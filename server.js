/**
 * Serves the static site and a writable shared archive at GET/POST /api/archive.
 * Run: npm start  (default http://127.0.0.1:8765)
 * Anyone hitting the same deployment sees the same community.json after saves.
 */
const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const ROOT = __dirname;
const ARCHIVE_PATH = path.join(ROOT, "archive", "community.json");
const PORT = Number(process.env.PORT, 10) || 8765;
const MAX_BODY = 600 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function validateEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || e.id.length < 1 || e.id.length > 120) return null;
  if (!Array.isArray(e.strokes) || e.strokes.length === 0 || e.strokes.length > 400) return null;
  let totalPoints = 0;
  for (const s of e.strokes) {
    if (!s || typeof s !== "object" || !Array.isArray(s.points)) return null;
    if (s.points.length > 6000) return null;
    totalPoints += s.points.length;
    if (totalPoints > 80000) return null;
  }
  return e;
}

async function readArchiveArray() {
  try {
    const raw = await fs.readFile(ARCHIVE_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function handleGetArchive(res) {
  const arr = await readArchiveArray();
  json(res, 200, arr);
}

async function handlePostArchive(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      json(res, 413, { ok: false, error: "payload too large" });
      return;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const entry = validateEntry(body.entry);
  if (!entry) {
    json(res, 400, { ok: false, error: "invalid entry" });
    return;
  }
  const list = await readArchiveArray();
  if (list.some((x) => x && x.id === entry.id)) {
    json(res, 200, { ok: true, duplicate: true });
    return;
  }
  list.push(entry);
  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(list, null, 2), "utf8");
  json(res, 200, { ok: true });
}

function safeFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let rel = decoded.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = path.join(rel, "index.html");
  const resolved = path.resolve(ROOT, rel);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep) && resolved !== path.resolve(ROOT)) {
    return null;
  }
  return resolved;
}

async function handleStatic(req, res) {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const filePath = safeFilePath(u.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (stat.isDirectory()) {
    const indexPath = path.join(filePath, "index.html");
    try {
      await fs.access(indexPath);
      return serveFile(res, indexPath);
    } catch {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }
  return serveFile(res, filePath);
}

async function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const buf = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  if (u.pathname === "/api/archive") {
    if (req.method === "GET") {
      await handleGetArchive(res);
      return;
    }
    if (req.method === "POST") {
      await handlePostArchive(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }
  await handleStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lunar pareidolia — http://127.0.0.1:${PORT}/`);
  console.log("Shared archive: GET/POST /api/archive → archive/community.json");
});
