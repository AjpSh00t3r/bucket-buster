// Bucket Buster UI: opens the RAID stream and pours real object keys down the
// screen while a counter climbs to the real total. Only server-reported data.
const $ = (id) => document.getElementById(id);
const form = $("form"), go = $("go"), cascade = $("cascade");
const MAX_CARDS = 300;        // keep the DOM light; counter still reflects the true total

let es = null, state, counterTimer = null;

function setStatus(t, err = false, spin = false) {
  const s = $("status"); s.className = "status" + (err ? " err" : ""); s.innerHTML = "";
  if (spin) { const sp = document.createElement("span"); sp.className = "spin"; sp.setAttribute("aria-hidden", "true"); s.append(sp); }
  s.append(t);
}
const fmtBytes = (n) => { if (!n) return "0 B"; const u = ["B","KB","MB","GB","TB"]; let i = 0; while (n >= 1024 && i < u.length-1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; };
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));

function reset() {
  if (es) es.close();
  if (counterTimer) cancelAnimationFrame(counterTimer);
  state = { probed: 0, totalProbes: 0, buckets: 0, privateCount: 0, shown: 0, real: 0, counterShown: 0 };
  cascade.innerHTML = ""; $("bucket-list").innerHTML = "";
  $("r-probed").textContent = "0"; $("r-buckets").textContent = "0"; $("r-private").textContent = "0";
  $("bar").style.width = "0"; $("counter").textContent = "0"; $("counter-sub").textContent = "";
  $("counter-wrap").hidden = true; $("buckets").hidden = true; $("empty").hidden = true;
  document.body.dataset.state = "running";
}

function animateCounter() {
  if (counterTimer) cancelAnimationFrame(counterTimer);
  const step = () => {
    const target = state.real;
    if (state.counterShown < target) {
      const inc = Math.max(1, Math.ceil((target - state.counterShown) / 8));
      state.counterShown = Math.min(target, state.counterShown + inc);
      $("counter").textContent = state.counterShown.toLocaleString();
      counterTimer = requestAnimationFrame(step);
    }
  };
  counterTimer = requestAnimationFrame(step);
}

function pourObjects(provider, name, objects) {
  if ($("counter-wrap").hidden) $("counter-wrap").hidden = false;
  state.real += objects.length;
  $("counter-sub").textContent = "from " + name;
  animateCounter();
  const frag = document.createDocumentFragment();
  for (const o of objects) {
    if (state.shown >= MAX_CARDS) break;
    state.shown++;
    const el = document.createElement("div");
    el.className = "file";
    el.innerHTML = `<span class="prov ${provider}">${provider.toUpperCase()}</span>`
      + `<span class="key" title="${esc(o.key)}">${esc(o.key)}</span>`
      + `<span class="size">${fmtBytes(o.size)}</span>`
      + `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>`;
    frag.append(el);
  }
  cascade.prepend(frag);
  while (cascade.children.length > MAX_CARDS) cascade.lastElementChild.remove();
}

function addBucket(b) {
  state.buckets++; $("r-buckets").textContent = state.buckets;
  $("buckets").hidden = false;
  const li = document.createElement("li");
  li.innerHTML = `<span class="b-name">${esc(b.name)}</span><span class="b-meta">${b.provider.toUpperCase()} · <span id="bt-${b.provider}-${esc(b.name)}">counting…</span></span>`;
  $("bucket-list").append(li);
}

function run(brand, own) {
  reset();
  go.disabled = true;
  setStatus("Probing S3 and GCS for buckets under your brand…", false, true);
  const qs = new URLSearchParams({ brand, own: own ? "1" : "0" });
  es = new EventSource("/api/raid?" + qs);

  es.addEventListener("start", (e) => { const d = JSON.parse(e.data); state.totalProbes = d.probes; });
  es.addEventListener("tick", (e) => { const d = JSON.parse(e.data); state.probed = d.done; $("r-probed").textContent = Math.ceil(d.done/2); $("bar").style.width = Math.round(d.done/d.total*100) + "%"; });
  es.addEventListener("probe", (e) => { const d = JSON.parse(e.data); if (d.state === "private") { state.privateCount++; $("r-private").textContent = state.privateCount; } });
  es.addEventListener("bucket", (e) => addBucket(JSON.parse(e.data)));
  es.addEventListener("objects", (e) => { const d = JSON.parse(e.data); pourObjects(d.provider, d.name, d.objects); });
  es.addEventListener("fail", (e) => { finish(JSON.parse(e.data).message); });
  es.addEventListener("done", (e) => { finish(null, JSON.parse(e.data)); });
  es.onerror = () => { if (es && es.readyState === 2) finish("Lost connection to the local Bucket Buster server."); };
}

function finish(err, summary) {
  if (es) es.close();
  go.disabled = false; $("bar").style.width = "100%";
  if (err) { setStatus(err, true); document.body.dataset.state = "error"; if (!state.buckets) { $("empty").hidden = false; $("empty").textContent = err; } return; }
  state.real = summary.totalObjects; animateCounter();
  const priv = summary.existsPrivate ? ` · ${summary.existsPrivate} exist but are locked down` : "";
  if (summary.publicBuckets === 0) {
    document.body.dataset.state = "clean";
    $("counter-wrap").hidden = false;
    $("empty").hidden = false;
    $("empty").innerHTML = `<b>No public bucket found.</b> None of the ${Math.ceil(summary.probes/2)} names resolved to a publicly-listable bucket${priv}.`;
    setStatus(`RAID complete · ${Math.ceil(summary.probes/2)} names checked · nothing public${priv}.`);
  } else {
    document.body.dataset.state = "hit";
    const trunc = state.shown < summary.totalObjects ? ` (showing the first ${state.shown.toLocaleString()})` : "";
    if (trunc) { const m = document.createElement("div"); m.className = "more"; m.textContent = `+ ${(summary.totalObjects - state.shown).toLocaleString()} more objects not shown`; cascade.append(m); }
    setStatus(`RAID complete · ${summary.publicBuckets} public bucket${summary.publicBuckets===1?"":"s"} · ${summary.totalObjects.toLocaleString()} objects exposed${priv}.`);
    // fill the per-bucket counts
    for (const li of $("bucket-list").children) {
      const span = li.querySelector("[id^=bt-]");
      if (span && span.textContent === "counting…") span.textContent = "public";
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!$("own").checked) { setStatus("Tick the box to confirm you own this brand.", true); return; }
  const brand = $("brand").value.trim();
  if (!brand) { setStatus("Enter your brand or bucket name.", true); return; }
  run(brand, true);
});
