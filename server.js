// Bucket Buster — local server. Serves the UI and streams real bucket findings
// over Server-Sent Events. Binds to localhost only. The browser never talks to
// AWS/GCS directly (they send no CORS headers); this server makes the anonymous
// GETs and only ever requests names derived from the submitted brand.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { raid, normalizeBrand } from "./lib/buckets.js";

const PORT = Number(process.env.PORT || 4778);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function stream(req, res, url) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  let closed = false;
  req.on("close", () => { closed = true; });
  const emit = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  try {
    if (url.searchParams.get("own") !== "1") throw new Error("Confirm you own this bucket / brand before scanning");
    const brand = normalizeBrand(url.searchParams.get("brand"));
    await raid(brand, emit);
  } catch (e) {
    emit("fail", { message: e.message || String(e) });
  } finally {
    res.end();
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/raid" && req.method === "GET") return stream(req, res, url);

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, HOST, () => console.log(`Bucket Buster → http://${HOST}:${PORT}`));
