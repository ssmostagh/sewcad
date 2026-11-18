/**
 * Pattern Studio v2 — Application Controller (`app.mjs`)
 * Canonical `mm` state, bounded Undo/Redo, XSS-safe DOM updates,
 * REST API + offline core integration, 2D CAD, WebGL2 PBR Cloth & 1:1 Export.
 */

import '../src/core/index.mjs';
import {
  mmToUnit,
  unitToMm,
  formatUnitValue,
  DEFAULT_AVATAR_MEASUREMENTS,
  ValidationError,
} from '../src/core/types.mjs';
import {
  computePieceMeasurements,
  polygonBounds,
  dist2D,
} from '../src/core/geometry.mjs';
import {
  TEMPLATE_CATALOG,
  generateTemplatePattern,
  createFreeformPiece,
  createRectanglePiece,
  addDartToPiece,
  toggleDartFold,
  addNotchToPiece,
  splitPieceEdge,
  deletePieceVertex,
  mirrorPieceAcrossEdge,
  validatePatternSeams,
} from '../src/core/templates.mjs';
import {
  parseSTL,
  unwrapSTLToPattern,
  createWedgeSTL,
} from '../src/core/stl.mjs';
import {
  MATERIAL_PRESETS,
  WEAVE_TYPES,
  getMaterialConfig,
  generateProceduralPBRMaps,
} from '../src/core/materials.mjs';
import {
  createParametricAvatar,
  ClothSimulation,
} from '../src/core/physics.mjs';
import {
  FABRIC_ROLL_PRESETS,
  nestPatternPieces,
} from '../src/core/nesting.mjs';
import {
  PAGE_FORMATS,
  exportSVG,
  exportDXF,
  exportPatternJSON,
  importPatternJSON,
} from '../src/core/exporters.mjs';

import { CAD2DViewport, inferCurveType } from './cad2d.mjs';
import { createViewport3D } from './webgl3d.mjs';
import {
  WOMENS_SIZE_PRESETS,
  DEFAULT_WOMENS_AVATAR_MEASUREMENTS,
} from '../src/core/womens_templates.mjs';

const PARAMETRIC_SCHEMA = {
  bodice_sloper: [
    { key: 'chestMm', label: 'Full Bust Circumference', min: 720, max: 1480, step: 5, isLength: true },
    { key: 'underbustMm', label: 'Underbust (Cup Frame)', min: 520, max: 1380, step: 5, isLength: true },
    { key: 'waistMm', label: 'Natural Waist', min: 560, max: 1360, step: 5, isLength: true },
    { key: 'lengthMm', label: 'Bodice Length (HPS to Waist)', min: 340, max: 560, step: 5, isLength: true },
    { key: 'shoulderWidthMm', label: 'Shoulder Width', min: 310, max: 500, step: 5, isLength: true },
    { key: 'bustSpanMm', label: 'Bust Apex Span', min: 145, max: 270, step: 2, isLength: true },
    { key: 'sleeveLengthMm', label: 'Sleeve Length (Short to Long)', min: 130, max: 620, step: 10, isLength: true },
    { key: 'easeMm', label: 'Wearing Ease', min: 15, max: 180, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  princess_bodice: [
    { key: 'chestMm', label: 'Full Bust Circumference', min: 720, max: 1480, step: 5, isLength: true },
    { key: 'underbustMm', label: 'Underbust (Cup Frame)', min: 520, max: 1380, step: 5, isLength: true },
    { key: 'waistMm', label: 'Natural Waist', min: 540, max: 1340, step: 5, isLength: true },
    { key: 'lengthMm', label: 'Bodice Length', min: 330, max: 540, step: 5, isLength: true },
    { key: 'shoulderWidthMm', label: 'Shoulder Width', min: 310, max: 500, step: 5, isLength: true },
    { key: 'bustSpanMm', label: 'Bust Apex Span', min: 145, max: 270, step: 2, isLength: true },
    { key: 'frontNeckDropMm', label: 'Neckline Depth', min: 55, max: 165, step: 5, isLength: true },
    { key: 'easeMm', label: 'Wearing Ease', min: 10, max: 160, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  fit_flare_dress: [
    { key: 'chestMm', label: 'Full Bust Circumference', min: 720, max: 1480, step: 5, isLength: true },
    { key: 'underbustMm', label: 'Underbust (Cup Frame)', min: 520, max: 1380, step: 5, isLength: true },
    { key: 'waistMm', label: 'Natural Waist', min: 560, max: 1360, step: 5, isLength: true },
    { key: 'hipMm', label: 'Full Hip Circumference', min: 780, max: 1560, step: 5, isLength: true },
    { key: 'lengthMm', label: 'Bodice Length (HPS to Waist)', min: 340, max: 520, step: 5, isLength: true },
    { key: 'heightMm', label: 'Skirt Length (Waist to Hem)', min: 360, max: 880, step: 10, isLength: true },
    { key: 'hemWidthMm', label: 'Skirt Hem Flare', min: 50, max: 320, step: 5, isLength: true },
    { key: 'easeMm', label: 'Wearing Ease', min: 15, max: 180, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  aline_skirt: [
    { key: 'waistMm', label: 'Natural Waist', min: 560, max: 1400, step: 5, isLength: true },
    { key: 'hipMm', label: 'Full Hip Circumference', min: 760, max: 1580, step: 5, isLength: true },
    { key: 'lengthMm', label: 'Skirt Length', min: 340, max: 960, step: 10, isLength: true },
    { key: 'hemWidthMm', label: 'A-Line Hem Flare', min: 30, max: 320, step: 5, isLength: true },
    { key: 'waistbandHeightMm', label: 'Waistband Height', min: 25, max: 85, step: 2, isLength: true },
    { key: 'easeMm', label: 'Hip Fit Ease', min: 10, max: 160, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  pencil_skirt: [
    { key: 'waistMm', label: 'Natural Waist', min: 560, max: 1400, step: 5, isLength: true },
    { key: 'hipMm', label: 'Full Hip Circumference', min: 760, max: 1580, step: 5, isLength: true },
    { key: 'lengthMm', label: 'Skirt Length', min: 420, max: 880, step: 10, isLength: true },
    { key: 'hemWidthMm', label: 'Knee Peg Taper', min: 0, max: 80, step: 2, isLength: true },
    { key: 'waistbandHeightMm', label: 'Waistband Height', min: 25, max: 85, step: 2, isLength: true },
    { key: 'easeMm', label: 'Hip Fit Ease', min: 10, max: 150, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  womens_trousers: [
    { key: 'waistMm', label: 'Natural Waist', min: 560, max: 1400, step: 5, isLength: true },
    { key: 'hipMm', label: 'Full Hip Circumference', min: 780, max: 1580, step: 5, isLength: true },
    { key: 'inseamMm', label: 'Inseam Length', min: 580, max: 880, step: 10, isLength: true },
    { key: 'frontRiseMm', label: 'High-Waist Front Rise', min: 240, max: 380, step: 5, isLength: true },
    { key: 'backRiseMm', label: 'Contoured Back Rise', min: 300, max: 460, step: 5, isLength: true },
    { key: 'ankleWidthMm', label: 'Wide-Leg Hem Opening', min: 340, max: 720, step: 10, isLength: true },
    { key: 'easeMm', label: 'Hip Fit Ease', min: 15, max: 160, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  tshirt: [
    { key: 'chestMm', label: 'Chest Circumference', min: 760, max: 1400, step: 10, isLength: true },
    { key: 'waistMm', label: 'Waist Circumference', min: 680, max: 1360, step: 10, isLength: true },
    { key: 'lengthMm', label: 'Garment Length', min: 500, max: 920, step: 10, isLength: true },
    { key: 'shoulderWidthMm', label: 'Shoulder Width', min: 340, max: 580, step: 5, isLength: true },
    { key: 'sleeveLengthMm', label: 'Sleeve Length', min: 140, max: 680, step: 10, isLength: true },
    { key: 'bicepWidthMm', label: 'Bicep Width', min: 260, max: 520, step: 10, isLength: true },
    { key: 'easeMm', label: 'Fit Ease', min: 0, max: 240, step: 10, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  hoodie: [
    { key: 'chestMm', label: 'Chest Circumference', min: 820, max: 1480, step: 10, isLength: true },
    { key: 'lengthMm', label: 'Total Length', min: 540, max: 920, step: 10, isLength: true },
    { key: 'shoulderWidthMm', label: 'Shoulder Width', min: 380, max: 620, step: 5, isLength: true },
    { key: 'sleeveLengthMm', label: 'Long Sleeve Length', min: 450, max: 740, step: 10, isLength: true },
    { key: 'hoodHeightMm', label: 'Hood Crown Height', min: 280, max: 460, step: 10, isLength: true },
    { key: 'hoodDepthMm', label: 'Hood Depth', min: 210, max: 360, step: 5, isLength: true },
    { key: 'easeMm', label: 'Oversize Ease', min: 40, max: 280, step: 10, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  pants: [
    { key: 'waistMm', label: 'Waist Circumference', min: 620, max: 1300, step: 10, isLength: true },
    { key: 'hipMm', label: 'Hip Circumference', min: 800, max: 1450, step: 10, isLength: true },
    { key: 'inseamMm', label: 'Inseam Length', min: 550, max: 920, step: 10, isLength: true },
    { key: 'frontRiseMm', label: 'Front Rise', min: 210, max: 360, step: 5, isLength: true },
    { key: 'backRiseMm', label: 'Back Rise', min: 260, max: 430, step: 5, isLength: true },
    { key: 'ankleWidthMm', label: 'Ankle Opening', min: 300, max: 620, step: 10, isLength: true },
    { key: 'easeMm', label: 'Hip Fit Ease', min: 10, max: 160, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  tote_bag: [
    { key: 'widthMm', label: 'Bag Width', min: 200, max: 650, step: 10, isLength: true },
    { key: 'heightMm', label: 'Bag Height', min: 220, max: 650, step: 10, isLength: true },
    { key: 'gussetDepthMm', label: 'Gusset Depth', min: 50, max: 260, step: 5, isLength: true },
    { key: 'strapLengthMm', label: 'Strap Length', min: 350, max: 950, step: 10, isLength: true },
    { key: 'strapWidthMm', label: 'Strap Width', min: 20, max: 70, step: 5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
  ],
  stl_cover: [
    { key: 'easeMm', label: '3D Cover Fit Ease', min: 0, max: 20, step: 0.5, isLength: true },
    { key: 'thicknessMm', label: 'Shell Thickness Offset', min: 0, max: 15, step: 0.5, isLength: true },
    { key: 'seamAllowance', label: 'Seam Allowance', min: 0, max: 30, step: 1, isLength: true },
    { key: 'scale', label: '3D Scale Factor', min: 0.25, max: 3.0, step: 0.05, isLength: false },
  ],
};

const MATERIAL_PHYSICS_SLIDERS = [
  { key: 'gsm', label: 'Weight (GSM)', min: 40, max: 1200, step: 10, decimals: 0 },
  { key: 'thicknessMm', label: 'Thickness (mm)', min: 0.1, max: 12, step: 0.05, decimals: 2 },
  { key: 'warpStiffness', label: 'Warp Stiffness', min: 0.05, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'weftStiffness', label: 'Weft Stiffness', min: 0.05, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'shearStiffness', label: 'Shear Stiffness', min: 0.05, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'bendStiffness', label: 'Bend Stiffness', min: 0.01, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'damping', label: 'Damping', min: 0.01, max: 0.99, step: 0.01, decimals: 2 },
  { key: 'friction', label: 'Surface Friction', min: 0.05, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'maxSafeStrainPct', label: 'Max Safe Strain (%)', min: 2, max: 120, step: 1, decimals: 0 },
];

const MATERIAL_PBR_SLIDERS = [
  { key: 'roughness', label: 'Roughness', min: 0.05, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'metallic', label: 'Metallic', min: 0.0, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'normal', label: 'Normal Strength', min: 0.0, max: 2.0, step: 0.05, decimals: 2 },
  { key: 'ao', label: 'Ambient Occlusion', min: 0.0, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'sheen', label: 'Textile Sheen', min: 0.0, max: 1.0, step: 0.01, decimals: 2 },
  { key: 'threadScaleMm', label: 'Weave Scale (mm)', min: 0.2, max: 6.0, step: 0.1, decimals: 1 },
];

class UndoRedoManager {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  _snapshot(st) {
    return {
      json: JSON.stringify({
        pattern: st.pattern,
        selectedPieceId: st.selectedPieceId,
        selectedEdgeIndex: st.selectedEdgeIndex,
        selectedVertexIndex: st.selectedVertexIndex,
        templateId: st.templateId,
        activeStlSource: st.activeStlSource ? { ...st.activeStlSource } : null,
      }),
      activeStlMesh: st.activeStlMesh || null,
      activeStlSource: st.activeStlSource ? { ...st.activeStlSource } : null,
    };
  }

  _sameSnapshot(a, b) {
    return Boolean(a && b && a.json === b.json && a.activeStlMesh === b.activeStlMesh);
  }

  _hydrateSnapshot(entry) {
    if (!entry) return null;
    const parsed = JSON.parse(entry.json);
    parsed.activeStlMesh = entry.activeStlMesh || null;
    parsed.activeStlSource = entry.activeStlSource ? { ...entry.activeStlSource } : null;
    return parsed;
  }

  push(st) {
    if (!st.pattern) return;
    const snap = this._snapshot(st);
    if (this.undoStack.length > 0 && this._sameSnapshot(this.undoStack[this.undoStack.length - 1], snap)) {
      return;
    }
    this.undoStack.push(snap);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo(st) {
    if (!this.canUndo()) return null;
    const cur = this._snapshot(st);
    this.redoStack.push(cur);
    return this._hydrateSnapshot(this.undoStack.pop());
  }

  redo(st) {
    if (!this.canRedo()) return null;
    const cur = this._snapshot(st);
    this.undoStack.push(cur);
    return this._hydrateSnapshot(this.redoStack.pop());
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  popIfUnchanged(st) {
    if (this.undoStack.length === 0 || !st.pattern) return;
    if (this._sameSnapshot(this.undoStack[this.undoStack.length - 1], this._snapshot(st))) {
      this.undoStack.pop();
    }
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

export const state = {
  templateId: 'tshirt',
  unit: 'mm',
  viewMode: 'split',
  activeTool: 'select',
  pattern: null,
  selectedPieceId: null,
  selectedEdgeIndex: 0,
  selectedVertexIndex: -1,
  pendingSeamEdge: null,

  showSeams2D: true,
  showLengths2D: true,
  showCutLine2D: true,
  showGrain2D: true,

  seamWalk: {
    seamId: null,
    walkT: 0,
  },

  // 3D & Physics
  sim: null,
  simRunning: false,
  autoSettleRemaining: 0,
  showStrainMap: false,
  showForm3D: true,
  showWire3D: false,
  showThreads3D: false,
  pinMode3D: false,
  autoSyncBlockToForm: false,
  strainReport: null,
  avatarMeasurements: { ...DEFAULT_AVATAR_MEASUREMENTS },
  avatar: createParametricAvatar(DEFAULT_AVATAR_MEASUREMENTS),
  activeStlMesh: null,
  activeStlSource: null,

  // Material
  materialOverrides: {},

  // Nesting & Export
  nestingOptions: {
    rollPreset: 'roll_54in',
    fabricWidthMm: 1371.6,
    marginMm: 10,
    spacingMm: 8,
    allowRotate90: true,
    lockGrainline: false,
  },
  nestingResult: null,
  activeSheetIndex: 0,
  exportOptions: {
    pageFormat: 'LETTER',
    orientation: 'portrait',
    marginMm: 10,
    overlapMm: 15,
    layout: 'cad',
    includeAssemblyMap: false,
    skipBlankTiles: false,
  },
};

const DRAFT_STORAGE_KEY = 'sewcad_draft_v1';

const history = new UndoRedoManager(50);
let cad2D = null;
let viewport3D = null;
let toastTimer = null;
let sliderSettleTimer = null;
let draftSaveTimer = null;
let suppressDraftSave = false;
let templateLoadSeq = 0;
let rafScheduled = false;

const TOOL_LABELS = {
  select: 'Move (V)',
  edit_points: 'Points (A)',
  draw_poly: 'Pen Poly (P)',
  add_rect: 'Add Rect (R)',
  split_edge: 'Split Edge (I)',
  sew: 'Sew Seam (S)',
  dart: 'Add Dart (D)',
  notch: 'Notch (N)',
  mirror: 'Unfold (M)',
};

const TOOL_HOTKEYS = {
  v: 'select',
  a: 'edit_points',
  p: 'draw_poly',
  r: 'add_rect',
  i: 'split_edge',
  s: 'sew',
  d: 'dart',
  n: 'notch',
  m: 'mirror',
};

function readSavedUnitPref() {
  try {
    const raw = globalThis.localStorage?.getItem('psv2_unit');
    if (raw === 'in' || raw === 'cm' || raw === 'mm') return raw;
  } catch {
    // ignore storage access issues
  }
  return 'in';
}

function saveUnitPref(u) {
  if (!isLiveBrowserCanvas()) return;
  try {
    globalThis.localStorage?.setItem('psv2_unit', u);
  } catch {
    // ignore storage access issues
  }
}

function activateInspectorTab(tabId) {
  document.querySelectorAll('.inspector-tabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset?.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === tabId);
  });
}

function syncContextualSidebarSections() {
  const avDet = el('avatarDetails');
  const stlDet = el('stlUnwrapDetails');
  const tId = state.templateId;
  if (tId === 'stl_cover') {
    if (avDet) avDet.open = false;
    if (stlDet) stlDet.open = true;
  } else if (tId === 'tote_bag') {
    if (avDet) avDet.open = false;
    if (stlDet) stlDet.open = false;
  } else {
    if (avDet) avDet.open = true;
    if (stlDet) stlDet.open = false;
  }
}

function updatePdfSpecBadge() {
  const badge = el('pdfSpecBadge');
  if (!badge) return;
  const fmt = String(state.exportOptions?.pageFormat || 'LETTER');
  const shortFmt = fmt === 'LETTER' ? 'Letter' : fmt === 'TABLOID' ? 'Tabloid' : fmt;
  const isNested = state.exportOptions?.layout === 'nested';
  badge.textContent = isNested ? `${shortFmt}·Nest` : shortFmt;
}

function refreshAvatarPresetLabels() {
  const sel = el('avSizePresetSelect');
  const badge = el('avatarActiveBadge');
  const u = state.unit;
  const dec = u === 'mm' ? 0 : 1;
  const unitSuffix = u === 'in' ? '"' : ` ${u}`;
  if (sel && Array.isArray(sel.options || null) || (sel && sel.options && typeof sel.options.length === 'number')) {
    const opts = Array.from(sel.options);
    const usMap = {
      XS: 'XS (US 2)',
      S: 'S (US 4–6)',
      M: 'M (US 8–10)',
      L: 'L (US 12–14)',
      XL: 'XL (US 16–18)',
      '1X': '1X (US 20W)',
      '2X': '2X (US 22–24W)',
    };
    for (const opt of opts) {
      const p = WOMENS_SIZE_PRESETS[opt.value];
      if (p && usMap[opt.value]) {
        const b = mmToUnit(p.chestMm, u).toFixed(dec);
        const w = mmToUnit(p.waistMm, u).toFixed(dec);
        const h = mmToUnit(p.hipMm, u).toFixed(dec);
        opt.textContent = `${usMap[opt.value]} — B ${b}${unitSuffix} / W ${w}${unitSuffix} / H ${h}${unitSuffix}`;
      }
    }
  }
  if (badge) {
    const val = sel?.value || 'M';
    badge.textContent = val === 'custom' ? 'Custom' : `Size ${val}`;
  }
}

function syncActiveGarmentBlockToAvatarInPlace() {
  if (!state.pattern || state.templateId === 'stl_cover' || state.templateId === 'tote_bag') {
    return false;
  }
  const schema = PARAMETRIC_SCHEMA[state.templateId] || [];
  if (schema.length === 0) return false;
  const nextParams = { ...(state.pattern.params || {}) };
  const av = state.avatarMeasurements;
  let changed = false;
  for (const s of schema) {
    if (s.key === 'chestMm' && Number.isFinite(av.chestMm)) { nextParams.chestMm = av.chestMm; changed = true; }
    if (s.key === 'underbustMm' && Number.isFinite(av.underbustMm)) { nextParams.underbustMm = av.underbustMm; changed = true; }
    if (s.key === 'waistMm' && Number.isFinite(av.waistMm)) { nextParams.waistMm = av.waistMm; changed = true; }
    if (s.key === 'hipMm' && Number.isFinite(av.hipMm)) { nextParams.hipMm = av.hipMm; changed = true; }
    if (s.key === 'shoulderWidthMm' && Number.isFinite(av.shoulderWidthMm)) { nextParams.shoulderWidthMm = av.shoulderWidthMm; changed = true; }
    if (s.key === 'bustSpanMm' && Number.isFinite(av.bustSpanMm)) { nextParams.bustSpanMm = av.bustSpanMm; changed = true; }
  }
  if (!changed) return false;
  const matId = state.pattern.materialId;
  state.pattern = generateTemplatePattern(state.templateId, nextParams);
  if (matId) state.pattern.materialId = matId;
  if (state.pattern?.pieces?.length && !state.pattern.pieces.some((p) => p.id === state.selectedPieceId)) {
    state.selectedPieceId = state.pattern.pieces[0].id;
    state.selectedVertexIndex = -1;
    state.selectedEdgeIndex = 0;
  }
  return true;
}

function scheduleDebouncedSliderSettle() {
  if (!isLiveBrowserCanvas() || state.simRunning) return;
  if (sliderSettleTimer) clearTimeout(sliderSettleTimer);
  sliderSettleTimer = setTimeout(() => {
    sliderSettleTimer = null;
    if (isLiveBrowserCanvas() && !state.simRunning) {
      startBrowserAutoSettle(14, 34);
    }
  }, 130);
}

function clearSavedDraft() {
  if (!isLiveBrowserCanvas()) return;
  try {
    globalThis.localStorage?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function scheduleDraftSave() {
  if (!isLiveBrowserCanvas() || suppressDraftSave || !state.pattern) return;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    if (!isLiveBrowserCanvas() || suppressDraftSave || !state.pattern) return;
    try {
      const payload = JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        templateId: state.templateId,
        avPreset: el('avSizePresetSelect')?.value || 'M',
        autoSyncBlockToForm: Boolean(state.autoSyncBlockToForm),
        avatarMeasurements: state.avatarMeasurements,
        materialOverrides: state.materialOverrides,
        workspaceStlFile: state.activeStlSource?.workspaceFile || null,
        patternJson: exportPatternJSON(state.pattern),
      });
      if (payload.length < 1_800_000) {
        globalThis.localStorage?.setItem(DRAFT_STORAGE_KEY, payload);
      }
    } catch {
      // ignore quota / storage access errors
    }
  }, 320);
}

async function tryRestoreDraftFromStorage() {
  if (!isLiveBrowserCanvas()) return false;
  try {
    const search = String(globalThis.location?.search || '');
    if (search.includes('fresh=1')) return false;
    const raw = globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY);
    if (!raw || typeof raw !== 'string') return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.patternJson !== 'string') return false;
    const restored = importPatternJSON(parsed.patternJson);
    if (!Array.isArray(restored?.pieces) || restored.pieces.length === 0) return false;

    suppressDraftSave = true;
    try {
      if (parsed.avatarMeasurements && typeof parsed.avatarMeasurements === 'object') {
        state.avatarMeasurements = {
          ...DEFAULT_WOMENS_AVATAR_MEASUREMENTS,
          ...parsed.avatarMeasurements,
          bodyType: 'womens',
        };
        state.avatar = createParametricAvatar(state.avatarMeasurements);
      }
      if (typeof parsed.autoSyncBlockToForm === 'boolean') {
        state.autoSyncBlockToForm = parsed.autoSyncBlockToForm;
        if (el('chkAutoSyncBlockToForm')) el('chkAutoSyncBlockToForm').checked = parsed.autoSyncBlockToForm;
      }
      if (typeof parsed.avPreset === 'string' && el('avSizePresetSelect')) {
        el('avSizePresetSelect').value = parsed.avPreset;
      }

      const tplId = parsed.templateId || restored.templateId || 'bodice_sloper';
      state.templateId = tplId;
      state.pattern = restored;
      state.materialOverrides =
        parsed.materialOverrides && typeof parsed.materialOverrides === 'object'
          ? { ...parsed.materialOverrides }
          : {};
      state.selectedPieceId = restored.pieces[0]?.id || null;
      state.selectedEdgeIndex = 0;
      state.selectedVertexIndex = -1;
      state.pendingSeamEdge = null;

      if (tplId === 'stl_cover' && typeof parsed.workspaceStlFile === 'string' && parsed.workspaceStlFile) {
        try {
          const stlRes = await fetch(`/api/stl-content?file=${encodeURIComponent(parsed.workspaceStlFile)}`);
          if (stlRes.ok) {
            const buf = await stlRes.arrayBuffer();
            state.activeStlMesh = parseSTL(buf, parsed.workspaceStlFile);
            state.activeStlSource = { workspaceFile: parsed.workspaceStlFile };
          }
        } catch {
          // continue without 3D STL mesh if unavailable
        }
      }

      if (el('templateSelect')) el('templateSelect').value = state.templateId;
      syncContextualSidebarSections();
      updateSTLMetadataUI(state.activeStlMesh, state.pattern);
      rebuildSimulationAndMetrics(false);
      startBrowserAutoSettle(28, 54);
      history.clear();
      renderParametricSliders();
      updateMaterialUI();
      updateAllInspectorUI();
      cad2D?.fitToContent(build2DScene());
      draw2D();
      showToast('Restored your auto-saved draft (click ↺ Reset for fresh defaults)');
      return true;
    } finally {
      suppressDraftSave = false;
    }
  } catch {
    clearSavedDraft();
    return false;
  }
}

function el(id) {
  return document.getElementById(id);
}

function showToast(message, isError = false) {
  const node = el('studioToast');
  if (!node) return;
  node.textContent = String(message);
  node.classList.toggle('toast-error', Boolean(isError));
  node.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add('hidden');
  }, 3600);
}

function getUnitDecimals(unit = state.unit) {
  return unit === 'mm' ? 1 : unit === 'cm' ? 2 : 3;
}

function toDisplayNum(mmVal, decimals = 1) {
  const num = Number(mmVal);
  if (!Number.isFinite(num)) return '';
  return Number(mmToUnit(num, state.unit).toFixed(decimals));
}

function parseInputToMm(rawVal, minMm = -Infinity, maxMm = Infinity) {
  if (rawVal === '' || rawVal === null || rawVal === undefined) return null;
  if (typeof rawVal === 'string' && rawVal.trim() === '') return null;
  const parsed = Number(rawVal);
  if (!Number.isFinite(parsed)) return null;
  let mm;
  try {
    mm = unitToMm(parsed, state.unit);
  } catch {
    return null;
  }
  if (!Number.isFinite(mm)) return null;
  return Math.max(minMm, Math.min(maxMm, mm));
}

function normalizeStlScaleInput() {
  const scaleInp = el('stlScaleInput');
  if (!scaleInp) return 1.0;
  const rawStr = String(scaleInp.value ?? '').trim();
  const parsed = rawStr === '' ? NaN : Number(rawStr);
  const scale =
    Number.isFinite(parsed) && parsed > 0
      ? Math.max(0.1, Math.min(5.0, parsed))
      : 1.0;
  scaleInp.value = String(Number(scale.toFixed(2)));
  return scale;
}

function normalizeStlUnwrapInputs() {
  const dec = getUnitDecimals(state.unit);
  const stlParams = state.templateId === 'stl_cover' ? state.pattern?.params : null;
  const specs = [
    { id: 'stlEaseInput', key: 'easeMm', minMm: 0, maxMm: 50, defaultMm: 2.0 },
    { id: 'stlThicknessInput', key: 'thicknessMm', minMm: 0, maxMm: 50, defaultMm: 0.0 },
    { id: 'stlSaInput', key: 'seamAllowance', minMm: 0, maxMm: 60, defaultMm: 10 },
  ];
  const out = {};
  for (const s of specs) {
    const inp = el(s.id);
    const rawFb = stlParams?.[s.key] ?? s.defaultMm;
    const fallback = Math.max(s.minMm, Math.min(s.maxMm, Number.isFinite(rawFb) ? rawFb : s.defaultMm));
    const parsed = inp ? parseInputToMm(inp.value, s.minMm, s.maxMm) : null;
    const mm = parsed !== null ? parsed : fallback;
    if (inp) inp.value = String(toDisplayNum(mm, dec));
    out[s.key] = mm;
  }
  out.scale = normalizeStlScaleInput();
  return out;
}

function ensurePieceEdges(piece) {
  if (!piece || !Array.isArray(piece.points)) return [];
  if (!Array.isArray(piece.edges)) piece.edges = [];
  const defaultSa = Number.isFinite(piece.seamAllowance) ? piece.seamAllowance : 0;
  while (piece.edges.length < piece.points.length) {
    piece.edges.push({ seamAllowance: defaultSa });
  }
  return piece.edges;
}

function getSelectedPiece() {
  if (!state.pattern?.pieces?.length) return null;
  return state.pattern.pieces.find((p) => p.id === state.selectedPieceId) || state.pattern.pieces[0];
}

function getActiveMaterialConfig() {
  const matId = state.pattern?.materialId || 'cotton_jersey';
  return getMaterialConfig(matId, state.materialOverrides);
}

function syncUndoRedoButtons() {
  const u = el('btnUndo');
  const r = el('btnRedo');
  if (u) u.disabled = !history.canUndo();
  if (r) r.disabled = !history.canRedo();
}

function capturePatternTx(deepPattern = false) {
  let patternSnap = null;
  if (deepPattern && state.pattern) {
    try {
      patternSnap = JSON.parse(JSON.stringify(state.pattern));
    } catch {
      patternSnap = null;
    }
  }
  return {
    pattern: state.pattern,
    patternSnap,
    templateId: state.templateId,
    materialOverrides: { ...state.materialOverrides },
    selectedPieceId: state.selectedPieceId,
    selectedEdgeIndex: state.selectedEdgeIndex,
    selectedVertexIndex: state.selectedVertexIndex,
    pendingSeamEdge: state.pendingSeamEdge ? { ...state.pendingSeamEdge } : null,
    seamWalk: { ...state.seamWalk },
    activeStlMesh: state.activeStlMesh,
    activeStlSource: state.activeStlSource ? { ...state.activeStlSource } : null,
    sim: state.sim,
    strainReport: state.strainReport,
    nestingResult: state.nestingResult,
    activeSheetIndex: state.activeSheetIndex,
    undoStack: [...history.undoStack],
    redoStack: [...history.redoStack],
  };
}

function rollbackPatternTx(tx, { refreshSliders = false } = {}) {
  if (!tx) return;
  state.pattern = tx.patternSnap || tx.pattern;
  state.templateId = tx.templateId;
  state.materialOverrides = tx.materialOverrides;
  state.selectedPieceId = tx.selectedPieceId;
  state.selectedEdgeIndex = tx.selectedEdgeIndex;
  state.selectedVertexIndex = tx.selectedVertexIndex;
  state.pendingSeamEdge = tx.pendingSeamEdge;
  state.seamWalk = tx.seamWalk;
  state.activeStlMesh = tx.activeStlMesh;
  state.activeStlSource = tx.activeStlSource;
  state.sim = tx.sim;
  state.strainReport = tx.strainReport;
  state.nestingResult = tx.nestingResult;
  state.activeSheetIndex = tx.activeSheetIndex;
  history.undoStack = Array.isArray(tx.undoStack) ? [...tx.undoStack] : [];
  history.redoStack = Array.isArray(tx.redoStack) ? [...tx.redoStack] : [];

  if (el('templateSelect')) el('templateSelect').value = state.templateId;
  if (el('seamWalkBar')) el('seamWalkBar').classList.toggle('hidden', !state.seamWalk?.seamId);
  if (state.pattern) {
    try {
      updateSTLMetadataUI(state.activeStlMesh, state.pattern);
    } catch {
      // ignore metadata UI refresh failures on rollback
    }
    try {
      syncNestingUI();
    } catch {
      // ignore nesting UI refresh failures on rollback
    }
    if (refreshSliders) {
      try {
        renderParametricSliders();
      } catch {
        // ignore slider refresh failures on rollback
      }
    }
    try {
      updateMaterialUI();
    } catch {
      // ignore material UI refresh failures on rollback
    }
    try {
      updateAllInspectorUI();
    } catch {
      // ignore inspector refresh failures on rollback
    }
    try {
      sync3DScene();
    } catch {
      // ignore 3D sync failures on rollback
    }
    try {
      draw2D();
    } catch {
      // ignore 2D draw failures on rollback
    }
  } else {
    syncUndoRedoButtons();
  }
}

function applyHistorySnapshot(snap) {
  if (!snap || !snap.pattern) return;
  cad2D?.clearPen?.();
  state.pattern = snap.pattern;
  state.templateId = snap.templateId || snap.pattern.templateId || state.templateId;
  state.selectedPieceId = snap.selectedPieceId;
  state.selectedEdgeIndex = snap.selectedEdgeIndex ?? 0;
  state.selectedVertexIndex = snap.selectedVertexIndex ?? -1;
  state.pendingSeamEdge = null;
  if (snap.pattern.material && typeof snap.pattern.material === 'object' && !Array.isArray(snap.pattern.material)) {
    const presetId = Object.hasOwn(MATERIAL_PRESETS, snap.pattern.materialId)
      ? snap.pattern.materialId
      : 'cotton_jersey';
    const baseCfg = getMaterialConfig(presetId);
    const { id: _matId, ...matRest } = snap.pattern.material;
    const diffOverrides = {};
    for (const [k, v] of Object.entries(matRest)) {
      if (v !== baseCfg[k]) diffOverrides[k] = v;
    }
    state.materialOverrides = diffOverrides;
  } else {
    state.materialOverrides = {};
  }
  if (state.templateId === 'stl_cover') {
    state.activeStlMesh = snap.activeStlMesh || null;
    state.activeStlSource = snap.activeStlSource ? { ...snap.activeStlSource } : null;
  } else {
    state.activeStlMesh = null;
    state.activeStlSource = null;
  }
  updateSTLMetadataUI(state.activeStlMesh, state.pattern);
  if (state.seamWalk.seamId && !state.pattern.seams?.some((s) => s.id === state.seamWalk.seamId)) {
    state.seamWalk.seamId = null;
    state.seamWalk.walkT = 0;
    el('seamWalkBar')?.classList.add('hidden');
  }
  if (el('templateSelect')) el('templateSelect').value = state.templateId;
  syncContextualSidebarSections();
  rebuildSimulationAndMetrics(true);
  if (isLiveBrowserCanvas() && !state.simRunning) {
    startBrowserAutoSettle(18, 40);
  }
  renderParametricSliders();
  updateMaterialUI();
  updateAllInspectorUI();
  draw2D();
}

function performUndo() {
  const cancelledMode = cad2D?.cancelActiveDrag?.();
  if (cancelledMode === 'piece' || cancelledMode === 'vertex' || cancelledMode === 'cp') {
    showToast('Cancelled active drag');
    return;
  }
  const snap = history.undo(state);
  if (snap) {
    applyHistorySnapshot(snap);
    showToast('Undid last pattern edit');
  }
}

function performRedo() {
  cad2D?.cancelActiveDrag?.();
  const snap = history.redo(state);
  if (snap) {
    applyHistorySnapshot(snap);
    showToast('Redid pattern edit');
  }
}

function build2DScene() {
  return {
    pattern: state.pattern,
    unit: state.unit,
    viewMode: state.viewMode,
    activeTool: state.activeTool,
    selectedPieceId: state.selectedPieceId,
    selectedEdgeIndex: state.selectedEdgeIndex,
    selectedVertexIndex: state.selectedVertexIndex,
    showSeams: state.showSeams2D,
    showLengths: state.showLengths2D,
    showCutLine: state.showCutLine2D,
    showGrain: state.showGrain2D,
    pendingSeamEdge: state.pendingSeamEdge,
    seamWalk: state.seamWalk,
    nestingResult: state.nestingResult,
    activeSheetIndex: state.activeSheetIndex,
  };
}

function draw2D() {
  if (cad2D) {
    cad2D.render(build2DScene());
  }
  updateHud2D();
}

function isLiveBrowserCanvas() {
  const c3 = el('canvas3D');
  return Boolean(
    typeof globalThis.HTMLCanvasElement === 'function' &&
    c3 instanceof globalThis.HTMLCanvasElement
  );
}

function getDrapeAvatar() {
  if (state.activeStlMesh || state.templateId === 'stl_cover' || state.templateId === 'tote_bag') {
    return null;
  }
  return state.avatar;
}

function pinToteStrapPeaksForStudio(sim) {
  if (!sim || !Array.isArray(sim.particles) || state.templateId !== 'tote_bag') return;
  for (const strapId of ['strap_front', 'strap_back']) {
    const strapPts = sim.particles.filter((p) => p.pieceId === strapId);
    if (strapPts.length === 0) continue;
    let maxY = -Infinity;
    for (const p of strapPts) {
      if (p.pos.y > maxY) maxY = p.pos.y;
    }
    for (const p of strapPts) {
      if (maxY - p.pos.y <= 14 && Math.abs(p.pos.x) <= 42) {
        p.invMass = 0;
        p.studioAnchor = true;
        p.prevPos = { ...p.pos };
      }
    }
  }
}

function startBrowserAutoSettle(initialSyncSteps = 28, asyncSteps = 60) {
  if (!isLiveBrowserCanvas() || !state.sim) return;
  if (state.templateId === 'stl_cover' && !state.activeStlMesh) return;
  if (initialSyncSteps > 0) {
    state.strainReport = state.sim.step(initialSyncSteps);
  }
  state.autoSettleRemaining = Math.max(0, asyncSteps);
  sync3DScene();
  if (state.autoSettleRemaining > 0) {
    scheduleAnimationLoop();
  }
}

function sync3DScene() {
  if (!viewport3D) return;
  const drapeAvatar = getDrapeAvatar();
  viewport3D.setScene({
    sim: state.sim,
    avatar: drapeAvatar,
    stlMesh: state.activeStlMesh,
    materialConfig: getActiveMaterialConfig(),
    showStrainMap: state.showStrainMap,
    showForm: state.showForm3D,
    showWire: state.showWire3D,
    showThreads: state.showThreads3D,
    selectedPieceId: state.selectedPieceId,
    pinMode: state.pinMode3D,
  });
  viewport3D.render();
  updateHud3D();
}

function updateHud2D() {
  const hud = el('hud2D');
  if (!hud) return;
  const pieceCount = state.pattern?.pieces?.length || 0;
  const sel = getSelectedPiece();
  const selName = sel ? sel.name : 'None';
  if (state.viewMode === 'nesting' && state.nestingResult) {
    const n = state.nestingResult;
    hud.textContent = `Nesting: ${n.totalCutPieceCount} cut pcs | Util ${n.utilizationPct?.toFixed(1)}% | Length ${formatUnitValue(n.requiredLengthMm, state.unit, 1)}`;
    return;
  }
  const extra = state.activeTool === 'draw_poly'
    ? 'Click vertices, click start or double-click to close (Esc: cancel)'
    : state.activeTool === 'sew'
      ? (state.pendingSeamEdge ? 'Click target Edge B to stitch (Esc: cancel)' : 'Click Edge A to start sewing')
      : state.activeTool === 'edit_points'
        ? 'Drag vertices/curves (piece locked) | Click edge to inspect'
        : 'Scroll: Zoom | Drag piece: Move | Shift+Drag bg: Pan';
  const toolLabel = TOOL_LABELS[state.activeTool] || state.activeTool;
  hud.textContent = `Tool: ${toolLabel} | Pieces: ${pieceCount} | Active: ${selName} | ${extra}`;
}

function updateHud3D() {
  const hud = el('hud3D');
  if (!hud) return;
  const sr = state.strainReport;
  const simInfo = sr
    ? `Step ${sr.stepCount} | Fit: ${sr.fitStatus} (Mean ${sr.meanStrainPct?.toFixed(1)}%, Max ${sr.maxStrainPct?.toFixed(1)}%)`
    : '3D Solver Ready';
  const stlInfo = state.activeStlMesh
    ? ` | STL: ${state.activeStlMesh.triangleCount} tris`
    : state.templateId === 'stl_cover'
      ? ' | STL: not loaded'
      : '';
  const pinCount = state.sim?.particles?.filter((p) => p.invMass <= 0 && !p.studioAnchor).length || 0;
  const pinInfo = pinCount > 0 ? ` | Pinned: ${pinCount}` : '';
  hud.textContent = `${simInfo}${stlInfo}${pinInfo}`;
}

function syncNestingUI() {
  const nest = state.nestingResult;
  if (!nest) return;
  const sheetCount = Math.max(1, nest.sheetCount || 1);
  if (state.activeSheetIndex >= sheetCount) {
    state.activeSheetIndex = 0;
  }
  const sheetSel = el('nestSheetSelect');
  if (sheetSel) {
    sheetSel.replaceChildren();
    for (let i = 0; i < sheetCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Sheet ${i + 1} / ${sheetCount}`;
      sheetSel.appendChild(opt);
    }
    sheetSel.value = String(state.activeSheetIndex);
  }
  updateNestingBOMUI();
}

function rebuildNesting() {
  if (!state.pattern) return;
  const opts = {
    fabricWidthMm: state.nestingOptions.fabricWidthMm,
    marginMm: state.nestingOptions.marginMm,
    spacingMm: state.nestingOptions.spacingMm,
    allowRotate90: state.nestingOptions.allowRotate90,
    lockGrainline: state.nestingOptions.lockGrainline,
  };
  const presetObj = FABRIC_ROLL_PRESETS.find((r) => r.id === state.nestingOptions.rollPreset);
  if (presetObj?.lengthMm) {
    opts.sheetLengthMm = presetObj.lengthMm;
    opts.paginateSheets = true;
  }
  state.nestingResult = nestPatternPieces(state.pattern, opts);
  syncNestingUI();
}

function rebuildSimulationAndMetrics(preserveCamera = false) {
  if (!state.pattern) return;
  state.autoSettleRemaining = 0;
  const matCfg = getActiveMaterialConfig();
  state.pattern.material = { ...matCfg };
  state.pattern.avatar = { ...state.avatarMeasurements };

  const drapeAvatar = getDrapeAvatar();
  const simOpts = {
    materialId: state.pattern.materialId,
    material: matCfg,
    materialOverrides: state.materialOverrides,
    stlMesh: state.activeStlMesh || null,
    avatar: drapeAvatar,
  };
  if (isLiveBrowserCanvas() && state.templateId !== 'stl_cover') {
    simOpts.maxEdgeLengthMm = 42;
  }
  state.sim = new ClothSimulation(state.pattern, simOpts);
  if (isLiveBrowserCanvas() && state.templateId === 'tote_bag') {
    pinToteStrapPeaksForStudio(state.sim);
  }
  state.strainReport = state.sim.computeStrainAnalysis();

  rebuildNesting();
  if (viewport3D && !preserveCamera) {
    viewport3D.setScene({
      sim: state.sim,
      avatar: drapeAvatar,
      stlMesh: state.activeStlMesh,
      materialConfig: matCfg,
      selectedPieceId: state.selectedPieceId,
    });
    viewport3D.fitToScene();
  }
  sync3DScene();
  syncUndoRedoButtons();
}

function renderParametricSliders() {
  const container = el('parametricSlidersContainer');
  if (!container) return;
  container.replaceChildren();

  const schema = PARAMETRIC_SCHEMA[state.templateId] || [];
  const params = state.pattern?.params || {};
  const decimals = state.unit === 'mm' ? 1 : 2;
  const isOrphanStlCover = state.templateId === 'stl_cover' && !state.activeStlMesh;

  for (const item of schema) {
    const rawVal = Number.isFinite(params[item.key]) ? params[item.key] : (item.min + item.max) * 0.5;
    const row = document.createElement('div');
    row.className = 'slider-row';

    const header = document.createElement('div');
    header.className = 'slider-header';

    const lbl = document.createElement('span');
    lbl.textContent = item.label;

    const valSpan = document.createElement('span');
    valSpan.className = 'slider-val';
    valSpan.title = isOrphanStlCover ? '' : 'Click to type exact measurement';
    valSpan.textContent = item.isLength
      ? formatUnitValue(rawVal, state.unit, decimals)
      : rawVal.toFixed(2);

    header.appendChild(lbl);
    header.appendChild(valSpan);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(item.min);
    slider.max = String(item.max);
    slider.step = String(item.step);
    slider.value = String(rawVal);
    if (isOrphanStlCover) {
      slider.disabled = true;
    }

    let gestureSnapshotPushed = false;
    const ensureGestureSnapshot = () => {
      if (state.templateId === 'stl_cover' && !state.activeStlMesh) return;
      if (!gestureSnapshotPushed) {
        cad2D?.cancelActiveDrag?.();
        history.push(state);
        gestureSnapshotPushed = true;
      }
    };
    const endGesture = () => {
      gestureSnapshotPushed = false;
    };

    const applyParamMmValue = (targetMm, { settleNow = false } = {}) => {
      if (state.templateId === 'stl_cover' && !state.activeStlMesh) return false;
      const clampedMm = Math.max(item.min, Math.min(item.max, targetMm));
      if (!Number.isFinite(clampedMm)) return false;
      cad2D?.cancelActiveDrag?.();
      const tx = capturePatternTx(false);
      ensureGestureSnapshot();
      try {
        const nextParams = { ...(state.pattern?.params || {}), [item.key]: clampedMm };
        if (state.templateId === 'stl_cover' && state.activeStlMesh) {
          state.pattern = unwrapSTLToPattern(state.activeStlMesh, {
            name: state.activeStlMesh.name,
            mode: el('stlUnwrapModeSelect')?.value || 'form_shell_cover',
            easeMm: nextParams.easeMm ?? 2.0,
            thicknessMm: nextParams.thicknessMm ?? 0,
            seamAllowance: nextParams.seamAllowance ?? 10,
            scale: nextParams.scale ?? 1.0,
            materialId: state.pattern?.materialId || 'veg_leather',
          });
          cad2D?.clearPen?.();
          updateSTLMetadataUI(state.activeStlMesh, state.pattern);
        } else {
          const matId = state.pattern?.materialId;
          state.pattern = generateTemplatePattern(state.templateId, nextParams);
          if (matId) state.pattern.materialId = matId;
          cad2D?.clearPen?.();
        }
        if (state.pattern?.pieces?.length && !state.pattern.pieces.some((p) => p.id === state.selectedPieceId)) {
          state.selectedPieceId = state.pattern.pieces[0].id;
          state.selectedVertexIndex = -1;
          state.selectedEdgeIndex = 0;
        }
        state.pendingSeamEdge = null;
        const activePiece = getSelectedPiece();
        const maxPtIdx = (activePiece?.points?.length || 0) - 1;
        if (maxPtIdx < 0) {
          state.selectedVertexIndex = -1;
          state.selectedEdgeIndex = -1;
        } else {
          if (state.selectedVertexIndex > maxPtIdx || state.selectedVertexIndex < -1) {
            state.selectedVertexIndex = -1;
          }
          if (state.selectedEdgeIndex > maxPtIdx || state.selectedEdgeIndex < 0) {
            state.selectedEdgeIndex = 0;
          }
        }
        if (state.seamWalk?.seamId && !(state.pattern?.seams || []).some((s) => s.id === state.seamWalk.seamId)) {
          state.seamWalk.seamId = null;
          state.seamWalk.walkT = 0;
          if (el('seamWalkBar')) el('seamWalkBar').classList.add('hidden');
        }
        slider.value = String(clampedMm);
        rebuildSimulationAndMetrics(true);
        if (settleNow) {
          if (sliderSettleTimer) {
            clearTimeout(sliderSettleTimer);
            sliderSettleTimer = null;
          }
          if (isLiveBrowserCanvas() && !state.simRunning) {
            startBrowserAutoSettle(20, 44);
          }
        } else {
          scheduleDebouncedSliderSettle();
        }
        valSpan.textContent = item.isLength
          ? formatUnitValue(clampedMm, state.unit, decimals)
          : clampedMm.toFixed(2);
        updateAllInspectorUI();
        draw2D();
        return true;
      } catch (err) {
        rollbackPatternTx(tx, { refreshSliders: false });
        gestureSnapshotPushed = false;
        showToast(err?.message || 'Failed to update parameter', true);
        return false;
      }
    };

    slider.addEventListener('pointerdown', ensureGestureSnapshot);
    slider.addEventListener('pointerup', () => {
      endGesture();
      if (isLiveBrowserCanvas() && !state.simRunning) {
        if (sliderSettleTimer) {
          clearTimeout(sliderSettleTimer);
          sliderSettleTimer = null;
        }
        startBrowserAutoSettle(20, 44);
      }
    });
    slider.addEventListener('change', () => {
      endGesture();
      if (isLiveBrowserCanvas() && !state.simRunning) {
        if (sliderSettleTimer) {
          clearTimeout(sliderSettleTimer);
          sliderSettleTimer = null;
        }
        startBrowserAutoSettle(20, 44);
      }
    });
    slider.addEventListener('blur', endGesture);
    slider.addEventListener('input', () => {
      applyParamMmValue(Number(slider.value), { settleNow: false });
    });

    if (!isOrphanStlCover) {
      valSpan.addEventListener('click', () => {
        if (header.querySelector?.('.slider-val-input')) return;
        const curMm = Number.isFinite(state.pattern?.params?.[item.key])
          ? state.pattern.params[item.key]
          : Number(slider.value);
        const editInp = document.createElement('input');
        editInp.type = 'number';
        editInp.className = 'slider-val-input';
        editInp.step = 'any';
        const curDisplay = item.isLength ? Number(mmToUnit(curMm, state.unit).toFixed(decimals)) : Number(curMm.toFixed(2));
        editInp.value = String(curDisplay);
        valSpan.classList.add('hidden');
        header.appendChild(editInp);
        editInp.focus?.();
        editInp.select?.();

        let closed = false;
        const finishEdit = (commit) => {
          if (closed) return;
          closed = true;
          const rawText = String(editInp.value || '').trim();
          try {
            header.removeChild(editInp);
          } catch {
            // ignore
          }
          valSpan.classList.remove('hidden');
          if (!commit || rawText === '') {
            endGesture();
            return;
          }
          const parsed = Number(rawText);
          if (!Number.isFinite(parsed)) {
            endGesture();
            return;
          }
          let nextMm = parsed;
          if (item.isLength) {
            try {
              nextMm = unitToMm(parsed, state.unit);
            } catch {
              endGesture();
              return;
            }
          }
          ensureGestureSnapshot();
          applyParamMmValue(nextMm, { settleNow: true });
          endGesture();
        };

        editInp.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            finishEdit(true);
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            finishEdit(false);
          }
        });
        editInp.addEventListener('blur', () => finishEdit(true));
      });
    }

    row.appendChild(header);
    row.appendChild(slider);
    container.appendChild(row);
  }
  if (isOrphanStlCover) {
    const note = document.createElement('p');
    note.className = 'section-hint';
    note.textContent = 'Load matching .stl to re-unwrap parameters';
    container.appendChild(note);
  }
}

function updateSTLMetadataUI(meshOrMeta, pattern) {
  const isLiveMesh = Boolean(meshOrMeta);
  const meta = meshOrMeta || pattern?.stlMetadata;
  if (!meta) {
    el('metaStlName').textContent =
      pattern?.templateId === 'stl_cover'
        ? 'None loaded (STL not loaded — reload .stl for 3D cover drape)'
        : 'None loaded';
    el('metaStlTris').textContent = '-';
    el('metaStlBounds').textContent = '-';
    el('metaStlArea').textContent = '-';
    el('metaStlDistortion').textContent = '-';
    return;
  }
  const baseName = meta.name || 'model.stl';
  el('metaStlName').textContent = isLiveMesh
    ? baseName
    : `${baseName} (STL not loaded — reload .stl for 3D cover drape)`;
  const tris = meta.triangleCount ?? 0;
  const verts = meta.vertexCount ?? meta.weldedVertexCount ?? 0;
  el('metaStlTris').textContent = `${tris} tris / ${verts} verts`;
  const size = meta.bounds?.size || meta.dimensions;
  if (size) {
    el('metaStlBounds').textContent = `${Number(size.x).toFixed(1)} × ${Number(size.y).toFixed(1)} × ${Number(size.z).toFixed(1)} mm`;
  }
  const areaCm2 = ((meta.surfaceAreaMm2 || 0) / 100).toFixed(1);
  el('metaStlArea').textContent = `${areaCm2} cm²`;

  const pieces = pattern?.pieces || [];
  const distVals = pieces.map((p) => p.distortionPct).filter((v) => Number.isFinite(v));
  if (distVals.length > 0) {
    const mean = distVals.reduce((a, b) => a + b, 0) / distVals.length;
    el('metaStlDistortion').textContent = `${mean.toFixed(1)}% (developable)`;
  } else {
    el('metaStlDistortion').textContent = `${pieces.length} developable panels`;
  }
}

function updatePieceInspectorUI() {
  const pieces = state.pattern?.pieces || [];
  const selDrop = el('pieceSelectDropdown');
  if (selDrop) {
    selDrop.replaceChildren();
    for (const p of pieces) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      selDrop.appendChild(opt);
    }
    if (state.selectedPieceId) selDrop.value = state.selectedPieceId;
  }

  const obSummary = el('obPieceSummary');
  if (obSummary) {
    obSummary.textContent = `${pieces.length} Piece${pieces.length === 1 ? '' : 's'}`;
  }
  const obList = el('objectBrowserList');
  if (obList) {
    obList.replaceChildren();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ob-item ${p.id === (state.selectedPieceId || pieces[0]?.id) ? 'is-selected' : ''}`;
      btn.textContent = `${i + 1}. ${p.name || p.id}`;
      btn.addEventListener('click', () => {
        cad2D?.cancelActiveDrag?.();
        state.selectedPieceId = p.id;
        state.selectedEdgeIndex = 0;
        state.selectedVertexIndex = -1;
        updateAllInspectorUI();
        sync3DScene();
        draw2D();
      });
      obList.appendChild(btn);
    }
  }

  const piece = getSelectedPiece();
  const ctxBar = el('contextEdgeBar');
  if (!piece) {
    if (ctxBar) ctxBar.classList.add('hidden');
    return;
  }
  if (ctxBar) {
    ctxBar.classList.toggle('hidden', state.viewMode === 'nesting');
  }
  state.selectedPieceId = piece.id;

  const unitDec = getUnitDecimals(state.unit);
  el('pieceNameInput').value = piece.name || '';
  el('pieceQuantityInput').value = String(piece.quantity || 1);
  el('pieceRotationInput').value = String(Number((piece.rotation || 0).toFixed(2)));
  el('pieceGrainInput').value = String(Number((piece.grainline?.angleDeg ?? 90).toFixed(2)));
  el('pieceSaInput').value = String(toDisplayNum(piece.seamAllowance ?? 10, unitDec));
  el('pieceOnFoldChk').checked = Boolean(piece.onFold);
  el('pieceGrainLockChk').checked = Boolean(piece.grainLock);

  // Measurements
  const meas = computePieceMeasurements(piece, state.unit);
  const dec = state.unit === 'mm' ? 1 : 2;
  el('measNetSize').textContent = `${formatUnitValue(meas.netWidthMm, state.unit, dec)} × ${formatUnitValue(meas.netHeightMm, state.unit, dec)}`;
  el('measPerims').textContent = `${formatUnitValue(meas.netPerimeterMm, state.unit, dec)} / ${formatUnitValue(meas.cutPerimeterMm, state.unit, dec)}`;
  el('measNetArea').textContent = `${meas.netAreaCm2.toFixed(1)} cm²`;
  el('measVertsCount').textContent = `${meas.vertexCount} verts / ${piece.edges?.length || 0} edges`;

  // Edge controls
  const eIdx = Math.max(0, Math.min((piece.points?.length || 1) - 1, state.selectedEdgeIndex || 0));
  state.selectedEdgeIndex = eIdx;
  const edge = piece.edges?.[eIdx] || {};
  const edgeLenMm = meas.edges?.[eIdx]?.netLengthMm ?? 0;
  const curveType = inferCurveType(edge.curve);
  el('selectedEdgeBadge').textContent = `Edge ${eIdx + 1} (${formatUnitValue(edgeLenMm, state.unit, dec)})`;
  el('edgeSaInput').value = String(toDisplayNum(edge.seamAllowance ?? piece.seamAllowance ?? 10, unitDec));
  el('edgeCurveSelect').value = curveType;

  const ctxLbl = el('ctxSelectionLabel');
  if (ctxLbl) {
    const ptInfo = state.selectedVertexIndex >= 0 ? ` · Pt ${state.selectedVertexIndex + 1}` : '';
    const lenShort = state.unit === 'in'
      ? `${mmToUnit(edgeLenMm, 'in').toFixed(1)}"`
      : formatUnitValue(edgeLenMm, state.unit, dec);
    ctxLbl.textContent = `Edge ${eIdx + 1} · ${lenShort}${ptInfo}`;
    ctxLbl.title = `${piece.name || piece.id} — Edge ${eIdx + 1} (${formatUnitValue(edgeLenMm, state.unit, dec)})`;
  }
  const ctxCurve = el('ctxCurveSelect');
  if (ctxCurve) ctxCurve.value = curveType;

  const delVertBtn = el('btnDeleteSelectedVertex');
  if (delVertBtn) delVertBtn.disabled = (piece.points?.length || 0) <= 3;

  // Darts list with Fold/Unfold button
  const dartBox = el('dartListContainer');
  if (dartBox) {
    dartBox.replaceChildren();
    const darts = piece.darts || [];
    for (let i = 0; i < darts.length; i++) {
      const d = darts[i];
      const card = document.createElement('div');
      card.className = 'list-item-card';
      const row = document.createElement('div');
      row.className = 'list-item-row';

      const info = document.createElement('span');
      info.textContent = `Dart ${i + 1} (E${d.edgeIndex + 1}): ${formatUnitValue(d.widthMm, state.unit, 1)} × ${formatUnitValue(d.depthMm, state.unit, 1)}`;

      const btnFold = document.createElement('button');
      btnFold.type = 'button';
      btnFold.className = `btn-mini ${d.folded ? 'is-active' : ''}`;
      btnFold.textContent = d.folded ? 'Unfold Dart' : 'Fold Dart';
      btnFold.addEventListener('click', () => {
        cad2D?.cancelActiveDrag?.();
        const tx = capturePatternTx(true);
        try {
          history.push(state);
          toggleDartFold(piece, d.id || i);
          rebuildSimulationAndMetrics(true);
          updateAllInspectorUI();
          draw2D();
        } catch (err) {
          rollbackPatternTx(tx);
          showToast(err?.message || 'Cannot toggle dart fold', true);
        }
      });

      row.appendChild(info);
      row.appendChild(btnFold);
      card.appendChild(row);
      dartBox.appendChild(card);
    }
  }

  // Notches list
  const notchBox = el('notchListContainer');
  if (notchBox) {
    notchBox.replaceChildren();
    const notches = piece.notches || [];
    for (let i = 0; i < notches.length; i++) {
      const n = notches[i];
      const card = document.createElement('div');
      card.className = 'list-item-card';
      const row = document.createElement('div');
      row.className = 'list-item-row';
      const info = document.createElement('span');
      info.textContent = `Notch ${i + 1}: ${String(n.type || 'single').toUpperCase()} on Edge ${n.edgeIndex + 1} (t=${Number(n.t).toFixed(2)})`;
      row.appendChild(info);
      card.appendChild(row);
      notchBox.appendChild(card);
    }
  }
}

function reconcileSeamWalkState() {
  if (
    state.seamWalk?.seamId &&
    !(state.pattern?.seams || []).some((s) => s.id === state.seamWalk.seamId)
  ) {
    state.seamWalk.seamId = null;
    state.seamWalk.walkT = 0;
    if (el('seamWalkSelect')) el('seamWalkSelect').value = '';
    if (el('seamWalkSlider')) el('seamWalkSlider').value = '0';
    if (el('seamWalkReadout')) el('seamWalkReadout').textContent = '0%';
    el('seamWalkBar')?.classList.add('hidden');
  }
}

function updateSeamDiagnosticsUI() {
  reconcileSeamWalkState();
  const list = el('seamValidationList');
  const badge = el('seamCountBadge');
  const walkSel = el('seamWalkSelect');
  if (!list || !state.pattern) return;

  const report = validatePatternSeams(state.pattern);
  if (badge) badge.textContent = String(report.length);
  list.replaceChildren();

  if (walkSel) {
    walkSel.replaceChildren();
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Select seam...';
    walkSel.appendChild(emptyOpt);
    for (const r of report) {
      const opt = document.createElement('option');
      opt.value = r.seamId;
      opt.textContent = r.name || r.seamId;
      walkSel.appendChild(opt);
    }
    const activeWalkId =
      state.seamWalk.seamId && report.some((r) => r.seamId === state.seamWalk.seamId)
        ? state.seamWalk.seamId
        : '';
    walkSel.value = activeWalkId;
  }

  for (const r of report) {
    const card = document.createElement('div');
    card.className = 'seam-card';

    const top = document.createElement('div');
    top.className = 'seam-card-top';

    const title = document.createElement('strong');
    title.textContent = r.name || r.seamId;

    const status = document.createElement('span');
    status.className = `seam-status status-${r.status}`;
    status.textContent = r.status;

    top.appendChild(title);
    top.appendChild(status);

    const sub = document.createElement('div');
    sub.className = 'seam-sub';
    const lenA = Number.isFinite(r.lengthAMm) ? formatUnitValue(r.lengthAMm, state.unit, 1) : '-';
    const lenB = Number.isFinite(r.lengthBMm) ? formatUnitValue(r.lengthBMm, state.unit, 1) : '-';
    const delta = Number.isFinite(r.deltaMm) ? formatUnitValue(r.deltaMm, state.unit, 1) : '-';
    sub.textContent = `${r.pieceAName || r.pieceA} (${lenA}) ↔ ${r.pieceBName || r.pieceB} (${lenB}) | Δ ${delta} (${r.deltaPct ?? 0}%)`;

    const actions = document.createElement('div');
    actions.className = 'inline-row';
    const walkBtn = document.createElement('button');
    walkBtn.type = 'button';
    walkBtn.className = `btn-mini ${state.seamWalk.seamId === r.seamId ? 'is-active' : ''}`;
    walkBtn.textContent = state.seamWalk.seamId === r.seamId ? 'Walking' : 'Walk Seam';
    walkBtn.addEventListener('click', () => {
      state.seamWalk.seamId = r.seamId;
      state.seamWalk.walkT = 0;
      if (el('seamWalkBar')) el('seamWalkBar').classList.remove('hidden');
      if (el('seamWalkSelect')) el('seamWalkSelect').value = r.seamId;
      if (el('seamWalkSlider')) el('seamWalkSlider').value = '0';
      if (el('seamWalkReadout')) el('seamWalkReadout').textContent = `0% | Δ ${r.deltaMm ?? 0} mm`;
      updateSeamDiagnosticsUI();
      draw2D();
    });

    actions.appendChild(walkBtn);
    card.appendChild(top);
    card.appendChild(sub);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function updateMaterialUI() {
  const cfg = getActiveMaterialConfig();
  if (el('materialPresetSelect')) el('materialPresetSelect').value = cfg.id;
  if (el('matWeaveTypeSelect')) el('matWeaveTypeSelect').value = cfg.weaveType;
  if (el('matWarpColor')) el('matWarpColor').value = cfg.warpColor;
  if (el('matWeftColor')) el('matWeftColor').value = cfg.weftColor;
  if (el('matStitchColor')) el('matStitchColor').value = cfg.stitchColor;

  el('matGsmLabel').textContent = `${Math.round(cfg.gsm)} GSM`;
  el('matThickLabel').textContent = `${cfg.thicknessMm.toFixed(2)} mm`;
  el('matStretchLabel').textContent = `${cfg.warpStiffness.toFixed(2)} / ${cfg.weftStiffness.toFixed(2)}`;
  el('matBendLabel').textContent = `${cfg.bendStiffness.toFixed(2)}`;
  el('matStrainLabel').textContent = `${Math.round(cfg.maxSafeStrainPct)}%`;

  // Render Substance-style procedural PBR swatch onto <canvas> via ImageData (XSS-safe)
  const swatchCanvas = el('weaveSwatchCanvas');
  if (swatchCanvas) {
    const ctx = swatchCanvas.getContext('2d');
    if (ctx) {
      const maps = generateProceduralPBRMaps(cfg, 128);
      const img = new ImageData(
        new Uint8ClampedArray(maps.albedo.data),
        maps.albedo.width,
        maps.albedo.height
      );
      ctx.putImageData(img, 0, 0);
    }
  }

  // Sync slider values
  for (const spec of [...MATERIAL_PHYSICS_SLIDERS, ...MATERIAL_PBR_SLIDERS]) {
    const slider = document.getElementById(`matSlider_${spec.key}`);
    const valNode = document.getElementById(`matVal_${spec.key}`);
    if (slider && Number.isFinite(cfg[spec.key])) {
      slider.value = String(cfg[spec.key]);
    }
    if (valNode && Number.isFinite(cfg[spec.key])) {
      valNode.textContent = Number(cfg[spec.key]).toFixed(spec.decimals);
    }
  }
  scheduleDraftSave();
}

function updateNestingBOMUI() {
  const n = state.nestingResult;
  if (!n) return;
  const dec = state.unit === 'mm' ? 1 : 2;
  el('bomLength').textContent = formatUnitValue(n.requiredLengthMm, state.unit, dec);
  el('bomYards').textContent = `${n.requiredMeters?.toFixed(2)} m / ${n.requiredYards?.toFixed(2)} yd`;
  el('bomUtilization').textContent = `${n.utilizationPct?.toFixed(1)}% (${n.wastePct?.toFixed(1)}% waste)`;
  el('bomCutPieces').textContent = `${n.totalCutPieceCount} pcs / ${n.sheetCount || 1} sheet(s)`;
  el('bomCutPerim').textContent = formatUnitValue(n.totalCutPerimeterMm, state.unit, dec);
  el('bomSeamLen').textContent = formatUnitValue(n.totalSeamLengthMm, state.unit, dec);
}

function refreshUnitLabelsAndInputs() {
  const u = state.unit;
  document.querySelectorAll('[data-unit-label]').forEach((node) => {
    const base = node.getAttribute('data-unit-label');
    node.textContent = `${base} (${u})`;
  });

  const dec = getUnitDecimals(u);
  const stepDec = dec;
  const setVal = (id, mm) => {
    const inp = el(id);
    if (inp && Number.isFinite(mm)) inp.value = String(Number(mmToUnit(mm, u).toFixed(dec)));
  };
  const syncUnitBounds = (id, minMm, maxMm, stepMm) => {
    const inp = el(id);
    if (!inp) return;
    if (minMm !== null && minMm !== undefined) {
      inp.min = String(Number(mmToUnit(minMm, u).toFixed(stepDec)));
    }
    if (maxMm !== null && maxMm !== undefined) {
      inp.max = String(Number(mmToUnit(maxMm, u).toFixed(stepDec)));
    }
    if (stepMm !== null && stepMm !== undefined) {
      inp.step = u === 'in' ? '0.001' : u === 'cm' ? '0.01' : '0.1';
    }
  };

  syncUnitBounds('avChestInput', 600, 1600, 5);
  syncUnitBounds('avUnderbustInput', 500, 1500, 5);
  syncUnitBounds('avWaistInput', 500, 1500, 5);
  syncUnitBounds('avHighHipInput', 600, 1650, 5);
  syncUnitBounds('avHipInput', 650, 1700, 5);
  syncUnitBounds('avShoulderInput', 280, 700, 5);
  syncUnitBounds('avBustSpanInput', 110, 380, 2);
  syncUnitBounds('avShoulderToBustInput', 160, 420, 5);
  syncUnitBounds('avHeightInput', 1200, 2200, 10);
  syncUnitBounds('nestCustomWidthInput', 100, 5000, 10);
  syncUnitBounds('nestMarginInput', 0, 500, 1);
  syncUnitBounds('nestSpacingInput', 0, 500, 1);
  syncUnitBounds('pdfMarginInput', 0, 200, 1);
  syncUnitBounds('pdfOverlapInput', 0, 200, 1);
  syncUnitBounds('stlEaseInput', 0, 50, 0.5);
  syncUnitBounds('stlThicknessInput', 0, 50, 0.5);
  syncUnitBounds('stlSaInput', 0, 60, 1);
  syncUnitBounds('pieceSaInput', 0, 200, 1);
  syncUnitBounds('edgeSaInput', 0, 200, 1);
  syncUnitBounds('dartWidthInput', 2, 200, 2);
  syncUnitBounds('dartDepthInput', 10, 400, 5);
  syncUnitBounds('rectWidthInput', 10, 3000, 5);
  syncUnitBounds('rectHeightInput', 10, 3000, 5);
  syncUnitBounds('rectSaInput', 0, 100, 1);

  setVal('avChestInput', state.avatarMeasurements.chestMm);
  setVal('avUnderbustInput', state.avatarMeasurements.underbustMm ?? Math.round((state.avatarMeasurements.chestMm || 925) * 0.84));
  setVal('avWaistInput', state.avatarMeasurements.waistMm);
  setVal('avHighHipInput', state.avatarMeasurements.highHipMm ?? Math.round((state.avatarMeasurements.waistMm || 730) * 0.32 + (state.avatarMeasurements.hipMm || 1000) * 0.68));
  setVal('avHipInput', state.avatarMeasurements.hipMm);
  setVal('avShoulderInput', state.avatarMeasurements.shoulderWidthMm);
  setVal('avBustSpanInput', state.avatarMeasurements.bustSpanMm ?? Math.round((state.avatarMeasurements.chestMm || 925) * 0.20));
  setVal('avShoulderToBustInput', state.avatarMeasurements.shoulderToBustMm ?? 260);
  setVal('avHeightInput', state.avatarMeasurements.heightMm);

  setVal('nestCustomWidthInput', state.nestingOptions.fabricWidthMm);
  setVal('nestMarginInput', state.nestingOptions.marginMm);
  setVal('nestSpacingInput', state.nestingOptions.spacingMm);
  setVal('pdfMarginInput', state.exportOptions.marginMm);
  setVal('pdfOverlapInput', state.exportOptions.overlapMm);

  const standaloneInputs = [
    'rectWidthInput',
    'rectHeightInput',
    'rectSaInput',
    'dartWidthInput',
    'dartDepthInput',
    ...(state.templateId !== 'stl_cover' ? ['stlEaseInput', 'stlThicknessInput', 'stlSaInput'] : []),
  ];
  for (const id of standaloneInputs) {
    const inp = el(id);
    if (!inp) continue;
    const prevUnit = inp._unit || 'mm';
    if (prevUnit !== u) {
      const curNum = Number(inp.value);
      if (Number.isFinite(curNum) && String(inp.value).trim() !== '') {
        try {
          const mm = unitToMm(curNum, prevUnit);
          if (Number.isFinite(mm)) {
            inp.value = String(Number(mmToUnit(mm, u).toFixed(dec)));
          }
        } catch {
          // Ignore overflow during unit display conversion
        }
      }
      inp._unit = u;
    } else if (!inp._unit) {
      inp._unit = u;
    }
  }

  if (state.templateId === 'stl_cover' && state.pattern?.params) {
    setVal('stlEaseInput', state.pattern.params.easeMm ?? 2.0);
    setVal('stlThicknessInput', state.pattern.params.thicknessMm ?? 0.0);
    setVal('stlSaInput', state.pattern.params.seamAllowance ?? 10);
    for (const id of ['stlEaseInput', 'stlThicknessInput', 'stlSaInput']) {
      const inp = el(id);
      if (inp) inp._unit = u;
    }
    const scaleInp = el('stlScaleInput');
    if (scaleInp) scaleInp.value = String(Number((state.pattern.params.scale ?? 1.0).toFixed(2)));
    const modeSel = el('stlUnwrapModeSelect');
    if (modeSel && typeof state.pattern.params.mode === 'string') {
      modeSel.value = state.pattern.params.mode;
    }
  }
}

function updateAllInspectorUI() {
  refreshUnitLabelsAndInputs();
  refreshAvatarPresetLabels();
  updatePdfSpecBadge();
  updatePieceInspectorUI();
  updateSeamDiagnosticsUI();
  updateNestingBOMUI();
  syncUndoRedoButtons();
  scheduleDraftSave();
}

function buildMaterialSlidersOnce() {
  const buildGroup = (containerId, specs) => {
    const box = el(containerId);
    if (!box) return;
    box.replaceChildren();
    for (const s of specs) {
      const row = document.createElement('div');
      row.className = 'slider-row';

      const hdr = document.createElement('div');
      hdr.className = 'slider-header';
      const lbl = document.createElement('span');
      lbl.textContent = s.label;
      const val = document.createElement('span');
      val.className = 'slider-val';
      val.id = `matVal_${s.key}`;
      hdr.appendChild(lbl);
      hdr.appendChild(val);

      const inp = document.createElement('input');
      inp.type = 'range';
      inp.id = `matSlider_${s.key}`;
      inp.min = String(s.min);
      inp.max = String(s.max);
      inp.step = String(s.step);

      inp.addEventListener('input', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        const prevPatternMat = state.pattern?.material;
        const prevMaterialCfg = getActiveMaterialConfig();
        const tx = capturePatternTx(false);
        try {
          state.materialOverrides[s.key] = v;
          val.textContent = v.toFixed(s.decimals);
          const cfg = getActiveMaterialConfig();
          if (state.pattern) state.pattern.material = { ...cfg };
          if (state.sim) {
            if (typeof state.sim.updateMaterial === 'function') {
              state.sim.updateMaterial(cfg);
            } else {
              state.sim.material = cfg;
            }
            state.strainReport = state.sim.computeStrainAnalysis();
          }
          updateMaterialUI();
          sync3DScene();
        } catch (err) {
          if (state.pattern) state.pattern.material = prevPatternMat;
          if (state.sim) {
            try {
              if (typeof state.sim.updateMaterial === 'function') {
                state.sim.updateMaterial(prevMaterialCfg);
              } else {
                state.sim.material = prevMaterialCfg;
              }
            } catch {
              state.sim.material = prevMaterialCfg;
            }
          }
          rollbackPatternTx(tx);
          showToast(err?.message || 'Cannot update material property', true);
        }
      });

      row.appendChild(hdr);
      row.appendChild(inp);
      box.appendChild(row);
    }
  };

  buildGroup('materialPhysicsSliders', MATERIAL_PHYSICS_SLIDERS);
  buildGroup('materialPbrSliders', MATERIAL_PBR_SLIDERS);
}

function populateSelects() {
  const matSel = el('materialPresetSelect');
  if (matSel) {
    matSel.replaceChildren();
    for (const mat of Object.values(MATERIAL_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = mat.id;
      opt.textContent = `${mat.name} (${mat.category})`;
      matSel.appendChild(opt);
    }
  }

  const weaveSel = el('matWeaveTypeSelect');
  if (weaveSel) {
    weaveSel.replaceChildren();
    for (const w of WEAVE_TYPES) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = w.replace(/_/g, ' ');
      weaveSel.appendChild(opt);
    }
  }

  const rollSel = el('fabricRollSelect');
  if (rollSel) {
    rollSel.replaceChildren();
    for (const roll of FABRIC_ROLL_PRESETS) {
      const opt = document.createElement('option');
      opt.value = roll.id;
      opt.textContent = roll.name;
      rollSel.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom Width...';
    rollSel.appendChild(customOpt);
    rollSel.value = state.nestingOptions.rollPreset;
  }

  const pdfSel = el('pdfFormatSelect');
  if (pdfSel) {
    pdfSel.replaceChildren();
    for (const fmt of Object.values(PAGE_FORMATS)) {
      const opt = document.createElement('option');
      opt.value = fmt.id;
      opt.textContent = fmt.name;
      pdfSel.appendChild(opt);
    }
    pdfSel.value = state.exportOptions.pageFormat;
  }
}

async function fetchInitialCatalogAndStls() {
  const stlSel = el('workspaceStlSelect');
  if (stlSel) stlSel.replaceChildren();

  const [catRes, stlRes] = await Promise.allSettled([
    fetch('/api/catalog'),
    fetch('/api/workspace-stls'),
  ]);

  if (catRes.status === 'fulfilled' && catRes.value.ok) {
    try {
      await catRes.value.json();
    } catch {
      // ignore non-json
    }
  }

  if (stlRes.status === 'fulfilled' && stlRes.value.ok) {
    try {
      const data = await stlRes.value.json();
      const files = Array.isArray(data.files) ? data.files : [];
      if (stlSel) {
        for (const f of files) {
          const opt = document.createElement('option');
          opt.value = f.name;
          const kb = Math.max(1, Math.round((f.sizeBytes || 0) / 1024));
          opt.textContent = `${f.name} (${kb} KB)`;
          stlSel.appendChild(opt);
        }
      }
    } catch {
      // ignore
    }
  }

  if (stlSel && stlSel.options.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'cutting_mat_wedge_assembled_view.stl';
    opt.textContent = 'cutting_mat_wedge_assembled_view.stl (Built-in Wedge)';
    stlSel.appendChild(opt);
  }
}

export async function loadTemplate(templateId, customParams = {}) {
  cad2D?.cancelActiveDrag?.();
  const reqId = ++templateLoadSeq;
  const prevTemplateId = state.templateId;

  if (templateId === 'stl_cover') {
    if (!state.activeStlMesh) {
      const wsFile = el('workspaceStlSelect')?.value || 'cutting_mat_wedge_assembled_view.stl';
      const ok = await loadWorkspaceSTLFile(wsFile, reqId);
      if (!ok && reqId === templateLoadSeq) {
        state.templateId = prevTemplateId;
        if (el('templateSelect')) el('templateSelect').value = prevTemplateId;
        if (state.pattern) {
          renderParametricSliders();
          updateAllInspectorUI();
        }
      }
      return ok;
    }
  }

  const tx = capturePatternTx(false);
  try {
    const catalogItem = TEMPLATE_CATALOG.find((t) => t.id === templateId);
    const materialId = catalogItem?.defaultMaterial || 'cotton_jersey';

    let loadedPattern = null;
    if (templateId !== 'stl_cover') {
      try {
        const res = await fetch('/api/generate-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateId,
            params: customParams,
            materialId,
            avatar: state.avatarMeasurements,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.pattern) loadedPattern = data.pattern;
        }
      } catch {
        // Offline fallback below
      }
    }

    if (reqId !== templateLoadSeq) return false;
    cad2D?.cancelActiveDrag?.();

    if (!loadedPattern) {
      if (templateId === 'stl_cover' && state.activeStlMesh) {
        loadedPattern = unwrapSTLToPattern(state.activeStlMesh, {
          name: state.activeStlMesh.name,
          mode: el('stlUnwrapModeSelect')?.value || 'form_shell_cover',
          easeMm: Number(customParams.easeMm ?? 2.0),
          thicknessMm: Number(customParams.thicknessMm ?? 0),
          seamAllowance: Number(customParams.seamAllowance ?? 10),
          scale: Number(customParams.scale ?? 1.0),
          materialId,
        });
      } else {
        loadedPattern = generateTemplatePattern(templateId, customParams);
      }
    }

    if (templateId !== 'stl_cover') {
      state.activeStlMesh = null;
      state.activeStlSource = null;
    }
    state.templateId = templateId;
    state.materialOverrides = {};
    state.seamWalk.seamId = null;
    state.seamWalk.walkT = 0;
    if (el('seamWalkBar')) el('seamWalkBar').classList.add('hidden');
    if (el('templateSelect')) el('templateSelect').value = templateId;

    state.pattern = loadedPattern;
    cad2D?.clearPen?.();
    if (!state.pattern.materialId) state.pattern.materialId = materialId;
    state.selectedPieceId = state.pattern.pieces?.[0]?.id || null;
    state.selectedEdgeIndex = 0;
    state.selectedVertexIndex = -1;
    state.pendingSeamEdge = null;

    updateSTLMetadataUI(state.activeStlMesh, state.pattern);
    syncContextualSidebarSections();
    rebuildSimulationAndMetrics(false);
    startBrowserAutoSettle(30, 58);
    history.clear();
    renderParametricSliders();
    updateMaterialUI();
    updateAllInspectorUI();
    cad2D?.fitToContent(build2DScene());
    draw2D();
    return true;
  } catch (err) {
    if (reqId === templateLoadSeq) {
      rollbackPatternTx(tx, { refreshSliders: true });
      showToast(err?.message || 'Failed to load template', true);
    }
    return false;
  }
}

async function applyStlUnwrapFromMesh(mesh, rawPayload, expectedSeq = null, options = {}) {
  cad2D?.cancelActiveDrag?.();
  const preserveState = Boolean(options && options.preserveState);
  const reqId = expectedSeq !== null ? expectedSeq : ++templateLoadSeq;
  const mode = el('stlUnwrapModeSelect')?.value || 'form_shell_cover';
  const { easeMm, thicknessMm, seamAllowance, scale } = normalizeStlUnwrapInputs();
  const materialId = preserveState && state.pattern?.materialId && state.templateId === 'stl_cover'
    ? state.pattern.materialId
    : 'veg_leather';

  const hasRemoteSource = Boolean(
    rawPayload && (rawPayload.workspaceFile || rawPayload.stlBase64 || rawPayload.stlText)
  );

  let pattern = null;
  if (hasRemoteSource) {
    try {
      const res = await fetch('/api/unwrap-stl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...rawPayload,
          name: mesh.name,
          mode,
          easeMm,
          thicknessMm,
          seamAllowance,
          scale,
          materialId,
        }),
      });
      if (reqId !== templateLoadSeq) return false;
      if (res.ok) {
        const data = await res.json();
        if (reqId !== templateLoadSeq) return false;
        if (data?.pattern) pattern = data.pattern;
      } else if (res.status >= 400 && res.status < 500) {
        let errMsg = null;
        try {
          const errData = await res.json();
          if (errData && typeof errData.error === 'string' && errData.error.trim().length > 0) {
            errMsg = errData.error;
          }
        } catch {
          // Ignore non-JSON error body
        }
        if (reqId !== templateLoadSeq) return false;
        // Abort on any explicit 4xx validation/client error (or 404 with JSON error message);
        // allow bare 404 (no API server / static host) to fall back to client unwrap.
        if (res.status !== 404 || errMsg !== null) {
          showToast(errMsg || `STL unwrap failed (HTTP ${res.status})`, true);
          return false;
        }
      }
    } catch {
      // Client fallback on network/server unavailability
    }
  }

  if (reqId !== templateLoadSeq) return false;
  cad2D?.cancelActiveDrag?.();

  const tx = capturePatternTx(false);
  try {
    if (!pattern) {
      pattern = unwrapSTLToPattern(mesh, {
        name: mesh.name,
        mode,
        easeMm,
        thicknessMm,
        seamAllowance,
        scale,
        materialId,
      });
    }

    if (preserveState) {
      history.push(state);
    } else {
      state.materialOverrides = {};
    }

    state.activeStlMesh = mesh;
    state.activeStlSource = hasRemoteSource ? rawPayload : null;
    state.templateId = 'stl_cover';
    state.pattern = pattern;
    cad2D?.clearPen?.();
    state.selectedPieceId = pattern.pieces?.[0]?.id || null;
    state.selectedEdgeIndex = 0;
    state.selectedVertexIndex = -1;
    state.pendingSeamEdge = null;
    state.seamWalk.seamId = null;
    state.seamWalk.walkT = 0;
    if (el('seamWalkBar')) el('seamWalkBar').classList.add('hidden');

    if (el('templateSelect')) el('templateSelect').value = 'stl_cover';
    syncContextualSidebarSections();
    updateSTLMetadataUI(mesh, pattern);
    rebuildSimulationAndMetrics(preserveState);
    startBrowserAutoSettle(24, 52);
    if (!preserveState) {
      history.clear();
    }
    renderParametricSliders();
    updateMaterialUI();
    updateAllInspectorUI();
    cad2D?.fitToContent(build2DScene());
    draw2D();
    showToast(`Unwrapped ${mesh.name} (${mesh.triangleCount} tris → ${pattern.pieces.length} panels)`);
    return true;
  } catch (err) {
    rollbackPatternTx(tx, { refreshSliders: true });
    showToast(`STL unwrap failed: ${err?.message || err}`, true);
    return false;
  }
}

export async function loadWorkspaceSTLFile(fileName, expectedSeq = null) {
  cad2D?.cancelActiveDrag?.();
  const reqId = expectedSeq !== null ? expectedSeq : ++templateLoadSeq;
  const requestedName = typeof fileName === 'string' ? fileName.trim() : '';
  const targetName = requestedName || 'cutting_mat_wedge_assembled_view.stl';
  const isDefaultWedge =
    requestedName === '' || targetName === 'cutting_mat_wedge_assembled_view.stl';

  let mesh = null;
  let remotePayload = { workspaceFile: targetName };
  let res = null;
  let fetchFailed = false;
  try {
    res = await fetch(`/api/stl-content?file=${encodeURIComponent(targetName)}`);
  } catch {
    fetchFailed = true;
  }

  if (reqId !== templateLoadSeq) return false;

  if (res && res.ok) {
    try {
      const buf = await res.arrayBuffer();
      if (reqId !== templateLoadSeq) return false;
      mesh = parseSTL(buf, targetName);
    } catch (parseErr) {
      if (reqId !== templateLoadSeq) return false;
      showToast(parseErr?.message || `Failed to parse STL: ${targetName}`, true);
      return false;
    }
  } else if (res) {
    let errMsg = null;
    try {
      const errData = await res.json();
      if (errData && typeof errData.error === 'string' && errData.error.trim().length > 0) {
        errMsg = errData.error;
      }
    } catch {
      // Ignore non-JSON error body
    }
    if (reqId !== templateLoadSeq) return false;
    if (res.status === 404 && errMsg === null && isDefaultWedge) {
      mesh = parseSTL(createWedgeSTL(), 'cutting_mat_wedge_assembled_view.stl');
      remotePayload = null;
    } else {
      showToast(
        errMsg ||
          (res.status === 404
            ? `Workspace STL file not found: ${targetName}`
            : `Failed to load workspace STL (HTTP ${res.status})`),
        true
      );
      return false;
    }
  } else if (fetchFailed) {
    if (!isDefaultWedge) {
      showToast(`Could not load workspace STL: ${targetName}`, true);
      return false;
    }
    mesh = parseSTL(createWedgeSTL(), 'cutting_mat_wedge_assembled_view.stl');
    remotePayload = null;
  }

  return await applyStlUnwrapFromMesh(mesh, remotePayload, reqId);
}

async function handleUploadedSTLFile(file) {
  if (!file) return;
  cad2D?.cancelActiveDrag?.();
  const reqId = ++templateLoadSeq;
  try {
    const buf = await file.arrayBuffer();
    if (reqId !== templateLoadSeq) return;
    const mesh = parseSTL(buf, file.name);
    const stlBase64 = arrayBufferToBase64(buf);
    const remotePayload = { stlBase64, name: file.name };
    await applyStlUnwrapFromMesh(mesh, remotePayload, reqId);
  } catch (err) {
    if (reqId !== templateLoadSeq) return;
    showToast(`Invalid STL file: ${err?.message || err}`, true);
  }
}

function triggerDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function handleExport(format) {
  if (!state.pattern) return;
  const slug = String(state.pattern.name || state.templateId || 'pattern')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');

  const layout = el('exportLayoutSelect')?.value === 'nested' ? 'nested' : 'cad';
  const nestingOptions = {
    fabricWidthMm: state.nestingOptions.fabricWidthMm,
    marginMm: state.nestingOptions.marginMm,
    spacingMm: state.nestingOptions.spacingMm,
    allowRotate90: state.nestingOptions.allowRotate90,
    lockGrainline: state.nestingOptions.lockGrainline,
  };
  const presetObj = FABRIC_ROLL_PRESETS.find((r) => r.id === state.nestingOptions.rollPreset);
  if (presetObj?.lengthMm) {
    nestingOptions.sheetLengthMm = presetObj.lengthMm;
    nestingOptions.paginateSheets = true;
  }
  const options = {
    layout,
    nestingOptions,
    pageFormat: state.exportOptions.pageFormat,
    orientation: state.exportOptions.orientation,
    marginMm: state.exportOptions.marginMm,
    overlapMm: state.exportOptions.overlapMm,
    ...(format === 'pdf'
      ? {
          includeAssemblyMap: Boolean(state.exportOptions.includeAssemblyMap),
          skipBlankTiles: Boolean(state.exportOptions.skipBlankTiles),
        }
      : {}),
  };

  let nestDiag = null;
  if (layout === 'nested' && format !== 'json') {
    try {
      nestDiag = nestPatternPieces(state.pattern, nestingOptions);
    } catch {
      nestDiag = state.nestingResult || null;
    }
  }
  const formatExportToast = (isFallback = false) => {
    if (layout === 'nested' && format !== 'json' && nestDiag) {
      const placedCount = Array.isArray(nestDiag.placements) ? nestDiag.placements.length : 0;
      const unfittedCount = Array.isArray(nestDiag.unfittedPieces) ? nestDiag.unfittedPieces.length : 0;
      if (placedCount === 0 && (unfittedCount > 0 || (state.pattern.pieces?.length || 0) > 0)) {
        return {
          message: `Nested ${format.toUpperCase()} warning: 0 pieces fit (${unfittedCount} unfitted for roll bounds)`,
          isError: true,
        };
      }
      if (placedCount > 0 && unfittedCount > 0) {
        return {
          message: `Exported 1:1 ${format.toUpperCase()} (${placedCount} placed, ${unfittedCount} unfitted)${isFallback ? ' (client fallback)' : ''}`,
          isError: false,
        };
      }
    }
    return {
      message: `Exported 1:1 ${format.toUpperCase()}${isFallback ? ' (client fallback)' : ''}`,
      isError: false,
    };
  };

  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: state.pattern,
        format,
        options,
      }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const ext = format === 'pdf' ? 'pdf' : format === 'dxf' ? 'dxf' : format === 'json' ? 'json' : 'svg';
      triggerDownloadBlob(blob, `${slug}_1to1.${ext}`);
      const toastInfo = formatExportToast(false);
      showToast(toastInfo.message, toastInfo.isError);
      return;
    }
    let errMsg = `Export failed (HTTP ${res.status})`;
    try {
      const errData = await res.json();
      if (errData && typeof errData.error === 'string' && errData.error.trim().length > 0) {
        errMsg = errData.error;
      }
    } catch {
      // Ignore non-JSON error body
    }
    showToast(errMsg, true);
    return;
  } catch {
    // Client-side fallback for svg/dxf/json on network unavailability
  }

  if (format === 'pdf') {
    showToast('Tiled PDF export requires server /api/export connection.', true);
    return;
  }

  try {
    let content = '';
    let mime = 'text/plain;charset=utf-8';
    if (format === 'svg') {
      content = exportSVG(state.pattern, options);
      mime = 'image/svg+xml;charset=utf-8';
    } else if (format === 'dxf') {
      content = exportDXF(state.pattern, options);
      mime = 'application/dxf;charset=utf-8';
    } else {
      content = exportPatternJSON(state.pattern);
      mime = 'application/json;charset=utf-8';
    }
    triggerDownloadBlob(new Blob([content], { type: mime }), `${slug}_1to1.${format}`);
    const toastInfo = formatExportToast(true);
    showToast(toastInfo.message, toastInfo.isError);
  } catch (fallbackErr) {
    showToast(fallbackErr?.message || `Client ${format.toUpperCase()} export failed.`, true);
  }
}

function setActiveTool(tool) {
  cad2D?.cancelActiveDrag?.();
  state.activeTool = tool;
  if (tool !== 'draw_poly') cad2D?.clearPen();
  if (tool !== 'sew') state.pendingSeamEdge = null;
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  const rectPop = el('rectPopover');
  if (rectPop) {
    rectPop.classList.toggle('hidden', tool !== 'add_rect');
    if (tool === 'add_rect') {
      const dec = state.unit === 'mm' ? 0 : getUnitDecimals(state.unit);
      const rw = el('rectWidthInput');
      const rh = el('rectHeightInput');
      const rsa = el('rectSaInput');
      if (rw) { rw.value = String(toDisplayNum(240, dec)); rw._unit = state.unit; }
      if (rh) { rh.value = String(toDisplayNum(180, dec)); rh._unit = state.unit; }
      if (rsa) { rsa.value = String(toDisplayNum(10, dec)); rsa._unit = state.unit; }
    }
  }
  draw2D();
}

function setViewMode(view) {
  cad2D?.cancelActiveDrag?.();
  state.viewMode = view;
  const stage = el('viewportStage');
  if (stage) stage.dataset.layout = view;
  document.querySelectorAll('#viewModeGroup .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  el('nestSheetSelectWrap')?.classList.toggle('hidden', view !== 'nesting');
  el('contextEdgeBar')?.classList.toggle('hidden', view === 'nesting' || !getSelectedPiece());
  el('pane2DTitle').textContent = view === 'nesting'
    ? 'Fabric Roll Cut Nesting & Yield Layout'
    : '2D Pattern Drafting CAD (True Scale)';
  handleResize();
  if (view === 'nesting') {
    cad2D?.clearPen?.();
    rebuildNesting();
  }
  cad2D?.fitToContent(build2DScene());
  draw2D();
}

function handleEdgeToolAction(tool, pieceId, edgeIndex, t) {
  cad2D?.cancelActiveDrag?.();
  const piece = state.pattern?.pieces?.find((p) => p.id === pieceId);
  if (
    !piece ||
    !Array.isArray(piece.points) ||
    !Number.isInteger(edgeIndex) ||
    edgeIndex < 0 ||
    edgeIndex >= piece.points.length
  ) {
    return;
  }

  state.selectedPieceId = piece.id;
  state.selectedEdgeIndex = edgeIndex;

  if (tool === 'sew') {
    if (state.pendingSeamEdge) {
      const pendingPiece = (state.pattern?.pieces || []).find((p) => p.id === state.pendingSeamEdge.pieceId);
      const pendingIdx = state.pendingSeamEdge.edgeIndex;
      if (
        !pendingPiece ||
        !Array.isArray(pendingPiece.points) ||
        !Number.isInteger(pendingIdx) ||
        pendingIdx < 0 ||
        pendingIdx >= pendingPiece.points.length
      ) {
        state.pendingSeamEdge = null;
      }
    }
    if (!state.pendingSeamEdge) {
      state.pendingSeamEdge = { pieceId: piece.id, edgeIndex };
      draw2D();
      return;
    }
    if (state.pendingSeamEdge.pieceId === piece.id && state.pendingSeamEdge.edgeIndex === edgeIndex) {
      state.pendingSeamEdge = null;
      draw2D();
      return;
    }
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      const id = `seam_${Date.now().toString(36)}`;
      state.pattern.seams.push({
        id,
        name: `Custom Seam ${state.pattern.seams.length + 1}`,
        pieceA: state.pendingSeamEdge.pieceId,
        edgeA: state.pendingSeamEdge.edgeIndex,
        pieceB: piece.id,
        edgeB: edgeIndex,
        reversed: false,
        allowEase: false,
        tStartA: 0,
        tEndA: 1,
        tStartB: 0,
        tEndB: 1,
      });
      state.pendingSeamEdge = null;
      rebuildSimulationAndMetrics(true);
      if (isLiveBrowserCanvas() && !state.simRunning) {
        startBrowserAutoSettle(16, 36);
      }
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot create custom seam', true);
    }
    return;
  }

  const tx = capturePatternTx(true);
  try {
    if (tool === 'dart') {
      history.push(state);
      const wMm = parseInputToMm(el('dartWidthInput')?.value, 2, 120) ?? 22;
      const dMm = parseInputToMm(el('dartDepthInput')?.value, 10, 300) ?? 80;
      addDartToPiece(piece, { edgeIndex, t: t ?? 0.5, widthMm: wMm, depthMm: dMm, folded: false });
    } else if (tool === 'notch') {
      history.push(state);
      const nType = el('notchTypeSelect')?.value || 'single';
      addNotchToPiece(piece, { edgeIndex, t: t ?? 0.5, type: nType, depthMm: 5 });
    } else if (tool === 'split_edge') {
      history.push(state);
      splitPieceEdge(piece, edgeIndex, t ?? 0.5, state.pattern);
      if (state.pendingSeamEdge?.pieceId === piece.id) {
        state.pendingSeamEdge = null;
      }
      reconcileSeamWalkState();
    } else if (tool === 'mirror') {
      history.push(state);
      mirrorPieceAcrossEdge(piece, edgeIndex, state.pattern);
      if (state.pendingSeamEdge?.pieceId === piece.id) {
        state.pendingSeamEdge = null;
      }
      reconcileSeamWalkState();
    }
    rebuildSimulationAndMetrics(true);
    if (isLiveBrowserCanvas() && !state.simRunning && (tool === 'dart' || tool === 'mirror' || tool === 'split_edge')) {
      startBrowserAutoSettle(16, 36);
    }
    updateAllInspectorUI();
    draw2D();
  } catch (err) {
    rollbackPatternTx(tx);
    showToast(err instanceof ValidationError ? err.message : String(err?.message || err), true);
  }
}

function handleDeleteSelectedVertex() {
  cad2D?.cancelActiveDrag?.();
  const piece = getSelectedPiece();
  if (!piece) return;
  const vIdx = state.selectedVertexIndex;
  if (!Number.isInteger(vIdx) || vIdx < 0 || vIdx >= (piece.points?.length || 0)) {
    showToast('Select a vertex on the piece first before deleting.', true);
    return;
  }
  if ((piece.points?.length || 0) <= 3) {
    showToast('Cannot delete vertex: a pattern piece requires at least 3 vertices.', true);
    return;
  }
  const tx = capturePatternTx(true);
  try {
    history.push(state);
    deletePieceVertex(piece, vIdx, state.pattern);
    state.selectedVertexIndex = Math.min(vIdx, piece.points.length - 1);
    state.selectedEdgeIndex = Math.min(state.selectedEdgeIndex, piece.points.length - 1);
    if (state.pendingSeamEdge?.pieceId === piece.id) {
      state.pendingSeamEdge = null;
    }
    reconcileSeamWalkState();
    rebuildSimulationAndMetrics(true);
    updateAllInspectorUI();
    draw2D();
  } catch (err) {
    rollbackPatternTx(tx);
    showToast(err?.message || 'Cannot delete vertex', true);
  }
}

function bindUIEvents() {
  el('templateSelect')?.addEventListener('change', (e) => {
    loadTemplate(e.target.value);
  });

  el('btnResetBlock')?.addEventListener('click', async () => {
    cad2D?.cancelActiveDrag?.();
    const prevSnap = state.pattern ? history._snapshot(state) : null;
    clearSavedDraft();
    const ok = await loadTemplate(state.templateId || 'bodice_sloper');
    if (ok) {
      if (state.autoSyncBlockToForm) {
        syncActiveGarmentBlockToAvatarInPlace();
        rebuildSimulationAndMetrics(true);
        startBrowserAutoSettle(20, 44);
        renderParametricSliders();
        updateAllInspectorUI();
        cad2D?.fitToContent(build2DScene());
        draw2D();
      }
      if (prevSnap) {
        history.undoStack.push(prevSnap);
        syncUndoRedoButtons();
      }
      showToast('Reset block to fresh defaults (Ctrl+Z to undo)');
    }
  });

  document.querySelectorAll('#viewModeGroup .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  });

  el('btnUndo')?.addEventListener('click', performUndo);
  el('btnRedo')?.addEventListener('click', performRedo);

  el('unitSelect')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    state.unit = e.target.value;
    saveUnitPref(state.unit);
    if (state.pattern) state.pattern.displayUnit = state.unit;
    renderParametricSliders();
    updateAllInspectorUI();
    draw2D();
  });

  // Simulation controls
  el('btnSimToggle')?.addEventListener('click', () => {
    state.simRunning = !state.simRunning;
    const btn = el('btnSimToggle');
    if (btn) {
      btn.textContent = state.simRunning ? '❚❚ Pause 3D' : '▶ Drape 3D';
      btn.classList.toggle('is-active', state.simRunning);
    }
    if (state.simRunning) {
      scheduleAnimationLoop();
    }
  });

  el('btnSimStep')?.addEventListener('click', () => {
    if (!state.sim) return;
    state.strainReport = state.sim.step(25);
    sync3DScene();
  });

  el('btnSimReset')?.addEventListener('click', () => {
    state.simRunning = false;
    const btn = el('btnSimToggle');
    if (btn) {
      btn.textContent = '▶ Drape 3D';
      btn.classList.remove('is-active');
    }
    viewport3D?.clearPins();
    rebuildSimulationAndMetrics(true);
  });

  el('btnStrainToggle')?.addEventListener('click', () => {
    state.showStrainMap = !state.showStrainMap;
    el('btnStrainToggle')?.classList.toggle('is-active', state.showStrainMap);
    el('strainLegend')?.classList.toggle('hidden', !state.showStrainMap);
    sync3DScene();
  });

  // 2D & 3D pane controls
  el('chkShowSeams2D')?.addEventListener('change', (e) => { state.showSeams2D = e.target.checked; draw2D(); });
  el('chkShowLengths2D')?.addEventListener('change', (e) => { state.showLengths2D = e.target.checked; draw2D(); });
  el('chkShowCutLine2D')?.addEventListener('change', (e) => { state.showCutLine2D = e.target.checked; draw2D(); });
  el('chkShowGrain2D')?.addEventListener('change', (e) => { state.showGrain2D = e.target.checked; draw2D(); });
  el('nestSheetSelect')?.addEventListener('change', (e) => {
    state.activeSheetIndex = Number(e.target.value) || 0;
    draw2D();
  });
  el('btnFit2D')?.addEventListener('click', () => { cad2D?.fitToContent(build2DScene()); draw2D(); });
  el('btnToolZoomFit')?.addEventListener('click', () => { cad2D?.fitToContent(build2DScene()); draw2D(); });

  el('chkShowForm3D')?.addEventListener('change', (e) => { state.showForm3D = e.target.checked; sync3DScene(); });
  el('chkShowWire3D')?.addEventListener('change', (e) => { state.showWire3D = e.target.checked; sync3DScene(); });
  el('chkShowThreads3D')?.addEventListener('change', (e) => { state.showThreads3D = e.target.checked; sync3DScene(); });
  el('btnPinMode3D')?.addEventListener('click', () => {
    state.pinMode3D = !state.pinMode3D;
    el('btnPinMode3D')?.classList.toggle('is-active', state.pinMode3D);
    sync3DScene();
  });
  el('btnClearPins3D')?.addEventListener('click', () => {
    viewport3D?.clearPins();
    sync3DScene();
  });
  el('btnCamFront')?.addEventListener('click', () => { viewport3D?.setCameraPreset('front'); viewport3D?.render(); });
  el('btnCamBack')?.addEventListener('click', () => { viewport3D?.setCameraPreset('back'); viewport3D?.render(); });
  el('btnCamSide')?.addEventListener('click', () => { viewport3D?.setCameraPreset('side'); viewport3D?.render(); });
  el('btnCamIso')?.addEventListener('click', () => { viewport3D?.setCameraPreset('iso'); viewport3D?.render(); });

  // CAD tool dock
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });
  el('btnToolDeleteVertex')?.addEventListener('click', handleDeleteSelectedVertex);

  // Add Rectangle Popover
  el('btnCancelAddRect')?.addEventListener('click', () => {
    el('rectPopover')?.classList.add('hidden');
    setActiveTool('select');
  });
  el('btnConfirmAddRect')?.addEventListener('click', () => {
    if (!state.pattern) return;
    cad2D?.cancelActiveDrag?.();
    const wMm = parseInputToMm(el('rectWidthInput')?.value, 10, 3000);
    const hMm = parseInputToMm(el('rectHeightInput')?.value, 10, 3000);
    const saMm = parseInputToMm(el('rectSaInput')?.value, 0, 100) ?? 10;
    if (!Number.isFinite(wMm) || !Number.isFinite(hMm)) {
      showToast('Enter valid rectangle width and height.', true);
      return;
    }
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      const bounds = state.pattern.pieces.reduce((maxX, p) => {
        const b = polygonBounds(p.points.map((pt) => ({ x: pt.x + (p.position?.x || 0), y: pt.y + (p.position?.y || 0) })));
        return Math.max(maxX, b.maxX);
      }, 0);
      const rectPiece = createRectanglePiece(
        el('rectNameInput')?.value.trim() || `Panel ${state.pattern.pieces.length + 1}`,
        wMm,
        hMm,
        { seamAllowance: saMm, position: { x: bounds + 60, y: 40 } }
      );
      state.pattern.pieces.push(rectPiece);
      state.selectedPieceId = rectPiece.id;
      state.selectedVertexIndex = -1;
      state.selectedEdgeIndex = 0;
      rebuildSimulationAndMetrics(true);
      el('rectPopover')?.classList.add('hidden');
      setActiveTool('select');
      updateAllInspectorUI();
      cad2D?.fitToContent(build2DScene());
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot add rectangle piece', true);
    }
  });

  // Seam Walk controls
  el('seamWalkSelect')?.addEventListener('change', (e) => {
    state.seamWalk.seamId = e.target.value || null;
    state.seamWalk.walkT = 0;
    if (el('seamWalkSlider')) el('seamWalkSlider').value = '0';
    if (el('seamWalkReadout')) el('seamWalkReadout').textContent = '0%';
    updateSeamDiagnosticsUI();
    draw2D();
  });
  el('seamWalkSlider')?.addEventListener('input', (e) => {
    const pct = Number(e.target.value) || 0;
    state.seamWalk.walkT = pct / 100;
    if (el('seamWalkReadout')) el('seamWalkReadout').textContent = `${pct}%`;
    draw2D();
  });
  el('btnSeamWalkClear')?.addEventListener('click', () => {
    state.seamWalk.seamId = null;
    state.seamWalk.walkT = 0;
    if (el('seamWalkSelect')) el('seamWalkSelect').value = '';
    if (el('seamWalkSlider')) el('seamWalkSlider').value = '0';
    if (el('seamWalkReadout')) el('seamWalkReadout').textContent = '0%';
    el('seamWalkBar')?.classList.add('hidden');
    updateSeamDiagnosticsUI();
    draw2D();
  });

  // Inspector Tabs
  document.querySelectorAll('.inspector-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateInspectorTab(btn.dataset.tab);
    });
  });

  el('chkAutoSyncBlockToForm')?.addEventListener('change', (e) => {
    state.autoSyncBlockToForm = Boolean(e.target.checked);
    if (state.autoSyncBlockToForm) {
      el('btnSyncBlockToAvatar')?.click();
    }
  });

  // Women's Dress Form Size Presets & Custom Inputs
  el('avSizePresetSelect')?.addEventListener('change', (e) => {
    const presetKey = e.target.value;
    const preset = WOMENS_SIZE_PRESETS[presetKey];
    if (!preset) {
      refreshAvatarPresetLabels();
      return;
    }
    const prevMeas = { ...state.avatarMeasurements };
    const prevAvatar = state.avatar;
    const tx = capturePatternTx(true);
    try {
      if (state.autoSyncBlockToForm) {
        history.push(state);
      }
      state.avatarMeasurements = { ...preset };
      state.avatar = createParametricAvatar(state.avatarMeasurements);
      const syncedBlock = state.autoSyncBlockToForm && syncActiveGarmentBlockToAvatarInPlace();
      refreshUnitLabelsAndInputs();
      refreshAvatarPresetLabels();
      rebuildSimulationAndMetrics(true);
      startBrowserAutoSettle(20, 45);
      if (syncedBlock) {
        renderParametricSliders();
        updateAllInspectorUI();
        cad2D?.fitToContent(build2DScene());
        draw2D();
        showToast(`Sized dress form & garment block to Women's ${preset.label}`);
      } else {
        showToast(`Dress form set to Women's ${preset.label}`);
      }
    } catch (err) {
      state.avatarMeasurements = prevMeas;
      state.avatar = prevAvatar;
      rollbackPatternTx(tx, { refreshSliders: true });
      showToast(err?.message || 'Cannot apply size preset', true);
    }
  });

  el('btnSyncBlockToAvatar')?.addEventListener('click', () => {
    if (!state.pattern || state.templateId === 'stl_cover' || state.templateId === 'tote_bag') {
      showToast('Select a garment block to match to the dress form.', true);
      return;
    }
    cad2D?.cancelActiveDrag?.();
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      if (!syncActiveGarmentBlockToAvatarInPlace()) return;
      rebuildSimulationAndMetrics(true);
      startBrowserAutoSettle(24, 50);
      renderParametricSliders();
      updateAllInspectorUI();
      cad2D?.fitToContent(build2DScene());
      draw2D();
      showToast('Matched pattern block measurements to dress form');
    } catch (err) {
      rollbackPatternTx(tx, { refreshSliders: true });
      showToast(err?.message || 'Cannot sync block to dress form', true);
    }
  });

  const bindAvatarInput = (id, key, minMm, maxMm) => {
    el(id)?.addEventListener('change', (e) => {
      const dec = getUnitDecimals(state.unit);
      const prevMm = state.avatarMeasurements[key];
      const prevAvatar = state.avatar;
      const mm = parseInputToMm(e.target.value, minMm, maxMm);
      if (mm === null) {
        e.target.value = String(toDisplayNum(prevMm, dec));
        return;
      }
      const tx = capturePatternTx(true);
      try {
        if (state.autoSyncBlockToForm) {
          history.push(state);
        }
        state.avatarMeasurements.bodyType = 'womens';
        state.avatarMeasurements[key] = mm;
        if (el('avSizePresetSelect')) el('avSizePresetSelect').value = 'custom';
        refreshAvatarPresetLabels();
        e.target.value = String(toDisplayNum(mm, dec));
        state.avatar = createParametricAvatar(state.avatarMeasurements);
        const syncedBlock = state.autoSyncBlockToForm && syncActiveGarmentBlockToAvatarInPlace();
        rebuildSimulationAndMetrics(true);
        startBrowserAutoSettle(16, 40);
        if (syncedBlock) {
          renderParametricSliders();
          updateAllInspectorUI();
          draw2D();
        }
      } catch (err) {
        state.avatarMeasurements[key] = prevMm;
        state.avatar = prevAvatar;
        rollbackPatternTx(tx, { refreshSliders: true });
        e.target.value = String(toDisplayNum(prevMm, dec));
        showToast(err?.message || 'Cannot update avatar measurement', true);
      }
    });
  };
  bindAvatarInput('avChestInput', 'chestMm', 600, 1600);
  bindAvatarInput('avUnderbustInput', 'underbustMm', 500, 1500);
  bindAvatarInput('avWaistInput', 'waistMm', 500, 1500);
  bindAvatarInput('avHighHipInput', 'highHipMm', 600, 1650);
  bindAvatarInput('avHipInput', 'hipMm', 650, 1700);
  bindAvatarInput('avShoulderInput', 'shoulderWidthMm', 280, 700);
  bindAvatarInput('avBustSpanInput', 'bustSpanMm', 110, 380);
  bindAvatarInput('avShoulderToBustInput', 'shoulderToBustMm', 160, 420);
  bindAvatarInput('avHeightInput', 'heightMm', 1200, 2200);

  // STL Import / Unwrap
  el('btnLoadWorkspaceStl')?.addEventListener('click', () => {
    const file = el('workspaceStlSelect')?.value;
    if (file) loadWorkspaceSTLFile(file);
  });
  el('stlFileInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) handleUploadedSTLFile(f);
  });
  const dropZone = el('stlDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleUploadedSTLFile(f);
    });
  }
  const reUnwrapActiveStl = () => {
    normalizeStlUnwrapInputs();
    if (state.templateId === 'stl_cover' && state.activeStlMesh) {
      applyStlUnwrapFromMesh(state.activeStlMesh, state.activeStlSource || null, null, { preserveState: true })
        .catch((err) => showToast(err?.message || 'STL unwrap failed', true));
    }
  };
  el('stlUnwrapModeSelect')?.addEventListener('change', reUnwrapActiveStl);
  el('stlEaseInput')?.addEventListener('change', reUnwrapActiveStl);
  el('stlThicknessInput')?.addEventListener('change', reUnwrapActiveStl);
  el('stlSaInput')?.addEventListener('change', reUnwrapActiveStl);
  el('stlScaleInput')?.addEventListener('change', reUnwrapActiveStl);

  // Piece Inspector controls
  el('pieceSelectDropdown')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    state.selectedPieceId = e.target.value;
    state.selectedEdgeIndex = 0;
    state.selectedVertexIndex = -1;
    updateAllInspectorUI();
    sync3DScene();
    draw2D();
  });
  el('pieceNameInput')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.name = e.target.value.trim() || piece.id;
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot rename piece', true);
    }
  });
  el('pieceQuantityInput')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const raw = Number(e.target.value);
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
      const fallbackQty = Math.max(1, Math.min(20, Math.trunc(piece.quantity || 1)));
      e.target.value = String(fallbackQty);
      showToast('Cut quantity must be an integer >= 1.', true);
      return;
    }
    const clamped = Math.min(20, raw);
    if (clamped !== raw) e.target.value = String(clamped);
    const prevQty = piece.quantity || 1;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.quantity = clamped;
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.value = String(prevQty);
      showToast(err?.message || 'Cannot update cut quantity', true);
    }
  });
  el('pieceRotationInput')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const trimmed = String(e.target.value).trim();
    const val = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(val)) {
      e.target.value = String(Number((piece.rotation || 0).toFixed(2)));
      return;
    }
    const clamped = Math.max(-360, Math.min(360, val));
    if (clamped !== val) e.target.value = String(Number(clamped.toFixed(2)));
    const prevRot = piece.rotation || 0;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.rotation = clamped;
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.value = String(Number(prevRot.toFixed(2)));
      showToast(err?.message || 'Cannot update piece rotation', true);
    }
  });
  el('pieceGrainInput')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const trimmed = String(e.target.value).trim();
    const val = Number(trimmed);
    const prevAngle = piece.grainline?.angleDeg ?? 90;
    if (trimmed === '' || !Number.isFinite(val)) {
      e.target.value = String(Number(prevAngle.toFixed(2)));
      return;
    }
    const clamped = Math.max(0, Math.min(180, val));
    if (clamped !== val) e.target.value = String(Number(clamped.toFixed(2)));
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      const { start: _omitStart, end: _omitEnd, ...restGrain } = piece.grainline || {};
      piece.grainline = { ...restGrain, angleDeg: clamped };
      syncUndoRedoButtons();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.value = String(Number(prevAngle.toFixed(2)));
      showToast(err?.message || 'Cannot update grain angle', true);
    }
  });
  el('pieceSaInput')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const mm = parseInputToMm(e.target.value, 0, 80);
    if (mm === null) {
      e.target.value = String(toDisplayNum(piece.seamAllowance ?? 10, getUnitDecimals(state.unit)));
      return;
    }
    const prevSa = piece.seamAllowance ?? 10;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.seamAllowance = mm;
      for (const ed of ensurePieceEdges(piece)) {
        ed.seamAllowance = mm;
      }
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.value = String(toDisplayNum(prevSa, getUnitDecimals(state.unit)));
      showToast(err?.message || 'Cannot update seam allowance', true);
    }
  });
  el('pieceOnFoldChk')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const prevFold = Boolean(piece.onFold);
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.onFold = e.target.checked;
      const edges = ensurePieceEdges(piece);
      const eIdx = Math.max(0, Math.min(edges.length - 1, state.selectedEdgeIndex || 0));
      const edge = edges[eIdx];
      let foldNote = '';
      if (edge) {
        if (piece.onFold) {
          const prevEdgeSa = edge.seamAllowance ?? piece.seamAllowance ?? 12;
          if (prevEdgeSa > 0) {
            edge._prevSaBeforeFold = prevEdgeSa;
            edge.seamAllowance = 0;
            foldNote = `Cut On Fold enabled — Edge ${eIdx + 1} seam allowance set to 0`;
          }
        } else if ((edge.seamAllowance ?? 0) === 0) {
          edge.seamAllowance = Number.isFinite(edge._prevSaBeforeFold)
            ? edge._prevSaBeforeFold
            : (piece.seamAllowance ?? 12);
          delete edge._prevSaBeforeFold;
        }
      }
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
      if (foldNote) showToast(foldNote);
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.checked = prevFold;
      showToast(err?.message || 'Cannot update fold setting', true);
    }
  });
  el('pieceGrainLockChk')?.addEventListener('change', (e) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const prevLock = Boolean(piece.grainLock);
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      piece.grainLock = e.target.checked;
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      e.target.checked = prevLock;
      showToast(err?.message || 'Cannot update grain lock', true);
    }
  });

  el('btnDuplicatePiece')?.addEventListener('click', () => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece || !state.pattern) return;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      const clone = JSON.parse(JSON.stringify(piece));
      const existingIds = new Set(state.pattern.pieces.map((p) => p.id));
      const baseId = `${piece.id}_copy_${Date.now().toString(36)}`;
      let candidateId = baseId;
      let suffix = 2;
      while (existingIds.has(candidateId)) {
        candidateId = `${baseId}_${suffix++}`;
      }
      clone.id = candidateId;
      clone.name = `${piece.name} Copy`;
      clone.position = { x: (piece.position?.x || 0) + 45, y: (piece.position?.y || 0) + 45 };
      state.pattern.pieces.push(clone);
      state.selectedPieceId = clone.id;
      state.selectedVertexIndex = -1;
      state.selectedEdgeIndex = 0;
      rebuildSimulationAndMetrics(true);
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot duplicate piece', true);
    }
  });

  el('btnDeletePiece')?.addEventListener('click', () => {
    cad2D?.cancelActiveDrag?.();
    if (!state.pattern || state.pattern.pieces.length <= 1) {
      showToast('At least one pattern piece must remain.', true);
      return;
    }
    const piece = getSelectedPiece();
    if (!piece) return;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      state.pattern.pieces = state.pattern.pieces.filter((p) => p.id !== piece.id);
      state.pattern.seams = state.pattern.seams.filter((s) => s.pieceA !== piece.id && s.pieceB !== piece.id);
      if (state.seamWalk.seamId && !state.pattern.seams.some((s) => s.id === state.seamWalk.seamId)) {
        state.seamWalk.seamId = null;
        state.seamWalk.walkT = 0;
        el('seamWalkBar')?.classList.add('hidden');
      }
      if (state.pendingSeamEdge?.pieceId === piece.id) {
        state.pendingSeamEdge = null;
      }
      state.selectedPieceId = state.pattern.pieces[0]?.id || null;
      state.selectedEdgeIndex = 0;
      state.selectedVertexIndex = -1;
      rebuildSimulationAndMetrics(true);
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot delete piece', true);
    }
  });

  const applySelectedEdgeSaMm = (mm, toastMsg = null) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece || !Number.isFinite(mm)) return;
    const edges = ensurePieceEdges(piece);
    const eIdx = Math.max(0, Math.min(edges.length - 1, state.selectedEdgeIndex || 0));
    const edge = edges[eIdx];
    if (!edge) return;
    const clampedMm = Math.max(0, Math.min(80, Number(mm.toFixed(3))));
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      edge.seamAllowance = clampedMm;
      rebuildNesting();
      updateAllInspectorUI();
      draw2D();
      if (toastMsg) showToast(toastMsg);
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot update edge seam allowance', true);
    }
  };

  // Edge controls
  el('edgeSaInput')?.addEventListener('change', (e) => {
    const piece = getSelectedPiece();
    if (!piece) return;
    const edges = ensurePieceEdges(piece);
    const eIdx = Math.max(0, Math.min(edges.length - 1, state.selectedEdgeIndex || 0));
    const edge = edges[eIdx];
    if (!edge) return;
    const mm = parseInputToMm(e.target.value, 0, 80);
    if (mm === null) {
      e.target.value = String(
        toDisplayNum(edge.seamAllowance ?? piece.seamAllowance ?? 10, getUnitDecimals(state.unit))
      );
      return;
    }
    applySelectedEdgeSaMm(mm);
  });

  document.querySelectorAll('[data-sa-mm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetMm = Number(btn.getAttribute('data-sa-mm') ?? btn.dataset?.saMm);
      if (Number.isFinite(targetMm)) {
        const label = targetMm === 0
          ? 'Set selected edge SA to 0 (Fold)'
          : `Set selected edge SA to ${formatUnitValue(targetMm, state.unit, state.unit === 'mm' ? 1 : 2)}`;
        applySelectedEdgeSaMm(targetMm, label);
      }
    });
  });

  el('btnCtxZeroSa')?.addEventListener('click', () => {
    applySelectedEdgeSaMm(0, 'Set selected edge SA to 0 (Fold)');
  });

  const applySelectedEdgeCurveMode = (mode) => {
    cad2D?.cancelActiveDrag?.();
    const piece = getSelectedPiece();
    if (!piece) return;
    const edges = ensurePieceEdges(piece);
    const eIdx = Math.max(0, Math.min(edges.length - 1, state.selectedEdgeIndex || 0));
    const edge = edges[eIdx];
    if (!edge) return;
    const tx = capturePatternTx(true);
    try {
      history.push(state);
      const p0 = piece.points[eIdx];
      const p1 = piece.points[(eIdx + 1) % piece.points.length];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      if (mode === 'straight') {
        delete edge.curve;
      } else if (mode === 'quadratic') {
        edge.curve = {
          type: 'quadratic',
          cp: {
            x: Number(((p0.x + p1.x) * 0.5 + nx * Math.min(35, len * 0.18)).toFixed(2)),
            y: Number(((p0.y + p1.y) * 0.5 + ny * Math.min(35, len * 0.18)).toFixed(2)),
          },
        };
      } else if (mode === 'cubic') {
        const lift = Math.min(35, len * 0.18);
        edge.curve = {
          type: 'cubic',
          cp1: { x: Number((p0.x + dx * 0.33 + nx * lift).toFixed(2)), y: Number((p0.y + dy * 0.33 + ny * lift).toFixed(2)) },
          cp2: { x: Number((p0.x + dx * 0.67 + nx * lift).toFixed(2)), y: Number((p0.y + dy * 0.67 + ny * lift).toFixed(2)) },
        };
      }
      rebuildSimulationAndMetrics(true);
      if (isLiveBrowserCanvas() && !state.simRunning) {
        startBrowserAutoSettle(16, 36);
      }
      updateAllInspectorUI();
      draw2D();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot update edge curve', true);
    }
  };

  el('edgeCurveSelect')?.addEventListener('change', (e) => applySelectedEdgeCurveMode(e.target.value));
  el('ctxCurveSelect')?.addEventListener('change', (e) => applySelectedEdgeCurveMode(e.target.value));

  el('btnSplitSelectedEdge')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('split_edge', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnDeleteSelectedVertex')?.addEventListener('click', handleDeleteSelectedVertex);
  el('btnQuickUnfold')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('mirror', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnQuickDart')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('dart', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnQuickNotch')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('notch', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });

  // Contextual 2D Canvas Edge Quick-Action Bar
  el('btnCtxSplit')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('split_edge', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnCtxUnfold')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('mirror', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnCtxDart')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('dart', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnCtxNotch')?.addEventListener('click', () => {
    if (state.selectedPieceId) handleEdgeToolAction('notch', state.selectedPieceId, state.selectedEdgeIndex, 0.5);
  });
  el('btnCtxOpenPieceTab')?.addEventListener('click', () => {
    activateInspectorTab('tabPiece');
  });

  // Material Studio
  el('materialPresetSelect')?.addEventListener('change', (e) => {
    if (!state.pattern) return;
    const tx = capturePatternTx(true);
    try {
      state.pattern.materialId = e.target.value;
      state.materialOverrides = {};
      rebuildSimulationAndMetrics(true);
      updateMaterialUI();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot update material preset', true);
    }
  });
  el('matWeaveTypeSelect')?.addEventListener('change', (e) => {
    const prevPatternMat = state.pattern?.material;
    const prevMaterialCfg = getActiveMaterialConfig();
    const tx = capturePatternTx(false);
    try {
      state.materialOverrides.weaveType = e.target.value;
      const cfg = getActiveMaterialConfig();
      if (state.pattern) state.pattern.material = { ...cfg };
      if (state.sim) {
        if (typeof state.sim.updateMaterial === 'function') {
          state.sim.updateMaterial(cfg);
        } else {
          state.sim.material = cfg;
        }
      }
      updateMaterialUI();
      sync3DScene();
    } catch (err) {
      if (state.pattern) state.pattern.material = prevPatternMat;
      if (state.sim) {
        try {
          if (typeof state.sim.updateMaterial === 'function') {
            state.sim.updateMaterial(prevMaterialCfg);
          } else {
            state.sim.material = prevMaterialCfg;
          }
        } catch {
          state.sim.material = prevMaterialCfg;
        }
      }
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot update weave type', true);
    }
  });
  el('btnResetMaterial')?.addEventListener('click', () => {
    const tx = capturePatternTx(true);
    try {
      state.materialOverrides = {};
      rebuildSimulationAndMetrics(true);
      updateMaterialUI();
    } catch (err) {
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot reset material overrides', true);
    }
  });
  for (const [id, key] of [
    ['matWarpColor', 'warpColor'],
    ['matWeftColor', 'weftColor'],
    ['matStitchColor', 'stitchColor'],
  ]) {
    el(id)?.addEventListener('input', (e) => {
      const prevPatternMat = state.pattern?.material;
      const prevMaterialCfg = getActiveMaterialConfig();
      const tx = capturePatternTx(false);
      try {
        state.materialOverrides[key] = e.target.value;
        if (key === 'warpColor') state.materialOverrides.baseColor = e.target.value;
        const cfg = getActiveMaterialConfig();
        if (state.pattern) state.pattern.material = { ...cfg };
        if (state.sim) {
          if (typeof state.sim.updateMaterial === 'function') {
            state.sim.updateMaterial(cfg);
          } else {
            state.sim.material = cfg;
          }
        }
        updateMaterialUI();
        sync3DScene();
      } catch (err) {
        if (state.pattern) state.pattern.material = prevPatternMat;
        if (state.sim) {
          try {
            if (typeof state.sim.updateMaterial === 'function') {
              state.sim.updateMaterial(prevMaterialCfg);
            } else {
              state.sim.material = prevMaterialCfg;
            }
          } catch {
            state.sim.material = prevMaterialCfg;
          }
        }
        rollbackPatternTx(tx);
        showToast(err?.message || 'Cannot update material color', true);
      }
    });
  }

  // Nesting & Export controls
  el('fabricRollSelect')?.addEventListener('change', (e) => {
    const val = e.target.value;
    const prevNestingOptions = { ...state.nestingOptions };
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.rollPreset = val;
      el('nestCustomWidthRow')?.classList.toggle('hidden', val !== 'custom');
      const preset = FABRIC_ROLL_PRESETS.find((r) => r.id === val);
      if (preset) state.nestingOptions.fabricWidthMm = preset.widthMm;
      rebuildNesting();
      if (state.viewMode === 'nesting') cad2D?.fitToContent(build2DScene());
      draw2D();
    } catch (err) {
      state.nestingOptions = prevNestingOptions;
      e.target.value = prevNestingOptions.rollPreset;
      el('nestCustomWidthRow')?.classList.toggle('hidden', prevNestingOptions.rollPreset !== 'custom');
      rollbackPatternTx(tx);
      showToast(err?.message || 'Cannot update fabric roll preset', true);
    }
  });
  el('nestCustomWidthInput')?.addEventListener('change', (e) => {
    const dec = getUnitDecimals(state.unit);
    const prevVal = state.nestingOptions.fabricWidthMm;
    const mm = parseInputToMm(e.target.value, 100, 5000);
    if (mm === null) {
      e.target.value = String(toDisplayNum(prevVal, dec));
      return;
    }
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.fabricWidthMm = mm;
      e.target.value = String(toDisplayNum(mm, dec));
      rebuildNesting();
      draw2D();
    } catch (err) {
      state.nestingOptions.fabricWidthMm = prevVal;
      rollbackPatternTx(tx);
      e.target.value = String(toDisplayNum(prevVal, dec));
      showToast(err?.message || 'Cannot update fabric width', true);
    }
  });
  el('nestMarginInput')?.addEventListener('change', (e) => {
    const dec = getUnitDecimals(state.unit);
    const prevVal = state.nestingOptions.marginMm;
    const mm = parseInputToMm(e.target.value, 0, 100);
    if (mm === null) {
      e.target.value = String(toDisplayNum(prevVal, dec));
      return;
    }
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.marginMm = mm;
      e.target.value = String(toDisplayNum(mm, dec));
      rebuildNesting();
      draw2D();
    } catch (err) {
      state.nestingOptions.marginMm = prevVal;
      rollbackPatternTx(tx);
      e.target.value = String(toDisplayNum(prevVal, dec));
      showToast(err?.message || 'Cannot update nesting margin', true);
    }
  });
  el('nestSpacingInput')?.addEventListener('change', (e) => {
    const dec = getUnitDecimals(state.unit);
    const prevVal = state.nestingOptions.spacingMm;
    const mm = parseInputToMm(e.target.value, 0, 100);
    if (mm === null) {
      e.target.value = String(toDisplayNum(prevVal, dec));
      return;
    }
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.spacingMm = mm;
      e.target.value = String(toDisplayNum(mm, dec));
      rebuildNesting();
      draw2D();
    } catch (err) {
      state.nestingOptions.spacingMm = prevVal;
      rollbackPatternTx(tx);
      e.target.value = String(toDisplayNum(prevVal, dec));
      showToast(err?.message || 'Cannot update nesting spacing', true);
    }
  });
  el('chkNestRotate90')?.addEventListener('change', (e) => {
    const prevVal = state.nestingOptions.allowRotate90;
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.allowRotate90 = e.target.checked;
      rebuildNesting();
      draw2D();
    } catch (err) {
      state.nestingOptions.allowRotate90 = prevVal;
      rollbackPatternTx(tx);
      e.target.checked = prevVal;
      showToast(err?.message || 'Cannot update rotation setting', true);
    }
  });
  el('chkNestLockGrain')?.addEventListener('change', (e) => {
    const prevVal = state.nestingOptions.lockGrainline;
    const tx = capturePatternTx(false);
    try {
      state.nestingOptions.lockGrainline = e.target.checked;
      rebuildNesting();
      draw2D();
    } catch (err) {
      state.nestingOptions.lockGrainline = prevVal;
      rollbackPatternTx(tx);
      e.target.checked = prevVal;
      showToast(err?.message || 'Cannot update grain lock setting', true);
    }
  });

  el('pdfFormatSelect')?.addEventListener('change', (e) => {
    state.exportOptions.pageFormat = e.target.value;
    updatePdfSpecBadge();
  });
  el('pdfOrientationSelect')?.addEventListener('change', (e) => { state.exportOptions.orientation = e.target.value; });
  el('pdfMarginInput')?.addEventListener('change', (e) => {
    const dec = getUnitDecimals(state.unit);
    const mm = parseInputToMm(e.target.value, 0, 50);
    if (mm === null) {
      e.target.value = String(toDisplayNum(state.exportOptions.marginMm, dec));
      return;
    }
    state.exportOptions.marginMm = mm;
    e.target.value = String(toDisplayNum(mm, dec));
  });
  el('pdfOverlapInput')?.addEventListener('change', (e) => {
    const dec = getUnitDecimals(state.unit);
    const mm = parseInputToMm(e.target.value, 0, 50);
    if (mm === null) {
      e.target.value = String(toDisplayNum(state.exportOptions.overlapMm, dec));
      return;
    }
    state.exportOptions.overlapMm = mm;
    e.target.value = String(toDisplayNum(mm, dec));
  });
  el('exportLayoutSelect')?.addEventListener('change', (e) => {
    state.exportOptions.layout = e.target.value;
    updatePdfSpecBadge();
  });
  el('chkPdfAssemblyMap')?.addEventListener('change', (e) => {
    state.exportOptions.includeAssemblyMap = Boolean(e.target.checked);
  });
  el('chkPdfSkipBlank')?.addEventListener('change', (e) => {
    state.exportOptions.skipBlankTiles = Boolean(e.target.checked);
  });

  const closeExportMenu = () => {
    const menu = el('fileExportMenu');
    if (menu) menu.open = false;
  };

  // Export & Import buttons
  el('btnExportSVG')?.addEventListener('click', () => handleExport('svg'));
  el('btnExportPDF')?.addEventListener('click', () => handleExport('pdf'));
  el('btnExportDXF')?.addEventListener('click', () => { closeExportMenu(); handleExport('dxf'); });
  el('btnExportJSON')?.addEventListener('click', () => { closeExportMenu(); handleExport('json'); });
  el('btnDownloadTiledPDFFull')?.addEventListener('click', () => handleExport('pdf'));
  el('btnDownloadSVGPanel')?.addEventListener('click', () => handleExport('svg'));
  el('btnDownloadDXFPanel')?.addEventListener('click', () => handleExport('dxf'));
  el('btnDownloadJSONPanel')?.addEventListener('click', () => handleExport('json'));

  el('btnImportJSON')?.addEventListener('click', () => {
    closeExportMenu();
    el('jsonFileInput')?.click();
  });
  el('btnMenuOpenExportTab')?.addEventListener('click', () => {
    closeExportMenu();
    activateInspectorTab('tabOutput');
  });

  // Quick-Start Guide Modal
  const guideModal = el('quickGuideModal');
  el('btnOpenGuide')?.addEventListener('click', () => guideModal?.classList.remove('hidden'));
  el('btnCloseGuide')?.addEventListener('click', () => guideModal?.classList.add('hidden'));
  guideModal?.addEventListener('click', (e) => {
    if (e.target === guideModal) guideModal.classList.add('hidden');
  });
  el('jsonFileInput')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    cad2D?.cancelActiveDrag?.();
    const reqId = ++templateLoadSeq;
    const tx = capturePatternTx(false);
    try {
      const text = await f.text();
      if (reqId !== templateLoadSeq) return;
      let rawMaterialId = null;
      try {
        const parsedRaw = JSON.parse(text);
        if (parsedRaw && typeof parsedRaw === 'object') rawMaterialId = parsedRaw.materialId ?? null;
      } catch {
        // importPatternJSON will surface invalid JSON errors cleanly below
      }
      const imported = importPatternJSON(text);
      if (!Array.isArray(imported?.pieces) || imported.pieces.length === 0) {
        throw new ValidationError('Pattern JSON must contain at least one pattern piece.', {
          code: 'EMPTY_PIECES',
          path: 'pieces',
        });
      }
      cad2D?.cancelActiveDrag?.();
      history.push(state);
      const nextTemplateId = imported.templateId || 'tshirt';
      const hasMatchingStl = Boolean(
        nextTemplateId === 'stl_cover' &&
        state.activeStlMesh &&
        imported.stlMetadata?.name &&
        state.activeStlMesh.name === imported.stlMetadata.name
      );
      if (!hasMatchingStl) {
        state.activeStlMesh = null;
        state.activeStlSource = null;
      }
      const hasValidRawMatId =
        typeof rawMaterialId === 'string' &&
        Object.prototype.hasOwnProperty.call(MATERIAL_PRESETS, rawMaterialId);
      const candidateMatId =
        !hasValidRawMatId &&
        imported.material?.id &&
        Object.prototype.hasOwnProperty.call(MATERIAL_PRESETS, imported.material.id)
          ? imported.material.id
          : imported.materialId;
      imported.materialId = Object.prototype.hasOwnProperty.call(MATERIAL_PRESETS, candidateMatId)
        ? candidateMatId
        : 'cotton_jersey';
      const { id: _matId, ...materialOverridesRest } =
        imported.material && typeof imported.material === 'object' && !Array.isArray(imported.material)
          ? imported.material
          : {};
      if (imported.material && typeof imported.material === 'object' && !Array.isArray(imported.material)) {
        imported.material = { ...materialOverridesRest, id: imported.materialId };
      }
      state.pattern = imported;
      cad2D?.clearPen?.();
      state.templateId = nextTemplateId;
      state.materialOverrides = materialOverridesRest;
      state.selectedPieceId = imported.pieces?.[0]?.id || null;
      state.selectedEdgeIndex = 0;
      state.selectedVertexIndex = -1;
      state.pendingSeamEdge = null;
      if (state.seamWalk.seamId && !imported.seams?.some((s) => s.id === state.seamWalk.seamId)) {
        state.seamWalk.seamId = null;
        state.seamWalk.walkT = 0;
        el('seamWalkBar')?.classList.add('hidden');
      }
      if (el('templateSelect')) el('templateSelect').value = state.templateId;
      updateSTLMetadataUI(state.activeStlMesh, state.pattern);
      syncContextualSidebarSections();
      rebuildSimulationAndMetrics(false);
      if (isLiveBrowserCanvas() && !state.simRunning) {
        startBrowserAutoSettle(20, 44);
      }
      renderParametricSliders();
      updateMaterialUI();
      updateAllInspectorUI();
      cad2D?.fitToContent(build2DScene());
      draw2D();
      const isOrphanStl =
        (nextTemplateId === 'stl_cover' || Boolean(imported.stlMetadata)) && !state.activeStlMesh;
      if (isOrphanStl) {
        const stlHint = imported.stlMetadata?.name ? ` (${imported.stlMetadata.name})` : '';
        showToast(
          `Imported ${imported.name || f.name} — STL${stlHint} not loaded; reload .stl for 3D cover drape`,
          true
        );
      } else {
        showToast(`Imported ${imported.name || f.name}`);
      }
    } catch (err) {
      if (reqId === templateLoadSeq) {
        rollbackPatternTx(tx, { refreshSliders: true });
        showToast(`JSON Import failed: ${err?.message || err}`, true);
      }
    } finally {
      e.target.value = '';
    }
  });

  // Global Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Escape') {
      const gm = el('quickGuideModal');
      if (gm && !gm.classList.contains('hidden')) {
        e.preventDefault();
        gm.classList.add('hidden');
        return;
      }
      const expMenu = el('fileExportMenu');
      if (expMenu && expMenu.open) {
        e.preventDefault();
        expMenu.open = false;
        return;
      }
      const cancelledDrag = cad2D?.cancelActiveDrag?.();
      if (cancelledDrag) {
        e.preventDefault();
        showToast('Cancelled active drag');
        return;
      }
      if (
        state.activeTool !== 'select' ||
        state.pendingSeamEdge ||
        (el('rectPopover') && !el('rectPopover').classList.contains('hidden'))
      ) {
        e.preventDefault();
        cad2D?.clearPen?.();
        state.pendingSeamEdge = null;
        el('rectPopover')?.classList.add('hidden');
        setActiveTool('select');
        showToast('Returned to Move tool (V)');
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) performRedo();
      else performUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      performRedo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handleDeleteSelectedVertex();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      el('btnSimToggle')?.click();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (lower === 'f') {
        cad2D?.fitToContent(build2DScene());
        draw2D();
      } else if (e.key === '?') {
        e.preventDefault();
        el('quickGuideModal')?.classList.toggle('hidden');
      } else if (Object.hasOwn(TOOL_HOTKEYS, lower)) {
        e.preventDefault();
        setActiveTool(TOOL_HOTKEYS[lower]);
      }
    }
  });
}

function handleResize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c2 = el('canvas2D');
  if (c2?.parentElement && cad2D) {
    const r = c2.parentElement.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      cad2D.resize(r.width, r.height, dpr);
    }
  }
  const c3 = el('canvas3D');
  if (c3?.parentElement && viewport3D) {
    const r = c3.parentElement.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      viewport3D.resize(r.width, r.height, dpr);
    }
  }
  draw2D();
  viewport3D?.render();
}

function scheduleAnimationLoop() {
  if (rafScheduled || typeof requestAnimationFrame !== 'function') return;
  rafScheduled = true;
  requestAnimationFrame(animationLoop);
}

function animationLoop() {
  rafScheduled = false;
  if (state.simRunning && state.sim) {
    state.autoSettleRemaining = 0;
    state.strainReport = state.sim.step(2);
    sync3DScene();
  } else if (state.autoSettleRemaining > 0 && state.sim) {
    const chunk = Math.min(3, state.autoSettleRemaining);
    state.autoSettleRemaining -= chunk;
    state.strainReport = state.sim.step(chunk);
    sync3DScene();
  } else if (viewport3D && viewport3D._dirty) {
    viewport3D.render();
  }
  if (state.simRunning || state.autoSettleRemaining > 0 || (viewport3D && viewport3D._dirty)) {
    scheduleAnimationLoop();
  }
}

export async function initStudio() {
  const c2 = el('canvas2D');
  const c3 = el('canvas3D');

  let pendingDragTx = null;
  try {
    cad2D = new CAD2DViewport(c2, {
      onBeforeMutate: () => {
        pendingDragTx = capturePatternTx(true);
        history.push(state);
      },
      onAfterMutate: () => {
        const tx = pendingDragTx;
        pendingDragTx = null;
        const fallbackTx = tx || capturePatternTx(false);
        try {
          history.popIfUnchanged(state);
          rebuildSimulationAndMetrics(true);
          if (isLiveBrowserCanvas() && !state.simRunning) {
            startBrowserAutoSettle(16, 36);
          }
          updateAllInspectorUI();
          draw2D();
        } catch (err) {
          rollbackPatternTx(fallbackTx);
          showToast(err?.message || 'Cannot apply geometry edit', true);
        }
      },
      onCancelMutate: () => {
        const tx = pendingDragTx;
        pendingDragTx = null;
        if (tx) {
          rollbackPatternTx(tx);
        } else {
          history.popIfUnchanged(state);
          updateAllInspectorUI();
          sync3DScene();
          draw2D();
        }
      },
      onGeometryDragging: () => {
        updatePieceInspectorUI();
        updateSeamDiagnosticsUI();
        draw2D();
      },
      onSelectPiece: (pieceId, vertexIndex, edgeIndex) => {
        state.selectedPieceId = pieceId;
        state.selectedVertexIndex = vertexIndex;
        if (Number.isInteger(edgeIndex)) state.selectedEdgeIndex = edgeIndex;
        updateAllInspectorUI();
        sync3DScene();
        draw2D();
      },
      onEdgeToolClick: handleEdgeToolAction,
      onCreateFreeform: (points) => {
        if (!state.pattern || !Array.isArray(points) || points.length < 3) return;
        const tx = capturePatternTx(true);
        try {
          history.push(state);
          const piece = createFreeformPiece(
            `Freeform ${state.pattern.pieces.length + 1}`,
            points,
            { seamAllowance: 10 }
          );
          state.pattern.pieces.push(piece);
          state.selectedPieceId = piece.id;
          state.selectedVertexIndex = -1;
          state.selectedEdgeIndex = 0;
          setActiveTool('select');
          rebuildSimulationAndMetrics(true);
          updateAllInspectorUI();
          draw2D();
          showToast(`Created freeform piece (${piece.points.length} vertices)`);
        } catch (err) {
          rollbackPatternTx(tx);
          showToast(err?.message || 'Could not create freeform polygon', true);
        }
      },
      onRedraw: () => draw2D(),
    });
  } catch (err) {
    cad2D = null;
    showToast(err?.message || '2D viewport initialization failed', true);
  }

  try {
    viewport3D = createViewport3D(c3, {
      onPinChange: () => updateHud3D(),
      onDirty: () => scheduleAnimationLoop(),
    });
  } catch (err) {
    viewport3D = null;
    showToast(err?.message || '3D viewport unavailable; continuing in 2D mode', true);
  }

  const badge = el('webglBadge');
  if (badge) {
    badge.textContent =
      viewport3D?.mode === 'webgl2'
        ? (isLiveBrowserCanvas() ? 'Three.js PBR' : 'WebGL2 PBR')
        : viewport3D?.mode === '2d'
          ? 'Canvas2D Fallback'
          : '3D Unavailable';
  }

  if (isLiveBrowserCanvas()) {
    state.unit = readSavedUnitPref();
    if (el('unitSelect')) el('unitSelect').value = state.unit;
    state.autoSyncBlockToForm = true;
    if (el('chkAutoSyncBlockToForm')) el('chkAutoSyncBlockToForm').checked = true;
    state.exportOptions.includeAssemblyMap = true;
    state.exportOptions.skipBlankTiles = true;
    if (el('chkPdfAssemblyMap')) el('chkPdfAssemblyMap').checked = true;
    if (el('chkPdfSkipBlank')) el('chkPdfSkipBlank').checked = true;
    state.avatarMeasurements = { ...DEFAULT_WOMENS_AVATAR_MEASUREMENTS };
    state.avatar = createParametricAvatar(state.avatarMeasurements);
  } else {
    state.autoSyncBlockToForm = false;
    state.exportOptions.includeAssemblyMap = false;
    state.exportOptions.skipBlankTiles = false;
  }

  populateSelects();
  buildMaterialSlidersOnce();
  bindUIEvents();
  syncContextualSidebarSections();
  updatePdfSpecBadge();
  window.addEventListener('resize', handleResize);
  handleResize();

  const bootSeq = templateLoadSeq;
  await fetchInitialCatalogAndStls();
  if (templateLoadSeq === bootSeq) {
    const restoredDraft = await tryRestoreDraftFromStorage();
    if (!restoredDraft && templateLoadSeq === bootSeq) {
      await loadTemplate(isLiveBrowserCanvas() ? 'bodice_sloper' : 'tshirt');
    }
  }
  handleResize();
  scheduleAnimationLoop();
}

if (typeof document !== 'undefined') {
  initStudio();
}

export { cad2D, viewport3D };
