/**
 * Google Gemini — title + sketch (vision caption → embed) for archive similarity.
 * Free tier: https://aistudio.google.com/apikey — set GEMINI_API_KEY on Netlify / local.
 */

const GEMINI_EMBED_MODEL = "text-embedding-004";
const GEMINI_VISION_MODEL = "gemini-2.0-flash";

function stripDataUrl(b64) {
  if (typeof b64 !== "string") return "";
  return b64.replace(/^data:image\/\w+;base64,/, "").trim();
}

async function geminiEmbedText(text, apiKey) {
  const t = String(text || "").trim().slice(0, 8000) || "untitled";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBED_MODEL}`,
      content: { parts: [{ text: t }] },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Gemini embed ${r.status}: ${err.slice(0, 220)}`);
  }
  const data = await r.json();
  const v = data?.embedding?.values;
  if (!Array.isArray(v) || v.length < 8) return null;
  return v;
}

async function describeSketchGemini(pngBase64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const instruction = `You index lunar pareidolia doodles: people see faces, animals, objects, or patterns in sparse lines on the moon.

Study the image (dark background, light strokes). Your job is to guess what a human might *think it depicts*, not only describe geometry.

Reply in exactly two lines, no greeting, no markdown:

INTERPRETATION: After the colon, 3–8 comma-separated short phrases naming plausible things it could resemble (e.g. "side profile face, nose and eye socket", "rabbit ears and body", "letter H", "two craters and a ridge"). If truly no likeness, write: abstract scribble, no clear object.

GEOMETRY: One sentence on main contours, open vs closed shapes, symmetry, and where the mass of ink sits.`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: instruction },
            {
              inline_data: {
                mime_type: "image/png",
                data: pngBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 220,
        temperature: 0.2,
      },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Gemini vision ${r.status}: ${err.slice(0, 220)}`);
  }
  const data = await r.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const txt = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
  return String(txt).trim().slice(0, 900);
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
  const titlePromise = geminiEmbedText(title || "untitled", apiKey);

  const sketchPromise = (async () => {
    if (!b64 || b64.length > 600_000) return null;
    try {
      const desc = await describeSketchGemini(b64, apiKey);
      if (!desc) return null;
      /* One text for embedding: title + what Gemini sees in the image (similarity uses this together). */
      const titled = `Pareidolia archive entry. Author title: "${String(title || "untitled").slice(0, 80)}".\n${desc}`;
      return geminiEmbedText(titled, apiKey);
    } catch (e) {
      console.error("embeddingProvider sketch path:", e.message || e);
      return null;
    }
  })();

  const [embTitle, embSketch] = await Promise.all([titlePromise, sketchPromise]);
  return { embTitle, embSketch };
}

/** Legacy OpenAI vectors; current Gemini title-embedding length */
const SUPPORTED_EMB_LENGTHS = [256, 768];

module.exports = {
  computeEmbeddings,
  SUPPORTED_EMB_LENGTHS,
};
