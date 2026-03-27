import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  loadLocalEntries,
  saveLocalEntries,
  fetchCommunityArchive,
  fetchCommunityArchiveAdmin,
  pushSharedArchiveEntry,
  fetchAiEmbeddings,
  archiveAdminPost,
  createDrawSurface,
  strokesToCanvas,
  strokesToThumbnailCropped,
  uvToPx,
  UV_JUMP,
} from "./archive-draw.js";
import { findTopSimilar, AI_EMB_DIM } from "./similarity.js";

/**
 * NASA SVS — Moon 3D Models for Web, AR, and Animation
 * https://svs.gsfc.nasa.gov/14959
 */
const MODELS = [
  {
    id: "flat-8k",
    file: "Moon_NASA_LRO_8k_Flat.glb",
    url: "https://svs.gsfc.nasa.gov/vis/a010000/a014900/a014959/Moon_NASA_LRO_8k_Flat.glb",
  },
];

function localAssetCandidates(filename) {
  const pageBase = document.baseURI || window.location.href;
  const fromPage = new URL(`assets/${filename}`, pageBase).href;
  const fromScript = new URL(`../assets/${filename}`, import.meta.url).href;
  return [...new Set([fromPage, fromScript])];
}

const loader = new GLTFLoader();

async function loadGltfFirstWorking(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await loader.loadAsync(url);
    } catch (e) {
      lastErr = e;
      console.warn("GLB load failed:", url, e?.message || e);
    }
  }
  throw lastErr;
}

const canvas = document.getElementById("c");
const statusEl = document.getElementById("load-status");
const btnArchiveFab = document.getElementById("btn-archive-fab");
const btnBrush = document.getElementById("btn-brush");
const drawPalette = document.getElementById("draw-palette");
const btnPaletteExpand = document.getElementById("btn-palette-expand");
const drawColor = document.getElementById("draw-color");
const drawWidth = document.getElementById("draw-width");
const btnUndo = document.getElementById("btn-undo");
const btnClear = document.getElementById("btn-clear");
const btnSave = document.getElementById("btn-save");
const entryTitle = document.getElementById("entry-title");
const archivePanel = document.getElementById("archive-panel");
const btnCloseArchive = document.getElementById("btn-close-archive");
const listArchive = document.getElementById("list-archive");
const btnArchiveAdmin = document.getElementById("btn-archive-admin");
const moonArchiveTagsEl = document.getElementById("moon-archive-tags");
const welcomeOverlay = document.getElementById("welcome-overlay");
const btnWelcomeArchive = document.getElementById("btn-welcome-archive");
const btnWelcomeExplore = document.getElementById("btn-welcome-explore");
const toast = document.getElementById("toast");
const appEl = document.getElementById("app");
const similarPanel = document.getElementById("similar-panel");
const similarList = document.getElementById("similar-list");
const btnSimilarClose = document.getElementById("btn-similar-close");
const brushHintEl = document.getElementById("brush-hint");
const brushHintClose = brushHintEl?.querySelector(".brush-hint__close");

welcomeOverlay.classList.remove("hidden");

const moonAnchorCenter = new THREE.Vector3();
let moonHullRadius = 1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080c);

const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 5000);
camera.position.set(0, 0.35, 2.8);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
  logarithmicDepthBuffer: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
function applyPixelRatio() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
}

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.zoomSpeed = 0.88;
controls.rotateSpeed = window.matchMedia("(pointer: coarse)").matches ? 0.85 : 1;
controls.minDistance = 0.5;
controls.maxDistance = 20;
controls.target.set(0, 0, 0);

const sun = new THREE.DirectionalLight(0xfff4e8, 1.65);
sun.position.set(0, 0, 2);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0x6b7a99, 0x1a1410, 0.24);
scene.add(hemi);

let moonRoot = null;
let currentModelId = null;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

const { canvas: drawCanvas, ctx: drawCtx } = createDrawSurface();
const drawTexture = new THREE.CanvasTexture(drawCanvas);
drawTexture.colorSpace = THREE.SRGBColorSpace;
drawTexture.minFilter = THREE.LinearMipmapLinearFilter;
drawTexture.magFilter = THREE.LinearFilter;
drawTexture.generateMipmaps = true;

const doodleMaterial = new THREE.MeshBasicMaterial({
  map: drawTexture,
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4,
  side: THREE.FrontSide,
});

let moonRaycastMeshes = [];
let overlayInnerMeshes = [];
/** When false, pareidolia overlay meshes and floating archive tags are hidden (moon base still visible). */
let archiveMoonDrawingsVisible = true;

const strokes = [];
let drawingStroke = null;
let isDrawMode = false;
let pointerDrawing = false;
/** Touch: defer stroke until move (avoids pinch-zoom registering as draw). */
const TOUCH_DRAW_SLOP_PX = 10;
const TOUCH_DRAW_SLOP_SQ = TOUCH_DRAW_SLOP_PX * TOUCH_DRAW_SLOP_PX;
const canvasTouchPointerIds = new Set();
let touchDrawPending = null;
let communityEntries = [];

const SIMILAR_BTN_ICON = `<svg class="archive-list__similar__icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="9.25" cy="12" r="4.25" fill="none" stroke="currentColor" stroke-width="1.65"/><circle cx="14.75" cy="12" r="4.25" fill="none" stroke="currentColor" stroke-width="1.65"/></svg>`;

const ARCHIVE_ADMIN_PASS = "391612";
const ARCHIVE_ADMIN_SESSION_KEY = "lunarPareidoliaArchiveAdmin_v1";

function setStatus(text) {
  statusEl.textContent = text;
}

function dismissWelcome(openArchiveFirst) {
  welcomeOverlay.classList.add("hidden");
  if (openArchiveFirst) void openArchiveFromWelcome();
}

/** Welcome “Archive”: same as FAB archive — show panel and moon tags as soon as the moon exists, then fetch + merge. */
async function openArchiveFromWelcome() {
  setMode(true, { skipBrushHint: true });
  try {
    await initialMoonLoad;
    archivePanel.classList.remove("hidden");
    buildMoonArchiveTags();
    const base = document.baseURI || window.location.href;
    await loadCommunityEntriesForSession(base);
    renderArchiveLists();
    await applyAllArchivesToMoon({ silent: true });
    syncArchiveFabVisibilityButton();
  } catch (e) {
    console.error(e);
    setStatus("Could not load archive.");
  }
}

function dismissWelcomeExplore() {
  welcomeOverlay.classList.add("hidden");
  setMode(true);
}

let brushHintTimer = null;
let brushHintDismissed = false;

function hideBrushHint(permanent) {
  brushHintEl?.classList.add("hidden");
  if (permanent) brushHintDismissed = true;
  if (brushHintTimer) {
    clearTimeout(brushHintTimer);
    brushHintTimer = null;
  }
}

function scheduleBrushHint() {
  if (!brushHintEl || brushHintDismissed) return;
  if (brushHintTimer) clearTimeout(brushHintTimer);
  brushHintTimer = setTimeout(() => {
    brushHintTimer = null;
    if (brushHintDismissed) return;
    if (!welcomeOverlay.classList.contains("hidden")) return;
    if (isDrawMode) return;
    if (!archivePanel.classList.contains("hidden")) return;
    if (!similarPanel.classList.contains("hidden")) return;
    brushHintEl.classList.remove("hidden");
  }, 900);
}

function showArchivedFeedback(savedTitle) {
  if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches) {
    return;
  }
  toast.textContent = `Archived · ${savedTitle}`;
  toast.classList.remove("hidden");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("toast--visible"));
  });
  appEl.classList.add("archived-celebrate");
  btnArchiveFab.classList.add("archive-fab--pulse");
  setTimeout(() => appEl.classList.remove("archived-celebrate"), 1000);
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    btnArchiveFab.classList.remove("archive-fab--pulse");
    setTimeout(() => toast.classList.add("hidden"), 400);
  }, 3200);
}

function disposeObject3D(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      const mats = child.material;
      if (Array.isArray(mats)) mats.forEach((m) => m.dispose?.());
      else mats?.dispose?.();
    }
  });
}

function upgradeLoadedTextures(root) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (mat === doodleMaterial) return;
      for (const key of Object.keys(mat)) {
        const v = mat[key];
        if (v && v.isTexture) {
          v.anisotropy = maxAniso;
          v.minFilter = THREE.LinearMipmapLinearFilter;
          v.magFilter = THREE.LinearFilter;
          if (v.image && v.image.width) v.needsUpdate = true;
        }
      }
    }
  });
}

/** Screen-space labels on the moon while the archive panel is open. */
const moonTagProj = new THREE.Vector3();
const moonTagToCam = new THREE.Vector3();
const moonTagOutward = new THREE.Vector3();
let moonArchiveTagItems = [];

function disposeMoonArchiveTags() {
  moonArchiveTagItems = [];
  if (moonArchiveTagsEl) moonArchiveTagsEl.innerHTML = "";
}

function buildMoonArchiveTags() {
  disposeMoonArchiveTags();
  if (!moonArchiveTagsEl || archivePanel.classList.contains("hidden")) return;
  if (!moonRoot || moonHullRadius <= 0) return;
  const baseMeshes = moonRaycastMeshes.filter((m) => !m.userData.pareidoliaOverlay);
  const local = loadLocalEntries();
  const localIds = new Set(local.map((e) => e.id));
  const items = [
    ...local
      .slice()
      .reverse()
      .map((e) => ({ entry: e, shared: false })),
    ...communityEntries.filter((c) => !localIds.has(c.id)).map((e) => ({ entry: e, shared: true })),
  ];
  for (const { entry: raw } of items) {
    const e = normalizeEntry(raw);
    if (!e?.strokes?.length) continue;
    const wp = framingWorldPointFromEntryStrokes(e).clone();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "moon-archive-tag";
    btn.textContent = e.title.length > 22 ? `${e.title.slice(0, 20)}…` : e.title;
    btn.title = e.title;
    btn.setAttribute("aria-label", `View on moon: ${e.title}`);
    btn.addEventListener("click", () => void focusOrbitOnEntry(e));
    moonArchiveTagsEl.appendChild(btn);
    moonArchiveTagItems.push({ worldPos: wp, el: btn });
  }
}

function updateMoonArchiveTagPositions() {
  if (!moonArchiveTagItems.length || archivePanel.classList.contains("hidden")) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const t of moonArchiveTagItems) {
    moonTagProj.copy(t.worldPos).project(camera);
    const onScreen =
      moonTagProj.z > -1 &&
      moonTagProj.z < 1 &&
      Math.abs(moonTagProj.x) < 1.02 &&
      Math.abs(moonTagProj.y) < 1.02;
    moonTagOutward.copy(t.worldPos).sub(moonAnchorCenter);
    if (moonTagOutward.lengthSq() < 1e-12) {
      t.el.style.display = "none";
      continue;
    }
    moonTagOutward.normalize();
    moonTagToCam.copy(camera.position).sub(t.worldPos).normalize();
    const facing = moonTagOutward.dot(moonTagToCam) > 0.08;
    if (!onScreen || !facing) {
      t.el.style.display = "none";
      continue;
    }
    const x = (moonTagProj.x * 0.5 + 0.5) * w;
    const y = (-moonTagProj.y * 0.5 + 0.5) * h;
    t.el.style.display = "";
    t.el.style.left = `${x}px`;
    t.el.style.top = `${y}px`;
  }
}

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(Math.min(size.x, size.y, size.z) / 2, 0.001);
  const dist = radius * 2.6;
  controls.target.copy(center);
  const surfaceGap = Math.max(radius * 0.1, 1e-5);
  controls.minDistance = radius + surfaceGap;
  camera.near = Math.max(surfaceGap * 0.08, radius * 1e-8);
  camera.far = Math.max(radius * 400, 500);
  camera.updateProjectionMatrix();
  camera.position.copy(center);
  camera.position.z += dist;
  controls.maxDistance = radius * 28;
  moonAnchorCenter.copy(center);
  moonHullRadius = radius;
  syncOrbitControlsFromCamera();
  controls.update();
}

const _orbitOffset = new THREE.Vector3();

function syncOrbitControlsFromCamera() {
  _orbitOffset.subVectors(camera.position, controls.target);
  controls._spherical.setFromVector3(_orbitOffset);
  controls._spherical.makeSafe();
  controls._sphericalDelta.set(0, 0, 0);
  controls._scale = 1;
}

function syncSunToView() {
  sun.target.position.copy(controls.target);
  sun.position.copy(camera.position);
}

function clearOverlayLayer() {
  for (const m of overlayInnerMeshes) {
    m.parent?.remove(m);
    m.geometry?.dispose();
  }
  overlayInnerMeshes = [];
  moonRaycastMeshes = [];
}

function applyArchiveMoonDrawingsVisibility() {
  const v = archiveMoonDrawingsVisible;
  for (const m of overlayInnerMeshes) {
    if (m) m.visible = v;
  }
  moonArchiveTagsEl?.classList.toggle("moon-archive-tags--drawings-hidden", !v);
  document.querySelectorAll(".archive-visibility-sync").forEach((btn) => {
    btn.setAttribute("aria-pressed", v ? "true" : "false");
    btn.setAttribute("aria-label", v ? "Hide drawings on moon" : "Show drawings on moon");
  });
}

/** FAB eye is redundant while the archive panel is open (header has the same control). */
function syncArchiveFabVisibilityButton() {
  const fabEye = document.getElementById("btn-archive-visibility-fab");
  if (!fabEye) return;
  const panelOpen = !archivePanel.classList.contains("hidden");
  fabEye.classList.toggle("icon-archive-visibility--fab-hidden", panelOpen);
}

function setupPareidoliaLayer() {
  clearOverlayLayer();
  if (!moonRoot) return;
  moonRoot.updateMatrixWorld(true);
  moonRoot.traverse((child) => {
    if (!child.isMesh || child.userData.pareidoliaOverlay) return;
    moonRaycastMeshes.push(child);
    const inner = new THREE.Mesh(child.geometry.clone(), doodleMaterial);
    inner.userData.pareidoliaOverlay = true;
    inner.scale.setScalar(1.008);
    inner.renderOrder = 1;
    inner.visible = archiveMoonDrawingsVisible;
    child.add(inner);
    overlayInnerMeshes.push(inner);
  });
}

function refreshDrawTexture() {
  strokesToCanvas(drawCtx, strokes);
  drawTexture.needsUpdate = true;
}

function segmentOnCanvas(u0, v0, u1, v1) {
  if (Math.abs(u1 - u0) > UV_JUMP || Math.abs(v1 - v0) > UV_JUMP) return;
  const a = uvToPx(u0, v0);
  const b = uvToPx(u1, v1);
  const w = Math.max(0.5, Number(drawWidth.value) * (drawCanvas.width / 8192));
  drawCtx.strokeStyle = drawColor.value;
  drawCtx.lineWidth = w;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.beginPath();
  drawCtx.moveTo(a.x, a.y);
  drawCtx.lineTo(b.x, b.y);
  drawCtx.stroke();
  drawTexture.needsUpdate = true;
}

function clampNum(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

const _uvTri = new THREE.Triangle();
const _uvA = new THREE.Vector3();
const _uvB = new THREE.Vector3();
const _uvC = new THREE.Vector3();
const _uvP = new THREE.Vector3();
const _uvClosest = new THREE.Vector3();
const _uvBary = new THREE.Vector3();
const _w0 = new THREE.Vector3();
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _worldFromUv = new THREE.Vector3();

/**
 * Closest point on mesh in world space for texture UV (0–1), using each triangle’s UV
 * footprint (barycentric interp). Handles horizontal seam via ±1 shifts in U.
 * Replaces naive “nearest vertex” lookup, which jumped to wrong regions on sparse UVs.
 */
function worldPointFromUvMeshes(meshes, u, v) {
  let bestD = Infinity;
  let found = false;
  for (const mesh of meshes) {
    if (!mesh.isMesh) continue;
    const geo = mesh.geometry;
    const uvAttr = geo.attributes?.uv;
    const posAttr = geo.attributes?.position;
    if (!uvAttr || !posAttr) continue;
    mesh.updateMatrixWorld(true);
    const idx = geo.index;

    const tryTri = (i0, i1, i2) => {
      const u0 = uvAttr.getX(i0);
      const v0 = uvAttr.getY(i0);
      const u1 = uvAttr.getX(i1);
      const v1 = uvAttr.getY(i1);
      const u2 = uvAttr.getX(i2);
      const v2 = uvAttr.getY(i2);
      for (const du of [-1, 0, 1]) {
        _uvA.set(u0 + du, v0, 0);
        _uvB.set(u1 + du, v1, 0);
        _uvC.set(u2 + du, v2, 0);
        _uvP.set(u, v, 0);
        _uvTri.set(_uvA, _uvB, _uvC);
        if (_uvTri.getArea() < 1e-16) continue;
        _uvTri.closestPointToPoint(_uvP, _uvClosest);
        const d = _uvClosest.distanceToSquared(_uvP);
        if (d >= bestD) continue;
        bestD = d;
        _uvTri.getBarycoord(_uvClosest, _uvBary);
        _w0.fromBufferAttribute(posAttr, i0).applyMatrix4(mesh.matrixWorld);
        _w1.fromBufferAttribute(posAttr, i1).applyMatrix4(mesh.matrixWorld);
        _w2.fromBufferAttribute(posAttr, i2).applyMatrix4(mesh.matrixWorld);
        _worldFromUv
          .copy(_w0)
          .multiplyScalar(_uvBary.x)
          .addScaledVector(_w1, _uvBary.y)
          .addScaledVector(_w2, _uvBary.z);
        found = true;
      }
    };

    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        tryTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        tryTri(i, i + 1, i + 2);
      }
    }
  }
  return found ? _worldFromUv.clone() : null;
}

const _uvDirScratch = new THREE.Vector3();

/** Unit direction from texture UV, same convention as drawing / LRO-style unwrap: u=0.5 → lon 0, v=0.5 → equator. */
function uvToWorldUnitDir(u, v, target = _uvDirScratch) {
  const lon = (u - 0.5) * Math.PI * 2;
  const lat = (0.5 - v) * Math.PI;
  return target.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)).normalize();
}

function worldPointFromUvSpherical(u, v) {
  uvToWorldUnitDir(u, v, _uvDirScratch);
  return moonAnchorCenter.clone().add(_uvDirScratch.clone().multiplyScalar(moonHullRadius));
}

/** Ray from moon center outward through UV direction; hits the mesh shell (handles non-spherical GLB). */
function worldPointFromUvRaycast(meshes, u, v) {
  if (!meshes.length) return null;
  uvToWorldUnitDir(u, v, _uvDirScratch);
  raycaster.set(moonAnchorCenter, _uvDirScratch);
  raycaster.near = 0;
  raycaster.far = Math.max(moonHullRadius * 25, 50);
  const hits = raycaster.intersectObjects(meshes, false);
  const h = hits[0];
  return h?.point ? h.point.clone() : null;
}

/** Average outward direction of all stroke sample points on the sphere (handles UV seam cleanly). */
function meanDirectionUnitFromStrokes(strokeList, out) {
  out.set(0, 0, 0);
  let n = 0;
  for (const s of strokeList || []) {
    for (const p of s.points || []) {
      const u = Number(p[0]);
      const v = Number(p[1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      uvToWorldUnitDir(u, v, _uvDirScratch);
      out.add(_uvDirScratch);
      n++;
    }
  }
  if (!n) {
    out.set(0, 0, 1);
    return out;
  }
  if (out.lengthSq() < 1e-14) {
    out.set(0, 0, 1);
    return out;
  }
  return out.normalize();
}

function unitDirectionToUv(dir) {
  const lat = Math.asin(clampNum(dir.y, -1, 1));
  const lon = Math.atan2(dir.x, dir.z);
  let u = lon / (Math.PI * 2) + 0.5;
  u -= Math.floor(u);
  const v = clampNum(0.5 - lat / Math.PI, 0, 1);
  return { u, v };
}

function pickMajorityModelId(entries) {
  const counts = {};
  for (const e of entries) counts[e.modelId] = (counts[e.modelId] || 0) + 1;
  let best = MODELS[0].id;
  let max = 0;
  for (const [id, c] of Object.entries(counts)) {
    if (c > max) {
      max = c;
      best = id;
    }
  }
  return best;
}

/**
 * Raycast from moon center along the first saved anchor (pointer-down direction).
 * We do not average multiple anchors — vector mean on the sphere points the wrong way for multi-stroke doodles.
 */
function entryFramingSurfacePoint(entry) {
  const baseMeshes = moonRaycastMeshes.filter((m) => !m.userData.pareidoliaOverlay);
  for (const s of entry.strokes || []) {
    if (!Array.isArray(s.anchorDir) || s.anchorDir.length < 3) continue;
    const d = new THREE.Vector3(
      Number(s.anchorDir[0]),
      Number(s.anchorDir[1]),
      Number(s.anchorDir[2])
    );
    if (d.lengthSq() < 1e-14) continue;
    d.normalize();
    raycaster.set(moonAnchorCenter, d);
    raycaster.near = 0;
    raycaster.far = Math.max(moonHullRadius * 25, 50);
    const hits = raycaster.intersectObjects(baseMeshes, false);
    if (hits[0]?.point) return hits[0].point.clone();
    return moonAnchorCenter.clone().add(d.multiplyScalar(moonHullRadius));
  }
  return null;
}

function unwrapUChain(us) {
  if (!us.length) return [];
  const uu = [us[0]];
  for (let i = 1; i < us.length; i++) {
    let u = us[i];
    const prev = uu[uu.length - 1];
    while (u - prev > 0.5) u -= 1;
    while (prev - u > 0.5) u += 1;
    uu.push(u);
  }
  return uu;
}

/**
 * Framing from stroke UVs resolved on the actual GLB (texture space → mesh), with U unwrapped across the seam.
 */
function framingWorldPointFromMeshUvMean(entry) {
  const baseMeshes = moonRaycastMeshes.filter((m) => !m.userData.pareidoliaOverlay);
  const flatU = [];
  const flatV = [];
  for (const s of entry.strokes || []) {
    for (const p of s.points || []) {
      const u = Number(p[0]);
      const v = Number(p[1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      flatU.push(u);
      flatV.push(v);
    }
  }
  if (!flatU.length) return null;
  const uu = unwrapUChain(flatU);
  let meanU = uu.reduce((a, b) => a + b, 0) / uu.length;
  const meanV = flatV.reduce((a, b) => a + b, 0) / flatV.length;
  meanU -= Math.floor(meanU);
  if (meanU < 0) meanU += 1;
  const vClamped = clampNum(meanV, 0, 1);
  let wp = worldPointFromUvMeshes(baseMeshes, meanU, vClamped);
  if (!wp) wp = worldPointFromUvRaycast(baseMeshes, meanU, vClamped);
  if (!wp) wp = worldPointFromUvSpherical(meanU, vClamped);
  return wp;
}

function framingWorldPointFromEntryStrokes(entry) {
  moonRoot?.updateMatrixWorld(true);
  let wp = framingWorldPointFromMeshUvMean(entry);
  if (!wp) wp = entryFramingSurfacePoint(entry);
  if (!wp) {
    meanDirectionUnitFromStrokes(entry.strokes, _meanStrokeDir);
    const baseMeshes = moonRaycastMeshes.filter((m) => !m.userData.pareidoliaOverlay);
    raycaster.set(moonAnchorCenter, _meanStrokeDir);
    raycaster.near = 0;
    raycaster.far = Math.max(moonHullRadius * 25, 50);
    const rayHits = raycaster.intersectObjects(baseMeshes, false);
    if (rayHits[0]?.point) wp = rayHits[0].point.clone();
    else {
      const { u, v } = unitDirectionToUv(_meanStrokeDir);
      wp = worldPointFromUvMeshes(baseMeshes, u, v);
      if (!wp) wp = worldPointFromUvRaycast(baseMeshes, u, v);
      if (!wp) wp = worldPointFromUvSpherical(u, v);
    }
  }
  return wp;
}

async function focusOrbitOnEntry(entry) {
  const norm = normalizeEntry(entry);
  if (!norm?.strokes?.length) return;
  const model = MODELS.find((m) => m.id === norm.modelId) || MODELS[0];
  if (currentModelId !== model.id) await loadModel(model);
  strokes.length = 0;
  for (const s of norm.strokes) {
    const o = {
      color: s.color,
      width: s.width,
      points: s.points.map((p) => [...p]),
    };
    if (Array.isArray(s.anchorDir) && s.anchorDir.length >= 3) {
      o.anchorDir = [s.anchorDir[0], s.anchorDir[1], s.anchorDir[2]];
    }
    strokes.push(o);
  }
  refreshDrawTexture();
  moonRoot?.updateMatrixWorld(true);
  const wp = framingWorldPointFromEntryStrokes(norm);
  const dir = wp.clone().sub(moonAnchorCenter);
  if (dir.lengthSq() < 1e-14) dir.set(0, 0, 1);
  dir.normalize();
  const surfaceGap = Math.max(moonHullRadius * 0.1, 1e-5);
  controls.minDistance = moonHullRadius + surfaceGap;
  controls.maxDistance = moonHullRadius * 28;
  controls.target.copy(moonAnchorCenter);
  const baseMeshes = moonRaycastMeshes.filter((m) => !m.userData.pareidoliaOverlay);
  let maxSpread = 0.04;
  for (const s of norm.strokes) {
    for (const p of s.points || []) {
      const u = Number(p[0]);
      const v = Number(p[1]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const hit = worldPointFromUvMeshes(baseMeshes, u, v);
      if (!hit) continue;
      const sampleDir = hit.clone().sub(moonAnchorCenter);
      if (sampleDir.lengthSq() < 1e-14) continue;
      sampleDir.normalize();
      const dot = clampNum(sampleDir.dot(dir), -1, 1);
      maxSpread = Math.max(maxSpread, Math.acos(dot));
    }
  }
  const orbitDist = moonHullRadius * clampNum(1.2 + 2.35 * maxSpread, 1.18, 3.25);
  camera.position.copy(moonAnchorCenter.clone().add(dir.multiplyScalar(orbitDist)));
  camera.up.set(0, 1, 0);
  camera.lookAt(moonAnchorCenter);
  syncOrbitControlsFromCamera();
  controls.update();
  openArchive(false);
  setStatus(norm.title);
}

async function applyAllArchivesToMoon({ silent = false } = {}) {
  const local = loadLocalEntries();
  const localIds = new Set(local.map((e) => e.id));
  const combined = [...local, ...communityEntries.filter((c) => !localIds.has(c.id))];
  const entries = combined.map(normalizeEntry).filter((e) => e?.strokes?.length);
  if (!entries.length) {
    if (!silent) setStatus("Nothing to show.");
    return 0;
  }
  const merged = [];
  for (const e of entries) {
    for (const s of e.strokes) {
      const m = {
        color: s.color,
        width: s.width,
        points: s.points.map((p) => [...p]),
      };
      if (Array.isArray(s.anchorDir) && s.anchorDir.length >= 3) {
        m.anchorDir = [Number(s.anchorDir[0]), Number(s.anchorDir[1]), Number(s.anchorDir[2])];
      }
      merged.push(m);
    }
  }
  const modelId = pickMajorityModelId(entries);
  const model = MODELS.find((m) => m.id === modelId) || MODELS[0];
  if (currentModelId !== model.id) await loadModel(model);
  strokes.length = 0;
  for (const s of merged) strokes.push(s);
  refreshDrawTexture();
  if (moonRoot) {
    fitCameraToObject(moonRoot);
    controls.update();
  }
  if (!silent) setStatus("");
  if (!archivePanel.classList.contains("hidden")) buildMoonArchiveTags();
  return entries.length;
}

function getPointerMoonHit(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(moonRaycastMeshes, false);
  const hit = hits[0];
  if (!hit?.uv) return null;
  return { u: hit.uv.x, v: hit.uv.y, point: hit.point.clone() };
}

function getHitUv(clientX, clientY) {
  const h = getPointerMoonHit(clientX, clientY);
  return h ? { u: h.u, v: h.v } : null;
}

function setDrawPaletteExpanded(expanded) {
  const inner = document.getElementById("draw-palette-inner");
  drawPalette.classList.toggle("draw-palette--compact", !expanded);
  btnPaletteExpand?.setAttribute("aria-expanded", expanded ? "true" : "false");
  inner?.setAttribute("aria-hidden", expanded ? "false" : "true");
  const concealFab = !expanded && isDrawMode;
  btnBrush.classList.toggle("fab-brush--concealed", concealFab);
}

function setMode(orbit, { skipBrushHint = false } = {}) {
  if (!orbit) {
    strokes.length = 0;
    refreshDrawTexture();
  }
  isDrawMode = !orbit;
  controls.enabled = true;
  if (orbit) {
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
  } else {
    controls.enableRotate = false;
    controls.enableZoom = true;
    controls.enablePan = false;
  }
  if (orbit) {
    drawPalette.classList.remove("draw-palette--compact");
    btnPaletteExpand?.setAttribute("aria-expanded", "false");
    document.getElementById("draw-palette-inner")?.removeAttribute("aria-hidden");
    btnBrush.classList.remove("fab-brush--concealed");
  } else {
    /* Full palette on first entering draw; hamburger after first stroke on the moon */
    setDrawPaletteExpanded(true);
  }
  drawPalette.classList.toggle("hidden", orbit);
  btnBrush.classList.toggle("fab-brush--active", !orbit);
  btnBrush.setAttribute("aria-pressed", orbit ? "false" : "true");
  const labelEl = btnBrush.querySelector(".fab-brush__label");
  if (labelEl) labelEl.textContent = orbit ? "Brush" : "Back";
  btnBrush.setAttribute(
    "aria-label",
    orbit ? "Draw on the moon with the brush" : "Back — return to exploring the moon"
  );
  btnBrush.title = orbit ? "Brush — draw on the moon" : "Back — stop drawing";
  if (orbit && !skipBrushHint) {
    scheduleBrushHint();
  } else if (!orbit) {
    hideBrushHint(false);
  }
}

async function loadCommunityEntriesForSession(base) {
  const baseUrl = base || document.baseURI || window.location.href;
  if (isArchiveAdminUnlocked()) {
    const rawAdmin = await fetchCommunityArchiveAdmin(baseUrl, ARCHIVE_ADMIN_PASS);
    if (rawAdmin != null) {
      communityEntries = rawAdmin.map(normalizeEntry).filter(Boolean);
      return;
    }
  }
  const raw = await fetchCommunityArchive(baseUrl);
  communityEntries = (Array.isArray(raw) ? raw : []).map(normalizeEntry).filter(Boolean);
}

async function openArchive(open) {
  archivePanel.classList.toggle("hidden", !open);
  if (!open) disposeMoonArchiveTags();
  if (open) {
    syncArchiveAdminButton();
    hideBrushHint(false);
    setMode(true, { skipBrushHint: true });
    buildMoonArchiveTags();
    const base = document.baseURI || window.location.href;
    await loadCommunityEntriesForSession(base);
    renderArchiveLists();
  } else {
    scheduleBrushHint();
  }
  syncArchiveFabVisibilityButton();
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const strokesIn = Array.isArray(raw.strokes) ? raw.strokes : [];
  const cleaned = strokesIn
    .filter((s) => Array.isArray(s.points) && s.points.length)
    .map((s) => {
      const o = {
        color: typeof s.color === "string" ? s.color : "#ffffff",
        width: typeof s.width === "number" ? s.width : 4,
        points: s.points.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]), Number(p[1])]),
      };
      if (Array.isArray(s.anchorDir) && s.anchorDir.length >= 3) {
        o.anchorDir = [Number(s.anchorDir[0]), Number(s.anchorDir[1]), Number(s.anchorDir[2])];
      }
      return o;
    });
  return {
    id: typeof raw.id === "string" ? raw.id : crypto.randomUUID(),
    title: String(raw.title || "Untitled").slice(0, 80),
    author: String(raw.author || "").slice(0, 40),
    createdAt: raw.createdAt || new Date().toISOString(),
    savedAtLocal: String(raw.savedAtLocal || "").slice(0, 120),
    country: String(raw.country || "").slice(0, 80),
    countryCode: String(raw.countryCode || "").slice(0, 4).toUpperCase(),
    timeZone: String(raw.timeZone || "").slice(0, 80),
    modelId: typeof raw.modelId === "string" ? raw.modelId : MODELS[0].id,
    strokes: cleaned,
    submittedIp:
      typeof raw.submittedIp === "string" ? raw.submittedIp.trim().slice(0, 45) : "",
    embTitle: parseEmbedding(raw.embTitle),
    embSketch: parseEmbedding(raw.embSketch),
  };
}

/** In-memory cache so saves are fast after the first lookup; prefetched on startup. */
let userCountryCache = null;

function parseGeoPayload(d, codeKey = "country_code") {
  const name = typeof d.country === "string" ? d.country.trim() : "";
  const codeRaw = d[codeKey];
  const code = typeof codeRaw === "string" ? codeRaw.trim().toUpperCase() : "";
  if (!name && !code) return null;
  return { name: name || code, code: code || "" };
}

/**
 * Resolves country via IP (ipwho.is, then geojs.io fallback). Caches success for the session.
 */
async function resolveUserCountry() {
  if (userCountryCache) return userCountryCache;

  const withTimeout = (ms, fn) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return Promise.resolve(fn(ctrl.signal)).finally(() => clearTimeout(t));
  };

  try {
    const r = await withTimeout(5500, (signal) => fetch("https://ipwho.is/", { signal }));
    if (r.ok) {
      const d = await r.json();
      if (d.success) {
        const g = parseGeoPayload(d, "country_code");
        if (g) {
          userCountryCache = g;
          return g;
        }
      }
    }
  } catch {
    /* try fallback */
  }

  try {
    const r = await withTimeout(5500, (signal) =>
      fetch("https://get.geojs.io/v1/ip/geo.json", { signal })
    );
    if (r.ok) {
      const d = await r.json();
      const g = parseGeoPayload(d, "country_code");
      if (g) {
        userCountryCache = g;
        return g;
      }
    }
  } catch {
    /* none */
  }

  return null;
}


function getAllArchiveEntriesNormalized() {
  const byId = new Map();
  for (const raw of communityEntries) {
    const e = normalizeEntry(raw);
    if (e) byId.set(e.id, e);
  }
  for (const raw of loadLocalEntries()) {
    const e = normalizeEntry(raw);
    if (e) byId.set(e.id, e);
  }
  return [...byId.values()];
}

const SIM_THUMB_W = 280;
const SIM_THUMB_H = 140;
/** Same UV window for every archive / similar thumbnail so list items look equally “big”. */
const ARCHIVE_THUMB_FIXED_UV = 0.19;
const AI_PREVIEW_PX = 384;

function parseEmbedding(raw) {
  if (!Array.isArray(raw) || raw.length !== AI_EMB_DIM) return null;
  const out = [];
  for (let i = 0; i < AI_EMB_DIM; i++) {
    const n = Number(raw[i]);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function strokesToAiPreviewBase64(strokes) {
  const w = AI_PREVIEW_PX;
  const h = AI_PREVIEW_PX;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#07080e";
  ctx.fillRect(0, 0, w, h);
  strokesToThumbnailCropped(ctx, strokes, w, h, {
    fixedUvSpan: ARCHIVE_THUMB_FIXED_UV,
    innerPad: 0.04,
  });
  const dataUrl = c.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}
const LIST_THUMB_PX = 44;

const _meanStrokeDir = new THREE.Vector3();
const _spreadDir = new THREE.Vector3();

function buildArchiveListThumb(strokes) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wrap = document.createElement("div");
  wrap.className = "archive-list__thumb";
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(LIST_THUMB_PX * dpr);
  canvas.height = Math.round(LIST_THUMB_PX * dpr);
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#07080e";
    ctx.fillRect(0, 0, LIST_THUMB_PX, LIST_THUMB_PX);
    strokesToThumbnailCropped(ctx, strokes, LIST_THUMB_PX, LIST_THUMB_PX, {
      fixedUvSpan: ARCHIVE_THUMB_FIXED_UV,
      innerPad: 0.04,
    });
  }
  wrap.appendChild(canvas);
  return wrap;
}

function buildSimilarThumbnail(strokes) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = SIM_THUMB_W;
  const ch = SIM_THUMB_H;
  const wrap = document.createElement("div");
  wrap.className = "similar-panel__thumb-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "similar-panel__thumb-canvas";
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#07080e";
    ctx.fillRect(0, 0, cw, ch);
    strokesToThumbnailCropped(ctx, strokes, cw, ch, {
      fixedUvSpan: ARCHIVE_THUMB_FIXED_UV,
      innerPad: 0.04,
    });
  }
  wrap.appendChild(canvas);
  return wrap;
}

async function openSimilarForEntry(rawEntry) {
  const norm = normalizeEntry(rawEntry);
  if (!norm?.strokes?.length) return;
  let query = norm;
  if (!query.embTitle?.length) {
    setStatus("Finding similar…");
    const base = document.baseURI || window.location.href;
    const b64 = strokesToAiPreviewBase64(norm.strokes);
    const em = await fetchAiEmbeddings(base, norm.title, b64);
    setStatus("");
    const et = parseEmbedding(em.title);
    if (et) {
      query = {
        ...norm,
        embTitle: et,
        embSketch: parseEmbedding(em.sketch),
      };
    }
  }
  const pool = getAllArchiveEntriesNormalized();
  const matches = findTopSimilar(query, pool, { limit: 3 });
  if (!matches.length) {
    setStatus("No similar drawings found.");
    return;
  }
  showSimilarPanel(matches);
}

function showSimilarPanel(matches) {
  hideBrushHint(false);
  const localIds = new Set(loadLocalEntries().map((x) => x.id));
  similarList.innerHTML = "";
  const n = Math.min(3, Math.max(1, matches.length));
  similarList.className = `similar-picks similar-picks--cols-${n}`;
  for (const { entry: e, score } of matches) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "similar-panel__pick";
    const shared = !localIds.has(e.id);
    const meta = formatArchiveMeta(e, shared);
    const pct = Math.round(score * 100);
    btn.setAttribute(
      "aria-label",
      `${e.title}. ${meta}. About ${pct} percent match. View on moon.`
    );
    btn.appendChild(buildSimilarThumbnail(e.strokes || []));
    const cap = document.createElement("div");
    cap.className = "similar-panel__pick-body";
    const titleEl = document.createElement("span");
    titleEl.className = "similar-panel__pick-title";
    titleEl.textContent = e.title;
    const metaEl = document.createElement("span");
    metaEl.className = "similar-panel__meta";
    metaEl.textContent = `${meta} · ~${pct}% match`;
    cap.appendChild(titleEl);
    cap.appendChild(metaEl);
    btn.appendChild(cap);
    btn.addEventListener("click", () => {
      similarPanel.classList.add("hidden");
      void focusOrbitOnEntry(e);
    });
    li.appendChild(btn);
    similarList.appendChild(li);
  }
  similarPanel.classList.remove("hidden");
  requestAnimationFrame(() => btnSimilarClose.focus());
}

async function dismissSimilarPanelContinue() {
  similarPanel.classList.add("hidden");
  await openArchive(true);
}

function isArchiveAdminUnlocked() {
  try {
    return sessionStorage.getItem(ARCHIVE_ADMIN_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function syncArchiveAdminButton() {
  if (!btnArchiveAdmin) return;
  const on = isArchiveAdminUnlocked();
  btnArchiveAdmin.textContent = on ? "Exit admin" : "Admin";
  btnArchiveAdmin.setAttribute("aria-pressed", on ? "true" : "false");
}

function setArchiveAdminUnlocked(on) {
  try {
    if (on) sessionStorage.setItem(ARCHIVE_ADMIN_SESSION_KEY, "1");
    else sessionStorage.removeItem(ARCHIVE_ADMIN_SESSION_KEY);
  } catch {
    /* private / blocked storage */
  }
  syncArchiveAdminButton();
}

async function adminRemoveEntry(entry, shared) {
  if (!window.confirm(`Remove “${entry.title}” from the archive?`)) return;
  if (!shared) {
    const next = loadLocalEntries().filter((x) => x.id !== entry.id);
    saveLocalEntries(next);
  } else {
    const base = document.baseURI || window.location.href;
    const res = await archiveAdminPost(base, {
      password: ARCHIVE_ADMIN_PASS,
      action: "delete",
      id: entry.id,
    });
    if (!res.ok) {
      setStatus(
        res.status === 403
          ? "Server rejected the password (set ARCHIVE_ADMIN_PASSWORD on Netlify to 391612 or your chosen secret)."
          : "Could not remove from shared archive."
      );
      return;
    }
    await loadCommunityEntriesForSession(base);
  }
  setStatus("");
  renderArchiveLists();
  if (!archivePanel.classList.contains("hidden")) {
    buildMoonArchiveTags();
    await applyAllArchivesToMoon({ silent: true });
  }
}

async function adminRenameEntry(entry, shared) {
  const name = window.prompt("New title:", entry.title);
  if (name === null) return;
  const title = name.trim().slice(0, 80);
  if (!title) {
    setStatus("Title cannot be empty.");
    return;
  }
  if (!shared) {
    const next = loadLocalEntries().map((x) => (x.id === entry.id ? { ...x, title } : x));
    saveLocalEntries(next);
  } else {
    const base = document.baseURI || window.location.href;
    const res = await archiveAdminPost(base, {
      password: ARCHIVE_ADMIN_PASS,
      action: "updateTitle",
      id: entry.id,
      title,
    });
    if (!res.ok) {
      setStatus(
        res.status === 403
          ? "Server rejected the password (set ARCHIVE_ADMIN_PASSWORD on Netlify to match this app)."
          : "Could not rename on shared archive."
      );
      return;
    }
    await loadCommunityEntriesForSession(base);
  }
  setStatus("");
  renderArchiveLists();
  if (!archivePanel.classList.contains("hidden")) {
    buildMoonArchiveTags();
    await applyAllArchivesToMoon({ silent: true });
  }
}

function renderArchiveLists() {
  const local = loadLocalEntries();
  const localIds = new Set(local.map((e) => e.id));
  const items = [
    ...local
      .slice()
      .reverse()
      .map((e) => ({ entry: e, shared: false })),
    ...communityEntries.filter((c) => !localIds.has(c.id)).map((e) => ({ entry: e, shared: true })),
  ];
  listArchive.innerHTML = "";
  if (!items.length) {
    listArchive.innerHTML = '<li class="meta">No drawings yet.</li>';
    if (!archivePanel.classList.contains("hidden")) buildMoonArchiveTags();
    return;
  }
  for (const { entry: e, shared } of items) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "archive-list__row";
    row.appendChild(buildArchiveListThumb(e.strokes || []));

    const b = document.createElement("button");
    b.type = "button";
    b.className = "archive-list__open";
    const meta = formatArchiveMeta(e, shared);
    b.innerHTML = `${escapeHtml(e.title)}<span class="meta">${escapeHtml(meta)}</span>`;
    b.addEventListener("click", () => void focusOrbitOnEntry(e));

    const simBtn = document.createElement("button");
    simBtn.type = "button";
    simBtn.className = "archive-list__similar";
    simBtn.innerHTML = SIMILAR_BTN_ICON;
    simBtn.setAttribute("aria-label", `Similar drawings to ${e.title}`);
    simBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void openSimilarForEntry(e);
    });

    row.appendChild(b);
    row.appendChild(simBtn);
    li.appendChild(row);
    if (isArchiveAdminUnlocked()) {
      const ipLine = document.createElement("p");
      ipLine.className = "archive-list__admin-ip";
      if (shared) {
        const ip = typeof e.submittedIp === "string" ? e.submittedIp.trim() : "";
        ipLine.textContent = ip ? `IP · ${ip}` : "IP · Not recorded";
      } else {
        ipLine.textContent = "IP · This device only (not on shared server)";
      }
      li.appendChild(ipLine);

      const adminRow = document.createElement("div");
      adminRow.className = "archive-list__admin-row";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "archive-list__admin-btn";
      delBtn.textContent = "Remove";
      delBtn.setAttribute("aria-label", `Remove ${e.title} from archive`);
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void adminRemoveEntry(e, shared);
      });
      const renBtn = document.createElement("button");
      renBtn.type = "button";
      renBtn.className = "archive-list__admin-btn";
      renBtn.textContent = "Rename";
      renBtn.setAttribute("aria-label", `Rename ${e.title}`);
      renBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void adminRenameEntry(e, shared);
      });
      adminRow.appendChild(delBtn);
      adminRow.appendChild(renBtn);
      li.appendChild(adminRow);
    }
    listArchive.appendChild(li);
  }
  if (!archivePanel.classList.contains("hidden")) buildMoonArchiveTags();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
  } catch {
    return "";
  }
}

function formatArchiveMeta(e, shared) {
  const when = formatDate(e.createdAt);
  const place = e.country || e.countryCode || "";
  const bits = [when, place].filter(Boolean).join(" · ");
  const prefix = shared ? "Shared · " : "";
  return prefix + (bits || when);
}

async function loadModel(model) {
  if (currentModelId === model.id) return;
  setStatus("Loading…");
  let gltf;
  try {
    gltf = await loadGltfFirstWorking(localAssetCandidates(model.file));
  } catch {
    try {
      gltf = await loader.loadAsync(model.url);
    } catch (e2) {
      console.error("Remote NASA URL also failed (often browser CORS):", model.url, e2);
      const isFile = window.location.protocol === "file:";
      setStatus(
        isFile
          ? "Open via a local server (run npm start), not by double-clicking the HTML file."
          : `Add assets/${model.file} (from NASA SVS 14959). Browsers cannot load that NASA URL directly.`
      );
      return;
    }
  }
  try {
    if (moonRoot) {
      scene.remove(moonRoot);
      disposeObject3D(moonRoot);
    }
    clearOverlayLayer();
    moonRoot = gltf.scene;
    scene.add(moonRoot);
    moonRoot.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.depthWrite = true;
        child.frustumCulled = true;
      }
    });
    upgradeLoadedTextures(moonRoot);
    fitCameraToObject(moonRoot);
    setupPareidoliaLayer();
    refreshDrawTexture();
    currentModelId = model.id;
    setStatus("");
  } catch (e) {
    console.error(e);
    setStatus("Failed to attach model to scene.");
  }
}

function onResize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  applyPixelRatio();
  renderer.setSize(w, h, false);
}

brushHintClose?.addEventListener("click", () => hideBrushHint(true));

btnBrush.addEventListener("click", () => {
  if (isDrawMode) setMode(true);
  else setMode(false);
});

btnArchiveFab.addEventListener("click", async () => {
  const willOpen = archivePanel.classList.contains("hidden");
  await openArchive(willOpen);
  if (willOpen) await applyAllArchivesToMoon({ silent: true });
});
btnCloseArchive.addEventListener("click", () => openArchive(false));

document.querySelectorAll(".archive-visibility-sync").forEach((btn) => {
  btn.addEventListener("click", () => {
    archiveMoonDrawingsVisible = !archiveMoonDrawingsVisible;
    applyArchiveMoonDrawingsVisibility();
  });
});

btnArchiveAdmin?.addEventListener("click", () => {
  if (isArchiveAdminUnlocked()) {
    setArchiveAdminUnlocked(false);
    void (async () => {
      const base = document.baseURI || window.location.href;
      await loadCommunityEntriesForSession(base);
      renderArchiveLists();
    })();
    return;
  }
  const pw = window.prompt("Admin password:");
  if (pw === null) return;
  if (pw !== ARCHIVE_ADMIN_PASS) {
    setStatus("Incorrect password.");
    return;
  }
  setStatus("");
  setArchiveAdminUnlocked(true);
  void (async () => {
    const base = document.baseURI || window.location.href;
    await loadCommunityEntriesForSession(base);
    renderArchiveLists();
  })();
});
btnSimilarClose.addEventListener("click", () => void dismissSimilarPanelContinue());
similarPanel.addEventListener("click", (e) => {
  if (e.target === similarPanel) void dismissSimilarPanelContinue();
});

btnUndo.addEventListener("click", () => {
  strokes.pop();
  refreshDrawTexture();
});

btnClear.addEventListener("click", () => {
  strokes.length = 0;
  refreshDrawTexture();
});

btnSave.addEventListener("click", async () => {
  if (!strokes.length) {
    setStatus("Draw something first.");
    return;
  }
  const name = entryTitle.value.trim();
  if (!name) {
    setStatus("Add a name before saving.");
    entryTitle.focus();
    return;
  }
  const strokesSnapshot = strokes.map((s) => {
    const o = {
      color: s.color,
      width: s.width,
      points: s.points.map((p) => [...p]),
    };
    if (Array.isArray(s.anchorDir) && s.anchorDir.length >= 3) {
      o.anchorDir = [s.anchorDir[0], s.anchorDir[1], s.anchorDir[2]];
    }
    return o;
  });
  setStatus("Saving…");
  const geo = await resolveUserCountry();
  const now = new Date();
  let timeZone = "";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    /* ignore */
  }
  const entry = normalizeEntry({
    title: name,
    modelId: currentModelId,
    createdAt: now.toISOString(),
    savedAtLocal: formatDate(now.toISOString()),
    country: geo?.name || "",
    countryCode: geo?.code || "",
    timeZone,
    strokes: strokesSnapshot,
  });
  const all = loadLocalEntries();
  all.push(entry);
  saveLocalEntries(all);
  const base = document.baseURI || window.location.href;
  const previewPngBase64 = strokesToAiPreviewBase64(strokesSnapshot);
  const shared = await pushSharedArchiveEntry(base, { ...entry, previewPngBase64 });
  const embT = parseEmbedding(shared.embeddings?.title);
  if (shared.ok && embT) {
    entry.embTitle = embT;
    entry.embSketch = parseEmbedding(shared.embeddings?.sketch);
    const all2 = loadLocalEntries();
    const ix = all2.findIndex((x) => x.id === entry.id);
    if (ix >= 0) {
      all2[ix] = {
        ...all2[ix],
        embTitle: entry.embTitle,
        embSketch: entry.embSketch,
      };
      saveLocalEntries(all2);
    }
  }
  if (!shared.ok) {
    setStatus(
      window.location.hostname.endsWith(".github.io")
        ? "Saved on this device. GitHub Pages has no API — open your Netlify site URL to use the shared archive."
        : "Saved on this device. For a shared archive use Netlify (not static hosting only) or run npm start locally."
    );
  } else {
    setStatus("");
  }
  const archivedAt = performance.now();
  showArchivedFeedback(name);
  entryTitle.value = "";
  await loadCommunityEntriesForSession(base);
  const pool = getAllArchiveEntriesNormalized();
  const selfFromPool = pool.find((x) => x.id === entry.id);
  const queryForSimilar = selfFromPool && selfFromPool.embTitle?.length ? selfFromPool : entry;
  const topSimilar = findTopSimilar(queryForSimilar, pool, { limit: 3 });
  if (topSimilar.length > 0) {
    const minMsBeforeSimilar = 950;
    const elapsed = performance.now() - archivedAt;
    await new Promise((r) => setTimeout(r, Math.max(0, minMsBeforeSimilar - elapsed)));
    showSimilarPanel(topSimilar);
  } else {
    await openArchive(true);
  }
});

function startDrawingStroke(e, hit) {
  e.preventDefault();
  pointerDrawing = true;
  setDrawPaletteExpanded(false);
  canvas.setPointerCapture?.(e.pointerId);
  moonRoot?.updateMatrixWorld(true);
  const anchorDir = hit.point.clone().sub(moonAnchorCenter).normalize();
  drawingStroke = {
    color: drawColor.value,
    width: Number(drawWidth.value),
    points: [[hit.u, hit.v]],
    _anchorDir: anchorDir,
  };
}

function pushTapDotStroke(hit) {
  moonRoot?.updateMatrixWorld(true);
  const anchorDir = hit.point.clone().sub(moonAnchorCenter).normalize();
  strokes.push({
    color: drawColor.value,
    width: Number(drawWidth.value),
    points: [[hit.u, hit.v]],
    anchorDir: [anchorDir.x, anchorDir.y, anchorDir.z],
  });
  refreshDrawTexture();
}

function onPointerDown(e) {
  if (!isDrawMode) return;
  if (e.pointerType === "mouse" || e.pointerType === "pen") {
    if (e.button !== 0) return;
  } else if (e.pointerType !== "touch") {
    return;
  }

  if (e.pointerType === "touch") {
    canvasTouchPointerIds.add(e.pointerId);
    if (canvasTouchPointerIds.size > 1) {
      touchDrawPending = null;
      return;
    }
    const hit = getPointerMoonHit(e.clientX, e.clientY);
    if (!hit) {
      canvasTouchPointerIds.delete(e.pointerId);
      return;
    }
    touchDrawPending = {
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      hit,
    };
    return;
  }

  const hit = getPointerMoonHit(e.clientX, e.clientY);
  if (!hit) return;
  startDrawingStroke(e, hit);
}

function onPointerMove(e) {
  if (!isDrawMode) return;

  if (touchDrawPending && e.pointerId === touchDrawPending.pointerId) {
    if (canvasTouchPointerIds.size > 1) {
      touchDrawPending = null;
      return;
    }
    const dx = e.clientX - touchDrawPending.x0;
    const dy = e.clientY - touchDrawPending.y0;
    if (dx * dx + dy * dy >= TOUCH_DRAW_SLOP_SQ) {
      const { hit } = touchDrawPending;
      touchDrawPending = null;
      startDrawingStroke(e, hit);
      const uv = getHitUv(e.clientX, e.clientY);
      if (uv && drawingStroke) {
        const prev = drawingStroke.points[drawingStroke.points.length - 1];
        segmentOnCanvas(prev[0], prev[1], uv.u, uv.v);
        drawingStroke.points.push([uv.u, uv.v]);
      }
    }
    return;
  }

  if (!pointerDrawing || !drawingStroke) return;
  const uv = getHitUv(e.clientX, e.clientY);
  if (!uv) return;
  const prev = drawingStroke.points[drawingStroke.points.length - 1];
  segmentOnCanvas(prev[0], prev[1], uv.u, uv.v);
  drawingStroke.points.push([uv.u, uv.v]);
}

function onPointerUp(e) {
  if (e.pointerType === "touch") {
    if (touchDrawPending && touchDrawPending.pointerId === e.pointerId) {
      const pending = touchDrawPending;
      touchDrawPending = null;
      const wasOnlyFinger = canvasTouchPointerIds.size === 1;
      canvasTouchPointerIds.delete(e.pointerId);
      if (wasOnlyFinger && isDrawMode && !pointerDrawing && e.type === "pointerup") {
        pushTapDotStroke(pending.hit);
      }
    } else {
      canvasTouchPointerIds.delete(e.pointerId);
    }
  }

  if (!pointerDrawing) return;
  pointerDrawing = false;
  canvas.releasePointerCapture?.(e.pointerId);
  if (drawingStroke && drawingStroke.points.length >= 1) {
    const s = {
      color: drawingStroke.color,
      width: drawingStroke.width,
      points: drawingStroke.points.map((p) => [...p]),
    };
    if (drawingStroke._anchorDir) {
      s.anchorDir = [
        drawingStroke._anchorDir.x,
        drawingStroke._anchorDir.y,
        drawingStroke._anchorDir.z,
      ];
    }
    strokes.push(s);
  }
  drawingStroke = null;
  refreshDrawTexture();
}

btnPaletteExpand?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setDrawPaletteExpanded(true);
  requestAnimationFrame(() => drawColor?.focus());
});

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("lostpointercapture", () => {
  touchDrawPending = null;
  pointerDrawing = false;
  drawingStroke = null;
});

window.addEventListener("resize", onResize);

function tick() {
  requestAnimationFrame(tick);
  controls.update();
  syncSunToView();
  updateMoonArchiveTagPositions();
  renderer.render(scene, camera);
}

setMode(true);
syncArchiveAdminButton();
applyArchiveMoonDrawingsVisibility();
syncArchiveFabVisibilityButton();
onResize();
tick();

btnWelcomeArchive.addEventListener("click", () => dismissWelcome(true));
btnWelcomeExplore.addEventListener("click", () => dismissWelcomeExplore());
welcomeOverlay.addEventListener("click", (e) => {
  if (e.target === welcomeOverlay) dismissWelcomeExplore();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!welcomeOverlay.classList.contains("hidden")) {
    e.preventDefault();
    dismissWelcomeExplore();
    return;
  }
  if (brushHintEl && !brushHintEl.classList.contains("hidden")) {
    e.preventDefault();
    hideBrushHint(true);
    return;
  }
  if (!similarPanel.classList.contains("hidden")) {
    e.preventDefault();
    void dismissSimilarPanelContinue();
    return;
  }
  if (!archivePanel.classList.contains("hidden")) {
    e.preventDefault();
    void openArchive(false);
    return;
  }
  if (isDrawMode) {
    e.preventDefault();
    setMode(true);
  }
});

if (!welcomeOverlay.classList.contains("hidden")) {
  setTimeout(() => btnWelcomeExplore.focus(), 500);
}

let initialMoonLoad = loadModel(MODELS[0]);
void resolveUserCountry().catch(() => {});
