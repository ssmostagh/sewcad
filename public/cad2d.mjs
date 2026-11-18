/**
 * 2D Pattern CAD & Roll Nesting Canvas Controller (`cad2d.mjs`)
 * Pure HTML5 Canvas 2D renderer and hit-tester with full `piece.rotation`
 * and `rotationOrigin` support, quadratic/cubic Bezier handles, Seam Walk
 * ghost overlay, and multi-copy / multi-sheet nesting visualization.
 */

import {
  samplePieceOutline,
  computePieceCutBoundary,
  computePieceNotches,
  computePieceGrainline,
  computePieceMeasurements,
  transformPiecePoints,
  getPieceTransformPivot,
  evalEdgeAt,
  polygonBounds,
  pointInPolygon,
  formatLength,
  dist2D,
  rotate2,
  mmToUnit,
} from '../src/core/geometry.mjs';
import { computeSeamWalkTransform } from '../src/core/templates.mjs';

export const SEAM_COLORS = [
  '#38bdf8',
  '#34d399',
  '#f59e0b',
  '#fb7185',
  '#2dd4bf',
  '#60a5fa',
  '#fbbf24',
  '#f97316',
];

export function inferCurveType(curve) {
  if (!curve || typeof curve !== 'object') return 'straight';
  if (curve.type === 'cubic') return 'cubic';
  if (curve.type === 'quadratic') return 'quadratic';
  if (curve.cp1 && curve.cp2) return 'cubic';
  if (curve.cp || curve.cp1) return 'quadratic';
  return 'straight';
}

function collapseCoincidentPolyPoints(rawPts, tolMm = 1e-4) {
  const out = [];
  for (const pt of rawPts) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    const prev = out[out.length - 1];
    if (prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) <= tolMm) continue;
    out.push(pt);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) <= tolMm
  ) {
    out.pop();
  }
  return out;
}

function pointToSegmentDist(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) {
    return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  const projX = a.x + vx * t;
  const projY = a.y + vy * t;
  return { dist: Math.hypot(p.x - projX, p.y - projY), t };
}

export class CAD2DViewport {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;

    this.cam = {
      panX: 60,
      panY: 60,
      zoom: 0.42, // screen CSS px per mm
    };

    this.cssWidth = 640;
    this.cssHeight = 480;
    this.dpr = 1;

    this.penPoints = [];
    this.mouseWorld = { x: 0, y: 0 };

    this._drag = null; // { mode, startScreen, startWorld, pieceId, vertexIndex, edgeIndex, cpKey, pieceStartPos, fixedPivot }
    this._lastScene = null;

    this._bindPointerEvents();
  }

  resize(widthCss, heightCss, dpr = 1) {
    this.cssWidth = Math.max(100, widthCss || 640);
    this.cssHeight = Math.max(100, heightCss || 480);
    this.dpr = Math.max(1, dpr || 1);
    const pxW = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const pxH = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }
  }

  worldToScreen(wx, wy) {
    return {
      x: wx * this.cam.zoom + this.cam.panX,
      y: wy * this.cam.zoom + this.cam.panY,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.cam.panX) / this.cam.zoom,
      y: (sy - this.cam.panY) / this.cam.zoom,
    };
  }

  worldToPieceLocal(piece, wx, wy, explicitPivot = null) {
    const pos = piece?.position || { x: 0, y: 0 };
    const ox = Number.isFinite(pos.x) ? pos.x : 0;
    const oy = Number.isFinite(pos.y) ? pos.y : 0;
    const untranslated = { x: wx - ox, y: wy - oy };
    const rotDeg = Number.isFinite(piece?.rotation) ? piece.rotation : 0;
    const rotRad = (rotDeg * Math.PI) / 180;
    if (Math.abs(rotRad) <= 1e-9) return untranslated;
    const pivot = explicitPivot || getPieceTransformPivot(piece);
    return rotate2(untranslated, -rotRad, pivot);
  }

  pieceLocalToWorld(piece, pt, explicitPivot = null) {
    return transformPiecePoints([pt], piece, explicitPivot ? { pivot: explicitPivot } : {})[0];
  }

  fitToContent(scene) {
    if (!scene) return;
    this._lastScene = scene;
    const padX = 52;
    const padTop = 64;
    const padBottom = 64;
    const availW = Math.max(80, this.cssWidth - padX * 2);
    const availH = Math.max(80, this.cssHeight - padTop - padBottom);

    if (scene.viewMode === 'nesting' && scene.nestingResult) {
      const nest = scene.nestingResult;
      const sheetIdx = scene.activeSheetIndex || 0;
      const sheet = Array.isArray(nest.sheets) ? nest.sheets[sheetIdx] : null;
      const sheetW = sheet?.widthMm || nest.fabricWidthMm || nest.rollWidthMm || 1371.6;
      const sheetH = sheet?.lengthMm || nest.sheetLengthMm || nest.requiredLengthMm || 1000;
      const zoom = Math.max(0.05, Math.min(3.5, Math.min(availW / Math.max(100, sheetW), availH / Math.max(100, sheetH))));
      this.cam.zoom = zoom;
      this.cam.panX = (this.cssWidth - sheetW * zoom) * 0.5;
      this.cam.panY = (this.cssHeight - sheetH * zoom) * 0.5;
      return;
    }

    const pattern = scene.pattern;
    if (!pattern || !Array.isArray(pattern.pieces) || pattern.pieces.length === 0) {
      this.cam.zoom = 0.45;
      this.cam.panX = this.cssWidth * 0.25;
      this.cam.panY = this.cssHeight * 0.25;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const piece of pattern.pieces) {
      let pts = [];
      try {
        pts = computePieceCutBoundary(piece, 12, { worldSpace: true });
      } catch {
        pts = [];
      }
      if (!Array.isArray(pts) || pts.length === 0) {
        try {
          pts = samplePieceOutline(piece, 12, { worldSpace: true });
        } catch {
          pts = [];
        }
      }
      for (const p of pts) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return;
    const rawW = maxX - minX;
    const rawH = maxY - minY;
    if (!Number.isFinite(rawW) || !Number.isFinite(rawH)) {
      this.cam.zoom = 0.06;
      this.cam.panX = this.cssWidth * 0.5;
      this.cam.panY = this.cssHeight * 0.5;
      return;
    }
    const contentW = Math.max(40, rawW);
    const contentH = Math.max(40, rawH);
    const zoom = Math.max(0.06, Math.min(4.0, Math.min(availW / contentW, availH / contentH)));
    const panX = padX + (availW - contentW * zoom) * 0.5 - minX * zoom;
    const panY = padTop + (availH - contentH * zoom) * 0.5 - minY * zoom;
    if (!Number.isFinite(zoom) || !Number.isFinite(panX) || !Number.isFinite(panY)) return;
    this.cam.zoom = zoom;
    this.cam.panX = panX;
    this.cam.panY = panY;
  }

  clearPen() {
    this.penPoints = [];
  }

  cancelActiveDrag(pointerId) {
    if (!this._drag) return null;
    const drag = this._drag;
    this._drag = null;
    try {
      const capId = pointerId !== undefined ? pointerId : drag.pointerId;
      if (capId !== undefined) {
        this.canvas?.releasePointerCapture?.(capId);
      }
    } catch {
      // ignore
    }
    if (drag.mode === 'pan') {
      if (drag.startPan) {
        this.cam.panX = drag.startPan.x;
        this.cam.panY = drag.startPan.y;
      }
      this.callbacks.onRedraw?.();
      if (!this.callbacks.onRedraw && this._lastScene) {
        this.render(this._lastScene);
      }
      return drag.mode;
    }
    const piece = this._lastScene?.pattern?.pieces?.find((p) => p.id === drag.pieceId) || null;
    if (piece) {
      if (drag.mode === 'piece') {
        if (drag.hadPosition && drag.origPosition) {
          piece.position = { ...drag.origPosition };
        } else {
          delete piece.position;
        }
      } else if (drag.mode === 'vertex') {
        if (
          drag.origPoint &&
          Array.isArray(piece.points) &&
          Number.isInteger(drag.vertexIndex) &&
          drag.vertexIndex >= 0 &&
          drag.vertexIndex < piece.points.length
        ) {
          piece.points[drag.vertexIndex] = { ...drag.origPoint };
        }
        if (!drag.hadRotationOrigin) {
          delete piece.rotationOrigin;
        } else {
          piece.rotationOrigin = { ...drag.origRotationOrigin };
        }
      } else if (drag.mode === 'cp') {
        const curve =
          Number.isInteger(drag.edgeIndex) &&
          drag.edgeIndex >= 0 &&
          Array.isArray(piece.edges) &&
          drag.edgeIndex < piece.edges.length
            ? piece.edges[drag.edgeIndex]?.curve
            : null;
        if (curve && drag.origCp) {
          curve[drag.cpKey] = { ...drag.origCp };
        }
        if (!drag.hadRotationOrigin) {
          delete piece.rotationOrigin;
        } else {
          piece.rotationOrigin = { ...drag.origRotationOrigin };
        }
      }
    }
    if (drag.mode === 'piece' || drag.mode === 'vertex' || drag.mode === 'cp') {
      if (typeof this.callbacks.onCancelMutate === 'function') {
        this.callbacks.onCancelMutate();
      } else {
        this.callbacks.onRedraw?.();
        if (!this.callbacks.onRedraw && this._lastScene) {
          this.render(this._lastScene);
        }
      }
    }
    return drag.mode;
  }

  _getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    };
  }

  _getSelectedPiece(scene) {
    if (!scene?.pattern?.pieces) return null;
    return scene.pattern.pieces.find((p) => p.id === scene.selectedPieceId) || null;
  }

  _hitTestCurveHandles(piece, sx, sy) {
    if (!piece || !Array.isArray(piece.edges) || !Array.isArray(piece.points)) return null;
    const hitR = 11;
    const edgeCount = Math.min(piece.edges.length, piece.points.length);
    for (let i = 0; i < edgeCount; i++) {
      const curve = piece.edges[i]?.curve;
      if (!curve) continue;
      const curveType = inferCurveType(curve);
      if (curveType === 'quadratic') {
        const cpKey = curve.cp ? 'cp' : curve.cp1 ? 'cp1' : null;
        if (cpKey) {
          const w = this.pieceLocalToWorld(piece, curve[cpKey]);
          const s = this.worldToScreen(w.x, w.y);
          if (Math.hypot(sx - s.x, sy - s.y) <= hitR) {
            return { type: 'cp', cpKey, edgeIndex: i, piece };
          }
        }
      } else if (curveType === 'cubic') {
        for (const key of ['cp1', 'cp2']) {
          if (!curve[key]) continue;
          const w = this.pieceLocalToWorld(piece, curve[key]);
          const s = this.worldToScreen(w.x, w.y);
          if (Math.hypot(sx - s.x, sy - s.y) <= hitR) {
            return { type: 'cp', cpKey: key, edgeIndex: i, piece };
          }
        }
      }
    }
    return null;
  }

  _hitTestVertices(piece, sx, sy) {
    if (!piece || !Array.isArray(piece.points)) return null;
    const worldPts = transformPiecePoints(piece.points, piece);
    const hitR = 11;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < worldPts.length; i++) {
      const s = this.worldToScreen(worldPts[i].x, worldPts[i].y);
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d <= hitR && d < bestD) {
        bestD = d;
        best = { type: 'vertex', vertexIndex: i, piece };
      }
    }
    return best;
  }

  _hitTestEdges(pattern, sx, sy) {
    if (!pattern?.pieces) return null;
    const worldMouse = this.screenToWorld(sx, sy);
    const tolWorld = 10 / this.cam.zoom;
    let best = null;
    let bestDist = Infinity;

    for (let pIdx = pattern.pieces.length - 1; pIdx >= 0; pIdx--) {
      const piece = pattern.pieces[pIdx];
      const n = piece.points?.length || 0;
      if (n < 2) continue;
      for (let eIdx = 0; eIdx < n; eIdx++) {
        const p0 = piece.points[eIdx];
        const p1 = piece.points[(eIdx + 1) % n];
        const curve = piece.edges?.[eIdx]?.curve || null;
        const segs = curve ? 16 : 1;
        let prev = this.pieceLocalToWorld(piece, p0);
        for (let k = 1; k <= segs; k++) {
          const t0 = (k - 1) / segs;
          const t1 = k / segs;
          const localPt = k === segs ? p1 : evalEdgeAt(p0, p1, curve, t1);
          const cur = this.pieceLocalToWorld(piece, localPt);
          const { dist, t } = pointToSegmentDist(worldMouse, prev, cur);
          if (dist <= tolWorld && dist < bestDist) {
            bestDist = dist;
            best = {
              type: 'edge',
              piece,
              edgeIndex: eIdx,
              t: t0 + (t1 - t0) * t,
            };
          }
          prev = cur;
        }
      }
    }
    return best;
  }

  _hitTestPieces(pattern, sx, sy) {
    if (!pattern?.pieces) return null;
    const worldMouse = this.screenToWorld(sx, sy);
    for (let i = pattern.pieces.length - 1; i >= 0; i--) {
      const piece = pattern.pieces[i];
      const poly = samplePieceOutline(piece, 12, { worldSpace: true });
      if (poly.length >= 3 && pointInPolygon(worldMouse, poly)) {
        return { type: 'piece', piece };
      }
    }
    return null;
  }

  _hitTestNesting(scene, sx, sy) {
    const nest = scene?.nestingResult;
    if (!nest || !Array.isArray(nest.placements)) return null;
    const worldMouse = this.screenToWorld(sx, sy);
    const sheetIdx = scene.activeSheetIndex || 0;
    for (let i = nest.placements.length - 1; i >= 0; i--) {
      const pl = nest.placements[i];
      if ((pl.sheetIndex ?? 0) !== sheetIdx) continue;
      const poly = pl.points || pl.polygon;
      if (Array.isArray(poly) && poly.length >= 3 && pointInPolygon(worldMouse, poly)) {
        return { type: 'nest_placement', placement: pl, pieceId: pl.pieceId };
      }
    }
    return null;
  }

  _bindPointerEvents() {
    if (!this.canvas || typeof this.canvas.addEventListener !== 'function') return;
    const isMatchingPointer = (drag, e) =>
      drag.pointerId === undefined || e?.pointerId === undefined || e.pointerId === drag.pointerId;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this._drag) return;
      const scene = this._lastScene;
      if (!scene) return;
      const { sx, sy } = this._getCanvasCoords(e);
      const world = this.screenToWorld(sx, sy);
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        !Number.isFinite(world.x) ||
        !Number.isFinite(world.y)
      ) {
        return;
      }
      this.mouseWorld = world;

      if (e.button === 1 || e.button === 2 || e.altKey || e.shiftKey) {
        this._drag = {
          mode: 'pan',
          pointerId: e?.pointerId,
          startScreen: { x: sx, y: sy },
          startPan: { x: this.cam.panX, y: this.cam.panY },
        };
        this.canvas.setPointerCapture?.(e.pointerId);
        return;
      }

      if (scene.viewMode === 'nesting') {
        const hitNest = this._hitTestNesting(scene, sx, sy);
        if (hitNest) {
          this.callbacks.onSelectPiece?.(hitNest.pieceId, -1, 0);
        } else {
          this._drag = {
            mode: 'pan',
            pointerId: e?.pointerId,
            startScreen: { x: sx, y: sy },
            startPan: { x: this.cam.panX, y: this.cam.panY },
          };
          this.canvas.setPointerCapture?.(e.pointerId);
        }
        return;
      }

      const tool = scene.activeTool || 'select';
      const pattern = scene.pattern;

      // Pen / Freeform Polygon Tool
      if (tool === 'draw_poly') {
        if (this.penPoints.length >= 3) {
          const firstS = this.worldToScreen(this.penPoints[0].x, this.penPoints[0].y);
          if (Math.hypot(sx - firstS.x, sy - firstS.y) <= 14) {
            const pts = collapseCoincidentPolyPoints(this.penPoints, 1e-4);
            this.penPoints = [];
            if (pts.length >= 3) {
              this.callbacks.onCreateFreeform?.(pts);
            } else {
              this.callbacks.onRedraw?.();
            }
            return;
          }
        }
        const nextPt = { x: Number(world.x.toFixed(2)), y: Number(world.y.toFixed(2)) };
        if (this.penPoints.length > 0) {
          const lastPt = this.penPoints[this.penPoints.length - 1];
          const lastS = this.worldToScreen(lastPt.x, lastPt.y);
          if (
            Math.hypot(nextPt.x - lastPt.x, nextPt.y - lastPt.y) <= 1e-4 ||
            Math.hypot(sx - lastS.x, sy - lastS.y) <= 2
          ) {
            return;
          }
        }
        this.penPoints.push(nextPt);
        this.callbacks.onRedraw?.();
        return;
      }

      // Edge-action tools
      if (tool === 'sew' || tool === 'dart' || tool === 'notch' || tool === 'split_edge' || tool === 'mirror') {
        const edgeHit = this._hitTestEdges(pattern, sx, sy);
        if (edgeHit) {
          this.callbacks.onEdgeToolClick?.(tool, edgeHit.piece.id, edgeHit.edgeIndex, edgeHit.t);
          return;
        }
      }

      // Select / Edit Points
      const selPiece = this._getSelectedPiece(scene);
      const candidatePieces = tool === 'edit_points' && Array.isArray(pattern?.pieces)
        ? [
            ...(selPiece ? [selPiece] : []),
            ...pattern.pieces.filter((p) => p && p.id !== selPiece?.id).reverse(),
          ]
        : (selPiece ? [selPiece] : []);

      if (tool === 'select' || tool === 'edit_points') {
        for (const cand of candidatePieces) {
          const cpHit = this._hitTestCurveHandles(cand, sx, sy);
          if (cpHit) {
            if (cand.id !== selPiece?.id) {
              this.callbacks.onSelectPiece?.(cand.id, -1, cpHit.edgeIndex);
            }
            const fixedPivot = getPieceTransformPivot(cand);
            const origCp = cand.edges?.[cpHit.edgeIndex]?.curve?.[cpHit.cpKey];
            this.callbacks.onBeforeMutate?.('Edit Bezier handle');
            this._drag = {
              mode: 'cp',
              pointerId: e?.pointerId,
              pieceId: cand.id,
              edgeIndex: cpHit.edgeIndex,
              cpKey: cpHit.cpKey,
              fixedPivot,
              origCp: origCp ? { x: origCp.x, y: origCp.y } : null,
              hadRotationOrigin: cand.rotationOrigin !== undefined,
              origRotationOrigin: cand.rotationOrigin ? { ...cand.rotationOrigin } : undefined,
            };
            if (this.canvas?.style) this.canvas.style.cursor = 'grabbing';
            this.canvas.setPointerCapture?.(e.pointerId);
            return;
          }

          const vertHit = this._hitTestVertices(cand, sx, sy);
          if (vertHit) {
            const fixedPivot = getPieceTransformPivot(cand);
            const origPoint = cand.points?.[vertHit.vertexIndex];
            this.callbacks.onSelectPiece?.(cand.id, vertHit.vertexIndex, vertHit.vertexIndex);
            this.callbacks.onBeforeMutate?.('Move vertex');
            this._drag = {
              mode: 'vertex',
              pointerId: e?.pointerId,
              pieceId: cand.id,
              vertexIndex: vertHit.vertexIndex,
              fixedPivot,
              origPoint: origPoint ? { x: origPoint.x, y: origPoint.y } : null,
              hadRotationOrigin: cand.rotationOrigin !== undefined,
              origRotationOrigin: cand.rotationOrigin ? { ...cand.rotationOrigin } : undefined,
            };
            if (this.canvas?.style) this.canvas.style.cursor = 'grabbing';
            this.canvas.setPointerCapture?.(e.pointerId);
            return;
          }
        }
      }

      // Check edges on any piece for selection
      const anyEdge = this._hitTestEdges(pattern, sx, sy);
      const pieceHit = this._hitTestPieces(pattern, sx, sy);

      if (anyEdge && tool === 'edit_points') {
        this.callbacks.onSelectPiece?.(anyEdge.piece.id, -1, anyEdge.edgeIndex);
        return;
      }

      if (pieceHit) {
        const p = pieceHit.piece;
        const edgeIdx = anyEdge && anyEdge.piece.id === p.id ? anyEdge.edgeIndex : scene.selectedEdgeIndex;
        this.callbacks.onSelectPiece?.(p.id, -1, edgeIdx ?? 0);
        if (tool === 'select') {
          this.callbacks.onBeforeMutate?.('Move piece');
          this._drag = {
            mode: 'piece',
            pointerId: e?.pointerId,
            pieceId: p.id,
            startWorld: world,
            pieceStartPos: { x: p.position?.x || 0, y: p.position?.y || 0 },
            hadPosition: p.position !== undefined,
            origPosition: p.position ? { ...p.position } : undefined,
          };
          this.canvas.setPointerCapture?.(e.pointerId);
        }
        return;
      }

      // Background pan
      this._drag = {
        mode: 'pan',
        pointerId: e?.pointerId,
        startScreen: { x: sx, y: sy },
        startPan: { x: this.cam.panX, y: this.cam.panY },
      };
      this.canvas.setPointerCapture?.(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this._drag && !isMatchingPointer(this._drag, e)) return;
      const scene = this._lastScene;
      const { sx, sy } = this._getCanvasCoords(e);
      const world = this.screenToWorld(sx, sy);
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        !Number.isFinite(world.x) ||
        !Number.isFinite(world.y)
      ) {
        return;
      }
      this.mouseWorld = world;

      if (!this._drag) {
        if (scene?.activeTool === 'draw_poly' && this.penPoints.length > 0) {
          this.callbacks.onRedraw?.();
        }
        if (this.canvas?.style && scene) {
          const t = scene.activeTool || 'select';
          if (scene.viewMode === 'nesting') {
            this.canvas.style.cursor = this._hitTestNesting(scene, sx, sy) ? 'pointer' : 'grab';
          } else if (t === 'draw_poly') {
            this.canvas.style.cursor = 'crosshair';
          } else if (t === 'sew' || t === 'dart' || t === 'notch' || t === 'split_edge' || t === 'mirror') {
            this.canvas.style.cursor = this._hitTestEdges(scene.pattern, sx, sy) ? 'pointer' : 'default';
          } else {
            const sp = this._getSelectedPiece(scene);
            const overHandle = sp && (this._hitTestCurveHandles(sp, sx, sy) || this._hitTestVertices(sp, sx, sy));
            if (overHandle) {
              this.canvas.style.cursor = 'pointer';
            } else if (t === 'edit_points') {
              this.canvas.style.cursor = this._hitTestEdges(scene.pattern, sx, sy) ? 'pointer' : 'default';
            } else {
              this.canvas.style.cursor = this._hitTestPieces(scene.pattern, sx, sy) ? 'grab' : 'default';
            }
          }
        }
        return;
      }

      if (this._drag.mode === 'pan') {
        const nextPanX = this._drag.startPan.x + (sx - this._drag.startScreen.x);
        const nextPanY = this._drag.startPan.y + (sy - this._drag.startScreen.y);
        if (!Number.isFinite(nextPanX) || !Number.isFinite(nextPanY)) return;
        this.cam.panX = nextPanX;
        this.cam.panY = nextPanY;
        this.callbacks.onRedraw?.();
        return;
      }

      const pattern = scene?.pattern;
      if (!pattern || !Array.isArray(pattern.pieces)) {
        this.cancelActiveDrag();
        return;
      }
      const piece = pattern.pieces.find((p) => p.id === this._drag.pieceId);
      if (!piece) {
        this.cancelActiveDrag();
        return;
      }

      if (this._drag.mode === 'piece') {
        const dx = world.x - this._drag.startWorld.x;
        const dy = world.y - this._drag.startWorld.y;
        const nx = Number((this._drag.pieceStartPos.x + dx).toFixed(2));
        const ny = Number((this._drag.pieceStartPos.y + dy).toFixed(2));
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        piece.position = { x: nx, y: ny };
        this.callbacks.onGeometryDragging?.(piece);
      } else if (this._drag.mode === 'vertex') {
        if (
          !Array.isArray(piece.points) ||
          !Number.isInteger(this._drag.vertexIndex) ||
          this._drag.vertexIndex < 0 ||
          this._drag.vertexIndex >= piece.points.length
        ) {
          this.cancelActiveDrag();
          return;
        }
        if (Math.abs(piece.rotation || 0) > 1e-6 && !piece.rotationOrigin) {
          piece.rotationOrigin = { ...this._drag.fixedPivot };
        }
        const local = this.worldToPieceLocal(piece, world.x, world.y, piece.rotationOrigin || this._drag.fixedPivot);
        if (!Number.isFinite(local?.x) || !Number.isFinite(local?.y)) return;
        const nx = Number(local.x.toFixed(2));
        const ny = Number(local.y.toFixed(2));
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        piece.points[this._drag.vertexIndex] = { x: nx, y: ny };
        this.callbacks.onGeometryDragging?.(piece);
      } else if (this._drag.mode === 'cp') {
        const curve =
          Number.isInteger(this._drag.edgeIndex) &&
          this._drag.edgeIndex >= 0 &&
          Array.isArray(piece.edges) &&
          this._drag.edgeIndex < piece.edges.length
            ? piece.edges[this._drag.edgeIndex]?.curve
            : null;
        if (!curve || !curve[this._drag.cpKey]) {
          this.cancelActiveDrag();
          return;
        }
        if (Math.abs(piece.rotation || 0) > 1e-6 && !piece.rotationOrigin) {
          piece.rotationOrigin = { ...this._drag.fixedPivot };
        }
        const local = this.worldToPieceLocal(piece, world.x, world.y, piece.rotationOrigin || this._drag.fixedPivot);
        if (!Number.isFinite(local?.x) || !Number.isFinite(local?.y)) return;
        const nx = Number(local.x.toFixed(2));
        const ny = Number(local.y.toFixed(2));
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        curve[this._drag.cpKey] = { x: nx, y: ny };
        this.callbacks.onGeometryDragging?.(piece);
      }
    });

    const endDrag = (e) => {
      if (!this._drag) return;
      if (!isMatchingPointer(this._drag, e)) return;
      const mode = this._drag.mode;
      this._drag = null;
      try {
        this.canvas.releasePointerCapture?.(e?.pointerId);
      } catch {
        // ignore
      }
      if (this.canvas?.style) this.canvas.style.cursor = '';
      if (mode === 'piece' || mode === 'vertex' || mode === 'cp') {
        this.callbacks.onAfterMutate?.();
      }
    };

    const cancelDrag = (e) => {
      if (!this._drag) return;
      if (!isMatchingPointer(this._drag, e)) return;
      this.cancelActiveDrag(e?.pointerId);
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', cancelDrag);

    this.canvas.addEventListener('dblclick', () => {
      const scene = this._lastScene;
      if (scene?.activeTool === 'draw_poly' && this.penPoints.length >= 3) {
        const pts = collapseCoincidentPolyPoints(this.penPoints, 1e-4);
        this.penPoints = [];
        if (pts.length >= 3) {
          this.callbacks.onCreateFreeform?.(pts);
        } else {
          this.callbacks.onRedraw?.();
        }
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { sx, sy } = this._getCanvasCoords(e);
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(e.deltaY)) return;
        const before = this.screenToWorld(sx, sy);
        if (!Number.isFinite(before.x) || !Number.isFinite(before.y)) return;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.cam.zoom = Math.max(0.05, Math.min(8.0, this.cam.zoom * factor));
        const after = this.screenToWorld(sx, sy);
        const nextPanX = this.cam.panX + (after.x - before.x) * this.cam.zoom;
        const nextPanY = this.cam.panY + (after.y - before.y) * this.cam.zoom;
        if (Number.isFinite(nextPanX) && Number.isFinite(nextPanY)) {
          this.cam.panX = nextPanX;
          this.cam.panY = nextPanY;
        }
        this.callbacks.onRedraw?.();
      },
      { passive: false }
    );

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _drawGrid(unit) {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;

    ctx.fillStyle = '#141820';
    ctx.fillRect(0, 0, w, h);

    if (
      !Number.isFinite(this.cam.zoom) ||
      this.cam.zoom <= 0 ||
      !Number.isFinite(this.cam.panX) ||
      !Number.isFinite(this.cam.panY)
    ) {
      return;
    }

    const stepUnit = unit === 'in' ? 25.4 : unit === 'cm' ? 10 : 50;
    let gridMm = stepUnit;
    for (let i = 0; i < 128 && gridMm * this.cam.zoom < 22 && Number.isFinite(gridMm * 2); i++) {
      gridMm *= 2;
    }
    for (let i = 0; i < 128 && gridMm * this.cam.zoom > 120 && gridMm > 1e-12; i++) {
      gridMm *= 0.5;
    }

    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(w, h);
    if (
      !Number.isFinite(gridMm) ||
      gridMm <= 0 ||
      !Number.isFinite(tl.x) ||
      !Number.isFinite(tl.y) ||
      !Number.isFinite(br.x) ||
      !Number.isFinite(br.y)
    ) {
      return;
    }

    const startX = Math.floor(tl.x / gridMm) * gridMm;
    const startY = Math.floor(tl.y / gridMm) * gridMm;
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;

    const MAX_GRID_LINES = 500;
    ctx.lineWidth = 1;
    let idx = 0;
    let xLines = 0;
    for (let x = startX; x <= br.x && xLines < MAX_GRID_LINES; xLines++) {
      const s = this.worldToScreen(x, 0);
      if (Number.isFinite(s.x)) {
        const major = Math.round(x / gridMm) % 5 === 0;
        ctx.strokeStyle = major ? 'rgba(148, 163, 184, 0.10)' : 'rgba(148, 163, 184, 0.038)';
        ctx.beginPath();
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, h);
        ctx.stroke();
        if (major && idx++ % 2 === 0 && s.x > 26) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.48)';
          ctx.font = '10px monospace';
          try {
            ctx.fillText(String(Number(mmToUnit(x, unit).toFixed(1))), s.x + 4, 13);
          } catch {
            // Skip grid label on extreme unit conversion
          }
        }
      }
      const nextX = x + gridMm;
      if (!(nextX > x) || !Number.isFinite(nextX)) break;
      x = nextX;
    }

    let yIdx = 0;
    let yLines = 0;
    for (let y = startY; y <= br.y && yLines < MAX_GRID_LINES; yLines++) {
      const s = this.worldToScreen(0, y);
      if (Number.isFinite(s.y)) {
        const major = Math.round(y / gridMm) % 5 === 0;
        ctx.strokeStyle = major ? 'rgba(148, 163, 184, 0.10)' : 'rgba(148, 163, 184, 0.038)';
        ctx.beginPath();
        ctx.moveTo(0, s.y);
        ctx.lineTo(w, s.y);
        ctx.stroke();
        if (major && yIdx++ % 2 === 0 && s.y > 22 && s.y < h - 24) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
          ctx.font = '10px monospace';
          try {
            ctx.fillText(String(Number(mmToUnit(y, unit).toFixed(1))), 4, s.y - 3);
          } catch {
            // Skip grid label on extreme unit conversion
          }
        }
      }
      const nextY = y + gridMm;
      if (!(nextY > y) || !Number.isFinite(nextY)) break;
      y = nextY;
    }

    // Origin cross
    const origin = this.worldToScreen(0, 0);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(origin.x - 9, origin.y);
    ctx.lineTo(origin.x + 9, origin.y);
    ctx.moveTo(origin.x, origin.y - 9);
    ctx.lineTo(origin.x, origin.y + 9);
    ctx.stroke();
  }

  _drawArrow(from, to, color) {
    const ctx = this.ctx;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const len = 7;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - len * Math.cos(angle - 0.45), to.y - len * Math.sin(angle - 0.45));
    ctx.lineTo(to.x - len * Math.cos(angle + 0.45), to.y - len * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  _renderNestingMode(scene) {
    const ctx = this.ctx;
    const nest = scene.nestingResult;
    if (!nest) return;
    const sheetIdx = scene.activeSheetIndex || 0;
    const sheet = Array.isArray(nest.sheets) ? nest.sheets[sheetIdx] : null;
    const widthMm = sheet?.widthMm || nest.fabricWidthMm || nest.rollWidthMm || 1371.6;
    const lengthMm = sheet?.lengthMm || nest.sheetLengthMm || nest.requiredLengthMm || 1000;
    const margin = nest.marginMm ?? 10;

    // Roll sheet rect
    const tl = this.worldToScreen(0, 0);
    const br = this.worldToScreen(widthMm, lengthMm);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.55)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // Margin box
    const mtl = this.worldToScreen(margin, margin);
    const mbr = this.worldToScreen(Math.max(margin, widthMm - margin), Math.max(margin, lengthMm - margin));
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.strokeRect(mtl.x, mtl.y, mbr.x - mtl.x, mbr.y - mtl.y);
    ctx.setLineDash([]);

    const placements = Array.isArray(nest.placements) ? nest.placements : [];
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i];
      if ((pl.sheetIndex ?? 0) !== sheetIdx) continue;
      const poly = pl.points || pl.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;

      const isSel = pl.pieceId === scene.selectedPieceId;
      ctx.beginPath();
      for (let k = 0; k < poly.length; k++) {
        const s = this.worldToScreen(poly[k].x, poly[k].y);
        if (k === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
      ctx.fillStyle = isSel ? 'rgba(56, 189, 248, 0.28)' : 'rgba(52, 211, 153, 0.18)';
      ctx.fill();
      ctx.lineWidth = isSel ? 2 : 1.25;
      ctx.strokeStyle = isSel ? '#38bdf8' : '#34d399';
      ctx.stroke();

      const bounds = polygonBounds(poly);
      const center = this.worldToScreen((bounds.minX + bounds.maxX) * 0.5, (bounds.minY + bounds.maxY) * 0.5);
      const copyTag = Number.isInteger(pl.copyIndex) ? ` #${pl.copyIndex + 1}` : '';
      const rotTag = pl.rotated90 ? ' [90°]' : '';
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${pl.pieceName || pl.name || pl.pieceId}${copyTag}${rotTag}`, center.x, center.y);
      ctx.textAlign = 'left';
    }

    // Sheet header badge
    ctx.fillStyle = '#93c5fd';
    ctx.font = '700 12px monospace';
    ctx.fillText(
      `Roll ${formatLength(widthMm, scene.unit)} × ${formatLength(lengthMm, scene.unit)} | Util ${nest.utilizationPct?.toFixed(1) ?? 0}% | Sheet ${sheetIdx + 1}/${nest.sheetCount || 1}`,
      tl.x,
      tl.y - 8
    );
  }

  render(scene) {
    if (!this.ctx || !scene) return;
    this._lastScene = scene;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const unit = scene.unit || 'mm';
    this._drawGrid(unit);

    if (scene.viewMode === 'nesting' && scene.nestingResult) {
      this._renderNestingMode(scene);
      ctx.restore();
      return;
    }

    const pattern = scene.pattern;
    if (!pattern || !Array.isArray(pattern.pieces)) {
      ctx.restore();
      return;
    }

    // Pre-index seam color per (pieceId, edgeIndex) for CLO3D-style color-coded stitch edges
    const edgeSeamColors = new Map();
    if (scene.showSeams && Array.isArray(pattern.seams)) {
      const pieceMapPre = new Map(pattern.pieces.map((p) => [p.id, p]));
      for (let i = 0; i < pattern.seams.length; i++) {
        const sm = pattern.seams[i];
        const col = SEAM_COLORS[i % SEAM_COLORS.length];
        const pA = pieceMapPre.get(sm.pieceA);
        const pB = pieceMapPre.get(sm.pieceB);
        if (pA && Array.isArray(pA.points) && pA.points.length >= 2) {
          const eA = ((sm.edgeA % pA.points.length) + pA.points.length) % pA.points.length;
          edgeSeamColors.set(`${pA.id}:${eA}`, col);
        }
        if (pB && Array.isArray(pB.points) && pB.points.length >= 2 && !sm.internalLineIdB) {
          const eB = ((sm.edgeB % pB.points.length) + pB.points.length) % pB.points.length;
          edgeSeamColors.set(`${pB.id}:${eB}`, col);
        }
      }
    }

    const placedLabelRects = [];
    const measureTextWidth = (str, approxCharPx = 6.3) => {
      if (typeof ctx.measureText === 'function') {
        const m = ctx.measureText(str);
        if (m && Number.isFinite(m.width) && m.width > 0) return m.width;
      }
      return str.length * approxCharPx;
    };
    const rectsOverlap = (a, b, pad = 3) =>
      !(a.x2 + pad < b.x1 || a.x1 - pad > b.x2 || a.y2 + pad < b.y1 || a.y1 - pad > b.y2);
    const tryReserveRect = (cx, cy, w, h, force = false) => {
      const r = { x1: cx - w * 0.5, y1: cy - h * 0.5, x2: cx + w * 0.5, y2: cy + h * 0.5 };
      if (!force) {
        for (let i = 0; i < placedLabelRects.length; i++) {
          if (rectsOverlap(r, placedLabelRects[i])) return false;
        }
      }
      placedLabelRects.push(r);
      return true;
    };

    const pendingLabels = [];

    // 1. Render each PatternPiece geometry in world space
    for (const piece of pattern.pieces) {
      const isSelected = piece.id === scene.selectedPieceId;

      // Cut boundary (seam allowance)
      if (scene.showCutLine) {
        let cutPts = [];
        try {
          cutPts = computePieceCutBoundary(piece, 16, { worldSpace: true });
        } catch {
          cutPts = [];
        }
        if (cutPts.length >= 3) {
          ctx.beginPath();
          for (let i = 0; i < cutPts.length; i++) {
            const s = this.worldToScreen(cutPts[i].x, cutPts[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.closePath();
          ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.045)' : 'rgba(226, 232, 240, 0.025)';
          ctx.fill();
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1.05;
          ctx.strokeStyle = isSelected ? 'rgba(251, 191, 36, 0.72)' : 'rgba(148, 163, 184, 0.42)';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Net seam outline (crisp CLO3D pattern-card styling)
      const netPts = samplePieceOutline(piece, 18, { worldSpace: true });
      let screenSignedArea = 0;
      if (netPts.length >= 3) {
        ctx.beginPath();
        let prevS = null;
        let firstS = null;
        for (let i = 0; i < netPts.length; i++) {
          const s = this.worldToScreen(netPts[i].x, netPts[i].y);
          if (i === 0) {
            ctx.moveTo(s.x, s.y);
            firstS = s;
          } else {
            ctx.lineTo(s.x, s.y);
            screenSignedArea += prevS.x * s.y - s.x * prevS.y;
          }
          prevS = s;
        }
        if (prevS && firstS) {
          screenSignedArea += prevS.x * firstS.y - firstS.x * prevS.y;
        }
        ctx.closePath();
        ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.14)' : 'rgba(226, 232, 240, 0.085)';
        ctx.fill();
        ctx.lineWidth = isSelected ? 2.0 : 1.45;
        ctx.strokeStyle = isSelected ? '#38bdf8' : '#dde5f0';
        ctx.stroke();
      }
      const windingSign = screenSignedArea >= 0 ? 1 : -1;

      // Internal lines (fold / pocket / stitch / guide)
      if (Array.isArray(piece.internalLines)) {
        for (const il of piece.internalLines) {
          if (!Array.isArray(il?.points) || il.points.length < 2) continue;
          const wPts = transformPiecePoints(il.points, piece);
          ctx.beginPath();
          for (let i = 0; i < wPts.length; i++) {
            const s = this.worldToScreen(wPts[i].x, wPts[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.setLineDash(il.type === 'fold' ? [7, 4, 2, 4] : [3, 4]);
          ctx.strokeStyle = il.type === 'fold' ? 'rgba(251, 191, 36, 0.72)' : 'rgba(148, 163, 184, 0.55)';
          ctx.lineWidth = 1.05;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Grainline
      if (scene.showGrain !== false) {
        const grain = computePieceGrainline(piece, { worldSpace: true });
        if (grain?.start && grain?.end) {
          const gs = this.worldToScreen(grain.start.x, grain.start.y);
          const ge = this.worldToScreen(grain.end.x, grain.end.y);
          if (Math.hypot(ge.x - gs.x, ge.y - gs.y) >= 24) {
            ctx.lineWidth = 1.1;
            this._drawArrow(gs, ge, 'rgba(148, 163, 184, 0.55)');
          }
        }
      }

      // Alignment Notches
      const notches = computePieceNotches(piece, { worldSpace: true });
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      for (const n of notches) {
        for (const seg of n.lines || []) {
          if (seg.length < 2) continue;
          const a = this.worldToScreen(seg[0].x, seg[0].y);
          const b = this.worldToScreen(seg[1].x, seg[1].y);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Color-coded sewn edge accent + Selected edge highlight + Queue outward edge labels
      let meas = null;
      if (scene.showLengths) {
        try {
          meas = computePieceMeasurements(piece, unit);
        } catch {
          meas = null;
        }
      }
      const nPts = piece.points.length;
      const saDefault = Number.isFinite(piece.seamAllowance) ? piece.seamAllowance : 10;
      for (let eIdx = 0; eIdx < nPts; eIdx++) {
        const p0 = piece.points[eIdx];
        const p1 = piece.points[(eIdx + 1) % nPts];
        const curve = piece.edges?.[eIdx]?.curve || null;
        const seamCol = edgeSeamColors.get(`${piece.id}:${eIdx}`);
        const isSelEdge = isSelected && eIdx === scene.selectedEdgeIndex;

        if (seamCol || isSelEdge) {
          ctx.beginPath();
          const segs = curve ? 16 : 1;
          for (let k = 0; k <= segs; k++) {
            const lpt = k === 0 ? p0 : k === segs ? p1 : evalEdgeAt(p0, p1, curve, k / segs);
            const wpt = this.pieceLocalToWorld(piece, lpt);
            const s = this.worldToScreen(wpt.x, wpt.y);
            if (k === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.lineWidth = isSelEdge ? 3.0 : 2.1;
          ctx.strokeStyle = isSelEdge ? '#f59e0b' : seamCol;
          ctx.stroke();
        }

        const w0 = this.pieceLocalToWorld(piece, p0);
        const w1 = this.pieceLocalToWorld(piece, p1);
        const s0 = this.worldToScreen(w0.x, w0.y);
        const s1 = this.worldToScreen(w1.x, w1.y);
        const edgeScreenLen = Math.hypot(s1.x - s0.x, s1.y - s0.y);

        // Outward unit normal in screen coordinates
        const tx = edgeScreenLen > 1e-4 ? (s1.x - s0.x) / edgeScreenLen : 1;
        const ty = edgeScreenLen > 1e-4 ? (s1.y - s0.y) / edgeScreenLen : 0;
        const outNx = ty * windingSign;
        const outNy = -tx * windingSign;

        // CLO3D-style midpoint seam tick
        if (seamCol && edgeScreenLen >= 22) {
          const midLocal = evalEdgeAt(p0, p1, curve, 0.5);
          const midWorld = this.pieceLocalToWorld(piece, midLocal);
          const ms = this.worldToScreen(midWorld.x, midWorld.y);
          ctx.strokeStyle = seamCol;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(ms.x - outNx * 4, ms.y - outNy * 4);
          ctx.lineTo(ms.x + outNx * 4, ms.y + outNy * 4);
          ctx.stroke();
        }

        if (meas && meas.edges[eIdx]) {
          const edgeInfo = meas.edges[eIdx];
          const edgeSa = Number.isFinite(piece.edges?.[eIdx]?.seamAllowance)
            ? piece.edges[eIdx].seamAllowance
            : saDefault;
          const saPx = scene.showCutLine ? Math.max(0, edgeSa * this.cam.zoom) : 0;
          if (isSelEdge || (this.cam.zoom > 0.18 && edgeScreenLen >= 42)) {
            const midLocal = evalEdgeAt(p0, p1, curve, 0.5);
            const midWorld = this.pieceLocalToWorld(piece, midLocal);
            const ms = this.worldToScreen(midWorld.x, midWorld.y);
            const offsetPx = saPx + 11;
            pendingLabels.push({
              kind: 'edge',
              priority: isSelEdge ? 3 : isSelected ? 2 : 1,
              force: isSelEdge,
              text: formatLength(edgeInfo.netLengthMm, unit, 1),
              x: ms.x + outNx * offsetPx,
              y: ms.y + outNy * offsetPx,
              outNx,
              outNy,
              highlight: isSelEdge,
            });
          }
        }
      }

      // Selected piece vertices & Bezier control handles
      if (isSelected) {
        const wVerts = transformPiecePoints(piece.points, piece);
        const edgeCount = Array.isArray(piece.edges)
          ? Math.min(piece.edges.length, wVerts.length)
          : 0;
        for (let i = 0; i < edgeCount; i++) {
          const curve = piece.edges?.[i]?.curve;
          if (!curve) continue;
          const curveType = inferCurveType(curve);
          const p0w = wVerts[i];
          const p1w = wVerts[(i + 1) % wVerts.length];
          if (curveType === 'quadratic') {
            const quadCp = curve.cp || curve.cp1;
            if (!quadCp) continue;
            const cpw = this.pieceLocalToWorld(piece, quadCp);
            const s0 = this.worldToScreen(p0w.x, p0w.y);
            const s1 = this.worldToScreen(p1w.x, p1w.y);
            const sc = this.worldToScreen(cpw.x, cpw.y);
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(s0.x, s0.y);
            ctx.lineTo(sc.x, sc.y);
            ctx.lineTo(s1.x, s1.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#fbbf24';
            ctx.beginPath();
            ctx.arc(sc.x, sc.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
          } else if (curveType === 'cubic') {
            if (curve.cp1) {
              const cp1w = this.pieceLocalToWorld(piece, curve.cp1);
              const s0 = this.worldToScreen(p0w.x, p0w.y);
              const sc1 = this.worldToScreen(cp1w.x, cp1w.y);
              ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(s0.x, s0.y);
              ctx.lineTo(sc1.x, sc1.y);
              ctx.stroke();
              ctx.fillStyle = '#fbbf24';
              ctx.beginPath();
              ctx.arc(sc1.x, sc1.y, 4.5, 0, Math.PI * 2);
              ctx.fill();
            }
            if (curve.cp2) {
              const cp2w = this.pieceLocalToWorld(piece, curve.cp2);
              const s1 = this.worldToScreen(p1w.x, p1w.y);
              const sc2 = this.worldToScreen(cp2w.x, cp2w.y);
              ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(s1.x, s1.y);
              ctx.lineTo(sc2.x, sc2.y);
              ctx.stroke();
              ctx.fillStyle = '#fbbf24';
              ctx.beginPath();
              ctx.arc(sc2.x, sc2.y, 4.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }

        for (let i = 0; i < wVerts.length; i++) {
          const s = this.worldToScreen(wVerts[i].x, wVerts[i].y);
          const isActiveV = i === scene.selectedVertexIndex;
          ctx.fillStyle = isActiveV ? '#fbbf24' : '#38bdf8';
          ctx.strokeStyle = '#0f141c';
          ctx.lineWidth = 1.5;
          ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7);
          ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7);
        }
      }

      // Queue Piece Title & Metadata Pill (with automatic narrow-strip callout offset)
      if (netPts.length >= 3) {
        const b = polygonBounds(netPts);
        const sMin = this.worldToScreen(b.minX, b.minY);
        const sMax = this.worldToScreen(b.maxX, b.maxY);
        const screenW = Math.abs(sMax.x - sMin.x);
        const screenH = Math.abs(sMax.y - sMin.y);
        const badges = [];
        if ((piece.quantity || 1) > 1) badges.push(`×${piece.quantity}`);
        if (piece.onFold) badges.push('FOLD');
        if (Math.abs(piece.rotation || 0) > 0.1) badges.push(`${Math.round(piece.rotation)}°`);
        const suffix = badges.length > 0 ? ` (${badges.join(', ')})` : '';
        let baseTitle = piece.name || piece.id;
        if (!isSelected && Math.max(screenW, screenH) < 58) {
          baseTitle = baseTitle
            .replace(/^Perimeter Gusset\s+/i, 'G')
            .replace(/^Left Profile Panel$/i, 'L Profile')
            .replace(/^Right Profile Panel$/i, 'R Profile');
        }
        const titleStr = `${baseTitle}${suffix}`;
        ctx.font = '600 11px sans-serif';
        const tw = measureTextWidth(titleStr, 6.2) + 12;
        const centerX = (sMin.x + sMax.x) * 0.5;
        const centerY = (sMin.y + sMax.y) * 0.5;
        const isNarrowStrip = screenH < 34 || screenW < tw + 10;
        const saPx = scene.showCutLine ? Math.max(0, (piece.seamAllowance || 10) * this.cam.zoom) : 0;
        const labelY = isNarrowStrip ? Math.max(sMin.y, sMax.y) + saPx + 20 : centerY;
        pendingLabels.push({
          kind: 'title',
          priority: 10,
          force: true,
          text: titleStr,
          x: centerX,
          y: labelY,
          anchorY: Math.max(sMin.y, sMax.y) + saPx,
          isNarrowStrip,
          isSelected,
          width: tw,
        });
      }
    }

    // 2. Sewing seam connectors (clean CLO3D mode: shown for selected piece, active seam walk, or Sew tool)
    if (scene.showSeams && Array.isArray(pattern.seams)) {
      const pieceMap = new Map(pattern.pieces.map((p) => [p.id, p]));
      const showAllTethers = scene.activeTool === 'sew';
      for (let i = 0; i < pattern.seams.length; i++) {
        const seam = pattern.seams[i];
        const isActiveSeam = scene.seamWalk?.seamId === seam.id;
        const touchesSelected =
          seam.pieceA === scene.selectedPieceId || seam.pieceB === scene.selectedPieceId;
        if (!showAllTethers && !isActiveSeam && !touchesSelected) continue;

        const pA = pieceMap.get(seam.pieceA);
        const pB = pieceMap.get(seam.pieceB);
        if (
          !pA ||
          !pB ||
          !Array.isArray(pA.points) ||
          pA.points.length < 2 ||
          !Array.isArray(pB.points) ||
          pB.points.length < 2
        ) {
          continue;
        }
        const eA = ((seam.edgeA % pA.points.length) + pA.points.length) % pA.points.length;
        const midA = this.pieceLocalToWorld(
          pA,
          evalEdgeAt(pA.points[eA], pA.points[(eA + 1) % pA.points.length], pA.edges?.[eA]?.curve || null, 0.5)
        );
        let midB;
        if (seam.internalLineIdB) {
          const il = pB.internalLines?.find((l) => l.id === seam.internalLineIdB);
          midB = il?.points?.length ? this.pieceLocalToWorld(pB, il.points[0]) : this.pieceLocalToWorld(pB, pB.points[0]);
        } else {
          const eB = ((seam.edgeB % pB.points.length) + pB.points.length) % pB.points.length;
          midB = this.pieceLocalToWorld(
            pB,
            evalEdgeAt(pB.points[eB], pB.points[(eB + 1) % pB.points.length], pB.edges?.[eB]?.curve || null, 0.5)
          );
        }
        const sa = this.worldToScreen(midA.x, midA.y);
        const sb = this.worldToScreen(midB.x, midB.y);
        ctx.setLineDash(isActiveSeam ? [] : [4, 4]);
        ctx.lineWidth = isActiveSeam ? 2.2 : 1.15;
        ctx.strokeStyle = isActiveSeam ? SEAM_COLORS[i % SEAM_COLORS.length] : 'rgba(56, 189, 248, 0.42)';
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 2b. Render collision-free Piece Titles & Outward Edge Dimensions
    pendingLabels.sort((a, b) => b.priority - a.priority);
    for (const lbl of pendingLabels) {
      if (lbl.kind === 'title') {
        ctx.font = '600 11px sans-serif';
        const w = lbl.width;
        const h = 18;
        let ly = lbl.y;
        if (!tryReserveRect(lbl.x, ly, w, h, false)) {
          ly += 19;
          tryReserveRect(lbl.x, ly, w, h, true);
        }
        if (lbl.isNarrowStrip) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lbl.x, lbl.anchorY + 2);
          ctx.lineTo(lbl.x, ly - h * 0.5);
          ctx.stroke();
        }
        ctx.fillStyle = lbl.isSelected ? 'rgba(14, 28, 46, 0.88)' : 'rgba(15, 20, 28, 0.80)';
        ctx.fillRect(lbl.x - w * 0.5, ly - h * 0.5, w, h);
        ctx.strokeStyle = lbl.isSelected ? 'rgba(56, 189, 248, 0.55)' : 'rgba(148, 163, 184, 0.24)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lbl.x - w * 0.5, ly - h * 0.5, w, h);
        ctx.fillStyle = lbl.isSelected ? '#e0f2fe' : '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.fillText(lbl.text, lbl.x, ly + 3.5);
        ctx.textAlign = 'left';
      } else {
        ctx.font = '10px monospace';
        const w = measureTextWidth(lbl.text, 5.8) + 8;
        const h = 14;
        let lx = lbl.x;
        let ly = lbl.y;
        let placed = tryReserveRect(lx, ly, w, h, false);
        if (!placed && lbl.force) {
          lx += lbl.outNx * 12;
          ly += lbl.outNy * 12;
          placed = tryReserveRect(lx, ly, w, h, true);
        }
        if (!placed) continue;
        ctx.fillStyle = 'rgba(15, 20, 28, 0.78)';
        ctx.fillRect(lx - w * 0.5, ly - h * 0.5, w, h);
        ctx.fillStyle = lbl.highlight ? '#fbbf24' : 'rgba(203, 213, 225, 0.86)';
        ctx.textAlign = 'center';
        ctx.fillText(lbl.text, lx, ly + 3.2);
        ctx.textAlign = 'left';
      }
    }

    // 3. Pending seam first-edge highlight
    if (scene.pendingSeamEdge) {
      const p = pattern.pieces.find((pc) => pc.id === scene.pendingSeamEdge.pieceId);
      const ei = scene.pendingSeamEdge.edgeIndex;
      if (
        p &&
        Array.isArray(p.points) &&
        p.points.length >= 2 &&
        Number.isInteger(ei) &&
        ei >= 0 &&
        ei < p.points.length
      ) {
        const mid = this.pieceLocalToWorld(
          p,
          evalEdgeAt(p.points[ei], p.points[(ei + 1) % p.points.length], p.edges?.[ei]?.curve || null, 0.5)
        );
        const ms = this.worldToScreen(mid.x, mid.y);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(ms.x, ms.y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 4. Seam Walk ghost overlay (`computeSeamWalkTransform`)
    if (scene.seamWalk && scene.seamWalk.seamId) {
      try {
        const walk = computeSeamWalkTransform(pattern, scene.seamWalk.seamId, scene.seamWalk.walkT ?? 0, {
          normalized: true,
        });
        if (Array.isArray(walk.transformedPointsB) && walk.transformedPointsB.length >= 3) {
          ctx.beginPath();
          for (let i = 0; i < walk.transformedPointsB.length; i++) {
            const s = this.worldToScreen(walk.transformedPointsB[i].x, walk.transformedPointsB[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
          ctx.fill();
          ctx.lineWidth = 2.0;
          ctx.setLineDash([7, 4]);
          ctx.strokeStyle = '#22d3ee';
          ctx.stroke();
          ctx.setLineDash([]);

          if (walk.contactPointWorld) {
            const cp = this.worldToScreen(walk.contactPointWorld.x, walk.contactPointWorld.y);
            ctx.fillStyle = '#fbbf24';
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
            ctx.fill();

            if (walk.tangentWorld) {
              const tip = {
                x: cp.x + walk.tangentWorld.x * 34,
                y: cp.y + walk.tangentWorld.y * 34,
              };
              this._drawArrow(cp, tip, '#fbbf24');
            }
          }
        }
      } catch {
        // Ignore stale seam walk if seam deleted
      }
    }

    // 5. Freeform Pen Polygon in progress
    if (scene.activeTool === 'draw_poly' && this.penPoints.length > 0) {
      ctx.beginPath();
      for (let i = 0; i < this.penPoints.length; i++) {
        const s = this.worldToScreen(this.penPoints[i].x, this.penPoints[i].y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      const curS = this.worldToScreen(this.mouseWorld.x, this.mouseWorld.y);
      ctx.lineTo(curS.x, curS.y);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      for (let i = 0; i < this.penPoints.length; i++) {
        const s = this.worldToScreen(this.penPoints[i].x, this.penPoints[i].y);
        ctx.fillStyle = i === 0 ? '#34d399' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(s.x, s.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
