/**
 * POST /api/embed — one-off OpenAI vectors for similarity (no storage).
 * Body: { title, previewPngBase64 }
 */
const { computeEmbeddings } = require("./utils/openaiSimilarity");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders();
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "embeddings unavailable" }),
    };
  }

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    if (Buffer.byteLength(rawBody, "utf8") > 700 * 1024) {
      return {
        statusCode: 413,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "payload too large" }),
      };
    }
    const body = JSON.parse(rawBody);
    const title = typeof body.title === "string" ? body.title : "";
    const previewPngBase64 = typeof body.previewPngBase64 === "string" ? body.previewPngBase64 : "";
    const { embTitle, embSketch } = await computeEmbeddings({ title, previewPngBase64, apiKey });
    if (!embTitle?.length) {
      return {
        statusCode: 502,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "embedding failed" }),
      };
    }
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        embeddings: { title: embTitle, sketch: embSketch },
      }),
    };
  } catch (e) {
    console.error("embed function:", e);
    return {
      statusCode: 500,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "embed error" }),
    };
  }
};
