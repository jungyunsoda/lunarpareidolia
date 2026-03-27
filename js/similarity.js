/**
 * Rank archive entries by AI embeddings (OpenAI) when present, else shape + title heuristics.
 */

export const AI_EMB_DIM = 256;

const GRID_W = 28;
const GRID_H = 14;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function normalizedLevenshteinSimilarity(a, b) {
  const s1 = String(a).toLowerCase().trim();
  const s2 = String(b).toLowerCase().trim();
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const d = levenshtein(s1, s2);
  return 1 - d / Math.max(s1.length, s2.length);
}

function tokenizeTitle(t) {
  return String(t)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardWords(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** @returns {number} 0..1 */
export function titleSimilarity(titleA, titleB) {
  const wordsA = tokenizeTitle(titleA);
  const wordsB = tokenizeTitle(titleB);
  const jac = jaccardWords(wordsA, wordsB);
  const lev = normalizedLevenshteinSimilarity(titleA, titleB);
  return 0.45 * jac + 0.55 * lev;
}

function bresenhamLine(g, gw, gh, x0, y0, x1, y1, weight) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x0 >= 0 && x0 < gw && y0 >= 0 && y0 < gh) g[y0 * gw + x0] += weight;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * L2-normalized occupancy / stroke density grid in bbox-normalized UV space.
 * @param {Array<{ points: number[][] }>} strokes
 * @returns {Float32Array|null}
 */
export function strokesToShapeVector(strokes) {
  if (!strokes?.length) return null;
  let minU = 1;
  let maxU = 0;
  let minV = 1;
  let maxV = 0;
  for (const s of strokes) {
    const pts = s.points;
    if (!pts?.length) continue;
    for (const p of pts) {
      if (!p || p.length < 2) continue;
      const u = Number(p[0]);
      const v = Number(p[1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  if (maxU < minU || maxV < minV) return null;
  let du = maxU - minU;
  let dv = maxV - minV;
  if (du < 1e-5) du = 0.02;
  if (dv < 1e-5) dv = 0.02;

  const g = new Float32Array(GRID_W * GRID_H);
  const gw = GRID_W;
  const gh = GRID_H;

  function toCell(u, v) {
    const x = ((u - minU) / du) * (gw - 1);
    const y = ((v - minV) / dv) * (gh - 1);
    return [clamp(x, 0, gw - 1), clamp(y, 0, gh - 1)];
  }

  const UV_JUMP = 0.45;

  for (const s of strokes) {
    const pts = s.points;
    if (!pts?.length) continue;
    if (pts.length === 1) {
      const [cx, cy] = toCell(Number(pts[0][0]), Number(pts[0][1]));
      const ix = Math.round(cx);
      const iy = Math.round(cy);
      if (ix >= 0 && ix < gw && iy >= 0 && iy < gh) g[iy * gw + ix] += 1;
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const u1 = Number(pts[i - 1][0]);
      const v1 = Number(pts[i - 1][1]);
      const u2 = Number(pts[i][0]);
      const v2 = Number(pts[i][1]);
      if (Math.abs(u2 - u1) > UV_JUMP || Math.abs(v2 - v1) > UV_JUMP) continue;
      const [x0, y0] = toCell(u1, v1);
      const [x1, y1] = toCell(u2, v2);
      bresenhamLine(g, gw, gh, x0, y0, x1, y1, 1);
    }
  }

  let sumSq = 0;
  for (let i = 0; i < g.length; i++) sumSq += g[i] * g[i];
  if (sumSq < 1e-12) return null;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < g.length; i++) g[i] *= inv;
  return g;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return clamp(dot, 0, 1);
}

/** @returns {number} 0..1 */
export function shapeSimilarity(strokesA, strokesB) {
  const va = strokesToShapeVector(strokesA);
  const vb = strokesToShapeVector(strokesB);
  if (!va || !vb) return 0;
  return cosineSimilarity(va, vb);
}

/**
 * Combined score: shape + title (equal weight as requested).
 * @returns {number} 0..1
 */
export function combinedSimilarity(entryA, entryB) {
  const shape = shapeSimilarity(entryA.strokes, entryB.strokes);
  const title = titleSimilarity(entryA.title || "", entryB.title || "");
  return 0.5 * shape + 0.5 * title;
}

/** Cosine similarity for OpenAI unit vectors → 0..1 */
function cosineSim01(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return (dot + 1) / 2;
}

/**
 * @returns {number|null} null if AI cannot score this pair
 */
export function aiPairSimilarity(entryA, entryB) {
  const ta = entryA?.embTitle;
  const tb = entryB?.embTitle;
  if (!Array.isArray(ta) || !Array.isArray(tb) || ta.length !== AI_EMB_DIM || tb.length !== AI_EMB_DIM) {
    return null;
  }
  const ct = cosineSim01(ta, tb);
  const sa = entryA?.embSketch;
  const sb = entryB?.embSketch;
  if (
    Array.isArray(sa) &&
    Array.isArray(sb) &&
    sa.length === AI_EMB_DIM &&
    sb.length === AI_EMB_DIM
  ) {
    return 0.42 * ct + 0.58 * cosineSim01(sa, sb);
  }
  return ct;
}

/**
 * @param {object} savedEntry — normalized entry just saved
 * @param {object[]} candidates — normalized entries (exclude saved id)
 * @param {{ limit?: number }} opts
 * @returns {{ entry: object, score: number }[]}
 */
export function findTopSimilar(savedEntry, candidates, { limit = 3 } = {}) {
  const id = savedEntry?.id;
  const queryHasAi = Array.isArray(savedEntry?.embTitle) && savedEntry.embTitle.length === AI_EMB_DIM;
  const scored = [];
  for (const c of candidates) {
    if (!c || c.id === id) continue;
    if (!c.strokes?.length) continue;
    let score;
    if (queryHasAi) {
      const ai = aiPairSimilarity(savedEntry, c);
      score = ai != null ? ai : combinedSimilarity(savedEntry, c);
    } else {
      score = combinedSimilarity(savedEntry, c);
    }
    scored.push({ entry: c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
