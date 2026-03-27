/**
 * Lunar pareidolia: draw on moon UVs, persist archive, optional community JSON.
 */

const STORAGE_KEY = "lunarPareidoliaArchive_v1";
const DRAW_W = 4096;
const DRAW_H = 2048;
const UV_JUMP = 0.45;

export function loadLocalEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveLocalEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Prefer live API (same host as the app); fall back to static JSON for plain static hosting. */
export async function fetchCommunityArchive(baseUrl) {
  try {
    const apiUrl = new URL("api/archive", baseUrl).href;
    const r = await fetch(apiUrl);
    if (r.ok) {
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    }
  } catch {
    /* no server or file:// */
  }
  try {
    const url = new URL("archive/community.json", baseUrl).href;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** POST one entry to the shared archive (Node server). No-op failure if API missing. */
export async function pushSharedArchiveEntry(baseUrl, entry) {
  try {
    const apiUrl = new URL("api/archive", baseUrl).href;
    const r = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json().catch(() => ({}));
    return { ok: Boolean(data.ok), duplicate: Boolean(data.duplicate) };
  } catch {
    return { ok: false };
  }
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function createDrawSurface() {
  const c = document.createElement("canvas");
  c.width = DRAW_W;
  c.height = DRAW_H;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, DRAW_W, DRAW_H);
  return { canvas: c, ctx };
}

export function strokesToCanvas(ctx, strokes) {
  ctx.clearRect(0, 0, DRAW_W, DRAW_H);
  for (const s of strokes) {
    const pts = s.points;
    if (!pts?.length) continue;
    const lw = Math.max(0.5, (s.width || 2) * (DRAW_W / 8192));
    ctx.fillStyle = s.color || "#ffffff";
    ctx.strokeStyle = s.color || "#ffffff";
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    if (pts.length === 1) {
      const [u, v] = pts[0];
      const x = u * DRAW_W;
      const y = (1 - v) * DRAW_H;
      ctx.beginPath();
      ctx.arc(x, y, lw * 0.5, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    const [u0, v0] = pts[0];
    ctx.moveTo(u0 * DRAW_W, (1 - v0) * DRAW_H);
    for (let i = 1; i < pts.length; i++) {
      const [u1, v1] = pts[i - 1];
      const [u2, v2] = pts[i];
      if (Math.abs(u2 - u1) > UV_JUMP || Math.abs(v2 - v1) > UV_JUMP) {
        ctx.moveTo(u2 * DRAW_W, (1 - v2) * DRAW_H);
      } else {
        ctx.lineTo(u2 * DRAW_W, (1 - v2) * DRAW_H);
      }
    }
    ctx.stroke();
  }
}

/** Rasterize strokes to an arbitrary canvas size (same UV mapping as the moon texture). */
export function strokesToCanvasRect(ctx, strokes, width, height) {
  for (const s of strokes) {
    const pts = s.points;
    if (!pts?.length) continue;
    const lw = Math.max(0.5, (s.width || 2) * (width / 8192));
    ctx.fillStyle = s.color || "#ffffff";
    ctx.strokeStyle = s.color || "#ffffff";
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    if (pts.length === 1) {
      const [u, v] = pts[0];
      const x = u * width;
      const y = (1 - v) * height;
      ctx.beginPath();
      ctx.arc(x, y, lw * 0.5, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    const [u0, v0] = pts[0];
    ctx.moveTo(u0 * width, (1 - v0) * height);
    for (let i = 1; i < pts.length; i++) {
      const [u1, v1] = pts[i - 1];
      const [u2, v2] = pts[i];
      if (Math.abs(u2 - u1) > UV_JUMP || Math.abs(v2 - v1) > UV_JUMP) {
        ctx.moveTo(u2 * width, (1 - v2) * height);
      } else {
        ctx.lineTo(u2 * width, (1 - v2) * height);
      }
    }
    ctx.stroke();
  }
}

function clampNum(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Thumbnail: zoom to stroke bounding box (with padding) so small drawings fill the frame.
 */
export function strokesToThumbnailCropped(ctx, strokes, width, height, options = {}) {
  const pad = options.pad ?? 0.14;
  const minSpan = options.minSpan ?? 0.08;

  let minU = 1;
  let maxU = 0;
  let minV = 1;
  let maxV = 0;
  let any = false;
  for (const s of strokes || []) {
    for (const p of s.points || []) {
      const u = Number(p[0]);
      const v = Number(p[1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      any = true;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }

  if (!any) return;

  let du = maxU - minU;
  let dv = maxV - minV;
  if (du < minSpan) {
    const c = (minU + maxU) * 0.5;
    du = minSpan;
    minU = c - du * 0.5;
    maxU = c + du * 0.5;
  }
  if (dv < minSpan) {
    const c = (minV + maxV) * 0.5;
    dv = minSpan;
    minV = c - dv * 0.5;
    maxV = c + dv * 0.5;
  }

  const pEdge = Math.max(du, dv) * pad;
  minU -= pEdge;
  maxU += pEdge;
  minV -= pEdge;
  maxV += pEdge;
  minU = clampNum(minU, 0, 1);
  maxU = clampNum(maxU, 0, 1);
  minV = clampNum(minV, 0, 1);
  maxV = clampNum(maxV, 0, 1);
  du = maxU - minU;
  dv = maxV - minV;
  if (du < 1e-5) du = 0.02;
  if (dv < 1e-5) dv = 0.02;

  const uvSpan = Math.max(du, dv);

  function toXY(u, v) {
    const x = ((u - minU) / du) * width;
    const y = (1 - (v - minV) / dv) * height;
    return [x, y];
  }

  for (const s of strokes) {
    const pts = s.points;
    if (!pts?.length) continue;
    const baseW = (s.width || 2) * (width / 8192);
    const lw = clampNum(baseW / Math.max(uvSpan, 0.035), 1.5, width * 0.12);
    ctx.fillStyle = s.color || "#ffffff";
    ctx.strokeStyle = s.color || "#ffffff";
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";

    if (pts.length === 1) {
      const [u, v] = pts[0];
      const [x, y] = toXY(Number(u), Number(v));
      ctx.beginPath();
      ctx.arc(x, y, lw * 0.5, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    const [u0, v0] = pts[0];
    {
      const [x, y] = toXY(Number(u0), Number(v0));
      ctx.moveTo(x, y);
    }
    for (let i = 1; i < pts.length; i++) {
      const [u1, v1] = pts[i - 1];
      const [u2, v2] = pts[i];
      if (Math.abs(u2 - u1) > UV_JUMP || Math.abs(v2 - v1) > UV_JUMP) {
        const [x, y] = toXY(Number(u2), Number(v2));
        ctx.moveTo(x, y);
      } else {
        const [x, y] = toXY(Number(u2), Number(v2));
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

export function uvToPx(u, v) {
  return { x: u * DRAW_W, y: (1 - v) * DRAW_H };
}

export { DRAW_W, DRAW_H, UV_JUMP, STORAGE_KEY };
