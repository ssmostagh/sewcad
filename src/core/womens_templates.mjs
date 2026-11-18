/**
 * Women's Foundational Patternmaking Slopers, Garment Blocks & Standard Size Presets.
 * Pure ES module (Node.js v24 + Browsers, zero DOM dependencies).
 *
 * Includes:
 * - WOMENS_SIZE_PRESETS (ASTM Misses & Plus XS–2X / US 2–24W + Dress-Form Bust/Hip Proportions)
 * 1. `bodice_sloper`   — Women's Fitted Bodice Sloper (Side-Bust + Waist Darts + Set-In Sleeves)
 * 2. `princess_bodice` — Women's Princess-Seam Bodice / Bustier (6 Contoured Panels)
 * 3. `fit_flare_dress` — Women's Fit-and-Flare Dress (Darted Bodice + Flared Skirt)
 * 4. `aline_skirt`     — Women's A-Line Skirt + Contoured Waistband
 * 5. `pencil_skirt`    — Women's Tailored Pencil Skirt (Hip Curve + 4 Waist Darts)
 * 6. `womens_trousers` — Women's High-Waisted Wide-Leg Trousers
 */

import { SCHEMA_VERSION } from './types.mjs';
import { edgeArcLength, ensureCCW } from './geometry.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function finiteNum(val, fallback) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val.trim());
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export const WOMENS_SIZE_PRESETS = Object.freeze({
  XS: Object.freeze({
    id: 'XS',
    label: 'XS (US 2)',
    bodyType: 'womens',
    chestMm: 830,
    underbustMm: 700,
    waistMm: 650,
    highHipMm: 830,
    hipMm: 900,
    shoulderWidthMm: 365,
    bustSpanMm: 170,
    shoulderToBustMm: 245,
    heightMm: 1650,
  }),
  S: Object.freeze({
    id: 'S',
    label: 'S (US 4–6)',
    bodyType: 'womens',
    chestMm: 875,
    underbustMm: 735,
    waistMm: 685,
    highHipMm: 865,
    hipMm: 945,
    shoulderWidthMm: 375,
    bustSpanMm: 178,
    shoulderToBustMm: 252,
    heightMm: 1665,
  }),
  M: Object.freeze({
    id: 'M',
    label: 'M (US 8–10)',
    bodyType: 'womens',
    chestMm: 925,
    underbustMm: 775,
    waistMm: 730,
    highHipMm: 915,
    hipMm: 1000,
    shoulderWidthMm: 386,
    bustSpanMm: 186,
    shoulderToBustMm: 260,
    heightMm: 1680,
  }),
  L: Object.freeze({
    id: 'L',
    label: 'L (US 12–14)',
    bodyType: 'womens',
    chestMm: 990,
    underbustMm: 830,
    waistMm: 795,
    highHipMm: 975,
    hipMm: 1065,
    shoulderWidthMm: 398,
    bustSpanMm: 198,
    shoulderToBustMm: 270,
    heightMm: 1695,
  }),
  XL: Object.freeze({
    id: 'XL',
    label: 'XL (US 16–18)',
    bodyType: 'womens',
    chestMm: 1070,
    underbustMm: 900,
    waistMm: 880,
    highHipMm: 1055,
    hipMm: 1145,
    shoulderWidthMm: 412,
    bustSpanMm: 210,
    shoulderToBustMm: 282,
    heightMm: 1700,
  }),
  '1X': Object.freeze({
    id: '1X',
    label: '1X (US 20W)',
    bodyType: 'womens',
    chestMm: 1150,
    underbustMm: 970,
    waistMm: 970,
    highHipMm: 1140,
    hipMm: 1230,
    shoulderWidthMm: 424,
    bustSpanMm: 222,
    shoulderToBustMm: 292,
    heightMm: 1700,
  }),
  '2X': Object.freeze({
    id: '2X',
    label: '2X (US 22–24W)',
    bodyType: 'womens',
    chestMm: 1230,
    underbustMm: 1040,
    waistMm: 1060,
    highHipMm: 1220,
    hipMm: 1315,
    shoulderWidthMm: 436,
    bustSpanMm: 234,
    shoulderToBustMm: 302,
    heightMm: 1700,
  }),
});

export const DEFAULT_WOMENS_AVATAR_MEASUREMENTS = WOMENS_SIZE_PRESETS.M;

function solveWomensArmscyeAndCap({ halfBust, shoulderSpan, shoulderDrop, bodiceLengthMm, bicepWidthMm, sleeveLengthMm }) {
  const cx = halfBust * 0.5;
  const cp2x = Math.max(cx + 8, halfBust - Math.min(26, halfBust * 0.11));

  const armholeLenForDepth = (depth) =>
    edgeArcLength(
      { x: cx + shoulderSpan * 0.5, y: shoulderDrop },
      { x: halfBust, y: depth },
      {
        cp1: { x: cx + shoulderSpan * 0.44, y: depth * 0.56 },
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

  const minDepth = Math.max(135, shoulderDrop + 95);
  const maxDepth = Math.max(minDepth + 20, bodiceLengthMm * 0.56);
  let armholeDepth = clamp(bicepWidthMm * 0.62, minDepth, maxDepth);
  const armholeLen = armholeLenForDepth(armholeDepth);
  const targetCapLen = armholeLen * 1.055;

  let lo = 28;
  let hi = Math.max(95, sleeveLengthMm * 0.78, armholeDepth * 0.95);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (sleeveCapLenForH(bicepWidthMm, mid) < targetCapLen) lo = mid;
    else hi = mid;
  }
  return { armholeDepth, capH: (lo + hi) * 0.5, cp2x };
}

// ============================================================================
// 1. Women's Fitted Bodice Sloper (Bust + Waist Darts + Set-In Sleeves)
// ============================================================================

export function generateWomensBodiceSloper(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const bustMm = clamp(finiteNum(userParams.chestMm ?? userParams.bustMm, 925), 680, 1800);
  const stdUnderbust = Math.round(bustMm * 0.838);
  const underbustMm = clamp(
    finiteNum(userParams.underbustMm, stdUnderbust),
    Math.max(440, Math.round(bustMm * 0.60)),
    Math.round(bustMm * 0.98)
  );
  const cupDeltaMm = (bustMm - underbustMm) - (bustMm - stdUnderbust);
  const frameBustMm = clamp(Math.round(underbustMm / 0.838), Math.round(bustMm * 0.78), Math.round(bustMm * 1.06));

  const waistMm = clamp(finiteNum(userParams.waistMm, Math.round(bustMm * 0.79)), 520, Math.max(560, bustMm + 80));
  const lengthMm = clamp(finiteNum(userParams.lengthMm ?? userParams.bodiceLengthMm, 425), 320, 750);
  const defaultShoulder = clamp(Math.round(frameBustMm * 0.417), 320, 520);
  const easeMm = clamp(finiteNum(userParams.easeMm, 50), 10, 320);
  const halfBust = (bustMm + easeMm) * 0.5;
  const halfWaist = (waistMm + easeMm * 0.65) * 0.5;
  const shoulderWidthMm = clamp(
    finiteNum(userParams.shoulderWidthMm, defaultShoulder),
    280,
    Math.max(300, halfBust - 18)
  );
  const fbaFrontShift = clamp(cupDeltaMm * 0.30, -24, 48);
  const frontBustW = Math.max(shoulderWidthMm + 18, halfBust + fbaFrontShift);
  const backBustW = Math.max(shoulderWidthMm + 18, 2 * halfBust - frontBustW);

  const bustSpanMm = clamp(finiteNum(userParams.bustSpanMm, Math.round(frameBustMm * 0.20)), 130, Math.max(150, frontBustW * 0.68));
  const sleeveLengthMm = clamp(finiteNum(userParams.sleeveLengthMm, 205), 110, 680);
  const bicepWidthMm = clamp(finiteNum(userParams.bicepWidthMm, Math.round(frameBustMm * 0.33)), 210, 560);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const p = {
    chestMm: bustMm,
    underbustMm,
    waistMm,
    lengthMm,
    shoulderWidthMm,
    bustSpanMm,
    sleeveLengthMm,
    bicepWidthMm,
    easeMm,
    seamAllowance,
  };

  const sa = seamAllowance;
  const shoulderDrop = clamp(Math.round(shoulderWidthMm * 0.062), 18, 28);
  const neckW = clamp(Math.round(shoulderWidthMm * 0.43), 135, Math.max(145, shoulderWidthMm - 70));
  const { armholeDepth, capH } = solveWomensArmscyeAndCap({
    halfBust,
    shoulderSpan: shoulderWidthMm,
    shoulderDrop,
    bodiceLengthMm: lengthMm,
    bicepWidthMm,
    sleeveLengthMm,
  });

  const cxFront = frontBustW * 0.5;
  const cxBack = backBustW * 0.5;
  const cp2xFront = Math.max(cxFront + 8, frontBustW - Math.min(26, frontBustW * 0.11));
  const cp2xBack = Math.max(cxBack + 8, backBustW - Math.min(26, backBustW * 0.11));

  const backSideDrop = Math.max(135, lengthMm - armholeDepth);
  const backTotalReduction = Math.max(16, backBustW - halfWaist);
  const backSideTaper = clamp(backTotalReduction * 0.34, 6, Math.min(52, backBustW * 0.16));
  const backWaistSpanRaw = backBustW - 2 * backSideTaper;
  const backWaistDartEach = clamp((backWaistSpanRaw - halfWaist) * 0.5, 6, Math.min(46, backWaistSpanRaw * 0.20));

  const frontTotalReduction = Math.max(16, frontBustW - halfWaist);
  const frontSideTaper = clamp(frontTotalReduction * 0.34, 6, Math.min(58, frontBustW * 0.17));
  const frontWaistSpanRaw = frontBustW - 2 * frontSideTaper;
  const frontWaistDartEach = clamp((frontWaistSpanRaw - halfWaist) * 0.5, 6, Math.min(52, frontWaistSpanRaw * 0.22));

  const backSideLen = Math.hypot(backSideTaper, backSideDrop);
  const bustDartMm = clamp(
    Math.round((bustMm - waistMm) * 0.135 + cupDeltaMm * 0.19),
    12,
    Math.min(56, backSideDrop * 0.32)
  );
  const targetFrontSideRawLen = backSideLen + bustDartMm;
  const frontSideDrop = Math.sqrt(Math.max((backSideDrop + 8) ** 2, targetFrontSideRawLen ** 2 - frontSideTaper ** 2));

  const bustDartDepth = clamp(frontBustW * 0.5 - bustSpanMm * 0.5 - 20, 46, Math.max(55, frontBustW * 0.30));
  const frontWaistDartDepth = clamp(frontSideDrop * 0.64, 72, 145);
  const backWaistDartDepth = clamp(backSideDrop * 0.72, 82, 155);

  const frontNeckDrop = clamp(Math.round(neckW * 0.48), 62, Math.max(68, armholeDepth - 28));
  const backNeckDrop = 22;

  const frontBodice = {
    id: 'front_bodice',
    name: 'Front Bodice (Bust + Waist Darts)',
    role: 'front_bodice',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: cxFront - neckW * 0.5, y: 0 },
      { x: cxFront + neckW * 0.5, y: 0 },
      { x: cxFront + shoulderWidthMm * 0.5, y: shoulderDrop },
      { x: frontBustW, y: armholeDepth },
      { x: frontBustW - frontSideTaper, y: armholeDepth + frontSideDrop },
      { x: frontSideTaper, y: armholeDepth + frontSideDrop },
      { x: 0, y: armholeDepth },
      { x: cxFront - shoulderWidthMm * 0.5, y: shoulderDrop },
    ],
    edges: [
      {
        name: 'Scoop Neckline',
        seamAllowance: sa,
        curve: {
          cp1: { x: cxFront - neckW * 0.28, y: frontNeckDrop },
          cp2: { x: cxFront + neckW * 0.28, y: frontNeckDrop },
        },
      },
      { name: 'Right Shoulder', seamAllowance: sa },
      {
        name: 'Right Armscye',
        seamAllowance: sa,
        curve: {
          cp1: { x: cxFront + shoulderWidthMm * 0.44, y: armholeDepth * 0.56 },
          cp2: { x: cp2xFront, y: armholeDepth * 0.92 },
        },
      },
      { name: 'Right Side Seam (Bust Dart)', seamAllowance: sa },
      { name: 'Natural Waist Seam', seamAllowance: sa * 1.5 },
      { name: 'Left Side Seam (Bust Dart)', seamAllowance: sa },
      {
        name: 'Left Armscye',
        seamAllowance: sa,
        curve: {
          cp1: { x: frontBustW - cp2xFront, y: armholeDepth * 0.92 },
          cp2: { x: cxFront - shoulderWidthMm * 0.44, y: armholeDepth * 0.56 },
        },
      },
      { name: 'Left Shoulder', seamAllowance: sa },
    ],
    notches: [
      { id: 'fb_cf_neck', edgeIndex: 0, t: 0.5, type: 'single' },
      { id: 'fb_r_arm', edgeIndex: 2, t: 0.55, type: 'single' },
      { id: 'fb_l_arm', edgeIndex: 6, t: 0.45, type: 'single' },
      { id: 'fb_cf_waist', edgeIndex: 4, t: 0.5, type: 'single' },
    ],
    darts: [
      {
        id: 'dart_bust_right',
        edgeIndex: 3,
        t: 0.34,
        widthMm: bustDartMm,
        depthMm: bustDartDepth,
        folded: false,
      },
      {
        id: 'dart_bust_left',
        edgeIndex: 5,
        t: 0.66,
        widthMm: bustDartMm,
        depthMm: bustDartDepth,
        folded: false,
      },
      {
        id: 'dart_waist_front_right',
        edgeIndex: 4,
        t: 0.26,
        widthMm: Number(frontWaistDartEach.toFixed(2)),
        depthMm: frontWaistDartDepth,
        folded: false,
      },
      {
        id: 'dart_waist_front_left',
        edgeIndex: 4,
        t: 0.74,
        widthMm: Number(frontWaistDartEach.toFixed(2)),
        depthMm: frontWaistDartDepth,
        folded: false,
      },
    ],
    internalLines: [
      {
        id: 'fb_bust_level',
        name: 'Bust Apex Balance Line',
        type: 'stitch',
        points: [
          { x: cxFront - bustSpanMm * 0.5, y: armholeDepth + 32 },
          { x: cxFront + bustSpanMm * 0.5, y: armholeDepth + 32 },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 0, y: 155, z: 125 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const backBodice = {
    id: 'back_bodice',
    name: 'Back Bodice (Waist Darts)',
    role: 'back_bodice',
    quantity: 1,
    onFold: false,
    position: { x: frontBustW + 155, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: cxBack - neckW * 0.5, y: 0 },
      { x: cxBack + neckW * 0.5, y: 0 },
      { x: cxBack + shoulderWidthMm * 0.5, y: shoulderDrop },
      { x: backBustW, y: armholeDepth },
      { x: backBustW - backSideTaper, y: armholeDepth + backSideDrop },
      { x: backSideTaper, y: armholeDepth + backSideDrop },
      { x: 0, y: armholeDepth },
      { x: cxBack - shoulderWidthMm * 0.5, y: shoulderDrop },
    ],
    edges: [
      {
        name: 'Back Neckline',
        seamAllowance: sa,
        curve: {
          cp1: { x: cxBack - neckW * 0.25, y: backNeckDrop },
          cp2: { x: cxBack + neckW * 0.25, y: backNeckDrop },
        },
      },
      { name: 'Left Shoulder', seamAllowance: sa },
      {
        name: 'Left Armscye',
        seamAllowance: sa,
        curve: {
          cp1: { x: cxBack + shoulderWidthMm * 0.44, y: armholeDepth * 0.56 },
          cp2: { x: cp2xBack, y: armholeDepth * 0.92 },
        },
      },
      { name: 'Left Side Seam', seamAllowance: sa },
      { name: 'Back Waist Seam', seamAllowance: sa * 1.5 },
      { name: 'Right Side Seam', seamAllowance: sa },
      {
        name: 'Right Armscye',
        seamAllowance: sa,
        curve: {
          cp1: { x: backBustW - cp2xBack, y: armholeDepth * 0.92 },
          cp2: { x: cxBack - shoulderWidthMm * 0.44, y: armholeDepth * 0.56 },
        },
      },
      { name: 'Right Shoulder', seamAllowance: sa },
    ],
    notches: [
      { id: 'bb_cb_neck', edgeIndex: 0, t: 0.5, type: 'double' },
      { id: 'bb_l_arm', edgeIndex: 2, t: 0.55, type: 'double' },
      { id: 'bb_r_arm', edgeIndex: 6, t: 0.45, type: 'double' },
    ],
    darts: [
      {
        id: 'dart_waist_back_left',
        edgeIndex: 4,
        t: 0.28,
        widthMm: Number(backWaistDartEach.toFixed(2)),
        depthMm: backWaistDartDepth,
        folded: false,
      },
      {
        id: 'dart_waist_back_right',
        edgeIndex: 4,
        t: 0.72,
        widthMm: Number(backWaistDartEach.toFixed(2)),
        depthMm: backWaistDartDepth,
        folded: false,
      },
    ],
    internalLines: [
      {
        id: 'bb_cb_line',
        name: 'Center Back Plumb Line',
        type: 'stitch',
        points: [
          { x: cxBack, y: backNeckDrop + 12 },
          { x: cxBack, y: armholeDepth + backSideDrop - 12 },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: {
      offset: { x: 0, y: 155, z: -125 },
      normal: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    },
  };

  const makeSetInSleeve = (id, name, posX, posY, x3D, isRight) => {
    const w = bicepWidthMm;
    const underLen = Math.max(70, sleeveLengthMm - capH * 0.35);
    const cuffTaper = clamp(w * 0.11, 14, 48);
    return {
      id,
      name,
      role: 'sleeve',
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: [
        { x: 0, y: capH },
        { x: w * 0.5, y: 0 },
        { x: w, y: capH },
        { x: w - cuffTaper, y: capH + underLen },
        { x: cuffTaper, y: capH + underLen },
      ],
      edges: [
        {
          name: isRight ? 'Sleeve Cap (Front)' : 'Sleeve Cap (Back)',
          seamAllowance: sa,
          curve: {
            cp1: { x: w * 0.15, y: capH * 0.85 },
            cp2: { x: w * 0.32, y: capH * 0.08 },
          },
        },
        {
          name: isRight ? 'Sleeve Cap (Back)' : 'Sleeve Cap (Front)',
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
        { id: `${id}_crown`, edgeIndex: 0, t: 0.98, type: 'single' },
        { id: `${id}_cap_f`, edgeIndex: isRight ? 0 : 1, t: 0.5, type: 'single' },
        { id: `${id}_cap_b`, edgeIndex: isRight ? 1 : 0, t: 0.5, type: 'double' },
      ],
      darts: [],
      internalLines: [],
      grainline: { angleDeg: 90 },
      placement3D: {
        offset: { x: x3D, y: 235, z: 0 },
        normal: { x: Math.sign(x3D), y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
      },
    };
  };

  const row2Y = armholeDepth + Math.max(frontSideDrop, backSideDrop) + 100;
  const sleeveLeft = makeSetInSleeve('sleeve_left', 'Left Fitted Sleeve', 40, row2Y, -270, false);
  const sleeveRight = makeSetInSleeve('sleeve_right', 'Right Fitted Sleeve', bicepWidthMm + 100, row2Y, 270, true);

  const seams = [
    { id: 'seam_shoulder_right', name: 'Right Shoulder Seam', pieceA: 'front_bodice', edgeA: 1, pieceB: 'back_bodice', edgeB: 7, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_shoulder_left', name: 'Left Shoulder Seam', pieceA: 'front_bodice', edgeA: 7, pieceB: 'back_bodice', edgeB: 1, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_side_right', name: 'Right Side Seam (Bust-Darted)', pieceA: 'front_bodice', edgeA: 3, pieceB: 'back_bodice', edgeB: 5, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_side_left', name: 'Left Side Seam (Bust-Darted)', pieceA: 'front_bodice', edgeA: 5, pieceB: 'back_bodice', edgeB: 3, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_left_underarm', name: 'Left Sleeve Underarm', pieceA: 'sleeve_left', edgeA: 2, pieceB: 'sleeve_left', edgeB: 4, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_right_underarm', name: 'Right Sleeve Underarm', pieceA: 'sleeve_right', edgeA: 2, pieceB: 'sleeve_right', edgeB: 4, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_left_front_armhole', name: 'Left Sleeve to Front Armscye', pieceA: 'front_bodice', edgeA: 6, pieceB: 'sleeve_left', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_left_back_armhole', name: 'Left Sleeve to Back Armscye', pieceA: 'back_bodice', edgeA: 2, pieceB: 'sleeve_left', edgeB: 0, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_right_front_armhole', name: 'Right Sleeve to Front Armscye', pieceA: 'front_bodice', edgeA: 2, pieceB: 'sleeve_right', edgeB: 0, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sleeve_right_back_armhole', name: 'Right Sleeve to Back Armscye', pieceA: 'back_bodice', edgeA: 6, pieceB: 'sleeve_right', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
  ];

  return {
    id: `bodice_sloper_${Date.now()}`,
    name: "Women's Fitted Bodice Sloper",
    templateId: 'bodice_sloper',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'calico_muslin',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [frontBodice, backBodice, sleeveLeft, sleeveRight],
    seams,
  };
}

// ============================================================================
// 2. Women's Princess-Seam Bodice / Bustier (6 Contoured Panels)
// ============================================================================

export function generatePrincessBodicePattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const bustMm = clamp(finiteNum(userParams.chestMm ?? userParams.bustMm, 925), 680, 1800);
  const stdUnderbust = Math.round(bustMm * 0.838);
  const underbustMm = clamp(
    finiteNum(userParams.underbustMm, stdUnderbust),
    Math.max(440, Math.round(bustMm * 0.60)),
    Math.round(bustMm * 0.98)
  );
  const cupDeltaMm = (bustMm - underbustMm) - (bustMm - stdUnderbust);
  const frameBustMm = clamp(Math.round(underbustMm / 0.838), Math.round(bustMm * 0.78), Math.round(bustMm * 1.06));

  const waistMm = clamp(finiteNum(userParams.waistMm, Math.round(bustMm * 0.78)), 500, Math.max(540, bustMm + 60));
  const lengthMm = clamp(finiteNum(userParams.lengthMm ?? userParams.bodiceLengthMm, 415), 310, 720);
  const shoulderWidthMm = clamp(finiteNum(userParams.shoulderWidthMm, Math.round(frameBustMm * 0.415)), 280, 540);
  const bustSpanMm = clamp(finiteNum(userParams.bustSpanMm, Math.round(frameBustMm * 0.20)), 135, 300);
  const neckDropMm = clamp(finiteNum(userParams.frontNeckDropMm ?? userParams.neckDropMm, 95), 40, 185);
  const easeMm = clamp(finiteNum(userParams.easeMm, 36), 0, 260);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const p = {
    chestMm: bustMm,
    underbustMm,
    waistMm,
    lengthMm,
    shoulderWidthMm,
    bustSpanMm,
    frontNeckDropMm: neckDropMm,
    easeMm,
    seamAllowance,
  };

  const sa = seamAllowance;
  const halfBust = (bustMm + easeMm) * 0.5;
  const halfWaist = (waistMm + easeMm * 0.55) * 0.5;
  const fbaFrontShift = clamp(cupDeltaMm * 0.28, -20, 42);
  const frontBustHalf = halfBust + fbaFrontShift;
  const backBustHalf = Math.max(shoulderWidthMm + 16, 2 * halfBust - frontBustHalf);
  const shoulderDrop = 20;
  const armholeDepth = clamp(Math.round(lengthMm * 0.46), 155, 260);
  const sideLen = Math.max(135, lengthMm - armholeDepth);

  // Center Front Panel (shoulder-princess line passing over left & right bust apexes)
  const neckHalf = clamp(shoulderWidthMm * 0.235, 70, 125);
  const midShHalf = clamp((neckHalf + shoulderWidthMm * 0.5) * 0.5, neckHalf + 24, shoulderWidthMm * 0.5 - 24);
  const cfBustHalf = clamp(bustSpanMm * 0.52, 75, midShHalf + 18);
  const cfWaistHalf = clamp(halfWaist * 0.36, 62, cfBustHalf - 4);
  const cx = Math.max(midShHalf, cfBustHalf) + 10;

  const centerFront = {
    id: 'center_front_panel',
    name: 'Center Front Panel',
    role: 'front_center',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: 40 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: cx - neckHalf, y: 0 },
      { x: cx + neckHalf, y: 0 },
      { x: cx + midShHalf, y: shoulderDrop * 0.5 },
      { x: cx + cfWaistHalf, y: lengthMm },
      { x: cx - cfWaistHalf, y: lengthMm },
      { x: cx - midShHalf, y: shoulderDrop * 0.5 },
    ],
    edges: [
      {
        name: 'Sweetheart / Scoop Neckline',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx - neckHalf * 0.35, y: neckDropMm },
          cp2: { x: cx + neckHalf * 0.35, y: neckDropMm },
        },
      },
      { name: 'Right Inner Shoulder', seamAllowance: sa },
      {
        name: 'Right Princess Seam (CF)',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx + cfBustHalf + 8, y: armholeDepth * 0.92 },
          cp2: { x: cx + cfBustHalf, y: armholeDepth + sideLen * 0.36 },
        },
      },
      { name: 'Center Front Waist', seamAllowance: sa * 1.5 },
      {
        name: 'Left Princess Seam (CF)',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx - cfBustHalf, y: armholeDepth + sideLen * 0.36 },
          cp2: { x: cx - cfBustHalf - 8, y: armholeDepth * 0.92 },
        },
      },
      { name: 'Left Inner Shoulder', seamAllowance: sa },
    ],
    notches: [
      { id: 'cf_apex_r', edgeIndex: 2, t: 0.46, type: 'double' },
      { id: 'cf_apex_l', edgeIndex: 4, t: 0.54, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'cf_bust_line',
        name: 'Bust Apex Line',
        type: 'stitch',
        points: [
          { x: cx - cfBustHalf + 8, y: armholeDepth + 18 },
          { x: cx + cfBustHalf - 8, y: armholeDepth + 18 },
        ],
      },
    ],
    grainline: { angleDeg: 90 },
    placement3D: { offset: { x: 0, y: 155, z: 132 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  };

  const cfPrincessLen = edgeArcLength(
    centerFront.points[2],
    centerFront.points[3],
    centerFront.edges[2].curve
  );

  // Side Front & Side Back Panels (cup-projection aware bust curve + frame-balanced back)
  const outerShW = Math.max(24, shoulderWidthMm * 0.5 - midShHalf);
  const sfWaistW = Math.max(48, halfWaist * 0.5 - cfWaistHalf);
  const sfBustW = Math.max(sfWaistW + 14, frontBustHalf * 0.5 - cfBustHalf + 16);
  const sbBustW = Math.max(sfWaistW + 10, backBustHalf * 0.5 - cfBustHalf + 8);
  const frontPrincessEaseRatio = clamp(1.035 + cupDeltaMm * 0.00032, 1.012, 1.075);
  const truedSideSeamLen = Math.hypot(sbBustW - sfWaistW, sideLen);

  const buildSidePanel = (id, name, isBack, isLeft, posX, posY, x3D, z3D) => {
    const shY0 = shoulderDrop * 0.5;
    const shY1 = shoulderDrop;
    const targetCurveLen = isBack ? cfPrincessLen * 0.97 : cfPrincessLen * frontPrincessEaseRatio;
    // Solve princess bust/blade bow `bowX` (extending leftward `-bowX` into princess fullness)
    const baseX = 36;
    const evalCurveLen = (bow) =>
      edgeArcLength(
        { x: baseX, y: lengthMm },
        { x: baseX, y: shY0 },
        {
          cp1: { x: baseX - bow * 0.72, y: armholeDepth + sideLen * 0.36 },
          cp2: { x: baseX - bow, y: armholeDepth * 0.92 },
        },
        48
      );

    let bow = 8;
    let hiBow = 95;
    for (let it = 0; it < 22; it++) {
      const mid = (bow + hiBow) * 0.5;
      if (evalCurveLen(mid) < targetCurveLen) bow = mid;
      else hiBow = mid;
    }
    const finalBow = (bow + hiBow) * 0.5;
    const wBust = isBack ? sbBustW : sfBustW;
    const wTaper = wBust - sfWaistW;
    const outerSideDrop = isBack
      ? sideLen
      : Math.sqrt(Math.max(60 * 60, truedSideSeamLen * truedSideSeamLen - wTaper * wTaper));

    // Right-oriented points (CCW in y-down: top-left -> top-right -> armhole -> waist-right -> waist-left)
    const rawPts = [
      { x: baseX, y: shY0 },
      { x: baseX + outerShW, y: shY1 },
      { x: baseX + wBust, y: armholeDepth },
      { x: baseX + sfWaistW, y: Number((armholeDepth + outerSideDrop).toFixed(2)) },
      { x: baseX, y: lengthMm },
    ];
    const armCurve = {
      cp1: { x: baseX + outerShW + 4, y: armholeDepth * 0.58 },
      cp2: { x: baseX + wBust - 12, y: armholeDepth * 0.93 },
    };
    const princessCurve = {
      cp1: { x: baseX - finalBow * 0.72, y: armholeDepth + sideLen * 0.36 },
      cp2: { x: baseX - finalBow, y: armholeDepth * 0.92 },
    };

    if (!isLeft) {
      return {
        id,
        name,
        role: isBack ? 'side_back' : 'side_front',
        quantity: 1,
        onFold: false,
        position: { x: posX, y: posY },
        rotation: 0,
        seamAllowance: sa,
        points: rawPts,
        edges: [
          { name: 'Outer Shoulder', seamAllowance: sa },
          { name: 'Armscye Curve', seamAllowance: sa, curve: armCurve },
          { name: 'Side Seam', seamAllowance: sa },
          { name: 'Waist Hem', seamAllowance: sa * 1.5 },
          { name: 'Princess Bust Curve', seamAllowance: sa, curve: princessCurve },
        ],
        notches: [{ id: `${id}_apex`, edgeIndex: 4, t: 0.54, type: 'double' }],
        darts: [],
        internalLines: [],
        grainline: { angleDeg: 90 },
        placement3D: { offset: { x: x3D, y: 155, z: z3D }, normal: { x: 0, y: 0, z: isBack ? -1 : 1 }, up: { x: 0, y: 1, z: 0 } },
      };
    }

    // Mirror horizontally around maxX while keeping CCW winding (`reverse` order!)
    const mirrorAxis = baseX + wBust + 10;
    const mirPt = (pt) => ({ x: Number((mirrorAxis - pt.x).toFixed(3)), y: pt.y });
    const mPts = [
      mirPt(rawPts[1]), // 0: outer shoulder left
      mirPt(rawPts[0]), // 1: inner princess shoulder
      mirPt(rawPts[4]), // 2: inner princess waist
      mirPt(rawPts[3]), // 3: side waist
      mirPt(rawPts[2]), // 4: underarm
    ];
    return {
      id,
      name,
      role: isBack ? 'side_back' : 'side_front',
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: ensureCCW(mPts),
      edges: [
        { name: 'Outer Shoulder', seamAllowance: sa },
        {
          name: 'Princess Bust Curve',
          seamAllowance: sa,
          curve: {
            cp1: mirPt(princessCurve.cp2),
            cp2: mirPt(princessCurve.cp1),
          },
        },
        { name: 'Waist Hem', seamAllowance: sa * 1.5 },
        { name: 'Side Seam', seamAllowance: sa },
        {
          name: 'Armscye Curve',
          seamAllowance: sa,
          curve: {
            cp1: mirPt(armCurve.cp2),
            cp2: mirPt(armCurve.cp1),
          },
        },
      ],
      notches: [{ id: `${id}_apex`, edgeIndex: 1, t: 0.46, type: 'double' }],
      darts: [],
      internalLines: [],
      grainline: { angleDeg: 90 },
      placement3D: { offset: { x: x3D, y: 155, z: z3D }, normal: { x: 0, y: 0, z: isBack ? -1 : 1 }, up: { x: 0, y: 1, z: 0 } },
    };
  };

  const centerBack = {
    ...JSON.parse(JSON.stringify(centerFront)),
    id: 'center_back_panel',
    name: 'Center Back Panel',
    role: 'back_center',
    position: { x: 580, y: 40 },
    edges: [
      {
        name: 'Back Neckline',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx - neckHalf * 0.3, y: 22 },
          cp2: { x: cx + neckHalf * 0.3, y: 22 },
        },
      },
      { name: 'Left Inner Shoulder', seamAllowance: sa },
      {
        name: 'Left Back Princess Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx + cfBustHalf + 2, y: armholeDepth * 0.92 },
          cp2: { x: cx + cfBustHalf - 4, y: armholeDepth + sideLen * 0.36 },
        },
      },
      { name: 'Center Back Waist', seamAllowance: sa * 1.5 },
      {
        name: 'Right Back Princess Seam',
        seamAllowance: sa,
        curve: {
          cp1: { x: cx - cfBustHalf + 4, y: armholeDepth + sideLen * 0.36 },
          cp2: { x: cx - cfBustHalf - 2, y: armholeDepth * 0.92 },
        },
      },
      { name: 'Right Inner Shoulder', seamAllowance: sa },
    ],
    placement3D: { offset: { x: 0, y: 155, z: -132 }, normal: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
  };

  const sideFrontLeft = buildSidePanel('side_front_left', 'Side Front (Left)', false, true, 40, lengthMm + 95, -135, 118);
  const sideFrontRight = buildSidePanel('side_front_right', 'Side Front (Right)', false, false, 290, lengthMm + 95, 135, 118);
  const sideBackLeft = buildSidePanel('side_back_left', 'Side Back (Left)', true, false, 580, lengthMm + 95, -135, -118);
  const sideBackRight = buildSidePanel('side_back_right', 'Side Back (Right)', true, true, 830, lengthMm + 95, 135, -118);

  const seams = [
    // Front princess seams
    { id: 'seam_princess_front_right', name: 'Right Front Princess Seam', pieceA: 'center_front_panel', edgeA: 2, pieceB: 'side_front_right', edgeB: 4, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_princess_front_left', name: 'Left Front Princess Seam', pieceA: 'center_front_panel', edgeA: 4, pieceB: 'side_front_left', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    // Back princess seams (`center_back_panel` mirrored in 3D: edge 2 is Left, edge 4 is Right)
    { id: 'seam_princess_back_left', name: 'Left Back Princess Seam', pieceA: 'center_back_panel', edgeA: 2, pieceB: 'side_back_left', edgeB: 4, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_princess_back_right', name: 'Right Back Princess Seam', pieceA: 'center_back_panel', edgeA: 4, pieceB: 'side_back_right', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    // Inner & Outer Shoulders
    { id: 'seam_sh_inner_right', name: 'Right Inner Shoulder', pieceA: 'center_front_panel', edgeA: 1, pieceB: 'center_back_panel', edgeB: 5, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sh_inner_left', name: 'Left Inner Shoulder', pieceA: 'center_front_panel', edgeA: 5, pieceB: 'center_back_panel', edgeB: 1, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sh_outer_right', name: 'Right Outer Shoulder', pieceA: 'side_front_right', edgeA: 0, pieceB: 'side_back_right', edgeB: 0, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_sh_outer_left', name: 'Left Outer Shoulder', pieceA: 'side_front_left', edgeA: 0, pieceB: 'side_back_left', edgeB: 0, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    // Side Seams
    { id: 'seam_side_right', name: 'Right Side Seam', pieceA: 'side_front_right', edgeA: 2, pieceB: 'side_back_right', edgeB: 3, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_side_left', name: 'Left Side Seam', pieceA: 'side_front_left', edgeA: 3, pieceB: 'side_back_left', edgeB: 2, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
  ];

  return {
    id: `princess_bodice_${Date.now()}`,
    name: "Women's Princess-Seam Bodice",
    templateId: 'princess_bodice',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'cotton_sateen',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [centerFront, sideFrontLeft, sideFrontRight, centerBack, sideBackLeft, sideBackRight],
    seams,
  };
}

// ============================================================================
// 3. Women's A-Line Skirt + Contoured Waistband
// ============================================================================

export function generateALineSkirtPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const waistMm = clamp(finiteNum(userParams.waistMm, 730), 500, 1800);
  const hipMm = clamp(Math.max(finiteNum(userParams.hipMm, 1000), waistMm + 40), 580, 2100);
  const lengthMm = clamp(finiteNum(userParams.lengthMm ?? userParams.skirtLengthMm, 580), 320, 1050);
  const flareMm = clamp(finiteNum(userParams.hemWidthMm ?? userParams.flareMm, 115), 25, 340);
  const waistbandHeightMm = clamp(finiteNum(userParams.waistbandHeightMm, 40), 24, 95);
  const easeMm = clamp(finiteNum(userParams.easeMm, 36), 0, 240);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const p = {
    waistMm,
    hipMm,
    lengthMm,
    hemWidthMm: flareMm,
    waistbandHeightMm,
    easeMm,
    seamAllowance,
  };

  const sa = seamAllowance;
  const halfWaist = (waistMm + easeMm * 0.35) * 0.5;
  const halfHip = (hipMm + easeMm) * 0.5;
  const halfHem = halfHip + flareMm * 2;

  const frontDartW = clamp(Math.round((halfHip - halfWaist) * 0.16), 12, 28);
  const backDartW = clamp(Math.round((halfHip - halfWaist) * 0.22), 16, 36);

  const makeSkirtPanel = (id, name, dartW, dartDepth, posX, posY, z3D, normalZ) => {
    const rawWaistW = halfWaist + 2 * dartW;
    const cx = halfHem * 0.5;
    const waistLeft = cx - rawWaistW * 0.5;
    const waistRight = cx + rawWaistW * 0.5;
    const hemLift = clamp(flareMm * 0.16, 8, 32);

    const pts = [
      { x: waistLeft, y: 0 },
      { x: waistRight, y: 0 },
      { x: halfHem, y: lengthMm - hemLift },
      { x: 0, y: lengthMm - hemLift },
    ];
    const waistCurve = {
      cp1: { x: cx - rawWaistW * 0.22, y: 10 },
      cp2: { x: cx + rawWaistW * 0.22, y: 10 },
    };
    const hemCurve = {
      cp1: { x: halfHem * 0.68, y: lengthMm + hemLift * 0.45 },
      cp2: { x: halfHem * 0.32, y: lengthMm + hemLift * 0.45 },
    };
    const rightHipCurve = {
      cp1: { x: waistRight + (halfHem - waistRight) * 0.52, y: lengthMm * 0.32 },
      cp2: { x: halfHem - flareMm * 0.18, y: lengthMm * 0.68 },
    };
    const leftHipCurve = {
      cp1: { x: flareMm * 0.18, y: lengthMm * 0.68 },
      cp2: { x: waistLeft - waistLeft * 0.52, y: lengthMm * 0.32 },
    };

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
      edges: [
        { name: 'Waist Seam', seamAllowance: sa, curve: waistCurve },
        { name: 'Right Side Seam', seamAllowance: sa, curve: rightHipCurve },
        { name: 'Flared Sweep Hem', seamAllowance: sa * 2, curve: hemCurve },
        { name: 'Left Side Seam', seamAllowance: sa, curve: leftHipCurve },
      ],
      notches: [
        { id: `${id}_hip_r`, edgeIndex: 1, t: 0.34, type: normalZ > 0 ? 'single' : 'double' },
        { id: `${id}_hip_l`, edgeIndex: 3, t: 0.66, type: normalZ > 0 ? 'single' : 'double' },
      ],
      darts: [
        { id: `${id}_dart_r`, edgeIndex: 0, t: 0.28, widthMm: dartW, depthMm: dartDepth, folded: false },
        { id: `${id}_dart_l`, edgeIndex: 0, t: 0.72, widthMm: dartW, depthMm: dartDepth, folded: false },
      ],
      internalLines: [
        {
          id: `${id}_hipline`,
          name: 'Full Hip Balance Line',
          type: 'stitch',
          points: [
            { x: cx - halfHip * 0.44, y: Math.min(200, lengthMm * 0.36) },
            { x: cx + halfHip * 0.44, y: Math.min(200, lengthMm * 0.36) },
          ],
        },
      ],
      grainline: { angleDeg: 90 },
      placement3D: { offset: { x: 0, y: -180, z: z3D }, normal: { x: 0, y: 0, z: normalZ }, up: { x: 0, y: 1, z: 0 } },
    };
  };

  const skirtFront = makeSkirtPanel('skirt_front', 'A-Line Skirt Front', frontDartW, 95, 40, 40, 125, 1);
  const skirtBack = makeSkirtPanel('skirt_back', 'A-Line Skirt Back', backDartW, 125, halfHem + 90, 40, -125, -1);

  const netFrontWaist = Math.max(100, edgeArcLength(skirtFront.points[0], skirtFront.points[1], skirtFront.edges[0].curve) - 2 * frontDartW);
  const netBackWaist = Math.max(100, edgeArcLength(skirtBack.points[0], skirtBack.points[1], skirtBack.edges[0].curve) - 2 * backDartW);
  const wbLen = Math.round(netFrontWaist + netBackWaist);
  const fRatio = netFrontWaist / Math.max(1, wbLen);

  const waistband = {
    id: 'skirt_waistband',
    name: 'Contoured Waistband (Folded)',
    role: 'waistband',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: lengthMm + 100 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: wbLen, y: 0 },
      { x: wbLen, y: waistbandHeightMm * 2 },
      { x: 0, y: waistbandHeightMm * 2 },
    ],
    edges: [
      { name: 'Upper Fold Edge', seamAllowance: sa },
      { name: 'CB Closure Seam A', seamAllowance: sa },
      { name: 'Skirt Waist Attachment Seam', seamAllowance: sa },
      { name: 'CB Closure Seam B', seamAllowance: sa },
    ],
    notches: [
      { id: 'wb_cf', edgeIndex: 2, t: fRatio * 0.5, type: 'single' },
      { id: 'wb_side', edgeIndex: 2, t: fRatio, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'wb_fold',
        name: 'Top Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: waistbandHeightMm },
          { x: wbLen, y: waistbandHeightMm },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: { offset: { x: 0, y: 55, z: 145 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  };

  const seams = [
    { id: 'seam_skirt_side_right', name: 'Right Side Seam', pieceA: 'skirt_front', edgeA: 1, pieceB: 'skirt_back', edgeB: 3, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_skirt_side_left', name: 'Left Side Seam', pieceA: 'skirt_front', edgeA: 3, pieceB: 'skirt_back', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_front', name: 'Waistband to Skirt Front', pieceA: 'skirt_waistband', edgeA: 2, pieceB: 'skirt_front', edgeB: 0, reversed: false, allowEase: true, tStartA: 0, tEndA: fRatio, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_back', name: 'Waistband to Skirt Back', pieceA: 'skirt_waistband', edgeA: 2, pieceB: 'skirt_back', edgeB: 0, reversed: false, allowEase: true, tStartA: fRatio, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_cb_join', name: 'Waistband Center Back Closure', pieceA: 'skirt_waistband', edgeA: 1, pieceB: 'skirt_waistband', edgeB: 3, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
  ];

  return {
    id: `aline_skirt_${Date.now()}`,
    name: "Women's A-Line Skirt",
    templateId: 'aline_skirt',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'linen_flax',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [skirtFront, skirtBack, waistband],
    seams,
  };
}

// ============================================================================
// 4. Women's Tailored Pencil Skirt (Contoured Hip + 4 Waist Darts)
// ============================================================================

export function generatePencilSkirtPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const waistMm = clamp(finiteNum(userParams.waistMm, 730), 500, 1800);
  const hipMm = clamp(Math.max(finiteNum(userParams.hipMm, 1000), waistMm + 40), 580, 2100);
  const lengthMm = clamp(finiteNum(userParams.lengthMm ?? userParams.skirtLengthMm, 600), 380, 960);
  const taperMm = clamp(finiteNum(userParams.hemWidthMm ?? userParams.taperMm, 36), 0, 95);
  const waistbandHeightMm = clamp(finiteNum(userParams.waistbandHeightMm, 42), 24, 95);
  const easeMm = clamp(finiteNum(userParams.easeMm, 34), 0, 220);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const p = {
    waistMm,
    hipMm,
    lengthMm,
    hemWidthMm: taperMm,
    waistbandHeightMm,
    easeMm,
    seamAllowance,
  };

  const sa = seamAllowance;
  const halfWaist = (waistMm + easeMm * 0.35) * 0.5;
  const halfHip = (hipMm + easeMm) * 0.5;
  const hipDepth = clamp(Math.round(lengthMm * 0.34), 175, 225);
  const dartW = clamp(Math.round((halfHip - halfWaist) * 0.22), 14, 38);

  const makePencilPanel = (id, name, dartDepth, posX, posY, z3D, normalZ) => {
    const rawWaistW = halfWaist + 2 * dartW;
    const cx = halfHip * 0.5;
    const wLeft = Math.max(8, cx - rawWaistW * 0.5);
    const wRight = Math.min(halfHip - 8, cx + rawWaistW * 0.5);
    const safeTaper = clamp(taperMm, 0, halfHip * 0.22);

    return {
      id,
      name,
      role: id,
      quantity: 1,
      onFold: false,
      position: { x: posX, y: posY },
      rotation: 0,
      seamAllowance: sa,
      points: [
        { x: wLeft, y: 0 },
        { x: wRight, y: 0 },
        { x: halfHip, y: hipDepth },
        { x: halfHip - safeTaper, y: lengthMm },
        { x: safeTaper, y: lengthMm },
        { x: 0, y: hipDepth },
      ],
      edges: [
        {
          name: 'Waist Seam',
          seamAllowance: sa,
          curve: {
            cp1: { x: cx - rawWaistW * 0.22, y: 8 },
            cp2: { x: cx + rawWaistW * 0.22, y: 8 },
          },
        },
        {
          name: 'Right Upper Hip Curve',
          seamAllowance: sa,
          curve: {
            cp1: { x: wRight + (halfHip - wRight) * 0.72, y: hipDepth * 0.38 },
            cp2: { x: halfHip, y: hipDepth * 0.74 },
          },
        },
        { name: 'Right Lower Pencil Seam', seamAllowance: sa },
        { name: 'Pencil Hem', seamAllowance: 30 },
        { name: 'Left Lower Pencil Seam', seamAllowance: sa },
        {
          name: 'Left Upper Hip Curve',
          seamAllowance: sa,
          curve: {
            cp1: { x: 0, y: hipDepth * 0.74 },
            cp2: { x: wLeft - wLeft * 0.72, y: hipDepth * 0.38 },
          },
        },
      ],
      notches: [
        { id: `${id}_hip_r`, edgeIndex: 1, t: 0.95, type: normalZ > 0 ? 'single' : 'double' },
        { id: `${id}_hip_l`, edgeIndex: 5, t: 0.05, type: normalZ > 0 ? 'single' : 'double' },
      ],
      darts: [
        { id: `${id}_dart_r`, edgeIndex: 0, t: 0.28, widthMm: dartW, depthMm: dartDepth, folded: false },
        { id: `${id}_dart_l`, edgeIndex: 0, t: 0.72, widthMm: dartW, depthMm: dartDepth, folded: false },
      ],
      internalLines: [
        {
          id: `${id}_hipline`,
          name: 'Full Hip Balance Line',
          type: 'stitch',
          points: [
            { x: 14, y: hipDepth },
            { x: halfHip - 14, y: hipDepth },
          ],
        },
      ],
      grainline: { angleDeg: 90 },
      placement3D: { offset: { x: 0, y: -185, z: z3D }, normal: { x: 0, y: 0, z: normalZ }, up: { x: 0, y: 1, z: 0 } },
    };
  };

  const skirtFront = makePencilPanel('skirt_front', 'Pencil Skirt Front', 95, 40, 40, 125, 1);
  const skirtBack = makePencilPanel('skirt_back', 'Pencil Skirt Back', 130, halfHip + 90, 40, -125, -1);

  const netWaistEach = Math.max(100, edgeArcLength(skirtFront.points[0], skirtFront.points[1], skirtFront.edges[0].curve) - 2 * dartW);
  const wbLen = Math.round(netWaistEach * 2);

  const waistband = {
    id: 'skirt_waistband',
    name: 'Tailored Waistband',
    role: 'waistband',
    quantity: 1,
    onFold: false,
    position: { x: 40, y: lengthMm + 100 },
    rotation: 0,
    seamAllowance: sa,
    points: [
      { x: 0, y: 0 },
      { x: wbLen, y: 0 },
      { x: wbLen, y: waistbandHeightMm * 2 },
      { x: 0, y: waistbandHeightMm * 2 },
    ],
    edges: [
      { name: 'Upper Fold Edge', seamAllowance: sa },
      { name: 'CB Zip Closure A', seamAllowance: sa },
      { name: 'Skirt Waist Attachment Seam', seamAllowance: sa },
      { name: 'CB Zip Closure B', seamAllowance: sa },
    ],
    notches: [
      { id: 'pwb_cf', edgeIndex: 2, t: 0.25, type: 'single' },
      { id: 'pwb_side', edgeIndex: 2, t: 0.5, type: 'double' },
    ],
    darts: [],
    internalLines: [
      {
        id: 'pwb_fold',
        name: 'Top Fold Line',
        type: 'fold',
        points: [
          { x: 0, y: waistbandHeightMm },
          { x: wbLen, y: waistbandHeightMm },
        ],
      },
    ],
    grainline: { angleDeg: 0 },
    placement3D: { offset: { x: 0, y: 55, z: 145 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  };

  const seams = [
    { id: 'seam_hip_right', name: 'Right Upper Hip Seam', pieceA: 'skirt_front', edgeA: 1, pieceB: 'skirt_back', edgeB: 5, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_low_right', name: 'Right Lower Side Seam', pieceA: 'skirt_front', edgeA: 2, pieceB: 'skirt_back', edgeB: 4, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_hip_left', name: 'Left Upper Hip Seam', pieceA: 'skirt_front', edgeA: 5, pieceB: 'skirt_back', edgeB: 1, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_low_left', name: 'Left Lower Side Seam', pieceA: 'skirt_front', edgeA: 4, pieceB: 'skirt_back', edgeB: 2, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_front', name: 'Waistband to Front Waist', pieceA: 'skirt_waistband', edgeA: 2, pieceB: 'skirt_front', edgeB: 0, reversed: false, allowEase: true, tStartA: 0, tEndA: 0.5, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_back', name: 'Waistband to Back Waist', pieceA: 'skirt_waistband', edgeA: 2, pieceB: 'skirt_back', edgeB: 0, reversed: false, allowEase: true, tStartA: 0.5, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_wb_cb_join', name: 'Waistband Center Back Join', pieceA: 'skirt_waistband', edgeA: 1, pieceB: 'skirt_waistband', edgeB: 3, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
  ];

  return {
    id: `pencil_skirt_${Date.now()}`,
    name: "Women's Tailored Pencil Skirt",
    templateId: 'pencil_skirt',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'wool_crepe',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [skirtFront, skirtBack, waistband],
    seams,
  };
}

// ============================================================================
// 5. Women's Fit-and-Flare Dress (Darted Sleeveless Bodice + Flared Skirt)
// ============================================================================

export function generateFitAndFlareDressPattern(userParams = {}) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const bustMm = clamp(finiteNum(userParams.chestMm ?? userParams.bustMm, 925), 680, 1800);
  const stdUnderbust = Math.round(bustMm * 0.838);
  const underbustMm = clamp(
    finiteNum(userParams.underbustMm, stdUnderbust),
    Math.max(440, Math.round(bustMm * 0.60)),
    Math.round(bustMm * 0.98)
  );
  const frameBustMm = clamp(Math.round(underbustMm / 0.838), Math.round(bustMm * 0.78), Math.round(bustMm * 1.06));
  const waistMm = clamp(finiteNum(userParams.waistMm, Math.round(bustMm * 0.78)), 520, Math.max(560, bustMm + 60));
  const hipMm = clamp(Math.max(finiteNum(userParams.hipMm, 1000), waistMm + 40), 600, 2100);
  const bodiceLengthMm = clamp(finiteNum(userParams.lengthMm ?? userParams.bodiceLengthMm, 415), 320, 620);
  const skirtLengthMm = clamp(finiteNum(userParams.heightMm ?? userParams.skirtLengthMm, 540), 320, 980);
  const shoulderWidthMm = clamp(finiteNum(userParams.shoulderWidthMm, Math.round(frameBustMm * 0.40)), 280, 520);
  const flareMm = clamp(finiteNum(userParams.hemWidthMm ?? userParams.flareMm, 145), 40, 360);
  const easeMm = clamp(finiteNum(userParams.easeMm, 42), 0, 260);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const bodice = generateWomensBodiceSloper({
    chestMm: bustMm,
    underbustMm,
    waistMm,
    lengthMm: bodiceLengthMm,
    shoulderWidthMm,
    easeMm,
    seamAllowance,
  });

  const frontBodice = bodice.pieces[0];
  const backBodice = bodice.pieces[1];
  frontBodice.edges[4].seamAllowance = seamAllowance;
  backBodice.edges[4].seamAllowance = seamAllowance;

  const skirt = generateALineSkirtPattern({
    waistMm,
    hipMm,
    lengthMm: skirtLengthMm,
    hemWidthMm: flareMm,
    easeMm,
    seamAllowance,
  });
  const skirtFront = skirt.pieces[0];
  const skirtBack = skirt.pieces[1];
  skirtFront.name = 'Flared Dress Skirt (Front)';
  skirtBack.name = 'Flared Dress Skirt (Back)';
  const row2Y = Math.max(frontBodice.points[4].y, backBodice.points[4].y) + 170;
  skirtFront.position = { x: 40, y: row2Y };
  skirtBack.position = { x: skirtBack.position.x, y: row2Y };

  const p = {
    chestMm: bustMm,
    underbustMm,
    waistMm,
    hipMm,
    lengthMm: bodiceLengthMm,
    heightMm: skirtLengthMm,
    shoulderWidthMm,
    hemWidthMm: flareMm,
    easeMm,
    seamAllowance,
  };

  const seams = [
    { id: 'seam_shoulder_right', name: 'Right Shoulder Seam', pieceA: 'front_bodice', edgeA: 1, pieceB: 'back_bodice', edgeB: 7, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_shoulder_left', name: 'Left Shoulder Seam', pieceA: 'front_bodice', edgeA: 7, pieceB: 'back_bodice', edgeB: 1, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_bodice_side_right', name: 'Right Bodice Side Seam', pieceA: 'front_bodice', edgeA: 3, pieceB: 'back_bodice', edgeB: 5, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_bodice_side_left', name: 'Left Bodice Side Seam', pieceA: 'front_bodice', edgeA: 5, pieceB: 'back_bodice', edgeB: 3, reversed: true, allowEase: false, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    // Front & Back Waist Seams (`front_bodice` edge 4 runs Right->Left; `skirt_front` edge 0 runs Left->Right => `reversed: true`)
    { id: 'seam_dress_waist_front', name: 'Front Waistline Seam', pieceA: 'front_bodice', edgeA: 4, pieceB: 'skirt_front', edgeB: 0, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_dress_waist_back', name: 'Back Waistline Seam', pieceA: 'back_bodice', edgeA: 4, pieceB: 'skirt_back', edgeB: 0, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_skirt_side_right', name: 'Right Skirt Side Seam', pieceA: 'skirt_front', edgeA: 1, pieceB: 'skirt_back', edgeB: 3, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
    { id: 'seam_skirt_side_left', name: 'Left Skirt Side Seam', pieceA: 'skirt_front', edgeA: 3, pieceB: 'skirt_back', edgeB: 1, reversed: true, allowEase: true, tStartA: 0, tEndA: 1, tStartB: 0, tEndB: 1 },
  ];

  return {
    id: `fit_flare_dress_${Date.now()}`,
    name: "Women's Fit-and-Flare Dress",
    templateId: 'fit_flare_dress',
    version: SCHEMA_VERSION,
    unit: 'mm',
    displayUnit: 'mm',
    materialId: 'silk_charmeuse',
    material: null,
    avatar: null,
    stlMetadata: null,
    params: p,
    parameters: p,
    pieces: [frontBodice, backBodice, skirtFront, skirtBack],
    seams,
  };
}

// ============================================================================
// 6. Women's High-Waisted Wide-Leg Trousers (delegating base J-crotch solver)
// ============================================================================

export function generateWomensTrousersPattern(userParams = {}, generatePantsBaseFn) {
  userParams = userParams && typeof userParams === 'object' ? userParams : {};
  const waistMm = clamp(finiteNum(userParams.waistMm, 730), 500, 1800);
  const hipMm = clamp(Math.max(finiteNum(userParams.hipMm, 1000), waistMm + 40), 600, 2100);
  const inseamMm = clamp(finiteNum(userParams.inseamMm, 760), 350, 1100);
  const frontRiseMm = clamp(finiteNum(userParams.frontRiseMm, 295), 210, 460);
  const backRiseMm = clamp(finiteNum(userParams.backRiseMm, Math.max(frontRiseMm + 60, 360)), 250, 540);
  const ankleWidthMm = clamp(finiteNum(userParams.ankleWidthMm, 530), 280, 880);
  const waistbandHeightMm = clamp(finiteNum(userParams.waistbandHeightMm, 48), 28, 110);
  const easeMm = clamp(finiteNum(userParams.easeMm, 45), 0, 260);
  const seamAllowance = clamp(finiteNum(userParams.seamAllowance, 12), 0, 60);

  const pat = generatePantsBaseFn({
    waistMm,
    hipMm,
    inseamMm,
    frontRiseMm,
    backRiseMm,
    ankleWidthMm,
    waistbandHeightMm,
    easeMm,
    seamAllowance,
  });

  pat.id = `womens_trousers_${Date.now()}`;
  pat.name = "Women's High-Waisted Wide-Leg Trousers";
  pat.templateId = 'womens_trousers';
  pat.materialId = 'wool_crepe';
  return pat;
}
