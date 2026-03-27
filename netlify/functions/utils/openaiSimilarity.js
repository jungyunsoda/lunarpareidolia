/**
 * OpenAI embeddings for archive similarity (title + sketch via vision caption).
 * Used by archive POST and /api/embed. Requires OPENAI_API_KEY.
 */

const OPENAI_EMBED_MODEL = "text-embedding-3-small";
const OPENAI_VISION_MODEL = "gpt-4o-mini";
const EMBEDDING_DIM = 256;

function stripDataUrl(b64) {
  if (typeof b64 !== "string") return "";
  return b64.replace(/^data:image\/\w+;base64,/, "").trim();
}

async function embedText(text, apiKey) {
  const input = String(text || "").trim().slice(0, 8000) || "untitled";
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input,
      dimensions: EMBEDDING_DIM,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI embeddings ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  const v = data?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) return null;
  return v;
}

async function describeSketchBase64(pngBase64, apiKey) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      max_tokens: 100,
      temperature: 0.15,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this abstract line drawing (dark background). List curves, loops, crossings, symmetry, and overall shape in ≤35 words. No greeting or preamble.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${pngBase64}`,
                detail: "low",
              },
            },
          ],
        },
      ],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI vision ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  return String(data?.choices?.[0]?.message?.content || "")
    .trim()
    .slice(0, 500);
}

/**
 * @param {{ title?: string, previewPngBase64?: string, apiKey: string }} opts
 * @returns {{ embTitle: number[]|null, embSketch: number[]|null }}
 */
async function computeEmbeddings({ title, previewPngBase64, apiKey }) {
  if (!apiKey || typeof apiKey !== "string") {
    return { embTitle: null, embSketch: null };
  }

  const b64 = stripDataUrl(previewPngBase64 || "");
  const titlePromise = embedText(title || "untitled", apiKey);

  const sketchPromise = (async () => {
    if (!b64 || b64.length > 600_000) return null;
    try {
      const desc = await describeSketchBase64(b64, apiKey);
      if (!desc) return null;
      return embedText(desc, apiKey);
    } catch (e) {
      console.error("openaiSimilarity sketch path:", e.message || e);
      return null;
    }
  })();

  const [embTitle, embSketch] = await Promise.all([titlePromise, sketchPromise]);
  return { embTitle, embSketch };
}

module.exports = {
  computeEmbeddings,
  EMBEDDING_DIM,
};
