// Bucket Buster core. Generates bucket-name permutations from ONE brand and does
// anonymous server-side GETs to the S3 and GCS list endpoints. Only already-public
// data is read; names are derived from the brand and nothing else is ever requested.

const UA = "BucketBuster/1.0 (self-audit of own brand)";
const TIMEOUT_MS = 9000;
const MAX_PAGES = 3;           // up to ~3000 keys per bucket
const PER_PAGE = 1000;

// brand, brand-assets, brand-backups, brand-dev, brand-media, brand-static,
// brand-uploads (from the spec) plus other common suffixes.
const SUFFIXES = [
  "", "-assets", "-backups", "-backup", "-bak", "-dev", "-media", "-static",
  "-uploads", "-upload", "-prod", "-production", "-data", "-logs", "-log",
  "-public", "-private", "-files", "-images", "-img", "-cdn", "-www", "-web",
  "-test", "-staging", "-stage", "-storage", "-s3", "-archive",
];

// S3 bucket naming: 3–63 chars, lowercase letters/digits/hyphens/dots,
// start & end alphanumeric, no consecutive dots.
const VALID = /^(?=.{3,63}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function normalizeBrand(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) throw new Error("Enter your brand or bucket name");
  const brand = s.replace(/^https?:\/\//, "").replace(/\..*$/, "").replace(/[^a-z0-9-]/g, "");
  if (brand.length < 2) throw new Error("Brand must be at least 2 characters (a–z, 0–9, hyphen)");
  if (brand.length > 40) throw new Error("Brand is too long");
  return brand;
}

export function permutations(brand) {
  const names = new Set();
  for (const suf of SUFFIXES) {
    const n = brand + suf;
    if (VALID.test(n)) names.add(n);
  }
  return [...names];
}

function withTimeout() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENT[m] || m);
const s3url = (name, key) => `https://${name}.s3.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`;
const gcsurl = (name, key) => `https://storage.googleapis.com/${name}/${key.split("/").map(encodeURIComponent).join("/")}`;

// ----------------------------------------------------------------- S3
async function s3Page(name, token) {
  const u = new URL(`https://${name}.s3.amazonaws.com/`);
  u.searchParams.set("list-type", "2");
  u.searchParams.set("max-keys", String(PER_PAGE));
  if (token) u.searchParams.set("continuation-token", token);
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(u, { signal, headers: { "user-agent": UA } });
    if (res.status === 404) return { state: "absent" };
    if (res.status === 403) return { state: "private" };
    const text = await res.text();
    if (res.status !== 200 || !text.includes("<ListBucketResult")) return { state: "error", status: res.status };
    const objects = [];
    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = decode((m[1].match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || "");
      if (!key) continue;
      const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      objects.push({ key, size, url: s3url(name, key) });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
    const next = (text.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1];
    return { state: "public", objects, truncated, next: next ? decode(next) : null };
  } catch (e) {
    return { state: "error", status: e.name === "AbortError" ? "timeout" : (e.cause?.code || e.message) };
  } finally { done(); }
}

// ----------------------------------------------------------------- GCS
async function gcsPage(name, token) {
  const u = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/o`);
  u.searchParams.set("maxResults", String(PER_PAGE));
  if (token) u.searchParams.set("pageToken", token);
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(u, { signal, headers: { "user-agent": UA, accept: "application/json" } });
    if (res.status === 404) return { state: "absent" };
    if (res.status === 401 || res.status === 403) return { state: "private" };
    if (res.status !== 200) return { state: "error", status: res.status };
    const j = await res.json();
    const objects = (j.items || []).map((o) => ({ key: o.name, size: Number(o.size || 0), url: gcsurl(name, o.name) }));
    return { state: "public", objects, truncated: !!j.nextPageToken, next: j.nextPageToken || null };
  } catch (e) {
    return { state: "error", status: e.name === "AbortError" ? "timeout" : (e.cause?.code || e.message) };
  } finally { done(); }
}

// Probe one name on one provider, paginating a public bucket and streaming objects.
async function probe(provider, name, emit) {
  const pageFn = provider === "s3" ? s3Page : gcsPage;
  let first = await pageFn(name, null);
  if (first.state !== "public") {
    emit("probe", { provider, name, state: first.state, status: first.status || null });
    return { state: first.state };
  }
  let total = 0, truncated = first.truncated, token = first.next, pages = 1;
  emit("bucket", { provider, name, endpoint: provider === "s3" ? `https://${name}.s3.amazonaws.com` : `https://storage.googleapis.com/${name}` });
  if (first.objects.length) { total += first.objects.length; emit("objects", { provider, name, objects: first.objects }); }
  while (truncated && token && pages < MAX_PAGES) {
    const p = await pageFn(name, token);
    if (p.state !== "public") break;
    pages++;
    if (p.objects.length) { total += p.objects.length; emit("objects", { provider, name, objects: p.objects }); }
    truncated = p.truncated; token = p.next;
  }
  emit("probe", { provider, name, state: "public", total, truncated: truncated && pages >= MAX_PAGES });
  return { state: "public", total };
}

export async function raid(brand, emit, { concurrency = 6 } = {}) {
  const names = permutations(brand);
  const jobs = [];
  for (const name of names) { jobs.push(["s3", name]); jobs.push(["gcs", name]); }
  emit("start", { brand, names: names.length, probes: jobs.length });

  let i = 0, publicBuckets = 0, totalObjects = 0, exists = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [provider, name] = jobs[i++];
      const r = await probe(provider, name, emit);
      if (r.state === "public") { publicBuckets++; totalObjects += r.total; }
      else if (r.state === "private") exists++;
      emit("tick", { done: i, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  emit("done", { publicBuckets, totalObjects, existsPrivate: exists, probes: jobs.length });
}
