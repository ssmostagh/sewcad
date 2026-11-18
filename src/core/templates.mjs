/**
 * Parametric Garment & 3D Object Cover Starter Blocks + Freeform 2D CAD Operations.
 * Includes:
 * 1. T-Shirt Block (`tshirt`)
 * 2. Pullover Hoodie Block (`hoodie`)
 * 3. Trousers / Pants Block (`pants`)
 * 4. Structured Gusseted Tote Bag (`tote_bag`)
 * 5. Custom 3D .STL Object Cover (`stl_cover` — M1 stub + M2 registration hook)
 * Plus Freeform 2D CAD Piece Creation, Dart Insertion/Folding, Notch Placement,
 * De Casteljau Edge Splitting, Vertex Deletion, Symmetric Mirroring, Seam Validation,
 * and Walk-Seam Rigid Transform.
 */

import { ValidationError, SCHEMA_VERSION } from './types.mjs';
import {
  generateWomensBodiceSloper,
  generatePrincessBodicePattern,
  generateALineSkirtPattern,
  generatePencilSkirtPattern,
  generateFitAndFlareDressPattern,
  generateWomensTrousersPattern,
} from './womens_templates.mjs';
import {
  vec2,
  add2,
  sub2,
  scale2,
  dot2,
  dist2D,
  lerp2,
  norm2,
  rotate2,
  edgeArcLength,
  evalQuadBezier,
  evalCubicBezier,
  evalEdgeAt,
  evalEdgeTangentAt,
  splitEdgeCurve,
  buildEdgeArcTable,
  arcLengthAtT,
  tAtArcLength,
  signedPolygonArea,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  getPieceTransformPivot,
  ensureCCW,
  transformPiecePoints,
  resolveEdgeDarts,
  polygonSelfIntersects,
  samplePieceOutline,
} from './geometry.mjs';

const MAX_PIECE_DIMENSION_MM = 1e15;

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
const finiteParam = (val, fallback) => {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : fallback;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

const safeStr = (val) => {
  try {
    return String(val);
  } catch {
    try {
      return Object.prototype.toString.call(val);
    } catch {
      return '[object Unknown]';
    }
  }
};

const isFinitePoint2D = (pt) =>
  Boolean(
    pt &&
      typeof pt === 'object' &&
      typeof pt.x === 'number' &&
      Number.isFinite(pt.x) &&
      typeof pt.y === 'number' &&
      Number.isFinite(pt.y)
  );

function allFinitePoints2D(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr) || !isFinitePoint2D(arr[i])) return false;
  }
  return true;
}

function hasSparseHoles(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr)) return true;
  }
  return false;
}

function parseBoolFlag(val) {
  if (typeof val === 'string') {
    const norm = val.trim().toLowerCase();
    if (norm === '' || norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') {
      return false;
    }
    return true;
  }
  return Boolean(val);
}

const hasFiniteCurvePoints = (curve) => {
  if (curve === undefined || curve === null) return true;
  if (typeof curve !== 'object') return false;
  if (curve.cp1 && curve.cp2) return isFinitePoint2D(curve.cp1) && isFinitePoint2D(curve.cp2);
  if (curve.cp) return isFinitePoint2D(curve.cp);
  return true;
};

const solveArmholeAndSleeveCap = ({
  halfWidth,
  shoulderSpan,
  shoulderDrop,
  lengthMm,
  bicepWidthMm,
  sleeveLengthMm,
}) => {
  const cx = halfWidth / 2;
  const cp2x = Math.max(cx + 8, halfWidth - Math.min(28, halfWidth * 0.12));

  const armholeLenForDepth = (depth) =>
    edgeArcLength(
      { x: cx + shoulderSpan / 2, y: shoulderDrop },
      { x: halfWidth, y: depth },
      {
        cp1: { x: cx + shoulderSpan * 0.46, y: depth * 0.55 },
        cp2: { x: cp2x, y: depth * 0.92 },
      },
      48
    );

  const sleeveCapLenForH = (w, h) =>
    edgeArcLength(
      { x: 0, y: h },
      { x: w * 0.5, y: 0 },
      {
        cp1: { x: w * 0.15, y: h * 0.85 },
        cp2: { x: w * 0.32, y: h * 0.08 },
      },
      48
    );

  const w = bicepWidthMm;
  const minDepth = Math.max(60, shoulderDrop + 36);
  const softMaxDepth = Math.max(150, lengthMm * 0.55);
  const hardMaxDepth = Math.max(softMaxDepth, w * 0.62, lengthMm * 0.78);
  const capHMinFor = (d) => clamp(Math.min(d * 0.32, w * 0.16), 22, 48);
  const targetEase = 1.05;

  let armholeDepth = clamp(w * 0.6, minDepth, softMaxDepth);
  let armholeLen = armholeLenForDepth(armholeDepth);

  if (sleeveCapLenForH(w, capHMinFor(armholeDepth)) > armholeLen * 1.1) {
    let lo = armholeDepth;
    let hi = hardMaxDepth;
    for (let iter = 0; iter < 24; iter++) {
      const mid = (lo + hi) * 0.5;
      if (armholeLenForDepth(mid) * 1.06 < sleeveCapLenForH(w, capHMinFor(mid))) lo = mid;
      else hi = mid;
    }
    armholeDepth = hi;
    armholeLen = armholeLenForDepth(armholeDepth);
  }

  let capH;
  const capHMin = capHMinFor(armholeDepth);
  const targetCapLen = armholeLen * targetEase;

  if (sleeveCapLenForH(w, capHMin) >= targetCapLen) {
    const floorCapH = 18;
    if (sleeveCapLenForH(w, floorCapH) >= armholeLen * 1.12) {
      capH = floorCapH;
    } else {
      let lo = floorCapH;
      let hi = capHMin;
      for (let iter = 0; iter < 24; iter++) {
        const mid = (lo + hi) * 0.5;
        if (sleeveCapLenForH(w, mid) < targetCapLen) lo = mid;
        else hi = mid;
      }
      capH = (lo + hi) * 0.5;
    }
  } else {
    const niceCapCeiling = (d) => Math.max(capHMinFor(d), d * 1.1, w * 0.9);
    if (armholeDepth > minDepth && sleeveCapLenForH(w, niceCapCeiling(armholeDepth)) < targetCapLen) {
      let loD = minDepth;
      let hiD = armholeDepth;
      for (let iter = 0; iter < 20; iter++) {
        const midD = (loD + hiD) * 0.5;
        const aLen = armholeLenForDepth(midD);
        if (sleeveCapLenForH(w, niceCapCeiling(midD)) < aLen * targetEase) hiD = midD;
        else loD = midD;
      }
      armholeDepth = hiD;
      armholeLen = armholeLenForDepth(armholeDepth);
    }
    const updatedTarget = armholeLen * targetEase;
    const capHMax = Math.max(armholeDepth * 1.1, sleeveLengthMm * 0.85, updatedTarget * 1.05);
    let lo = capHMinFor(armholeDepth);
    let hi = capHMax;
    for (let iter = 0; iter < 26; iter++) {
      const mid = (lo + hi) * 0.5;
      if (sleeveCapLenForH(w, mid) < updatedTarget) lo = mid;
      else hi = mid;
    }
    capH = (lo + hi) * 0.5;
  }

  return { armholeDepth, capH, cp2x };
};

let registeredStlCoverGenerator = null;

export function registerStlCoverGenerator(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new ValidationError('registerStlCoverGenerator expects a function or null', {
      code: 'INVALID_GENERATOR',
      path: 'fn',
    });
  }
  registeredStlCoverGenerator = fn;
}

export const TEMPLATE_CATALOG = [
  {
    id: 'bodice_sloper',
    name: "Women's Fitted Bodice Sloper (Bust + Waist Darts)",
    category: "Women's Blocks",
    description: '4-piece couturier sloper (Front w/ Side-Bust & Waist Darts, Back w/ Waist Darts, 2x Fitted Sleeves).',
    defaultMaterial: 'calico_muslin',
  },
  {
    id: 'princess_bodice',
    name: "Women's Princess-Seam Bodice / Bustier",
    category: "Women's Blocks",
    description: '6-panel shoulder-princess bodice sculpted over full bust & natural waist.',
    defaultMaterial: 'cotton_sateen',
  },
  {
    id: 'fit_flare_dress',
    name: "Women's Fit-and-Flare Dress",
    category: "Women's Blocks",
    description: '4-piece darted fitted bodice + flared A-line skirt joined along natural waistline.',
    defaultMaterial: 'silk_charmeuse',
  },
  {
    id: 'aline_skirt',
    name: "Women's A-Line Skirt + Waistband",
    category: "Women's Blocks",
    description: '3-piece darted A-line skirt with hip contour, flared sweep hem & folded waistband.',
    defaultMaterial: 'linen_flax',
  },
  {
    id: 'pencil_skirt',
    name: "Women's Tailored Pencil Skirt",
    category: "Women's Blocks",
    description: '3-piece suiting pencil skirt with 4 waist darts, curved hipline & knee taper.',
    defaultMaterial: 'wool_crepe',
  },
  {
    id: 'womens_trousers',
    name: "Women's High-Waisted Wide-Leg Trousers",
    category: "Women's Blocks",
    description: '5-piece high-waisted wide-leg trousers with contoured seat curve, waist darts & waistband.',
    defaultMaterial: 'wool_crepe',
  },
  {
    id: 'tshirt',
    name: 'Relaxed Crewneck Tee',
    category: 'Casual & Gear',
    description: '5-piece knit crewneck tee (Front, Back, 2x Sleeves, Ribbed Neckband).',
    defaultMaterial: 'cotton_jersey',
  },
  {
    id: 'hoodie',
    name: 'Pullover Hoodie + Kangaroo Pocket',
    category: 'Casual & Gear',
    description: '8-piece fleece hoodie (Front, Back, 2x Sleeves, 2-panel Hood, Kangaroo Pocket, Ribbed Waistband).',
    defaultMaterial: 'heavy_fleece',
  },
  {
    id: 'pants',
    name: 'Classic Straight Work Pants',
    category: 'Casual & Gear',
    description: '5-piece straight utility trousers with J-crotch & waist darts.',
    defaultMaterial: 'heavy_denim',
  },
  {
    id: 'tote_bag',
    name: 'Structured Gusseted Tote Bag',
    category: 'Accessories & 3D Covers',
    description: '7-piece heavy-duty tote (Front, Back, Left/Right/Base Gussets, 2x Folded Carry Straps).',
    defaultMaterial: 'duck_canvas',
  },
  {
    id: 'stl_cover',
    name: 'Custom 3D .STL Object Cover',
    category: 'Accessories & 3D Covers',
    description: 'Unwraps any 3D .stl model (including workspace STLs) into cut-and-sew profile & gusset panels.',
    defaultMaterial: 'veg_leather',
    requiresStl: true,
  },
];

export function generateTemplatePattern(templateId, params = {}, options = {}) {
  const safeParams = params && typeof params === 'object' ? params : {};
  const safeOptions = options && typeof options === 'object' ? options : {};
  switch (templateId) {
    case 'bodice_sloper':
      return generateWomensBodiceSloper(safeParams);
    case 'princess_bodice':
      return generatePrincessBodicePattern(safeParams);
    case 'fit_flare_dress':
      return generateFitAndFlareDressPattern(safeParams);
    case 'aline_skirt':
      return generateALineSkirtPattern(safeParams);
    case 'pencil_skirt':
      return generatePencilSkirtPattern(safeParams);
    case 'womens_trousers':
      return generateWomensTrousersPattern(safeParams, generatePantsPattern);
    case 'tshirt':
      return generateTShirtPattern(safeParams);
    case 'hoodie':
      return generateHoodiePattern(safeParams);
    case 'pants':
      return generatePantsPattern(safeParams);
    case 'tote_bag':
      return generateToteBagPattern(safeParams);
    case 'stl_cover':
      return generateSTLCoverPattern(safeParams, safeOptions);
    default:
      throw new ValidationError(`Unknown template ID: "${safeStr(templateId)}"`, {
        code: 'UNKNOWN_TEMPLATE',
        path: 'templateId',
        details: { templateId },
      });
  }
}

// ============================================================================
// 1. Parametric T-Shirt Generator (F02 — 5 Pieces, 13 Complete Seams)
// ============================================================================

export function generateTShirtPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const chestMm = clamp(finiteParam(userParams.chestMm, 1000), 400, 3000);
  const waistMm = clamp(finiteParam(userParams.waistMm, Math.round(chestMm * 0.96)), 350, 3000);
  const lengthMm = clamp(finiteParam(userParams.lengthMm, 700), 350, 2500);
  const easeMm = clamp(finiteParam(userParams.easeMm, 80), 0, 600);
  const defaultBicep = clamp(Math.round(chestMm * 0.36), 140, 520);
  const bicepWidthMm = clamp(finiteParam(userParams.bicepWidthMm, defaultBicep), 120, 1500);
  const sleeveLengthMm = clamp(finiteParam(userParams.sleeveLengthMm, 220), 120, 1500);
  const seamAllowance = clamp(finiteParam(userParams.seamAllowance, 10), 0, 100);

  const halfWidth = (chestMm + easeMm) / 2;
  const halfWaist = (waistMm + easeMm) / 2;
  const defaultShoulder = Math.round(chestMm * 0.45);
  const shoulderWidthMm = clamp(
    finiteParam(userParams.shoulderWidthMm, defaultShoulder),
    Math.min(140, Math.max(120, halfWidth - 16)),
    Math.max(150, halfWidth - 16)
  );
  const neckWidthMm = clamp(
    finiteParam(userParams.neckWidthMm, Math.round(chestMm * 0.18)),
    70,
    Math.max(80, shoulderWidthMm - 30)
  );
  const shoulderSpan = shoulderWidthMm;
  const shoulderDrop = clamp(Math.round(shoulderSpan * 0.049), 12, 24);
  const { armholeDepth, capH, cp2x } = solveArmholeAndSleeveCap({
    halfWidth,
    shoulderSpan,
    shoulderDrop,
    lengthMm,
    bicepWidthMm,
    sleeveLengthMm,
  });
  const frontNeckDropMm = clamp(finiteParam(userParams.frontNeckDropMm, 85), 20, Math.max(25, armholeDepth - 15));
  const backNeckDropMm = clamp(finiteParam(userParams.backNeckDropMm, 25), 10, Math.max(15, armholeDepth - 15));

  const p = {
    chestMm,
    waistMm,
    lengthMm,
    shoulderWidthMm,
    sleeveLengthMm,
    bicepWidthMm,
    neckWidthMm,
    frontNeckDropMm,
    backNeckDropMm,
    easeMm,
    seamAllowance,
  };

  const neckW = p.neckWidthMm;
  const sideSeamLen = Math.max(140, p.lengthMm - armholeDepth);
  const bodiceHeight = armholeDepth + sideSeamLen;
  const sa = p.seamAllowance;
  const taper = clamp((halfWidth - halfWaist) * 0.5, -40, Math.max(0, halfWidth * 0.42));

  const createBodicePiece = (id, name, neckDrop, posX, posY, zOffset, normalZ) => {
    const cx = halfWidth / 2;
    const pts = [
      { x: cx - neckW / 2, y: 0 },
      { x: cx + neckW / 2, y: 0 },
      { x: cx + shoulderSpan / 2, y: shoulderDrop },
      { x: halfWidth, y: armholeDepth },
      { x: halfWidth - taper, y: armholeDepth + sideSeamLen },
      { x: taper, y: armholeDepth + sideSeamLen },
      { x: 0, y: armholeDepth },
      { x: cx - shoulderSpan / 2, y: shoulderDrop },
    ];

    const edges = [
      {
        name: 'Neckline',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx - neckW * 0.25, y: neckDrop },
          cp2: { x: cx + neckW * 0.25, y: neckDrop },
        },
      },
      { name: 'Right Shoulder', seamAllowance: sa },
      {
        name: 'Right Armhole',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx + shoulderSpan * 0.46, y: armholeDepth * 0.55 },
          cp2: { x: cp2x, y: armholeDepth * 0.92 },
        },
      },
      { name: 'Right Side Seam', seamAllowance: sa },
      { name: 'Bottom Hem', seamAllowance: sa * 2 },
      { name: 'Left Side Seam', seamAllowance: sa },
      {
        name: 'Left Armhole',
        seamAllowance: sa,
        curve: {
          cp1: { x: halfWidth - cp2x, y: armholeDepth * 0.92 },
          cp2: { x: cx - shoulderSpan * 0.46, y: armholeDepth * 0.55 },
        },
      },
      { name: 'Left Shoulder', seamAllowance: sa },
    ];

    return {
      id,
      name,
      role: id,
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: pts,
      edges,
      notches: [
        { id: `${id}_n_neck`, edgeIndex: 0, t: 0.5, type: 'single' },
        { id: `${id}_n_r_arm`, edgeIndex: 2, t: 0.5, type: id === 'front_bodice' ? 'single' : 'double' },
        { id: `${id}_n_l_arm`, edgeIndex: 6, t: 0.5, type: id === 'front_bodice' ? 'single' : 'double' },
        { id: `${id}_n_r_waist`, edgeIndex: 3, t: 0.4, type: 'single' },
        { id: `${id}_n_l_waist`, edgeIndex: 5, t: 0.6, type: 'single' },
      ],
      darts: [],
      internalLines: [
        {
          id: `${id}_chest_line`,
          name: 'Chest Balance Line',
          type: 'stitch',
          points: [
            { x: 15, y: armholeDepth },
            { x: halfWidth - 15, y: armholeDepth },
          ],
        },
      ],
      grainline: { angleDeg: 90 },
      placement3D: {
        offset: { x: 0, y: 120, z: zOffset },
        normal: { x: 0, y: 0, z: normalZ },
        up: { x: 0, y: 1, z: 0 },
      },
    };
  };

  const frontBodice = createBodicePiece('front_bodice', 'Front Bodice', p.frontNeckDropMm, 40, 40, 125, 1);
  const backBodice = createBodicePiece('back_bodice', 'Back Bodice', p.backNeckDropMm, halfWidth + 100, 40, -125, -1);

  const createSleevePiece = (id, name, posX, posY, xOffset3D, isRight) => {
    const w = p.bicepWidthMm;
    const underLen = Math.max(80, p.sleeveLengthMm - capH * 0.35);
    const cuffTaper = w * 0.08;
    const pts = [
      { x: 0, y: capH },
      { x: w * 0.5, y: 0 },
      { x: w, y: capH },
      { x: w - cuffTaper, y: capH + underLen },
      { x: cuffTaper, y: capH + underLen },
    ];
    const edge0Name = isRight ? 'Sleeve Cap (Front Half)' : 'Sleeve Cap (Back Half)';
    const edge1Name = isRight ? 'Sleeve Cap (Back Half)' : 'Sleeve Cap (Front Half)';
    const edge0Notch = isRight ? 'single' : 'double';
    const edge1Notch = isRight ? 'double' : 'single';

    return {
      id,
      name,
      role: 'sleeve',
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: pts,
      edges: [
        {
          name: edge0Name,
          seamAllowance: sa,
          curve: {
            cp1: { x: w * 0.15, y: capH * 0.85 },
            cp2: { x: w * 0.32, y: capH * 0.08 },
          },
        },
        {
          name: edge1Name,
          seamAllowance: sa,
          curve: {
            cp1: { x: w * 0.68, y: capH * 0.08 },
            cp2: { x: w * 0.85, y: capH * 0.85 },
          },
        },
        { name: 'Underarm Seam A', seamAllowance: sa },
        { name: 'Sleeve Hem', seamAllowance: sa * 2 },
        { name: 'Underarm Seam B', seamAllowance: sa },
      ],
      notches: [
        { id: `${id}_crown_notch`, edgeIndex: 0, t: 0.98, type: 'single' },
        { id: `${id}_cap0_notch`, edgeIndex: 0, t: 0.5, type: edge0Notch },
        { id: `${id}_cap1_notch`, edgeIndex: 1, t: 0.5, type: edge1Notch },
      ],
      darts: [],
      internalLines: [],
      grainline: { angleDeg: 90 },
      placement3D: {
        offset: { x: xOffset3D, y: 240, z: 0 },
        normal: { x: Math.sign(xOffset3D), y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
      },
    };
  };

  const sleeveLeft = createSleevePiece('sleeve_left', 'Left Sleeve', 40, bodiceHeight + 110, -290, false);
  const sleeveRight = createSleevePiece('sleeve_right', 'Right Sleeve', p.bicepWidthMm + 100, bodiceHeight + 110, 290, true);

  const frontNeckLen = edgeArcLength(
    frontBodice.points[0],
    frontBodice.points[1],
    frontBodice.edges[0].curve
  );
  const backNeckLen = edgeArcLength(
    backBodice.points[0],
    backBodice.points[1],
    backBodice.edges[0].curve
  );
  const totalNeckLen = frontNeckLen + backNeckLen;
  const frontRatio = frontNeckLen / Math.max(1, totalNeckLen);
  const neckbandLen = Math.round(totalNeckLen * 0.85);
  const neckbandH = 42;

  const neckband = {
    id: 'neckband',
    name: 'Ribbed Neckband',
    role: 'collar',
    quantity: 1,
    onFold: false,
    position: { x: p.bicepWidthMm * 2 + 160, y: bodiceHeight + 110 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: neckbandLen, y: 0 },
      { x: neckbandLen, y: neckbandH },
      { x: 0, y: neckbandH },
    ],
    edges: [
      { name: 'Neckline Attachment Edge', seamAllowance: sa },
      { name: 'Short Join Seam A', seamAllowance: sa },
      { name: 'Outer Fold Edge', seamAllowance: sa },
      { name: 'Short Join Seam B', seamAllowance: sa },
    ],
    notches: [
      { id: 'nb_cf', edgeIndex: 0, t: frontRatio * 0.5, type: 'double' },
      { id: 'nb_shoulder', edgeIndex: 0, t: frontRatio, type: 'single' },
      { id: 'nb_cb_quarter', edgeIndex: 0, t: frontRatio + (1 - frontRatio) * 0.5, type: 'single' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'nb_fold',
        name: 'Center Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: neckbandH / 2 },
          { x: neckbandLen, y: neckbandH / 2 },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: 370, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: -1 },
    },
  };

  const seams = [
    {
      id: 'seam_shoulder_right',
      name: 'Right Shoulder Seam',
      pieceA: 'front_bodice',
      edgeA: 1,
      pieceB: 'back_bodice',
      edgeB: 7,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_shoulder_left',
      name: 'Left Shoulder Seam',
      pieceA: 'front_bodice',
      edgeA: 7,
      pieceB: 'back_bodice',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_side_right',
      name: 'Right Side Seam',
      pieceA: 'front_bodice',
      edgeA: 3,
      pieceB: 'back_bodice',
      edgeB: 5,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_side_left',
      name: 'Left Side Seam',
      pieceA: 'front_bodice',
      edgeA: 5,
      pieceB: 'back_bodice',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_left_underarm',
      name: 'Left Sleeve Underarm Seam',
      pieceA: 'sleeve_left',
      edgeA: 2,
      pieceB: 'sleeve_left',
      edgeB: 4,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_right_underarm',
      name: 'Right Sleeve Underarm Seam',
      pieceA: 'sleeve_right',
      edgeA: 2,
      pieceB: 'sleeve_right',
      edgeB: 4,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_left_front_armhole',
      name: 'Left Sleeve Cap to Front Armhole',
      pieceA: 'front_bodice',
      edgeA: 6,
      pieceB: 'sleeve_left',
      edgeB: 1,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_left_back_armhole',
      name: 'Left Sleeve Cap to Back Armhole',
      pieceA: 'back_bodice',
      edgeA: 2,
      pieceB: 'sleeve_left',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_right_front_armhole',
      name: 'Right Sleeve Cap to Front Armhole',
      pieceA: 'front_bodice',
      edgeA: 2,
      pieceB: 'sleeve_right',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_sleeve_right_back_armhole',
      name: 'Right Sleeve Cap to Back Armhole',
      pieceA: 'back_bodice',
      edgeA: 6,
      pieceB: 'sleeve_right',
      edgeB: 1,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_neckband_join',
      name: 'Neckband Center Back Join',
      pieceA: 'neckband',
      edgeA: 1,
      pieceB: 'neckband',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_neckband_front',
      name: 'Neckband to Front Neckline',
      pieceA: 'neckband',
      edgeA: 0,
      pieceB: 'front_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: frontRatio,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_neckband_back',
      name: 'Neckband to Back Neckline',
      pieceA: 'neckband',
      edgeA: 0,
      pieceB: 'back_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: frontRatio,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
  ];

  return {
    id: `tshirt_${Date.now()}`,
    name: 'Classic Crewneck T-Shirt Pattern',
    templateId: 'tshirt',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'cotton_jersey',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [frontBodice, backBodice, sleeveLeft, sleeveRight, neckband],
    seams,
  };
}

// ============================================================================
// 2. Parametric Pullover Hoodie Generator (F03 — 8 Pieces, 23 Complete Seams)
// ============================================================================

export function generateHoodiePattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const chestVal = clamp(finiteParam(userParams.chestMm, 1080), 450, 3000);
  const ribHeightMm = clamp(finiteParam(userParams.ribHeightMm, 70), 30, 120);
  const lengthMm = clamp(finiteParam(userParams.lengthMm, 680), ribHeightMm + 250, 2500);
  const sleeveLengthMm = clamp(finiteParam(userParams.sleeveLengthMm, 600), ribHeightMm + 150, 1500);
  const hoodHeightMm = clamp(finiteParam(userParams.hoodHeightMm, 360), 220, 1200);
  const hoodDepthMm = clamp(finiteParam(userParams.hoodDepthMm, 270), 180, 1200);
  const easeMm = clamp(finiteParam(userParams.easeMm, 120), 0, 600);
  const seamAllowance = clamp(finiteParam(userParams.seamAllowance, 10), 0, 100);

  const neckWidthMm = clamp(Math.round(chestVal * 0.194), 100, 240);
  const frontNeckDropMm = clamp(Math.round(chestVal * 0.088), 40, 110);
  const backNeckDropMm = clamp(Math.round(chestVal * 0.028), 14, 40);

  const base = generateTShirtPattern({
    chestMm: chestVal,
    waistMm: finiteParam(userParams.waistMm, Math.round(chestVal * 0.96)),
    lengthMm: lengthMm - ribHeightMm,
    shoulderWidthMm: finiteParam(userParams.shoulderWidthMm, Math.round(chestVal * 0.444)),
    sleeveLengthMm: sleeveLengthMm - ribHeightMm,
    bicepWidthMm: finiteParam(userParams.bicepWidthMm, Math.round(chestVal * 0.389)),
    neckWidthMm,
    frontNeckDropMm,
    backNeckDropMm,
    easeMm,
    seamAllowance,
  });

  const sa = base.params.seamAllowance;
  const front = base.pieces[0];
  const back = base.pieces[1];
  const sleeveL = base.pieces[2];
  const sleeveR = base.pieces[3];

  // Bodice hem attaches to waistband_rib: use standard seam allowance `sa`
  front.edges[4].seamAllowance = sa;
  back.edges[4].seamAllowance = sa;

  const frontHemLen = edgeArcLength(front.points[4], front.points[5], front.edges[4].curve);
  const backHemLen = edgeArcLength(back.points[4], back.points[5], back.edges[4].curve);
  const frontNeckLen = edgeArcLength(front.points[0], front.points[1], front.edges[0].curve);
  const backNeckLen = edgeArcLength(back.points[0], back.points[1], back.edges[0].curve);
  const halfBodiceNeck = (frontNeckLen + backNeckLen) * 0.5;
  const frontRatio = frontNeckLen / Math.max(1, frontNeckLen + backNeckLen);
  const backRatio = 1 - frontRatio;

  const fBounds = polygonBounds(front.points);
  const sideSeamH = front.points[4].y - front.points[3].y;
  const pw = clamp(finiteParam(userParams.pocketWidthMm, 360), 120, Math.max(140, frontHemLen - 20));
  const ph = clamp(finiteParam(userParams.pocketHeightMm, 200), 100, Math.max(120, sideSeamH - 20));

  const p = {
    chestMm: chestVal,
    waistMm: base.params.waistMm,
    lengthMm,
    shoulderWidthMm: base.params.shoulderWidthMm,
    sleeveLengthMm,
    bicepWidthMm: base.params.bicepWidthMm,
    hoodHeightMm,
    hoodDepthMm,
    pocketWidthMm: pw,
    pocketHeightMm: ph,
    ribHeightMm,
    easeMm,
    seamAllowance: sa,
  };

  const fCx = fBounds.width * 0.5;
  const fBotY = fBounds.maxY;

  front.internalLines.push(
    {
      id: 'kangaroo_placement',
      name: 'Kangaroo Pocket Placement Guide',
      type: 'pocket',
      points: [
        { x: fCx - pw * 0.5, y: fBotY },
        { x: fCx - pw * 0.5, y: fBotY - ph * 0.45 },
        { x: fCx - pw * 0.34, y: fBotY - ph },
        { x: fCx + pw * 0.34, y: fBotY - ph },
        { x: fCx + pw * 0.5, y: fBotY - ph * 0.45 },
        { x: fCx + pw * 0.5, y: fBotY },
      ],
    },
    {
      id: 'kangaroo_bottom_stitch',
      name: 'Kangaroo Pocket Bottom Seam Line',
      type: 'stitch',
      points: [
        { x: fCx + pw * 0.5, y: fBotY },
        { x: fCx - pw * 0.5, y: fBotY },
      ],
    }
  );

  // 2-Panel Contoured Hood with Chin Cutout & Mirrored 3D Orientation
  const w = p.hoodDepthMm;
  const h = p.hoodHeightMm;
  const maxChinInset = Math.max(0, w - Math.max(60, Math.min(w * 0.85, halfBodiceNeck * 0.92)));
  const chinInset = clamp(w - halfBodiceNeck * 0.96, 0, maxChinInset);
  const spanNeck = w - chinInset;

  const makeHoodNeckCurveRight = (arch) => ({
    cp1: { x: chinInset + spanNeck * 0.65, y: h + 12 + arch },
    cp2: { x: chinInset + spanNeck * 0.3, y: h - 8 + (arch > 0 ? arch + 8 : 0) },
  });
  let neckArch = 0;
  const baseHoodNeckLen = edgeArcLength(
    { x: w, y: h },
    { x: chinInset, y: h },
    makeHoodNeckCurveRight(0)
  );
  if (baseHoodNeckLen < halfBodiceNeck * 0.92) {
    let lo = 0;
    let hi = Math.max(20, halfBodiceNeck * 1.2);
    for (let iter = 0; iter < 14; iter++) {
      const mid = (lo + hi) * 0.5;
      const len = edgeArcLength({ x: w, y: h }, { x: chinInset, y: h }, makeHoodNeckCurveRight(mid));
      if (len < halfBodiceNeck * 0.96) lo = mid;
      else hi = mid;
    }
    neckArch = (lo + hi) * 0.5;
  }
  const rightNeckCurve = makeHoodNeckCurveRight(neckArch);
  const leftNeckCurve = {
    cp1: { x: spanNeck * 0.7, y: h - 8 + (neckArch > 0 ? neckArch + 8 : 0) },
    cp2: { x: spanNeck * 0.35, y: h + 12 + neckArch },
  };

  const hoodRight = {
    id: 'hood_right',
    name: 'Hood Side Panel (Right)',
    role: 'hood',
    quantity: 1,
    onFold: false,
    position: { x: 1150 + w + 70, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: chinInset, y: h },
    ],
    edges: [
      {
        name: 'Top Crown Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: w * 0.35, y: -15 },
          cp2: { x: w * 0.75, y: 5 },
        },
      },
      {
        name: 'Center Back Hood Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: w + 28, y: h * 0.35 },
          cp2: { x: w + 10, y: h * 0.78 },
        },
      },
      {
        name: 'Hood Neckline Seam',
        seamAllowance: sa,
        curve: rightNeckCurve,
      },
      { name: 'Front Face Opening (Drawstring Channel)', seamAllowance: 25 },
    ],
    notches: [
      { id: 'hood_right_shoulder_notch', edgeIndex: 2, t: backRatio, type: 'single' },
      { id: 'hood_right_crown_notch', edgeIndex: 1, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'hood_right_drawstring_stitch',
        name: 'Drawstring Casing Stitch Line',
        type: 'stitch',
        points: [
          { x: 25, y: 0 },
          { x: chinInset + 25, y: h },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 85, y: 430, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const hoodLeft = {
    id: 'hood_left',
    name: 'Hood Side Panel (Left)',
    role: 'hood',
    quantity: 1,
    onFold: false,
    position: { x: 1150, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w - chinInset, y: h },
      { x: 0, y: h },
    ],
    edges: [
      {
        name: 'Top Crown Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: w * 0.25, y: 5 },
          cp2: { x: w * 0.65, y: -15 },
        },
      },
      { name: 'Front Face Opening (Drawstring Channel)', seamAllowance: 25 },
      {
        name: 'Hood Neckline Seam',
        seamAllowance: sa,
        curve: leftNeckCurve,
      },
      {
        name: 'Center Back Hood Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: -10, y: h * 0.78 },
          cp2: { x: -28, y: h * 0.35 },
        },
      },
    ],
    notches: [
      { id: 'hood_left_shoulder_notch', edgeIndex: 2, t: frontRatio, type: 'single' },
      { id: 'hood_left_crown_notch', edgeIndex: 3, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'hood_left_drawstring_stitch',
        name: 'Drawstring Casing Stitch Line',
        type: 'stitch',
        points: [
          { x: w - 25, y: 0 },
          { x: w - chinInset - 25, y: h },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: -85, y: 430, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const topW = pw * 0.68;
  const topInset = (pw - topW) * 0.5;
  const sideH = ph * 0.45;
  const kangarooPocket = {
    id: 'kangaroo_pocket',
    name: 'Kangaroo Front Pocket',
    role: 'pocket',
    quantity: 1,
    onFold: false,
    position: { x: 1150, y: p.hoodHeightMm + 110 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: topInset, y: 0 },
      { x: topInset + topW, y: 0 },
      { x: pw, y: ph - sideH },
      { x: pw, y: ph },
      { x: 0, y: ph },
      { x: 0, y: ph - sideH },
    ],
    edges: [
      { name: 'Pocket Top Stitch Edge', seamAllowance: sa },
      { name: 'Right Hand Entry (Folded Hem)', seamAllowance: 20 },
      { name: 'Right Lower Side Edge', seamAllowance: sa },
      { name: 'Bottom Waistband Seam Edge', seamAllowance: sa },
      { name: 'Left Lower Side Edge', seamAllowance: sa },
      { name: 'Left Hand Entry (Folded Hem)', seamAllowance: 20 },
    ],
    notches: [
      { id: 'kp_center_top', edgeIndex: 0, t: 0.5, type: 'single' },
      { id: 'kp_center_bot', edgeIndex: 3, t: 0.5, type: 'single' },
    ],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 0, y: 20, z: 145 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const waistRibWidth = Math.round((frontHemLen + backHemLen) * 0.86);
  const waistbandRib = {
    id: 'waistband_rib',
    name: 'Ribbed Waistband (Folded)',
    role: 'waistband',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: Math.max(p.lengthMm, front.points[4].y + p.ribHeightMm) + p.sleeveLengthMm + 140 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: waistRibWidth, y: 0 },
      { x: waistRibWidth, y: p.ribHeightMm * 2 },
      { x: 0, y: p.ribHeightMm * 2 },
    ],
    edges: [
      { name: 'Bodice Attachment Seam', seamAllowance: sa },
      { name: 'Side Join Seam A', seamAllowance: sa },
      { name: 'Lower Edge', seamAllowance: sa },
      { name: 'Side Join Seam B', seamAllowance: sa },
    ],
    notches: [{ id: 'wb_center', edgeIndex: 0, t: 0.5, type: 'double' }],
    darts: [],
    internalLines: [
      {
        id: 'wb_fold',
        name: 'Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: p.ribHeightMm },
          { x: waistRibWidth, y: p.ribHeightMm },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: -140, z: 165 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const seams = base.seams.filter((s) => s.pieceA !== 'neckband' && s.pieceB !== 'neckband');
  seams.push(
    {
      id: 'seam_hood_crown',
      name: 'Hood Top Crown Seam',
      pieceA: 'hood_left',
      edgeA: 0,
      pieceB: 'hood_right',
      edgeB: 0,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_hood_center_back',
      name: 'Hood Center Back Seam',
      pieceA: 'hood_left',
      edgeA: 3,
      pieceB: 'hood_right',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_hood_left_front_neck',
      name: 'Left Hood to Front Neckline',
      pieceA: 'hood_left',
      edgeA: 2,
      pieceB: 'front_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: frontRatio,
      tStartB: 0,
      tEndB: 0.5,
    },
    {
      id: 'seam_hood_left_back_neck',
      name: 'Left Hood to Back Neckline',
      pieceA: 'hood_left',
      edgeA: 2,
      pieceB: 'back_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: frontRatio,
      tEndA: 1,
      tStartB: 0.5,
      tEndB: 1,
    },
    {
      id: 'seam_hood_right_back_neck',
      name: 'Right Hood to Back Neckline',
      pieceA: 'hood_right',
      edgeA: 2,
      pieceB: 'back_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: backRatio,
      tStartB: 0,
      tEndB: 0.5,
    },
    {
      id: 'seam_hood_right_front_neck',
      name: 'Right Hood to Front Neckline',
      pieceA: 'hood_right',
      edgeA: 2,
      pieceB: 'front_bodice',
      edgeB: 0,
      reversed: true,
      allowEase: true,
      tStartA: backRatio,
      tEndA: 1,
      tStartB: 0.5,
      tEndB: 1,
    },
    {
      id: 'seam_waistband_join',
      name: 'Waistband Side Join Seam',
      pieceA: 'waistband_rib',
      edgeA: 1,
      pieceB: 'waistband_rib',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waistband_front',
      name: 'Waistband Rib to Front Hem',
      pieceA: 'waistband_rib',
      edgeA: 0,
      pieceB: 'front_bodice',
      edgeB: 4,
      reversed: true,
      allowEase: true,
      tStartA: 0,
      tEndA: 0.5,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waistband_back',
      name: 'Waistband Rib to Back Hem',
      pieceA: 'waistband_rib',
      edgeA: 0,
      pieceB: 'back_bodice',
      edgeB: 4,
      reversed: true,
      allowEase: true,
      tStartA: 0.5,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_pocket_top',
      name: 'Kangaroo Pocket Top Stitch',
      pieceA: 'kangaroo_pocket',
      edgeA: 0,
      pieceB: 'front_bodice',
      edgeB: 0,
      internalLineIdB: 'kangaroo_placement',
      internalSegmentIndexB: 2,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_pocket_right',
      name: 'Kangaroo Pocket Right Side Stitch',
      pieceA: 'kangaroo_pocket',
      edgeA: 2,
      pieceB: 'front_bodice',
      edgeB: 0,
      internalLineIdB: 'kangaroo_placement',
      internalSegmentIndexB: 4,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_pocket_left',
      name: 'Kangaroo Pocket Left Side Stitch',
      pieceA: 'kangaroo_pocket',
      edgeA: 4,
      pieceB: 'front_bodice',
      edgeB: 0,
      internalLineIdB: 'kangaroo_placement',
      internalSegmentIndexB: 0,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_pocket_bottom',
      name: 'Kangaroo Pocket Bottom Seam',
      pieceA: 'kangaroo_pocket',
      edgeA: 3,
      pieceB: 'front_bodice',
      edgeB: 0,
      internalLineIdB: 'kangaroo_bottom_stitch',
      internalSegmentIndexB: 0,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    }
  );

  return {
    id: `hoodie_${Date.now()}`,
    name: 'Pullover Hoodie Pattern',
    templateId: 'hoodie',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'heavy_fleece',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [front, back, sleeveL, sleeveR, hoodLeft, hoodRight, kangarooPocket, waistbandRib],
    seams,
  };
}

// ============================================================================
// 3. Parametric Pants / Trousers Generator (F04 — 5 Pieces, 11 Complete Seams)
// ============================================================================

export function generatePantsPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const waistMm = clamp(finiteParam(userParams.waistMm, 840), 400, 3000);
  const hipMm = clamp(Math.max(finiteParam(userParams.hipMm, 1020), Math.round(waistMm * 0.92)), 400, 3200);
  const inseamMm = clamp(finiteParam(userParams.inseamMm, 780), 250, 2000);
  const frontRiseMm = clamp(finiteParam(userParams.frontRiseMm, 270), 160, 1000);
  const rawBackRise = clamp(finiteParam(userParams.backRiseMm, Math.max(frontRiseMm + 40, 330)), 120, 1200);
  let backRiseMm = rawBackRise;
  const ankleWidthMm = clamp(finiteParam(userParams.ankleWidthMm, 420), 200, 1500);
  const waistbandHeightMm = clamp(finiteParam(userParams.waistbandHeightMm, 45), 25, 300);
  const easeMm = clamp(finiteParam(userParams.easeMm, 60), 0, 600);
  const seamAllowance = clamp(finiteParam(userParams.seamAllowance, 12), 0, 100);

  const sa = seamAllowance;
  const quarterWaist = (waistMm + easeMm * 0.4) / 4;
  const quarterHip = (hipMm + easeMm) / 4;
  const frontCrotchExt = Math.max(48, quarterHip * 0.22);
  let backCrotchExt = Math.max(82, quarterHip * 0.36);
  const halfAnkle = ankleWidthMm / 2;

  const frontHipW = quarterHip - 8;
  const frontTotalW = frontHipW + frontCrotchExt;
  const frontAnkleW = halfAnkle - 10;
  let frontHemLeft = Math.max(10, frontHipW * 0.55 - frontAnkleW * 0.5);
  let frontHemRight = frontHemLeft + frontAnkleW;
  const frontOutseamH = frontRiseMm + inseamMm;
  let frontOutseamLen = Math.hypot(frontHemLeft, frontOutseamH);
  let frontInseamLen = Math.hypot(frontTotalW - frontHemRight, inseamMm);

  const backHipW = quarterHip + 12;
  let backTotalW = backHipW + backCrotchExt;
  const backAnkleW = halfAnkle + 10;
  const minBackOutseamY = Math.min(frontOutseamH * 0.85, frontRiseMm + Math.max(20, inseamMm * 0.35));

  const evalFrontHem = (fhl) => {
    const fhr = fhl + frontAnkleW;
    const fOut = Math.hypot(fhl, frontOutseamH);
    const fIn = Math.hypot(frontTotalW - fhr, inseamMm);
    const maxBhl = Math.sqrt(Math.max(0, fOut * fOut - minBackOutseamY * minBackOutseamY));
    const reqBhl = backTotalW - backAnkleW - Math.max(20, fIn - 20);
    return { fhr, fOut, fIn, maxBhl, reqBhl };
  };

  let curFrontEval = evalFrontHem(frontHemLeft);
  if (curFrontEval.reqBhl > curFrontEval.maxBhl) {
    const lowEval = evalFrontHem(10);
    if (lowEval.reqBhl <= lowEval.maxBhl) {
      let lo = 10;
      let hi = frontHemLeft;
      for (let iter = 0; iter < 24; iter++) {
        const mid = (lo + hi) * 0.5;
        const mEval = evalFrontHem(mid);
        if (mEval.reqBhl <= mEval.maxBhl) lo = mid;
        else hi = mid;
      }
      frontHemLeft = lo;
    } else {
      frontHemLeft = 10;
      const maxBackTotalW = lowEval.maxBhl + backAnkleW + Math.max(20, lowEval.fIn - 20);
      backTotalW = Math.max(backHipW + 20, maxBackTotalW);
      backCrotchExt = Math.max(20, backTotalW - backHipW);
    }
    frontHemRight = frontHemLeft + frontAnkleW;
    frontOutseamLen = Math.hypot(frontHemLeft, frontOutseamH);
    frontInseamLen = Math.hypot(frontTotalW - frontHemRight, inseamMm);
    curFrontEval = evalFrontHem(frontHemLeft);
  }

  let backHemLeft = Math.max(10, Math.min(backHipW * 0.55 - backAnkleW * 0.5, curFrontEval.maxBhl));
  let backHemRight = backHemLeft + backAnkleW;
  const maxInseamDx = Math.max(20, frontInseamLen - 20);
  if (backTotalW - backHemRight > maxInseamDx) {
    const shift = backTotalW - backHemRight - maxInseamDx;
    backHemLeft += shift;
    backHemRight += shift;
  } else if (backTotalW - backHemRight < -maxInseamDx) {
    const shift = Math.min(backHemLeft - 10, -(maxInseamDx + (backTotalW - backHemRight)));
    if (shift > 0) {
      backHemLeft -= shift;
      backHemRight -= shift;
    }
  }
  const backInseamDx = backTotalW - backHemRight;
  const backVerticalInseam =
    frontInseamLen > Math.abs(backInseamDx) + 1
      ? Math.sqrt(frontInseamLen * frontInseamLen - backInseamDx * backInseamDx)
      : inseamMm;
  const backOutseamY = Math.sqrt(
    Math.max(frontRiseMm * frontRiseMm + 100, frontOutseamLen * frontOutseamLen - backHemLeft * backHemLeft)
  );
  const backWaistW = quarterWaist + 24;
  const maxNegativeRiseDrop = Math.max(
    0,
    backOutseamY * (Math.max(0, backWaistW - 2) / Math.max(1, backHemLeft)) * 0.85
  );
  if (frontRiseMm - backRiseMm > maxNegativeRiseDrop) {
    backRiseMm = Math.max(120, frontRiseMm - maxNegativeRiseDrop);
  }

  const p = {
    waistMm,
    hipMm,
    inseamMm,
    frontRiseMm,
    backRiseMm,
    ankleWidthMm,
    waistbandHeightMm,
    easeMm,
    seamAllowance,
  };

  const riseDelta = p.backRiseMm - p.frontRiseMm;
  const backTopPad = Math.max(0, riseDelta);
  const backWaistLen = Math.hypot(backWaistW, riseDelta);

  const createLegPiece = (id, name, isBack, posX, posY, x3D, z3D) => {
    const crotchExt = isBack ? backCrotchExt : frontCrotchExt;
    const waistW = isBack ? backWaistW : quarterWaist + 16;
    const totalW = isBack ? backTotalW : frontTotalW;
    const hemLeft = isBack ? backHemLeft : frontHemLeft;
    const hemRight = isBack ? backHemRight : frontHemRight;
    const vertInseam = isBack ? backVerticalInseam : p.inseamMm;
    const topPad = isBack ? backTopPad : 0;
    const sideWaistY = topPad;
    const centerWaistY = isBack ? topPad - riseDelta : 0;
    const crotchY = topPad + p.frontRiseMm;
    const inseamHemY = crotchY + vertInseam;
    const outseamHemY = topPad + (isBack ? backOutseamY : frontOutseamH);
    const crotchSpanY = crotchY - centerWaistY;

    const outseamXAt = (y) =>
      hemLeft * clamp((y - sideWaistY) / Math.max(1, outseamHemY - sideWaistY), 0, 1);
    const cp1y = centerWaistY + crotchSpanY * 0.62;
    const cp2y = centerWaistY + crotchSpanY * 0.96;
    const outX1 = outseamXAt(cp1y);
    const outX2 = outseamXAt(cp2y);
    const cp1x = Math.min(
      totalW - 2,
      Math.max(waistW + 5, outX1 + Math.min(18, Math.max(4, (totalW - outX1) * 0.5)))
    );
    const cp2x = Math.min(
      totalW - 2,
      Math.max(waistW + crotchExt * 0.35, outX2 + Math.min(18, Math.max(4, (totalW - outX2) * 0.5)))
    );

    const pts = [
      { x: 0, y: sideWaistY },
      { x: waistW, y: centerWaistY },
      { x: totalW, y: crotchY },
      { x: hemRight, y: inseamHemY },
      { x: hemLeft, y: outseamHemY },
    ];

    return {
      id,
      name,
      role: isBack ? 'back_leg' : 'front_leg',
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: pts,
      edges: [
        { name: 'Waistline', seamAllowance: sa },
        {
          name: isBack ? 'Back Seat / Crotch Curve' : 'Front Fly / Crotch J-Curve',
          seamAllowance: sa,
          curve: {
            cp1: { x: cp1x, y: cp1y },
            cp2: { x: cp2x, y: cp2y },
          },
        },
        { name: 'Inseam', seamAllowance: sa },
        { name: 'Ankle Hem', seamAllowance: 25 },
        { name: 'Outseam', seamAllowance: sa },
      ],
      notches: [
        { id: `${id}_knee_in`, edgeIndex: 2, t: 0.45, type: isBack ? 'double' : 'single' },
        { id: `${id}_knee_out`, edgeIndex: 4, t: 0.55, type: isBack ? 'double' : 'single' },
        { id: `${id}_hip_notch`, edgeIndex: 4, t: 0.82, type: 'single' },
      ],
      darts: [
        {
          id: `${id}_waist_dart`,
          edgeIndex: 0,
          t: 0.45,
          widthMm: isBack ? 22 : 15,
          depthMm: isBack ? 110 : 85,
          folded: false,
        },
      ],
      internalLines: [
        {
          id: `${id}_knee_line`,
          name: 'Knee Balance Line',
          type: 'stitch',
          points: [
            { x: hemLeft * 0.6, y: crotchY + vertInseam * 0.45 },
            { x: hemRight + 15, y: crotchY + vertInseam * 0.45 },
          ],
        },
      ],
      grainline: { angleDeg: 90 },
      placement3D: {
        offset: { x: x3D, y: -250, z: z3D },
        normal: { x: 0, y: 0, z: isBack ? -1 : 1 },
        up: { x: 0, y: 1, z: 0 },
      },
    };
  };

  const colW = quarterHip + backCrotchExt + 85;
  const frontLeft = createLegPiece('front_leg_left', 'Front Leg (Left)', false, 40, 40, -110, 95);
  const frontRight = createLegPiece('front_leg_right', 'Front Leg (Right)', false, 40 + colW, 40, 110, 95);
  const backLeft = createLegPiece('back_leg_left', 'Back Leg (Left)', true, 40 + colW * 2, 40, -110, -95);
  const backRight = createLegPiece('back_leg_right', 'Back Leg (Right)', true, 40 + colW * 3, 40, 110, -95);

  const netFrontWaist = quarterWaist + 1;
  const netBackWaist = Math.max(20, backWaistLen - 22);
  const overlapTab = 40;
  const wbLen = Math.round(2 * netFrontWaist + 2 * netBackWaist + overlapTab);
  const t0 = overlapTab / wbLen;
  const qF = netFrontWaist / wbLen;
  const qB = netBackWaist / wbLen;
  const t1 = t0 + qF;
  const t2 = t1 + qB;
  const t3 = t2 + qB;
  const maxLegHeight = backTopPad + Math.max(frontOutseamH, p.frontRiseMm + backVerticalInseam, backOutseamY);

  const waistband = {
    id: 'waistband',
    name: 'Contoured Waistband',
    role: 'waistband',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: maxLegHeight + 110 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: wbLen, y: 0 },
      { x: wbLen, y: p.waistbandHeightMm * 2 },
      { x: 0, y: p.waistbandHeightMm * 2 },
    ],
    edges: [
      { name: 'Upper Waistband Edge', seamAllowance: sa },
      { name: 'Right Fly Overlap End', seamAllowance: sa },
      { name: 'Lower Waist Attachment Seam', seamAllowance: sa },
      { name: 'Left Fly End', seamAllowance: sa },
    ],
    notches: [
      { id: 'wb_side_l', edgeIndex: 2, t: t1, type: 'single' },
      { id: 'wb_cb', edgeIndex: 2, t: t2, type: 'double' },
      { id: 'wb_side_r', edgeIndex: 2, t: t3, type: 'single' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'wb_fold',
        name: 'Top Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: p.waistbandHeightMm },
          { x: wbLen, y: p.waistbandHeightMm },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: 55, z: 165 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const seams = [
    {
      id: 'seam_inseam_left',
      name: 'Left Leg Inseam',
      pieceA: 'front_leg_left',
      edgeA: 2,
      pieceB: 'back_leg_left',
      edgeB: 2,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_inseam_right',
      name: 'Right Leg Inseam',
      pieceA: 'front_leg_right',
      edgeA: 2,
      pieceB: 'back_leg_right',
      edgeB: 2,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_outseam_left',
      name: 'Left Leg Outseam',
      pieceA: 'front_leg_left',
      edgeA: 4,
      pieceB: 'back_leg_left',
      edgeB: 4,
      reversed: false,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_outseam_right',
      name: 'Right Leg Outseam',
      pieceA: 'front_leg_right',
      edgeA: 4,
      pieceB: 'back_leg_right',
      edgeB: 4,
      reversed: false,
      allowEase: true,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_front_crotch',
      name: 'Front Crotch / Fly Seam',
      pieceA: 'front_leg_left',
      edgeA: 1,
      pieceB: 'front_leg_right',
      edgeB: 1,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_back_seat',
      name: 'Back Center Seat Seam',
      pieceA: 'back_leg_left',
      edgeA: 1,
      pieceB: 'back_leg_right',
      edgeB: 1,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waist_front_left',
      name: 'Waistband to Front Left Waist',
      pieceA: 'waistband',
      edgeA: 2,
      pieceB: 'front_leg_left',
      edgeB: 0,
      reversed: false,
      allowEase: false,
      tStartA: t0,
      tEndA: t1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waist_back_left',
      name: 'Waistband to Back Left Waist',
      pieceA: 'waistband',
      edgeA: 2,
      pieceB: 'back_leg_left',
      edgeB: 0,
      reversed: false,
      allowEase: false,
      tStartA: t1,
      tEndA: t2,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waist_back_right',
      name: 'Waistband to Back Right Waist',
      pieceA: 'waistband',
      edgeA: 2,
      pieceB: 'back_leg_right',
      edgeB: 0,
      reversed: false,
      allowEase: false,
      tStartA: t2,
      tEndA: t3,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waist_front_right',
      name: 'Waistband to Front Right Waist',
      pieceA: 'waistband',
      edgeA: 2,
      pieceB: 'front_leg_right',
      edgeB: 0,
      reversed: false,
      allowEase: false,
      tStartA: t3,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_waistband_closure',
      name: 'Waistband Center Front Closure',
      pieceA: 'waistband',
      edgeA: 1,
      pieceB: 'waistband',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
  ];

  return {
    id: `pants_${Date.now()}`,
    name: 'Tailored Work Pants Pattern',
    templateId: 'pants',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'heavy_denim',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [frontLeft, frontRight, backLeft, backRight, waistband],
    seams,
  };
}

// ============================================================================
// 4. Parametric Structured Tote Bag Generator (F05 — 7 Pieces, 14 Exact Seams)
// ============================================================================

export function generateToteBagPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const widthMm = clamp(finiteParam(userParams.widthMm, 380), 80, 3000);
  const heightMm = clamp(finiteParam(userParams.heightMm, 420), 80, 3000);
  const gussetDepthMm = clamp(finiteParam(userParams.gussetDepthMm, 120), 30, 1200);
  const strapLengthMm = clamp(finiteParam(userParams.strapLengthMm, 650), 150, 3000);
  const strapWidthMm = Math.min(Math.max(12, finiteParam(userParams.strapWidthMm, 40)), widthMm * 0.22);
  const seamAllowance = clamp(finiteParam(userParams.seamAllowance, 10), 0, 100);

  const p = {
    widthMm,
    heightMm,
    gussetDepthMm,
    strapLengthMm,
    strapWidthMm,
    seamAllowance,
  };

  const w = p.widthMm;
  const h = p.heightMm;
  const g = p.gussetDepthMm;
  const sa = p.seamAllowance;
  const sw = p.strapWidthMm;

  const createMainPanel = (id, name, posX, posY, z3D, normalZ) => ({
    id,
    name,
    role: id,
    quantity: 1,
    onFold: false,
    position: { x: posX, y: posY },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    edges: [
      { name: 'Top Bag Opening (Folded Hem)', seamAllowance: 30 },
      { name: 'Right Gusset Seam', seamAllowance: sa },
      { name: 'Bottom Gusset Seam', seamAllowance: sa },
      { name: 'Left Gusset Seam', seamAllowance: sa },
    ],
    notches: [
      { id: `${id}_strap_l`, edgeIndex: 0, t: 0.25, type: 'single' },
      { id: `${id}_strap_r`, edgeIndex: 0, t: 0.75, type: 'single' },
      { id: `${id}_bot_center`, edgeIndex: 2, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: `${id}_top_hem_fold`,
        name: 'Top Hem Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: 30 },
          { x: w, y: 30 },
        ],
      },
      {
        id: `${id}_strap_l_box`,
        name: 'Left Strap Attachment Box',
        type: 'stitch',
        points: [
          { x: w * 0.25 - sw * 0.5, y: 0 },
          { x: w * 0.25 - sw * 0.5, y: 30 },
          { x: w * 0.25 + sw * 0.5, y: 30 },
          { x: w * 0.25 + sw * 0.5, y: 0 },
        ],
      },
      {
        id: `${id}_strap_r_box`,
        name: 'Right Strap Attachment Box',
        type: 'stitch',
        points: [
          { x: w * 0.75 - sw * 0.5, y: 0 },
          { x: w * 0.75 - sw * 0.5, y: 30 },
          { x: w * 0.75 + sw * 0.5, y: 30 },
          { x: w * 0.75 + sw * 0.5, y: 0 },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 0, y: 0, z: z3D },
      normal: { x: 0, y: 0, z: normalZ },
      up: { x: 0, y: 1, z: 0 },
    },
  });

  const toteFront = createMainPanel('tote_front', 'Tote Front Panel', 40, 40, g * 0.5, 1);
  const toteBack = createMainPanel('tote_back', 'Tote Back Panel', w + 100, 40, -g * 0.5, -1);

  const gussetLeft = {
    id: 'tote_gusset_left',
    name: 'Left Side Gusset',
    role: 'gusset',
    quantity: 1,
    onFold: false,
    position: { x: w * 2 + 160, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: g, y: 0 },
      { x: g, y: h },
      { x: 0, y: h },
    ],
    edges: [
      { name: 'Top Gusset Hem', seamAllowance: 30 },
      { name: 'Front Left Seam', seamAllowance: sa },
      { name: 'Bottom Gusset Join', seamAllowance: sa },
      { name: 'Back Left Seam', seamAllowance: sa },
    ],
    notches: [{ id: 'gl_mid', edgeIndex: 1, t: 0.5, type: 'single' }],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: -w * 0.5, y: 0, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const gussetRight = {
    id: 'tote_gusset_right',
    name: 'Right Side Gusset',
    role: 'gusset',
    quantity: 1,
    onFold: false,
    position: { x: w * 2 + g + 220, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: g, y: 0 },
      { x: g, y: h },
      { x: 0, y: h },
    ],
    edges: [
      { name: 'Top Gusset Hem', seamAllowance: 30 },
      { name: 'Back Right Seam', seamAllowance: sa },
      { name: 'Bottom Gusset Join', seamAllowance: sa },
      { name: 'Front Right Seam', seamAllowance: sa },
    ],
    notches: [{ id: 'gr_mid', edgeIndex: 3, t: 0.5, type: 'single' }],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: w * 0.5, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const gussetBottom = {
    id: 'tote_gusset_bottom',
    name: 'Reinforced Base Gusset',
    role: 'gusset_bottom',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: h + 110 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: g },
      { x: 0, y: g },
    ],
    edges: [
      { name: 'Front Bottom Seam', seamAllowance: sa },
      { name: 'Right Gusset Join', seamAllowance: sa },
      { name: 'Back Bottom Seam', seamAllowance: sa },
      { name: 'Left Gusset Join', seamAllowance: sa },
    ],
    notches: [
      { id: 'gb_front', edgeIndex: 0, t: 0.5, type: 'double' },
      { id: 'gb_back', edgeIndex: 2, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: -h * 0.5, z: 0 },
      normal: { x: 0, y: -1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
  };

  const createStrap = (id, name, posY, z3D) => ({
    id,
    name,
    role: 'strap',
    quantity: 1,
    onFold: false,
    position: { x: w + 100, y: posY },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: p.strapLengthMm, y: 0 },
      { x: p.strapLengthMm, y: sw * 2 },
      { x: 0, y: sw * 2 },
    ],
    edges: [
      { name: 'Strap Long Edge A', seamAllowance: sa },
      { name: 'Strap End Tab A', seamAllowance: sa },
      { name: 'Strap Long Edge B', seamAllowance: sa },
      { name: 'Strap End Tab B', seamAllowance: sa },
    ],
    notches: [],
    darts: [],
    internalLines: [
      {
        id: `${id}_fold`,
        name: 'Center Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: sw },
          { x: p.strapLengthMm, y: sw },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: h * 0.65, z: z3D },
      normal: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
  });

  const strapFront = createStrap('strap_front', 'Front Carry Handle Strap', h + 110, g * 0.45);
  const strapBack = createStrap('strap_back', 'Back Carry Handle Strap', h + sw * 2 + 160, -g * 0.45);

  const hr = (sw * 0.5) / w;

  const seams = [
    {
      id: 'seam_tote_front_left',
      name: 'Front Panel to Left Gusset',
      pieceA: 'tote_front',
      edgeA: 3,
      pieceB: 'tote_gusset_left',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_tote_front_right',
      name: 'Front Panel to Right Gusset',
      pieceA: 'tote_front',
      edgeA: 1,
      pieceB: 'tote_gusset_right',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_tote_back_left',
      name: 'Back Panel to Left Gusset',
      pieceA: 'tote_back',
      edgeA: 1,
      pieceB: 'tote_gusset_left',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_tote_back_right',
      name: 'Back Panel to Right Gusset',
      pieceA: 'tote_back',
      edgeA: 3,
      pieceB: 'tote_gusset_right',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_tote_front_bottom',
      name: 'Front Panel to Base Gusset',
      pieceA: 'tote_front',
      edgeA: 2,
      pieceB: 'tote_gusset_bottom',
      edgeB: 0,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_tote_back_bottom',
      name: 'Back Panel to Base Gusset',
      pieceA: 'tote_back',
      edgeA: 2,
      pieceB: 'tote_gusset_bottom',
      edgeB: 2,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_gusset_bot_left',
      name: 'Left Gusset to Base Gusset',
      pieceA: 'tote_gusset_left',
      edgeA: 2,
      pieceB: 'tote_gusset_bottom',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_gusset_bot_right',
      name: 'Right Gusset to Base Gusset',
      pieceA: 'tote_gusset_right',
      edgeA: 2,
      pieceB: 'tote_gusset_bottom',
      edgeB: 1,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_strap_front_fold',
      name: 'Front Strap Lengthwise Fold Join',
      pieceA: 'strap_front',
      edgeA: 0,
      pieceB: 'strap_front',
      edgeB: 2,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_strap_back_fold',
      name: 'Back Strap Lengthwise Fold Join',
      pieceA: 'strap_back',
      edgeA: 0,
      pieceB: 'strap_back',
      edgeB: 2,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_strap_front_left',
      name: 'Front Strap Left Tab to Front Panel',
      pieceA: 'tote_front',
      edgeA: 0,
      pieceB: 'strap_front',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0.25 - hr,
      tEndA: 0.25 + hr,
      tStartB: 0,
      tEndB: 0.5,
    },
    {
      id: 'seam_strap_front_right',
      name: 'Front Strap Right Tab to Front Panel',
      pieceA: 'tote_front',
      edgeA: 0,
      pieceB: 'strap_front',
      edgeB: 3,
      reversed: false,
      allowEase: false,
      tStartA: 0.75 - hr,
      tEndA: 0.75 + hr,
      tStartB: 0,
      tEndB: 0.5,
    },
    {
      id: 'seam_strap_back_left',
      name: 'Back Strap Left Tab to Back Panel',
      pieceA: 'tote_back',
      edgeA: 0,
      pieceB: 'strap_back',
      edgeB: 1,
      reversed: true,
      allowEase: false,
      tStartA: 0.25 - hr,
      tEndA: 0.25 + hr,
      tStartB: 0,
      tEndB: 0.5,
    },
    {
      id: 'seam_strap_back_right',
      name: 'Back Strap Right Tab to Back Panel',
      pieceA: 'tote_back',
      edgeA: 0,
      pieceB: 'strap_back',
      edgeB: 3,
      reversed: false,
      allowEase: false,
      tStartA: 0.75 - hr,
      tEndA: 0.75 + hr,
      tStartB: 0,
      tEndB: 0.5,
    },
  ];

  return {
    id: `tote_${Date.now()}`,
    name: 'Structured Gusseted Tote Bag Pattern',
    templateId: 'tote_bag',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'duck_canvas',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [toteFront, toteBack, gussetLeft, gussetRight, gussetBottom, strapFront, strapBack],
    seams,
  };
}

// ============================================================================
// 5. Custom 3D .STL Object Cover (F06-stub — M1 Placeholder + M2 Hook)
// ============================================================================

export function generateSTLCoverPattern(userParams = {}, options = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  options = options && typeof options === 'object' ? options : {};
  const unwrapFn = options.unwrapFn || userParams.unwrapFn || registeredStlCoverGenerator;
  const materialId = typeof userParams.materialId === 'string' && userParams.materialId.length > 0 ? userParams.materialId : 'veg_leather';

  if (typeof unwrapFn === 'function') {
    const result = unwrapFn(userParams, options);
    if (result && typeof result === 'object') {
      if (Array.isArray(result) || !Array.isArray(result.pieces)) {
        throw new ValidationError('stl_cover generator must return an object with a pieces array', {
          code: 'INVALID_PATTERN',
          path: 'stl_cover',
        });
      }
      return {
        version: SCHEMA_VERSION,
        unit: 'mm',
        displayUnit: 'mm',
        ...result,
        templateId: 'stl_cover',
        materialId,
        params: result.params || result.parameters || userParams,
      };
    }
  }

  if (options.requireStl === true || userParams.strictStub === true) {
    throw new Error(
      'stl_cover unwrapping requires M2 stl.mjs (pass options.unwrapFn or register via registerStlCoverGenerator).'
    );
  }

  // Valid M1 4-piece wedge shell placeholder with exact 0.0 mm seams
  const seamAllowance = clamp(finiteParam(userParams.seamAllowance, 10), 0, 100);
  const easeMm = clamp(finiteParam(userParams.easeMm, 2.0), 0, 200);
  const scale = clamp(finiteParam(userParams.scale, 1.0), 0.1, 20);
  const wedgeLengthMm = clamp(finiteParam(userParams.wedgeLengthMm, 152.4), 10, 3000);
  const wedgeWidthMm = clamp(finiteParam(userParams.wedgeWidthMm, 152.4), 10, 3000);
  const wedgeHeightMm = clamp(finiteParam(userParams.wedgeHeightMm, 51.2), 10, 3000);
  const wedgeTipMm = clamp(finiteParam(userParams.wedgeTipMm, 13.5), 1, wedgeHeightMm);
  const L = wedgeLengthMm * scale + easeMm;
  const W = wedgeWidthMm * scale + easeMm;
  const H = wedgeHeightMm * scale + easeMm;
  const tipH = wedgeTipMm * scale + easeMm;
  const slopeLen = Math.hypot(L, H - tipH);

  const p = {
    wedgeLengthMm,
    wedgeWidthMm,
    wedgeHeightMm,
    wedgeTipMm,
    easeMm,
    seamAllowance,
    scale,
  };

  const makeWedgeSide = (id, name, posX, normalX) => ({
    id,
    name,
    role: 'stl_profile',
    quantity: 1,
    onFold: false,
    position: { x: posX, y: 40 },
    rotation: 0,
    seamAllowance,
    points: [
      { x: 0, y: 0 },
      { x: L, y: H - tipH },
      { x: L, y: H },
      { x: 0, y: H },
    ],
    edges: [
      { name: 'Top Slope Seam', seamAllowance },
      { name: 'Front Tip Edge', seamAllowance },
      { name: 'Base Edge', seamAllowance },
      { name: 'Back Wall Seam', seamAllowance },
    ],
    notches: [
      { id: `${id}_top_mid`, edgeIndex: 0, t: 0.5, type: 'single' },
      { id: `${id}_back_mid`, edgeIndex: 3, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: normalX * (W * 0.5), y: H * 0.5, z: 0 },
      normal: { x: normalX, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
  });

  const leftSide = makeWedgeSide('wedge_left_profile', 'Wedge Left Profile', 40, -1);
  const rightSide = makeWedgeSide('wedge_right_profile', 'Wedge Right Profile', 40 + L + 60, 1);

  const backWall = {
    id: 'wedge_back_wall',
    name: 'Wedge Back Wall',
    role: 'stl_gusset',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: H + 120 },
    rotation: 0,
    seamAllowance,
    points: [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    edges: [
      { name: 'Back-to-Top Seam', seamAllowance },
      { name: 'Right Side Seam', seamAllowance },
      { name: 'Base Edge', seamAllowance },
      { name: 'Left Side Seam', seamAllowance },
    ],
    notches: [{ id: 'bw_top', edgeIndex: 0, t: 0.5, type: 'single' }],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 0 },
    placement3D: {
      offset: { x: 0, y: H * 0.5, z: -L * 0.5 },
      normal: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const topSlope = {
    id: 'wedge_top_slope',
    name: 'Wedge Top Slope Cover',
    role: 'stl_top',
    quantity: 1,
    onFold: false,
    position: { x: 40 + W + 60, y: H + 120 },
    rotation: 0,
    seamAllowance,
    points: [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: slopeLen },
      { x: 0, y: slopeLen },
    ],
    edges: [
      { name: 'Back Edge Seam', seamAllowance },
      { name: 'Right Slope Seam', seamAllowance },
      { name: 'Front Tip Edge', seamAllowance },
      { name: 'Left Slope Seam', seamAllowance },
    ],
    notches: [{ id: 'ts_back', edgeIndex: 0, t: 0.5, type: 'single' }],
    darts: [],
    internalLines: [],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 0, y: H, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: -1 },
    },
  };

  const seams = [
    {
      id: 'seam_wedge_left_back',
      name: 'Left Profile to Back Wall',
      pieceA: 'wedge_left_profile',
      edgeA: 3,
      pieceB: 'wedge_back_wall',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_wedge_right_back',
      name: 'Right Profile to Back Wall',
      pieceA: 'wedge_right_profile',
      edgeA: 3,
      pieceB: 'wedge_back_wall',
      edgeB: 1,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_wedge_left_top',
      name: 'Left Profile to Top Slope',
      pieceA: 'wedge_left_profile',
      edgeA: 0,
      pieceB: 'wedge_top_slope',
      edgeB: 3,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_wedge_right_top',
      name: 'Right Profile to Top Slope',
      pieceA: 'wedge_right_profile',
      edgeA: 0,
      pieceB: 'wedge_top_slope',
      edgeB: 1,
      reversed: false,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
    {
      id: 'seam_wedge_back_top',
      name: 'Back Wall to Top Slope',
      pieceA: 'wedge_back_wall',
      edgeA: 0,
      pieceB: 'wedge_top_slope',
      edgeB: 0,
      reversed: true,
      allowEase: false,
      tStartA: 0,
      tEndA: 1,
      tStartB: 0,
      tEndB: 1,
    },
  ];

  return {
    id: `stl_cover_${Date.now()}`,
    name: typeof userParams.stlName === 'string' && userParams.stlName.length > 0 ? userParams.stlName : 'Cutting Mat Wedge Cover (M1 Stub)',
    templateId: 'stl_cover',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId,
    material: null,
    avatar: null,
    stlMetadata: null,
    isStub: true,
    stubReason: 'M2 stl.mjs integration pending',
    params: p,
    parameters: p,
    pieces: [leftSide, rightSide, backWall, topSlope],
    seams,
  };
}

// ============================================================================
// Freeform 2D CAD Piece Creation & Editing Operations (F07, F08, F10, F11, F12)
// ============================================================================

export function createFreeformPiece(nameOrOptions = {}, pointsArg, optionsArg = {}) {
  let name;
  let pointsInput;
  let options;

  if (typeof nameOrOptions === 'string') {
    name = nameOrOptions;
    pointsInput = pointsArg;
    options = optionsArg && typeof optionsArg === 'object' ? optionsArg : {};
  } else {
    options = nameOrOptions && typeof nameOrOptions === 'object' ? nameOrOptions : {};
    name = typeof options.name === 'string' && options.name.trim().length > 0 ? options.name : 'Custom Pattern Piece';
    pointsInput = options.points;
  }

  if (pointsInput !== undefined) {
    if (!Array.isArray(pointsInput) || pointsInput.length < 3) {
      throw new ValidationError('createFreeformPiece requires at least 3 valid points', {
        code: 'INVALID_POINTS',
        path: 'points',
      });
    }
  }

  const rawPoints =
    Array.isArray(pointsInput) && pointsInput.length >= 3
      ? pointsInput
      : [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 250 },
          { x: 0, y: 250 },
        ];

  const coerced = rawPoints.map((pt, idx) => {
    const x = finiteParam(pt?.x, NaN);
    const y = finiteParam(pt?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ValidationError(`Non-finite point at index ${idx}`, {
        code: 'INVALID_POINTS',
        path: `points[${idx}]`,
      });
    }
    return { x, y };
  });

  if (polygonArea(coerced) < 1e-3) {
    throw new ValidationError('createFreeformPiece polygon area is degenerate (< 1e-3 mm²)', {
      code: 'INVALID_POINTS',
      path: 'points',
    });
  }

  const cleanName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'Custom Pattern Piece';
  const nameSlug = cleanName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const id =
    typeof options.id === 'string' && options.id.trim().length > 0
      ? options.id.trim()
      : `${nameSlug || 'piece'}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const sa = Math.max(0, finiteParam(options.seamAllowance, 10));
  const wasReversed = signedPolygonArea(coerced) < 0;
  const ccw = wasReversed ? [...coerced].reverse() : coerced.map((pt) => ({ ...pt }));
  const m = ccw.length;
  const bounds = polygonBounds(ccw);
  if (
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    throw new ValidationError('Freeform piece coordinate span overflows finite bounds.', {
      code: 'INVALID_POINTS',
      path: 'points',
    });
  }
  const shiftPt = (pt) => {
    const x = pt.x - bounds.minX;
    const y = pt.y - bounds.minY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ValidationError('Freeform piece shifted coordinate overflows finite range.', {
        code: 'INVALID_POINTS',
        path: 'points',
      });
    }
    return { x, y };
  };
  const normalizedPoints = ccw.map(shiftPt);

  const remapEdgeIdx = (rawIdx) => {
    const e = ((Math.trunc(finiteParam(rawIdx, 0)) % m) + m) % m;
    return wasReversed ? (m - 2 - e + m) % m : e;
  };

  let edges;
  if (Array.isArray(options.edges) && options.edges.length === m) {
    edges = new Array(m);
    for (let i = 0; i < m; i++) {
      const e = options.edges[i];
      const targetIdx = wasReversed ? (m - 2 - i + m) % m : i;
      const edgeSa =
        e?.seamAllowance !== undefined && e?.seamAllowance !== null
          ? Math.max(0, finiteParam(e.seamAllowance, sa))
          : sa;
      const edgeObj = {
        name: typeof e?.name === 'string' && e.name.trim().length > 0 ? e.name : `Edge ${targetIdx + 1}`,
        seamAllowance: edgeSa,
      };
      if (e?.curve && typeof e.curve === 'object') {
        const sanitizeCurvePt = (pt) => {
          if (!pt || typeof pt !== 'object') return null;
          const x = finiteParam(pt.x, NaN);
          const y = finiteParam(pt.y, NaN);
          return Number.isFinite(x) && Number.isFinite(y) ? shiftPt({ x, y }) : null;
        };
        const cp1 = sanitizeCurvePt(e.curve.cp1);
        const cp2 = sanitizeCurvePt(e.curve.cp2);
        if (cp1 && cp2) {
          edgeObj.curve = wasReversed ? { cp1: cp2, cp2: cp1 } : { cp1, cp2 };
        } else {
          const cp = sanitizeCurvePt(e.curve.cp);
          if (cp) {
            edgeObj.curve = { cp };
          }
        }
      }
      edges[targetIdx] = edgeObj;
    }
  } else {
    edges = normalizedPoints.map((_, i) => ({
      name: `Edge ${i + 1}`,
      seamAllowance: sa,
    }));
  }

  const notches = Array.isArray(options.notches)
    ? options.notches
        .filter((n) => n && typeof n === 'object')
        .map((n) => {
          const nt = clamp(finiteParam(n.t, 0.5), 0, 1);
          const out = {
            ...n,
            edgeIndex: remapEdgeIdx(n.edgeIndex),
            t: wasReversed ? 1 - nt : nt,
          };
          if (n.depthMm !== undefined) {
            const nd = finiteParam(n.depthMm, 5);
            out.depthMm = nd > 0 ? nd : 5;
          }
          if (n.type !== undefined && !['single', 'double', 'v', 't'].includes(n.type)) {
            out.type = 'single';
          }
          return out;
        })
    : [];

  const darts = Array.isArray(options.darts)
    ? options.darts
        .filter((d) => d && typeof d === 'object')
        .map((d) => {
          const dt = clamp(finiteParam(d.t, 0.5), 0.01, 0.99);
          const dw = finiteParam(d.widthMm, 20);
          const dd = finiteParam(d.depthMm, 80);
          return {
            ...d,
            edgeIndex: remapEdgeIdx(d.edgeIndex),
            t: wasReversed ? 1 - dt : dt,
            widthMm: dw > 0 ? dw : 20,
            depthMm: dd > 0 ? dd : 80,
            folded: parseBoolFlag(d.folded ?? false),
          };
        })
    : [];

  return {
    id,
    name: cleanName,
    role: typeof options.role === 'string' && options.role.trim().length > 0 ? options.role.trim() : 'custom',
    quantity: Math.max(1, Math.trunc(finiteParam(options.quantity, 1))),
    onFold: parseBoolFlag(options.onFold ?? false),
    ...(options.grainLock !== undefined ? { grainLock: parseBoolFlag(options.grainLock) } : {}),
    ...(options.rotationOrigin &&
    typeof options.rotationOrigin === 'object' &&
    Number.isFinite(finiteParam(options.rotationOrigin.x, NaN)) &&
    Number.isFinite(finiteParam(options.rotationOrigin.y, NaN))
      ? {
          rotationOrigin: shiftPt({
            x: finiteParam(options.rotationOrigin.x, 0),
            y: finiteParam(options.rotationOrigin.y, 0),
          }),
        }
      : {}),
    position:
      options.position && typeof options.position === 'object'
        ? {
            x: finiteParam(options.position.x, 0),
            y: finiteParam(options.position.y, 0),
          }
        : { x: bounds.minX || 60, y: bounds.minY || 60 },
    rotation: finiteParam(options.rotation, 0),
    seamAllowance: sa,
    points: normalizedPoints,
    edges,
    notches,
    darts,
    internalLines: Array.isArray(options.internalLines)
      ? options.internalLines
          .filter((il) => il && typeof il === 'object')
          .map((il) => ({
            ...il,
            points: Array.isArray(il.points)
              ? il.points
                  .filter(
                    (pt) =>
                      pt &&
                      typeof pt === 'object' &&
                      Number.isFinite(finiteParam(pt.x, NaN)) &&
                      Number.isFinite(finiteParam(pt.y, NaN))
                  )
                  .map((pt) => shiftPt({ x: finiteParam(pt.x, 0), y: finiteParam(pt.y, 0) }))
              : [],
          }))
          .filter((il) => il.points.length >= 2)
      : [],
    grainline: (() => {
      if (!options.grainline || typeof options.grainline !== 'object') {
        return { angleDeg: 90 };
      }
      const rawG = options.grainline;
      const startX = rawG.start && typeof rawG.start === 'object' ? finiteParam(rawG.start.x, NaN) : NaN;
      const startY = rawG.start && typeof rawG.start === 'object' ? finiteParam(rawG.start.y, NaN) : NaN;
      const endX = rawG.end && typeof rawG.end === 'object' ? finiteParam(rawG.end.x, NaN) : NaN;
      const endY = rawG.end && typeof rawG.end === 'object' ? finiteParam(rawG.end.y, NaN) : NaN;
      const hasValidStart = Number.isFinite(startX) && Number.isFinite(startY);
      const hasValidEnd = Number.isFinite(endX) && Number.isFinite(endY);

      const g = {};
      if (hasValidStart && hasValidEnd) {
        g.start = shiftPt({ x: startX, y: startY });
        g.end = shiftPt({ x: endX, y: endY });
      }
      const rawAngle = finiteParam(rawG.angleDeg, NaN);
      if (Number.isFinite(rawAngle)) {
        g.angleDeg = rawAngle;
      } else if (g.start && g.end) {
        g.angleDeg = (Math.atan2(g.end.y - g.start.y, g.end.x - g.start.x) * 180) / Math.PI;
      } else {
        g.angleDeg = 90;
      }
      return g;
    })(),
    placement3D: (() => {
      const defaultOffset = { x: 0, y: 120, z: 140 };
      const defaultNormal = { x: 0, y: 0, z: 1 };
      const defaultUp = { x: 0, y: 1, z: 0 };
      const raw = options.placement3D;
      if (!raw || typeof raw !== 'object') {
        return { offset: defaultOffset, normal: defaultNormal, up: defaultUp };
      }
      const sanitizeVec3 = (v, fb) => {
        if (!v || typeof v !== 'object') return { ...fb };
        return {
          x: finiteParam(v.x, fb.x),
          y: finiteParam(v.y, fb.y),
          z: finiteParam(v.z, fb.z),
        };
      };
      const offset = sanitizeVec3(raw.offset, defaultOffset);
      let normal = sanitizeVec3(raw.normal, defaultNormal);
      if (Math.hypot(normal.x, normal.y, normal.z) <= 1e-9) {
        normal = { ...defaultNormal };
      }
      const out = { offset, normal };
      if (raw.up !== undefined) {
        if (raw.up && typeof raw.up === 'object') {
          const ux = finiteParam(raw.up.x, NaN);
          const uy = finiteParam(raw.up.y, NaN);
          const uz = finiteParam(raw.up.z, NaN);
          if (Number.isFinite(ux) && Number.isFinite(uy) && Number.isFinite(uz) && Math.hypot(ux, uy, uz) > 1e-9) {
            out.up = { x: ux, y: uy, z: uz };
          }
        }
      } else {
        out.up = defaultUp;
      }
      return out;
    })(),
  };
}

export function createRectanglePiece(nameOrOptions = 'Rectangle Piece', widthMmArg, heightMmArg, optionsArg = {}) {
  let name;
  let widthMm;
  let heightMm;
  let options;

  if (typeof nameOrOptions === 'string') {
    name = nameOrOptions;
    widthMm = finiteParam(widthMmArg, NaN);
    heightMm = finiteParam(heightMmArg, NaN);
    options = optionsArg && typeof optionsArg === 'object' ? optionsArg : {};
  } else {
    options = nameOrOptions && typeof nameOrOptions === 'object' ? nameOrOptions : {};
    name = typeof options.name === 'string' && options.name.trim().length > 0 ? options.name : 'Rectangle Piece';
    widthMm = finiteParam(options.widthMm ?? options.width, NaN);
    heightMm = finiteParam(options.heightMm ?? options.height, NaN);
  }

  if (
    !Number.isFinite(widthMm) ||
    widthMm <= 0 ||
    widthMm > MAX_PIECE_DIMENSION_MM ||
    !Number.isFinite(heightMm) ||
    heightMm <= 0 ||
    heightMm > MAX_PIECE_DIMENSION_MM
  ) {
    throw new ValidationError(
      `createRectanglePiece requires positive finite widthMm and heightMm <= ${MAX_PIECE_DIMENSION_MM} (got ${widthMm}, ${heightMm})`,
      {
        code: 'INVALID_DIMENSIONS',
        path: 'widthMm/heightMm',
      }
    );
  }

  const sa = Math.max(0, finiteParam(options.seamAllowance, 10));
  const onFold = parseBoolFlag(options.onFold ?? false);
  const foldEdgeIndex = onFold
    ? ((Math.trunc(finiteParam(options.foldEdgeIndex, 3)) % 4) + 4) % 4
    : -1;
  const edgeNames = ['Top Edge', 'Right Edge', 'Bottom Edge', 'Left Edge'];
  const edges = edgeNames.map((ename, i) => ({
    name: ename,
    seamAllowance: i === foldEdgeIndex ? 0 : sa,
  }));

  const internalLines = Array.isArray(options.internalLines) ? [...options.internalLines] : [];
  if (onFold) {
    const pts = [
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: heightMm },
      { x: 0, y: heightMm },
    ];
    internalLines.push({
      id: `fold_${Date.now()}`,
      name: 'Cut-on-Fold Edge',
      type: 'fold',
      points: [pts[foldEdgeIndex], pts[(foldEdgeIndex + 1) % 4]],
    });
  }

  return createFreeformPiece(
    name,
    [
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: heightMm },
      { x: 0, y: heightMm },
    ],
    {
      ...options,
      seamAllowance: sa,
      edges,
      internalLines,
      position:
        options.position && typeof options.position === 'object'
          ? options.position
          : { x: 40, y: 40 },
    }
  );
}

export function addDartToPiece(piece, opts = {}) {
  const { edgeIndex = 0, t = 0.5, widthMm = 20, depthMm = 80, folded = false } = opts || {};
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3) return piece;
  if (!allFinitePoints2D(piece.points)) {
    throw new ValidationError('Piece points must contain valid finite {x, y} coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  if (Array.isArray(piece.edges) && hasSparseHoles(piece.edges)) {
    throw new ValidationError('Piece edges must not contain sparse holes', {
      code: 'INVALID_EDGES',
      path: 'piece.edges',
    });
  }
  const n = piece.points.length;
  const safeEdge = ((Math.trunc(finiteParam(edgeIndex, 0)) % n) + n) % n;
  const p0 = piece.points[safeEdge];
  const p1 = piece.points[(safeEdge + 1) % n];
  const edgeMeta = Array.isArray(piece.edges) ? piece.edges[safeEdge] : null;
  const curve = edgeMeta && typeof edgeMeta === 'object' ? edgeMeta.curve || null : null;
  const edgeLen = Math.max(1, edgeArcLength(p0, p1, curve));

  const rawWidth = finiteParam(widthMm, 20);
  const rawDepth = finiteParam(depthMm, 80);
  const safeWidth = Math.max(2, Math.min(rawWidth > 0 ? rawWidth : 20, edgeLen * 0.9));
  const safeDepth = Math.max(5, rawDepth > 0 ? rawDepth : 80);
  const halfT = (safeWidth * 0.5) / edgeLen;
  const minT = Math.min(0.45, halfT + 0.02);
  const maxT = Math.max(0.55, 1 - halfT - 0.02);
  const clampedT = clamp(finiteParam(t, 0.5), minT, maxT);

  const existingDarts = Array.isArray(piece.darts) ? piece.darts : [];
  const dart = {
    id: `dart_${Date.now()}_${existingDarts.length + 1}`,
    edgeIndex: safeEdge,
    t: clampedT,
    widthMm: safeWidth,
    depthMm: safeDepth,
    folded: parseBoolFlag(folded),
  };
  piece.darts = [...existingDarts, dart];
  return piece;
}

export function toggleDartFold(piece, dartIdOrIndex = 0, folded) {
  if (!piece || !Array.isArray(piece.darts) || piece.darts.length === 0) return piece;
  let target = null;
  if (typeof dartIdOrIndex === 'string') {
    target = piece.darts.find((d) => d && typeof d === 'object' && d.id === dartIdOrIndex) || null;
  } else if (Number.isInteger(dartIdOrIndex)) {
    const idx = ((dartIdOrIndex % piece.darts.length) + piece.darts.length) % piece.darts.length;
    const cand = piece.darts[idx];
    target = cand && typeof cand === 'object' ? cand : null;
  }
  if (target) {
    target.folded = folded !== undefined ? parseBoolFlag(folded) : !parseBoolFlag(target.folded);
  }
  return piece;
}

export function addNotchToPiece(piece, opts = {}) {
  const { edgeIndex = 0, t = 0.5, type = 'single', depthMm = 5 } = opts || {};
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3) return piece;
  if (!allFinitePoints2D(piece.points)) {
    throw new ValidationError('Piece points must contain valid finite {x, y} coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  if (Array.isArray(piece.edges) && hasSparseHoles(piece.edges)) {
    throw new ValidationError('Piece edges must not contain sparse holes', {
      code: 'INVALID_EDGES',
      path: 'piece.edges',
    });
  }
  const n = piece.points.length;
  const safeEdge = ((Math.trunc(finiteParam(edgeIndex, 0)) % n) + n) % n;
  const rawDepth = finiteParam(depthMm, 5);
  const existingNotches = Array.isArray(piece.notches) ? piece.notches : [];
  const notch = {
    id: `notch_${Date.now()}_${existingNotches.length + 1}`,
    edgeIndex: safeEdge,
    t: clamp(finiteParam(t, 0.5), 0.01, 0.99),
    type: ['single', 'double', 'v', 't'].includes(type) ? type : 'single',
    depthMm: Math.max(1, rawDepth > 0 ? rawDepth : 5),
  };
  piece.notches = [...existingNotches, notch];
  return piece;
}

export function splitPieceEdge(piece, edgeIndex = 0, t = 0.5, pattern = null) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3) return piece;
  if (!allFinitePoints2D(piece.points)) {
    throw new ValidationError('Piece points must contain valid finite {x, y} coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  if (Array.isArray(piece.edges) && hasSparseHoles(piece.edges)) {
    throw new ValidationError('Piece edges must not contain sparse holes', {
      code: 'INVALID_EDGES',
      path: 'piece.edges',
    });
  }
  const n = piece.points.length;
  const idx = ((Math.trunc(finiteParam(edgeIndex, 0)) % n) + n) % n;
  const p0 = piece.points[idx];
  const p1 = piece.points[(idx + 1) % n];
  const edgeMeta = Array.isArray(piece.edges) ? piece.edges[idx] : null;
  const curve = edgeMeta && typeof edgeMeta === 'object' ? edgeMeta.curve || null : null;
  const clampedT = clamp(finiteParam(t, 0.5), 0.05, 0.95);
  const origLut = pattern && Array.isArray(pattern.seams) ? buildEdgeArcTable(p0, p1, curve, 64) : null;

  const { mid: midPt, curveA, curveB } = splitEdgeCurve(p0, p1, curve, clampedT);
  const isFinitePt = (pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
  const hasFiniteCurve = (c) => {
    if (!c) return true;
    if (c.cp && !isFinitePt(c.cp)) return false;
    if (c.cp1 && !isFinitePt(c.cp1)) return false;
    if (c.cp2 && !isFinitePt(c.cp2)) return false;
    return true;
  };
  if (!isFinitePt(midPt) || !hasFiniteCurve(curveA) || !hasFiniteCurve(curveB)) {
    throw new ValidationError('splitPieceEdge produced non-finite split coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }

  const normalizedEdges = Array.from({ length: n }, (_, i) => {
    const raw = Array.isArray(piece.edges) ? piece.edges[i] : null;
    return raw && typeof raw === 'object'
      ? { ...raw }
      : { name: `Edge ${i + 1}`, seamAllowance: piece.seamAllowance ?? 10 };
  });
  const origEdge = normalizedEdges[idx];
  const edgeAObj = { name: `${safeStr(origEdge.name || `Edge ${idx + 1}`)} (A)`, seamAllowance: origEdge.seamAllowance };
  const edgeBObj = { name: `${safeStr(origEdge.name || `Edge ${idx + 1}`)} (B)`, seamAllowance: origEdge.seamAllowance };
  if (curveA) edgeAObj.curve = curveA;
  if (curveB) edgeBObj.curve = curveB;
  normalizedEdges.splice(idx, 1, edgeAObj, edgeBObj);
  piece.points.splice(idx + 1, 0, midPt);
  piece.edges = normalizedEdges;

  for (const notch of Array.isArray(piece.notches) ? piece.notches : []) {
    if (!notch || typeof notch !== 'object' || !Number.isInteger(notch.edgeIndex)) continue;
    if (notch.edgeIndex === idx) {
      const nt = finiteParam(notch.t, 0.5);
      if (nt <= clampedT) {
        notch.t = clamp(nt / clampedT, 0.01, 0.99);
      } else {
        notch.edgeIndex = idx + 1;
        notch.t = clamp((nt - clampedT) / (1 - clampedT), 0.01, 0.99);
      }
    } else if (notch.edgeIndex > idx) {
      notch.edgeIndex += 1;
    }
  }

  for (const dart of Array.isArray(piece.darts) ? piece.darts : []) {
    if (!dart || typeof dart !== 'object' || !Number.isInteger(dart.edgeIndex)) continue;
    if (dart.edgeIndex === idx) {
      const dt = finiteParam(dart.t, 0.5);
      if (dt <= clampedT) {
        dart.t = clamp(dt / clampedT, 0.05, 0.95);
      } else {
        dart.edgeIndex = idx + 1;
        dart.t = clamp((dt - clampedT) / (1 - clampedT), 0.05, 0.95);
      }
    } else if (dart.edgeIndex > idx) {
      dart.edgeIndex += 1;
    }
  }

  if (pattern && Array.isArray(pattern.seams)) {
    const pieceMap = new Map(
      (Array.isArray(pattern.pieces) ? pattern.pieces : [])
        .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
        .map((p) => [p.id, p])
    );
    const computeOppSplitT = (oppPieceId, oppEdgeIdx, bs, be, arcFrac, reversed) => {
      const linearSplit = () => (reversed ? be - (be - bs) * arcFrac : bs + (be - bs) * arcFrac);
      if (!Number.isInteger(oppEdgeIdx)) {
        return linearSplit();
      }
      const opp = pieceMap.get(oppPieceId);
      if (opp && Array.isArray(opp.points) && opp.points.length >= 3) {
        const m = opp.points.length;
        const e = ((oppEdgeIdx % m) + m) % m;
        const oppLut = buildEdgeArcTable(
          opp.points[e],
          opp.points[(e + 1) % m],
          opp.edges?.[e]?.curve || null,
          64,
          bs,
          be
        );
        if (
          !Number.isFinite(oppLut.totalLen) ||
          oppLut.totalLen <= 1e-9 ||
          !oppLut.cumLen.every(Number.isFinite)
        ) {
          return linearSplit();
        }
        const oppHasDarts = (Array.isArray(opp.darts) ? opp.darts : []).some(
          (d) => d && typeof d === 'object' && d.edgeIndex === e && finiteParam(d.widthMm, 0) > 0
        );
        if (oppHasDarts) {
          const totalNet = computeSubEdgeLength(opp, e, bs, be);
          if (!Number.isFinite(totalNet) || totalNet <= 1e-6) {
            return linearSplit();
          }
          const targetNet = reversed ? totalNet * (1 - arcFrac) : totalNet * arcFrac;
          let lo = bs;
          let hi = be;
          for (let iter = 0; iter < 28; iter++) {
            const mid = (lo + hi) * 0.5;
            if (computeSubEdgeLength(opp, e, bs, mid) < targetNet) lo = mid;
            else hi = mid;
          }
          const pad = Math.min(1e-4, Math.max(0, (be - bs) * 0.01));
          return clamp((lo + hi) * 0.5, bs + pad, be - pad);
        }
        const targetDist = reversed ? oppLut.totalLen * (1 - arcFrac) : oppLut.totalLen * arcFrac;
        const rawT = tAtArcLength(oppLut, targetDist);
        if (!Number.isFinite(rawT) || (be > bs && (rawT <= bs || rawT >= be))) {
          return linearSplit();
        }
        return rawT;
      }
      return linearSplit();
    };

    const arcFractionForRange = (ts, te) => {
      const tsA = clamp(ts / clampedT, 0, 1);
      const teB = clamp((te - clampedT) / (1 - clampedT), 0, 1);
      const lenSubA = computeSubEdgeLength(piece, idx, tsA, 1);
      const lenSubB = computeSubEdgeLength(piece, idx + 1, 0, teB);
      const total = lenSubA + lenSubB;
      if (Number.isFinite(total) && total > 1e-6) {
        return clamp(lenSubA / total, 0.01, 0.99);
      }
      if (origLut) {
        const s0 = arcLengthAtT(origLut, ts);
        const sSplit = arcLengthAtT(origLut, clampedT);
        const s1 = arcLengthAtT(origLut, te);
        const span = s1 - s0;
        if (Number.isFinite(sSplit - s0) && Number.isFinite(span) && span > 1e-6) {
          return clamp((sSplit - s0) / span, 0.01, 0.99);
        }
      }
      const paramSpan = Math.max(1e-6, te - ts);
      const fallback = clamp((clampedT - ts) / paramSpan, 0.01, 0.99);
      return Number.isFinite(fallback) ? fallback : 0.5;
    };

    const remapNonStraddling = (ts, te) => {
      const s = clamp(finiteParam(ts, 0), 0, 1);
      const e = clamp(finiteParam(te, 1), s, 1);
      const leftSpan = Math.max(0, Math.min(e, clampedT) - s);
      const rightSpan = Math.max(0, e - Math.max(s, clampedT));
      if (rightSpan === 0 || leftSpan > rightSpan || (leftSpan === rightSpan && e <= clampedT)) {
        return {
          edge: idx,
          ts: clamp(s / clampedT, 0, 1),
          te: clamp(e / clampedT, 0, 1),
        };
      }
      return {
        edge: idx + 1,
        ts: clamp((s - clampedT) / (1 - clampedT), 0, 1),
        te: clamp((e - clampedT) / (1 - clampedT), 0, 1),
      };
    };
    const isStraddling = (ts, te) => {
      const s = clamp(finiteParam(ts, 0), 0, 1);
      const e = clamp(finiteParam(te, 1), s, 1);
      const leftSpan = Math.max(0, Math.min(e, clampedT) - s);
      const rightSpan = Math.max(0, e - Math.max(s, clampedT));
      return leftSpan > 1e-6 && rightSpan > 1e-6;
    };

    const usedSeamIds = new Set();
    for (const s of pattern.seams) {
      if (s && typeof s === 'object' && typeof s.id === 'string' && s.id.length > 0) {
        usedSeamIds.add(s.id);
      }
    }
    const allocSplitSeamId = (rawId, suffix) => {
      const base = safeStr(rawId);
      let cand = `${base}_${suffix}`;
      if (!usedSeamIds.has(cand)) {
        usedSeamIds.add(cand);
        return cand;
      }
      let k = 2;
      while (usedSeamIds.has(`${base}_${suffix}_${k}`)) {
        k += 1;
      }
      cand = `${base}_${suffix}_${k}`;
      usedSeamIds.add(cand);
      return cand;
    };

    const splitEndA = (seam) => {
      const ts = clamp(finiteParam(seam.tStartA, 0), 0, 1);
      const te = clamp(finiteParam(seam.tEndA, 1), ts, 1);
      if (!isStraddling(ts, te)) {
        const mapped = remapNonStraddling(ts, te);
        seam.edgeA = mapped.edge;
        seam.tStartA = mapped.ts;
        seam.tEndA = mapped.te;
        return [seam];
      }
      const arcFrac = arcFractionForRange(ts, te);
      const bs = clamp(finiteParam(seam.tStartB, 0), 0, 1);
      const be = clamp(finiteParam(seam.tEndB, 1), bs, 1);
      const isReversed = parseBoolFlag(seam.reversed);
      const splitB = seam.internalLineIdB
        ? isReversed
          ? be - (be - bs) * arcFrac
          : bs + (be - bs) * arcFrac
        : computeOppSplitT(seam.pieceB, seam.edgeB, bs, be, arcFrac, isReversed);
      const idA = allocSplitSeamId(seam.id, 'a');
      const idB = allocSplitSeamId(seam.id, 'b');
      return [
        {
          ...seam,
          id: idA,
          edgeA: idx,
          tStartA: ts / clampedT,
          tEndA: 1,
          tStartB: isReversed ? splitB : bs,
          tEndB: isReversed ? be : splitB,
        },
        {
          ...seam,
          id: idB,
          edgeA: idx + 1,
          tStartA: 0,
          tEndA: (te - clampedT) / (1 - clampedT),
          tStartB: isReversed ? bs : splitB,
          tEndB: isReversed ? splitB : be,
        },
      ];
    };

    const splitEndB = (seam) => {
      const ts = clamp(finiteParam(seam.tStartB, 0), 0, 1);
      const te = clamp(finiteParam(seam.tEndB, 1), ts, 1);
      if (!isStraddling(ts, te)) {
        const mapped = remapNonStraddling(ts, te);
        seam.edgeB = mapped.edge;
        seam.tStartB = mapped.ts;
        seam.tEndB = mapped.te;
        return [seam];
      }
      const arcFrac = arcFractionForRange(ts, te);
      const as = clamp(finiteParam(seam.tStartA, 0), 0, 1);
      const ae = clamp(finiteParam(seam.tEndA, 1), as, 1);
      const isReversed = parseBoolFlag(seam.reversed);
      const splitA = computeOppSplitT(seam.pieceA, seam.edgeA, as, ae, arcFrac, isReversed);
      const idA = allocSplitSeamId(seam.id, 'a');
      const idB = allocSplitSeamId(seam.id, 'b');
      return [
        {
          ...seam,
          id: idA,
          edgeB: idx,
          tStartB: ts / clampedT,
          tEndB: 1,
          tStartA: isReversed ? splitA : as,
          tEndA: isReversed ? ae : splitA,
        },
        {
          ...seam,
          id: idB,
          edgeB: idx + 1,
          tStartB: 0,
          tEndB: (te - clampedT) / (1 - clampedT),
          tStartA: isReversed ? as : splitA,
          tEndA: isReversed ? splitA : ae,
        },
      ];
    };

    const updatedSeams = [];
    for (const seam of pattern.seams) {
      if (!seam || typeof seam !== 'object') continue;
      const matchA = seam.pieceA === piece.id && seam.edgeA === idx;
      const matchB = seam.pieceB === piece.id && !seam.internalLineIdB && seam.edgeB === idx;

      if (seam.pieceA === piece.id && Number.isInteger(seam.edgeA) && seam.edgeA > idx) seam.edgeA += 1;
      if (seam.pieceB === piece.id && !seam.internalLineIdB && Number.isInteger(seam.edgeB) && seam.edgeB > idx) seam.edgeB += 1;

      if (matchA && matchB) {
        const tsA = clamp(finiteParam(seam.tStartA, 0), 0, 1);
        const teA = clamp(finiteParam(seam.tEndA, 1), tsA, 1);
        const tsB = clamp(finiteParam(seam.tStartB, 0), 0, 1);
        const teB = clamp(finiteParam(seam.tEndB, 1), tsB, 1);
        if (isStraddling(tsA, teA) && !isStraddling(tsB, teB)) {
          const mappedB = remapNonStraddling(tsB, teB);
          seam.edgeB = mappedB.edge;
          seam.tStartB = mappedB.ts;
          seam.tEndB = mappedB.te;
          updatedSeams.push(...splitEndA(seam));
        } else if (isStraddling(tsB, teB) && !isStraddling(tsA, teA)) {
          const mappedA = remapNonStraddling(tsA, teA);
          seam.edgeA = mappedA.edge;
          seam.tStartA = mappedA.ts;
          seam.tEndA = mappedA.te;
          updatedSeams.push(...splitEndB(seam));
        } else {
          const mappedA = remapNonStraddling(tsA, teA);
          const mappedB = remapNonStraddling(tsB, teB);
          seam.edgeA = mappedA.edge;
          seam.tStartA = mappedA.ts;
          seam.tEndA = mappedA.te;
          seam.edgeB = mappedB.edge;
          seam.tStartB = mappedB.ts;
          seam.tEndB = mappedB.te;
          updatedSeams.push(seam);
        }
      } else if (matchA) {
        updatedSeams.push(...splitEndA(seam));
      } else if (matchB) {
        updatedSeams.push(...splitEndB(seam));
      } else {
        updatedSeams.push(seam);
      }
    }
    pattern.seams = updatedSeams;
  }

  return piece;
}

export function deletePieceVertex(piece, vertexIndex, pattern = null) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length <= 3) {
    throw new ValidationError('Polygon must retain at least 3 vertices', {
      code: 'MIN_VERTICES',
      path: 'piece.points',
    });
  }
  if (!allFinitePoints2D(piece.points)) {
    throw new ValidationError('Piece points must contain valid finite {x, y} coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  if (Array.isArray(piece.edges) && hasSparseHoles(piece.edges)) {
    throw new ValidationError('Piece edges must not contain sparse holes', {
      code: 'INVALID_EDGES',
      path: 'piece.edges',
    });
  }

  const n = piece.points.length;
  const vIdx = ((Math.trunc(finiteParam(vertexIndex, 0)) % n) + n) % n;
  const candidatePts = piece.points.filter((_, i) => i !== vIdx);
  if (Math.abs(signedPolygonArea(candidatePts)) < 1e-4) {
    throw new ValidationError('Deleting vertex would collapse polygon to zero area', {
      code: 'DEGENERATE_POLYGON',
      path: 'piece.points',
    });
  }
  const prevEdgeIdx = (vIdx - 1 + n) % n;
  const currEdgeIdx = vIdx;

  const normalizedEdges = Array.from({ length: n }, (_, i) => {
    const raw = Array.isArray(piece.edges) ? piece.edges[i] : null;
    return raw && typeof raw === 'object'
      ? { ...raw }
      : { name: `Edge ${i + 1}`, seamAllowance: piece.seamAllowance ?? 10 };
  });
  normalizedEdges.splice(vIdx, 1);
  const newN = candidatePts.length;
  const mergedEdgeIdx = (vIdx - 1 + newN) % newN;
  if (normalizedEdges[mergedEdgeIdx]) {
    delete normalizedEdges[mergedEdgeIdx].curve;
  }

  if (
    polygonSelfIntersects(candidatePts) ||
    polygonSelfIntersects(samplePieceOutline({ points: candidatePts, edges: normalizedEdges }, 16))
  ) {
    throw new ValidationError('Deleting vertex produces a self-intersecting polygon', {
      code: 'SELF_INTERSECTING_POLYGON',
      path: 'piece.points',
    });
  }

  piece.points = candidatePts;
  piece.edges = normalizedEdges;

  const remapEdgeItems = (items) => {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      if (!Number.isInteger(item.edgeIndex)) {
        out.push(item);
        continue;
      }
      if (item.edgeIndex === prevEdgeIdx || item.edgeIndex === currEdgeIdx) continue;
      if (item.edgeIndex > vIdx) {
        out.push({ ...item, edgeIndex: item.edgeIndex - 1 });
      } else {
        out.push(item);
      }
    }
    return out;
  };

  piece.notches = remapEdgeItems(piece.notches);
  piece.darts = remapEdgeItems(piece.darts);

  if (pattern && Array.isArray(pattern.seams)) {
    const kept = [];
    for (const seam of pattern.seams) {
      if (!seam || typeof seam !== 'object') continue;
      const dropA = seam.pieceA === piece.id && (seam.edgeA === prevEdgeIdx || seam.edgeA === currEdgeIdx);
      const dropB =
        seam.pieceB === piece.id &&
        !seam.internalLineIdB &&
        (seam.edgeB === prevEdgeIdx || seam.edgeB === currEdgeIdx);
      if (dropA || dropB) continue;

      if (seam.pieceA === piece.id && Number.isInteger(seam.edgeA) && seam.edgeA > vIdx) seam.edgeA -= 1;
      if (seam.pieceB === piece.id && !seam.internalLineIdB && Number.isInteger(seam.edgeB) && seam.edgeB > vIdx) seam.edgeB -= 1;
      kept.push(seam);
    }
    pattern.seams = kept;
  }

  if (signedPolygonArea(piece.points) < 0) {
    const m = piece.points.length;
    piece.points.reverse();
    if (Array.isArray(piece.edges) && piece.edges.length === m) {
      const remappedEdges = new Array(m);
      for (let e = 0; e < m; e++) {
        const rawE = piece.edges[e];
        const edgeCopy = rawE && typeof rawE === 'object' ? { ...rawE } : {};
        if (edgeCopy.curve?.cp1 && edgeCopy.curve?.cp2) {
          edgeCopy.curve = { cp1: { ...edgeCopy.curve.cp2 }, cp2: { ...edgeCopy.curve.cp1 } };
        } else if (edgeCopy.curve?.cp) {
          edgeCopy.curve = { cp: { ...edgeCopy.curve.cp } };
        }
        remappedEdges[(m - 2 - e + m) % m] = edgeCopy;
      }
      piece.edges = remappedEdges;
    }
    piece.notches = (Array.isArray(piece.notches) ? piece.notches : [])
      .filter((ni) => ni && typeof ni === 'object')
      .map((ni) => ({
        ...ni,
        edgeIndex: Number.isInteger(ni.edgeIndex) ? (m - 2 - ni.edgeIndex + m) % m : ni.edgeIndex,
        t: 1 - finiteParam(ni.t, 0.5),
      }));
    piece.darts = (Array.isArray(piece.darts) ? piece.darts : [])
      .filter((di) => di && typeof di === 'object')
      .map((di) => ({
        ...di,
        edgeIndex: Number.isInteger(di.edgeIndex) ? (m - 2 - di.edgeIndex + m) % m : di.edgeIndex,
        t: 1 - finiteParam(di.t, 0.5),
      }));
    if (pattern && Array.isArray(pattern.seams)) {
      for (const seam of pattern.seams) {
        if (!seam || typeof seam !== 'object') continue;
        if (seam.pieceA === piece.id && Number.isInteger(seam.edgeA)) {
          seam.edgeA = (m - 2 - seam.edgeA + m) % m;
          const ts = finiteParam(seam.tStartA, 0);
          const te = finiteParam(seam.tEndA, 1);
          seam.tStartA = 1 - te;
          seam.tEndA = 1 - ts;
          seam.reversed = !parseBoolFlag(seam.reversed);
        }
        if (seam.pieceB === piece.id && !seam.internalLineIdB && Number.isInteger(seam.edgeB)) {
          seam.edgeB = (m - 2 - seam.edgeB + m) % m;
          const ts = finiteParam(seam.tStartB, 0);
          const te = finiteParam(seam.tEndB, 1);
          seam.tStartB = 1 - te;
          seam.tEndB = 1 - ts;
          seam.reversed = !parseBoolFlag(seam.reversed);
        }
      }
    }
  }

  return piece;
}

export function mirrorPieceAcrossEdge(piece, edgeIndex = 0, pattern = null) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3) return piece;
  if (!allFinitePoints2D(piece.points)) {
    throw new ValidationError('Piece points must contain valid finite {x, y} coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  if (Array.isArray(piece.edges) && hasSparseHoles(piece.edges)) {
    throw new ValidationError('Piece edges must not contain sparse holes', {
      code: 'INVALID_EDGES',
      path: 'piece.edges',
    });
  }
  const pts = piece.points;
  const n = pts.length;
  const idx = ((Math.trunc(finiteParam(edgeIndex, 0)) % n) + n) % n;
  const axisEdge = Array.isArray(piece.edges) ? piece.edges[idx] : null;
  if (axisEdge?.curve && (axisEdge.curve.cp || (axisEdge.curve.cp1 && axisEdge.curve.cp2))) {
    throw new ValidationError('Cannot mirror across a curved edge axis', {
      code: 'CURVED_MIRROR_AXIS',
      path: `edges[${idx}].curve`,
    });
  }
  const a = pts[idx];
  const b = pts[(idx + 1) % n];

  if (dist2D(a, b) < 1e-3) {
    throw new ValidationError('Cannot mirror across degenerate zero-length edge', {
      code: 'DEGENERATE_EDGE',
      path: `edges[${idx}]`,
    });
  }

  const halfDx = b.x * 0.5 - a.x * 0.5;
  const halfDy = b.y * 0.5 - a.y * 0.5;
  const axisScale = Math.max(Math.abs(halfDx), Math.abs(halfDy));
  const axisDir =
    axisScale > 0 ? norm2({ x: halfDx / axisScale, y: halfDy / axisScale }) : { x: 1, y: 0 };
  const closerAxisRef = (q) => {
    if (!isFinitePoint2D(q)) return a;
    const da = Math.abs(q.x * 0.25 - a.x * 0.25) + Math.abs(q.y * 0.25 - a.y * 0.25);
    const db = Math.abs(q.x * 0.25 - b.x * 0.25) + Math.abs(q.y * 0.25 - b.y * 0.25);
    return db < da ? b : a;
  };
  const signedAxisDistFrom = (q, ref = closerAxisRef(q)) => {
    if (!isFinitePoint2D(q)) return NaN;
    return axisDir.x * (q.y - ref.y) - axisDir.y * (q.x - ref.x);
  };
  const localCrossTolFrom = (q, ref = closerAxisRef(q)) => {
    if (!isFinitePoint2D(q)) return 1e-3;
    const t1 = Math.abs(axisDir.x * (q.y - ref.y));
    const t2 = Math.abs(axisDir.y * (q.x - ref.x));
    const cancel = Math.min(t1, t2);
    return Number.isFinite(cancel) ? Math.max(1e-3, cancel * (8 * Number.EPSILON)) : 1e-3;
  };
  const reflectPoint = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { x: NaN, y: NaN };
    }
    const ref = closerAxisRef(p);
    const maxMag = Math.max(Math.abs(ref.x), Math.abs(ref.y), Math.abs(p.x), Math.abs(p.y));
    if (maxMag <= 1e150) {
      const vx = p.x - ref.x;
      const vy = p.y - ref.y;
      const proj = vx * axisDir.x + vy * axisDir.y;
      return {
        x: ref.x + (2 * axisDir.x * proj - vx),
        y: ref.y + (2 * axisDir.y * proj - vy),
      };
    }
    const evx = p.x * 0.125 - ref.x * 0.125;
    const evy = p.y * 0.125 - ref.y * 0.125;
    const eProj = evx * axisDir.x + evy * axisDir.y;
    const dx8 = 2 * axisDir.x * eProj - evx;
    const dy8 = 2 * axisDir.y * eProj - evy;
    return {
      x: (ref.x * 0.125 + dx8) * 8,
      y: (ref.y * 0.125 + dy8) * 8,
    };
  };

  const forward = [];
  for (let k = 1; k <= n; k++) {
    forward.push(pts[(idx + k) % n]);
  }
  const mirrored = [];
  for (let k = forward.length - 2; k >= 1; k--) {
    mirrored.push(reflectPoint(forward[k]));
  }

  const rotDeg = finiteParam(piece.rotation, 0);
  const rotRad = (rotDeg * Math.PI) / 180;
  const posBefore = { x: finiteParam(piece.position?.x, 0), y: finiteParam(piece.position?.y, 0) };
  const pivotBefore = getPieceTransformPivot(piece);

  const rawCombined = [...forward, ...mirrored];
  const wasReversed = signedPolygonArea(rawCombined) < 0;
  const combined = wasReversed ? [...rawCombined].reverse() : rawCombined;
  const bounds = polygonBounds(combined);
  const minB = { x: bounds.minX, y: bounds.minY };
  const shiftPt = (p) => ({
    x: p.x - minB.x,
    y: p.y - minB.y,
  });

  const origSampled = samplePieceOutline({ points: pts, edges: Array.isArray(piece.edges) ? piece.edges : [] }, 16);
  const origSampleEntries = [];
  for (const p of origSampled) {
    if (dist2D(p, a) <= 1e-6 || dist2D(p, b) <= 1e-6) continue;
    const ref = closerAxisRef(p);
    const d = signedAxisDistFrom(p, ref);
    const tol = localCrossTolFrom(p, ref);
    if (Number.isFinite(d) && Number.isFinite(tol)) {
      origSampleEntries.push({ d, tol });
    }
  }

  const signedDists = forward.map((p) => signedAxisDistFrom(p));
  const hasInteriorAxisTouch = forward.slice(1, -1).some((_, sliceIdx) => {
    const k = sliceIdx + 1;
    return Number.isFinite(signedDists[k]) && Math.abs(signedDists[k]) <= 1e-3;
  });

  const oldEdges = Array.isArray(piece.edges) ? piece.edges : [];
  let hasInteriorCurveAxisTouch = false;
  const interiorRootEntries = [];
  for (let fIdx = 0; fIdx < n - 1; fIdx++) {
    const origE = (idx + 1 + fIdx) % n;
    const edgeCurve = oldEdges[origE]?.curve;
    if (!edgeCurve) continue;
    const p0 = pts[origE];
    const p1 = pts[(origE + 1) % n];
    const d0 = fIdx === 0 ? 0 : signedAxisDistFrom(p0);
    const dEnd = fIdx === n - 2 ? 0 : signedAxisDistFrom(p1);
    const roots = [];

    const evalCurveRootSample = (t, evalFn, cpList) => {
      let maxCoord = Math.max(
        Math.abs(a.x),
        Math.abs(a.y),
        Math.abs(b.x),
        Math.abs(b.y),
        Math.abs(p0.x),
        Math.abs(p0.y),
        Math.abs(p1.x),
        Math.abs(p1.y)
      );
      for (const cp of cpList) {
        maxCoord = Math.max(maxCoord, Math.abs(cp.x), Math.abs(cp.y));
      }
      if (maxCoord <= 1e150) {
        const ref0 = closerAxisRef(p0);
        const ref1 = closerAxisRef(p1);
        const seedRef = ref0 === ref1 ? ref0 : t <= 0.5 ? ref0 : ref1;
        const subSeed = (q) => ({ x: q.x - seedRef.x, y: q.y - seedRef.y });
        const relSeed = evalFn(subSeed(p0), ...cpList.map(subSeed), subSeed(p1), t);
        if (!isFinitePoint2D(relSeed)) return null;
        const roughPt = { x: seedRef.x + relSeed.x, y: seedRef.y + relSeed.y };
        const ref = closerAxisRef(roughPt);
        let rel = relSeed;
        if (ref !== seedRef) {
          const subRef = (q) => ({ x: q.x - ref.x, y: q.y - ref.y });
          rel = evalFn(subRef(p0), ...cpList.map(subRef), subRef(p1), t);
          if (!isFinitePoint2D(rel)) return null;
        }
        const pt = { x: ref.x + rel.x, y: ref.y + rel.y };
        const d = axisDir.x * rel.y - axisDir.y * rel.x;
        const t1 = Math.abs(axisDir.x * rel.y);
        const t2 = Math.abs(axisDir.y * rel.x);
        const cancel = Math.min(t1, t2);
        const tol = Number.isFinite(cancel) ? Math.max(1e-3, cancel * (8 * Number.EPSILON)) : 1e-3;
        const distP0 = Math.hypot(rel.x - (p0.x - ref.x), rel.y - (p0.y - ref.y));
        const distP1 = Math.hypot(rel.x - (p1.x - ref.x), rel.y - (p1.y - ref.y));
        const distA = Math.hypot(rel.x - (a.x - ref.x), rel.y - (a.y - ref.y));
        const distB = Math.hypot(rel.x - (b.x - ref.x), rel.y - (b.y - ref.y));
        return { pt, d, tol, distP0, distP1, distA, distB };
      }
      const pt = evalFn(p0, ...cpList, p1, t);
      if (!isFinitePoint2D(pt)) return null;
      const ref = closerAxisRef(pt);
      return {
        pt,
        d: signedAxisDistFrom(pt, ref),
        tol: localCrossTolFrom(pt, ref),
        distP0: dist2D(pt, p0),
        distP1: dist2D(pt, p1),
        distA: dist2D(pt, a),
        distB: dist2D(pt, b),
      };
    };

    if (edgeCurve.cp1 && edgeCurve.cp2) {
      const d1 = signedAxisDistFrom(edgeCurve.cp1);
      const d2 = signedAxisDistFrom(edgeCurve.cp2);
      if (Number.isFinite(d0) && Number.isFinite(d1) && Number.isFinite(d2) && Number.isFinite(dEnd)) {
        if (
          (d0 > 1e-3 && d1 > 1e-3 && d2 > 1e-3 && dEnd > 1e-3) ||
          (d0 < -1e-3 && d1 < -1e-3 && d2 < -1e-3 && dEnd < -1e-3)
        ) {
          continue;
        }
        const maxD = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(dEnd));
        if (maxD > 0) {
          const sd0 = d0 / maxD;
          const sd1 = d1 / maxD;
          const sd2 = d2 / maxD;
          const sd3 = dEnd / maxD;
          const a2 = -sd0 + 3 * sd1 - 3 * sd2 + sd3;
          const b2 = 2 * (sd0 - 2 * sd1 + sd2);
          const c2 = sd1 - sd0;
          const spanScale = Math.max(1, Math.abs(b2), Math.abs(c2));
          if (Math.abs(a2) <= 1e-12 * spanScale) {
            if (Math.abs(b2) > 1e-12) {
              const t = -c2 / b2;
              if (Number.isFinite(t) && t > 0 && t < 1) roots.push(t);
            }
          } else {
            const discRaw = b2 * b2 - 4 * a2 * c2;
            if (discRaw >= -1e-12 * Math.max(1, b2 * b2)) {
              const sqrtDisc = Math.sqrt(Math.max(0, discRaw));
              const q = b2 >= 0 ? -0.5 * (b2 + sqrtDisc) : -0.5 * (b2 - sqrtDisc);
              if (Math.abs(q) > 1e-15) {
                const t1 = q / a2;
                const t2 = c2 / q;
                if (Number.isFinite(t1) && t1 > 0 && t1 < 1) roots.push(t1);
                if (Number.isFinite(t2) && t2 > 0 && t2 < 1) roots.push(t2);
              } else {
                const t = -b2 / (2 * a2);
                if (Number.isFinite(t) && t > 0 && t < 1) roots.push(t);
              }
            }
          }
          for (const t of roots) {
            const sample = evalCurveRootSample(t, evalCubicBezier, [edgeCurve.cp1, edgeCurve.cp2]);
            if (!sample || !Number.isFinite(sample.d) || !Number.isFinite(sample.tol)) continue;
            const isEndpointSnap =
              (t <= 1e-4 && Math.abs(d0) <= 1e-3 && sample.distP0 <= 1e-3) ||
              (t >= 1 - 1e-4 && Math.abs(dEnd) <= 1e-3 && sample.distP1 <= 1e-3);
            const isAxisTangentSnap =
              (t <= 1e-12 && Math.abs(d0) <= 1e-3 && Math.abs(sample.d) <= 1e-9) ||
              (t >= 1 - 1e-12 && Math.abs(dEnd) <= 1e-3 && Math.abs(sample.d) <= 1e-9);
            if (!isEndpointSnap && !isAxisTangentSnap) {
              if (sample.distA > 1e-6 && sample.distB > 1e-6) {
                origSampleEntries.push({ d: sample.d, tol: sample.tol });
              }
              if (Math.abs(sample.d) <= 1e-3) {
                hasInteriorCurveAxisTouch = true;
              } else {
                interiorRootEntries.push({ d: sample.d, tol: sample.tol });
              }
            }
          }
        } else {
          const midSample = evalCurveRootSample(0.5, evalCubicBezier, [edgeCurve.cp1, edgeCurve.cp2]);
          if (midSample && Number.isFinite(midSample.d) && Math.abs(midSample.d) <= midSample.tol) {
            hasInteriorCurveAxisTouch = true;
          }
        }
      }
    } else if (edgeCurve.cp) {
      const d1 = signedAxisDistFrom(edgeCurve.cp);
      if (Number.isFinite(d0) && Number.isFinite(d1) && Number.isFinite(dEnd)) {
        if (
          (d0 > 1e-3 && d1 > 1e-3 && dEnd > 1e-3) ||
          (d0 < -1e-3 && d1 < -1e-3 && dEnd < -1e-3)
        ) {
          continue;
        }
        const maxD = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(dEnd));
        if (maxD > 0) {
          const sd0 = d0 / maxD;
          const sd1 = d1 / maxD;
          const sd2 = dEnd / maxD;
          const denom = sd0 - 2 * sd1 + sd2;
          if (Math.abs(denom) > 1e-12) {
            const t = (sd0 - sd1) / denom;
            if (Number.isFinite(t) && t > 0 && t < 1) roots.push(t);
          }
          for (const t of roots) {
            const sample = evalCurveRootSample(t, evalQuadBezier, [edgeCurve.cp]);
            if (!sample || !Number.isFinite(sample.d) || !Number.isFinite(sample.tol)) continue;
            const isEndpointSnap =
              (t <= 1e-4 && Math.abs(d0) <= 1e-3 && sample.distP0 <= 1e-3) ||
              (t >= 1 - 1e-4 && Math.abs(dEnd) <= 1e-3 && sample.distP1 <= 1e-3);
            const isAxisTangentSnap =
              (t <= 1e-12 && Math.abs(d0) <= 1e-3 && Math.abs(sample.d) <= 1e-9) ||
              (t >= 1 - 1e-12 && Math.abs(dEnd) <= 1e-3 && Math.abs(sample.d) <= 1e-9);
            if (!isEndpointSnap && !isAxisTangentSnap) {
              if (sample.distA > 1e-6 && sample.distB > 1e-6) {
                origSampleEntries.push({ d: sample.d, tol: sample.tol });
              }
              if (Math.abs(sample.d) <= 1e-3) {
                hasInteriorCurveAxisTouch = true;
              } else {
                interiorRootEntries.push({ d: sample.d, tol: sample.tol });
              }
            }
          }
        } else {
          const midSample = evalCurveRootSample(0.5, evalQuadBezier, [edgeCurve.cp]);
          if (midSample && Number.isFinite(midSample.d) && Math.abs(midSample.d) <= midSample.tol) {
            hasInteriorCurveAxisTouch = true;
          }
        }
      }
    }
  }

  const hasPosSide = origSampleEntries.some((e) => e.d > e.tol);
  const hasNegSide = origSampleEntries.some((e) => e.d < -e.tol);
  const crossesMirrorLine =
    (hasPosSide && hasNegSide) ||
    (hasPosSide && interiorRootEntries.some((e) => e.d < -1e-3)) ||
    (hasNegSide && interiorRootEntries.some((e) => e.d > 1e-3));

  const shiftedPreview = combined.map(shiftPt);
  if (
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    shiftedPreview.some((pt) => !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y))
  ) {
    throw new ValidationError('mirrorPieceAcrossEdge produced non-finite piece bounds or vertices', {
      code: 'INVALID_POINTS',
      path: 'piece.points',
    });
  }
  const totalEdges = shiftedPreview.length;
  const newEdges = Array.from({ length: totalEdges }, (_, i) => ({
    name: `Edge ${i + 1}`,
    seamAllowance: piece.seamAllowance ?? 10,
  }));

  const mapEdgeIndex = (rawEdgeIdx) =>
    wasReversed ? (totalEdges - 2 - rawEdgeIdx + totalEdges) % totalEdges : rawEdgeIdx;

  const origToFwdEdge = new Map();
  for (let fIdx = 0; fIdx < n - 1; fIdx++) {
    const origE = (idx + 1 + fIdx) % n;
    const rawOrigMeta = oldEdges[origE];
    const origMeta =
      rawOrigMeta && typeof rawOrigMeta === 'object'
        ? rawOrigMeta
        : { name: `Edge ${origE + 1}`, seamAllowance: piece.seamAllowance ?? 10 };
    const fwdTarget = mapEdgeIndex(fIdx);
    const mirTarget = mapEdgeIndex(totalEdges - 1 - fIdx);
    origToFwdEdge.set(origE, fwdTarget);

    newEdges[fwdTarget] = {
      name: origMeta.name || `Edge ${fwdTarget + 1}`,
      seamAllowance: origMeta.seamAllowance ?? piece.seamAllowance ?? 10,
    };
    if (origMeta.curve) {
      if (origMeta.curve.cp1 && origMeta.curve.cp2) {
        const fcp1 = shiftPt(origMeta.curve.cp1);
        const fcp2 = shiftPt(origMeta.curve.cp2);
        if (!isFinitePoint2D(fcp1) || !isFinitePoint2D(fcp2)) {
          throw new ValidationError('mirrorPieceAcrossEdge produced non-finite curve control points', {
            code: 'INVALID_POINTS',
            path: `edges[${fwdTarget}].curve`,
          });
        }
        newEdges[fwdTarget].curve = wasReversed ? { cp1: fcp2, cp2: fcp1 } : { cp1: fcp1, cp2: fcp2 };
      } else if (origMeta.curve.cp) {
        const fcp = shiftPt(origMeta.curve.cp);
        if (!isFinitePoint2D(fcp)) {
          throw new ValidationError('mirrorPieceAcrossEdge produced non-finite curve control point', {
            code: 'INVALID_POINTS',
            path: `edges[${fwdTarget}].curve`,
          });
        }
        newEdges[fwdTarget].curve = { cp: fcp };
      }
    }

    newEdges[mirTarget] = {
      name: `${safeStr(origMeta.name || `Edge ${origE + 1}`)} (Mirrored)`,
      seamAllowance: origMeta.seamAllowance ?? piece.seamAllowance ?? 10,
    };
    if (origMeta.curve) {
      if (origMeta.curve.cp1 && origMeta.curve.cp2) {
        const rcp1 = shiftPt(reflectPoint(origMeta.curve.cp1));
        const rcp2 = shiftPt(reflectPoint(origMeta.curve.cp2));
        if (!isFinitePoint2D(rcp1) || !isFinitePoint2D(rcp2)) {
          throw new ValidationError('mirrorPieceAcrossEdge produced non-finite mirrored curve control points', {
            code: 'INVALID_POINTS',
            path: `edges[${mirTarget}].curve`,
          });
        }
        newEdges[mirTarget].curve = wasReversed ? { cp1: rcp1, cp2: rcp2 } : { cp1: rcp2, cp2: rcp1 };
      } else if (origMeta.curve.cp) {
        const rcp = shiftPt(reflectPoint(origMeta.curve.cp));
        if (!isFinitePoint2D(rcp)) {
          throw new ValidationError('mirrorPieceAcrossEdge produced non-finite mirrored curve control point', {
            code: 'INVALID_POINTS',
            path: `edges[${mirTarget}].curve`,
          });
        }
        newEdges[mirTarget].curve = { cp: rcp };
      }
    }
  }

  const hasAnyCurve = newEdges.some((e) => Boolean(e?.curve));
  if (
    hasInteriorAxisTouch ||
    hasInteriorCurveAxisTouch ||
    crossesMirrorLine ||
    Math.abs(signedPolygonArea(shiftedPreview)) < 1e-3 ||
    polygonSelfIntersects(shiftedPreview) ||
    (hasAnyCurve &&
      polygonSelfIntersects(samplePieceOutline({ points: shiftedPreview, edges: newEdges }, 64)))
  ) {
    throw new ValidationError('Mirroring across this edge produces a self-intersecting or degenerate polygon', {
      code: 'SELF_INTERSECTING_MIRROR',
      path: 'piece.points',
    });
  }

  let nextRotationOrigin = piece.rotationOrigin;
  if (piece.rotationOrigin && Number.isFinite(piece.rotationOrigin.x) && Number.isFinite(piece.rotationOrigin.y)) {
    nextRotationOrigin = shiftPt(piece.rotationOrigin);
    if (!isFinitePoint2D(nextRotationOrigin)) {
      throw new ValidationError('mirrorPieceAcrossEdge produced non-finite rotationOrigin', {
        code: 'INVALID_POINTS',
        path: 'piece.rotationOrigin',
      });
    }
  }

  let nextGrainline = piece.grainline;
  if (piece.grainline && typeof piece.grainline === 'object') {
    nextGrainline = { ...piece.grainline };
    if (
      piece.grainline.start &&
      Number.isFinite(piece.grainline.start.x) &&
      Number.isFinite(piece.grainline.start.y)
    ) {
      nextGrainline.start = shiftPt(piece.grainline.start);
      if (!isFinitePoint2D(nextGrainline.start)) {
        throw new ValidationError('mirrorPieceAcrossEdge produced non-finite grainline.start', {
          code: 'INVALID_POINTS',
          path: 'piece.grainline.start',
        });
      }
    }
    if (
      piece.grainline.end &&
      Number.isFinite(piece.grainline.end.x) &&
      Number.isFinite(piece.grainline.end.y)
    ) {
      nextGrainline.end = shiftPt(piece.grainline.end);
      if (!isFinitePoint2D(nextGrainline.end)) {
        throw new ValidationError('mirrorPieceAcrossEdge produced non-finite grainline.end', {
          code: 'INVALID_POINTS',
          path: 'piece.grainline.end',
        });
      }
    }
  }

  const pivotAfter = getPieceTransformPivot({
    points: shiftedPreview,
    rotationOrigin: nextRotationOrigin,
  });
  let nextPosition;
  if (Math.abs(rotRad) > 1e-9) {
    const rotVec = (v) => rotate2(v, rotRad, { x: 0, y: 0 });
    const rotPivotBefore = rotVec(pivotBefore);
    const shiftedPivotAfter = add2(minB, pivotAfter);
    const rotShiftedPivotAfter = rotVec(shiftedPivotAfter);
    const pBeforeTerm = sub2(pivotBefore, rotPivotBefore);
    const pAfterTerm = sub2(rotShiftedPivotAfter, pivotAfter);
    const deltaPos = add2(pBeforeTerm, pAfterTerm);
    nextPosition = add2(posBefore, deltaPos);
    if (
      !isFinitePoint2D(pivotBefore) ||
      !isFinitePoint2D(pivotAfter) ||
      !isFinitePoint2D(rotPivotBefore) ||
      !isFinitePoint2D(shiftedPivotAfter) ||
      !isFinitePoint2D(rotShiftedPivotAfter) ||
      !isFinitePoint2D(pBeforeTerm) ||
      !isFinitePoint2D(pAfterTerm) ||
      !isFinitePoint2D(deltaPos) ||
      !isFinitePoint2D(nextPosition)
    ) {
      throw new ValidationError('mirrorPieceAcrossEdge produced non-finite piece position', {
        code: 'INVALID_DIMENSIONS',
        path: 'piece.position',
      });
    }
  } else {
    nextPosition = {
      x: posBefore.x + minB.x,
      y: posBefore.y + minB.y,
    };
    if (!isFinitePoint2D(nextPosition)) {
      throw new ValidationError('mirrorPieceAcrossEdge produced non-finite piece position', {
        code: 'INVALID_DIMENSIONS',
        path: 'piece.position',
      });
    }
  }

  const newDarts = [];
  for (const d of Array.isArray(piece.darts) ? piece.darts : []) {
    if (!d || typeof d !== 'object' || !Number.isInteger(d.edgeIndex)) continue;
    if (d.edgeIndex === idx) continue;
    const fIdx = (d.edgeIndex - (idx + 1) + n) % n;
    if (fIdx < 0 || fIdx >= n - 1) continue;
    const fwdTarget = mapEdgeIndex(fIdx);
    const mirTarget = mapEdgeIndex(totalEdges - 1 - fIdx);
    const dt = clamp(finiteParam(d.t, 0.5), 0.01, 0.99);
    const tFwd = wasReversed ? 1 - dt : dt;
    const tMir = wasReversed ? dt : 1 - dt;
    newDarts.push(
      { ...d, edgeIndex: fwdTarget, t: tFwd },
      { ...d, id: `${safeStr(d.id)}_mir`, edgeIndex: mirTarget, t: tMir }
    );
  }

  const newNotches = [];
  for (const nItem of Array.isArray(piece.notches) ? piece.notches : []) {
    if (!nItem || typeof nItem !== 'object' || !Number.isInteger(nItem.edgeIndex)) continue;
    if (nItem.edgeIndex === idx) continue;
    const fIdx = (nItem.edgeIndex - (idx + 1) + n) % n;
    if (fIdx < 0 || fIdx >= n - 1) continue;
    const fwdTarget = mapEdgeIndex(fIdx);
    const mirTarget = mapEdgeIndex(totalEdges - 1 - fIdx);
    const nt = clamp(finiteParam(nItem.t, 0.5), 0, 1);
    const tFwd = wasReversed ? 1 - nt : nt;
    const tMir = wasReversed ? nt : 1 - nt;
    newNotches.push(
      { ...nItem, edgeIndex: fwdTarget, t: tFwd },
      { ...nItem, id: `${safeStr(nItem.id)}_mir`, edgeIndex: mirTarget, t: tMir }
    );
  }

  const updatedInternalLines = [];
  for (const il of Array.isArray(piece.internalLines) ? piece.internalLines : []) {
    if (!il || typeof il !== 'object' || !Array.isArray(il.points) || il.points.length < 2) continue;
    if (!allFinitePoints2D(il.points)) continue;
    const shiftedIlPts = il.points.map(shiftPt);
    if (!allFinitePoints2D(shiftedIlPts)) {
      throw new ValidationError('mirrorPieceAcrossEdge produced non-finite internalLine coordinates', {
        code: 'INVALID_POINTS',
        path: 'piece.internalLines',
      });
    }
    updatedInternalLines.push({
      ...il,
      points: shiftedIlPts,
    });
    if (il.type !== 'fold') {
      const mirroredIlPts = il.points.map((pt) => shiftPt(reflectPoint(pt)));
      if (!allFinitePoints2D(mirroredIlPts)) {
        throw new ValidationError('mirrorPieceAcrossEdge produced non-finite mirrored internalLine coordinates', {
          code: 'INVALID_POINTS',
          path: 'piece.internalLines',
        });
      }
      updatedInternalLines.push({
        ...il,
        id: `${safeStr(il.id)}_mir`,
        name: `${safeStr(il.name || il.id)} (Mirrored)`,
        points: mirroredIlPts,
      });
    }
  }
  const foldAxisPts = [shiftPt(a), shiftPt(b)];
  if (!allFinitePoints2D(foldAxisPts)) {
    throw new ValidationError('mirrorPieceAcrossEdge produced non-finite fold axis coordinates', {
      code: 'INVALID_POINTS',
      path: 'piece.internalLines',
    });
  }
  updatedInternalLines.push({
    id: `mirror_center_${Date.now()}`,
    name: 'Center Fold / Symmetry Axis',
    type: 'fold',
    points: foldAxisPts,
  });

  // Commit all validated mutations atomically
  piece.points = shiftedPreview;
  if (nextRotationOrigin !== undefined) {
    piece.rotationOrigin = nextRotationOrigin;
  }
  if (nextGrainline !== undefined) {
    piece.grainline = nextGrainline;
  }
  piece.position = nextPosition;
  piece.onFold = false;
  piece.edges = newEdges;
  piece.darts = newDarts;
  piece.notches = newNotches;
  piece.internalLines = updatedInternalLines;

  if (pattern && Array.isArray(pattern.seams)) {
    const remapped = [];
    for (const seam of pattern.seams) {
      if (!seam || typeof seam !== 'object') continue;
      if (seam.pieceA === piece.id && seam.edgeA === idx) continue;
      if (seam.pieceB === piece.id && !seam.internalLineIdB && seam.edgeB === idx) continue;
      if (seam.pieceA === piece.id && origToFwdEdge.has(seam.edgeA)) {
        seam.edgeA = origToFwdEdge.get(seam.edgeA);
        if (wasReversed) {
          const ts = finiteParam(seam.tStartA, 0);
          const te = finiteParam(seam.tEndA, 1);
          seam.tStartA = 1 - te;
          seam.tEndA = 1 - ts;
          seam.reversed = !parseBoolFlag(seam.reversed);
        }
      }
      if (seam.pieceB === piece.id && !seam.internalLineIdB && origToFwdEdge.has(seam.edgeB)) {
        seam.edgeB = origToFwdEdge.get(seam.edgeB);
        if (wasReversed) {
          const ts = finiteParam(seam.tStartB, 0);
          const te = finiteParam(seam.tEndB, 1);
          seam.tStartB = 1 - te;
          seam.tEndB = 1 - ts;
          seam.reversed = !parseBoolFlag(seam.reversed);
        }
      }
      remapped.push(seam);
    }
    pattern.seams = remapped;
  }

  return piece;
}

// ============================================================================
// Sewing Seam Length Validator & Walk Seam Transform (F13)
// ============================================================================

function computeSubEdgeLength(piece, edgeIdx, tStart = 0, tEnd = 1) {
  const n = piece.points.length;
  const p0 = piece.points[edgeIdx];
  const p1 = piece.points[(edgeIdx + 1) % n];
  const edgeMeta = Array.isArray(piece.edges) ? piece.edges[edgeIdx] : null;
  const curve = edgeMeta && typeof edgeMeta === 'object' ? edgeMeta.curve || null : null;

  if (!isFinitePoint2D(p0) || !isFinitePoint2D(p1) || !hasFiniteCurvePoints(curve)) {
    return NaN;
  }

  const t0 = clamp(finiteParam(tStart, 0), 0, 1);
  const t1 = clamp(finiteParam(tEnd, 1), t0, 1);

  const steps = curve ? 48 : 1;
  let rawSubLen = 0;
  let prev = evalEdgeAt(p0, p1, curve, t0);
  for (let s = 1; s <= steps; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    const pt = evalEdgeAt(p0, p1, curve, t);
    rawSubLen += dist2D(prev, pt);
    prev = pt;
  }

  const fullEdgeLen = edgeArcLength(p0, p1, curve);
  if (!Number.isFinite(rawSubLen) || !Number.isFinite(fullEdgeLen)) {
    return NaN;
  }
  let dartIntake = 0;
  const resolvedDarts = resolveEdgeDarts(p0, p1, curve, piece.darts, edgeIdx, 1);
  for (const rd of resolvedDarts) {
    const span = rd.tEnd - rd.tStart;
    if (!(span > 0)) continue;
    const overlap = Math.max(0, Math.min(t1, rd.tEnd) - Math.max(t0, rd.tStart));
    const frac = overlap / span;
    dartIntake += (rd.intakeMm || 0) * frac;
  }

  return Math.max(0.1, rawSubLen - dartIntake);
}

function intervalsOverlap(a, b, eps = 1e-3) {
  return Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0) > eps;
}

function isValidSeamTRange(rawStart, rawEnd) {
  const t0 = rawStart !== undefined ? rawStart : 0;
  const t1 = rawEnd !== undefined ? rawEnd : 1;
  return (
    typeof t0 === 'number' &&
    Number.isFinite(t0) &&
    typeof t1 === 'number' &&
    Number.isFinite(t1) &&
    t0 >= 0 &&
    t1 <= 1 &&
    t0 < t1
  );
}

export function validatePatternSeams(pattern, toleranceMm = 5.0, maxEasePct = 18.0) {
  if (!pattern || !Array.isArray(pattern.seams)) return [];
  const tolMm = finiteParam(toleranceMm, 5.0);
  const maxEase = finiteParam(maxEasePct, 18.0);
  const pieceMap = new Map(
    (Array.isArray(pattern.pieces) ? pattern.pieces : [])
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
      .map((p) => [p.id, p])
  );
  const edgeIntervals = new Map();

  const registerInterval = (key, tag, t0, t1) => {
    if (!edgeIntervals.has(key)) edgeIntervals.set(key, []);
    edgeIntervals.get(key).push({ tag, t0, t1 });
  };

  const hasOverlapConflict = (key, tag, t0, t1) => {
    const list = edgeIntervals.get(key) || [];
    for (const entry of list) {
      if (entry.tag === tag) continue;
      if (intervalsOverlap(entry, { t0, t1 })) {
        return true;
      }
    }
    return false;
  };

  const prepared = pattern.seams.map((seam, seamIdx) => {
    if (!seam || typeof seam !== 'object') {
      return {
        earlyResult: {
          seamId: undefined,
          name: 'Invalid Seam',
          valid: false,
          status: 'invalid_seam',
          message: 'Seam entry must be an object.',
        },
      };
    }

    const baseStatus = {
      seamId: seam.id,
      name: seam.name || seam.id,
    };

    const pA = pieceMap.get(seam.pieceA);
    const pB = pieceMap.get(seam.pieceB);
    if (!pA || !pB) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'missing_piece',
          message: 'Referenced pattern piece not found.',
        },
      };
    }

    if (!Array.isArray(pA.points) || pA.points.length === 0 || !Array.isArray(pB.points) || pB.points.length === 0) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'invalid_seam',
          message: 'Referenced pattern piece has no vertices.',
        },
      };
    }

    if (
      !allFinitePoints2D(pA.points) ||
      !allFinitePoints2D(pB.points) ||
      (Array.isArray(pA.edges) && hasSparseHoles(pA.edges)) ||
      (Array.isArray(pB.edges) && hasSparseHoles(pB.edges))
    ) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'invalid_seam',
          message: `Seam "${safeStr(seam.id)}" references piece with non-finite or sparse vertices/edges.`,
        },
      };
    }

    if (!Number.isInteger(seam.edgeA) || seam.edgeA < 0 || seam.edgeA >= pA.points.length) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'invalid_seam',
          message: `Invalid seam edgeA (${safeStr(seam.edgeA)}) on piece "${pA.id}".`,
        },
      };
    }

    if (!isValidSeamTRange(seam.tStartA, seam.tEndA) || !isValidSeamTRange(seam.tStartB, seam.tEndB)) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'invalid_seam',
          message: `Invalid seam parametric range on seam "${safeStr(seam.id)}".`,
        },
      };
    }

    const eA = seam.edgeA;
    const tStartA = seam.tStartA ?? 0;
    const tEndA = seam.tEndA ?? 1;
    const lenA = computeSubEdgeLength(pA, eA, tStartA, tEndA);

    let lenB = 0;
    let eB = Number.isInteger(seam.edgeB) ? seam.edgeB : 0;
    let edgeBName = '';
    const tStartB = seam.tStartB ?? 0;
    const tEndB = seam.tEndB ?? 1;
    const hasInternalTarget = seam.internalLineIdB !== undefined;

    if (hasInternalTarget) {
      if (typeof seam.internalLineIdB !== 'string' || seam.internalLineIdB.length === 0) {
        return {
          earlyResult: {
            ...baseStatus,
            valid: false,
            status: 'invalid_seam',
            message: `Invalid internalLineIdB (${safeStr(seam.internalLineIdB)}) on piece "${pB.id}".`,
          },
        };
      }
      const il = (Array.isArray(pB.internalLines) ? pB.internalLines : []).find(
        (line) => line && typeof line === 'object' && line.id === seam.internalLineIdB
      );
      if (!il || !Array.isArray(il.points) || il.points.length < 2) {
        return {
          earlyResult: {
            ...baseStatus,
            valid: false,
            status: 'missing_piece',
            message: `Internal line "${safeStr(seam.internalLineIdB)}" not found on piece "${pB.id}".`,
          },
        };
      }
      const rawSegIdx = seam.internalSegmentIndexB === undefined ? 0 : seam.internalSegmentIndexB;
      if (!Number.isInteger(rawSegIdx) || rawSegIdx < 0 || rawSegIdx >= il.points.length - 1) {
        return {
          earlyResult: {
            ...baseStatus,
            valid: false,
            status: 'invalid_seam',
            message: `Internal segment index ${safeStr(rawSegIdx)} out of range [0, ${il.points.length - 2}] on piece "${pB.id}".`,
          },
        };
      }
      const segIdx = rawSegIdx;
      const pt0 = il.points[segIdx];
      const pt1 = il.points[segIdx + 1];
      lenB =
        isFinitePoint2D(pt0) && isFinitePoint2D(pt1)
          ? Math.max(0.1, dist2D(pt0, pt1) * (tEndB - tStartB))
          : NaN;
      edgeBName = `${safeStr(il.name || il.id)} [seg ${segIdx}]`;
    } else {
      if (!Number.isInteger(seam.edgeB) || seam.edgeB < 0 || seam.edgeB >= pB.points.length) {
        return {
          earlyResult: {
            ...baseStatus,
            valid: false,
            status: 'invalid_seam',
            message: `Invalid seam edgeB (${safeStr(seam.edgeB)}) on piece "${pB.id}".`,
          },
        };
      }
      eB = seam.edgeB;
      lenB = computeSubEdgeLength(pB, eB, tStartB, tEndB);
      const edgeBMeta = Array.isArray(pB.edges) ? pB.edges[eB] : null;
      edgeBName = (edgeBMeta && typeof edgeBMeta === 'object' && edgeBMeta.name) || `Edge ${eB + 1}`;
    }

    if (!Number.isFinite(lenA) || !Number.isFinite(lenB)) {
      return {
        earlyResult: {
          ...baseStatus,
          valid: false,
          status: 'invalid_seam',
          message: `Non-finite seam length on seam "${safeStr(seam.id)}".`,
        },
      };
    }

    registerInterval(`${pA.id}:${eA}`, `${seamIdx}:A`, tStartA, tEndA);
    if (!hasInternalTarget) {
      registerInterval(`${pB.id}:${eB}`, `${seamIdx}:B`, tStartB, tEndB);
    }

    return {
      seam,
      seamIdx,
      pA,
      pB,
      eA,
      eB,
      tStartA,
      tEndA,
      tStartB,
      tEndB,
      lenA,
      lenB,
      edgeBName,
      hasInternalTarget,
    };
  });

  return prepared.map((entry) => {
    if (entry.earlyResult) return entry.earlyResult;
    const {
      seam,
      seamIdx,
      pA,
      pB,
      eA,
      eB,
      tStartA,
      tEndA,
      tStartB,
      tEndB,
      lenA,
      lenB,
      edgeBName,
      hasInternalTarget,
    } = entry;

    let isDuplicateEdge = hasOverlapConflict(`${pA.id}:${eA}`, `${seamIdx}:A`, tStartA, tEndA);
    if (!hasInternalTarget) {
      if (hasOverlapConflict(`${pB.id}:${eB}`, `${seamIdx}:B`, tStartB, tEndB)) {
        isDuplicateEdge = true;
      }
      if (
        pA.id === pB.id &&
        eA === eB &&
        intervalsOverlap({ t0: tStartA, t1: tEndA }, { t0: tStartB, t1: tEndB }, 1e-6)
      ) {
        isDuplicateEdge = true;
      }
    }

    const deltaMm = Math.abs(lenA - lenB);
    const avgLen = (lenA + lenB) * 0.5;
    const deltaPct = (deltaMm / Math.max(1, avgLen)) * 100;

    let status = 'ok';
    if (isDuplicateEdge) {
      status = 'duplicate_edge';
    } else if (deltaMm > tolMm) {
      status = parseBoolFlag(seam.allowEase) && deltaPct <= maxEase ? 'ease' : 'mismatch';
    }

    const edgeAMeta = Array.isArray(pA.edges) ? pA.edges[eA] : null;
    return {
      seamId: seam.id,
      name: seam.name || `${safeStr(pA.name)} <-> ${safeStr(pB.name)}`,
      pieceA: pA.id,
      pieceAName: pA.name,
      edgeA: eA,
      edgeAName: (edgeAMeta && typeof edgeAMeta === 'object' && edgeAMeta.name) || `Edge ${eA + 1}`,
      lengthAMm: Number(lenA.toFixed(1)),
      pieceB: pB.id,
      pieceBName: pB.name,
      edgeB: eB,
      edgeBName,
      lengthBMm: Number(lenB.toFixed(1)),
      deltaMm: Number(deltaMm.toFixed(1)),
      deltaPct: Number(deltaPct.toFixed(1)),
      status,
      valid: status === 'ok' || status === 'ease',
    };
  });
}

export function computeSeamWalkTransform(pattern, seamOrId, walkMm = 0, options = {}) {
  if (!pattern || !Array.isArray(pattern.pieces)) {
    throw new ValidationError('computeSeamWalkTransform requires a valid pattern with pieces', {
      code: 'INVALID_PROJECT',
      path: 'pattern',
    });
  }

  const opts = options && typeof options === 'object' ? options : {};
  const seam =
    typeof seamOrId === 'string'
      ? (Array.isArray(pattern.seams) ? pattern.seams : []).find(
          (s) => s && typeof s === 'object' && s.id === seamOrId
        )
      : seamOrId;

  if (!seam || typeof seam !== 'object') {
    throw new ValidationError(`Seam "${safeStr(seamOrId)}" not found`, {
      code: 'INVALID_SEAM',
      path: 'seam',
    });
  }

  const pieceMap = new Map(
    pattern.pieces
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
      .map((p) => [p.id, p])
  );
  const pieceA = pieceMap.get(seam.pieceA);
  const pieceB = pieceMap.get(seam.pieceB);
  if (!pieceA || !pieceB) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" references missing piece(s)`, {
      code: 'SEAM_MISSING_PIECE',
      path: 'seam',
    });
  }

  if (!Array.isArray(pieceA.points) || pieceA.points.length === 0 || !Array.isArray(pieceB.points) || pieceB.points.length === 0) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" references piece with no vertices`, {
      code: 'INVALID_SEAM',
      path: 'seam',
    });
  }

  if (!allFinitePoints2D(pieceA.points) || !allFinitePoints2D(pieceB.points)) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" references piece with non-finite vertices`, {
      code: 'INVALID_SEAM',
      path: 'seam',
    });
  }
  if ((Array.isArray(pieceA.edges) && hasSparseHoles(pieceA.edges)) || (Array.isArray(pieceB.edges) && hasSparseHoles(pieceB.edges))) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" references piece with sparse edges`, {
      code: 'INVALID_EDGES',
      path: 'seam',
    });
  }

  if (!Number.isInteger(seam.edgeA)) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" has invalid edgeA (${safeStr(seam.edgeA)})`, {
      code: 'INVALID_SEAM',
      path: 'seam.edgeA',
    });
  }

  const tStartA = clamp(finiteParam(seam.tStartA, 0), 0, 1);
  const tEndA = clamp(finiteParam(seam.tEndA, 1), tStartA, 1);
  const tStartB = clamp(finiteParam(seam.tStartB, 0), 0, 1);
  const tEndB = clamp(finiteParam(seam.tEndB, 1), tStartB, 1);
  const walkVal = finiteParam(walkMm, 0);

  const nA = pieceA.points.length;
  const eA = (((seam.edgeA % nA) + nA) % nA) || 0;
  const pA0 = pieceA.points[eA];
  const pA1 = pieceA.points[(eA + 1) % nA];
  const edgeAMeta = Array.isArray(pieceA.edges) ? pieceA.edges[eA] : null;
  const curveA = edgeAMeta && typeof edgeAMeta === 'object' ? edgeAMeta.curve || null : null;
  if (!isFinitePoint2D(pA0) || !isFinitePoint2D(pA1) || !hasFiniteCurvePoints(curveA)) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" has non-finite edgeA geometry`, {
      code: 'INVALID_SEAM',
      path: 'seam.edgeA',
    });
  }
  const lutA = buildEdgeArcTable(pA0, pA1, curveA, 64, tStartA, tEndA);
  const lenA = lutA.totalLen;
  if (!Number.isFinite(lenA)) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" has non-finite edgeA length`, {
      code: 'INVALID_SEAM',
      path: 'seam.edgeA',
    });
  }

  const seamReversed = parseBoolFlag(seam.reversed);
  const walkNormalized = parseBoolFlag(opts.normalized);
  let lenB;
  let pB_local;
  let tanB_local;
  let tB;
  let s;

  if (seam.internalLineIdB !== undefined && seam.internalLineIdB !== null) {
    if (typeof seam.internalLineIdB !== 'string' || seam.internalLineIdB.length === 0) {
      throw new ValidationError(`Invalid internalLineIdB "${safeStr(seam.internalLineIdB)}"`, {
        code: 'INVALID_SEAM',
        path: 'seam.internalLineIdB',
      });
    }
    const il = (Array.isArray(pieceB.internalLines) ? pieceB.internalLines : []).find(
      (line) => line && typeof line === 'object' && line.id === seam.internalLineIdB
    );
    if (!il || !Array.isArray(il.points) || il.points.length < 2) {
      throw new ValidationError(`Internal line "${safeStr(seam.internalLineIdB)}" not found`, {
        code: 'INVALID_SEAM',
        path: 'seam.internalLineIdB',
      });
    }
    const segIdx = clamp(Math.trunc(finiteParam(seam.internalSegmentIndexB, 0)), 0, Math.max(0, il.points.length - 2));
    const ip0 = il.points[segIdx];
    const ip1 = il.points[segIdx + 1];
    if (!isFinitePoint2D(ip0) || !isFinitePoint2D(ip1)) {
      throw new ValidationError(`Internal line "${safeStr(seam.internalLineIdB)}" has non-finite points`, {
        code: 'INVALID_SEAM',
        path: 'seam.internalLineIdB',
      });
    }
    const lutB = buildEdgeArcTable(ip0, ip1, null, 4, tStartB, tEndB);
    lenB = lutB.totalLen;
    if (!Number.isFinite(lenB)) {
      throw new ValidationError(`Seam "${safeStr(seam.id)}" has non-finite internal line length`, {
        code: 'INVALID_SEAM',
        path: 'seam.internalLineIdB',
      });
    }
    const maxWalk = Math.min(lenA, lenB);
    s = clamp(walkNormalized ? walkVal * maxWalk : walkVal, 0, maxWalk);
    const sB = seamReversed ? Math.max(0, lenB - s) : s;
    tB = tAtArcLength(lutB, sB);
    pB_local = lerp2(ip0, ip1, tB);
    tanB_local = norm2(sub2(ip1, ip0));
  } else {
    if (!Number.isInteger(seam.edgeB)) {
      throw new ValidationError(`Seam "${safeStr(seam.id)}" has invalid edgeB (${safeStr(seam.edgeB)})`, {
        code: 'INVALID_SEAM',
        path: 'seam.edgeB',
      });
    }
    const nB = pieceB.points.length;
    const eB = (((seam.edgeB % nB) + nB) % nB) || 0;
    const pB0 = pieceB.points[eB];
    const pB1 = pieceB.points[(eB + 1) % nB];
    const edgeBMeta = Array.isArray(pieceB.edges) ? pieceB.edges[eB] : null;
    const curveB = edgeBMeta && typeof edgeBMeta === 'object' ? edgeBMeta.curve || null : null;
    if (!isFinitePoint2D(pB0) || !isFinitePoint2D(pB1) || !hasFiniteCurvePoints(curveB)) {
      throw new ValidationError(`Seam "${safeStr(seam.id)}" has non-finite edgeB geometry`, {
        code: 'INVALID_SEAM',
        path: 'seam.edgeB',
      });
    }
    const lutB = buildEdgeArcTable(pB0, pB1, curveB, 64, tStartB, tEndB);
    lenB = lutB.totalLen;
    if (!Number.isFinite(lenB)) {
      throw new ValidationError(`Seam "${safeStr(seam.id)}" has non-finite edgeB length`, {
        code: 'INVALID_SEAM',
        path: 'seam.edgeB',
      });
    }
    const maxWalk = Math.min(lenA, lenB);
    s = clamp(walkNormalized ? walkVal * maxWalk : walkVal, 0, maxWalk);
    const sB = seamReversed ? Math.max(0, lenB - s) : s;
    tB = tAtArcLength(lutB, sB);
    pB_local = evalEdgeAt(pB0, pB1, curveB, tB);
    tanB_local = evalEdgeTangentAt(pB0, pB1, curveB, tB);
  }

  const maxWalkMm = Math.min(lenA, lenB);
  const tA = tAtArcLength(lutA, s);
  const pA_local = evalEdgeAt(pA0, pA1, curveA, tA);
  const tanA_local = evalEdgeTangentAt(pA0, pA1, curveA, tA);

  const safeRotationA = finiteParam(pieceA.rotation, 0);
  const safePositionA =
    pieceA.position && typeof pieceA.position === 'object'
      ? { x: finiteParam(pieceA.position.x, 0), y: finiteParam(pieceA.position.y, 0) }
      : { x: 0, y: 0 };
  const safePieceA = { ...pieceA, rotation: safeRotationA, position: safePositionA };
  const [pA_world] = transformPiecePoints([pA_local], safePieceA);
  const rotRadA = (safeRotationA * Math.PI) / 180;
  const tanA_world = Math.abs(rotRadA) > 1e-9 ? rotate2(tanA_local, rotRadA, { x: 0, y: 0 }) : tanA_local;

  const walkTanB = seamReversed ? scale2(tanB_local, -1) : tanB_local;
  let angleRad = Math.atan2(tanA_world.y, tanA_world.x) - Math.atan2(walkTanB.y, walkTanB.x);
  while (angleRad <= -Math.PI) angleRad += 2 * Math.PI;
  while (angleRad > Math.PI) angleRad -= 2 * Math.PI;

  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const tx = pA_world.x - (pB_local.x * cos - pB_local.y * sin);
  const ty = pA_world.y - (pB_local.x * sin + pB_local.y * cos);

  const applyTransform = (pt) => ({
    x: pt.x * cos - pt.y * sin + tx,
    y: pt.x * sin + pt.y * cos + ty,
  });

  const transformedPointsB = pieceB.points.map(applyTransform);
  if (
    !isFinitePoint2D(pA_world) ||
    !Number.isFinite(tx) ||
    !Number.isFinite(ty) ||
    !transformedPointsB.every(isFinitePoint2D)
  ) {
    throw new ValidationError(`Seam "${safeStr(seam.id)}" walk transform exceeds finite coordinate bounds`, {
      code: 'INVALID_POINTS',
      path: 'seam',
    });
  }

  return {
    seamId: seam.id,
    walkMm: s,
    maxWalkMm,
    lenA,
    lenB,
    tA,
    tB,
    contactPointWorld: pA_world,
    tangentWorld: tanA_world,
    angleRad,
    angleDeg: (angleRad * 180) / Math.PI,
    translation: { x: tx, y: ty },
    matrix: [cos, sin, -sin, cos, tx, ty],
    applyTransform,
    transformedPointsB,
  };
}
