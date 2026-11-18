/**
 * Sub-stepped XPBD 3D Cloth & Sewing Solver, Parametric Dress-Form Avatar,
 * Median-Split AABB BVH STL Triangle-Mesh Collider, and Strain/Fit Analyzer.
 * Isomorphic pure ES module (Node.js v24 + browsers).
 */

import {
  DEFAULT_AVATAR_MEASUREMENTS,
  UNIT_FACTORS,
  ValidationError,
  isValidUnit,
} from './types.mjs';
import {
  vec2,
  sub2,
  dot2,
  dist2D,
  vec3,
  add3,
  sub3,
  scale3,
  dot3,
  cross3,
  len3,
  dist3,
  norm3,
  evalEdgeAt,
  buildEdgeArcTable,
  tAtArcLength,
  signedPolygonArea,
  polygonBounds,
  polygonCentroid,
  samplePieceOutline,
  generateClothMesh2D,
} from './geometry.mjs';
import { MATERIAL_PRESETS, getMaterialConfig } from './materials.mjs';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

const MAX_SIM_STEPS = 10000;

function finiteOr(v, fallback) {
  if (
    v === null ||
    v === undefined ||
    typeof v === 'boolean' ||
    typeof v === 'symbol' ||
    typeof v === 'bigint' ||
    typeof v === 'object'
  ) {
    return fallback;
  }
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function validateSimSteps(rawSteps, defaultSteps) {
  if (rawSteps === undefined || rawSteps === null) return defaultSteps;
  if (
    (typeof rawSteps === 'number' && !Number.isFinite(rawSteps) && !Number.isNaN(rawSteps)) ||
    (typeof rawSteps === 'string' &&
      rawSteps.trim() !== '' &&
      !Number.isFinite(Number(rawSteps)) &&
      !Number.isNaN(Number(rawSteps)))
  ) {
    throw new ValidationError(`Simulation steps must be a finite number <= ${MAX_SIM_STEPS}.`, {
      code: 'INVALID_OPTIONS',
      path: 'steps',
    });
  }
  const parsed = finiteOr(rawSteps, defaultSteps);
  if (parsed > MAX_SIM_STEPS) {
    throw new ValidationError(
      `Simulation steps (${Math.trunc(parsed)}) exceeds maximum allowed limit (${MAX_SIM_STEPS}).`,
      {
        code: 'INVALID_OPTIONS',
        path: 'steps',
      }
    );
  }
  return Math.max(0, Math.trunc(parsed));
}

// ============================================================================
// Parametric Dress-Form Avatar (F19)
// ============================================================================

function resolveDimMm(params, mmKey, cmKey, defaultMm, minMm, maxMm) {
  const rawMm = finiteOr(params?.[mmKey], NaN);
  if (Number.isFinite(rawMm) && rawMm > 0) return clamp(rawMm, minMm, maxMm);
  const rawCm = finiteOr(params?.[cmKey], NaN);
  if (Number.isFinite(rawCm) && rawCm > 0) return clamp(rawCm * 10, minMm, maxMm);
  return defaultMm;
}

function ellipseRadiiFromCircumference(circMm, aspect) {
  const rSum = circMm / Math.PI;
  const rz = rSum / (1 + aspect);
  const rx = rSum - rz;
  return { rx, rz };
}

export function createParametricAvatar(avatarParams = {}) {
  const p = avatarParams && typeof avatarParams === 'object' ? avatarParams : {};
  const isWomens = Boolean(
    p.bodyType === 'womens' ||
    p.underbustMm !== undefined ||
    p.highHipMm !== undefined ||
    p.bustSpanMm !== undefined ||
    p.shoulderToBustMm !== undefined
  );

  const chestMm = resolveDimMm(p, 'chestMm', 'chestCm', DEFAULT_AVATAR_MEASUREMENTS.chestMm, 300, 2200);
  const waistMm = resolveDimMm(p, 'waistMm', 'waistCm', DEFAULT_AVATAR_MEASUREMENTS.waistMm, 250, 2100);
  const hipMm = resolveDimMm(p, 'hipMm', 'hipCm', DEFAULT_AVATAR_MEASUREMENTS.hipMm, 300, 2300);
  const defaultShoulderRatio = isWomens
    ? 386 / 925
    : DEFAULT_AVATAR_MEASUREMENTS.shoulderWidthMm / DEFAULT_AVATAR_MEASUREMENTS.chestMm;
  const defaultShoulderMm = chestMm * defaultShoulderRatio;
  const shoulderWidthMm = resolveDimMm(
    p,
    'shoulderWidthMm',
    'shoulderWidthCm',
    defaultShoulderMm,
    150,
    900
  );
  const heightMm = resolveDimMm(
    p,
    'heightMm',
    'heightCm',
    isWomens ? 1680 : DEFAULT_AVATAR_MEASUREMENTS.heightMm,
    600,
    2500
  );
  const neckMm = resolveDimMm(
    p,
    'neckMm',
    'neckCm',
    Math.max(isWomens ? 245 : 260, chestMm * (isWomens ? 0.375 : 0.398)),
    180,
    750
  );
  const underbustMm = resolveDimMm(
    p,
    'underbustMm',
    'underbustCm',
    Math.round(chestMm * 0.84),
    240,
    2100
  );
  const highHipMm = resolveDimMm(
    p,
    'highHipMm',
    'highHipCm',
    Math.round(waistMm * 0.32 + hipMm * 0.68),
    280,
    2250
  );
  const bustSpanMm = resolveDimMm(
    p,
    'bustSpanMm',
    'bustSpanCm',
    Math.round(chestMm * 0.20),
    100,
    440
  );
  const shoulderToBustMm = resolveDimMm(
    p,
    'shoulderToBustMm',
    'shoulderToBustCm',
    Math.round(260 * (heightMm / 1680)),
    140,
    460
  );

  const measurements = {
    bodyType: isWomens ? 'womens' : 'standard',
    chestMm,
    underbustMm,
    waistMm,
    highHipMm,
    hipMm,
    shoulderWidthMm,
    bustSpanMm,
    shoulderToBustMm,
    heightMm,
    neckMm,
    chestCm: Number((chestMm / 10).toFixed(1)),
    waistCm: Number((waistMm / 10).toFixed(1)),
    hipCm: Number((hipMm / 10).toFixed(1)),
    shoulderWidthCm: Number((shoulderWidthMm / 10).toFixed(1)),
    heightCm: Number((heightMm / 10).toFixed(1)),
  };

  const chestR = ellipseRadiiFromCircumference(chestMm, isWomens ? 1.28 : 1.38);
  const underbustR = ellipseRadiiFromCircumference(underbustMm, 1.34);
  const ribCageR = isWomens
    ? ellipseRadiiFromCircumference(underbustMm * 0.58 + chestMm * 0.42, 1.34)
    : chestR;
  const waistR = ellipseRadiiFromCircumference(waistMm, isWomens ? 1.28 : 1.32);
  const highHipR = ellipseRadiiFromCircumference(highHipMm, 1.35);
  const hipR = ellipseRadiiFromCircumference(hipMm, isWomens ? 1.38 : 1.36);
  const neckR = ellipseRadiiFromCircumference(neckMm, 1.06);

  const hScale = isWomens ? heightMm / 1680 : heightMm / 1750;
  const yAt = (yBase) => (isWomens ? yBase * hScale : 40 + (yBase - 40) * hScale);
  const shoulderHalf = Math.max(ribCageR.rx * 0.98, shoulderWidthMm * 0.5);

  // True 1:1 couturier vertical proportions for women's dress form:
  // HPS +385 -> Bust +152 -> Underbust +82 -> Natural Waist -25 (~415mm bodice)
  // -> High Hip -125 -> Full Hip -225 (200mm below waist) -> Crotch/Pelvis -292 -> Floor -1080
  const keyStations = isWomens
    ? [
        { y: yAt(-292), rx: hipR.rx * 0.68, rz: hipR.rz * 0.68, cz: -5 * hScale },
        { y: yAt(-258), rx: hipR.rx * 0.94, rz: hipR.rz * 0.94, cz: -8 * hScale },
        { y: yAt(-225), rx: hipR.rx, rz: hipR.rz * 1.02, cz: -9 * hScale },
        { y: yAt(-125), rx: highHipR.rx, rz: highHipR.rz, cz: -4 * hScale },
        { y: yAt(-25), rx: waistR.rx, rz: waistR.rz, cz: 0 },
        { y: yAt(82), rx: underbustR.rx, rz: underbustR.rz, cz: 3 * hScale },
        { y: yAt(156), rx: ribCageR.rx, rz: ribCageR.rz, cz: 6 * hScale },
        { y: yAt(252), rx: Math.max(ribCageR.rx * 0.94, shoulderHalf * 0.88), rz: ribCageR.rz * 0.84, cz: 2 * hScale },
        { y: yAt(336), rx: shoulderHalf * 0.96, rz: ribCageR.rz * 0.68, cz: -1 * hScale },
        { y: yAt(372), rx: neckR.rx * 0.5 + shoulderHalf * 0.38, rz: neckR.rz * 1.12, cz: -2 * hScale },
        { y: yAt(396), rx: neckR.rx * 1.02, rz: neckR.rz * 1.02, cz: -1 * hScale },
        { y: yAt(442), rx: neckR.rx * 0.92, rz: neckR.rz * 0.92, cz: 0 },
      ]
    : [
        { y: yAt(-195), rx: hipR.rx * 0.74, rz: hipR.rz * 0.74, cz: -4 * hScale },
        { y: yAt(-148), rx: hipR.rx * 0.95, rz: hipR.rz * 0.95, cz: -6 * hScale },
        { y: yAt(-92), rx: hipR.rx, rz: hipR.rz, cz: -7 * hScale },
        { y: yAt(-28), rx: hipR.rx * 0.6 + waistR.rx * 0.4, rz: hipR.rz * 0.58 + waistR.rz * 0.42, cz: -3 * hScale },
        { y: yAt(42), rx: waistR.rx, rz: waistR.rz, cz: 0 },
        { y: yAt(118), rx: waistR.rx * 0.42 + chestR.rx * 0.58, rz: waistR.rz * 0.46 + chestR.rz * 0.54, cz: 4 * hScale },
        { y: yAt(192), rx: chestR.rx, rz: chestR.rz * 1.04, cz: 9 * hScale },
        { y: yAt(248), rx: Math.max(chestR.rx * 0.96, shoulderHalf * 0.88), rz: chestR.rz * 0.86, cz: 4 * hScale },
        { y: yAt(288), rx: shoulderHalf * 0.95, rz: chestR.rz * 0.7, cz: -1 * hScale },
        { y: yAt(314), rx: neckR.rx * 0.48 + shoulderHalf * 0.42, rz: neckR.rz * 1.16, cz: -2 * hScale },
        { y: yAt(338), rx: neckR.rx * 1.04, rz: neckR.rz * 1.04, cz: -1 * hScale },
        { y: yAt(392), rx: neckR.rx * 0.93, rz: neckR.rz * 0.93, cz: 0 },
      ];

  // Sub-sample into smooth cosine-interpolated anatomical loft stations
  const torsoStations = [];
  const subsPerSeg = 3;
  for (let i = 0; i < keyStations.length - 1; i++) {
    const a = keyStations[i];
    const b = keyStations[i + 1];
    const count = i === keyStations.length - 2 ? subsPerSeg + 1 : subsPerSeg;
    for (let k = 0; k < count; k++) {
      const u = k / subsPerSeg;
      const s = 0.5 - 0.5 * Math.cos(u * Math.PI);
      torsoStations.push({
        y: a.y + (b.y - a.y) * u,
        rx: a.rx + (b.rx - a.rx) * s,
        rz: a.rz + (b.rz - a.rz) * s,
        cz: a.cz + (b.cz - a.cz) * s,
      });
    }
  }

  // True 40-degree A-pose tapered arm capsules & anatomical leg/head capsules
  const armAngleRad = (40 * Math.PI) / 180;
  const sinA = Math.sin(armAngleRad);
  const cosA = Math.cos(armAngleRad);
  const shPivotX = shoulderHalf * 0.85;
  const shPivotY = isWomens ? yAt(304) : yAt(252);
  const shPivotZ = -1 * hScale;
  const upperArmLen = (isWomens ? 268 : 252) * hScale;
  const foreArmLen = (isWomens ? 242 : 228) * hScale;
  const rShoulder = clamp(chestMm * 0.044, 34, 49);
  const rElbow = rShoulder * 0.78;
  const rWrist = rShoulder * 0.6;

  const legX = hipR.rx * 0.48;
  const rThigh = clamp(hipR.rx * 0.48, 52, 92);
  const rKnee = rThigh * 0.73;
  const rAnkle = rThigh * 0.52;
  const rHead = clamp(neckR.rx * 1.28, 62, 84);

  const capsules = [];
  for (const side of [-1, 1]) {
    const pSh = vec3(side * shPivotX, shPivotY, shPivotZ);
    const pEl = vec3(
      side * (shPivotX + sinA * upperArmLen),
      shPivotY - cosA * upperArmLen,
      shPivotZ + 8 * hScale
    );
    const pWr = vec3(
      side * (shPivotX + sinA * (upperArmLen + foreArmLen * 0.92)),
      pEl.y - cosA * foreArmLen,
      pEl.z + 20 * hScale
    );
    capsules.push(
      { name: side < 0 ? 'upper_arm_left' : 'upper_arm_right', a: pSh, b: pEl, rA: rShoulder, rB: rElbow },
      { name: side < 0 ? 'fore_arm_left' : 'fore_arm_right', a: pEl, b: pWr, rA: rElbow, rB: rWrist }
    );

    const pHip = vec3(side * legX, isWomens ? yAt(-255) : yAt(-150), -4 * hScale);
    const pKnee = vec3(side * (legX * 1.03), isWomens ? yAt(-625) : yAt(-510), 6 * hScale);
    const pAnk = vec3(side * (legX * 1.03), isWomens ? yAt(-995) : yAt(-860), -2 * hScale);
    capsules.push(
      { name: side < 0 ? 'thigh_left' : 'thigh_right', a: pHip, b: pKnee, rA: rThigh, rB: rKnee },
      { name: side < 0 ? 'calf_left' : 'calf_right', a: pKnee, b: pAnk, rA: rKnee, rB: rAnkle }
    );
  }
  capsules.push({
    name: 'head',
    a: vec3(0, isWomens ? yAt(488) : yAt(442), 2 * hScale),
    b: vec3(0, isWomens ? yAt(545) : yAt(496), 4 * hScale),
    rA: rHead * 0.94,
    rB: rHead,
  });

  // Sculpted anatomical twin bust mounds for women's dress form (SDF collision + surface metadata)
  let bustGeometry = null;
  if (isWomens) {
    const cupDiff = Math.max(28, chestMm - underbustMm);
    const rBust = clamp(cupDiff * 0.44, 44, 92);
    const yBustApex = clamp(yAt(386) - shoulderToBustMm * 0.9, yAt(118), yAt(196));
    const xBustApex = clamp(bustSpanMm * 0.5, 52, ribCageR.rx * 0.76);
    const zBustCenter = ribCageR.rz * 0.56 + 6 * hScale;
    const zBustApex = zBustCenter + rBust;
    for (const side of [-1, 1]) {
      const cTop = vec3(side * xBustApex * 0.94, yBustApex + 14 * hScale, zBustCenter - 8 * hScale);
      const cApex = vec3(side * xBustApex, yBustApex - 4 * hScale, zBustCenter);
      capsules.push({
        name: side < 0 ? 'bust_left' : 'bust_right',
        a: cTop,
        b: cApex,
        rA: rBust * 0.82,
        rB: rBust,
      });
    }
    bustGeometry = {
      isWomens: true,
      xBustApex,
      yBustApex,
      zBustCenter,
      zBustApex,
      rBust,
      yHps: yAt(386),
      yUnderbust: yAt(82),
      yWaist: yAt(-25),
      yHighHip: yAt(-125),
      yFullHip: yAt(-225),
    };
  }

  const radialSegments = 32;
  const vertices = [];
  const triangles = [];

  for (const st of torsoStations) {
    for (let j = 0; j < radialSegments; j++) {
      const ang = (j / radialSegments) * Math.PI * 2;
      vertices.push(vec3(Math.cos(ang) * st.rx, st.y, st.cz + Math.sin(ang) * st.rz));
    }
  }

  for (let s = 0; s < torsoStations.length - 1; s++) {
    const row0 = s * radialSegments;
    const row1 = (s + 1) * radialSegments;
    for (let j = 0; j < radialSegments; j++) {
      const jNext = (j + 1) % radialSegments;
      const a = row0 + j;
      const b = row0 + jNext;
      const c = row1 + jNext;
      const d = row1 + j;
      triangles.push([a, c, b], [a, d, c]);
    }
  }

  const bottomPole = vertices.length;
  vertices.push(vec3(0, torsoStations[0].y, torsoStations[0].cz));
  const topPole = vertices.length;
  const lastSt = torsoStations[torsoStations.length - 1];
  vertices.push(vec3(0, lastSt.y, lastSt.cz));
  const topRow = (torsoStations.length - 1) * radialSegments;
  for (let j = 0; j < radialSegments; j++) {
    const jNext = (j + 1) % radialSegments;
    triangles.push([bottomPole, j, jNext]);
    triangles.push([topPole, topRow + jNext, topRow + j]);
  }

  // Append tapered capsule limb & head geometry into unified avatar mesh
  const appendCapsuleToAvatarMesh = (cap, segRad = 16, segCap = 4) => {
    const ab = sub3(cap.b, cap.a);
    const L = len3(ab);
    if (L < 1e-4) return;
    const axis = scale3(ab, 1 / L);
    const refUp = Math.abs(axis.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    const t1 = norm3(cross3(axis, refUp));
    const t2 = norm3(cross3(axis, t1));

    const rings = [];
    for (let k = segCap; k >= 1; k--) {
      const phi = (k / segCap) * (Math.PI * 0.5);
      rings.push({
        center: sub3(cap.a, scale3(axis, Math.sin(phi) * cap.rA)),
        r: Math.max(0.4, Math.cos(phi) * cap.rA),
      });
    }
    const bodySlices = 4;
    for (let k = 0; k <= bodySlices; k++) {
      const u = k / bodySlices;
      rings.push({
        center: add3(cap.a, scale3(ab, u)),
        r: cap.rA + (cap.rB - cap.rA) * u,
      });
    }
    for (let k = 1; k <= segCap; k++) {
      const phi = (k / segCap) * (Math.PI * 0.5);
      rings.push({
        center: add3(cap.b, scale3(axis, Math.sin(phi) * cap.rB)),
        r: Math.max(0.4, Math.cos(phi) * cap.rB),
      });
    }

    const baseV = vertices.length;
    for (const rg of rings) {
      for (let j = 0; j < segRad; j++) {
        const ang = (j / segRad) * Math.PI * 2;
        const radial = add3(scale3(t1, Math.cos(ang) * rg.r), scale3(t2, Math.sin(ang) * rg.r));
        vertices.push(add3(rg.center, radial));
      }
    }
    for (let s = 0; s < rings.length - 1; s++) {
      const r0 = baseV + s * segRad;
      const r1 = baseV + (s + 1) * segRad;
      for (let j = 0; j < segRad; j++) {
        const jn = (j + 1) % segRad;
        triangles.push([r0 + j, r1 + jn, r0 + jn], [r0 + j, r1 + j, r1 + jn]);
      }
    }
  };

  for (const cap of capsules) {
    appendCapsuleToAvatarMesh(cap, 16, 4);
  }

  // Smooth vertex normals
  const normals = vertices.map(() => vec3(0, 0, 0));
  for (const [i0, i1, i2] of triangles) {
    const cr = cross3(sub3(vertices[i1], vertices[i0]), sub3(vertices[i2], vertices[i0]));
    normals[i0] = add3(normals[i0], cr);
    normals[i1] = add3(normals[i1], cr);
    normals[i2] = add3(normals[i2], cr);
  }
  for (let i = 0; i < normals.length; i++) {
    normals[i] = len3(normals[i]) > 1e-6 ? norm3(normals[i]) : vec3(0, 1, 0);
  }

  const colliders = [
    { name: 'neck', center: vec3(0, isWomens ? yAt(408) : yAt(365), 0), radii: vec3(neckR.rx + 4, 48 * hScale, neckR.rz + 4) },
    { name: 'shoulders', center: vec3(0, isWomens ? yAt(336) : yAt(285), 0), radii: vec3(shoulderHalf, 62 * hScale, chestR.rz * 0.86) },
    { name: 'chest', center: vec3(0, isWomens ? yAt(156) : yAt(190), 8 * hScale), radii: vec3(chestR.rx + 3, 98 * hScale, chestR.rz * 1.04 + 3) },
    { name: 'waist', center: vec3(0, isWomens ? yAt(-25) : yAt(42), 0), radii: vec3(waistR.rx + 3, 92 * hScale, waistR.rz + 3) },
    { name: 'hip', center: vec3(0, isWomens ? yAt(-225) : yAt(-92), -6 * hScale), radii: vec3(hipR.rx + 3, 105 * hScale, hipR.rz + 3) },
    { name: 'arm_left', center: vec3(-(shPivotX + sinA * 120 * hScale), shPivotY - cosA * 120 * hScale, 0), radii: vec3(62, 95 * hScale, 56) },
    { name: 'arm_right', center: vec3(shPivotX + sinA * 120 * hScale, shPivotY - cosA * 120 * hScale, 0), radii: vec3(62, 95 * hScale, 56) },
    { name: 'leg_left', center: vec3(-legX, isWomens ? yAt(-440) : yAt(-340), 0), radii: vec3(rThigh, 260 * hScale, rThigh) },
    { name: 'leg_right', center: vec3(legX, isWomens ? yAt(-440) : yAt(-340), 0), radii: vec3(rThigh, 260 * hScale, rThigh) },
  ];

  const armPose = {
    isWomens,
    angleRad: armAngleRad,
    shoulderPivotX: shPivotX,
    shoulderPivotY: shPivotY,
    shoulderPivotZ: shPivotZ,
    upperArmLen,
    foreArmLen,
    rShoulder,
    rElbow,
    rWrist,
    legX,
    rThigh,
    hScale,
    yHps: isWomens ? yAt(386) : yAt(328),
    yWaist: isWomens ? yAt(-25) : yAt(46),
    yFullHip: isWomens ? yAt(-225) : yAt(-92),
    chestRx: chestR.rx,
    chestRz: bustGeometry ? Math.max(chestR.rz, bustGeometry.zBustApex) : chestR.rz,
    waistRx: waistR.rx,
    waistRz: waistR.rz,
    hipRx: hipR.rx,
    hipRz: hipR.rz,
    neckRx: neckR.rx,
    neckRz: neckR.rz,
  };

  return {
    measurements,
    vertices,
    triangles,
    faces: triangles,
    normals,
    colliders,
    torsoStations,
    capsules,
    armPose,
    bustGeometry,
    floorY: isWomens ? yAt(-1085) : yAt(-980),
  };
}

function sampleTorsoProfileAtY(torsoStations, y) {
  const n = torsoStations.length;
  if (n === 0) return { rx: 140, rz: 100, cz: 0, drxDy: 0, drzDy: 0 };
  if (y <= torsoStations[0].y) return { ...torsoStations[0], drxDy: 0, drzDy: 0 };
  if (y >= torsoStations[n - 1].y) return { ...torsoStations[n - 1], drxDy: 0, drzDy: 0 };
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (torsoStations[mid].y <= y) lo = mid;
    else hi = mid;
  }
  const a = torsoStations[lo];
  const b = torsoStations[hi];
  const span = Math.max(1e-5, b.y - a.y);
  const t = clamp((y - a.y) / span, 0, 1);
  return {
    rx: a.rx + (b.rx - a.rx) * t,
    rz: a.rz + (b.rz - a.rz) * t,
    cz: a.cz + (b.cz - a.cz) * t,
    drxDy: (b.rx - a.rx) / span,
    drzDy: (b.rz - a.rz) / span,
  };
}

function projectPointOutsideAvatarSDF(avatar, pxIn, pyIn, pzIn, clearanceMm) {
  const st = avatar.torsoStations;
  const caps = avatar.capsules;
  let px = pxIn;
  let py = pyIn;
  let pz = pzIn;
  let pushed = false;
  let lastNx = 0;
  let lastNy = 1;
  let lastNz = 0;

  for (let pass = 0; pass < 2; pass++) {
    // 1. Smooth anatomical torso + neck loft (zero allocation)
    if (Array.isArray(st) && st.length >= 2) {
      const nSt = st.length;
      const yMin = st[0].y;
      const yMax = st[nSt - 1].y;
      if (py >= yMin - clearanceMm && py <= yMax + clearanceMm) {
        const yc = py < yMin ? yMin : py > yMax ? yMax : py;
        let profRx, profRz, profCz, drxDy = 0, drzDy = 0;
        if (yc <= yMin) {
          profRx = st[0].rx; profRz = st[0].rz; profCz = st[0].cz;
        } else if (yc >= yMax) {
          profRx = st[nSt - 1].rx; profRz = st[nSt - 1].rz; profCz = st[nSt - 1].cz;
        } else {
          let lo = 0;
          let hi = nSt - 1;
          while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (st[mid].y <= yc) lo = mid;
            else hi = mid;
          }
          const a = st[lo];
          const b = st[hi];
          const span = Math.max(1e-5, b.y - a.y);
          const t = (yc - a.y) / span;
          profRx = a.rx + (b.rx - a.rx) * t;
          profRz = a.rz + (b.rz - a.rz) * t;
          profCz = a.cz + (b.cz - a.cz) * t;
          drxDy = (b.rx - a.rx) / span;
          drzDy = (b.rz - a.rz) / span;
        }

        const capFade =
          py < yMin
            ? Math.max(0, 1 - ((yMin - py) / Math.max(1e-3, clearanceMm)) ** 2)
            : py > yMax
              ? Math.max(0, 1 - ((py - yMax) / Math.max(1e-3, clearanceMm)) ** 2)
              : 1;
        if (capFade > 0) {
          const fadeSqrt = capFade === 1 ? 1 : Math.sqrt(capFade);
          const rx = Math.max(2, (profRx + clearanceMm) * fadeSqrt);
          const rz = Math.max(2, (profRz + clearanceMm) * fadeSqrt);
          const dx = px / rx;
          const dz = (pz - profCz) / rz;
          const d2 = dx * dx + dz * dz;
          if (d2 < 1.0) {
            pushed = true;
            if (d2 > 1e-8) {
              const inv = 1 / Math.sqrt(d2);
              px = dx * inv * rx;
              pz = profCz + dz * inv * rz;
              const nySlope = clamp(-(Math.abs(dx) * drxDy + Math.abs(dz) * drzDy) * 0.45, -0.4, 0.85);
              const gx = dx / rx;
              const gz = dz / rz;
              const gl = Math.hypot(gx, nySlope, gz) || 1;
              lastNx = gx / gl;
              lastNy = nySlope / gl;
              lastNz = gz / gl;
            } else {
              pz = profCz + rz;
              lastNx = 0; lastNy = 0; lastNz = 1;
            }
          }
        }
      }
    }

    // 2. Tapered limb & head capsules (zero allocation)
    if (Array.isArray(caps)) {
      for (let ci = 0; ci < caps.length; ci++) {
        const cap = caps[ci];
        const abx = cap.b.x - cap.a.x;
        const aby = cap.b.y - cap.a.y;
        const abz = cap.b.z - cap.a.z;
        const abLenSq = abx * abx + aby * aby + abz * abz;
        const rawT =
          abLenSq > 1e-6
            ? ((px - cap.a.x) * abx + (py - cap.a.y) * aby + (pz - cap.a.z) * abz) / abLenSq
            : 0;
        const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;
        const qx = cap.a.x + abx * t;
        const qy = cap.a.y + aby * t;
        const qz = cap.a.z + abz * t;
        const r = Math.max(2, cap.rA + (cap.rB - cap.rA) * t + clearanceMm);
        const rxVec = px - qx;
        const ryVec = py - qy;
        const rzVec = pz - qz;
        const distSq = rxVec * rxVec + ryVec * ryVec + rzVec * rzVec;
        if (distSq < r * r) {
          pushed = true;
          if (distSq > 1e-8) {
            const invD = 1 / Math.sqrt(distSq);
            const nx = rxVec * invD;
            const ny = ryVec * invD;
            const nz = rzVec * invD;
            px = qx + nx * r;
            py = qy + ny * r;
            pz = qz + nz * r;
            lastNx = nx; lastNy = ny; lastNz = nz;
          } else {
            pz = qz + r;
            lastNx = 0; lastNy = 0; lastNz = 1;
          }
        }
      }
    }
  }

  return pushed ? { px, py, pz, nx: lastNx, ny: lastNy, nz: lastNz } : null;
}

function isDefaultTemplatePlacement(piece, patTemplateId) {
  const pl = piece?.placement3D;
  if (!pl || typeof pl !== 'object' || !pl.offset || !pl.normal) return false;
  if (
    !Number.isFinite(pl.offset.x) ||
    !Number.isFinite(pl.offset.y) ||
    !Number.isFinite(pl.offset.z) ||
    !Number.isFinite(pl.normal.x) ||
    !Number.isFinite(pl.normal.y) ||
    !Number.isFinite(pl.normal.z)
  ) {
    return false;
  }
  const id = piece.id || '';
  if (
    id === 'front_bodice' ||
    id === 'back_bodice' ||
    id === 'center_front_panel' ||
    id === 'center_back_panel' ||
    id === 'side_front_left' ||
    id === 'side_front_right' ||
    id === 'side_back_left' ||
    id === 'side_back_right' ||
    id === 'skirt_front' ||
    id === 'skirt_back' ||
    id === 'skirt_waistband' ||
    id === 'sleeve_left' ||
    id === 'sleeve_right' ||
    id === 'neckband' ||
    id === 'hood_left' ||
    id === 'hood_right' ||
    id === 'kangaroo_pocket' ||
    id === 'waistband_rib' ||
    id === 'front_leg_left' ||
    id === 'front_leg_right' ||
    id === 'back_leg_left' ||
    id === 'back_leg_right' ||
    id === 'waistband' ||
    id === 'strap_front' ||
    id === 'strap_back'
  ) {
    return patTemplateId !== 'stl_cover';
  }
  return false;
}

function evalEllipseArcPoint(rx, rz, signedArcMm) {
  const sign = signedArcMm < 0 ? -1 : 1;
  const target = Math.abs(signedArcMm);
  if (target <= 1e-5) return { x: 0, z: rz };
  const steps = 48;
  const maxTheta = Math.PI * 0.85;
  const dTheta = maxTheta / steps;
  let acc = 0;
  let prevX = 0;
  let prevZ = rz;
  for (let i = 1; i <= steps; i++) {
    const th = i * dTheta;
    const x = rx * Math.sin(th);
    const z = rz * Math.cos(th);
    const seg = Math.hypot(x - prevX, z - prevZ);
    if (acc + seg >= target) {
      const f = seg > 1e-6 ? (target - acc) / seg : 0;
      return {
        x: sign * (prevX + (x - prevX) * f),
        z: prevZ + (z - prevZ) * f,
      };
    }
    acc += seg;
    prevX = x;
    prevZ = z;
  }
  const extra = target - acc;
  const tanX = rx * Math.cos(maxTheta);
  const tanZ = -rz * Math.sin(maxTheta);
  const tanL = Math.hypot(tanX, tanZ) || 1;
  return {
    x: sign * (prevX + (tanX / tanL) * extra),
    z: prevZ + (tanZ / tanL) * extra,
  };
}

function computeCurvedArrangementPoint3D(piece, v2, outlineBounds, c2D, avatar, pat) {
  const id = piece.id || '';
  const pose = avatar?.armPose;
  const hScale = pose?.hScale ?? 1;
  const yAt = (yBase) => 40 + (yBase - 40) * hScale;
  const bW = Math.max(1, outlineBounds.maxX - outlineBounds.minX);
  const bH = Math.max(1, outlineBounds.maxY - outlineBounds.minY);
  const localX = v2.x - outlineBounds.minX;
  const localY = v2.y - outlineBounds.minY;
  const uCentered = v2.x - (outlineBounds.minX + bW * 0.5);

  // Tote bag U-arched carry handle straps aligned directly above attachment notches
  if (id === 'strap_front' || id === 'strap_back') {
    const signZ = id === 'strap_front' ? 1 : -1;
    const zBase = finiteOr(piece.placement3D?.offset?.z, signZ * 55);
    const bagW = Math.max(160, finiteOr(pat?.params?.widthMm, 380));
    const bagH = Math.max(120, finiteOr(pat?.params?.heightMm, 420));
    const xSpan = bagW * 0.26;
    const yRise = Math.max(60, (bW - xSpan * 0.6) * 0.46);
    const theta = (localX / bW) * Math.PI;
    const xArc = -xSpan * Math.cos(theta);
    const yArc = bagH * 0.5 - 12 + yRise * Math.sin(theta);
    const zBand = zBase + signZ * (8 + (localY - bH * 0.5) * 0.35);
    return vec3(xArc, yArc, zBand);
  }

  if (!pose) return null;

  const torsoRx = Math.max(pose.shoulderPivotX + pose.rShoulder * 0.58, pose.chestRx + 16, pose.hipRx + 16, bW * 0.34);
  const torsoRz = Math.max(pose.chestRz + 14, pose.hipRz + 14, bW * 0.215);
  const yShoulderTop = Number.isFinite(pose.yHps) ? pose.yHps : yAt(328);
  const yWaistBase = Number.isFinite(pose.yWaist) ? pose.yWaist : yAt(46);

  if (id === 'front_bodice' || id === 'back_bodice') {
    const signZ = id === 'front_bodice' ? 1 : -1;
    const halfTorsoArc = Math.PI * 0.5 * (torsoRx + torsoRz);
    const stretchFit = halfTorsoArc * 0.88 > bW ? clamp((halfTorsoArc * 0.88) / bW, 1.0, 1.38) : 1.0;
    const ep = evalEllipseArcPoint(torsoRx, torsoRz, uCentered * stretchFit);
    return vec3(signZ * ep.x, yShoulderTop - localY, signZ * (ep.z + 5 * hScale));
  }

  // Princess-seam 6-panel bodice wrapping
  if (id === 'center_front_panel' || id === 'center_back_panel') {
    const signZ = id === 'center_front_panel' ? 1 : -1;
    const pRx = Math.max(pose.chestRx + 16, pose.waistRx + 18);
    const pRz = Math.max(pose.chestRz + 14, pose.waistRz + 16);
    const ep = evalEllipseArcPoint(pRx, pRz, uCentered);
    return vec3(signZ * ep.x, yShoulderTop - localY, signZ * (ep.z + 6 * hScale));
  }

  if (
    id === 'side_front_right' ||
    id === 'side_front_left' ||
    id === 'side_back_right' ||
    id === 'side_back_left'
  ) {
    const isFront = id.startsWith('side_front_');
    const isRight3D = id.endsWith('_right');
    const pRx = Math.max(pose.chestRx + 16, pose.waistRx + 18);
    const pRz = Math.max(pose.chestRz + 14, pose.waistRz + 16);
    const cfPiece = Array.isArray(pat?.pieces) ? pat.pieces.find((p) => p?.id === 'center_front_panel') : null;
    const cfBounds = cfPiece ? polygonBounds(cfPiece.points) : null;
    const cfMidX = cfBounds ? cfBounds.minX + cfBounds.width * 0.5 : 0;
    const cfHalfTop = cfPiece?.points?.[2] ? Math.abs(cfPiece.points[2].x - cfMidX) : 84;
    const cfHalfBot = cfPiece?.points?.[3] ? Math.abs(cfPiece.points[3].x - cfMidX) : 68;
    const uY = clamp(localY / bH, 0, 1);
    const cfHalfAtY = cfHalfTop * (1 - uY) + cfHalfBot * uY + Math.sin(uY * Math.PI) * 14;
    // Measure distance directly from the princess seam anchor X so shoulder, bust & waist start flush
    const princessOnLeft = id === 'side_front_right' || id === 'side_back_left';
    const princessRefX = princessOnLeft
      ? finiteOr(piece.points?.[0]?.x, outlineBounds.minX)
      : finiteOr(piece.points?.[1]?.x, outlineBounds.maxX);
    const distFromPrincess = Math.max(-22, princessOnLeft ? v2.x - princessRefX : princessRefX - v2.x);
    const signedArc = (isRight3D ? 1 : -1) * Math.max(0, cfHalfAtY + distFromPrincess * 0.94);
    const ep = evalEllipseArcPoint(pRx, pRz, signedArc);
    return vec3(ep.x, yShoulderTop - localY, (isFront ? 1 : -1) * (ep.z + 6 * hScale));
  }

  // Women's skirts (standalone A-line / Pencil skirts & Fit-and-Flare dress skirt panels)
  if (id === 'skirt_front' || id === 'skirt_back') {
    const signZ = id === 'skirt_front' ? 1 : -1;
    const frontBodicePiece = Array.isArray(pat?.pieces) ? pat.pieces.find((p) => p?.id === 'front_bodice') : null;
    const isDress = Boolean(frontBodicePiece);
    const bodiceH = frontBodicePiece ? polygonBounds(frontBodicePiece.points).height : 0;
    const ySkirtTop = isDress ? yShoulderTop - bodiceH - 2 : yWaistBase;
    const hipBlend = clamp(localY / 210, 0, 1);
    const sRx =
      (pose.waistRx + 16) * (1 - hipBlend) +
      Math.max(pose.hipRx + 20, bW * 0.33) * hipBlend;
    const sRz =
      (pose.waistRz + 16) * (1 - hipBlend) +
      Math.max(pose.hipRz + 20, bW * 0.23) * hipBlend;
    const ep = evalEllipseArcPoint(sRx, sRz, uCentered);
    return vec3(signZ * ep.x, ySkirtTop - localY, signZ * (ep.z + 5 * hScale));
  }

  if (id === 'skirt_waistband') {
    const rxW = Math.max(pose.waistRx + 14, bW / (2 * Math.PI) * 1.12);
    const rzW = Math.max(pose.waistRz + 14, bW / (2 * Math.PI) * 0.88);
    const theta = -Math.PI * 0.5 - (localX / bW) * Math.PI * 2;
    return vec3(rxW * Math.sin(theta), yWaistBase + (bH - localY) * 0.52, rzW * Math.cos(theta));
  }

  if (id === 'kangaroo_pocket') {
    const frontPiece = Array.isArray(pat?.pieces) ? pat.pieces.find((p) => p?.id === 'front_bodice') : null;
    const frontH = frontPiece && Array.isArray(frontPiece.points) ? polygonBounds(frontPiece.points).height : 600;
    const frontW = frontPiece && Array.isArray(frontPiece.points) ? polygonBounds(frontPiece.points).width : bW * 1.4;
    const pocketRx = Math.max(torsoRx, frontW * 0.34) + 9;
    const pocketRz = Math.max(torsoRz, frontW * 0.215) + 9;
    const pocketTopY = yShoulderTop - (frontH - bH);
    const ep = evalEllipseArcPoint(pocketRx, pocketRz, uCentered);
    return vec3(ep.x, pocketTopY - localY, ep.z + 9 * hScale);
  }

  if (id === 'sleeve_right' || id === 'sleeve_left') {
    const isRight = id === 'sleeve_right';
    const side = isRight ? 1 : -1;
    const sinA = Math.sin(pose.angleRad);
    const cosA = Math.cos(pose.angleRad);
    const axis = norm3(vec3(side * sinA, -cosA, 0.03));
    const upArm = norm3(vec3(side * cosA, sinA, 0));
    // Always orient frontArm toward +Z regardless of left/right side
    const rawCross = cross3(axis, upArm);
    const frontArm = rawCross.z >= 0 ? norm3(rawCross) : scale3(norm3(rawCross), -1);
    const R = Math.max(pose.rShoulder + 16, bW / (2 * Math.PI * 0.94));
    const phi = (isRight ? -1 : 1) * (uCentered / R);
    const origin = vec3(
      side * (pose.shoulderPivotX + 18 * hScale),
      pose.shoulderPivotY + 12 * hScale,
      pose.shoulderPivotZ
    );
    const radial = add3(scale3(upArm, R * Math.cos(phi)), scale3(frontArm, R * Math.sin(phi)));
    return add3(add3(origin, scale3(axis, localY)), radial);
  }

  if (id === 'neckband') {
    const rx = Math.max(pose.neckRx + 24, bW / (2 * Math.PI));
    const rz = Math.max(pose.neckRz + 26, bW / (2 * Math.PI));
    const uNorm = clamp(localX / bW, 0, 1);
    const fRatio = 0.61;
    const theta =
      uNorm <= fRatio
        ? (uNorm / fRatio) * Math.PI
        : Math.PI + ((uNorm - fRatio) / (1 - fRatio)) * Math.PI;
    const frontFactor = Math.max(0, Math.sin(theta));
    const backFactor = Math.max(0, -Math.sin(theta));
    const yCollar = yAt(320) - 72 * hScale * frontFactor - 12 * hScale * backFactor;
    const zShift = (pose.chestRz - rz + 22 * hScale) * frontFactor - 16 * hScale * backFactor;
    return vec3(
      rx * Math.cos(theta),
      yCollar + localY * 0.65,
      rz * Math.sin(theta) + zShift
    );
  }

  if (id === 'waistband_rib') {
    const frontPiece = Array.isArray(pat?.pieces) ? pat.pieces.find((p) => p?.id === 'front_bodice') : null;
    const frontH = frontPiece && Array.isArray(frontPiece.points) ? polygonBounds(frontPiece.points).height : 610;
    const R = Math.max(pose.hipRx + 16, bW / (2 * Math.PI));
    const theta = -Math.PI * 0.5 + (localX / bW) * Math.PI * 2;
    const yTop = yShoulderTop - frontH - 2;
    return vec3(R * Math.sin(theta), yTop - localY, R * Math.cos(theta));
  }

  if (id === 'hood_left' || id === 'hood_right') {
    const isLeft = id === 'hood_left';
    const rHeadApprox = Math.max(66, pose.neckRx * 1.28);
    const bottomFlare = clamp((localY - bH * 0.65) / (bH * 0.35), 0, 1) * 20 * hScale;
    const R = Math.max(rHeadApprox + 20 * hScale, bW / (0.95 * Math.PI)) + bottomFlare;
    const ang = isLeft ? Math.PI - localX / R : Math.PI - (bW - localX) / R;
    const xSign = isLeft ? -1 : 1;
    const yNeck = yAt(316) - bottomFlare * 0.85;
    return vec3(
      xSign * R * Math.sin(ang),
      yNeck + (bH - localY),
      R * Math.cos(ang) - 4 * hScale
    );
  }

  if (
    id === 'front_leg_left' ||
    id === 'front_leg_right' ||
    id === 'back_leg_left' ||
    id === 'back_leg_right'
  ) {
    const isLeft = id.endsWith('_left');
    const isBack = id.startsWith('back_');
    const crotchBlend = pose.isWomens ? clamp((localY - 220) / 140, 0, 1) : 1;
    const legSpreadFactor = 0.56 * (1 - crotchBlend) + 0.86 * crotchBlend;
    const legCenterX = (isLeft ? -1 : 1) * (pose.legX * legSpreadFactor);
    const R = Math.max(pose.rThigh + 40, bW / (Math.PI * 0.82));
    const phi = uCentered / R;
    const xSign = isLeft ? 1 : -1;
    const zSign = isBack ? -1 : 1;
    const zOffset = Math.max(24 * hScale, pose.hipRz + 16 - R * 0.42);
    const yWaistTop = pose.isWomens ? yWaistBase + 8 * hScale : yAt(46);
    return vec3(
      legCenterX + xSign * R * Math.sin(phi),
      yWaistTop - localY,
      zSign * (R * Math.cos(phi) + zOffset)
    );
  }

  if (id === 'waistband') {
    const rxW = Math.max(pose.waistRx + 16, bW / (2 * Math.PI) * 1.12);
    const rzW = Math.max(pose.waistRz + 16, bW / (2 * Math.PI) * 0.88);
    const theta = (localX / bW) * Math.PI * 2;
    if (pose.isWomens) {
      const yWaistTop = yWaistBase + 8 * hScale;
      return vec3(rxW * Math.sin(theta), yWaistTop + (bH - localY) * 0.52, rzW * Math.cos(theta));
    }
    const yTop = yAt(72);
    return vec3(rxW * Math.sin(theta), yTop - localY, rzW * Math.cos(theta));
  }

  return null;
}

function optimizeDelaunayTriangles2D(vertices, inputTriangles, passes = 4) {
  const tris = inputTriangles.map((t) => [t[0], t[1], t[2]]);
  if (tris.length < 2) return tris;

  const signedArea2 = (ia, ib, ic) => {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  };

  for (let pass = 0; pass < passes; pass++) {
    let flipped = 0;
    const edgeMap = new Map();
    for (let ti = 0; ti < tris.length; ti++) {
      const [a, b, c] = tris[ti];
      const edges = [
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ];
      for (let ei = 0; ei < 3; ei++) {
        const [u, v, opp] = edges[ei];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const prev = edgeMap.get(key);
        if (!prev) {
          edgeMap.set(key, { t0: ti, u0: u, v0: v, opp0: opp, t1: -1, opp1: -1 });
        } else if (prev.t1 === -1) {
          prev.t1 = ti;
          prev.opp1 = opp;
        } else {
          prev.t1 = -2;
        }
      }
    }

    const touched = new Uint8Array(tris.length);
    for (const entry of edgeMap.values()) {
      if (entry.t1 < 0) continue;
      const { t0, t1, u0: u, v0: v, opp0: p, opp1: q } = entry;
      if (touched[t0] || touched[t1] || p === q) continue;

      const origSign = signedArea2(u, v, p) >= 0 ? 1 : -1;
      const aNew1 = signedArea2(p, q, v) * origSign;
      const aNew2 = signedArea2(q, p, u) * origSign;
      if (aNew1 <= 1e-3 || aNew2 <= 1e-3) continue;

      const pu = sub2(vertices[u], vertices[p]);
      const pv = sub2(vertices[v], vertices[p]);
      const qu = sub2(vertices[u], vertices[q]);
      const qv = sub2(vertices[v], vertices[q]);

      const crossP = Math.abs(pu.x * pv.y - pu.y * pv.x);
      const crossQ = Math.abs(qu.x * qv.y - qu.y * qv.x);
      if (crossP <= 1e-6 || crossQ <= 1e-6) continue;

      const dotP = dot2(pu, pv);
      const dotQ = dot2(qu, qv);
      // Flip if sum of opposite angles > PI (Delaunay incircle criterion with epsilon margin)
      if (dotP * crossQ + dotQ * crossP < -1e-3 * crossP * crossQ) {
        if (origSign > 0) {
          tris[t0] = [p, q, v];
          tris[t1] = [q, p, u];
        } else {
          tris[t0] = [p, v, q];
          tris[t1] = [q, u, p];
        }
        touched[t0] = 1;
        touched[t1] = 1;
        flipped++;
      }
    }
    if (flipped === 0) break;
  }

  return tris;
}

export const DEFAULT_AVATAR = createParametricAvatar(DEFAULT_AVATAR_MEASUREMENTS);

// ============================================================================
// Triangle-Mesh BVH + Voronoi Feature Pseudo-Normal STL Collider (F19)
// ============================================================================

function closestPointOnTriangle3D(p, a, b, c) {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);

  const d1 = dot3(ab, ap);
  const d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) {
    return { q: a, distSq: dot3(ap, ap), feature: 'a' };
  }

  const bp = sub3(p, b);
  const d3 = dot3(ab, bp);
  const d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) {
    return { q: b, distSq: dot3(bp, bp), feature: 'b' };
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const q = add3(a, scale3(ab, v));
    const dq = sub3(p, q);
    return { q, distSq: dot3(dq, dq), feature: 'ab' };
  }

  const cp = sub3(p, c);
  const d5 = dot3(ab, cp);
  const d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) {
    return { q: c, distSq: dot3(cp, cp), feature: 'c' };
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const q = add3(a, scale3(ac, w));
    const dq = sub3(p, q);
    return { q, distSq: dot3(dq, dq), feature: 'ca' };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const q = add3(b, scale3(sub3(c, b), w));
    const dq = sub3(p, q);
    return { q, distSq: dot3(dq, dq), feature: 'bc' };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const q = add3(a, add3(scale3(ab, v), scale3(ac, w)));
  const dq = sub3(p, q);
  return { q, distSq: dot3(dq, dq), feature: 'face' };
}

function pointToAABBMinDistSq(p, box) {
  let d2 = 0;
  if (p.x < box.minX) d2 += (box.minX - p.x) * (box.minX - p.x);
  else if (p.x > box.maxX) d2 += (p.x - box.maxX) * (p.x - box.maxX);
  if (p.y < box.minY) d2 += (box.minY - p.y) * (box.minY - p.y);
  else if (p.y > box.maxY) d2 += (p.y - box.maxY) * (p.y - box.maxY);
  if (p.z < box.minZ) d2 += (box.minZ - p.z) * (box.minZ - p.z);
  else if (p.z > box.maxZ) d2 += (p.z - box.maxZ) * (p.z - box.maxZ);
  return d2;
}

function buildSTLBvhCollider(stlMesh) {
  if (!stlMesh || typeof stlMesh !== 'object') return null;

  let rawTris = [];
  if (Array.isArray(stlMesh.triangles) && stlMesh.triangles.length > 0) {
    rawTris = stlMesh.triangles.map((t) => {
      if (!t || typeof t !== 'object') return null;
      return Array.isArray(t) ? t : [t.a ?? t.v0, t.b ?? t.v1, t.c ?? t.v2];
    });
  } else if (Array.isArray(stlMesh.faces) && Array.isArray(stlMesh.vertices)) {
    rawTris = stlMesh.faces.map((f) => {
      if (!f || typeof f !== 'object') return null;
      const idx = Array.isArray(f) ? f : f.indices || [f.a, f.b, f.c];
      if (!Array.isArray(idx) || idx.length < 3) return null;
      return [stlMesh.vertices[idx[0]], stlMesh.vertices[idx[1]], stlMesh.vertices[idx[2]]];
    });
  }

  const tris = [];
  const vNormAccum = new Map();
  const eNormAccum = new Map();
  const vKeyOf = (v) => `${Math.round(v.x * 1e4)}_${Math.round(v.y * 1e4)}_${Math.round(v.z * 1e4)}`;
  const eKeyOf = (ka, kb) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const t of rawTris) {
    if (
      !Array.isArray(t) ||
      t.length < 3 ||
      !t[0] ||
      typeof t[0] !== 'object' ||
      !t[1] ||
      typeof t[1] !== 'object' ||
      !t[2] ||
      typeof t[2] !== 'object'
    ) continue;
    const a = vec3(t[0].x, t[0].y, t[0].z);
    const b = vec3(t[1].x, t[1].y, t[1].z);
    const c = vec3(t[2].x, t[2].y, t[2].z);
    if (!Number.isFinite(a.x + a.y + a.z + b.x + b.y + b.z + c.x + c.y + c.z)) continue;
    const cr = cross3(sub3(b, a), sub3(c, a));
    const dblArea = len3(cr);
    if (dblArea <= 1e-8) continue; // Degenerate zero-area triangle guard

    const normal = scale3(cr, 1 / dblArea);
    const ka = vKeyOf(a);
    const kb = vKeyOf(b);
    const kc = vKeyOf(c);

    const angA = Math.acos(clamp(dot3(norm3(sub3(b, a)), norm3(sub3(c, a))), -1, 1));
    const angB = Math.acos(clamp(dot3(norm3(sub3(a, b)), norm3(sub3(c, b))), -1, 1));
    const angC = Math.acos(clamp(dot3(norm3(sub3(a, c)), norm3(sub3(b, c))), -1, 1));

    vNormAccum.set(ka, add3(vNormAccum.get(ka) || vec3(0, 0, 0), scale3(normal, Number.isFinite(angA) ? angA : 1)));
    vNormAccum.set(kb, add3(vNormAccum.get(kb) || vec3(0, 0, 0), scale3(normal, Number.isFinite(angB) ? angB : 1)));
    vNormAccum.set(kc, add3(vNormAccum.get(kc) || vec3(0, 0, 0), scale3(normal, Number.isFinite(angC) ? angC : 1)));

    const eab = eKeyOf(ka, kb);
    const ebc = eKeyOf(kb, kc);
    const eca = eKeyOf(kc, ka);
    eNormAccum.set(eab, add3(eNormAccum.get(eab) || vec3(0, 0, 0), normal));
    eNormAccum.set(ebc, add3(eNormAccum.get(ebc) || vec3(0, 0, 0), normal));
    eNormAccum.set(eca, add3(eNormAccum.get(eca) || vec3(0, 0, 0), normal));

    const tMinX = Math.min(a.x, b.x, c.x);
    const tMinY = Math.min(a.y, b.y, c.y);
    const tMinZ = Math.min(a.z, b.z, c.z);
    const tMaxX = Math.max(a.x, b.x, c.x);
    const tMaxY = Math.max(a.y, b.y, c.y);
    const tMaxZ = Math.max(a.z, b.z, c.z);
    if (tMinX < minX) minX = tMinX;
    if (tMinY < minY) minY = tMinY;
    if (tMinZ < minZ) minZ = tMinZ;
    if (tMaxX > maxX) maxX = tMaxX;
    if (tMaxY > maxY) maxY = tMaxY;
    if (tMaxZ > maxZ) maxZ = tMaxZ;

    tris.push({
      a,
      b,
      c,
      normal,
      ka,
      kb,
      kc,
      eab,
      ebc,
      eca,
      cx: (a.x + b.x + c.x) / 3,
      cy: (a.y + b.y + c.y) / 3,
      cz: (a.z + b.z + c.z) / 3,
      minX: tMinX,
      minY: tMinY,
      minZ: tMinZ,
      maxX: tMaxX,
      maxY: tMaxY,
      maxZ: tMaxZ,
    });
  }

  if (tris.length === 0) return null;

  const vNorms = new Map();
  for (const [k, v] of vNormAccum) {
    vNorms.set(k, len3(v) > 1e-6 ? norm3(v) : vec3(0, 1, 0));
  }
  const eNorms = new Map();
  for (const [k, v] of eNormAccum) {
    eNorms.set(k, len3(v) > 1e-6 ? norm3(v) : vec3(0, 1, 0));
  }

  for (const tri of tris) {
    tri.na = vNorms.get(tri.ka) || tri.normal;
    tri.nb = vNorms.get(tri.kb) || tri.normal;
    tri.nc = vNorms.get(tri.kc) || tri.normal;
    tri.nab = eNorms.get(tri.eab) || tri.normal;
    tri.nbc = eNorms.get(tri.ebc) || tri.normal;
    tri.nca = eNorms.get(tri.eca) || tri.normal;
  }

  const indices = Array.from({ length: tris.length }, (_, i) => i);
  const nodes = [];

  const buildNode = (start, end) => {
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
    let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = tris[indices[i]];
      if (t.minX < bx0) bx0 = t.minX;
      if (t.minY < by0) by0 = t.minY;
      if (t.minZ < bz0) bz0 = t.minZ;
      if (t.maxX > bx1) bx1 = t.maxX;
      if (t.maxY > by1) by1 = t.maxY;
      if (t.maxZ > bz1) bz1 = t.maxZ;
    }

    const nodeIdx = nodes.length;
    const node = {
      minX: bx0,
      minY: by0,
      minZ: bz0,
      maxX: bx1,
      maxY: by1,
      maxZ: bz1,
      left: -1,
      right: -1,
      start,
      end,
    };
    nodes.push(node);

    const count = end - start;
    if (count <= 4) return nodeIdx;

    const dx = bx1 - bx0;
    const dy = by1 - by0;
    const dz = bz1 - bz0;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const slice = indices.slice(start, end).sort((ia, ib) => {
      const ta = tris[ia];
      const tb = tris[ib];
      return axis === 0 ? ta.cx - tb.cx : axis === 1 ? ta.cy - tb.cy : ta.cz - tb.cz;
    });
    for (let i = 0; i < count; i++) indices[start + i] = slice[i];

    const mid = start + (count >> 1);
    node.left = buildNode(start, mid);
    node.right = buildNode(mid, end);
    return nodeIdx;
  };

  buildNode(0, indices.length);

  return {
    tris,
    indices,
    nodes,
    bounds: {
      min: vec3(minX, minY, minZ),
      max: vec3(maxX, maxY, maxZ),
      size: vec3(maxX - minX, maxY - minY, maxZ - minZ),
      center: vec3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    },
  };
}

function querySTLBvhClosest(bvh, p, maxRadiusSq) {
  let bestDistSq = maxRadiusSq;
  let bestQ = null;
  let bestNormal = null;
  const stack = [0];

  while (stack.length > 0) {
    const ni = stack.pop();
    const node = bvh.nodes[ni];
    if (pointToAABBMinDistSq(p, node) >= bestDistSq) continue;

    if (node.left === -1) {
      for (let i = node.start; i < node.end; i++) {
        const tri = bvh.tris[bvh.indices[i]];
        const hit = closestPointOnTriangle3D(p, tri.a, tri.b, tri.c);
        if (hit.distSq < bestDistSq) {
          bestDistSq = hit.distSq;
          bestQ = hit.q;
          bestNormal =
            hit.feature === 'face'
              ? tri.normal
              : hit.feature === 'ab'
                ? tri.nab
                : hit.feature === 'bc'
                  ? tri.nbc
                  : hit.feature === 'ca'
                    ? tri.nca
                    : hit.feature === 'a'
                      ? tri.na
                      : hit.feature === 'b'
                        ? tri.nb
                        : tri.nc;
        }
      }
    } else {
      const dL = pointToAABBMinDistSq(p, bvh.nodes[node.left]);
      const dR = pointToAABBMinDistSq(p, bvh.nodes[node.right]);
      if (dL < dR) {
        if (dR < bestDistSq) stack.push(node.right);
        if (dL < bestDistSq) stack.push(node.left);
      } else {
        if (dL < bestDistSq) stack.push(node.left);
        if (dR < bestDistSq) stack.push(node.right);
      }
    }
  }

  return bestQ ? { distSq: bestDistSq, q: bestQ, nFeature: bestNormal } : null;
}

function querySTLBvhWithinRadius(bvh, p, radiusSq) {
  const hits = [];
  const stack = [0];

  while (stack.length > 0) {
    const ni = stack.pop();
    const node = bvh.nodes[ni];
    if (pointToAABBMinDistSq(p, node) >= radiusSq) continue;

    if (node.left === -1) {
      for (let i = node.start; i < node.end; i++) {
        const tri = bvh.tris[bvh.indices[i]];
        const hit = closestPointOnTriangle3D(p, tri.a, tri.b, tri.c);
        if (hit.distSq < radiusSq) {
          const nFeature =
            hit.feature === 'face'
              ? tri.normal
              : hit.feature === 'ab'
                ? tri.nab
                : hit.feature === 'bc'
                  ? tri.nbc
                  : hit.feature === 'ca'
                    ? tri.nca
                    : hit.feature === 'a'
                      ? tri.na
                      : hit.feature === 'b'
                        ? tri.nb
                        : tri.nc;
          hits.push({ tri, q: hit.q, distSq: hit.distSq, nFeature, feature: hit.feature });
        }
      }
    } else {
      stack.push(node.right);
      stack.push(node.left);
    }
  }

  return hits;
}

function rayIntersectsAABB(orig, invDir, node) {
  const tx1 = (node.minX - orig.x) * invDir.x;
  const tx2 = (node.maxX - orig.x) * invDir.x;
  let tmin = Math.min(tx1, tx2);
  let tmax = Math.max(tx1, tx2);

  const ty1 = (node.minY - orig.y) * invDir.y;
  const ty2 = (node.maxY - orig.y) * invDir.y;
  tmin = Math.max(tmin, Math.min(ty1, ty2));
  tmax = Math.min(tmax, Math.max(ty1, ty2));

  const tz1 = (node.minZ - orig.z) * invDir.z;
  const tz2 = (node.maxZ - orig.z) * invDir.z;
  tmin = Math.max(tmin, Math.min(tz1, tz2));
  tmax = Math.min(tmax, Math.max(tz1, tz2));

  return tmax >= Math.max(0, tmin);
}

function rayIntersectsTriBVH(orig, dir, tri) {
  const e1x = tri.b.x - tri.a.x;
  const e1y = tri.b.y - tri.a.y;
  const e1z = tri.b.z - tri.a.z;
  const e2x = tri.c.x - tri.a.x;
  const e2y = tri.c.y - tri.a.y;
  const e2z = tri.c.z - tri.a.z;

  const hx = dir.y * e2z - dir.z * e2y;
  const hy = dir.z * e2x - dir.x * e2z;
  const hz = dir.x * e2y - dir.y * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (a > -1e-10 && a < 1e-10) return false;

  const f = 1 / a;
  const sx = orig.x - tri.a.x;
  const sy = orig.y - tri.a.y;
  const sz = orig.z - tri.a.z;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return false;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dir.x * qx + dir.y * qy + dir.z * qz);
  if (v < 0 || u + v > 1) return false;

  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 1e-6;
}

const INSIDE_RAY_DIRS = [
  norm3(vec3(1, 0.0137, 0.0219)),
  norm3(vec3(0.0173, 1, 0.0291)),
  norm3(vec3(0.0231, 0.0119, 1)),
];

function isPointInsideSTLBvh(bvh, p) {
  if (!bvh || !bvh.nodes || bvh.nodes.length === 0) return false;
  const bMin = bvh.bounds.min;
  const bMax = bvh.bounds.max;
  if (
    p.x < bMin.x ||
    p.x > bMax.x ||
    p.y < bMin.y ||
    p.y > bMax.y ||
    p.z < bMin.z ||
    p.z > bMax.z
  ) {
    return false;
  }

  let oddCount = 0;
  for (let r = 0; r < INSIDE_RAY_DIRS.length; r++) {
    const dir = INSIDE_RAY_DIRS[r];
    const invDir = {
      x: 1 / dir.x,
      y: 1 / dir.y,
      z: 1 / dir.z,
    };
    let hits = 0;
    const stack = [0];
    while (stack.length > 0) {
      const ni = stack.pop();
      const node = bvh.nodes[ni];
      if (!rayIntersectsAABB(p, invDir, node)) continue;
      if (node.left === -1) {
        for (let i = node.start; i < node.end; i++) {
          if (rayIntersectsTriBVH(p, dir, bvh.tris[bvh.indices[i]])) hits++;
        }
      } else {
        stack.push(node.right);
        stack.push(node.left);
      }
    }
    if ((hits & 1) === 1) oddCount++;
  }
  return oddCount >= 2;
}

function sanitizeCustomAvatar(avatar) {
  const srcColliders = Array.isArray(avatar.colliders) ? avatar.colliders : [];
  const colliders = [];
  for (let i = 0; i < srcColliders.length; i++) {
    const col = srcColliders[i];
    if (
      !col ||
      typeof col !== 'object' ||
      !col.center ||
      typeof col.center !== 'object' ||
      !col.radii ||
      typeof col.radii !== 'object'
    ) {
      continue;
    }
    colliders.push({
      ...col,
      center: vec3(
        finiteOr(col.center.x, 0),
        finiteOr(col.center.y, 0),
        finiteOr(col.center.z, 0)
      ),
      radii: vec3(
        Math.max(1e-3, finiteOr(col.radii.x, 1)),
        Math.max(1e-3, finiteOr(col.radii.y, 1)),
        Math.max(1e-3, finiteOr(col.radii.z, 1))
      ),
    });
  }
  return {
    ...avatar,
    colliders,
    floorY: finiteOr(avatar.floorY, -980),
  };
}

// ============================================================================
// ClothSimulation (F18, F19, F20)
// ============================================================================

function scaleVec2IfObj(pt, scale, rawUnit = 'mm') {
  if (!pt || typeof pt !== 'object') return pt;
  const x = Number.isFinite(pt.x) ? pt.x * scale : pt.x;
  const y = Number.isFinite(pt.y) ? pt.y * scale : pt.y;
  if (
    (Number.isFinite(pt.x) && !Number.isFinite(x)) ||
    (Number.isFinite(pt.y) && !Number.isFinite(y))
  ) {
    throw new ValidationError(
      `Piece coordinates overflow finite millimeter bounds when converted from "${rawUnit}".`,
      {
        code: 'INVALID_POINTS',
        path: 'pieces',
      }
    );
  }
  return {
    ...pt,
    x,
    y,
  };
}

function scaleScalarIfFinite(val, scale, rawUnit = 'mm', code = 'INVALID_POINTS', path = 'pieces') {
  if (!Number.isFinite(val)) return val;
  const scaled = val * scale;
  if (!Number.isFinite(scaled)) {
    throw new ValidationError(
      `Piece numeric property overflows finite millimeter bounds when converted from "${rawUnit}".`,
      {
        code,
        path,
      }
    );
  }
  return scaled;
}

function normalizePatternForSimulation(rawPat) {
  if (!rawPat || typeof rawPat !== 'object') return { pieces: [], seams: [] };
  const rawUnit = rawPat.unit;
  if (rawUnit === undefined || rawUnit === null || rawUnit === 'mm') {
    return rawPat;
  }
  if (!isValidUnit(rawUnit)) {
    let safeUnitStr = typeof rawUnit;
    if (typeof rawUnit === 'string') {
      safeUnitStr = rawUnit;
    } else if (typeof rawUnit === 'number' || typeof rawUnit === 'boolean') {
      safeUnitStr = String(rawUnit);
    }
    throw new ValidationError(`Unsupported pattern unit "${safeUnitStr}".`, {
      code: 'INVALID_UNIT',
      path: 'pattern.unit',
      details: { unit: rawUnit },
    });
  }
  const scale = UNIT_FACTORS[rawUnit];
  const rawPieces = Array.isArray(rawPat.pieces) ? rawPat.pieces : [];
  const pieces = rawPieces.map((piece, pIdx) => {
    if (!piece || typeof piece !== 'object') return piece;
    const out = { ...piece };
    if (Array.isArray(piece.points)) {
      out.points = piece.points.map((pt) => scaleVec2IfObj(pt, scale, rawUnit));
    }
    if (piece.position && typeof piece.position === 'object') {
      out.position = scaleVec2IfObj(piece.position, scale, rawUnit);
    }
    if (piece.rotationOrigin && typeof piece.rotationOrigin === 'object') {
      out.rotationOrigin = scaleVec2IfObj(piece.rotationOrigin, scale, rawUnit);
    }
    if (Number.isFinite(piece.seamAllowance)) {
      out.seamAllowance = scaleScalarIfFinite(
        piece.seamAllowance,
        scale,
        rawUnit,
        'INVALID_PIECE',
        `pieces[${pIdx}].seamAllowance`
      );
    }
    if (Array.isArray(piece.edges)) {
      out.edges = piece.edges.map((edge, eIdx) => {
        if (!edge || typeof edge !== 'object') return edge;
        const eOut = { ...edge };
        if (Number.isFinite(edge.seamAllowance)) {
          eOut.seamAllowance = scaleScalarIfFinite(
            edge.seamAllowance,
            scale,
            rawUnit,
            'INVALID_EDGES',
            `pieces[${pIdx}].edges[${eIdx}].seamAllowance`
          );
        }
        if (edge.curve && typeof edge.curve === 'object') {
          const cOut = { ...edge.curve };
          if (edge.curve.cp) cOut.cp = scaleVec2IfObj(edge.curve.cp, scale, rawUnit);
          if (edge.curve.cp1) cOut.cp1 = scaleVec2IfObj(edge.curve.cp1, scale, rawUnit);
          if (edge.curve.cp2) cOut.cp2 = scaleVec2IfObj(edge.curve.cp2, scale, rawUnit);
          eOut.curve = cOut;
        }
        return eOut;
      });
    }
    if (Array.isArray(piece.notches)) {
      out.notches = piece.notches.map((n, nIdx) =>
        n && typeof n === 'object' && Number.isFinite(n.depthMm)
          ? {
              ...n,
              depthMm: scaleScalarIfFinite(
                n.depthMm,
                scale,
                rawUnit,
                'INVALID_NOTCH',
                `pieces[${pIdx}].notches[${nIdx}].depthMm`
              ),
            }
          : n
      );
    }
    if (Array.isArray(piece.darts)) {
      out.darts = piece.darts.map((d, dIdx) => {
        if (!d || typeof d !== 'object') return d;
        return {
          ...d,
          ...(Number.isFinite(d.widthMm)
            ? {
                widthMm: scaleScalarIfFinite(
                  d.widthMm,
                  scale,
                  rawUnit,
                  'INVALID_DART',
                  `pieces[${pIdx}].darts[${dIdx}].widthMm`
                ),
              }
            : {}),
          ...(Number.isFinite(d.depthMm)
            ? {
                depthMm: scaleScalarIfFinite(
                  d.depthMm,
                  scale,
                  rawUnit,
                  'INVALID_DART',
                  `pieces[${pIdx}].darts[${dIdx}].depthMm`
                ),
              }
            : {}),
        };
      });
    }
    if (Array.isArray(piece.internalLines)) {
      out.internalLines = piece.internalLines.map((ln) =>
        ln && typeof ln === 'object' && Array.isArray(ln.points)
          ? { ...ln, points: ln.points.map((pt) => scaleVec2IfObj(pt, scale, rawUnit)) }
          : ln
      );
    }
    if (piece.grainline && typeof piece.grainline === 'object') {
      const gOut = { ...piece.grainline };
      if (piece.grainline.start) gOut.start = scaleVec2IfObj(piece.grainline.start, scale, rawUnit);
      if (piece.grainline.end) gOut.end = scaleVec2IfObj(piece.grainline.end, scale, rawUnit);
      out.grainline = gOut;
    }
    if (piece.placement3D && typeof piece.placement3D === 'object' && piece.placement3D.offset && typeof piece.placement3D.offset === 'object') {
      const off = piece.placement3D.offset;
      const ox = Number.isFinite(off.x) ? off.x * scale : off.x;
      const oy = Number.isFinite(off.y) ? off.y * scale : off.y;
      const oz = Number.isFinite(off.z) ? off.z * scale : off.z;
      if (
        (Number.isFinite(off.x) && !Number.isFinite(ox)) ||
        (Number.isFinite(off.y) && !Number.isFinite(oy)) ||
        (Number.isFinite(off.z) && !Number.isFinite(oz))
      ) {
        throw new ValidationError(
          `Piece placement3D coordinates overflow finite millimeter bounds when converted from "${rawUnit}".`,
          {
            code: 'INVALID_POINTS',
            path: 'pieces',
          }
        );
      }
      out.placement3D = {
        ...piece.placement3D,
        offset: {
          ...off,
          x: ox,
          y: oy,
          z: oz,
        },
      };
    }
    return out;
  });
  return {
    ...rawPat,
    unit: 'mm',
    pieces,
  };
}

export class ClothSimulation {
  constructor(pattern, options = {}) {
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const pat = normalizePatternForSimulation(pattern);

    const optMatId =
      typeof opts.materialId === 'string' && opts.materialId.length > 0 ? opts.materialId : null;
    const optMatObjId =
      opts.material &&
      typeof opts.material === 'object' &&
      typeof opts.material.id === 'string' &&
      Object.hasOwn(MATERIAL_PRESETS, opts.material.id)
        ? opts.material.id
        : null;
    const patMatId =
      typeof pat.materialId === 'string' && Object.hasOwn(MATERIAL_PRESETS, pat.materialId)
        ? pat.materialId
        : null;
    const patMatObjId =
      pat.material &&
      typeof pat.material === 'object' &&
      typeof pat.material.id === 'string' &&
      Object.hasOwn(MATERIAL_PRESETS, pat.material.id)
        ? pat.material.id
        : null;
    const matId =
      optMatId || optMatObjId || patMatId || patMatObjId || pat.materialId || 'cotton_jersey';
    const mergedOverrides = {
      ...(pat.material && typeof pat.material === 'object' ? pat.material : {}),
      ...(opts.material && typeof opts.material === 'object' ? opts.material : {}),
      ...(opts.materialOverrides && typeof opts.materialOverrides === 'object' ? opts.materialOverrides : {}),
    };
    this.material = getMaterialConfig(matId, mergedOverrides);

    this.stlTargetMesh = opts.stlMesh || null;
    this.stlCollider = this.stlTargetMesh ? buildSTLBvhCollider(this.stlTargetMesh) : null;

    if (opts.avatar === null || opts.avatar === false) {
      this.avatar = null;
    } else if (opts.avatar && typeof opts.avatar === 'object') {
      this.avatar = Array.isArray(opts.avatar.colliders)
        ? sanitizeCustomAvatar(opts.avatar)
        : createParametricAvatar(opts.avatar);
    } else if (!this.stlTargetMesh) {
      this.avatar =
        pat.avatar && typeof pat.avatar === 'object'
          ? Array.isArray(pat.avatar.colliders)
            ? sanitizeCustomAvatar(pat.avatar)
            : createParametricAvatar(pat.avatar)
          : DEFAULT_AVATAR;
    } else {
      this.avatar = null;
    }

    this.maxEdgeLengthMm = clamp(finiteOr(opts.maxEdgeLengthMm, 38), 8, 500);
    this.substeps = clamp(Math.trunc(finiteOr(opts.substeps, 6)), 4, 24);
    this.dt = clamp(finiteOr(opts.dt, 1 / 60), 1 / 240, 1 / 20);
    this.gravityMmS2 = finiteOr(opts.gravityMmS2, -980);
    this.stepCount = 0;

    this.particles = [];
    this.triangles = [];
    this.pieceMeshes = [];
    this.structuralConstraints = [];
    this.shearConstraints = [];
    this.bendingConstraints = [];
    this._restShearSpecs = [];
    this._restBendingSpecs = [];
    this.sewingConstraints = [];
    this.dartConstraints = [];
    this.seams = Array.isArray(pat.seams) ? pat.seams : [];

    this._initFromPattern(pat);
    this.computeStrainAnalysis();
  }

  updateMaterial(materialConfig) {
    if (!materialConfig || typeof materialConfig !== 'object') return this.material;
    const prevId = this.material?.id || 'cotton_jersey';
    const nextId =
      typeof materialConfig.id === 'string' && materialConfig.id.length > 0
        ? materialConfig.id
        : prevId;
    if (nextId !== prevId) {
      this.material = getMaterialConfig(nextId, materialConfig);
    } else {
      const prev = this.material && typeof this.material === 'object' ? { ...this.material } : {};
      if (materialConfig.stretchStiffness !== undefined) {
        if (materialConfig.warpStiffness === undefined && materialConfig.stretchWarp === undefined) {
          delete prev.warpStiffness;
          delete prev.stretchWarp;
        }
        if (materialConfig.weftStiffness === undefined && materialConfig.stretchWeft === undefined) {
          delete prev.weftStiffness;
          delete prev.stretchWeft;
        }
      } else if (
        materialConfig.warpStiffness !== undefined ||
        materialConfig.stretchWarp !== undefined ||
        materialConfig.weftStiffness !== undefined ||
        materialConfig.stretchWeft !== undefined
      ) {
        delete prev.stretchStiffness;
      }
      if (materialConfig.warpStiffness !== undefined && materialConfig.stretchWarp === undefined) {
        delete prev.stretchWarp;
      }
      if (materialConfig.weftStiffness !== undefined && materialConfig.stretchWeft === undefined) {
        delete prev.stretchWeft;
      }
      if (materialConfig.warpColor !== undefined) {
        if (materialConfig.baseColor === undefined) delete prev.baseColor;
        if (materialConfig.albedo === undefined) delete prev.albedo;
      }
      if (materialConfig.weftColor !== undefined && materialConfig.grainColor === undefined) {
        delete prev.grainColor;
      }
      if (materialConfig.threadScaleMm !== undefined && materialConfig.weaveScale === undefined) {
        delete prev.weaveScale;
      }
      const merged = { ...prev, ...materialConfig };
      this.material = getMaterialConfig(nextId, merged);
    }
    const kWarp = clamp(finiteOr(this.material.warpStiffness ?? this.material.stretchStiffness, 0.85), 0.01, 1.0);
    const kWeft = clamp(finiteOr(this.material.weftStiffness ?? this.material.stretchStiffness, 0.75), 0.01, 1.0);
    const kShear = clamp(finiteOr(this.material.shearStiffness, 0.5), 0.0, 1.0);
    const kBend = clamp(finiteOr(this.material.bendStiffness, 0.35), 0.0, 1.0);
    const gsmFactor = clamp(finiteOr(this.material.gsm, 200) / 200, 0.25, 6.0);

    if (kShear > 1e-4) {
      const alphaShear = kShear >= 0.9999 ? 0 : ((1 - kShear) / kShear) * 1.2e-6;
      if (this.shearConstraints.length === 0 && this._restShearSpecs.length > 0) {
        this.shearConstraints = this._restShearSpecs.map((spec) => ({
          ...spec,
          alpha: alphaShear,
          lambda: 0,
        }));
      } else {
        for (let i = 0; i < this.shearConstraints.length; i++) {
          this.shearConstraints[i].alpha = alphaShear;
        }
      }
    } else {
      this.shearConstraints = [];
    }

    for (let i = 0; i < this.structuralConstraints.length; i++) {
      const c = this.structuralConstraints[i];
      const wWarp = Number.isFinite(c.wWarp) ? c.wWarp : 0.5;
      const wWeft = Number.isFinite(c.wWeft) ? c.wWeft : 0.5;
      const kEdge = clamp(wWarp * kWarp + wWeft * kWeft, 0.01, 1.0);
      c.alpha = kEdge >= 0.9999 ? 0 : ((1 - kEdge) / kEdge) * 4e-7;
    }

    if (kBend > 1e-4) {
      const alphaBend = kBend >= 0.9999 ? 0 : ((1 - kBend) / kBend) * 2.5e-6;
      if (this.bendingConstraints.length === 0 && this._restBendingSpecs.length > 0) {
        this.bendingConstraints = this._restBendingSpecs.map((spec) => ({
          ...spec,
          alpha: alphaBend,
        }));
      } else {
        for (let i = 0; i < this.bendingConstraints.length; i++) {
          this.bendingConstraints[i].alpha = alphaBend;
        }
      }
    } else {
      this.bendingConstraints = [];
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!(p.invMass > 0)) continue;
      const rel = Number.isFinite(p.baseRelMass) ? p.baseRelMass : 1.0;
      const mass = clamp(gsmFactor * rel, 0.25, 8.0);
      p.invMass = 1 / mass;
    }

    return this.material;
  }

  _initFromPattern(pat) {
    const pieces = Array.isArray(pat.pieces) ? pat.pieces : [];
    const totalPieces = pieces.length;

    const allDefaultPlacement =
      totalPieces > 1 &&
      pieces.every((p) => {
        const off = p?.placement3D?.offset;
        return (
          off &&
          typeof off === 'object' &&
          Number.isFinite(off.x) &&
          Number.isFinite(off.y) &&
          Number.isFinite(off.z) &&
          Math.abs(off.x) < 1e-4 &&
          Math.abs(off.y - 120) < 1e-4 &&
          Math.abs(off.z - 140) < 1e-4
        );
      });

    const vertexArea = [];
    const pieceMap = new Map();

    for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
      const piece = pieces[pIdx];
      if (!piece || typeof piece !== 'object' || !Array.isArray(piece.points) || piece.points.length < 3) continue;

      const outline2D = samplePieceOutline(piece, 8);
      if (outline2D.length < 3) continue;

      const mesh2D = generateClothMesh2D(outline2D, this.maxEdgeLengthMm);
      if (!mesh2D || mesh2D.triangles.length === 0 || mesh2D.vertices.length < 3) continue;
      const delaunayTris = optimizeDelaunayTriangles2D(mesh2D.vertices, mesh2D.triangles, 4);

      const c2D = polygonCentroid(outline2D);
      const pl = piece.placement3D;
      const hasFinitePl =
        pl &&
        typeof pl === 'object' &&
        pl.offset &&
        typeof pl.offset === 'object' &&
        Number.isFinite(pl.offset.x) &&
        Number.isFinite(pl.offset.y) &&
        Number.isFinite(pl.offset.z) &&
        pl.normal &&
        typeof pl.normal === 'object' &&
        Number.isFinite(pl.normal.x) &&
        Number.isFinite(pl.normal.y) &&
        Number.isFinite(pl.normal.z);

      let offset;
      let rawN;
      let rawUp;
      if (hasFinitePl && !(this.stlTargetMesh && allDefaultPlacement)) {
        offset = vec3(pl.offset.x, pl.offset.y, pl.offset.z);
        rawN = vec3(pl.normal.x, pl.normal.y, pl.normal.z);
        rawUp =
          pl.up &&
          typeof pl.up === 'object' &&
          Number.isFinite(pl.up.x) &&
          Number.isFinite(pl.up.y) &&
          Number.isFinite(pl.up.z)
            ? vec3(pl.up.x, pl.up.y, pl.up.z)
            : null;
      } else if (this.stlCollider) {
        const c = this.stlCollider.bounds.center;
        const r = 0.5 * len3(this.stlCollider.bounds.size) + 25;
        const phi = (pIdx / Math.max(1, totalPieces)) * Math.PI * 2;
        rawN = norm3(vec3(Math.sin(phi), 0.15, Math.cos(phi)));
        offset = add3(c, scale3(rawN, r));
        rawUp = vec3(0, 1, 0);
      } else {
        const sideSign = pIdx % 2 === 0 ? 1 : -1;
        offset = vec3((pIdx - (totalPieces - 1) * 0.5) * 160, 120, sideSign * 130);
        rawN = vec3(0, 0, sideSign);
        rawUp = vec3(0, 1, 0);
      }

      const n = len3(rawN) > 1e-6 ? norm3(rawN) : vec3(0, 0, 1);
      let upRef = rawUp && len3(rawUp) > 1e-6 ? norm3(rawUp) : null;
      if (!upRef || len3(cross3(upRef, n)) < 1e-4) {
        upRef = Math.abs(n.y) > 0.9 ? vec3(0, 0, 1) : vec3(0, 1, 0);
      }
      const uAxis = norm3(cross3(upRef, n));
      const vAxis = norm3(cross3(n, uAxis));

      const startIdx = this.particles.length;
      const outlineBounds = polygonBounds(outline2D);
      const useCurvedWrap =
        !this.stlCollider &&
        hasFinitePl &&
        !allDefaultPlacement &&
        isDefaultTemplatePlacement(piece, pat.templateId);

      for (let i = 0; i < mesh2D.vertices.length; i++) {
        const v2 = mesh2D.vertices[i];
        const curvedPos = useCurvedWrap
          ? computeCurvedArrangementPoint3D(piece, v2, outlineBounds, c2D, this.avatar, pat)
          : null;
        let pos;
        if (curvedPos) {
          pos = curvedPos;
        } else {
          const dx = v2.x - c2D.x;
          const dy = -(v2.y - c2D.y);
          pos = add3(offset, add3(scale3(uAxis, dx), scale3(vAxis, dy)));
        }
        const idx = this.particles.length;
        this.particles.push({
          index: idx,
          pieceId: piece.id,
          pos: { ...pos },
          prevPos: { ...pos },
          lastFinitePos: { ...pos },
          rest2D: { x: v2.x, y: v2.y },
          invMass: 1.0,
          strainPct: 0,
          color: [0.13, 0.77, 0.37],
        });
        vertexArea.push(0);
      }

      // Grainline axes in 2D
      const grainDeg = finiteOr(piece.grainline?.angleDeg, 90);
      const grainRad = (grainDeg * Math.PI) / 180;
      const warpDir2 = vec2(Math.cos(grainRad), Math.sin(grainRad));
      const weftDir2 = vec2(-Math.sin(grainRad), Math.cos(grainRad));

      const kWarp = clamp(finiteOr(this.material.warpStiffness ?? this.material.stretchStiffness, 0.85), 0.01, 1.0);
      const kWeft = clamp(finiteOr(this.material.weftStiffness ?? this.material.stretchStiffness, 0.75), 0.01, 1.0);
      const kShear = clamp(finiteOr(this.material.shearStiffness, 0.5), 0.0, 1.0);
      const kBend = clamp(finiteOr(this.material.bendStiffness, 0.35), 0.0, 1.0);

      const pieceTris = [];
      const edgeFaces = new Map();

      for (const [la, lb, lc] of delaunayTris) {
        const ga = startIdx + la;
        const gb = startIdx + lb;
        const gc = startIdx + lc;
        this.triangles.push([ga, gb, gc]);
        pieceTris.push([ga, gb, gc]);

        const va = mesh2D.vertices[la];
        const vb = mesh2D.vertices[lb];
        const vc = mesh2D.vertices[lc];
        const area2 = Math.abs((vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x)) * 0.5;
        const third = area2 / 3;
        vertexArea[ga] += third;
        vertexArea[gb] += third;
        vertexArea[gc] += third;

        // In-plane Green-Lagrange shear constraint in (warp, weft) coordinates
        const e1 = sub2(vb, va);
        const e2 = sub2(vc, va);
        const du1 = dot2(e1, warpDir2);
        const dv1 = dot2(e1, weftDir2);
        const du2 = dot2(e2, warpDir2);
        const dv2 = dot2(e2, weftDir2);
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) >= 1e-2) {
          const invDet = 1 / det;
          const shearSpec = {
            i0: ga,
            i1: gb,
            i2: gc,
            m00: dv2 * invDet,
            m01: -du2 * invDet,
            m10: -dv1 * invDet,
            m11: du1 * invDet,
          };
          this._restShearSpecs.push(shearSpec);
          if (kShear > 1e-4) {
            const alphaShear = kShear >= 0.9999 ? 0 : ((1 - kShear) / kShear) * 1.2e-6;
            this.shearConstraints.push({
              ...shearSpec,
              alpha: alphaShear,
              lambda: 0,
            });
          }
        }

        const addEdge = (u, v, opp) => {
          const k = u < v ? `${u}_${v}` : `${v}_${u}`;
          if (!edgeFaces.has(k)) edgeFaces.set(k, []);
          edgeFaces.get(k).push({ u, v, opp });
        };
        addEdge(ga, gb, gc);
        addEdge(gb, gc, ga);
        addEdge(gc, ga, gb);
      }

      // Build structural & dihedral bending constraints
      for (const [, faces] of edgeFaces) {
        const u = faces[0].u;
        const v = faces[0].v;
        const pA2 = this.particles[u].rest2D;
        const pB2 = this.particles[v].rest2D;
        const e2 = sub2(pB2, pA2);
        const L0 = Math.hypot(e2.x, e2.y);
        if (L0 > 1e-4) {
          const dHat = vec2(e2.x / L0, e2.y / L0);
          const wWarp = dot2(dHat, warpDir2) ** 2;
          const wWeft = dot2(dHat, weftDir2) ** 2;
          const kEdge = clamp(wWarp * kWarp + wWeft * kWeft, 0.01, 1.0);
          const alpha = kEdge >= 0.9999 ? 0 : ((1 - kEdge) / kEdge) * 4e-7;
          this.structuralConstraints.push({
            a: u,
            b: v,
            restLength: L0,
            wWarp,
            wWeft,
            alpha,
            lambda: 0,
          });
        }

        if (faces.length === 2) {
          const f0 = faces[0];
          const f1 = faces[1];
          const bendSpec = {
            p1: f0.u,
            p2: f0.v,
            p3: f0.opp,
            p4: f1.opp,
          };
          this._restBendingSpecs.push(bendSpec);
          if (kBend > 1e-4) {
            const alphaBend = kBend >= 0.9999 ? 0 : ((1 - kBend) / kBend) * 2.5e-6;
            this.bendingConstraints.push({
              ...bendSpec,
              alpha: alphaBend,
            });
          }
        }
      }

      const endIdx = this.particles.length;
      const meta = {
        pieceId: piece.id,
        piece,
        startIdx,
        endIdx,
        triangleCount: pieceTris.length,
        normal: n,
      };
      this.pieceMeshes.push(meta);
      pieceMap.set(piece.id, meta);

      // Dart-closing constraints for unfolded darts
      if (Array.isArray(piece.darts)) {
        const nPts = piece.points.length;
        for (const dart of piece.darts) {
          if (!dart || parseBoolFlag(dart.folded)) continue;
          const ei = ((Math.trunc(finiteOr(dart.edgeIndex, 0)) % nPts) + nPts) % nPts;
          const p0 = piece.points[ei];
          const p1 = piece.points[(ei + 1) % nPts];
          const curve = piece.edges?.[ei]?.curve || null;
          const table = buildEdgeArcTable(p0, p1, curve, 32);
          if (table.totalLen <= 1e-3) continue;
          const tMid = clamp(finiteOr(dart.t, 0.5), 0.05, 0.95);
          const halfW = clamp(finiteOr(dart.widthMm, 20) * 0.5, 1, table.totalLen * 0.45);
          const sMid = tMid * table.totalLen;
          const tA = tAtArcLength(table, Math.max(0.01, sMid - halfW));
          const tB = tAtArcLength(table, Math.min(table.totalLen - 0.01, sMid + halfW));
          const dStart = evalEdgeAt(p0, p1, curve, tA);
          const dEnd = evalEdgeAt(p0, p1, curve, tB);
          const dMid = evalEdgeAt(p0, p1, curve, tAtArcLength(table, sMid));

          // Inward normal oriented into the piece interior regardless of CCW vs CW winding
          const windingSign = signedPolygonArea(outline2D) >= 0 ? 1 : -1;
          const tangent = sub2(dEnd, dStart);
          const tLen = Math.hypot(tangent.x, tangent.y);
          if (tLen <= 1e-4) continue;
          const inward = vec2((-tangent.y / tLen) * windingSign, (tangent.x / tLen) * windingSign);
          const depthMm = clamp(finiteOr(dart.depthMm, 80), 2, 400);
          const apex = { x: dMid.x + inward.x * depthMm, y: dMid.y + inward.y * depthMm };

          // Seed apex particle slightly out-of-plane along piece normal so dart folds smoothly into 3D
          const apexIdx = this._findClosestParticleInPiece(meta, apex);
          if (apexIdx !== -1) {
            const pApex = this.particles[apexIdx];
            pApex.pos = add3(pApex.pos, scale3(n, 1.2));
            pApex.prevPos = { ...pApex.pos };
            pApex.lastFinitePos = { ...pApex.pos };
          }

          const sideDir = sub2(dStart, dEnd);
          const findDartLegParticle = (ptTarget, wantPositiveSide) => {
            let bestIdx = -1;
            let bestD = Infinity;
            for (let i = meta.startIdx; i < meta.endIdx; i++) {
              const r2 = this.particles[i].rest2D;
              const sideDot = (r2.x - apex.x) * sideDir.x + (r2.y - apex.y) * sideDir.y;
              if (wantPositiveSide && sideDot < -1.5) continue;
              if (!wantPositiveSide && sideDot > 1.5) continue;
              const d = dist2D(r2, ptTarget);
              if (d < bestD) {
                bestD = d;
                bestIdx = i;
              }
            }
            return bestIdx !== -1 ? bestIdx : this._findClosestParticleInPiece(meta, ptTarget);
          };

          const seenDartPairs = new Set();
          for (let k = 1; k <= 12; k++) {
            const f = k / 12;
            const ptA = { x: apex.x + (dStart.x - apex.x) * f, y: apex.y + (dStart.y - apex.y) * f };
            const ptB = { x: apex.x + (dEnd.x - apex.x) * f, y: apex.y + (dEnd.y - apex.y) * f };
            const pIdxA = findDartLegParticle(ptA, true);
            const pIdxB = findDartLegParticle(ptB, false);
            if (pIdxA !== -1 && pIdxB !== -1 && pIdxA !== pIdxB) {
              const pairKey = pIdxA < pIdxB ? `${pIdxA}_${pIdxB}` : `${pIdxB}_${pIdxA}`;
              if (!seenDartPairs.has(pairKey)) {
                seenDartPairs.add(pairKey);
                this.dartConstraints.push({
                  seamId: dart.id || `dart_${ei}`,
                  a: pIdxA,
                  b: pIdxB,
                  isDart: true,
                });
              }
            }
          }
        }
      }
    }

    // Assign GSM-coupled particle inverse masses
    if (this.particles.length > 0) {
      const validAreas = vertexArea.filter((a) => a > 1e-4);
      const meanArea = validAreas.length > 0 ? validAreas.reduce((s, a) => s + a, 0) / validAreas.length : 100;
      const gsmFactor = clamp(finiteOr(this.material.gsm, 200) / 200, 0.25, 6.0);
      for (let i = 0; i < this.particles.length; i++) {
        const rel = vertexArea[i] > 1e-4 ? vertexArea[i] / meanArea : 1.0;
        this.particles[i].baseRelMass = rel;
        const mass = clamp(gsmFactor * rel, 0.25, 8.0);
        this.particles[i].invMass = 1 / mass;
      }
    }

    // Build sewing constraints (piece-to-piece & piece-to-internalLine)
    for (const seam of this.seams) {
      if (!seam || typeof seam !== 'object') continue;
      const mA = pieceMap.get(seam.pieceA);
      const mB = pieceMap.get(seam.pieceB);
      if (!mA || !mB) continue;

      const pA = mA.piece;
      const pB = mB.piece;
      const eA = ((Math.trunc(finiteOr(seam.edgeA, 0)) % pA.points.length) + pA.points.length) % pA.points.length;
      const pA0 = pA.points[eA];
      const pA1 = pA.points[(eA + 1) % pA.points.length];
      const curveA = pA.edges?.[eA]?.curve || null;

      const tsA = clamp(finiteOr(seam.tStartA, 0), 0, 1);
      const teA = clamp(finiteOr(seam.tEndA, 1), 0, 1);
      if (teA <= tsA + 1e-5) continue;

      const lutA = buildEdgeArcTable(pA0, pA1, curveA, 48, tsA, teA);

      let pB0, pB1, curveB, tsB, teB;
      if (typeof seam.internalLineIdB === 'string' && seam.internalLineIdB.length > 0) {
        const il = (Array.isArray(pB.internalLines) ? pB.internalLines : []).find((l) => l && l.id === seam.internalLineIdB);
        if (!il || !Array.isArray(il.points) || il.points.length < 2) continue;
        const segIdx = clamp(Math.trunc(finiteOr(seam.internalSegmentIndexB, 0)), 0, il.points.length - 2);
        pB0 = il.points[segIdx];
        pB1 = il.points[segIdx + 1];
        curveB = null;
        tsB = clamp(finiteOr(seam.tStartB, 0), 0, 1);
        teB = clamp(finiteOr(seam.tEndB, 1), 0, 1);
      } else {
        const eB = ((Math.trunc(finiteOr(seam.edgeB, 0)) % pB.points.length) + pB.points.length) % pB.points.length;
        pB0 = pB.points[eB];
        pB1 = pB.points[(eB + 1) % pB.points.length];
        curveB = pB.edges?.[eB]?.curve || null;
        tsB = clamp(finiteOr(seam.tStartB, 0), 0, 1);
        teB = clamp(finiteOr(seam.tEndB, 1), 0, 1);
      }
      if (teB <= tsB + 1e-5) continue;

      const lutB = buildEdgeArcTable(pB0, pB1, curveB, 48, tsB, teB);
      const maxLen = Math.max(lutA.totalLen, lutB.totalLen);
      const stations = clamp(Math.ceil(maxLen / Math.max(12, this.maxEdgeLengthMm * 0.65)) + 2, 6, 34);

      let seamReversed = parseBoolFlag(seam.reversed);
      if (
        (pat.templateId === 'pants' || pat.templateId === 'womens_trousers') &&
        seam.pieceA === 'waistband' &&
        (seam.id === 'seam_waist_front_left' || seam.id === 'seam_waist_back_right')
      ) {
        seamReversed = !seamReversed;
      }
      for (let k = 0; k < stations; k++) {
        const u = k / (stations - 1);
        const uB = seamReversed ? 1 - u : u;
        const ptA = evalEdgeAt(pA0, pA1, curveA, tAtArcLength(lutA, u * lutA.totalLen));
        const ptB = evalEdgeAt(pB0, pB1, curveB, tAtArcLength(lutB, uB * lutB.totalLen));
        const idxA = this._findClosestParticleInPiece(mA, ptA);
        const idxB = this._findClosestParticleInPiece(mB, ptB);
        if (idxA !== -1 && idxB !== -1 && idxA !== idxB) {
          this.sewingConstraints.push({
            seamId: seam.id || 'seam',
            a: idxA,
            b: idxB,
            isDart: false,
          });
        }
      }
    }

    this._clearInitialAvatarOverlaps();
  }

  _clearInitialAvatarOverlaps() {
    if (!this.avatar) return;
    const rawThickness = Math.max(0, finiteOr(this.material?.thicknessMm, 0.65));
    const thicknessOffset = rawThickness + 0.5;

    if (Array.isArray(this.avatar.torsoStations) && this.avatar.torsoStations.length >= 2) {
      const avatarClearance = Math.max(thicknessOffset + 3.8, 4.6);
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (p.invMass <= 0) continue;
        const proj = projectPointOutsideAvatarSDF(this.avatar, p.pos.x, p.pos.y, p.pos.z, avatarClearance);
        if (proj) {
          p.pos.x = proj.px; p.pos.y = proj.py; p.pos.z = proj.pz;
          p.prevPos.x = proj.px; p.prevPos.y = proj.py; p.prevPos.z = proj.pz;
          p.lastFinitePos.x = proj.px; p.lastFinitePos.y = proj.py; p.lastFinitePos.z = proj.pz;
        }
      }
      return;
    }

    if (!Array.isArray(this.avatar.colliders) || this.avatar.colliders.length === 0) {
      return;
    }
    const colliders = this.avatar.colliders;
    const isClear = (pt) => {
      for (let ci = 0; ci < colliders.length; ci++) {
        const col = colliders[ci];
        if (
          !col ||
          typeof col !== 'object' ||
          !col.center ||
          typeof col.center !== 'object' ||
          !col.radii ||
          typeof col.radii !== 'object'
        ) {
          continue;
        }
        const rx = Math.max(1, Math.max(1e-3, finiteOr(col.radii.x, 1)) + thicknessOffset);
        const ry = Math.max(1, Math.max(1e-3, finiteOr(col.radii.y, 1)) + thicknessOffset);
        const rz = Math.max(1, Math.max(1e-3, finiteOr(col.radii.z, 1)) + thicknessOffset);
        const dx = (pt.x - finiteOr(col.center.x, 0)) / rx;
        const dy = (pt.y - finiteOr(col.center.y, 0)) / ry;
        const dz = (pt.z - finiteOr(col.center.z, 0)) / rz;
        if (dx * dx + dy * dy + dz * dz < 1.0) return false;
      }
      return true;
    };

    for (let mi = 0; mi < this.pieceMeshes.length; mi++) {
      const meta = this.pieceMeshes[mi];
      let hasPinned = false;
      let hasOverlap = false;
      let outSum = vec3(0, 0, 0);
      for (let i = meta.startIdx; i < meta.endIdx; i++) {
        const p = this.particles[i];
        if (p.invMass <= 0) {
          hasPinned = true;
          break;
        }
        if (!isClear(p.pos)) {
          hasOverlap = true;
          for (let ci = 0; ci < colliders.length; ci++) {
            const col = colliders[ci];
            if (
              !col ||
              typeof col !== 'object' ||
              !col.center ||
              typeof col.center !== 'object' ||
              !col.radii ||
              typeof col.radii !== 'object'
            ) {
              continue;
            }
            const rx = Math.max(1, Math.max(1e-3, finiteOr(col.radii.x, 1)) + thicknessOffset);
            const ry = Math.max(1, Math.max(1e-3, finiteOr(col.radii.y, 1)) + thicknessOffset);
            const rz = Math.max(1, Math.max(1e-3, finiteOr(col.radii.z, 1)) + thicknessOffset);
            const dx = (p.pos.x - finiteOr(col.center.x, 0)) / rx;
            const dy = (p.pos.y - finiteOr(col.center.y, 0)) / ry;
            const dz = (p.pos.z - finiteOr(col.center.z, 0)) / rz;
            if (dx * dx + dy * dy + dz * dz < 1.0) {
              const g = vec3(dx / rx, dy / ry, dz / rz);
              outSum = add3(outSum, len3(g) > 1e-6 ? norm3(g) : meta.normal);
            }
          }
        }
      }
      if (hasPinned || !hasOverlap) continue;

      const dirs = [];
      if (len3(outSum) > 1e-6) dirs.push(norm3(outSum));
      dirs.push(meta.normal, scale3(meta.normal, -1));
      dirs.push(vec3(0, 0, 1), vec3(0, 0, -1), vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0));

      let bestShift = null;
      let bestDist = Infinity;
      for (const dir of dirs) {
        if (!dir || len3(dir) < 1e-6) continue;
        for (let step = 5; step <= 220; step += 5) {
          if (step >= bestDist) break;
          const shift = scale3(dir, step);
          let allOk = true;
          for (let i = meta.startIdx; i < meta.endIdx; i++) {
            if (!isClear(add3(this.particles[i].pos, shift))) {
              allOk = false;
              break;
            }
          }
          if (allOk) {
            bestShift = shift;
            bestDist = step;
            break;
          }
        }
      }
      if (bestShift) {
        for (let i = meta.startIdx; i < meta.endIdx; i++) {
          const p = this.particles[i];
          p.pos = add3(p.pos, bestShift);
          p.prevPos = { ...p.pos };
          p.lastFinitePos = { ...p.pos };
        }
      }
    }
  }

  _findClosestParticleInPiece(pieceMeta, pt2D) {
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = pieceMeta.startIdx; i < pieceMeta.endIdx; i++) {
      const d = dist2D(this.particles[i].rest2D, pt2D);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  _enforceFiniteGuard() {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (
        !Number.isFinite(p.pos.x) ||
        !Number.isFinite(p.pos.y) ||
        !Number.isFinite(p.pos.z) ||
        Math.abs(p.pos.x) > 5e4 ||
        Math.abs(p.pos.y) > 5e4 ||
        Math.abs(p.pos.z) > 5e4
      ) {
        p.pos = { ...p.lastFinitePos };
        p.prevPos = { ...p.lastFinitePos };
      } else {
        p.lastFinitePos = { ...p.pos };
      }
    }
  }

  _solveStretchConstraints(subDtSq) {
    for (let i = 0; i < this.structuralConstraints.length; i++) {
      const c = this.structuralConstraints[i];
      const pa = this.particles[c.a];
      const pb = this.particles[c.b];
      const wa = pa.invMass;
      const wb = pb.invMass;
      const wSum = wa + wb;
      if (wSum <= 0) continue;

      const dx = pb.pos.x - pa.pos.x;
      const dy = pb.pos.y - pa.pos.y;
      const dz = pb.pos.z - pa.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d <= 1e-8) continue;

      const C = d - c.restLength;
      const alphaTilde = c.alpha / subDtSq;
      const denom = wSum + alphaTilde;
      if (denom <= 1e-12) continue;

      const dLambda = clamp((-C - alphaTilde * c.lambda) / denom, -12, 12);
      c.lambda += dLambda;
      const corr = dLambda / d;
      const corrX = dx * corr;
      const corrY = dy * corr;
      const corrZ = dz * corr;

      pa.pos.x -= wa * corrX;
      pa.pos.y -= wa * corrY;
      pa.pos.z -= wa * corrZ;
      pb.pos.x += wb * corrX;
      pb.pos.y += wb * corrY;
      pb.pos.z += wb * corrZ;
    }
  }

  _solveShearConstraints(subDtSq) {
    for (let i = 0; i < this.shearConstraints.length; i++) {
      const c = this.shearConstraints[i];
      const p0 = this.particles[c.i0];
      const p1 = this.particles[c.i1];
      const p2 = this.particles[c.i2];
      const w0 = p0.invMass;
      const w1 = p1.invMass;
      const w2 = p2.invMass;

      const p0x = p0.pos.x, p0y = p0.pos.y, p0z = p0.pos.z;
      const e1x = p1.pos.x - p0x, e1y = p1.pos.y - p0y, e1z = p1.pos.z - p0z;
      const e2x = p2.pos.x - p0x, e2y = p2.pos.y - p0y, e2z = p2.pos.z - p0z;

      const m00 = c.m00, m01 = c.m01, m10 = c.m10, m11 = c.m11;
      const fux = e1x * m00 + e2x * m10;
      const fuy = e1y * m00 + e2y * m10;
      const fuz = e1z * m00 + e2z * m10;
      const fvx = e1x * m01 + e2x * m11;
      const fvy = e1y * m01 + e2y * m11;
      const fvz = e1z * m01 + e2z * m11;

      const C = fux * fvx + fuy * fvy + fuz * fvz;
      const g1x = fvx * m00 + fux * m01;
      const g1y = fvy * m00 + fuy * m01;
      const g1z = fvz * m00 + fuz * m01;
      const g2x = fvx * m10 + fux * m11;
      const g2y = fvy * m10 + fuy * m11;
      const g2z = fvz * m10 + fuz * m11;
      const g0x = -(g1x + g2x);
      const g0y = -(g1y + g2y);
      const g0z = -(g1z + g2z);

      const alphaTilde = c.alpha / subDtSq;
      const denom =
        w0 * (g0x * g0x + g0y * g0y + g0z * g0z) +
        w1 * (g1x * g1x + g1y * g1y + g1z * g1z) +
        w2 * (g2x * g2x + g2y * g2y + g2z * g2z) +
        alphaTilde;
      if (denom <= 1e-12) continue;

      const dLambda = clamp((-C - alphaTilde * c.lambda) / denom, -10, 10);
      c.lambda += dLambda;

      const s0 = w0 * dLambda;
      const s1 = w1 * dLambda;
      const s2 = w2 * dLambda;
      p0.pos.x += s0 * g0x;
      p0.pos.y += s0 * g0y;
      p0.pos.z += s0 * g0z;
      p1.pos.x += s1 * g1x;
      p1.pos.y += s1 * g1y;
      p1.pos.z += s1 * g1z;
      p2.pos.x += s2 * g2x;
      p2.pos.y += s2 * g2y;
      p2.pos.z += s2 * g2z;
    }
  }

  _solveBendingConstraints(subDtSq) {
    for (let i = 0; i < this.bendingConstraints.length; i++) {
      const c = this.bendingConstraints[i];
      const p1 = this.particles[c.p1];
      const p2 = this.particles[c.p2];
      const p3 = this.particles[c.p3];
      const p4 = this.particles[c.p4];

      const p1x = p1.pos.x, p1y = p1.pos.y, p1z = p1.pos.z;
      const p2x = p2.pos.x - p1x, p2y = p2.pos.y - p1y, p2z = p2.pos.z - p1z;
      const p3x = p3.pos.x - p1x, p3y = p3.pos.y - p1y, p3z = p3.pos.z - p1z;
      const p4x = p4.pos.x - p1x, p4y = p4.pos.y - p1y, p4z = p4.pos.z - p1z;

      const c1x = p2y * p3z - p2z * p3y;
      const c1y = p2z * p3x - p2x * p3z;
      const c1z = p2x * p3y - p2y * p3x;
      const c2x = p4y * p2z - p4z * p2y;
      const c2y = p4z * p2x - p4x * p2z;
      const c2z = p4x * p2y - p4y * p2x;

      const len1Sq = c1x * c1x + c1y * c1y + c1z * c1z;
      const len2Sq = c2x * c2x + c2y * c2y + c2z * c2z;
      if (len1Sq < 1e-8 || len2Sq < 1e-8) continue;

      const invL1 = 1 / Math.sqrt(len1Sq);
      const invL2 = 1 / Math.sqrt(len2Sq);
      const n1x = c1x * invL1, n1y = c1y * invL1, n1z = c1z * invL1;
      const n2x = c2x * invL2, n2y = c2y * invL2, n2z = c2z * invL2;

      const rawDot = n1x * n2x + n1y * n2y + n1z * n2z;
      if (rawDot >= 0.999999) continue;
      const d = clamp(rawDot, -0.9999, 0.9999);
      const sSq = 1 - d * d;
      if (sSq < 1e-10) continue;
      const s = Math.sqrt(sSq);

      const n2mx = n2x - n1x * d, n2my = n2y - n1y * d, n2mz = n2z - n1z * d;
      const n1mx = n1x - n2x * d, n1my = n1y - n2y * d, n1mz = n1z - n2z * d;

      const q3x = (n2my * p2z - n2mz * p2y) * invL1;
      const q3y = (n2mz * p2x - n2mx * p2z) * invL1;
      const q3z = (n2mx * p2y - n2my * p2x) * invL1;

      const q4x = (p2y * n1mz - p2z * n1my) * invL2;
      const q4y = (p2z * n1mx - p2x * n1mz) * invL2;
      const q4z = (p2x * n1my - p2y * n1mx) * invL2;

      const q2x = -((n2my * p3z - n2mz * p3y) * invL1 + (p4y * n1mz - p4z * n1my) * invL2);
      const q2y = -((n2mz * p3x - n2mx * p3z) * invL1 + (p4z * n1mx - p4x * n1mz) * invL2);
      const q2z = -((n2mx * p3y - n2my * p3x) * invL1 + (p4x * n1my - p4y * n1mx) * invL2);

      const q1x = -(q2x + q3x + q4x);
      const q1y = -(q2y + q3y + q4y);
      const q1z = -(q2z + q3z + q4z);

      const sumQ =
        p1.invMass * (q1x * q1x + q1y * q1y + q1z * q1z) +
        p2.invMass * (q2x * q2x + q2y * q2y + q2z * q2z) +
        p3.invMass * (q3x * q3x + q3y * q3y + q3z * q3z) +
        p4.invMass * (q4x * q4x + q4y * q4y + q4z * q4z);
      const alphaTilde = c.alpha / subDtSq;
      const denom = sumQ + alphaTilde * sSq;
      if (denom <= 1e-12) continue;

      const factor = clamp((Math.acos(d) * s) / denom, -8, 8);
      const f1 = p1.invMass * factor;
      const f2 = p2.invMass * factor;
      const f3 = p3.invMass * factor;
      const f4 = p4.invMass * factor;

      p1.pos.x += q1x * f1; p1.pos.y += q1y * f1; p1.pos.z += q1z * f1;
      p2.pos.x += q2x * f2; p2.pos.y += q2y * f2; p2.pos.z += q2z * f2;
      p3.pos.x += q3x * f3; p3.pos.y += q3y * f3; p3.pos.z += q3z * f3;
      p4.pos.x += q4x * f4; p4.pos.y += q4y * f4; p4.pos.z += q4z * f4;
    }
  }

  _solveSewingAndDarts(subSew, maxPullMm = 3.2) {
    const pullPair = (c, strength, maxStepPull) => {
      const pa = this.particles[c.a];
      const pb = this.particles[c.b];
      const wSum = pa.invMass + pb.invMass;
      if (wSum <= 0) return;
      const dx = pb.pos.x - pa.pos.x;
      const dy = pb.pos.y - pa.pos.y;
      const dz = pb.pos.z - pa.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d <= 0.2) return;
      const pull = Math.min(d * strength, maxStepPull);
      const s = pull / (d * wSum);
      const sa = pa.invMass * s;
      const sb = pb.invMass * s;
      pa.pos.x += dx * sa; pa.pos.y += dy * sa; pa.pos.z += dz * sa;
      pb.pos.x -= dx * sb; pb.pos.y -= dy * sb; pb.pos.z -= dz * sb;
    };

    for (let i = 0; i < this.sewingConstraints.length; i++) {
      pullPair(this.sewingConstraints[i], subSew, maxPullMm);
    }
    const dartPull = Math.min(0.82, subSew * 2.1);
    for (let i = 0; i < this.dartConstraints.length; i++) {
      pullPair(this.dartConstraints[i], dartPull, Math.max(4.8, maxPullMm));
    }
  }

  _solveDartsOnly(strength = 0.72, maxPullMm = 4.5) {
    if (this.dartConstraints.length === 0) return;
    for (let i = 0; i < this.dartConstraints.length; i++) {
      const c = this.dartConstraints[i];
      const pa = this.particles[c.a];
      const pb = this.particles[c.b];
      const wSum = pa.invMass + pb.invMass;
      if (wSum <= 0) continue;
      const dx = pb.pos.x - pa.pos.x;
      const dy = pb.pos.y - pa.pos.y;
      const dz = pb.pos.z - pa.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d <= 0.15) continue;
      const pull = Math.min(d * strength, maxPullMm);
      const s = pull / (d * wSum);
      const sa = pa.invMass * s;
      const sb = pb.invMass * s;
      pa.pos.x += dx * sa; pa.pos.y += dy * sa; pa.pos.z += dz * sa;
      pb.pos.x -= dx * sb; pb.pos.y -= dy * sb; pb.pos.z -= dz * sb;
    }
  }

  _resolveCollisions(thicknessOffset, friction) {
    const oneMinusFriction = 1 - friction;

    // 1. STL Triangle-Mesh BVH Collision in raw STL coordinates
    if (this.stlCollider) {
      const bvh = this.stlCollider;
      const targetOffset = thicknessOffset + 0.02;
      const targetOffsetSq = targetOffset * targetOffset;
      const minClearSq = thicknessOffset * thicknessOffset;
      const bMin = bvh.bounds.min;
      const bMax = bvh.bounds.max;
      const pad = Math.max(40, targetOffset * 4);
      const localRadiusSq = pad * pad;
      const diag = len3(bvh.bounds.size) + targetOffset + 10;
      const diagSq = diag * diag;

      if (!ClothSimulation._stlEscapeDirs) {
        const dirs = [];
        for (let x = -1; x <= 1; x++) {
          for (let y = -1; y <= 1; y++) {
            for (let z = -1; z <= 1; z++) {
              if (x === 0 && y === 0 && z === 0) continue;
              dirs.push(norm3(vec3(x, y, z)));
            }
          }
        }
        ClothSimulation._stlEscapeDirs = dirs;
      }
      const fixedDirs = ClothSimulation._stlEscapeDirs;

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (p.invMass <= 0) continue;

        const nearBounds =
          p.pos.x >= bMin.x - pad &&
          p.pos.x <= bMax.x + pad &&
          p.pos.y >= bMin.y - pad &&
          p.pos.y <= bMax.y + pad &&
          p.pos.z >= bMin.z - pad &&
          p.pos.z <= bMax.z + pad;
        if (!nearBounds) continue;

        let closest = querySTLBvhClosest(bvh, p.pos, localRadiusSq);
        if (!closest) {
          closest = querySTLBvhClosest(bvh, p.pos, diagSq);
        }
        if (!closest) continue;

        const closestDist = Math.sqrt(closest.distSq);
        const signedDist = dot3(sub3(p.pos, closest.q), closest.nFeature);
        if (signedDist > 0.25 && closestDist >= targetOffset) continue;

        const inside = isPointInsideSTLBvh(bvh, p.pos);
        if (!inside && signedDist >= 0 && closestDist >= thicknessOffset) continue;

        const oldPos = { ...p.pos };
        let cur = { ...p.pos };
        let lastSumDir = closest.nFeature;
        let lastAvgFaceN = closest.nFeature;

        for (let pass = 0; pass < 8; pass++) {
          const hits = querySTLBvhWithinRadius(bvh, cur, targetOffsetSq);
          const curInside = isPointInsideSTLBvh(bvh, cur);
          if (!curInside && hits.length === 0) break;

          if (hits.length === 0 && curInside) {
            const farHit = querySTLBvhClosest(bvh, cur, diagSq);
            if (!farHit) break;
            cur = add3(farHit.q, scale3(farHit.nFeature, targetOffset));
            lastSumDir = farHit.nFeature;
            lastAvgFaceN = farHit.nFeature;
            continue;
          }

          hits.sort((a, b) => a.distSq - b.distSq);
          if (hits.length === 1 && !curInside) {
            const h0 = hits[0];
            const d0 = Math.sqrt(h0.distSq);
            const sd0 = dot3(sub3(cur, h0.q), h0.nFeature);
            const dir0 = sd0 >= 0 && d0 > 1e-5 ? scale3(sub3(cur, h0.q), 1 / d0) : h0.nFeature;
            cur = add3(h0.q, scale3(dir0, targetOffset));
            lastSumDir = dir0;
            lastAvgFaceN = h0.tri.normal;
            continue;
          }

          let sumDir = vec3(0, 0, 0);
          let avgFaceN = vec3(0, 0, 0);
          const count = Math.min(hits.length, 12);
          for (let hi = 0; hi < count; hi++) {
            const h = hits[hi];
            const d = Math.sqrt(h.distSq);
            const pen = targetOffset - d;
            const sd = dot3(sub3(cur, h.q), h.nFeature);
            const outDir = !curInside && sd >= 0 && d > 1e-5 ? scale3(sub3(cur, h.q), 1 / d) : h.nFeature;
            const w = curInside ? targetOffset : Math.max(0.15, pen) + 0.05;
            sumDir = add3(sumDir, scale3(outDir, w));
            avgFaceN = add3(avgFaceN, h.tri.normal);
          }

          const h0 = hits[0];
          const d0 = Math.sqrt(h0.distSq);
          const stepDir = len3(sumDir) > 1e-6 ? norm3(sumDir) : h0.nFeature;
          lastSumDir = stepDir;
          lastAvgFaceN = len3(avgFaceN) > 1e-6 ? norm3(avgFaceN) : h0.tri.normal;
          const stepMag = curInside
            ? Math.max(targetOffset, targetOffset + d0)
            : Math.max(0.35, targetOffset - d0 + 0.12);
          cur = add3(cur, scale3(stepDir, stepMag));
        }

        // Fallback escape probe for narrow concave grooves (< 2 * thicknessOffset) or acute corners
        if (isPointInsideSTLBvh(bvh, cur) || querySTLBvhClosest(bvh, cur, minClearSq)) {
          const toCenterOut = sub3(cur, bvh.bounds.center);
          const candDirs = [lastSumDir, lastAvgFaceN, closest.nFeature];
          if (len3(toCenterOut) > 1e-6) candDirs.push(norm3(toCenterOut));
          for (let di = 0; di < fixedDirs.length; di++) candDirs.push(fixedDirs[di]);

          const origins = [cur, oldPos];
          const radii = [
            targetOffset * 0.75,
            targetOffset * 1.25,
            targetOffset * 1.9,
            targetOffset * 2.8,
            targetOffset * 4.2,
            targetOffset * 6.5,
          ];
          let bestCand = null;
          let bestMoveSq = Infinity;
          for (let ri = 0; ri < radii.length; ri++) {
            const rad = radii[ri];
            for (let oi = 0; oi < origins.length; oi++) {
              const org = origins[oi];
              for (let di = 0; di < candDirs.length; di++) {
                const cand = add3(org, scale3(candDirs[di], rad));
                const moveSq =
                  (cand.x - oldPos.x) * (cand.x - oldPos.x) +
                  (cand.y - oldPos.y) * (cand.y - oldPos.y) +
                  (cand.z - oldPos.z) * (cand.z - oldPos.z);
                if (moveSq >= bestMoveSq) continue;
                if (isPointInsideSTLBvh(bvh, cand)) continue;
                if (querySTLBvhClosest(bvh, cand, minClearSq)) continue;
                bestCand = cand;
                bestMoveSq = moveSq;
              }
            }
            if (bestCand) break;
          }
          if (bestCand) cur = bestCand;
        }

        const v = sub3(oldPos, p.prevPos);
        const moveVec = sub3(cur, oldPos);
        const dir = len3(moveVec) > 1e-6 ? norm3(moveVec) : closest.nFeature;
        p.pos = cur;
        const vn = dot3(v, dir);
        const vt = sub3(v, scale3(dir, vn));
        const vAfter = add3(scale3(dir, Math.max(0, vn) * 0.12), scale3(vt, oneMinusFriction));
        p.prevPos = sub3(p.pos, vAfter);
      }
    }

    // 2A. Exact Analytical SDF Avatar Collision (Torso-Neck Loft + Tapered A-Pose Limb Capsules + Face Guard)
    if (this.avatar && Array.isArray(this.avatar.torsoStations) && this.avatar.torsoStations.length >= 2) {
      const floorY = finiteOr(this.avatar.floorY, -980);
      const avatarClearance = Math.max(thicknessOffset + 3.8, 4.6);
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (p.invMass <= 0) continue;
        const ox = p.pos.x, oy = p.pos.y, oz = p.pos.z;
        const proj = projectPointOutsideAvatarSDF(this.avatar, ox, oy, oz, avatarClearance);
        if (proj) {
          const vx = ox - p.prevPos.x;
          const vy = oy - p.prevPos.y;
          const vz = oz - p.prevPos.z;
          const nx = proj.nx, ny = proj.ny, nz = proj.nz;
          p.pos.x = proj.px; p.pos.y = proj.py; p.pos.z = proj.pz;
          const vn = vx * nx + vy * ny + vz * nz;
          const vtx = vx - nx * vn;
          const vty = vy - ny * vn;
          const vtz = vz - nz * vn;
          const vnOut = vn > 0 ? vn * 0.08 : 0;
          p.prevPos.x = proj.px - (nx * vnOut + vtx * oneMinusFriction);
          p.prevPos.y = proj.py - (ny * vnOut + vty * oneMinusFriction);
          p.prevPos.z = proj.pz - (nz * vnOut + vtz * oneMinusFriction);
        }
        if (p.pos.y < floorY) {
          const vx = p.pos.x - p.prevPos.x;
          const vz = p.pos.z - p.prevPos.z;
          p.pos.y = floorY;
          p.prevPos.x = p.pos.x - vx * oneMinusFriction;
          p.prevPos.y = floorY;
          p.prevPos.z = p.pos.z - vz * oneMinusFriction;
        }
      }

      // Triangle centroid proximity pushout so stretched faces never slice into curved shoulders/chest
      const faceClearance = Math.max(thicknessOffset + 2.2, 2.8);
      for (let ti = 0; ti < this.triangles.length; ti++) {
        const [ia, ib, ic] = this.triangles[ti];
        const pa = this.particles[ia];
        const pb = this.particles[ib];
        const pc = this.particles[ic];
        const wSum = pa.invMass + pb.invMass + pc.invMass;
        if (wSum <= 0) continue;
        const cx = (pa.pos.x + pb.pos.x + pc.pos.x) / 3;
        const cy = (pa.pos.y + pb.pos.y + pc.pos.y) / 3;
        const cz = (pa.pos.z + pb.pos.z + pc.pos.z) / 3;
        const cProj = projectPointOutsideAvatarSDF(this.avatar, cx, cy, cz, faceClearance);
        if (cProj) {
          const dx = cProj.px - cx;
          const dy = cProj.py - cy;
          const dz = cProj.pz - cz;
          if (pa.invMass > 0) { pa.pos.x += dx; pa.pos.y += dy; pa.pos.z += dz; }
          if (pb.invMass > 0) { pb.pos.x += dx; pb.pos.y += dy; pb.pos.z += dz; }
          if (pc.invMass > 0) { pc.pos.x += dx; pc.pos.y += dy; pc.pos.z += dz; }
        }
      }
      return;
    }

    // 2B. Custom Avatar Ellipsoid Colliders Fallback
    if (this.avatar && Array.isArray(this.avatar.colliders)) {
      const floorY = finiteOr(this.avatar.floorY, -980);
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (p.invMass <= 0) continue;
        for (let ci = 0; ci < this.avatar.colliders.length; ci++) {
          const col = this.avatar.colliders[ci];
          if (
            !col ||
            typeof col !== 'object' ||
            !col.center ||
            typeof col.center !== 'object' ||
            !col.radii ||
            typeof col.radii !== 'object'
          ) {
            continue;
          }
          const cx = finiteOr(col.center.x, 0);
          const cy = finiteOr(col.center.y, 0);
          const cz = finiteOr(col.center.z, 0);
          const rx = Math.max(1, Math.max(1e-3, finiteOr(col.radii.x, 1)) + thicknessOffset);
          const ry = Math.max(1, Math.max(1e-3, finiteOr(col.radii.y, 1)) + thicknessOffset);
          const rz = Math.max(1, Math.max(1e-3, finiteOr(col.radii.z, 1)) + thicknessOffset);
          const dx = (p.pos.x - cx) / rx;
          const dy = (p.pos.y - cy) / ry;
          const dz = (p.pos.z - cz) / rz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1.0) {
            const v = sub3(p.pos, p.prevPos);
            let dir;
            if (d2 > 1e-8) {
              const inv = 1 / Math.sqrt(d2);
              p.pos = vec3(
                cx + dx * inv * rx,
                cy + dy * inv * ry,
                cz + dz * inv * rz
              );
              dir = norm3(vec3(dx / rx, dy / ry, dz / rz));
            } else {
              p.pos = vec3(cx, cy, cz + rz);
              dir = vec3(0, 0, 1);
            }
            const vn = dot3(v, dir);
            const vt = sub3(v, scale3(dir, vn));
            const vAfter = add3(scale3(dir, Math.max(0, vn) * 0.12), scale3(vt, oneMinusFriction));
            p.prevPos = sub3(p.pos, vAfter);
          }
        }
        if (p.pos.y < floorY) {
          const vx = p.pos.x - p.prevPos.x;
          const vz = p.pos.z - p.prevPos.z;
          p.pos.y = floorY;
          p.prevPos.x = p.pos.x - vx * oneMinusFriction;
          p.prevPos.y = floorY;
          p.prevPos.z = p.pos.z - vz * oneMinusFriction;
        }
      }
    }
  }

  step(numSteps = 1) {
    const steps = validateSimSteps(numSteps, 1);
    if (steps === 0) {
      return this.computeStrainAnalysis();
    }

    const subDt = this.dt / this.substeps;
    const subDtSq = subDt * subDt;
    const damping = clamp(finiteOr(this.material.damping, 0.95), 0.7, 0.999);
    const subDamping = Math.pow(damping, 1 / this.substeps);
    const friction = clamp(finiteOr(this.material.friction, 0.4), 0, 1);
    const rawThickness = Math.max(0, finiteOr(this.material.thicknessMm, 0.65));
    const thicknessOffset = rawThickness + 0.5;

    for (let s = 0; s < steps; s++) {
      const sewStrength = Math.min(0.68, 0.14 + this.stepCount * 0.016);
      const subSew = 1 - Math.pow(1 - sewStrength, 1 / this.substeps);
      const maxPull = Math.min(4.8, 2.0 + this.stepCount * 0.14);

      for (let sub = 0; sub < this.substeps; sub++) {
        // Verlet integration
        for (let i = 0; i < this.particles.length; i++) {
          const p = this.particles[i];
          if (p.invMass <= 0) {
            p.prevPos.x = p.pos.x;
            p.prevPos.y = p.pos.y;
            p.prevPos.z = p.pos.z;
            continue;
          }
          const vx = clamp((p.pos.x - p.prevPos.x) * subDamping, -14, 14);
          const vy = clamp((p.pos.y - p.prevPos.y) * subDamping, -14, 14);
          const vz = clamp((p.pos.z - p.prevPos.z) * subDamping, -14, 14);
          p.prevPos.x = p.pos.x;
          p.prevPos.y = p.pos.y;
          p.prevPos.z = p.pos.z;
          p.pos.x += vx;
          p.pos.y += vy + this.gravityMmS2 * subDtSq;
          p.pos.z += vz;
        }

        // Reset constraint lambdas per substep
        for (let i = 0; i < this.structuralConstraints.length; i++) this.structuralConstraints[i].lambda = 0;
        for (let i = 0; i < this.shearConstraints.length; i++) this.shearConstraints[i].lambda = 0;

        this._solveSewingAndDarts(subSew, maxPull);
        this._solveStretchConstraints(subDtSq);
        this._solveShearConstraints(subDtSq);
        this._solveBendingConstraints(subDtSq);
        this._solveStretchConstraints(subDtSq);
        this._solveDartsOnly(0.75, 4.5);
        this._resolveCollisions(thicknessOffset, friction);
        this._enforceFiniteGuard();
      }

      this.stepCount++;
    }

    return this.computeStrainAnalysis();
  }

  computeStrainAnalysis() {
    const n = this.particles.length;
    const sumStrain = new Float64Array(n);
    const weightStrain = new Float64Array(n);

    const minRestForStrain = Math.min(6.0, this.maxEdgeLengthMm * 0.2);
    for (let i = 0; i < this.structuralConstraints.length; i++) {
      const c = this.structuralConstraints[i];
      if (c.restLength <= minRestForStrain) continue;
      const d = dist3(this.particles[c.a].pos, this.particles[c.b].pos);
      const rawStrain = ((d - c.restLength) / c.restLength) * 100;
      const s = Number.isFinite(rawStrain) ? Math.max(0, rawStrain) : 0;
      const w = c.restLength;
      sumStrain[c.a] += s * w;
      weightStrain[c.a] += w;
      sumStrain[c.b] += s * w;
      weightStrain[c.b] += w;
    }

    const maxSafe =
      Number.isFinite(this.material.maxSafeStrainPct) && this.material.maxSafeStrainPct > 0
        ? this.material.maxSafeStrainPct
        : 10.0;

    let totalStrain = 0;
    let maxStrainPct = 0;
    let tightParticleCount = 0;
    const vertexColors = new Array(n * 3);

    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      const avg = weightStrain[i] > 1e-6 ? sumStrain[i] / weightStrain[i] : 0;
      const strainPct = Number((Number.isFinite(avg) ? Math.max(0, avg) : 0).toFixed(2));
      p.strainPct = strainPct;
      totalStrain += strainPct;
      if (strainPct > maxStrainPct) maxStrainPct = strainPct;
      if (strainPct > maxSafe) tightParticleCount++;

      const ratio = strainPct / maxSafe;
      let r, g, b;
      if (strainPct < 1.0 || ratio < 0.2) {
        const t = clamp(ratio / 0.2, 0, 1);
        r = 0.23 + (0.13 - 0.23) * t;
        g = 0.51 + (0.77 - 0.51) * t;
        b = 0.96 + (0.37 - 0.96) * t;
      } else if (ratio <= 0.65) {
        r = 0.13;
        g = 0.77;
        b = 0.37;
      } else if (ratio <= 1.0) {
        const t = (ratio - 0.65) / 0.35;
        r = 0.13 + (0.96 - 0.13) * t;
        g = 0.77 + (0.62 - 0.77) * t;
        b = 0.37 + (0.04 - 0.37) * t;
      } else {
        const t = clamp((ratio - 1.0) / 0.5, 0, 1);
        r = 0.96 + (0.94 - 0.96) * t;
        g = 0.62 + (0.27 - 0.62) * t;
        b = 0.04 + (0.27 - 0.04) * t;
      }
      p.color = [r, g, b];
      vertexColors[i * 3] = r;
      vertexColors[i * 3 + 1] = g;
      vertexColors[i * 3 + 2] = b;
    }

    const meanStrainPct = n > 0 ? Number((totalStrain / n).toFixed(2)) : 0;
    maxStrainPct = Number(maxStrainPct.toFixed(2));

    let avgSewGapMm = 0;
    if (this.sewingConstraints.length > 0) {
      let gapSum = 0;
      for (let i = 0; i < this.sewingConstraints.length; i++) {
        const sc = this.sewingConstraints[i];
        gapSum += dist3(this.particles[sc.a].pos, this.particles[sc.b].pos);
      }
      avgSewGapMm = Number((gapSum / this.sewingConstraints.length).toFixed(2));
    }

    const fitStatus =
      maxStrainPct > maxSafe * 1.35 ? 'too_tight' : maxStrainPct > maxSafe ? 'snug' : 'good_fit';

    return {
      stepCount: this.stepCount,
      particleCount: n,
      triangleCount: this.triangles.length,
      meanStrainPct,
      maxStrainPct,
      maxSafeStrainPct: maxSafe,
      tightParticleCount,
      avgSewGapMm,
      fitStatus,
      vertexColors,
    };
  }
}

export function runSimulationSteps(pattern, options = {}) {
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const steps = validateSimSteps(opts.steps, 120);

  const sim = new ClothSimulation(pattern, opts);
  const strainReport = steps > 0 ? sim.step(steps) : sim.computeStrainAnalysis();

  const finiteOk =
    sim.particles.every(
      (p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)
    ) &&
    Number.isFinite(strainReport.meanStrainPct) &&
    Number.isFinite(strainReport.maxStrainPct);

  return {
    stepCount: sim.stepCount,
    particles: sim.particles.map((p) => ({
      index: p.index,
      pieceId: p.pieceId,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      rest2D: { x: p.rest2D.x, y: p.rest2D.y },
      strainPct: p.strainPct,
      color: p.color,
    })),
    triangles: sim.triangles,
    piecesMeta: sim.pieceMeshes,
    seams3D: sim.sewingConstraints.map((s) => ({
      seamId: s.seamId,
      a: s.a,
      b: s.b,
      posA: { ...sim.particles[s.a].pos },
      posB: { ...sim.particles[s.b].pos },
      gapMm: dist3(sim.particles[s.a].pos, sim.particles[s.b].pos),
    })),
    strainReport,
    avgSewGapMm: strainReport.avgSewGapMm,
    finiteOk,
    avatar: sim.avatar,
    stlBounds: sim.stlCollider ? sim.stlCollider.bounds : null,
  };
}
