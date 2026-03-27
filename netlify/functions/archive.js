/**
 * Shared archive for production on Netlify (Netlify Blobs).
 * Rewritten from /api/archive via netlify.toml — same paths as local server.js.
 */
const { connectLambda, getStore } = require("@netlify/blobs");
const { computeEmbeddings } = require("./utils/embeddingProvider");

const STORE_NAME = "lunar-pareidolia-archive";
const BLOB_KEY = "community-entries";
const MAX_BODY = 600 * 1024;

function adminPasswordOk(pw) {
  const expected = process.env.ARCHIVE_ADMIN_PASSWORD || "391612";
  return typeof pw === "string" && pw === expected;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function getClientIp(event) {
  const h = event.headers || {};
  const xff = h["x-forwarded-for"] || h["X-Forwarded-For"];
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first.slice(0, 45);
  }
  const nf = h["x-nf-client-connection-ip"] || h["X-NF-Client-Connection-IP"];
  if (nf) return String(nf).trim().slice(0, 45);
  const clientIp = h["client-ip"] || h["Client-IP"];
  if (clientIp) return String(clientIp).trim().slice(0, 45);
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

async function readList(store) {
  const data = await store.get(BLOB_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

exports.handler = async (event) => {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    /* Required for Lambda-style handlers so Blobs env is wired in production */
    connectLambda(event);
    const store = getStore(STORE_NAME);

    if (event.httpMethod === "GET") {
      const list = await readList(store);
      const body = JSON.stringify(list.map(entryForPublic));
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

    if (body.admin === true) {
      if (!adminPasswordOk(body.password)) {
        return {
          statusCode: 403,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: false, error: "forbidden" }),
        };
      }
      const list = await readList(store);
      if (body.action === "list") {
        return {
          statusCode: 200,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: true, entries: list }),
        };
      }
      if (body.action === "delete") {
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
          return {
            statusCode: 400,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "missing id" }),
          };
        }
        const next = list.filter((x) => x && x.id !== id);
        if (next.length === list.length) {
          return {
            statusCode: 404,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "not found" }),
          };
        }
        await store.setJSON(BLOB_KEY, next);
        return {
          statusCode: 200,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: true }),
        };
      }
      if (body.action === "updateTitle") {
        const id = typeof body.id === "string" ? body.id : "";
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
        if (!id || !title) {
          return {
            statusCode: 400,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "missing id or title" }),
          };
        }
        const idx = list.findIndex((x) => x && x.id === id);
        if (idx === -1) {
          return {
            statusCode: 404,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "not found" }),
          };
        }
        const copy = [...list];
        copy[idx] = { ...copy[idx], title };
        await store.setJSON(BLOB_KEY, copy);
        return {
          statusCode: 200,
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: true }),
        };
      }
      return {
        statusCode: 400,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "unknown action" }),
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

    const toStore = { ...entry };
    delete toStore.submittedIp;
    toStore.submittedIp = getClientIp(event);

    const previewRaw = toStore.previewPngBase64;
    delete toStore.previewPngBase64;

    const apiKey = process.env.GEMINI_API_KEY || "";
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

    const list = await readList(store);
    if (list.some((x) => x && x.id === entry.id)) {
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: true, duplicate: true }),
      };
    }

    list.push(toStore);
    await store.setJSON(BLOB_KEY, list);

    const payload = { ok: true };
    if (embTitle?.length || embSketch?.length) {
      payload.embeddings = { title: embTitle, sketch: embSketch };
    }
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error("archive function:", err);
    return {
      statusCode: 500,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "archive unavailable" }),
    };
  }
};
