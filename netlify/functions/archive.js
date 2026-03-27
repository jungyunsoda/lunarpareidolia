/**
 * Shared archive for production on Netlify (Netlify Blobs).
 * Rewritten from /api/archive via netlify.toml — same paths as local server.js.
 */
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "lunar-pareidolia-archive";
const BLOB_KEY = "community-entries";
const MAX_BODY = 600 * 1024;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
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

async function readList(store) {
  const data = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

exports.handler = async (event) => {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const store = getStore(STORE_NAME);

  if (event.httpMethod === "GET") {
    const list = await readList(store);
    const body = JSON.stringify(list);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body,
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "method not allowed" }) };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY) {
    return {
      statusCode: 413,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "payload too large" }),
    };
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      statusCode: 400,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "invalid json" }),
    };
  }

  const entry = validateEntry(body.entry);
  if (!entry) {
    return {
      statusCode: 400,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "invalid entry" }),
    };
  }

  const list = await readList(store);
  if (list.some((x) => x && x.id === entry.id)) {
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, duplicate: true }),
    };
  }

  list.push(entry);
  await store.setJSON(BLOB_KEY, list);

  return {
    statusCode: 200,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true }),
  };
};
