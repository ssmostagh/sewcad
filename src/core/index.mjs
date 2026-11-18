/**
 * Isomorphic Core Barrel for pattern_studio_v2.
 * M1 exports: types, geometry, templates.
 * M2 exports: stl, materials, physics (+ conditional stl_cover hook registration).
 * M3 exports: nesting, exporters.
 */

import { registerStlCoverGenerator } from './templates.mjs';
import { unwrapSTLToPattern } from './stl.mjs';
import { getMaterialConfig } from './materials.mjs';

registerStlCoverGenerator((userParams = {}, options = {}) => {
  const stlInput =
    options?.stlMesh ??
    options?.mesh ??
    options?.stlData ??
    options?.stlText ??
    options?.stlBuffer ??
    options?.stlInput ??
    options?.stl ??
    userParams?.stlMesh ??
    userParams?.mesh ??
    userParams?.stlData ??
    userParams?.stlText ??
    userParams?.stlBuffer ??
    userParams?.stlInput ??
    userParams?.stl;

  if (stlInput === undefined || stlInput === null || stlInput === '') {
    return null;
  }

  const materialId =
    typeof userParams?.materialId === 'string' && userParams.materialId.length > 0
      ? userParams.materialId
      : typeof options?.materialId === 'string' && options.materialId.length > 0
        ? options.materialId
        : 'veg_leather';

  const rawThickness =
    userParams?.thicknessMm ??
    options?.thicknessMm ??
    userParams?.materialThicknessMm ??
    options?.materialThicknessMm;

  const thicknessMm =
    rawThickness !== undefined && rawThickness !== null
      ? rawThickness
      : userParams?.materialId || options?.materialId
        ? getMaterialConfig(materialId).thicknessMm
        : 0;

  return unwrapSTLToPattern(stlInput, {
    ...options,
    ...userParams,
    name: userParams?.stlName || options?.stlName || options?.name || userParams?.name,
    materialId,
    thicknessMm,
  });
});

export * from './types.mjs';
export {
  add2,
  add3,
  arcLengthAtT,
  buildEdgeArcTable,
  clipSelfIntersectingLoops,
  computeEdgeLength,
  computePieceCutBoundary,
  computePieceGrainline,
  computePieceMeasurements,
  computePieceNotches,
  convertFromMm,
  convertToMm,
  cross2,
  cross3,
  deduplicateConsecutivePoints,
  dist2,
  dist2D,
  dist3,
  dot2,
  dot3,
  edgeArcLength,
  ensureCCW,
  ensureCounterClockwise,
  evalCubicBezier,
  evalEdgeAt,
  evalEdgeAtArcLength,
  evalEdgeNormalAt,
  evalEdgeTangentAt,
  evalQuadBezier,
  evalQuadraticBezier,
  formatLength,
  generateClothMesh2D,
  getPieceTransformPivot,
  len2,
  len3,
  lerp2,
  lerp3,
  norm2,
  norm3,
  offsetPolygonOutward,
  perp2,
  pointInPolygon,
  pointInTriangle2D,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  polygonPerimeter,
  polygonSelfIntersects,
  polygonSignedArea,
  rotate2,
  sampleEdgePoints,
  samplePieceOutline,
  scale2,
  scale3,
  segmentIntersection2D,
  signedPolygonArea,
  splitCubicBezier,
  splitEdgeCurve,
  splitQuadBezier,
  sub2,
  sub3,
  tAtArcLength,
  transformPiecePoints,
  triangulatePolygon,
  vec2,
  vec3,
} from './geometry.mjs';
export * from './templates.mjs';

// M2 extensions (added in Milestone M2):
export * from './stl.mjs';
export * from './materials.mjs';
export * from './physics.mjs';

// M3 extensions (added in Milestone M3):
export * from './nesting.mjs';
export * from './exporters.mjs';
