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
const { computeEmbeddings } = require(path.join(ROOT, "netlify/functions/utils/openaiSimilarity.js"));
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

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first.slice(0, 45);
  }
  const ra = req.socket?.remoteAddress || "";
  if (ra) return String(ra).replace(/^::ffff:/, "").slice(0, 45);
  return "";
}

function entryForPublic(e) {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  delete out.submittedIp;
  return out;
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
  json(res, 200, arr.map(entryForPublic));
}

function adminPasswordOk(pw) {
  const expected = process.env.ARCHIVE_ADMIN_PASSWORD || "391612";
  return typeof pw === "string" && pw === expected;
}

async function handleAdminPost(res, body) {
  if (!adminPasswordOk(body.password)) {
    json(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  if (body.action === "list") {
    const list = await readArchiveArray();
    json(res, 200, { ok: true, entries: list });
    return;
  }
  const list = await readArchiveArray();
  if (body.action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      json(res, 400, { ok: false, error: "missing id" });
      return;
    }
    const next = list.filter((x) => x && x.id !== id);
    if (next.length === list.length) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
    await fs.writeFile(ARCHIVE_PATH, JSON.stringify(next, null, 2), "utf8");
    json(res, 200, { ok: true });
    return;
  }
  if (body.action === "updateTitle") {
    const id = typeof body.id === "string" ? body.id : "";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
    if (!id || !title) {
      json(res, 400, { ok: false, error: "missing id or title" });
      return;
    }
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx === -1) {
      json(res, 404, { ok: false, error: "not found" });
      return;
    }
    const copy = [...list];
    copy[idx] = { ...copy[idx], title };
    await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
    await fs.writeFile(ARCHIVE_PATH, JSON.stringify(copy, null, 2), "utf8");
    json(res, 200, { ok: true });
    return;
  }
  json(res, 400, { ok: false, error: "unknown action" });
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
  if (body.admin === true) {
    await handleAdminPost(res, body);
    return;
  }
  const entry = validateEntry(body.entry);
  if (!entry) {
    json(res, 400, { ok: false, error: "invalid entry" });
    return;
  }
  const toStore = { ...entry };
  delete toStore.submittedIp;
  toStore.submittedIp = getClientIp(req);

  const previewRaw = toStore.previewPngBase64;
  delete toStore.previewPngBase64;

  const apiKey = process.env.OPENAI_API_KEY || "";
  let embTitle = null;
  let embSketch = null;
  if (apiKey && previewRaw) {
    try {
      const em = await computeEmbeddings({
        title: toStore.title,
        previewPngBase64: previewRaw,
        apiKey,
      });
      embTitle = em.embTitle;
      embSketch = em.embSketch;
    } catch (e) {
      console.error("archive embed:", e.message || e);
    }
  }
  if (embTitle?.length) toStore.embTitle = embTitle;
  if (embSketch?.length) toStore.embSketch = embSketch;

  const list = await readArchiveArray();
  if (list.some((x) => x && x.id === entry.id)) {
    json(res, 200, { ok: true, duplicate: true });
    return;
  }
  list.push(toStore);
  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(list, null, 2), "utf8");
  const payload = { ok: true };
  if (embTitle?.length || embSketch?.length) {
    payload.embeddings = { title: embTitle, sketch: embSketch };
  }
  json(res, 200, payload);
}

const MAX_EMBED_BODY = 700 * 1024;

async function handlePostEmbed(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_EMBED_BODY) {
      json(res, 413, { ok: false, error: "payload too large" });
      return;
    }
    chunks.push(chunk);
  }
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    json(res, 503, { ok: false, error: "embeddings unavailable" });
    return;
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  try {
    const title = typeof body.title === "string" ? body.title : "";
    const previewPngBase64 = typeof body.previewPngBase64 === "string" ? body.previewPngBase64 : "";
    const { embTitle, embSketch } = await computeEmbeddings({ title, previewPngBase64, apiKey });
    if (!embTitle?.length) {
      json(res, 502, { ok: false, error: "embedding failed" });
      return;
    }
    json(res, 200, { ok: true, embeddings: { title: embTitle, sketch: embSketch } });
  } catch (e) {
    console.error("embed:", e);
    json(res, 500, { ok: false, error: "embed error" });
  }
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
  if (u.pathname === "/api/embed") {
    if (req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      await handlePostEmbed(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
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
