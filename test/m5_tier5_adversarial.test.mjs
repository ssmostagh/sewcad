/**
 * Tier-5 Adversarial & Hardening Test Suite (`test/m5_tier5_adversarial.test.mjs`)
 * Covers all Challenger 1 (`adv_*`) and Challenger 2 (`T5-*`) bug regressions and adversarial edge cases:
 *  - Core STL malformed ASCII / 0-tri binary / topology extremes (`adv_stl_malformed_and_topology`)
 *  - Geometry exports, short-edge double notch, dart overlap/clamping, degeneracies (`adv_geometry_exports_and_corner_cases`)
 *  - Templates CAD invariants, grainLock/rotationOrigin, splitPieceEdge, mirror/delete guards (`adv_templates_cad_invariants`)
 *  - Types unit scaling, WEAVE_TYPES PBR/SVG XML escaping & #RGB hex (`adv_types_and_materials_edge_cases`)
 *  - Physics NaN/Infinity recovery, live updateMaterial, colliders & avatar extremes (`adv_physics_stress_and_recovery`)
 *  - Nesting & exporters parity (`quantity<=0`, `usable<=0`, `rotated90` curved+darted+onFold `<=0.1mm`, hostile names) (`adv_nesting_and_exporters_parity`)
 *  - Server chunked 413, truncated stream, timeout/abort/queue 503, symlink/null-byte traversal, HTTP 405/HEAD, strict 400 (`T5-SRV-01`..`04`)
 *  - CLI negative/unknown flags & directory/missing args (`T5-CLI-01`)
 *  - Frontend CAD2DViewport, WebGL3DViewport, and app.mjs DOM/unit/undo/export/XSS invariants (`T5-FE-01`..`03`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as core from '../src/core/index.mjs';
import { resolveEdgeDarts } from '../src/core/geometry.mjs';
import { CAD2DViewport } from '../public/cad2d.mjs';
import { createViewport3D } from '../public/webgl3d.mjs';
import { startServer } from '../src/server.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs');
const VERIFY_EXPORTS_PY = path.join(PROJECT_ROOT, 'e2e_tests', 'verify_exports.py');

function assertNear(actual, expected, tol, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ? msg + ': ' : ''}expected ${actual} within ${tol} of ${expected}`
  );
}

async function closeStudioServer(srv) {
  if (!srv?.server) return;
  srv.server.closeAllConnections?.();
  await new Promise((resolve) => srv.server.close(() => resolve()));
}

async function withTempDir(fn, prefix = 'psv2-m5-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function runVerifyExports(format, contentOrBuffer, expectations = {}) {
  return withTempDir(async (tmpDir) => {
    const ext = format === 'pdf' ? 'pdf' : format === 'dxf' ? 'dxf' : 'svg';
    const filePath = path.join(tmpDir, `export.${ext}`);
    const expPath = path.join(tmpDir, 'expectations.json');
    if (typeof contentOrBuffer === 'string') {
      await fsp.writeFile(filePath, contentOrBuffer, 'utf8');
    } else {
      await fsp.writeFile(filePath, contentOrBuffer);
    }
    await fsp.writeFile(expPath, JSON.stringify(expectations), 'utf8');
    try {
      const { stdout } = await execFileAsync(
        'python3',
        ['-B', VERIFY_EXPORTS_PY, '--format', format, '--file', filePath, '--expectations', expPath],
        {
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          maxBuffer: 10 * 1024 * 1024,
        }
      );
      return JSON.parse(stdout);
    } catch (err) {
      if (err.stdout) {
        try {
          return JSON.parse(err.stdout);
        } catch {
          // fall through
        }
      }
      throw err;
    }
  });
}

async function runCliProcess(args, { cwd = PROJECT_ROOT, env = {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.once('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

function makeTriStlText(tris, headerName = 'test_mesh') {
  const lines = [`solid ${headerName}`];
  for (const [a, b, c] of tris) {
    lines.push('  facet normal 0 0 1');
    lines.push('    outer loop');
    lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
    lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
    lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${headerName}`);
  return lines.join('\n');
}

function makeBinaryStl(tris, headerText = 'binary test') {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(headerText.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  for (let i = 0; i < tris.length; i++) {
    const off = 84 + i * 50;
    buf.writeFloatLE(0, off + 0);
    buf.writeFloatLE(0, off + 4);
    buf.writeFloatLE(1, off + 8);
    const [a, b, c] = tris[i];
    [a, b, c].forEach((v, k) => {
      const vo = off + 12 + k * 12;
      buf.writeFloatLE(v[0], vo);
      buf.writeFloatLE(v[1], vo + 4);
      buf.writeFloatLE(v[2], vo + 8);
    });
  }
  return buf;
}

function makeTorusTris(R = 40, r = 12, nu = 12, nv = 8) {
  const tris = [];
  const pt = (i, j) => {
    const u = ((i % nu) / nu) * Math.PI * 2;
    const v = ((j % nv) / nv) * Math.PI * 2;
    const rc = R + r * Math.cos(v);
    return [rc * Math.cos(u), r * Math.sin(v), rc * Math.sin(u)];
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const p00 = pt(i, j);
      const p10 = pt(i + 1, j);
      const p11 = pt(i + 1, j + 1);
      const p01 = pt(i, j + 1);
      tris.push([p00, p10, p11]);
      tris.push([p00, p11, p01]);
    }
  }
  return tris;
}

function makeOpenGridTris(nx = 4, ny = 4, size = 20) {
  const tris = [];
  const p = (i, j) => [i * size, Math.sin(i * 0.6) * 8 + Math.cos(j * 0.5) * 6, j * size];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      tris.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)]);
      tris.push([p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
    }
  }
  return tris;
}

function createMock2DContext() {
  const ops = [];
  const noop = (name) => (...args) => {
    ops.push({ op: name, argsCount: args.length, args });
  };
  return {
    ops,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    save: noop('save'),
    restore: noop('restore'),
    setTransform: noop('setTransform'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    bezierCurveTo: noop('bezierCurveTo'),
    quadraticCurveTo: noop('quadraticCurveTo'),
    arc: noop('arc'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    setLineDash: noop('setLineDash'),
    fillText: noop('fillText'),
    translate: noop('translate'),
    rotate: noop('rotate'),
    measureText: (t) => ({ width: String(t).length * 6 }),
  };
}

function createStrictMockWebGL2Context() {
  let nextId = 1;
  let activeProgram = null;
  let boundVao = null;
  let boundArrayBuf = null;
  let boundElemBuf = null;
  const vaos = new Map();
  const programs = new Map();
  const buffers = new Set();
  const textures = new Set();
  const drawCalls = [];

  const getUniformLocations = (vsSrc, fsSrc) => {
    const names = new Set();
    for (const src of [vsSrc, fsSrc]) {
      for (const m of src.matchAll(/\buniform\s+\w+\s+([A-Za-z_]\w*)(?:\[\d+\])?\s*;/g)) {
        names.add(m[1]);
      }
    }
    return new Map(Array.from(names, (n) => [n, { name: n }]));
  };

  const getAttribLocations = (vsSrc) => {
    const map = new Map();
    let idx = 1;
    for (const m of vsSrc.matchAll(/\bin\s+\w+\s+([A-Za-z_]\w*)\s*;/g)) {
      map.set(m[1], idx++);
    }
    return map;
  };

  return {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_BYTE: 0x1401,
    TRIANGLES: 0x0004,
    LINES: 0x0001,
    POINTS: 0x0000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    REPEAT: 0x2901,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    RGBA: 0x1908,
    _state: { programs, vaos, buffers, textures, drawCalls },
    createShader(type) { return { id: nextId++, type, source: '' }; },
    shaderSource(sh, src) { sh.source = src; },
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    deleteShader() {},
    createProgram() {
      const p = { id: nextId++, vs: null, fs: null, uniforms: new Map(), attribs: new Map() };
      programs.set(p.id, p);
      return p;
    },
    attachShader(p, sh) {
      if (sh.type === 0x8b31) p.vs = sh;
      else p.fs = sh;
    },
    linkProgram(p) {
      p.uniforms = getUniformLocations(p.vs?.source || '', p.fs?.source || '');
      p.attribs = getAttribLocations(p.vs?.source || '');
    },
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    useProgram(p) { activeProgram = p; },
    deleteProgram(p) { if (p) programs.delete(p.id); },
    getAttribLocation(p, name) { return p?.attribs.has(name) ? p.attribs.get(name) : -1; },
    getUniformLocation(p, name) { return p?.uniforms.get(name) || null; },
    createVertexArray() {
      const v = { id: nextId++, attribs: new Map(), eboId: null };
      vaos.set(v.id, v);
      return v;
    },
    bindVertexArray(v) { boundVao = v || null; },
    deleteVertexArray(v) { if (v) vaos.delete(v.id); },
    createBuffer() {
      const b = { id: nextId++ };
      buffers.add(b.id);
      return b;
    },
    bindBuffer(target, b) {
      if (target === 0x8892) boundArrayBuf = b || null;
      if (target === 0x8893) {
        boundElemBuf = b || null;
        if (boundVao) boundVao.eboId = b ? b.id : null;
      }
    },
    bufferData() {},
    deleteBuffer(b) { if (b) buffers.delete(b.id); },
    enableVertexAttribArray(loc) {
      if (boundVao && loc >= 0) {
        const cur = boundVao.attribs.get(loc) || {};
        boundVao.attribs.set(loc, { ...cur, enabled: true });
      }
    },
    vertexAttribPointer(loc, size) {
      if (boundVao && loc >= 0) {
        const cur = boundVao.attribs.get(loc) || {};
        boundVao.attribs.set(loc, { ...cur, size, bufferId: boundArrayBuf?.id || null });
      }
    },
    createTexture() { const t = { id: nextId++ }; textures.add(t.id); return t; },
    activeTexture() {},
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    generateMipmap() {},
    deleteTexture(t) { if (t) textures.delete(t.id); },
    uniform1i() {},
    uniform1f() {},
    uniform2f() {},
    uniform3f() {},
    uniform4f() {},
    uniform3fv() {},
    uniform4fv() {},
    uniformMatrix4fv() {},
    viewport() {},
    enable() {},
    disable() {},
    blendFunc() {},
    clearColor() {},
    clear() {},
    drawArrays(mode, first, count) {
      drawCalls.push({ kind: 'drawArrays', mode, first, count, progId: activeProgram?.id });
    },
    drawElements(mode, count, type, offset) {
      drawCalls.push({ kind: 'drawElements', mode, count, type, offset, progId: activeProgram?.id });
    },
  };
}

// ============================================================================
// 1. Challenger 1 Core Adversarial Tests (`adv_*`)
// ============================================================================

test('adv_stl_malformed_and_topology: malformed ASCII NaN/Infinity, 0-tri binary, >512B header, degenerate & topological unwraps', () => {
  // 1a) Malformed ASCII STL with NaN across 3 facets MUST throw INVALID_STL (never re-stitch cross-facet vertices)
  const nanCrossFacetAscii = [
    'solid bad',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex NaN 0 0',
    '      vertex 10 0 0',
    '      vertex 0 10 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 20 0 0',
    '      vertex Infinity 0 0',
    '      vertex 20 10 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 40 0 0',
    '      vertex 50 0 0',
    '      vertex -Infinity 10 0',
    '    endloop',
    '  endfacet',
    'endsolid bad',
  ].join('\n');
  assert.throws(
    () => core.parseSTL(nanCrossFacetAscii, 'bad_nan.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL'
  );

  // 2-vertex malformed facet
  const twoVertFacet = [
    'solid two',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 10 0 0',
    '    endloop',
    '  endfacet',
    'endsolid two',
  ].join('\n');
  assert.throws(
    () => core.parseSTL(twoVertFacet, 'two.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL'
  );

  // 1b) Binary 84-byte STL with triCount === 0 throws EMPTY_STL
  const emptyBin = Buffer.alloc(84);
  emptyBin.write('empty binary header', 0, 'ascii');
  emptyBin.writeUInt32LE(0, 80);
  assert.throws(
    () => core.parseSTL(emptyBin, 'empty_bin.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'EMPTY_STL'
  );

  // Small ASCII STL <84 bytes with 0 facets also throws EMPTY_STL
  assert.throws(
    () => core.parseSTL('solid empty\nendsolid empty\n', 'empty_ascii.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'EMPTY_STL'
  );

  // 1c) ASCII STL with >512B header before first facet/vertex parses cleanly (CRLF + scientific notation + optional normal)
  const longHeaderComment = 'x'.repeat(650);
  const longHeaderAscii = [
    `solid ${longHeaderComment}`,
    '  facet',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1e1 0 0',
    '      vertex 0 1e1 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 -1',
    '    outer loop',
    '      vertex 0 0 10',
    '      vertex 0 10 10',
    '      vertex 10 0 10',
    '    endloop',
    '  endfacet',
    `endsolid ${longHeaderComment}`,
  ].join('\r\n');
  const parsedLong = core.parseSTL(longHeaderAscii, 'long_hdr.stl');
  assert.equal(parsedLong.format, 'ascii');
  assert.equal(parsedLong.triangleCount, 2);

  // 1d) Degenerate-only STL: faceCount === analyzeSTLTopology(mesh).faces.length
  const degenAscii = makeTriStlText([
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[0, 0, 0], [10, 0, 0], [10, 0, 0]],
    [[0, 0, 0], [20, 0, 0], [0, 20, 0]],
  ], 'degen');
  const parsedDegen = core.parseSTL(degenAscii, 'degen.stl');
  const degenTopo = core.analyzeSTLTopology(parsedDegen);
  assert.equal(parsedDegen.faceCount, degenTopo.faces.length);
  assert.equal(parsedDegen.faceCount, 1);

  // 1e) Topological extremes: non-manifold edge, open shell, genus-1 torus, 2 shells, extreme aspect ratios
  const nonManifold = makeTriStlText([
    [[0, 0, 0], [40, 0, 0], [20, 35, 0]],
    [[0, 0, 0], [20, -35, 0], [40, 0, 0]],
    [[0, 0, 0], [20, 0, 35], [40, 0, 0]],
    [[40, 0, 0], [20, 0, 35], [20, 35, 0]],
  ], 'non_manifold');
  const nmMesh = core.parseSTL(nonManifold, 'nm.stl');
  assert.ok(core.analyzeSTLTopology(nmMesh).nonManifoldEdges > 0);

  const openGridMesh = core.parseSTL(makeTriStlText(makeOpenGridTris(3, 3, 25), 'open_grid'), 'open_grid.stl');
  assert.ok(core.analyzeSTLTopology(openGridMesh).boundaryEdges > 0);

  const torusMesh = core.parseSTL(makeBinaryStl(makeTorusTris(45, 12, 10, 8), 'torus'), 'torus.stl');
  const twoShells = [
    ...core.parseSTL(core.createBoxSTL(40, 40, 40), 'b1').triangles.map((t) => [
      [t[0].x, t[0].y, t[0].z],
      [t[1].x, t[1].y, t[1].z],
      [t[2].x, t[2].y, t[2].z],
    ]),
    ...core.parseSTL(core.createBoxSTL(30, 30, 30), 'b2').triangles.map((t) => [
      [t[0].x + 120, t[0].y, t[0].z],
      [t[1].x + 120, t[1].y, t[1].z],
      [t[2].x + 120, t[2].y, t[2].z],
    ]),
  ];
  const twoShellMesh = core.parseSTL(makeTriStlText(twoShells, 'two_shells'), 'two_shells.stl');
  assert.equal(core.analyzeSTLTopology(twoShellMesh).shellCount, 2);

  const rodMesh = core.parseSTL(core.createBoxSTL(1000, 5, 5), 'rod.stl');
  const sheetMesh = core.parseSTL(core.createBoxSTL(1000, 1000, 1), 'sheet.stl');
  const microMesh = core.parseSTL(core.createBoxSTL(1, 1, 1), 'micro.stl');

  for (const [label, mesh] of [
    ['nonManifold', nmMesh],
    ['openGrid', openGridMesh],
    ['torus', torusMesh],
    ['twoShells', twoShellMesh],
    ['rod', rodMesh],
    ['sheet', sheetMesh],
    ['micro', microMesh],
  ]) {
    for (const mode of ['form_shell_cover', 'surface_panels']) {
      const pat = core.unwrapSTLToPattern(mesh, { mode, seamAllowance: 8 });
      const val = core.validatePatternProject(pat);
      assert.equal(val.valid, true, `${label}/${mode} must be valid: ${val.errors.map((e) => e.message).join('; ')}`);
      const seamVal = core.validatePatternSeams(pat);
      assert.equal(seamVal.filter((s) => !s.valid).length, 0, `${label}/${mode} must have 0 invalid seams`);
      for (const pc of pat.pieces) {
        assert.equal(core.polygonSelfIntersects(pc.points), false, `${label}/${mode} piece ${pc.id} self-intersects`);
      }
    }
  }
});

test('adv_geometry_exports_and_corner_cases: 16 untested exports, short double notch, dart overlap/clamping, collinear degeneracies', () => {
  // 2a) All 16 previously untested geometry.mjs exports
  assertNear(core.convertFromMm(25.4, 'in'), 1, 1e-9, 'convertFromMm');
  assertNear(core.convertToMm(2.5, 'cm'), 25, 1e-9, 'convertToMm');
  const qb = core.evalQuadraticBezier({ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }, 0.5);
  assertNear(qb.x, 50, 1e-6);
  assertNear(qb.y, 50, 1e-6);
  const en = core.evalEdgeNormalAt({ x: 0, y: 0 }, { x: 100, y: 0 }, null, 0.5, 1);
  assertNear(Math.hypot(en.x, en.y), 1, 1e-6);
  const sq = core.splitQuadBezier({ x: 0, y: 0 }, { x: 50, y: 80 }, { x: 100, y: 0 }, 0.5);
  assertNear(sq.mid.x, 50, 1e-6);
  assertNear(sq.mid.y, 40, 1e-6);
  const sc = core.splitCubicBezier({ x: 0, y: 0 }, { x: 20, y: 60 }, { x: 80, y: 60 }, { x: 100, y: 0 }, 0.4);
  assert.ok(Number.isFinite(sc.mid.x) && Number.isFinite(sc.mid.y) && sc.curveA && sc.curveB);
  const lenQ = core.computeEdgeLength({ x: 0, y: 0 }, { x: 100, y: 0 }, { type: 'quadratic', cp: { x: 50, y: 60 } });
  assert.ok(lenQ > 100);
  const arcTable = core.buildEdgeArcTable({ x: 0, y: 0 }, { x: 100, y: 0 }, null, 32);
  assertNear(core.arcLengthAtT(arcTable, 0.5), 50, 1e-4);
  assertNear(core.tAtArcLength(arcTable, 25), 0.25, 1e-4);
  const ptArc = core.evalEdgeAtArcLength({ x: 0, y: 0 }, { x: 100, y: 0 }, null, 75, arcTable);
  assertNear(ptArc.point.x, 75, 1e-4);
  const deduped = core.deduplicateConsecutivePoints([
    { x: 0, y: 0 },
    { x: 0, y: 1e-6 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.equal(deduped.length, 3);
  const cwTri = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }];
  assert.ok(core.polygonSignedArea(cwTri) < 0);
  const ccwTri = core.ensureCounterClockwise(cwTri);
  assert.ok(core.polygonSignedArea(ccwTri) > 0);
  assert.equal(core.pointInTriangle2D({ x: 2, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }), true);
  assert.equal(core.pointInTriangle2D({ x: 9, y: 9 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }), false);
  const pivotPiece = {
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
    rotationOrigin: { x: 25, y: 15 },
  };
  const pivot = core.getPieceTransformPivot(pivotPiece);
  assertNear(pivot.x, 25, 1e-6);
  assertNear(pivot.y, 15, 1e-6);
  const clipped = core.clipSelfIntersectingLoops([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]);
  assert.ok(Array.isArray(clipped) && clipped.length >= 3);

  // 2b) Double notch on < 5mm straight edge (3 x 100) stays strictly within [0, 3] X bounds
  const narrowPiece = core.createRectanglePiece('Narrow', 3, 100, { id: 'narrow', seamAllowance: 10 });
  core.addNotchToPiece(narrowPiece, { edgeIndex: 0, t: 0.5, type: 'double', depthMm: 4 });
  const notches = core.computePieceNotches(narrowPiece);
  assert.equal(notches.length, 1);
  assert.equal(notches[0].lines.length, 2);
  for (const ln of notches[0].lines) {
    assert.ok(ln[0].x >= -1e-6 && ln[0].x <= 3 + 1e-6, `notch p0.x out of [0,3]: ${ln[0].x}`);
    assert.ok(ln[1].x >= -1e-6 && ln[1].x <= 3 + 1e-6, `notch p1.x out of [0,3]: ${ln[1].x}`);
  }

  // 2c) Overlapping darts & corner-clamped wide darts: computePieceMeasurements & validatePatternSeams match samplePieceOutline
  const overlapPc = core.createRectanglePiece('Overlap A', 100, 100, { id: 'ov_a', seamAllowance: 0 });
  core.addDartToPiece(overlapPc, { edgeIndex: 0, t: 0.45, widthMm: 60, depthMm: 20 });
  core.addDartToPiece(overlapPc, { edgeIndex: 0, t: 0.55, widthMm: 60, depthMm: 20 });
  const ovResolved = resolveEdgeDarts(overlapPc.points[0], overlapPc.points[1], null, overlapPc.darts, 0, 1);
  const ovIntakeExpected = ovResolved.reduce((acc, d) => acc + d.intakeMm, 0);
  const ovMeas = core.computePieceMeasurements(overlapPc);
  assertNear(ovMeas.edges[0].dartIntakeMm, ovIntakeExpected, 0.5, 'overlapping darts intakeMm');
  const matePc = core.createRectanglePiece('Mate B', 40, 100, { id: 'ov_b', seamAllowance: 0 });
  const seamPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'dart_seam_match',
    name: 'Dart Seam Match',
    unit: 'mm',
    pieces: [overlapPc, matePc],
    seams: [{ id: 's1', pieceA: 'ov_a', edgeA: 0, pieceB: 'ov_b', edgeB: 0, type: 'plain' }],
  };
  const seamCheck = core.validatePatternSeams(seamPat);
  assertNear(seamCheck[0].lengthAMm, 40, 1.0, 'overlapping darts sewn lengthAMm must match actual outline ~40mm');

  const cornerPc = core.createRectanglePiece('CornerWide', 100, 100, { id: 'cw_a', seamAllowance: 0 });
  core.addDartToPiece(cornerPc, { edgeIndex: 0, t: 0.2, widthMm: 80, depthMm: 20 });
  const cornerResolved = resolveEdgeDarts(cornerPc.points[0], cornerPc.points[1], null, cornerPc.darts, 0, 1);
  const cornerMeas = core.computePieceMeasurements(cornerPc);
  assertNear(cornerMeas.edges[0].dartIntakeMm, cornerResolved[0].intakeMm, 0.5, 'corner-clamped dart intakeMm');

  // 2d) Collinear 3-vertex polygon degeneracy, miterLimit extremes, self-intersecting cubic Bezier loop
  const collinear = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
  const cCent = core.polygonCentroid(collinear);
  assert.ok(Number.isFinite(cCent.x) && Number.isFinite(cCent.y));
  const cOff = core.offsetPolygonOutward(collinear, 10);
  assert.ok(Array.isArray(cOff));
  const cTris = core.triangulatePolygon(collinear);
  assert.ok(Array.isArray(cTris.triangles));
  const colPiece = { id: 'col', name: 'Collinear', points: collinear, edges: [{}, {}, {}], seamAllowance: 10 };
  const cMesh = core.generateClothMesh2D(colPiece);
  assert.ok(Array.isArray(cMesh.vertices));
  const cGrain = core.computePieceGrainline(colPiece);
  assert.ok(Number.isFinite(cGrain.start.x) && Number.isFinite(cGrain.end.x));
  const cMeas = core.computePieceMeasurements(colPiece);
  assert.ok(Number.isFinite(cMeas.netAreaMm2) && Number.isFinite(cMeas.netPerimeterMm));

  const spike = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 2 }];
  for (const ml of [0, 0.5, 1, 10]) {
    const off = core.offsetPolygonOutward(spike, 12, { miterLimit: ml });
    assert.ok(off.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `miterLimit=${ml} finite`);
  }

  const loopBezierPiece = core.createFreeformPiece('Loop Bezier', [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ], { id: 'loop_bez', seamAllowance: 10 });
  loopBezierPiece.edges[0].curve = { type: 'cubic', cp1: { x: 150, y: -90 }, cp2: { x: -50, y: -90 } };
  const loopCut = core.computePieceCutBoundary(loopBezierPiece);
  assert.ok(loopCut.length >= 3 && loopCut.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('adv_templates_cad_invariants: grainLock/rotationOrigin, splitPieceEdge short edges, mirror/delete guards, rotated seamWalk', () => {
  // 3a) createRectanglePiece & createFreeformPiece preserve grainLock & rotationOrigin
  const rect = core.createRectanglePiece('Rect', 120, 80, {
    id: 'r1',
    grainLock: true,
    rotationOrigin: { x: 30, y: 20 },
  });
  assert.equal(rect.grainLock, true);
  assertNear(rect.rotationOrigin.x, 30, 1e-6);
  assertNear(rect.rotationOrigin.y, 20, 1e-6);

  const free = core.createFreeformPiece('Free', [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 60, y: 90 },
  ], {
    id: 'f1',
    grainLock: true,
    rotationOrigin: { x: 50, y: 30 },
  });
  assert.equal(free.grainLock, true);
  // createFreeformPiece translates minX/minY (10,10) -> (0,0), shifting rotationOrigin cleanly
  assertNear(free.rotationOrigin.x, 40, 1e-6);
  assertNear(free.rotationOrigin.y, 20, 1e-6);

  // 3b) splitPieceEdge with piece.edges.length < piece.points.length normalizes edges
  const shortEdgesPc = core.createRectanglePiece('ShortEdges', 100, 100, { id: 'se1' });
  shortEdgesPc.edges = [{ seamAllowance: 15 }];
  core.splitPieceEdge(shortEdgesPc, 2, 0.5);
  assert.equal(shortEdgesPc.points.length, 5);
  assert.equal(shortEdgesPc.edges.length, 5);
  assert.equal(shortEdgesPc.edges[0].seamAllowance, 15);
  const valShort = core.validatePatternPiece(shortEdgesPc);
  assert.equal(valShort.valid, true, `splitPieceEdge result must be valid: ${valShort.errors.map((e) => e.message).join('; ')}`);

  // 3c) mirrorPieceAcrossEdge: tilted 45 deg with active seams succeeds, curved axis & concave self-intersecting reject
  const triPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'tilt_mir',
    name: 'Tilt Mirror',
    unit: 'mm',
    pieces: [
      core.createFreeformPiece('Tri', [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ], { id: 'tm1' }),
      core.createRectanglePiece('Mate', 100, 50, { id: 'tm2' }),
    ],
    seams: [{ id: 's_tilt', pieceA: 'tm1', edgeA: 2, pieceB: 'tm2', edgeB: 0, type: 'plain' }],
  };
  const beforeTiltArea = core.polygonArea(triPat.pieces[0].points);
  core.mirrorPieceAcrossEdge(triPat.pieces[0], 2, triPat);
  assertNear(core.polygonArea(triPat.pieces[0].points), beforeTiltArea * 2, 1.0);
  assert.equal(triPat.pieces[0].points.length, 4);

  const curvedMirPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'curv_mir',
    name: 'Curved Mirror',
    unit: 'mm',
    pieces: [
      {
        ...core.createRectanglePiece('Curv', 100, 100, { id: 'cm1' }),
        edges: [
          { seamAllowance: 10, curve: { type: 'quadratic', cp: { x: 50, y: -30 } } },
          { seamAllowance: 10 },
          { seamAllowance: 10 },
          { seamAllowance: 10 },
        ],
      },
    ],
    seams: [],
  };
  assert.throws(
    () => core.mirrorPieceAcrossEdge(curvedMirPat.pieces[0], 0, curvedMirPat),
    (err) => err instanceof core.ValidationError && err.code === 'CURVED_MIRROR_AXIS'
  );

  const concaveMirPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'conc_mir',
    name: 'Concave Mirror',
    unit: 'mm',
    pieces: [
      core.createFreeformPiece('Arrow', [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 40 },
        { x: 50, y: 80 },
        { x: 0, y: 80 },
      ], { id: 'cc1' }),
    ],
    seams: [],
  };
  assert.throws(
    () => core.mirrorPieceAcrossEdge(concaveMirPat.pieces[0], 2, concaveMirPat),
    (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
  );

  // deletePieceVertex: reject zero-area collinear collapse cleanly
  const colDelPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'col_del',
    name: 'Collinear Delete',
    unit: 'mm',
    pieces: [
      core.createFreeformPiece('LinePlus', [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 40 },
      ], { id: 'cd1' }),
    ],
    seams: [],
  };
  assert.throws(
    () => core.deletePieceVertex(colDelPat.pieces[0], 3, colDelPat),
    (err) => err instanceof core.ValidationError && err.code === 'DEGENERATE_POLYGON'
  );
  assert.equal(colDelPat.pieces[0].points.length, 4, 'rejected delete must not mutate piece');

  // 3d) computeSeamWalkTransform with rotated pieceB (rotation=45) and hoodie internalLineIdB
  const swA = core.createRectanglePiece('SwA', 100, 60, { id: 'swa' });
  const swB = core.createRectanglePiece('SwB', 100, 60, { id: 'swb', rotation: 45, position: { x: 200, y: 100 } });
  const swPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'sw_pat',
    name: 'SW',
    unit: 'mm',
    pieces: [swA, swB],
    seams: [{ id: 'sw1', pieceA: 'swa', edgeA: 0, pieceB: 'swb', edgeB: 2, type: 'plain' }],
  };
  const swTf = core.computeSeamWalkTransform(swPat, 'sw1', 0.5);
  assert.ok(Number.isFinite(swTf.translation.x) && Number.isFinite(swTf.translation.y) && Number.isFinite(swTf.angleDeg));

  const hoodie = core.generateTemplatePattern('hoodie');
  const pocketSeam = hoodie.seams.find((s) => s.id === 'seam_pocket_top' && s.internalLineIdB === 'kangaroo_placement');
  assert.ok(pocketSeam, 'hoodie must contain seam_pocket_top referencing kangaroo_placement');
  const pocketWalk = core.computeSeamWalkTransform(hoodie, pocketSeam.id, 0.5);
  assert.ok(Number.isFinite(pocketWalk.translation.x) && Number.isFinite(pocketWalk.angleDeg));
});

test('adv_types_and_materials_edge_cases: unit scaling constants, normalizePatternProject in->mm, 6 WEAVE_TYPES PBR/SVG XML & #RGB', () => {
  assert.deepEqual(core.NOTCH_TYPES, ['single', 'double', 'v', 't']);
  assert.deepEqual(core.INTERNAL_LINE_TYPES, ['fold', 'stitch', 'pocket', 'grain', 'balance', 'guide']);
  assert.equal(core.DEFAULT_AVATAR_MEASUREMENTS.chestMm, 980);
  assert.equal(core.isValidUnit('in'), true);
  assert.equal(core.isValidUnit('pt'), false);

  const inProj = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'in_proj',
    name: 'Inch Project',
    unit: 'in',
    pieces: [
      {
        id: 'p1',
        name: 'InchSq',
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
        position: { x: 1, y: 2 },
        rotationOrigin: { x: 2, y: 1 },
        seamAllowance: 0.5,
        grainline: { start: { x: 2.5, y: 0.5 }, end: { x: 2.5, y: 4.5 }, angleDeg: 90 },
        notches: [{ edgeIndex: 0, t: 0.5, depthMm: 0.25, type: 'single' }],
        darts: [{ edgeIndex: 1, t: 0.5, widthMm: 0.5, depthMm: 1 }],
        internalLines: [{ id: 'il1', type: 'stitch', points: [{ x: 1, y: 1 }, { x: 4, y: 1 }] }],
      },
    ],
    seams: [],
  };
  const norm = core.normalizePatternProject(inProj);
  assert.equal(norm.unit, 'mm');
  assertNear(norm.pieces[0].points[1].x, 127, 1e-4);
  assertNear(norm.pieces[0].position.x, 25.4, 1e-4);
  assertNear(norm.pieces[0].rotationOrigin.x, 50.8, 1e-4);
  assertNear(norm.pieces[0].seamAllowance, 12.7, 1e-4);
  assertNear(norm.pieces[0].grainline.start.x, 63.5, 1e-4);
  assertNear(norm.pieces[0].notches[0].depthMm, 6.35, 1e-4);
  assertNear(norm.pieces[0].darts[0].widthMm, 12.7, 1e-4);
  assertNear(norm.pieces[0].internalLines[0].points[1].x, 101.6, 1e-4);

  for (const wt of core.WEAVE_TYPES) {
    const cfg = core.getMaterialConfig('cotton_jersey', { weaveType: wt, baseColor: '#abc' });
    assert.equal(cfg.baseColor, '#aabbcc', '3-char #RGB hex must expand to #aabbcc');
    const pbrOdd = core.generateProceduralPBRMaps(cfg, 17);
    assert.equal(pbrOdd.size, 17);
    assert.equal(pbrOdd.albedo.data.length, 17 * 17 * 4);
    const pbrNaN = core.generateProceduralPBRMaps(cfg, NaN);
    assert.ok(Number.isInteger(pbrNaN.size) && pbrNaN.size >= 16);
  }

  const svgWeave = core.generateProceduralWeaveSVG({
    weaveType: 'plain',
    baseColor: '#abc" onclick="alert(1)',
    warpColor: '<script>',
  });
  assert.ok(!svgWeave.includes('<script>'), 'SVG weave must XML-escape hostile colors');
});

test('adv_physics_stress_and_recovery: NaN/1e6 recovery, empty/tiny pieces, extreme materials, live updateMaterial & colliders', () => {
  // 5a) Runtime NaN/Infinity/1e6 particle injection recovery
  const tshirt = core.generateTemplatePattern('tshirt');
  const avatar = core.createParametricAvatar();
  const sim = new core.ClothSimulation(tshirt, { avatar, maxEdgeLengthMm: 45 });
  assert.ok(sim.particles.length > 10);
  sim.particles[0].pos.x = NaN;
  sim.particles[1].pos.y = Infinity;
  sim.particles[2].pos.z = 1e6;
  sim.particles[2].prevPos.x = -Infinity;
  sim.step(5);
  for (const p of sim.particles) {
    assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z), 'particle pos must recover finite');
    assert.ok(Math.abs(p.pos.x) < 1e5 && Math.abs(p.pos.y) < 1e5 && Math.abs(p.pos.z) < 1e5, 'particle pos bounded after 1e6');
  }

  // 5b) Empty pieces: [], tiny 2x2mm with bad edgeA, step(0)/step(-5)/step(NaN)
  const emptySim = new core.ClothSimulation({ id: 'empty', name: 'Empty', unit: 'mm', pieces: [], seams: [] });
  emptySim.step(2);
  assert.equal(emptySim.particles.length, 0);

  const tinySim = new core.ClothSimulation({
    id: 'tiny',
    name: 'Tiny',
    unit: 'mm',
    pieces: [core.createFreeformPiece('TinyTri', [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }], { id: 't1' })],
    seams: [{ id: 'bad', pieceA: 't1', edgeA: 99, pieceB: 't1', edgeB: 0, type: 'plain' }],
  });
  tinySim.step(0);
  tinySim.step(-5);
  tinySim.step(NaN);
  assert.ok(tinySim.particles.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)));

  // 5c) Live updateMaterial (B-07) updates constraint alpha & unpinned particle invMass while keeping pinned invMass=0
  const liveSim = new core.ClothSimulation(tshirt, { avatar, materialId: 'cotton_jersey', maxEdgeLengthMm: 50 });
  liveSim.particles[0].invMass = 0; // pin particle 0
  const unpinnedIdx = liveSim.particles.findIndex((p, idx) => idx > 0 && p.invMass > 0);
  assert.ok(unpinnedIdx >= 0);
  const oldAlphaStruct = liveSim.structuralConstraints[0].alpha;
  const oldAlphaShear = liveSim.shearConstraints[0].alpha;
  const oldInvMass = liveSim.particles[unpinnedIdx].invMass;
  liveSim.updateMaterial(core.getMaterialConfig('veg_leather', { stretchStiffness: 0.99, shearStiffness: 0.99, gsm: 2000 }));
  assert.notEqual(liveSim.structuralConstraints[0].alpha, oldAlphaStruct, 'structural alpha must update live');
  assert.notEqual(liveSim.shearConstraints[0].alpha, oldAlphaShear, 'shear alpha must update live');
  assert.notEqual(liveSim.particles[unpinnedIdx].invMass, oldInvMass, 'unpinned invMass must scale with new GSM');
  assert.equal(liveSim.particles[0].invMass, 0, 'pinned particle invMass must remain 0');

  // 5d) Extreme materials, extreme avatars, internalLineIdB sewing (hoodie), simultaneous dart + seam + BVH + avatar + floor
  for (const overrides of [
    { stretchStiffness: 0, shearStiffness: 0, bendingStiffness: 0, damping: 0, friction: 0, gsm: 1, maxSafeStrainPct: 0 },
    { stretchStiffness: 1, shearStiffness: 1, bendingStiffness: 1, damping: 1, friction: 1, gsm: 5000, maxSafeStrainPct: NaN },
  ]) {
    const extSim = new core.ClothSimulation(tshirt, {
      material: core.getMaterialConfig('cotton_jersey', overrides),
      maxEdgeLengthMm: 60,
    });
    extSim.step(2);
    const st = extSim.computeStrainAnalysis();
    assert.ok(Number.isFinite(st.maxStrainPct));
  }

  for (const avOpts of [
    { chestMm: 500, waistMm: 600, hipMm: 550, heightMm: 900 },
    { chestMm: 1600, waistMm: 1500, hipMm: 1700, heightMm: 2200 },
    { chestMm: 0, waistMm: -100, hipMm: 0, heightMm: 0 },
  ]) {
    const av = core.createParametricAvatar(avOpts);
    assert.ok(av.triangles.length > 0);
  }

  const hoodie = core.generateTemplatePattern('hoodie');
  const boxStl = core.parseSTL(core.createBoxSTL(200, 200, 200), 'box.stl');
  const comboSim = new core.ClothSimulation(hoodie, { avatar, stlMesh: boxStl, maxEdgeLengthMm: 55 });
  comboSim.step(3);
  assert.ok(comboSim.sewingConstraints.some((c) => c.seamId === 'seam_pocket_top'), 'hoodie internalLineIdB seams active');
  assert.ok(comboSim.particles.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)));
});

test('adv_nesting_and_exporters_parity: quantity<=0 rejection, usable<=0, rotated90 <=0.1mm SVG/DXF/PDF, hostile names & tiling bounds', async () => {
  // 6a) Invalid quantity <= 0 / fractional throws ValidationError consistently across nesting & all exporters
  for (const badQty of [0, -2, 1.8, NaN]) {
    const basePc = core.createRectanglePiece('Q1', 50, 50, { id: 'q1' });
    basePc.quantity = badQty;
    const badPat = {
      schemaVersion: core.SCHEMA_VERSION,
      id: 'bad_qty',
      name: 'Bad Qty',
      unit: 'mm',
      pieces: [basePc],
      seams: [],
    };
    assert.throws(() => core.nestPatternPieces(badPat), (e) => e instanceof core.ValidationError && e.code === 'INVALID_PIECE');
    assert.throws(() => core.exportSVG(badPat), (e) => e instanceof core.ValidationError && e.code === 'INVALID_PIECE');
    assert.throws(() => core.exportDXF(badPat), (e) => e instanceof core.ValidationError && e.code === 'INVALID_PIECE');
    assert.throws(() => core.exportTiledPDF(badPat), (e) => e instanceof core.ValidationError && e.code === 'INVALID_PIECE');
    assert.equal(typeof core.exportPatternJSON(badPat), 'string');
  }

  // 6b) usableW <= 0 / usableH <= 0 -> EXCEEDS_USABLE_SHEET_BOUNDS & all-unfitted nested exports without crashing
  const rectPat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'unfit',
    name: 'Unfit',
    unit: 'mm',
    pieces: [core.createRectanglePiece('U1', 80, 60, { id: 'u1' })],
    seams: [],
  };
  const zeroUsableNest = core.nestPatternPieces(rectPat, { fabricWidthMm: 20, marginMm: 15, sheetLengthMm: 20 });
  assert.equal(zeroUsableNest.sheetCount, 0);
  assert.equal(zeroUsableNest.unfittedPieces[0].reason, 'EXCEEDS_USABLE_SHEET_BOUNDS');
  assert.ok(core.exportSVG(rectPat, { layout: 'nested', nestingResult: zeroUsableNest }).includes('<svg'));
  assert.ok(core.exportDXF(rectPat, { layout: 'nested', nestingResult: zeroUsableNest }).includes('EOF'));
  assert.ok(core.exportTiledPDF(rectPat, { layout: 'nested', nestingResult: zeroUsableNest }).pdfString.startsWith('%PDF'));

  // 6c) rotated90: true nested exports verified <= 0.1 mm via verify_exports.py
  const curvedDartPc = core.createRectanglePiece('CurvedDartRot', 140, 80, { id: 'cd_rot', seamAllowance: 10 });
  curvedDartPc.edges[1].curve = { type: 'cubic', cp1: { x: 165, y: 20 }, cp2: { x: 165, y: 60 } };
  core.addDartToPiece(curvedDartPc, { edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 25 });
  core.addNotchToPiece(curvedDartPc, { edgeIndex: 2, t: 0.5, type: 'single', depthMm: 4 });

  const zeroSaCurvedPc = core.createRectanglePiece('ZeroSACurv', 120, 60, { id: 'zsa_rot', seamAllowance: 0 });
  zeroSaCurvedPc.edges[0].curve = { type: 'quadratic', cp: { x: 60, y: -20 } };

  const foldRotPc = core.createRectanglePiece('FoldRot', 100, 60, {
    id: 'fr_rot',
    seamAllowance: 10,
    onFold: true,
    rotation: 15,
    rotationOrigin: { x: 20, y: 15 },
    internalLines: [{ id: 'il_rot', type: 'stitch', points: [{ x: 10, y: 10 }, { x: 90, y: 50 }] }],
  });

  const makeSingleNestPat = (pc) => ({
    schemaVersion: core.SCHEMA_VERSION,
    id: `rot90_${pc.id}`,
    name: `Rot90 ${pc.name}`,
    unit: 'mm',
    pieces: [pc],
    seams: [],
  });

  for (const [label, pc, cutEqualsNet] of [
    ['curved_dart_notch', curvedDartPc, false],
    ['zero_sa_curved', zeroSaCurvedPc, true],
    ['fold_rot_internal', foldRotPc, false],
  ]) {
    const pat = makeSingleNestPat(pc);
    const forcedNest = core.nestPatternPieces(pat, { fabricWidthMm: 500, sheetLengthMm: 500, marginMm: 10 });
    forcedNest.placements[0].rotated90 = true;
    const exp = {
      pieceCount: 1,
      cutEqualsNet,
      pieces: [
        {
          id: pc.id,
          name: pc.name,
          expectedNetBounds: core.polygonBounds(core.samplePieceOutline(pc)),
          expectedCutBounds: core.polygonBounds(core.computePieceCutBoundary(pc)),
        },
      ],
    };
    const svg = core.exportSVG(pat, { layout: 'nested', nestingResult: forcedNest });
    const dxf = core.exportDXF(pat, { layout: 'nested', nestingResult: forcedNest });
    const pdf = core.exportTiledPDF(pat, { layout: 'nested', nestingResult: forcedNest, pageFormat: 'A3' });

    const [rS, rD, rP] = await Promise.all([
      runVerifyExports('svg', svg, exp),
      runVerifyExports('dxf', dxf, exp),
      runVerifyExports('pdf', pdf.pdfBytes, exp),
    ]);
    assert.equal(rS.ok, true, `${label} rotated90 SVG <=0.1mm failed: ${JSON.stringify(rS)}`);
    assert.equal(rD.ok, true, `${label} rotated90 DXF <=0.1mm failed: ${JSON.stringify(rD)}`);
    assert.equal(rP.ok, true, `${label} rotated90 PDF <=0.1mm failed: ${JSON.stringify(rP)}`);

    if (label === 'fold_rot_internal') {
      assert.ok(svg.includes('id="internal-lines"'), 'SVG must contain internal-lines group');
    }
  }

  // 6d) Hostile DXF / PDF labels + extreme PDF tiling + importPatternJSON unit='in' + stl_cover thickness priority
  const hostilePat = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'hostile_exp',
    name: 'Evil\rName\n0\nENDSEC',
    unit: 'mm',
    pieces: [
      core.createRectanglePiece('Sleeve (Left) \\ "Test" \u2702\uFE0F\uD83D\uDD25', 80, 60, { id: 'h1' }),
    ],
    seams: [],
  };
  const hostileDxf = core.exportDXF(hostilePat);
  const hostilePdfExtreme = core.exportTiledPDF(hostilePat, {
    overlapMm: 500,
    marginMm: 150,
    pageWidthMm: 0,
  });
  assert.ok(hostilePdfExtreme.pdfString.startsWith('%PDF'));
  assert.ok(hostilePdfExtreme.pageCount >= 1 && hostilePdfExtreme.pageCount <= 20);
  assert.equal(/\bNaN\b/.test(hostilePdfExtreme.pdfString), false, 'extreme tiling PDF must contain no NaN tokens');

  const hostilePdfValid = core.exportTiledPDF(hostilePat, { pageFormat: 'LETTER', marginMm: 10, overlapMm: 15 });
  const [rHD, rHP] = await Promise.all([
    runVerifyExports('dxf', hostileDxf, { pieceCount: 1 }),
    runVerifyExports('pdf', hostilePdfValid.pdfBytes, { pieceCount: 1 }),
  ]);
  assert.equal(rHD.ok, true, `hostile DXF failed: ${JSON.stringify(rHD)}`);
  assert.equal(rHP.ok, true, `hostile PDF failed: ${JSON.stringify(rHP)}`);

  const jsonIn = JSON.stringify({
    schemaVersion: core.SCHEMA_VERSION,
    id: 'imp_in',
    name: 'Inch JSON',
    unit: 'in',
    pieces: [{ id: 'i1', name: 'I1', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }],
    seams: [],
  });
  const imp = core.importPatternJSON(jsonIn);
  assert.equal(imp.unit, 'mm');
  assertNear(imp.pieces[0].points[1].x, 50.8, 1e-4);

  const boxStl = core.createBoxSTL(60, 60, 40);
  const coverZero = core.generateTemplatePattern('stl_cover', { stlData: boxStl, materialId: 'eva_foam_4mm', thicknessMm: 0 });
  const coverFour = core.generateTemplatePattern('stl_cover', { stlData: boxStl, materialId: 'eva_foam_4mm' });
  const area0 = coverZero.pieces.reduce((a, p) => a + core.polygonArea(p.points), 0);
  const area4 = coverFour.pieces.reduce((a, p) => a + core.polygonArea(p.points), 0);
  assert.ok(area0 < area4, `explicit thicknessMm=0 (${area0}) must be < eva_foam_4mm (${area4})`);
});

// ============================================================================
// 2. Challenger 2 Server Adversarial Tests (`T5-SRV-01`..`T5-SRV-04`)
// ============================================================================

test('T5-SRV-01: chunked transfer-encoding >25MB returns 413 and truncated request recovers cleanly', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    // 1) Chunked 27 x 1MB payload without Content-Length -> 413 containing 26214400
    const chunkedResult = await new Promise((resolve, reject) => {
      let settled = false;
      let gotResponse = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(val);
      };
      const req = http.request({
        host: '127.0.0.1',
        port: srv.port,
        path: '/api/nest',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        gotResponse = true;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => done(null, { status: res.statusCode, body }));
        res.on('close', () => done(null, { status: res.statusCode, body }));
      });
      req.setTimeout(10000, () => {
        req.destroy(new Error('T5-SRV-01 chunked request timed out'));
      });
      req.on('error', (err) => {
        if ((err.code === 'ECONNRESET' || err.code === 'EPIPE') && gotResponse) {
          return;
        }
        done(err);
      });
      const oneMb = Buffer.alloc(1024 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        if (settled || gotResponse || req.destroyed) return;
        if (sent >= 26) {
          // Total written = 26 MiB > 25 MiB (26214400); wait for server's immediate 413 response
          return;
        }
        sent++;
        const ok = req.write(oneMb);
        if (ok) {
          setTimeout(pump, 5);
        } else {
          req.once('drain', () => setTimeout(pump, 5));
        }
      };
      pump();
    });
    assert.equal(chunkedResult.status, 413);
    assert.ok(chunkedResult.body.includes('26214400'));

    // 2) Truncated Content-Length stream mid-body -> server recovers cleanly
    await new Promise((resolve) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write('POST /api/nest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"pieces":');
        setTimeout(() => { sock.destroy(); resolve(); }, 50);
      });
      sock.on('error', () => resolve());
    });
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await closeStudioServer(srv);
  }
});

test('T5-SRV-02: simulation worker timeout 504, client abort recovery, and 24-request burst 503 queue full', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, simTimeoutMs: 15, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    const rTimeout = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'hoodie', steps: 20, maxEdgeLengthMm: 12 }),
    });
    assert.equal(rTimeout.status, 504);
    const jTimeout = await rTimeout.json();
    assert.match(jTimeout.error, /timed out/i);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  } finally {
    await closeStudioServer(srv);
  }

  const srv2 = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const base2 = `http://127.0.0.1:${srv2.port}`;
  try {
    // Client abort mid-simulation
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);
    await fetch(`${base2}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'hoodie', steps: 30, maxEdgeLengthMm: 15 }),
      signal: ac.signal,
    }).catch(() => {});

    const postAbort = await fetch(`${base2}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tshirt', steps: 2 }),
    });
    assert.equal(postAbort.status, 200);

    // 24-request burst against maxQueue=16 triggers >=1 503 and recovers cleanly
    const tshirt = core.generateTemplatePattern('tshirt');
    const burst = await Promise.all(
      Array.from({ length: 24 }, () =>
        fetch(`${base2}/api/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern: tshirt, steps: 60, maxEdgeLengthMm: 18 }),
        }).then(async (r) => ({ status: r.status, text: await r.text() }))
      )
    );
    const count503 = burst.filter((b) => b.status === 503 && b.text.includes('Simulation queue is full')).length;
    assert.ok(count503 >= 1, `Expected at least 1 HTTP 503 in 24-req burst, statuses=${burst.map((b) => b.status).join(',')}`);
    const postBurst = await fetch(`${base2}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tshirt', steps: 2 }),
    });
    assert.equal(postBurst.status, 200);
  } finally {
    await closeStudioServer(srv2);
  }
});

test('T5-SRV-03: symlink escape, null byte, malformed URI, static 405, /api/stl-content bounds, non-object JSON & proto pollution', async () => {
  await withTempDir(async (tmpDir) => {
    const pubDir = path.join(tmpDir, 'public');
    const wsDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    await fsp.mkdir(pubDir, { recursive: true });
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(path.join(pubDir, 'index.html'), '<h1>hi</h1>', 'utf8');
    await fsp.writeFile(path.join(outsideDir, 'secret.html'), '<h1>secret</h1>', 'utf8');
    await fsp.writeFile(path.join(outsideDir, 'secret.stl'), core.createBoxSTL(20, 20, 20), 'utf8');
    await fsp.writeFile(path.join(wsDir, 'legit.stl'), core.createBoxSTL(30, 30, 30), 'utf8');
    await fsp.symlink(path.join(outsideDir, 'secret.html'), path.join(pubDir, 'escape.html'));
    await fsp.symlink(path.join(outsideDir, 'secret.stl'), path.join(wsDir, 'escape.stl'));

    const srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      publicDir: pubDir,
      workspaceRoot: wsDir,
      quiet: true,
    });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    try {
      assert.equal((await fetch(`${baseUrl}/escape.html`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/stl-content?file=escape.stl`)).status, 404);
      const wsList = await (await fetch(`${baseUrl}/api/workspace-stls`)).json();
      assert.equal(wsList.files.some((f) => f.name === 'escape.stl'), false);
      assert.equal(wsList.files.some((f) => f.name === 'legit.stl'), true);

      assert.equal((await fetch(`${baseUrl}/src/core/types.mjs%00.mjs`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/src/core/`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/src/core/foo.txt`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/..%5c..%5cetc%5cpasswd`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/..%2fsrc/server.mjs`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/%E0%A4%A`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/src/server.mjs`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/index.html`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${baseUrl}/cad2d.mjs`, { method: 'DELETE' })).status, 405);

      assert.equal((await fetch(`${baseUrl}/api/stl-content`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/stl-content?file=missing.stl`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/stl-content?file=..%5Csecret.txt`)).status, 404);

      for (const nonObj of ['[]', 'null', '"hello"']) {
        const r = await fetch(`${baseUrl}/api/generate-template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: nonObj,
        });
        assert.equal(r.status, 400);
      }

      const protoPayload = '{"templateId":"tshirt","materialOverrides":{"__proto__":{"pollutedProbe":true}}}';
      const rProto = await fetch(`${baseUrl}/api/generate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: protoPayload,
      });
      assert.equal(rProto.status, 200);
      assert.equal(({}).pollutedProbe, undefined);
    } finally {
      await closeStudioServer(srv);
    }
  });
});

test('T5-SRV-04: HTTP HEAD/OPTIONS/405 semantics (B-04) and strict 400 validation for materialId/mode/pageFormat/steps/pieces/refs (B-06)', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    // B-04: HEAD, OPTIONS, 405
    const headHealth = await fetch(`${baseUrl}/api/health`, { method: 'HEAD' });
    assert.equal(headHealth.status, 200);
    assert.equal(await headHealth.text(), '');

    const postHealth = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
    assert.equal(postHealth.status, 405);
    assert.ok(postHealth.headers.get('allow')?.includes('GET'));

    const getExport = await fetch(`${baseUrl}/api/export`, { method: 'GET' });
    assert.equal(getExport.status, 405);
    assert.ok(getExport.headers.get('allow')?.includes('POST'));

    const delNest = await fetch(`${baseUrl}/api/nest`, { method: 'DELETE' });
    assert.equal(delNest.status, 405);

    const optSim = await fetch(`${baseUrl}/api/simulate`, { method: 'OPTIONS' });
    assert.equal(optSim.status, 204);
    assert.ok(optSim.headers.get('allow')?.includes('POST'));

    // B-06: strict 400 validation
    const tshirt = core.generateTemplatePattern('tshirt');
    const stlBase64 = Buffer.from(core.createBoxSTL(40, 40, 40), 'utf8').toString('base64');

    const rBadMat = await fetch(`${baseUrl}/api/generate-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tshirt', materialId: 'nonexistent_mat' }),
    });
    assert.equal(rBadMat.status, 400);

    const rBadUnwrapMode = await fetch(`${baseUrl}/api/unwrap-stl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stlBase64, mode: 'unknown_mode' }),
    });
    assert.equal(rBadUnwrapMode.status, 400);

    const rBadPageFmt = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirt, format: 'pdf', options: { pageFormat: 'BOGUS' } }),
    });
    assert.equal(rBadPageFmt.status, 400);

    const rNegSteps = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirt, steps: -5 }),
    });
    assert.equal(rNegSteps.status, 400);

    const rEmptyPiecesSim = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: { id: 'e', name: 'e', pieces: [], seams: [] }, steps: 2 }),
    });
    assert.equal(rEmptyPiecesSim.status, 400);

    const badDartPat = structuredClone(tshirt);
    badDartPat.pieces[0].darts = [{ edgeIndex: 999, t: 0.5, widthMm: 10, depthMm: 20 }];
    assert.equal(
      (await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: badDartPat, steps: 1 }),
      })).status,
      400
    );

    const badNotchPat = structuredClone(tshirt);
    badNotchPat.pieces[0].notches = [{ edgeIndex: -1, t: 0.5, depthMm: 4, type: 'single' }];
    assert.equal(
      (await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: badNotchPat, steps: 1 }),
      })).status,
      400
    );

    const badSeamPat = structuredClone(tshirt);
    badSeamPat.seams = [{ ...badSeamPat.seams[0], pieceA: 'missing_piece' }];
    assert.equal(
      (await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: badSeamPat, steps: 1 }),
      })).status,
      400
    );
  } finally {
    await closeStudioServer(srv);
  }
});


// ============================================================================
// 3. Challenger 2 CLI Adversarial Test (`T5-CLI-01`)
// ============================================================================

test('T5-CLI-01: CLI rejects negative --steps, unknown flags, directory --stl, missing/bad args & handles nested outDir', async () => {
  await withTempDir(async (tmpDir) => {
    const existingFile = path.join(tmpDir, 'already_file.txt');
    const validStl = path.join(tmpDir, 'box.stl');
    const nestedOut = path.join(tmpDir, 'deep', 'nested', 'out_dir');
    await fsp.writeFile(existingFile, 'occupied', 'utf8');
    await fsp.writeFile(validStl, core.createBoxSTL(60, 60, 40), 'utf8');

    // B-05 fixes
    const negSteps = await runCliProcess(['verify-sim', '--template', 'tshirt', '--steps', '-10']);
    assert.equal(negSteps.code, 1);
    assert.match(negSteps.stderr, /CLI Error:/);

    const bogusFlag = await runCliProcess(['template', '--type', 'tshirt', '--bogus=1', '--out', tmpDir]);
    assert.equal(bogusFlag.code, 1);
    assert.match(bogusFlag.stderr, /CLI Error:.*Unknown flag/i);

    const dirStlTpl = await runCliProcess(['template', '--type', 'stl_cover', '--stl', tmpDir]);
    assert.equal(dirStlTpl.code, 1);
    assert.match(dirStlTpl.stderr, /CLI Error:/i);
    assert.doesNotMatch(dirStlTpl.stderr, /EISDIR/);

    // G-03 error cases
    const badInvocations = [
      [],
      ['boguscmd'],
      ['template', '--type'],
      ['template', '--type', '--out', tmpDir],
      ['template', '--out', tmpDir],
      ['template', '--type', 'unknown_tpl'],
      ['template', '--type', 'tshirt', '--out', existingFile],
      ['template', '--type', 'tshirt', '--format', ''],
      ['template', '--type', 'tshirt', '--format', 'svg,bogus'],
      ['unwrap'],
      ['unwrap', '--stl', path.join(tmpDir, 'missing.stl')],
      ['unwrap', '--stl', tmpDir],
      ['unwrap', '--stl', validStl, '--mode', 'bogus_mode'],
      ['verify-sim'],
      ['verify-sim', '--steps', 'abc'],
    ];
    for (const argv of badInvocations) {
      const res = await runCliProcess(argv);
      assert.equal(res.code, 1, `Expected exit 1 for CLI ${JSON.stringify(argv)}, got ${res.code}`);
    }

    // Positive controls
    assert.equal((await runCliProcess(['help'])).code, 0);
    assert.equal((await runCliProcess(['-h'])).code, 0);
    const okUnwrap = await runCliProcess(['unwrap', '--stl', validStl, '--mode', 'form_shell_cover', '--out', nestedOut]);
    assert.equal(okUnwrap.code, 0, okUnwrap.stderr);
    assert.equal(fs.existsSync(path.join(nestedOut, 'box_form_shell_cover.svg')), true);
  });
});

// ============================================================================
// 4. Challenger 2 Frontend Adversarial Tests (`T5-FE-01`..`T5-FE-03`)
// ============================================================================

test('T5-FE-01: CAD2DViewport guards missing .edges, draw_poly >=3 pts, zoom clamp [0.05, 8], rotated vertex drag', () => {
  const listeners = new Map();
  const ctx = createMock2DContext();
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: (t) => (t === '2d' ? ctx : null),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };

  let createdPolys = 0;
  let lastCreated = null;
  let dragUpdates = 0;
  const emit = (type, ev) => {
    for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, ...ev });
  };

  const vp = new CAD2DViewport(canvas, {
    onCreateFreeform: (pts) => { createdPolys++; lastCreated = pts; },
    onGeometryDragging: () => { dragUpdates++; },
  });

  // B-01: Selected piece without .edges must NOT throw on render
  const noEdgesScene = {
    activeTool: 'select',
    pattern: {
      unit: 'mm',
      pieces: [
        {
          id: 'p1',
          name: 'NoEdges',
          points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }],
          position: { x: 0, y: 0 },
          rotation: 0,
        },
      ],
      seams: [],
    },
    selectedPieceId: 'p1',
    selectedVertexIndex: 0,
    showNet: true,
    showCut: false,
    showGrain: false,
    showNotches: false,
    showDarts: false,
    showInternalLines: false,
    showSeams: false,
  };
  assert.doesNotThrow(() => vp.render(noEdgesScene));

  // G-04a: draw_poly with 2 points + dblclick must NOT emit piece; 3rd point + dblclick emits 3-pt piece; click-near-start emits 3-pt piece
  vp.render({ ...noEdgesScene, activeTool: 'draw_poly' });
  emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
  emit('pointerdown', { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
  emit('dblclick', { clientX: 200, clientY: 100 });
  assert.equal(createdPolys, 0, '2 points + dblclick must not create polygon');
  emit('pointerdown', { clientX: 150, clientY: 180, button: 0, pointerId: 1 });
  emit('dblclick', { clientX: 150, clientY: 180 });
  assert.equal(createdPolys, 1);
  assert.equal(lastCreated.length, 3);

  emit('pointerdown', { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
  emit('pointerdown', { clientX: 400, clientY: 100, button: 0, pointerId: 1 });
  emit('pointerdown', { clientX: 350, clientY: 180, button: 0, pointerId: 1 });
  emit('pointerdown', { clientX: 302, clientY: 102, button: 0, pointerId: 1 });
  assert.equal(createdPolys, 2, 'click-near-start after 3 points must close & emit');
  assert.equal(lastCreated.length, 3);

  // G-04b: Zoom clamp strictly in [0.05, 8]
  for (let i = 0; i < 60; i++) emit('wheel', { clientX: 400, clientY: 300, deltaY: -120 });
  assert.ok(vp.cam.zoom <= 8 && vp.cam.zoom >= 7.5, `max zoom clamped <=8: ${vp.cam.zoom}`);
  for (let i = 0; i < 120; i++) emit('wheel', { clientX: 400, clientY: 300, deltaY: 120 });
  assert.ok(vp.cam.zoom >= 0.05 && vp.cam.zoom <= 0.06, `min zoom clamped >=0.05: ${vp.cam.zoom}`);

  // G-04c: Drag vertex 0 of a 90-deg rotated square by screen (+20, +10) at zoom=1 -> world dx=20, dy=10
  vp.cam.panX = 0;
  vp.cam.panY = 0;
  vp.cam.zoom = 1;
  const rotPiece = core.createRectanglePiece('RotSq', 100, 100, { id: 'rotp', rotation: 90, position: { x: 0, y: 0 } });
  const rotScene = {
    activeTool: 'select',
    pattern: { unit: 'mm', pieces: [rotPiece], seams: [] },
    selectedPieceId: 'rotp',
    selectedVertexIndex: -1,
    showNet: true,
    showCut: false,
    showGrain: false,
    showNotches: false,
    showDarts: false,
    showInternalLines: false,
    showSeams: false,
  };
  vp.render(rotScene);
  const wv0Before = vp.pieceLocalToWorld(rotPiece, rotPiece.points[0]);
  const sv0 = vp.worldToScreen(wv0Before.x, wv0Before.y);
  emit('pointerdown', { clientX: sv0.x, clientY: sv0.y, button: 0, pointerId: 1 });
  emit('pointermove', { clientX: sv0.x + 20, clientY: sv0.y + 10, pointerId: 1 });
  emit('pointerup', { clientX: sv0.x + 20, clientY: sv0.y + 10, pointerId: 1 });
  assert.ok(dragUpdates > 0, 'dragging vertex 0 of rotated piece must update geometry');
  const wv0After = vp.pieceLocalToWorld(rotPiece, rotPiece.points[0]);
  assertNear(wv0After.x - wv0Before.x, 20, 0.05);
  assertNear(wv0After.y - wv0Before.y, 10, 0.05);
});

test('T5-FE-02: WebGL3DViewport empty/NaN/dispose lifecycle and 5 GLSL #version 300 es shader binding parity', async () => {
  // Verify 2D fallback empty/NaN/dispose
  const ctx2d = createMock2DContext();
  const canvas2d = {
    width: 640,
    height: 480,
    getContext: (t) => (t === '2d' ? ctx2d : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    addEventListener() {},
  };
  const vp2 = createViewport3D(canvas2d);
  assert.equal(vp2.mode, '2d');
  vp2.setScene({ sim: null, stlMesh: null, avatar: null });
  assert.doesNotThrow(() => vp2.render());
  assert.equal(vp2.pickParticle(100, 100), null);
  vp2.dispose();
  assert.doesNotThrow(() => { vp2.resize(); vp2.render(); });

  // Verify WebGL2 empty/NaN/dispose + shader parity
  const gl = createStrictMockWebGL2Context();
  const canvasGl = {
    width: 640,
    height: 480,
    getContext: (t) => (t === 'webgl2' ? gl : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    addEventListener() {},
  };
  const vpGl = createViewport3D(canvasGl);
  assert.equal(vpGl.mode, 'webgl2');
  assert.equal(Object.keys(vpGl._progs).length, 5, 'must compile all 5 GLSL 300 es programs');

  // Assert every program's source starts with #version 300 es and exposes expected attribs/uniforms
  for (const [name, prog] of Object.entries(vpGl._progs)) {
    assert.ok(prog.vs.source.startsWith('#version 300 es'), `${name} VS missing #version 300 es`);
    assert.ok(prog.fs.source.startsWith('#version 300 es'), `${name} FS missing #version 300 es`);
    assert.ok(prog.attribs.size >= 1, `${name} VS must declare >=1 vertex attribute`);
    assert.ok(prog.uniforms.size >= 1, `${name} program must declare >=1 uniform`);
  }

  vpGl.setScene({ sim: null, stlMesh: null, avatar: null });
  assert.doesNotThrow(() => vpGl.render());

  const tshirt = core.generateTemplatePattern('tshirt');
  const sim = new core.ClothSimulation(tshirt, { maxEdgeLengthMm: 60 });
  sim.particles[0].pos.x = NaN;
  vpGl.setScene({ sim, stlMesh: null, avatar: null });
  assert.doesNotThrow(() => { vpGl.fitToScene(); vpGl.render(); });
  assert.ok(Number.isFinite(vpGl.cam.target.x) && Number.isFinite(vpGl.cam.target.y) && Number.isFinite(vpGl.cam.target.z));

  vpGl.dispose();
  assert.doesNotThrow(() => { vpGl.resize(); vpGl.render(); });
});

test('T5-FE-03: app.mjs export 400 error propagation (B-02), vertex delete guard (B-03), stlScale/material undo sync (B-07), unit bounds (B-08), XSS escape', async () => {
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const attrMap = new Map();
  for (const m of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = m[0];
    const id = m[1];
    const getA = (k) => tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] || '';
    attrMap.set(id, { min: getA('min'), max: getA('max'), step: getA('step'), value: getA('value') });
  }

  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c);
        else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };

  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    const initAttrs = attrMap.get(id);
    if (initAttrs) {
      if (initAttrs.min) attrs.set('min', initAttrs.min);
      if (initAttrs.max) attrs.set('max', initAttrs.max);
      if (initAttrs.step) attrs.set('step', initAttrs.step);
    }
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: initAttrs?.value || '',
      min: initAttrs?.min || '',
      max: initAttrs?.max || '',
      step: initAttrs?.step || '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };

  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };

  const createdAnchors = [];
  const appMod = await import(`../public/app.mjs?t5fe03=${Date.now()}`);

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => {
        const el = makeEl(tag, '');
        if (String(tag).toLowerCase() === 'a') createdAnchors.push(el);
        return el;
      },
      querySelectorAll: () => [],
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url) => {
      if (String(url) === '/api/workspace-stls') {
        return {
          ok: true,
          async json() {
            return { files: [{ name: '<img src=x onerror=alert(1)>.stl', sizeBytes: 128 }] };
          },
        };
      }
      if (String(url) === '/api/export') {
        return {
          ok: false,
          status: 400,
          async json() { return { error: 'EXPLICIT_EXPORT_400_ERR' }; },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };

    await appMod.initStudio();
    await new Promise((r) => setTimeout(r, 20));
    const st = appMod.state;

    // 1) XSS check: workspace-stls option uses textContent and leaves innerHTML empty
    const wsOpts = elements.get('workspaceStlSelect').options;
    const xssOpt = wsOpts.find((o) => String(o.value).includes('<img'));
    assert.ok(xssOpt, 'workspace-stls should populate hostile filename option');
    assert.equal(xssOpt.textContent.includes('<img'), true);
    assert.equal(xssOpt.innerHTML, '');

    // 2) B-02: /api/export 400 surfaces EXPLICIT_EXPORT_400_ERR without offline fallback download or misleading PDF message
    createdAnchors.length = 0;
    elements.get('btnExportPDF').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get('studioToast').textContent.includes('EXPLICIT_EXPORT_400_ERR'));
    assert.doesNotMatch(elements.get('studioToast').textContent, /Tiled PDF export requires server/);
    assert.equal(createdAnchors.length, 0);

    elements.get('studioToast').textContent = '';
    elements.get('btnExportSVG').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get('studioToast').textContent.includes('EXPLICIT_EXPORT_400_ERR'));
    assert.doesNotMatch(elements.get('studioToast').textContent, /client fallback/);
    assert.equal(createdAnchors.length, 0);

    // 3) B-03: Delete vertex with selectedVertexIndex === -1 leaves vertex count intact
    st.selectedPieceId = st.pattern.pieces[0].id;
    st.selectedVertexIndex = -1;
    const beforeVerts = st.pattern.pieces[0].points.length;
    elements.get('btnDeleteSelectedVertex').click();
    assert.equal(st.pattern.pieces[0].points.length, beforeVerts);
    assert.match(elements.get('studioToast').textContent, /Select a vertex/i);

    // 4) B-07: stlScaleInput syncs on Undo & matStretchInput updates live sim constraints
    const boxBuf = Buffer.from(core.createBoxSTL(60, 60, 40), 'utf8');
    elements.get('stlFileInput').files = [{
      name: 'scale_undo.stl',
      async arrayBuffer() { return boxBuf.buffer.slice(boxBuf.byteOffset, boxBuf.byteOffset + boxBuf.byteLength); },
    }];
    elements.get('stlFileInput').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(elements.get('stlScaleInput').value, '1');
    elements.get('pieceNameInput').value = 'Edited';
    elements.get('pieceNameInput').dispatchEvent({ type: 'change' });
    elements.get('stlScaleInput').value = '1.5'; // simulate stale DOM edit before Undo
    elements.get('btnUndo').click();
    assert.equal(elements.get('stlScaleInput').value, '1');

    const prevStructAlpha = st.sim.structuralConstraints[0].alpha;
    const warpInp = elements.get('matSlider_warpStiffness');
    assert.ok(warpInp, 'matSlider_warpStiffness slider must exist');
    warpInp.value = '0.25';
    warpInp.dispatchEvent({ type: 'input' });
    assert.notEqual(st.sim.structuralConstraints[0].alpha, prevStructAlpha);

    // 5) B-08: Switching unitSelect to 'in' updates min/max/step on unit-scaled inputs & resets invalid pieceQuantityInput
    elements.get('unitSelect').value = 'in';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    const nestWMin = Number(elements.get('nestCustomWidthInput').min);
    const nestWVal = Number(elements.get('nestCustomWidthInput').value);
    const rectWMin = Number(elements.get('rectWidthInput').min);
    const rectWVal = Number(elements.get('rectWidthInput').value);
    assert.ok(nestWMin > 0 && nestWMin <= nestWVal, `nestCustomWidth min (${nestWMin}) must <= value (${nestWVal}) in inches`);
    assert.ok(rectWMin > 0 && rectWMin <= rectWVal, `rectWidth min (${rectWMin}) must <= value (${rectWVal}) in inches`);

    elements.get('pieceQuantityInput').value = '0';
    elements.get('pieceQuantityInput').dispatchEvent({ type: 'change' });
    assert.equal(Number(elements.get('pieceQuantityInput').value) >= 1, true);
    elements.get('pieceQuantityInput').value = '1.5';
    elements.get('pieceQuantityInput').dispatchEvent({ type: 'change' });
    assert.equal(Number.isInteger(Number(elements.get('pieceQuantityInput').value)), true);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});
// ============================================================================
// 5. Iteration 2 Tier-5 Hardening Regressions (Findings 1-6, B2-01..B2-07)
// ============================================================================

test('adv_i2_core_hardening_regressions: physics updateMaterial, grainLock, mirror/delete guards, quantity parity, empty facet normal', () => {
  // Finding 1a: updateMaterial lazily activates shear & bending constraints when starting from 0
  const rect = core.createRectanglePiece('SimRect', 200, 200, { seamAllowance: 0 });
  const sim = new core.ClothSimulation({ pieces: [rect], seams: [] }, {
    avatar: null,
    particleSpacingMm: 40,
    materialId: 'cotton_jersey',
    materialOverrides: { shearStiffness: 0, bendStiffness: 0, stretchStiffness: 0.5, gsm: 120, damping: 0.42 },
  });
  assert.equal(sim.shearConstraints.length, 0);
  assert.equal(sim.bendingConstraints.length, 0);
  sim.updateMaterial({ shearStiffness: 0.9, bendStiffness: 0.9, stretchStiffness: 0.9 });
  assert.ok(sim.shearConstraints.length > 0, 'shearConstraints must be lazily built on 0->0.9 update');
  assert.ok(sim.bendingConstraints.length > 0, 'bendingConstraints must be lazily built on 0->0.9 update');
  assert.ok(sim.shearConstraints[0].alpha > 0 && Number.isFinite(sim.shearConstraints[0].alpha));
  assert.ok(sim.bendingConstraints[0].alpha > 0 && Number.isFinite(sim.bendingConstraints[0].alpha));
  const repAfter = sim.step(3);
  assert.equal(sim.particles.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)), true);
  assert.ok(Number.isFinite(repAfter.meanStrainPct));

  // Finding 1b: partial updateMaterial preserves prior overrides; preset change resets defaults
  const sim2 = new core.ClothSimulation({ pieces: [rect], seams: [] }, {
    avatar: null,
    particleSpacingMm: 50,
    materialId: 'cotton_jersey',
    materialOverrides: { gsm: 120, damping: 0.42, warpStiffness: 0.15, weftStiffness: 0.25 },
  });
  sim2.updateMaterial({ gsm: 400 });
  assert.equal(sim2.material.gsm, 400);
  assert.equal(sim2.material.damping, 0.42);
  assert.equal(sim2.material.warpStiffness, 0.15);
  assert.equal(sim2.material.weftStiffness, 0.25);
  sim2.updateMaterial({ id: 'heavy_denim' });
  assert.equal(sim2.material.id, 'heavy_denim');
  assert.notEqual(sim2.material.damping, 0.42);

  // Finding 2: grainLock normalization & preservation across types.mjs + templates.mjs + nesting
  const wideLocked = core.createRectanglePiece('Wide', 1800, 50, { grainLock: true, seamAllowance: 0 });
  assert.equal(wideLocked.grainLock, true);
  assert.equal(core.createRectanglePiece('RF', 100, 100, { grainLock: 'false' }).grainLock, false);
  assert.equal(core.createRectanglePiece('RZ', 100, 100, { grainLock: '0' }).grainLock, false);
  assert.equal(
    core.createFreeformPiece('FF', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], { grainLock: 'false' }).grainLock,
    false
  );
  const cpPiece = core.createPatternPiece({
    id: 'cp1',
    name: 'CP1',
    points: wideLocked.points,
    edges: wideLocked.edges,
    grainLock: true,
    seamAllowance: 0,
  });
  assert.equal(cpPiece.grainLock, true);
  const normProj = core.normalizePatternProject({ pieces: [wideLocked] });
  assert.equal(normProj.pieces[0].grainLock, true);
  const nestRes = core.nestPatternPieces(normProj, { rollWidthMm: 1500, allowRotate90: true });
  assert.equal(nestRes.unfittedPieces.length, 1);
  assert.equal(nestRes.placements.length, 0);

  // Finding 3: mirrorPieceAcrossEdge curved axis crossing + interior pinch; deletePieceVertex bowtie
  const curvedCross = core.createRectanglePiece('MC', 100, 100);
  curvedCross.edges[1] = { name: 'BulgeLeft', curve: { type: 'quadratic', cp: { x: -120, y: 50 } }, seamAllowance: 10 };
  assert.throws(() => core.mirrorPieceAcrossEdge(curvedCross, 3), core.ValidationError);

  const pinched = {
    id: 'pinched',
    name: 'Pinched',
    points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }],
    edges: Array.from({ length: 5 }, () => ({ seamAllowance: 10 })),
    seamAllowance: 10,
  };
  assert.throws(() => core.mirrorPieceAcrossEdge(pinched, 4), core.ValidationError);

  const simple5 = {
    id: 'simple5',
    name: 'Simple5',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 40, y: 20 }, { x: 0, y: 100 }],
    edges: Array.from({ length: 5 }, () => ({ seamAllowance: 10 })),
    seamAllowance: 10,
  };
  assert.throws(() => core.deletePieceVertex(simple5, 1), core.ValidationError);
  assert.equal(simple5.points.length, 5, 'failed deletePieceVertex must leave piece unchanged');

  // Finding 4: deletePieceVertex short edges padded/normalized before splice
  const shortEdges5 = {
    id: 'se5',
    name: 'SE5',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    edges: [{ seamAllowance: 15 }, { curve: { cx: 120, cy: 25 } }, { curve: { cx: 120, cy: 75 } }],
    seamAllowance: 10,
  };
  core.deletePieceVertex(shortEdges5, 2);
  assert.equal(shortEdges5.points.length, 4);
  assert.equal(shortEdges5.edges.length, 4);
  assert.equal(core.validatePatternPiece(shortEdges5).valid, true);

  // Finding 5: strict quantity parity across types/nesting/exporters
  for (const badQty of ['2', '', true, null, 0, -1, 1.5, {}]) {
    const qPiece = { ...core.createRectanglePiece('QBad', 50, 50), quantity: badQty };
    const qPat = { id: 'qp', name: 'QP', unit: 'mm', pieces: [qPiece], seams: [] };
    assert.throws(() => core.validatePatternPiece(qPiece), core.ValidationError);
    assert.throws(() => core.nestPatternPieces(qPat, { fabricWidthMm: 500 }), core.ValidationError);
    assert.throws(() => core.exportSVG(qPat), core.ValidationError);
    assert.throws(() => core.exportDXF(qPat), core.ValidationError);
    assert.throws(() => core.exportTiledPDF(qPat), core.ValidationError);
  }

  // Finding 6: truncated "facet normal" with 0 coords rejected as INVALID_STL
  assert.throws(
    () => core.parseSTL('solid t\nfacet normal\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n', 'trunc.stl'),
    (e) => e instanceof core.ValidationError && e.code === 'INVALID_STL'
  );
});

test('T5-I2-01: server B2-01..03, CLI B2-04, and frontend B2-05..07 regressions', async () => {
  // ---- Server B2-01..B2-03 ----
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const sqPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const validPiece = { id: 'front', name: 'Front', points: sqPts, seamAllowance: 10 };
  const validPattern = { name: 'ValidPat', unit: 'mm', pieces: [validPiece], seams: [] };

  try {
    // B2-01: hadSanitizedPieceId bypass removed; bogus seams still rejected 400 when another piece has id:"" or id:123
    for (const badId of ['', 123]) {
      const bypassAttempt = {
        name: 'Bypass',
        unit: 'mm',
        pieces: [{ id: badId, points: sqPts }, validPiece],
        seams: [{ pieceA: 'nonexistent_piece', edgeA: 999, pieceB: 'also_missing', edgeB: -5 }],
      };
      const simRes = await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: bypassAttempt, steps: 1 }),
      });
      assert.equal(simRes.status, 400, `Expected 400 for bogus seam with piece id=${JSON.stringify(badId)}`);

      const expRes = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'svg', pattern: bypassAttempt }),
      });
      assert.equal(expRes.status, 400, `Expected 400 on /api/export for bogus seam with piece id=${JSON.stringify(badId)}`);
    }

    // Valid sanitized piece IDs resolve cleanly in seams
    const sanitizedValid = {
      name: 'SanitizedValid',
      unit: 'mm',
      pieces: [
        { id: 'front bodice', points: sqPts, seamAllowance: 10 },
        { id: 'back bodice', points: sqPts, seamAllowance: 10 },
      ],
      seams: [{ pieceA: 'front bodice', edgeA: 1, pieceB: 'back bodice', edgeB: 3 }],
    };
    const simSanOk = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: sanitizedValid, steps: 2 }),
    });
    assert.equal(simSanOk.status, 200);

    // B2-02: empty materialId / material, empty pieces on export/nest, invalid option enums, steps > 600
    assert.equal((await fetch(`${baseUrl}/api/generate-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'tshirt', materialId: '', params: {} }),
    })).status, 400);

    assert.equal((await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: validPattern, material: '', steps: 1 }),
    })).status, 400);

    assert.equal((await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: validPattern, steps: 999999999 }),
    })).status, 400);

    assert.equal((await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'svg', pattern: { pieces: [], seams: [] } }),
    })).status, 400);

    assert.equal((await fetch(`${baseUrl}/api/nest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: { pieces: [], seams: [] } }),
    })).status, 400);

    for (const badOpts of [
      { orientation: 'upside_down' },
      { layout: 'free_chaos' },
      { rollPreset: 'nonexistent_roll' },
      { rollPreset: '' },
      { unit: 'furlong' },
    ]) {
      const rOpt = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'pdf', pattern: validPattern, options: badOpts }),
      });
      assert.equal(rOpt.status, 400, `Expected 400 for options=${JSON.stringify(badOpts)}`);
    }

    // B2-03: Static/core 405 includes Allow and OPTIONS returns 204 + Allow
    const postStatic = await fetch(`${baseUrl}/index.html`, { method: 'POST' });
    assert.equal(postStatic.status, 405);
    assert.equal(postStatic.headers.get('allow'), 'GET, HEAD, OPTIONS');

    const optStatic = await fetch(`${baseUrl}/index.html`, { method: 'OPTIONS' });
    assert.equal(optStatic.status, 204);
    assert.equal(optStatic.headers.get('allow'), 'GET, HEAD, OPTIONS');

    const optCore = await fetch(`${baseUrl}/src/core/types.mjs`, { method: 'OPTIONS' });
    assert.equal(optCore.status, 204);
    assert.equal(optCore.headers.get('allow'), 'GET, HEAD, OPTIONS');

    const optMissing = await fetch(`${baseUrl}/does_not_exist_12345.html`, { method: 'OPTIONS' });
    assert.equal(optMissing.status, 404);
  } finally {
    await closeStudioServer(srv);
  }

  // ---- CLI B2-04 ----
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psv2-i2-cli-'));
  try {
    const validStl = path.join(tmpDir, 'box.stl');
    await fsp.writeFile(validStl, core.createBoxSTL(40, 40, 20), 'utf8');
    const outDir = path.join(tmpDir, 'out');
    const badCliCases = [
      ['template', '--type', 'tshirt', '--material', 'bogus_mat', '--out', outDir],
      ['template', '--type', 'tshirt', '--material=', '--out', outDir],
      ['template', '--type', 'tshirt', '--sa', '-10', '--out', outDir],
      ['template', '--type', 'tshirt', '--ease', '-5', '--out', outDir],
      ['template', '--type', 'tshirt', '--scale', '0', '--out', outDir],
      ['unwrap', '--stl', validStl, '--material', 'nonexistent_mat', '--out', outDir],
      ['unwrap', '--stl', validStl, '--sa', '-10', '--out', outDir],
      ['unwrap', '--stl', validStl, '--thickness', '-5', '--out', outDir],
      ['unwrap', '--stl', validStl, '--scale', '-1', '--out', outDir],
      ['unwrap', '--stl', validStl, '--scale', '0', '--out', outDir],
      ['unwrap', '--stl', validStl, '--ease', '-20', '--out', outDir],
      ['verify-sim', '--template', 'tshirt', '--material', 'bogus_mat', '--steps', '2'],
      ['list', 'unexpected_extra_arg'],
    ];
    for (const argv of badCliCases) {
      const res = await runCliProcess(argv);
      assert.equal(res.code, 1, `Expected CLI exit 1 for ${JSON.stringify(argv)}, got ${res.code}: ${res.stdout}`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // ---- Frontend B2-05..B2-07 ----
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const attrMap = new Map();
  for (const m of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = m[0];
    const id = m[1];
    const getA = (k) => tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] || '';
    attrMap.set(id, { min: getA('min'), max: getA('max'), step: getA('step'), value: getA('value') });
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    const initAttrs = attrMap.get(id);
    if (initAttrs) {
      if (initAttrs.min) attrs.set('min', initAttrs.min);
      if (initAttrs.max) attrs.set('max', initAttrs.max);
      if (initAttrs.step) attrs.set('step', initAttrs.step);
    }
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: initAttrs?.value || '',
      min: initAttrs?.min || '',
      max: initAttrs?.max || '',
      step: initAttrs?.step || '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: () => [],
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url) => {
      if (String(url) === '/api/workspace-stls') {
        return { ok: true, async json() { return { files: [] }; } };
      }
      throw new Error('ECONNREFUSED');
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t5i2=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I2-01: initStudio must populate state.pattern');
    const st = appMod.state;

    // B2-07: unitSelect 'mm' -> 'in' converts rectWidthInput/rectHeightInput/dartWidthInput/dartDepthInput .value
    elements.get('unitSelect').value = 'in';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assertNear(Number(elements.get('rectWidthInput').value), 240 / 25.4, 0.05, 'rectWidth in');
    assertNear(Number(elements.get('rectHeightInput').value), 180 / 25.4, 0.05, 'rectHeight in');
    assertNear(Number(elements.get('dartWidthInput').value), 22 / 25.4, 0.05, 'dartWidth in');
    assertNear(Number(elements.get('dartDepthInput').value), 80 / 25.4, 0.05, 'dartDepth in');
    assert.ok(Number(elements.get('rectWidthInput').value) <= Number(elements.get('rectWidthInput').max));
    elements.get('unitSelect').value = 'mm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assertNear(Number(elements.get('rectWidthInput').value), 240, 0.5, 'rectWidth back to mm');

    // B2-06a: edgeSaInput / edgeCurveSelect lazily initialize missing .edges
    const firstPiece = st.pattern.pieces[0];
    st.selectedPieceId = firstPiece.id;
    st.selectedEdgeIndex = 1;
    delete firstPiece.edges;
    elements.get('edgeSaInput').value = '15';
    elements.get('edgeSaInput').dispatchEvent({ type: 'change' });
    assert.ok(Array.isArray(firstPiece.edges));
    assert.equal(firstPiece.edges.length, firstPiece.points.length);
    assert.equal(firstPiece.edges[1].seamAllowance, 15);
    elements.get('edgeCurveSelect').value = 'quadratic';
    elements.get('edgeCurveSelect').dispatchEvent({ type: 'change' });
    assert.equal(firstPiece.edges[1].curve?.type, 'quadratic');

    // B2-06b: rapid btnDuplicatePiece produces strictly unique IDs
    const countBefore = st.pattern.pieces.length;
    elements.get('btnDuplicatePiece').click();
    elements.get('btnDuplicatePiece').click();
    assert.equal(st.pattern.pieces.length, countBefore + 2);
    const idSet = new Set(st.pattern.pieces.map((p) => p.id));
    assert.equal(idSet.size, st.pattern.pieces.length, 'rapid duplicates must have unique IDs');

    // B2-06c: nestMarginInput out-of-range resets DOM .value to clamped value
    elements.get('nestMarginInput').value = '-50';
    elements.get('nestMarginInput').dispatchEvent({ type: 'change' });
    assert.equal(st.nestingOptions.marginMm, 0);
    assert.equal(elements.get('nestMarginInput').value, '0');

    // B2-06d: cad2d.mjs clamps overlong piece.edges.length safely
    const overlongPiece = {
      ...core.createRectanglePiece('OverEdges', 100, 80),
      edges: Array.from({ length: 10 }, () => ({ seamAllowance: 10, curve: { type: 'quadratic', cp: { x: 50, y: -10 } } })),
    };
    assert.doesNotThrow(() => {
      appMod.cad2D.render({ pattern: { unit: 'mm', pieces: [overlongPiece], seams: [] }, selectedPieceId: overlongPiece.id });
    });

    // B2-05: offline export fallback throwing ValidationError shows toast instead of unhandled rejection
    const origQty = st.pattern.pieces[0].quantity;
    st.pattern.pieces[0].quantity = 0;
    elements.get('studioToast').textContent = '';
    elements.get('btnExportSVG').click();
    await waitUntil(() => elements.get('studioToast').textContent.length > 0);
    assert.match(elements.get('studioToast').textContent, /quantity/i);
    assert.equal(elements.get('studioToast').classList.contains('toast-error'), true);
    st.pattern.pieces[0].quantity = origQty;
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});
// ============================================================================
// 6. Iteration 3 Tier-5 Hardening Regressions (B3-01..B3-04 & Minor Caveats)
// ============================================================================

test('T5-I3-01: B3-01..B3-04 & Reviewer Caveats 2-4 regressions across server, CLI, and app.mjs', async () => {
  // ---- Server B3-03 & Caveat 2 ----
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const sqPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const validPiece = { id: 'front', name: 'Front', points: sqPts, seamAllowance: 10 };
  const validPattern = { name: 'ValidI3', unit: 'mm', pieces: [validPiece], seams: [] };

  try {
    // 1) Empty / partial seam objects rejected 400 on /api/simulate and /api/export
    for (const badSeams of [[{}], [{ pieceA: 'front', edgeA: 0 }], [{ pieceA: '', pieceB: 'front' }], [{ pieceA: 'front', pieceB: '   ' }]]) {
      const pat = { ...validPattern, seams: badSeams };
      const simRes = await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: pat, steps: 1 }),
      });
      assert.equal(simRes.status, 400, `Expected 400 on /api/simulate for seams=${JSON.stringify(badSeams)}`);

      const expRes = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'svg', pattern: pat }),
      });
      assert.equal(expRes.status, 400, `Expected 400 on /api/export for seams=${JSON.stringify(badSeams)}`);
    }

    // 2) /api/simulate rejects invalid pattern.unit and pattern.materialId with 400
    const badUnitSim = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: { ...validPattern, unit: 'furlong' }, steps: 1 }),
    });
    assert.equal(badUnitSim.status, 400);

    const badMatSim = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: { ...validPattern, materialId: 'bogus_mat' }, steps: 1 }),
    });
    assert.equal(badMatSim.status, 400);

    const emptyMatSim = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: { ...validPattern, materialId: '' }, steps: 1 }),
    });
    assert.equal(emptyMatSim.status, 400);

    // 3) piece.quantity empty/whitespace/null/non-integer/non-numeric rejected 400 on /api/export & /api/simulate
    for (const badQty of ['', '   ', 'abc', null, 0, -2, 1.5]) {
      const qPat = { ...validPattern, pieces: [{ ...validPiece, quantity: badQty }] };
      const expQty = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'svg', pattern: qPat }),
      });
      assert.equal(expQty.status, 400, `Expected 400 on /api/export for quantity=${JSON.stringify(badQty)}`);
    }

    // 4) Caveat 2: rollPreset substring matching removed ('a', 'mm' -> 400; canonical presets & cricut_24x12 -> 200)
    for (const badPreset of ['a', 'mm', '45']) {
      const nestSub = await fetch(`${baseUrl}/api/nest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: validPattern, options: { rollPreset: badPreset } }),
      });
      assert.equal(nestSub.status, 400, `Expected 400 for substring rollPreset=${JSON.stringify(badPreset)}`);
    }
    for (const okPreset of ['roll_45in', 'cricut_24x12', '45" Standard Apparel Roll (1143 mm)']) {
      const nestOk = await fetch(`${baseUrl}/api/nest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: validPattern, options: { rollPreset: okPreset } }),
      });
      assert.equal(nestOk.status, 200, `Expected 200 for valid rollPreset=${JSON.stringify(okPreset)}`);
    }
  } finally {
    await closeStudioServer(srv);
  }

  // ---- CLI B3-04 ----
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psv2-i3-cli-'));
  try {
    const outDir = path.join(tmpDir, 'out');
    const badCliCases = [
      ['verify-sim', '--template', 'tshirt', '--steps', '601'],
      ['verify-sim', '--template', 'tshirt', '--steps', '0'],
      ['template', '--type', 'tshirt', '--thickness', '-5', '--out', outDir],
      ['template', '--type', 'stl_cover', '--stl=', '--out', outDir],
      ['verify-sim', '--template', 'tshirt', '--stl='],
    ];
    for (const argv of badCliCases) {
      const res = await runCliProcess(argv);
      assert.equal(res.code, 1, `Expected CLI exit 1 for ${JSON.stringify(argv)}, got ${res.code}`);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // ---- Frontend B3-01, B3-02, Caveat 4 ----
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const attrMap = new Map();
  for (const m of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = m[0];
    const id = m[1];
    const getA = (k) => tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] || '';
    attrMap.set(id, { min: getA('min'), max: getA('max'), step: getA('step'), value: getA('value') });
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    const initAttrs = attrMap.get(id);
    if (initAttrs) {
      if (initAttrs.min) attrs.set('min', initAttrs.min);
      if (initAttrs.max) attrs.set('max', initAttrs.max);
      if (initAttrs.step) attrs.set('step', initAttrs.step);
    }
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: initAttrs?.value || '',
      min: initAttrs?.min || '',
      max: initAttrs?.max || '',
      step: initAttrs?.step || '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      checkValidity() {
        const val = Number(this.value);
        if (!Number.isFinite(val)) return false;
        if (this.min !== '' && val < Number(this.min)) return false;
        if (this.max !== '' && val > Number(this.max)) return false;
        if (this.step !== '' && this.step !== 'any') {
          const stepNum = Number(this.step);
          const base = this.min !== '' ? Number(this.min) : 0;
          const rem = Math.abs((val - base) / stepNum);
          if (Math.abs(rem - Math.round(rem)) > 1e-6) return false;
        }
        return true;
      },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const unwrapBodies = [];
  const toolBtns = [];
  for (const toolName of ['select', 'add_rect']) {
    const b = makeEl('button', '');
    b.dataset.tool = toolName;
    toolBtns.push(b);
  }

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl === '/api/workspace-stls') {
        return { ok: true, async json() { return { files: ['demo.stl'] }; } };
      }
      if (sUrl.startsWith('/api/stl-content')) {
        return {
          ok: true,
          async arrayBuffer() {
            const b = Buffer.from(core.createBoxSTL(40, 40, 20), 'utf8');
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        };
      }
      if (sUrl === '/api/unwrap-stl') {
        unwrapBodies.push(JSON.parse(init.body));
        throw new Error('offline');
      }
      throw new Error('ECONNREFUSED');
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t5i3=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I3-01: initStudio must populate state.pattern');
    const st = appMod.state;

    // B3-01: exact mm boundary values remain valid after switching mm -> in
    elements.get('avChestInput').value = '600';
    elements.get('avChestInput').dispatchEvent({ type: 'change' });
    elements.get('avWaistInput').value = '1500';
    elements.get('avWaistInput').dispatchEvent({ type: 'change' });
    elements.get('rectWidthInput').value = '10';
    elements.get('dartDepthInput').value = '10';

    elements.get('unitSelect').value = 'in';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    for (const id of ['avChestInput', 'avWaistInput', 'rectWidthInput', 'dartDepthInput']) {
      const inp = elements.get(id);
      assert.equal(
        inp.checkValidity(),
        true,
        `B3-01: ${id} invalid in 'in' (value=${inp.value}, min=${inp.min}, max=${inp.max}, step=${inp.step})`
      );
    }

    // Caveat 4: add_rect tool sets ._unit = state.unit so subsequent unit switch converts accurately
    toolBtns[1].click(); // add_rect while in 'in'
    assert.equal(elements.get('rectWidthInput')._unit, 'in');
    elements.get('unitSelect').value = 'mm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assertNear(Number(elements.get('rectWidthInput').value), 240, 1.0, 'add_rect _unit in->mm');

    // B3-02a: avChestInput out-of-range / empty syncs clamped/restored value back to DOM
    elements.get('avChestInput').value = '-999';
    elements.get('avChestInput').dispatchEvent({ type: 'change' });
    assert.equal(st.avatarMeasurements.chestMm, 600);
    assert.equal(elements.get('avChestInput').value, '600');
    elements.get('avChestInput').value = '';
    elements.get('avChestInput').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('avChestInput').value, '600');

    // B3-02b: empty / non-positive stlScaleInput resets DOM .value to '1' and sends scale: 1
    elements.get('stlScaleInput').value = '';
    elements.get('stlScaleInput').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('stlScaleInput').value, '1');
    elements.get('stlScaleInput').value = '0';
    elements.get('workspaceStlSelect').value = 'demo.stl';
    elements.get('btnLoadWorkspaceStl').click();
    await waitUntil(() => unwrapBodies.length > 0);
    assert.equal(elements.get('stlScaleInput').value, '1');
    assert.equal(unwrapBodies.at(-1)?.scale, 1);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});
test('adv_i4_core_hardening_regressions: CW dart inward normal, ClothSimulation unit->mm, rollPreset exact match, 0-tri solid STL', () => {
  // GAP-I4-01: Unfolded dart on CW-wound piece must orient inward normal into piece interior (not outside)
  const cwPiece = {
    id: 'cw_panel',
    name: 'CW Panel',
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 240 },
      { x: 240, y: 240 },
      { x: 240, y: 0 },
    ],
    edges: [{}, {}, {}, {}],
    darts: [{ id: 'd_cw', edgeIndex: 0, t: 0.5, widthMm: 30, depthMm: 80, folded: false }],
    placement3D: { offset: { x: 0, y: 120, z: 120 }, normal: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  };
  const cwSim = new core.ClothSimulation({ pieces: [cwPiece], seams: [] }, { avatar: null, maxEdgeLengthMm: 25 });
  assert.equal(cwSim.dartConstraints.length, 4, 'CW unfolded dart must build 4 dart-closing constraints');
  // All dart constraint particles should be genuinely distinct and spaced along the dart depth inward (x > 5)
  const xs = cwSim.dartConstraints.flatMap((c) => [cwSim.particles[c.a].rest2D.x, cwSim.particles[c.b].rest2D.x]);
  assert.ok(Math.max(...xs) > 35, `Expected CW dart constraints to extend inward toward x=80, got max rest2D.x=${Math.max(...xs)}`);
  const cwRes = cwSim.step(20);
  assert.ok(Number.isFinite(cwRes.meanStrainPct) && Number.isFinite(cwRes.maxStrainPct));

  // GAP-I4-02: ClothSimulation and runSimulationSteps normalize 'in'/'cm' patterns to canonical 'mm'
  const inchSquare = {
    unit: 'in',
    pieces: [
      {
        id: 'front_in',
        name: 'Front In',
        points: [
          { x: 0, y: 0 },
          { x: 16, y: 0 },
          { x: 16, y: 20 },
          { x: 0, y: 20 },
        ],
        edges: [{}, {}, {}, {}],
      },
    ],
    seams: [],
  };
  const mmSquare = {
    unit: 'mm',
    pieces: [
      {
        id: 'front_mm',
        name: 'Front MM',
        points: [
          { x: 0, y: 0 },
          { x: 16 * 25.4, y: 0 },
          { x: 16 * 25.4, y: 20 * 25.4 },
          { x: 0, y: 20 * 25.4 },
        ],
        edges: [{}, {}, {}, {}],
      },
    ],
    seams: [],
  };
  const simIn = core.runSimulationSteps(inchSquare, { steps: 5, avatar: null });
  const simMm = core.runSimulationSteps(mmSquare, { steps: 5, avatar: null });
  assert.equal(simIn.particles.length, simMm.particles.length, 'Inch pattern should normalize to identical mm mesh density');
  const maxXIn = Math.max(...simIn.particles.map((p) => p.rest2D.x));
  assertNear(maxXIn, 406.4, 0.5, '16 in piece should normalize to 406.4 mm in ClothSimulation');
  assert.throws(
    () => new core.ClothSimulation({ unit: 'ft', pieces: inchSquare.pieces, seams: [] }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_UNIT'
  );
  assert.throws(
    () => new core.ClothSimulation({ unit: { toString: 'nope' }, pieces: inchSquare.pieces, seams: [] }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_UNIT'
  );

  // GAP-I4-03: nesting.mjs resolveRollSpec rejects substring matches and resolves cricut_24x12 cleanly
  const rectPat = {
    unit: 'mm',
    pieces: [core.createRectanglePiece('Panel', 200, 150)],
    seams: [],
  };
  const nestSub = core.nestPatternPieces(rectPat, { rollPreset: '45' });
  assert.equal(nestSub.fabricWidthMm, 1371.6, 'Substring rollPreset "45" must not match roll_45in');
  const nestCricut = core.nestPatternPieces(rectPat, { rollPreset: 'cricut_24x12' });
  assert.equal(nestCricut.fabricWidthMm, 609.6);
  assert.equal(nestCricut.sheets[0].lengthMm, 304.8);

  // GAP-I4-04: 84-byte binary STL with triCount === 0 and "solid...facet...vertex" in header throws EMPTY_STL
  const buf84 = new Uint8Array(84);
  const hdrBytes = Buffer.from('solid fake facet normal 0 0 1 outer loop vertex 0 0 0', 'ascii');
  buf84.set(hdrBytes.subarray(0, 80), 0);
  new DataView(buf84.buffer).setUint32(80, 0, true);
  assert.throws(
    () => core.parseSTL(buf84, 'empty_hdr.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'EMPTY_STL'
  );
});

test('T5-I4-01: B4-01..10 server cricut_24x12/seams/unit/material/params/options, CLI bounds/stl & app.mjs race/stepMismatch/restore', async () => {
  const srv = await startServer({ port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    const validPattern = core.generateTemplatePattern('tshirt');
    const postJson = async (ep, payload) =>
      fetch(`${baseUrl}${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // B4-01: cricut_24x12 preset uses 304.8 x 609.6 mm (never silently falls back to 1371.6 mm)
    const presetsRes = await fetch(`${baseUrl}/api/catalog`);
    assert.equal(presetsRes.status, 200);
    const presetsBody = await presetsRes.json();
    const cricutPreset = presetsBody.rolls.find((r) => r.id === 'cricut_24x12');
    assert.ok(cricutPreset, 'GET /api/catalog must list cricut_24x12');
    assert.equal(cricutPreset.widthMm, 609.6);
    assert.equal(cricutPreset.lengthMm, 304.8);

    const rect280 = {
      unit: 'mm',
      pieces: [core.createRectanglePiece('Wide', 280, 120)],
      seams: [],
    };
    const nestCricutRes = await postJson('/api/nest', {
      pattern: rect280,
      options: { rollPreset: 'cricut_24x12' },
    });
    assert.equal(nestCricutRes.status, 200);
    const nestCricutBody = await nestCricutRes.json();
    assert.equal(nestCricutBody.nesting.fabricWidthMm, 609.6);
    assert.equal(nestCricutBody.nesting.sheets[0].lengthMm, 304.8);

    // B4-02: seam validation on /api/nest, /api/simulate, /api/export
    const baseTwoPiece = {
      unit: 'mm',
      pieces: [
        { ...core.createRectanglePiece('A', 120, 120), id: 'p1' },
        { ...core.createRectanglePiece('B', 120, 120), id: 'p2' },
      ],
    };
    const badSeams = [
      [{ id: 's1', pieceA: 'missing', edgeA: 0, pieceB: 'p2', edgeB: 0 }],
      [{ id: 's1', pieceA: 'p1', edgeA: 99, pieceB: 'p2', edgeB: 0 }],
      [{ id: 's1', pieceA: 'p1', pieceB: 'p2', edgeB: 0 }], // omitted edgeA
      [{ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p2', edgeB: '' }], // empty string edgeB
      [{ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p2', edgeB: 0, tStartA: 0.8, tEndA: 0.2 }], // inverted t
      [{ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p1', edgeB: 0 }], // self-identical edge
      [{ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p2', internalLineIdB: '' }], // empty internalLineIdB
    ];
    for (const seams of badSeams) {
      const badSeamPat = { ...baseTwoPiece, seams };
      for (const [ep, extra] of [
        ['/api/nest', {}],
        ['/api/simulate', { steps: 1 }],
        ['/api/export', { format: 'svg' }],
      ]) {
        const res = await postJson(ep, { pattern: badSeamPat, ...extra });
        assert.equal(res.status, 400, `B4-02: expected 400 on ${ep} for seams=${JSON.stringify(seams)}`);
      }
    }

    // Valid internalLineIdB seam without edgeB must remain 200
    const ilPat = {
      unit: 'mm',
      pieces: [
        { ...core.createRectanglePiece('Pocket', 80, 80), id: 'p1' },
        {
          ...core.createRectanglePiece('Body', 200, 200),
          id: 'p2',
          internalLines: [{ id: 'il1', type: 'stitch', points: [{ x: 40, y: 40 }, { x: 120, y: 40 }] }],
        },
      ],
      seams: [{ id: 's_il', pieceA: 'p1', edgeA: 0, pieceB: 'p2', internalLineIdB: 'il1', internalSegmentIndexB: 0 }],
    };
    assert.equal((await postJson('/api/nest', { pattern: ilPat })).status, 200);

    // B4-03: pattern.unit: null -> 400
    const nullUnitPat = { ...validPattern, unit: null };
    for (const [ep, extra] of [
      ['/api/nest', {}],
      ['/api/simulate', { steps: 1 }],
      ['/api/export', { format: 'svg' }],
    ]) {
      assert.equal((await postJson(ep, { pattern: nullUnitPat, ...extra })).status, 400, `B4-03 ${ep} unit:null`);
    }

    // B4-04: material / materialOverrides type & range checks
    for (const badSim of [
      { pattern: { ...validPattern, material: 123 }, steps: 1 },
      { pattern: { ...validPattern, material: { gsm: 'bad' } }, steps: 1 },
      { pattern: { ...validPattern, material: { gsm: -5 } }, steps: 1 },
      { pattern: validPattern, materialOverrides: 'bad', steps: 1 },
      { pattern: validPattern, materialOverrides: { thicknessMm: 999 }, steps: 1 },
      { pattern: validPattern, materialOverrides: { weaveType: 'bogus_weave' }, steps: 1 },
      { pattern: validPattern, material: { gsm: 99999 }, steps: 1 },
    ]) {
      assert.equal((await postJson('/api/simulate', badSim)).status, 400, `B4-04 sim: ${JSON.stringify(badSim.materialOverrides ?? badSim.material ?? badSim.pattern?.material)}`);
    }
    for (const badTplMat of [
      { templateId: 'tshirt', materialOverrides: 'bad' },
      { templateId: 'tshirt', materialOverrides: { gsm: -1 } },
      { templateId: 'tshirt', materialOverrides: { roughness: 5 } },
      { templateId: 'tshirt', materialOverrides: { weaveType: 'nope' } },
    ]) {
      assert.equal((await postJson('/api/generate-template', badTplMat)).status, 400);
    }

    // B4-05: empty templateId '' -> 400 & hoodDepthMm/frontRiseMm/backRiseMm/ankleWidthMm bounds -> 400
    assert.equal((await postJson('/api/generate-template', { templateId: '' })).status, 400);
    assert.equal((await postJson('/api/simulate', { templateId: '' })).status, 400);
    for (const [k, v] of [
      ['hoodDepthMm', -10],
      ['frontRiseMm', 999999],
      ['backRiseMm', 'bad'],
      ['ankleWidthMm', 0],
    ]) {
      assert.equal(
        (await postJson('/api/generate-template', { templateId: 'pants', params: { [k]: v } })).status,
        400,
        `B4-05: expected 400 for params.${k}=${JSON.stringify(v)}`
      );
    }

    // B4-06: non-object body.options & body.nestingOptions -> 400
    for (const badOpt of ['bad', [], 123, true]) {
      assert.equal((await postJson('/api/nest', { pattern: validPattern, options: badOpt })).status, 400);
      assert.equal((await postJson('/api/export', { pattern: validPattern, format: 'svg', options: badOpt })).status, 400);
      assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', nestingOptions: badOpt })).status, 400);
    }
  } finally {
    await closeStudioServer(srv);
  }

  // ---- B4-10: CLI upper bounds & --stl validation ----
  const tmpCliDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psv2-i4-cli-'));
  try {
    const outDir = path.join(tmpCliDir, 'out');
    const badCliCases = [
      ['template', '--type', 'tshirt', '--thickness', '5000', '--out', outDir],
      ['template', '--type', 'tshirt', '--sa', '5000', '--out', outDir],
      ['template', '--type', 'tshirt', '--ease', '10000', '--out', outDir],
      ['template', '--type', 'tshirt', '--scale', '200', '--out', outDir],
      ['template', '--type', 'tshirt', '--stl', path.join(tmpCliDir, 'missing.stl'), '--out', outDir],
    ];
    for (const argv of badCliCases) {
      const res = await runCliProcess(argv);
      assert.equal(res.code, 1, `B4-10: expected CLI exit 1 for ${JSON.stringify(argv)}, got ${res.code}`);
    }
  } finally {
    await fsp.rm(tmpCliDir, { recursive: true, force: true });
  }

  // ---- B4-07, B4-08, B4-09: Frontend race, stepMismatch & invalid input restore ----
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const attrMap = new Map();
  for (const m of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = m[0];
    const id = m[1];
    const getA = (k) => tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] || '';
    attrMap.set(id, { min: getA('min'), max: getA('max'), step: getA('step'), value: getA('value') });
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    const initAttrs = attrMap.get(id);
    if (initAttrs) {
      if (initAttrs.min) attrs.set('min', initAttrs.min);
      if (initAttrs.max) attrs.set('max', initAttrs.max);
      if (initAttrs.step) attrs.set('step', initAttrs.step);
    }
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: initAttrs?.value || '',
      min: initAttrs?.min || '',
      max: initAttrs?.max || '',
      step: initAttrs?.step || '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      checkValidity() {
        const val = Number(this.value);
        if (!Number.isFinite(val)) return false;
        if (this.min !== '' && val < Number(this.min)) return false;
        if (this.max !== '' && val > Number(this.max)) return false;
        if (this.step !== '' && this.step !== 'any') {
          const stepNum = Number(this.step);
          const base = this.min !== '' ? Number(this.min) : 0;
          const rem = Math.abs((val - base) / stepNum);
          if (Math.abs(rem - Math.round(rem)) > 1e-6) return false;
        }
        return true;
      },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  let releaseSlowStl = null;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url) => {
      const sUrl = String(url);
      if (sUrl === '/api/workspace-stls') {
        return { ok: true, async json() { return { files: ['slow.stl'] }; } };
      }
      if (sUrl.startsWith('/api/stl-content')) {
        await new Promise((resolve) => { releaseSlowStl = resolve; });
        return {
          ok: true,
          async arrayBuffer() {
            const b = Buffer.from(core.createBoxSTL(40, 40, 20), 'utf8');
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        };
      }
      throw new Error('offline');
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t5i4=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I4-01: initStudio must populate state.pattern');
    const st = appMod.state;

    // B4-08: nestCustomWidthInput (1371.6 mm / 137.16 cm) & avChestInput (985 mm) pass checkValidity across mm/cm/in
    elements.get('avChestInput').value = '985';
    elements.get('avChestInput').dispatchEvent({ type: 'change' });
    for (const u of ['mm', 'cm', 'in']) {
      elements.get('unitSelect').value = u;
      elements.get('unitSelect').dispatchEvent({ type: 'change' });
      assert.equal(
        elements.get('nestCustomWidthInput').checkValidity(),
        true,
        `B4-08: nestCustomWidthInput invalid in ${u} (val=${elements.get('nestCustomWidthInput').value}, min=${elements.get('nestCustomWidthInput').min}, step=${elements.get('nestCustomWidthInput').step})`
      );
      assert.equal(
        elements.get('avChestInput').checkValidity(),
        true,
        `B4-08: avChestInput invalid in ${u} (val=${elements.get('avChestInput').value}, min=${elements.get('avChestInput').min}, step=${elements.get('avChestInput').step})`
      );
    }
    elements.get('unitSelect').value = 'mm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });

    // B4-09: invalid inputs restore DOM .value on pieceRotationInput, pieceGrainInput, pieceSaInput, edgeSaInput
    const rotInp = elements.get('pieceRotationInput');
    const expectedRot = rotInp.value;
    rotInp.value = '';
    rotInp.dispatchEvent({ type: 'change' });
    assert.equal(rotInp.value, expectedRot, 'B4-09: empty pieceRotationInput should restore');
    rotInp.value = 'abc';
    rotInp.dispatchEvent({ type: 'change' });
    assert.equal(rotInp.value, expectedRot, 'B4-09: NaN pieceRotationInput should restore');

    const grainInp = elements.get('pieceGrainInput');
    const expectedGrain = grainInp.value;
    grainInp.value = '';
    grainInp.dispatchEvent({ type: 'change' });
    assert.equal(grainInp.value, expectedGrain, 'B4-09: empty pieceGrainInput should restore');

    const pieceSaInp = elements.get('pieceSaInput');
    const expectedPieceSa = pieceSaInp.value;
    pieceSaInp.value = 'nope';
    pieceSaInp.dispatchEvent({ type: 'change' });
    assert.equal(pieceSaInp.value, expectedPieceSa, 'B4-09: NaN pieceSaInput should restore');
    pieceSaInp.value = '';
    pieceSaInp.dispatchEvent({ type: 'change' });
    assert.equal(pieceSaInp.value, expectedPieceSa, 'B4-09: empty pieceSaInput should restore');

    const edgeSaInp = elements.get('edgeSaInput');
    const expectedEdgeSa = edgeSaInp.value;
    edgeSaInp.value = 'nope';
    edgeSaInp.dispatchEvent({ type: 'change' });
    assert.equal(edgeSaInp.value, expectedEdgeSa, 'B4-09: NaN edgeSaInput should restore');
    edgeSaInp.value = '';
    edgeSaInp.dispatchEvent({ type: 'change' });
    assert.equal(edgeSaInp.value, expectedEdgeSa, 'B4-09: empty edgeSaInput should restore');

    // B4-07: slow STL load must NOT overwrite subsequent loadTemplate('tshirt')
    const slowPromise = appMod.loadWorkspaceSTLFile('slow.stl');
    await new Promise((r) => setTimeout(r, 15));
    await appMod.loadTemplate('tshirt');
    assert.equal(st.templateId, 'tshirt');
    releaseSlowStl?.();
    await slowPromise;
    assert.equal(st.templateId, 'tshirt', 'B4-07: stale slow STL load must not overwrite templateId');
    assert.equal(st.activeStlSource, null, 'B4-07: stale slow STL load must not overwrite activeStlSource');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});
test('adv_i5_core_hardening_regressions: GAP-I5-01..04 + COV-I5-01 (all 21+ barrel vector helpers)', () => {
  // GAP-I5-01: parseBoolFlag for dart.folded, piece.onFold, seam.reversed, seam.allowEase
  const dartFalse = core.createDartSpec({ folded: 'false' });
  assert.equal(dartFalse.folded, false, 'GAP-I5-01: dart.folded "false" must normalize to false');
  const pieceFalse = core.createPatternPiece({
    name: 'Test',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    onFold: '0',
    darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 30, folded: 'off' }],
  });
  assert.equal(pieceFalse.onFold, false, 'GAP-I5-01: piece.onFold "0" must normalize to false');
  assert.equal(pieceFalse.darts[0].folded, false, 'GAP-I5-01: nested dart.folded "off" must normalize to false');
  const seamFalse = core.createSeam({ pieceA: 'a', edgeA: 0, pieceB: 'b', edgeB: 0, reversed: 'no', allowEase: 'false' });
  assert.equal(seamFalse.reversed, false, 'GAP-I5-01: seam.reversed "no" must normalize to false');
  assert.equal(seamFalse.allowEase, false, 'GAP-I5-01: seam.allowEase "false" must normalize to false');

  const normPat = core.normalizePatternProject({
    unit: 'mm',
    pieces: [
      {
        id: 'a',
        name: 'A',
        points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }],
        onFold: 'false',
        grainLock: 'false',
        darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 20, folded: '0' }],
      },
      {
        id: 'b',
        name: 'B',
        points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }],
        onFold: 'yes',
      },
    ],
    seams: [{ id: 's1', pieceA: 'a', edgeA: 0, pieceB: 'b', edgeB: 0, reversed: 'false', allowEase: 'off' }],
  });
  assert.equal(normPat.pieces[0].onFold, false);
  assert.equal(normPat.pieces[0].grainLock, false);
  assert.equal(normPat.pieces[0].darts[0].folded, false);
  assert.equal(normPat.pieces[1].onFold, true);
  assert.equal(normPat.seams[0].reversed, false);
  assert.equal(normPat.seams[0].allowEase, false);

  // GAP-I5-02: finiteOr in nesting.mjs & exporters.mjs rejects objects/arrays/booleans
  const tinyPat = {
    unit: 'mm',
    pieces: [core.createRectanglePiece('Box', 100, 80)],
    seams: [],
  };
  const nestArrWidth = core.nestPatternPieces(tinyPat, {
    rollPreset: 'custom',
    fabricWidthMm: [420],
    marginMm: null,
    gapMm: [33],
    allowRotate90: true,
  });
  assert.notEqual(nestArrWidth.fabricWidthMm, 420, 'GAP-I5-02: array fabricWidthMm must not coerce via Number([420])');
  assert.ok(nestArrWidth.fabricWidthMm > 420, 'GAP-I5-02: falls back to positive default width');

  const hostileToString = { toString() { throw new Error('hostile'); }, valueOf() { return 55; } };
  const svgObjGuard = core.exportSVG(tinyPat, {
    marginMm: [120],
    seamAllowanceMm: [25],
    sheetLengthMm: hostileToString,
  });
  assert.equal(typeof svgObjGuard, 'string');
  assert.ok(!svgObjGuard.includes('220.00mm'), 'GAP-I5-02: array marginMm:[120] must fall back to default margin');
  const dxfObjGuard = core.exportDXF(tinyPat, { seamAllowanceMm: [25], marginMm: null });
  assert.ok(dxfObjGuard.includes('EOF'));
  const pdfRes = core.exportTiledPDF(tinyPat, { marginMm: [120], tileOverlapMm: [30] });
  assert.ok(pdfRes.pdfBytes instanceof Uint8Array && pdfRes.pdfBytes.length > 100);

  // GAP-I5-03: resolveRollSpec (via nestPatternPieces) explicitLength non-finite fallback vs numeric <= 0 + hostile rollPreset
  const tinyBox = {
    unit: 'mm',
    pieces: [core.createRectanglePiece('Tiny', 80, 60)],
    seams: [],
  };
  const nanNest = core.nestPatternPieces(tinyBox, { rollPreset: 'cricut_24x12', sheetLengthMm: NaN });
  assert.equal(nanNest.fabricWidthMm, 609.6);
  assert.equal(nanNest.sheets[0].lengthMm, 304.8, 'GAP-I5-03: NaN sheetLengthMm falls back to preset.lengthMm');
  const emptyNest = core.nestPatternPieces(tinyBox, { rollPreset: 'cricut_24x12', sheetLengthMm: '' });
  assert.equal(emptyNest.sheets[0].lengthMm, 304.8, 'GAP-I5-03: empty string sheetLengthMm falls back to preset.lengthMm');
  const symNest = core.nestPatternPieces(tinyBox, { rollPreset: 'cricut_24x12', sheetLengthMm: Symbol('len') });
  assert.equal(symNest.sheets[0].lengthMm, 304.8, 'GAP-I5-03: Symbol sheetLengthMm must not throw');
  const zeroNest = core.nestPatternPieces(tinyBox, { rollPreset: 'cricut_24x12', sheetLengthMm: 0 });
  assert.equal(zeroNest.sheets[0].lengthMm, null, 'GAP-I5-03: explicit numeric <= 0 disables pagination');
  const hostilePresetNest = core.nestPatternPieces(tinyBox, { rollPreset: hostileToString });
  assert.ok(hostilePresetNest && Number.isFinite(hostilePresetNest.fabricWidthMm));

  // GAP-I5-04: binary STL with exact byte length and header containing "solid" + "endsolid"
  const binBuf = new ArrayBuffer(84 + 50);
  const binBytes = new Uint8Array(binBuf);
  const hdrText = 'solid fake_bin\nendsolid fake_bin';
  for (let i = 0; i < hdrText.length; i += 1) binBytes[i] = hdrText.charCodeAt(i);
  const binDv = new DataView(binBuf);
  binDv.setUint32(80, 1, true);
  // normal (0,0,1) + triangle (0,0,0), (10,0,0), (0,10,0)
  binDv.setFloat32(84 + 8, 1, true);
  binDv.setFloat32(84 + 24, 10, true);
  binDv.setFloat32(84 + 40, 10, true);
  const parsedBin = core.parseSTL(binBuf);
  assert.equal(parsedBin.format, 'binary', 'GAP-I5-04: exact-byte binary STL with endsolid header must parse as binary');
  assert.equal(parsedBin.triangles.length, 1);

  // COV-I5-01: Direct unit tests for all 21 (+1) barrel-exported vector helpers
  const a2 = core.vec2(3, 4);
  const b2 = core.vec2(1, -2);
  assert.deepEqual(a2, { x: 3, y: 4 });
  assert.deepEqual(core.vec2(), { x: 0, y: 0 });
  assert.deepEqual(core.add2(a2, b2), { x: 4, y: 2 });
  assert.deepEqual(core.sub2(a2, b2), { x: 2, y: 6 });
  assert.deepEqual(core.scale2(a2, 2.5), { x: 7.5, y: 10 });
  assert.equal(core.dot2(a2, b2), -5);
  assert.equal(core.cross2(a2, b2), -10);
  assertNear(core.len2(a2), 5, 1e-9);
  assertNear(core.dist2(core.vec2(1, 2), core.vec2(4, 6)), 5, 1e-9);
  assertNear(core.norm2(a2).x, 0.6, 1e-9);
  assertNear(core.norm2(a2).y, 0.8, 1e-9);
  assert.deepEqual(core.norm2(core.vec2(0, 0)), { x: 0, y: 0 });
  assert.deepEqual(core.lerp2(core.vec2(0, 10), core.vec2(10, 20), 0.25), { x: 2.5, y: 12.5 });
  const rotPt = core.rotate2(core.vec2(2, 1), Math.PI / 2, core.vec2(1, 1));
  assertNear(rotPt.x, 1, 1e-9);
  assertNear(rotPt.y, 2, 1e-9);
  assert.deepEqual(core.perp2(core.vec2(3, 5)), { x: -5, y: 3 });

  const a3 = core.vec3(2, 3, 6);
  const b3 = core.vec3(1, 0, -2);
  assert.deepEqual(a3, { x: 2, y: 3, z: 6 });
  assert.deepEqual(core.vec3(), { x: 0, y: 0, z: 0 });
  assert.deepEqual(core.add3(a3, b3), { x: 3, y: 3, z: 4 });
  assert.deepEqual(core.sub3(a3, b3), { x: 1, y: 3, z: 8 });
  assert.deepEqual(core.scale3(a3, -2), { x: -4, y: -6, z: -12 });
  assert.equal(core.dot3(a3, b3), -10);
  assert.deepEqual(core.cross3(core.vec3(1, 0, 0), core.vec3(0, 1, 0)), { x: 0, y: 0, z: 1 });
  assertNear(core.len3(a3), 7, 1e-9);
  assertNear(core.dist3(core.vec3(1, 2, 3), core.vec3(3, 5, 9)), 7, 1e-9);
  const n3 = core.norm3(a3);
  assertNear(n3.x, 2 / 7, 1e-9);
  assertNear(n3.y, 3 / 7, 1e-9);
  assertNear(n3.z, 6 / 7, 1e-9);
  assert.deepEqual(core.norm3(core.vec3(0, 0, 0)), { x: 0, y: 0, z: 0 });
  assert.deepEqual(core.lerp3(core.vec3(0, 0, 0), core.vec3(4, 8, 12), 0.5), { x: 2, y: 4, z: 6 });
});

test('T5-I5-01: B5-01..06 + GAP-I5-01..04 server/CLI/UI/CAD2D adversarial hardening', async () => {
  const customAsciiStl = [
    'solid custom_prism',
    '  facet normal 0 0 -1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 0 60 0',
    '      vertex 40 0 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 -1',
    '    outer loop',
    '      vertex 40 0 0',
    '      vertex 0 60 0',
    '      vertex 40 60 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 25',
    '      vertex 40 0 25',
    '      vertex 0 60 25',
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 40 0 25',
    '      vertex 40 60 25',
    '      vertex 0 60 25',
    '    endloop',
    '  endfacet',
    '  facet normal 0 -1 0',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 40 0 0',
    '      vertex 40 0 25',
    '    endloop',
    '  endfacet',
    '  facet normal 0 -1 0',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 40 0 25',
    '      vertex 0 0 25',
    '    endloop',
    '  endfacet',
    '  facet normal 0 1 0',
    '    outer loop',
    '      vertex 0 60 0',
    '      vertex 40 60 25',
    '      vertex 40 60 0',
    '    endloop',
    '  endfacet',
    '  facet normal 0 1 0',
    '    outer loop',
    '      vertex 0 60 0',
    '      vertex 0 60 25',
    '      vertex 40 60 25',
    '    endloop',
    '  endfacet',
    '  facet normal -1 0 0',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 0 0 25',
    '      vertex 0 60 25',
    '    endloop',
    '  endfacet',
    '  facet normal -1 0 0',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 0 60 25',
    '      vertex 0 60 0',
    '    endloop',
    '  endfacet',
    '  facet normal 1 0 0',
    '    outer loop',
    '      vertex 40 0 0',
    '      vertex 40 60 25',
    '      vertex 40 0 25',
    '    endloop',
    '  endfacet',
    '  facet normal 1 0 0',
    '    outer loop',
    '      vertex 40 0 0',
    '      vertex 40 60 0',
    '      vertex 40 60 25',
    '    endloop',
    '  endfacet',
    'endsolid custom_prism',
  ].join('\n');

  const srv = await startServer({ port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    const postJson = async (ep, payload) =>
      fetch(`${baseUrl}${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // B5-01: /api/simulate with templateId:'stl_cover' + stlText must simulate uploaded STL, not default wedge
    const simDefaultRes = await postJson('/api/simulate', { templateId: 'stl_cover', steps: 2 });
    assert.equal(simDefaultRes.status, 200);
    const simDefaultBody = await simDefaultRes.json();

    const simUploadedRes = await postJson('/api/simulate', {
      templateId: 'stl_cover',
      stlText: customAsciiStl,
      stlName: 'custom_prism.stl',
      steps: 2,
    });
    assert.equal(simUploadedRes.status, 200, 'B5-01: /api/simulate with stl_cover + stlText must return 200');
    const simUploadedBody = await simUploadedRes.json();
    assert.ok(simUploadedBody.stlBounds, 'B5-01: uploaded STL simulation must include stlBounds');
    assert.notDeepEqual(
      simUploadedBody.piecesMeta.map((p) => p.pieceId),
      simDefaultBody.piecesMeta.map((p) => p.pieceId),
      'B5-01: uploaded STL simulation must generate pieces from uploaded STL, not default cutting_mat_wedge_cover',
    );
    assert.notEqual(
      simUploadedBody.particles.length,
      simDefaultBody.particles.length,
      'B5-01: uploaded STL simulation particle mesh must differ from default wedge cover',
    );

    // B5-02: /api/unwrap-stl must honor materialOverrides.thicknessMm
    const unwrapT0Res = await postJson('/api/unwrap-stl', {
      stlText: customAsciiStl,
      easeMm: 2,
      seamAllowance: 10,
      materialId: 'eva_foam_4mm',
      materialOverrides: { thicknessMm: 0 },
    });
    assert.equal(unwrapT0Res.status, 200);
    const unwrapT0Body = await unwrapT0Res.json();

    const unwrapT8Res = await postJson('/api/unwrap-stl', {
      stlText: customAsciiStl,
      easeMm: 2,
      seamAllowance: 10,
      materialId: 'eva_foam_4mm',
      materialOverrides: { thicknessMm: 8 },
    });
    assert.equal(unwrapT8Res.status, 200);
    const unwrapT8Body = await unwrapT8Res.json();
    const maxDim = (pat) =>
      Math.max(
        ...pat.pattern.pieces.map((p) => {
          const xs = p.points.map((pt) => pt.x);
          const ys = p.points.map((pt) => pt.y);
          return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        }),
      );
    assert.ok(
      maxDim(unwrapT8Body) > maxDim(unwrapT0Body) + 100,
      'B5-02: materialOverrides.thicknessMm=8 must inflate unwrapped piece size vs thicknessMm=0',
    );

    // GAP-I5-01 (Server /api/nest seam refs while preserving nestSanitized)
    const twoPiece = {
      unit: 'mm',
      pieces: [
        { ...core.createRectanglePiece('A', 120, 120), id: 'p1' },
        { ...core.createRectanglePiece('B', 120, 120), id: 'p2' },
      ],
    };
    const invalidNestSeams = [
      [{ id: 's1', pieceA: 'p1', edgeA: 99, pieceB: 'p2', edgeB: 0 }],
      [{ id: 's1', pieceA: 'missing_a', edgeA: 0, pieceB: 'missing_b', edgeB: 0 }],
      [{
        id: 's1',
        pieceA: 'p1',
        edgeA: 0,
        pieceB: 'p2',
        edgeB: -1,
        internalLineIdB: 'il1',
      }],
    ];
    for (const seams of invalidNestSeams) {
      const r = await postJson('/api/nest', { pattern: { ...twoPiece, seams } });
      assert.equal(r.status, 400, `GAP-I5-01 /api/nest must reject seams=${JSON.stringify(seams)}`);
    }
    const onePtIlPat = {
      unit: 'mm',
      pieces: [
        { ...core.createRectanglePiece('A', 80, 80), id: 'p1' },
        {
          ...core.createRectanglePiece('B', 200, 200),
          id: 'p2',
          internalLines: [{ id: 'il1', type: 'stitch', points: [{ x: 40, y: 40 }] }],
        },
      ],
      seams: [{ id: 's1', pieceA: 'p1', edgeA: 0, pieceB: 'p2', internalLineIdB: 'il1', internalSegmentIndexB: 0 }],
    };
    assert.equal((await postJson('/api/nest', { pattern: onePtIlPat })).status, 400, 'GAP-I5-01: 1-pt internalLine segCount===0 must 400');

    // Preserve nestSanitized compatibility (non-string piece id sanitized to piece_1 while seam points to front)
    const tshirtCompat = core.generateTemplatePattern('tshirt');
    tshirtCompat.pieces[0].id = { toString: 'nope' };
    assert.equal((await postJson('/api/nest', { pattern: tshirtCompat })).status, 200, 'nestSanitized compat must stay 200');

    // GAP-I5-02: body.material and pattern.material validation
    assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', material: 'bogus_mat' })).status, 400);
    assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', material: { gsm: -5 } })).status, 400);
    assert.equal((await postJson('/api/unwrap-stl', { stlText: customAsciiStl, material: 'bogus_mat' })).status, 400);
    assert.equal((await postJson('/api/unwrap-stl', { stlText: customAsciiStl, material: 123 })).status, 400);

    const validPat = core.generateTemplatePattern('tshirt');
    assert.equal((await postJson('/api/nest', { pattern: { ...validPat, materialId: 'bogus_mat' } })).status, 400);
    assert.equal((await postJson('/api/nest', { pattern: { ...validPat, material: 'bogus_mat' } })).status, 400);
    assert.equal((await postJson('/api/export', { pattern: { ...validPat, material: { thicknessMm: -1 } }, format: 'svg' })).status, 400);
    assert.equal((await postJson('/api/nest', { pattern: { ...validPat, material: 'heavy_denim' } })).status, 200);

    // GAP-I5-04: body.avatar & option booleans
    assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', avatar: 'bad' })).status, 400);
    assert.equal((await postJson('/api/simulate', { templateId: 'tshirt', avatar: ['bad'], steps: 1 })).status, 400);
    assert.equal((await postJson('/api/nest', { pattern: validPat, options: { allowRotate90: 'bogus_str' } })).status, 400);
    assert.equal((await postJson('/api/export', { pattern: validPat, format: 'svg', options: { allowRotate90: 'bogus_str' } })).status, 400);
    assert.equal((await postJson('/api/nest', { pattern: validPat, options: { allowRotate90: 'false' } })).status, 200);
  } finally {
    await closeStudioServer(srv);
  }

  // B5-06 + GAP-I5-04 CLI checks
  await withTempDir(async (tmpDir) => {
    const stlPath = path.join(tmpDir, 'box.stl');
    await fsp.writeFile(stlPath, customAsciiStl, 'utf8');

    const emptyOutTpl = await runCliProcess(['template', '--type', 'tshirt', '--out', ''], tmpDir);
    assert.notEqual(emptyOutTpl.code, 0, 'B5-06: template --out "" must fail');
    assert.match(emptyOutTpl.stderr, /Invalid --out value/i);

    const emptyOutUnwrap = await runCliProcess(['unwrap', '--stl', stlPath, '--out', ''], tmpDir);
    assert.notEqual(emptyOutUnwrap.code, 0, 'B5-06: unwrap --stl ... --out "" must fail');
    assert.match(emptyOutUnwrap.stderr, /Invalid --out value/i);

    const emptyPageTpl = await runCliProcess(['template', '--type', 'tshirt', '--page', '', '--out', path.join(tmpDir, 'op1')], tmpDir);
    assert.notEqual(emptyPageTpl.code, 0, 'GAP-I6-01: template --page "" must fail');
    assert.match(emptyPageTpl.stderr, /Unsupported --page format/i);

    const emptyPageUnwrap = await runCliProcess(['unwrap', '--stl', stlPath, '--page', '   ', '--out', path.join(tmpDir, 'op2')], tmpDir);
    assert.notEqual(emptyPageUnwrap.code, 0, 'GAP-I6-01: unwrap --page "   " must fail');
    assert.match(emptyPageUnwrap.stderr, /Unsupported --page format/i);

    const conflictTpl = await runCliProcess(['template', '--type', 'tshirt', '--template', 'hoodie', '--out', path.join(tmpDir, 'o1')], tmpDir);
    assert.notEqual(conflictTpl.code, 0, 'GAP-I5-04: conflicting --type and --template must fail');

    const stlOnTshirt = await runCliProcess(['template', '--type', 'tshirt', '--stl', stlPath, '--out', path.join(tmpDir, 'o2')], tmpDir);
    assert.notEqual(stlOnTshirt.code, 0, 'GAP-I5-04: --stl on non-stl_cover template must fail');

    const conflictVerify = await runCliProcess(['verify-sim', '--template', 'tshirt', '--stl', stlPath], tmpDir);
    assert.notEqual(conflictVerify.code, 0, 'GAP-I5-04: verify-sim with both --template and --stl must fail');

    const modeWithoutStl = await runCliProcess(['verify-sim', '--template', 'tshirt', '--mode', 'form_shell_cover'], tmpDir);
    assert.notEqual(modeWithoutStl.code, 0, 'GAP-I5-04: verify-sim --mode without --stl must fail');
  });

  // GAP-I5-03 CAD2DViewport._hitTestCurveHandles mismatched points/edges
  {
    const canvas = {
      width: 640,
      height: 480,
      clientWidth: 640,
      clientHeight: 480,
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      getContext: () => createMock2DContext(),
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const vp = new CAD2DViewport(canvas, { onSelectPiece() {} });
    const badPiece = {
      id: 'mismatch_p',
      name: 'Mismatch',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }],
      edges: [
        { seamAllowance: 10 },
        { seamAllowance: 10 },
        { seamAllowance: 10 },
        { curve: { type: 'quadratic', cp: { x: 10, y: 10 } } },
        { curve: { type: 'quadratic', cp: { x: 20, y: 20 } } },
      ],
      position: { x: 0, y: 0 },
      rotation: 0,
    };
    const targetScreen = vp.worldToScreen(10, 10);
    assert.doesNotThrow(
      () => assert.equal(vp._hitTestCurveHandles(badPiece, targetScreen.x, targetScreen.y), null),
      'GAP-I5-03: _hitTestCurveHandles must ignore out-of-bounds edges beyond points.length',
    );
  }

  // B5-03, B5-04, B5-05: HTML + app.mjs DOM checks
  const htmlText = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(htmlText, /id="pieceRotationInput"[^>]*step="any"/, 'B5-03: pieceRotationInput must allow arbitrary angles');
  assert.match(htmlText, /id="pieceGrainInput"[^>]*step="any"/, 'B5-03: pieceGrainInput must allow arbitrary angles');
  assert.match(htmlText, /id="stlEaseInput"[^>]*max="50"/, 'B5-05: stlEaseInput max=50');
  assert.match(htmlText, /id="stlThicknessInput"[^>]*max="50"/, 'B5-05: stlThicknessInput max=50');
  assert.match(htmlText, /id="stlSaInput"[^>]*max="60"/, 'B5-05: stlSaInput max=60');

  const htmlIds = new Set();
  const attrMap = new Map();
  const tagRegex = /<([a-zA-Z0-9-]+)\b([^>]*)>/g;
  let mTag;
  while ((mTag = tagRegex.exec(htmlText)) !== null) {
    const attrsText = mTag[2];
    const idMatch = attrsText.match(/\bid="([^"]+)"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    htmlIds.add(id);
    const minMatch = attrsText.match(/\bmin="([^"]*)"/);
    const maxMatch = attrsText.match(/\bmax="([^"]*)"/);
    const stepMatch = attrsText.match(/\bstep="([^"]*)"/);
    const valMatch = attrsText.match(/\bvalue="([^"]*)"/);
    attrMap.set(id, {
      min: minMatch ? minMatch[1] : '',
      max: maxMatch ? maxMatch[1] : '',
      step: stepMatch ? stepMatch[1] : '',
      value: valMatch ? valMatch[1] : '',
    });
  }

  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    const initAttrs = attrMap.get(id);
    if (initAttrs) {
      if (initAttrs.min) attrs.set('min', initAttrs.min);
      if (initAttrs.max) attrs.set('max', initAttrs.max);
      if (initAttrs.step) attrs.set('step', initAttrs.step);
    }
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: initAttrs?.value || '',
      min: initAttrs?.min || '',
      max: initAttrs?.max || '',
      step: initAttrs?.step || '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      checkValidity() {
        const val = Number(this.value);
        if (!Number.isFinite(val)) return false;
        if (this.min !== '' && val < Number(this.min)) return false;
        if (this.max !== '' && val > Number(this.max)) return false;
        if (this.step !== '' && this.step !== 'any') {
          const stepNum = Number(this.step);
          const base = this.min !== '' ? Number(this.min) : 0;
          const rem = Math.abs((val - base) / stepNum);
          if (Math.abs(rem - Math.round(rem)) > 1e-6) return false;
        }
        return true;
      },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url) => {
      const sUrl = String(url);
      if (sUrl === '/api/workspace-stls') {
        return { ok: true, async json() { return { files: [] }; } };
      }
      if (sUrl === '/api/catalog') {
        return { ok: true, async json() { return { templates: [], materials: [], rolls: [] }; } };
      }
      return { ok: true, async json() { return {}; } };
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t5i5=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I5-01: initStudio must populate state.pattern');
    const st = appMod.state;
    await appMod.loadTemplate('tshirt');
    assert.ok(st.pattern.pieces.length > 0 && st.pattern.seams.length > 0);
    st.selectedPieceId = st.pattern.pieces[0].id;

    // B5-03: non-15 rotation & grain angles pass checkValidity() + clamp/restore
    const rotInput = elements.get('pieceRotationInput');
    const grainInput = elements.get('pieceGrainInput');
    rotInput.value = '17.5';
    assert.equal(rotInput.checkValidity(), true, 'B5-03: non-15 rotation 17.5 must pass checkValidity()');
    rotInput.dispatchEvent({ type: 'change' });
    assert.equal(st.pattern.pieces[0].rotation, 17.5);
    rotInput.value = '999';
    rotInput.dispatchEvent({ type: 'change' });
    assert.equal(rotInput.value, '360', 'B5-03: out-of-range rotation clamps DOM value to 360');
    assert.equal(st.pattern.pieces[0].rotation, 360);
    rotInput.value = 'bad';
    rotInput.dispatchEvent({ type: 'change' });
    assert.equal(rotInput.value, '360', 'B5-03: NaN rotation restores previous DOM value');

    grainInput.value = '12.5';
    assert.equal(grainInput.checkValidity(), true, 'B5-03: non-15 grain 12.5 must pass checkValidity()');
    grainInput.dispatchEvent({ type: 'change' });
    assert.equal(st.pattern.pieces[0].grainline?.angleDeg, 12.5);
    grainInput.value = '250';
    grainInput.dispatchEvent({ type: 'change' });
    assert.equal(grainInput.value, '180', 'B5-03: out-of-range grain clamps DOM value to 180');

    // B5-04: seamWalkSelect change resets seamWalkReadout to 0%
    const swReadout = elements.get('seamWalkReadout');
    const swSelect = elements.get('seamWalkSelect');
    swReadout.textContent = '75%';
    swSelect.value = st.pattern.seams[0].id;
    swSelect.dispatchEvent({ type: 'change' });
    assert.equal(swReadout.textContent, '0%', 'B5-04: seamWalkSelect change must reset seamWalkReadout to 0%');

    // B5-05: STL unwrap inputs clamp/restore even when templateId !== 'stl_cover'
    assert.equal(st.templateId, 'tshirt');
    const easeInput = elements.get('stlEaseInput');
    const thickInput = elements.get('stlThicknessInput');
    const saInput = elements.get('stlSaInput');
    easeInput.value = '200';
    easeInput.dispatchEvent({ type: 'change' });
    assert.equal(easeInput.value, '50', 'B5-05: stlEaseInput must clamp to 50 even on tshirt template');
    thickInput.value = '-5';
    thickInput.dispatchEvent({ type: 'change' });
    assert.equal(thickInput.value, '0', 'B5-05: stlThicknessInput must clamp to 0 even on tshirt template');
    saInput.value = '999';
    saInput.dispatchEvent({ type: 'change' });
    assert.equal(saInput.value, '60', 'B5-05: stlSaInput must clamp to 60 even on tshirt template');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});

test('adv_i6_core_null_options_and_parse_bool_flag_rollout: GAP-I6-01 & GAP-I6-02 across all core modules', () => {
  const tote = core.generateToteBagPattern();
  const samplePiece = tote.pieces[0];
  const sampleSeam = tote.seams[0];
  const pieceMap = new Map(tote.pieces.map((p) => [p.id, p]));

  // GAP-I6-01: null / primitive / array options never throw TypeError
  for (const badOpts of [null, undefined, 123, 'bad', []]) {
    const svg = core.exportSVG(tote, badOpts);
    assert.ok(svg.includes('<svg'), `exportSVG(${String(badOpts)}) must return SVG`);
    const dxf = core.exportDXF(tote, badOpts);
    assert.ok(dxf.includes('SECTION'), `exportDXF(${String(badOpts)}) must return DXF`);
    const pdf = core.exportTiledPDF(tote, badOpts);
    assert.ok(pdf.pageCount >= 1, `exportTiledPDF(${String(badOpts)}) must return PDF`);
    const nest = core.nestPatternPieces(tote, badOpts);
    assert.ok(nest.placements.length >= tote.pieces.length, `nestPatternPieces(${String(badOpts)}) must return placements`);
    assert.equal(core.validatePatternPiece(samplePiece, 'piece', badOpts).valid, true);
    assert.equal(core.validateSeam(sampleSeam, pieceMap, 'seam', badOpts).valid, true);
    assert.equal(core.validatePatternProject(tote, badOpts).valid, true);
    assert.ok(core.normalizePatternProject(tote, badOpts).pieces.length > 0);
  }

  // GAP-I6-02: parseBoolFlag rollout for dart.folded, seam.reversed, seam.allowEase, piece.onFold, worldSpace, normalized
  const falsyStrings = ['false', 'FALSE', '0', 'no', 'off', ''];
  const rectPts = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 200 },
  ];
  const refDartPiece = core.createFreeformPiece('RefDart', rectPts, {
    seamAllowance: 10,
    darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 24, depthMm: 60, folded: false }],
  });
  const refCut = core.computePieceCutBoundary(refDartPiece);
  const refOutline = core.samplePieceOutline(refDartPiece);

  for (const fStr of falsyStrings) {
    // 1. geometry.mjs: dart.folded & worldSpace
    const strDartPiece = {
      ...structuredClone(refDartPiece),
      position: { x: 500, y: 500 },
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 24, depthMm: 60, folded: fStr }],
    };
    const strCutLocal = core.computePieceCutBoundary(strDartPiece, 16, { worldSpace: fStr });
    assert.equal(strCutLocal.length, refCut.length, `dart.folded="${fStr}" cut vertex count must match folded=false`);
    assert.ok(Math.abs(core.polygonArea(strCutLocal) - core.polygonArea(refCut)) < 1e-3);
    const strOutlineLocal = core.samplePieceOutline(strDartPiece, 16, { worldSpace: fStr });
    assert.ok(Math.abs(strOutlineLocal[0].x - refOutline[0].x) < 1e-3, `worldSpace="${fStr}" must remain local`);

    // 2. exporters.mjs: piece.onFold
    const patOnFoldStr = {
      id: 'pat_fold',
      name: 'FoldCheck',
      unit: 'mm',
      pieces: [{ ...structuredClone(refDartPiece), onFold: fStr, darts: [] }],
      seams: [],
    };
    assert.equal(core.exportSVG(patOnFoldStr).includes('[CUT ON FOLD]'), false, `exportSVG onFold="${fStr}"`);
    assert.equal(core.exportDXF(patOnFoldStr).includes('[FOLD]'), false, `exportDXF onFold="${fStr}"`);
    assert.equal(
      core.exportTiledPDF(patOnFoldStr).pdfString.includes('[FOLD]'),
      false,
      `exportTiledPDF onFold="${fStr}"`
    );

    // 3. nesting.mjs: piece.onFold & paginateSheets
    const nestRes = core.nestPatternPieces(patOnFoldStr, { rollPreset: 'cricut_24x12', paginateSheets: fStr });
    assert.equal(nestRes.placements[0].onFold, false, `nestPatternPieces onFold="${fStr}"`);
    assert.equal(nestRes.sheetLengthMm, null, `nestPatternPieces paginateSheets="${fStr}" disables pagination`);

    // 4. templates.mjs: createFreeformPiece, createRectanglePiece, addDartToPiece, toggleDartFold, validatePatternSeams, computeSeamWalkTransform
    const ff = core.createFreeformPiece('FF', rectPts, {
      onFold: fStr,
      darts: [{ id: 'df', edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 50, folded: fStr }],
    });
    assert.equal(ff.onFold, false, `createFreeformPiece onFold="${fStr}"`);
    assert.equal(ff.darts[0].folded, false, `createFreeformPiece dart.folded="${fStr}"`);

    const rp = core.createRectanglePiece('RP', 120, 140, { seamAllowance: 10, onFold: fStr });
    assert.equal(rp.onFold, false, `createRectanglePiece onFold="${fStr}"`);
    assert.equal(rp.edges[3].seamAllowance, 10, `createRectanglePiece edge3 SA when onFold="${fStr}"`);
    assert.equal(rp.internalLines.filter((l) => l.type === 'fold').length, 0);

    core.addDartToPiece(rp, { edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 50, folded: fStr });
    assert.equal(rp.darts[0].folded, false, `addDartToPiece folded="${fStr}"`);
    core.toggleDartFold(rp, 0, true);
    assert.equal(rp.darts[0].folded, true);
    core.toggleDartFold(rp, 0, fStr);
    assert.equal(rp.darts[0].folded, false, `toggleDartFold explicit "${fStr}"`);
  }

  // 5. physics.mjs: dart.folded="false" creates dart constraints & seam.reversed="false" matches reversed=false
  const pA = core.createRectanglePiece('PA', 120, 120, { seamAllowance: 10, position: { x: 0, y: 0 } });
  const pB = core.createRectanglePiece('PB', 120, 120, { seamAllowance: 10, position: { x: 200, y: 0 } });
  const pAWithStrDart = {
    ...structuredClone(pA),
    darts: [{ id: 'd_phys', edgeIndex: 0, t: 0.5, widthMm: 24, depthMm: 60, folded: 'false' }],
  };
  const pAWithBoolDart = {
    ...structuredClone(pA),
    darts: [{ id: 'd_phys', edgeIndex: 0, t: 0.5, widthMm: 24, depthMm: 60, folded: false }],
  };
  const simStrDart = new core.ClothSimulation({ pieces: [pAWithStrDart], seams: [] }, { avatar: null });
  const simBoolDart = new core.ClothSimulation({ pieces: [pAWithBoolDart], seams: [] }, { avatar: null });
  assert.equal(simStrDart.dartConstraints.length, simBoolDart.dartConstraints.length);
  assert.ok(simStrDart.dartConstraints.length > 0, 'Unfolded dart with folded="false" must generate dart constraints');

  const simBoolRevFalse = new core.ClothSimulation(
    { pieces: [pA, pB], seams: [{ id: 's', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0, reversed: false }] },
    { avatar: null }
  );
  const simStrRevFalse = new core.ClothSimulation(
    { pieces: [pA, pB], seams: [{ id: 's', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0, reversed: 'false' }] },
    { avatar: null }
  );
  assert.deepEqual(
    simStrRevFalse.sewingConstraints.map((c) => [c.a, c.b]),
    simBoolRevFalse.sewingConstraints.map((c) => [c.a, c.b]),
    'seam.reversed="false" must match reversed=false in ClothSimulation'
  );

  // templates.mjs seam helpers with string flags
  const walkBool = core.computeSeamWalkTransform(
    { pieces: [pA, pB], seams: [{ id: 's', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0, reversed: false }] },
    's',
    40,
    { normalized: false }
  );
  const walkStr = core.computeSeamWalkTransform(
    { pieces: [pA, pB], seams: [{ id: 's', pieceA: pA.id, edgeA: 0, pieceB: pB.id, edgeB: 0, reversed: 'false' }] },
    's',
    40,
    { normalized: 'false' }
  );
  assert.ok(Math.abs(walkStr.transformedPointsB[0].x - walkBool.transformedPointsB[0].x) < 1e-6);

  const pShort = core.createRectanglePiece('PS', 100, 100);
  const pLong = core.createRectanglePiece('PL', 110, 100);
  const seamRep = core.validatePatternSeams({
    pieces: [pShort, pLong],
    seams: [{ id: 'se', pieceA: pShort.id, edgeA: 0, pieceB: pLong.id, edgeB: 0, allowEase: 'false' }],
  });
  assert.equal(seamRep[0].status, 'mismatch', 'allowEase="false" must not treat 10mm delta as ease');
});

test('adv_i6_server_validation_and_ui_pending_seam_edge: B6-01, B6-02, B6-03 regressions', async () => {
  // 1. B6-03 REST validation fixes on live server
  const srv = await startServer({ port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  try {
    const postJson = async (urlPath, payload) => {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return { status: res.status, json };
    };

    const validTpl = await postJson('/api/generate-template', { templateId: 'tshirt' });
    assert.equal(validTpl.status, 200);
    const validPat = validTpl.json.pattern;

    // B6-03a: empty/whitespace stlText / stlBase64 / workspaceFile in /api/simulate and /api/generate-template (stl_cover) -> 400
    for (const badStlBody of [
      { templateId: 'stl_cover', stlText: '   ', steps: 1 },
      { templateId: 'stl_cover', stlText: '', steps: 1 },
      { templateId: 'stl_cover', stlBase64: '   ', steps: 1 },
      { templateId: 'stl_cover', workspaceFile: '   ', steps: 1 },
      { templateId: 'tshirt', stlText: '   ', steps: 1 },
    ]) {
      const r = await postJson('/api/simulate', badStlBody);
      assert.equal(r.status, 400, `B6-03a: /api/simulate must reject ${JSON.stringify(badStlBody)}, got ${r.status}`);
    }
    assert.equal(
      (await postJson('/api/generate-template', { templateId: 'stl_cover', stlText: '   ' })).status,
      400,
      'B6-03a: /api/generate-template stl_cover with whitespace stlText must return 400'
    );

    // B6-03b: unknown material.id rejected 400 across endpoints, while valid custom override (no id) & valid preset id work 200
    const boxStl = core.createBoxSTL(40, 40, 40, false);
    assert.equal(
      (await postJson('/api/generate-template', { templateId: 'tshirt', material: { id: 'bogus_preset', gsm: 200 } })).status,
      400
    );
    assert.equal(
      (await postJson('/api/unwrap-stl', { stlText: boxStl, material: { id: 'bogus_preset', gsm: 200 } })).status,
      400
    );
    assert.equal(
      (await postJson('/api/simulate', { templateId: 'tshirt', material: { id: 'bogus_preset', gsm: 200 }, steps: 1 })).status,
      400
    );
    assert.equal(
      (await postJson('/api/nest', { pattern: { ...validPat, material: { id: 'bogus_preset' } } })).status,
      400
    );
    assert.equal(
      (await postJson('/api/export', { pattern: { ...validPat, material: { id: 'bogus_preset' } }, format: 'svg' })).status,
      400
    );
    const customNoId = await postJson('/api/generate-template', { templateId: 'tshirt', material: { name: 'Custom Silk', gsm: 185 } });
    assert.equal(customNoId.status, 200);
    assert.equal(customNoId.json.pattern.material.gsm, 185);
    const validPresetObj = await postJson('/api/generate-template', { templateId: 'tshirt', material: { id: 'heavy_denim', gsm: 410 } });
    assert.equal(validPresetObj.status, 200);
    assert.equal(validPresetObj.json.pattern.material.id, 'heavy_denim');

    // B6-03c: avatar: false rejected consistently 400 on both /api/generate-template and /api/simulate, while avatar: null succeeds
    assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', avatar: false })).status, 400);
    assert.equal((await postJson('/api/simulate', { templateId: 'tshirt', avatar: false, steps: 1 })).status, 400);
    assert.equal((await postJson('/api/generate-template', { templateId: 'tshirt', avatar: null })).status, 200);
    assert.equal((await postJson('/api/simulate', { templateId: 'tshirt', avatar: null, steps: 1 })).status, 200);
  } finally {
    await closeStudioServer(srv);
  }

  // 2. B6-01 CAD2DViewport.render() bounds guard for out-of-range pendingSeamEdge
  {
    const canvas = {
      width: 640,
      height: 480,
      clientWidth: 640,
      clientHeight: 480,
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      getContext: () => createMock2DContext(),
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const vp = new CAD2DViewport(canvas, {});
    const pat = core.generateToteBagPattern();
    assert.doesNotThrow(() => {
      vp.render({
        pattern: pat,
        pendingSeamEdge: { pieceId: pat.pieces[0].id, edgeIndex: 999 },
      });
    }, 'B6-01: CAD2DViewport.render must guard out-of-range pendingSeamEdge.edgeIndex');
    assert.doesNotThrow(() => {
      vp.render({
        pattern: pat,
        pendingSeamEdge: { pieceId: pat.pieces[0].id, edgeIndex: -1 },
      });
    }, 'B6-01: CAD2DViewport.render must guard negative pendingSeamEdge.edgeIndex');
  }

  // 3. B6-01 & B6-02 app.mjs mock-DOM state sync for pendingSeamEdge & selectedVertexIndex
  const htmlTextI6 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI6.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const windowListeners = new Map();
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url) => {
      const sUrl = String(url);
      if (sUrl === '/api/workspace-stls') return { ok: true, async json() { return { files: [] }; } };
      if (sUrl === '/api/catalog') return { ok: true, async json() { return { templates: [], materials: [], rolls: [] }; } };
      return { ok: true, async json() { return {}; } };
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t6i6=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I6-01: initStudio must populate state.pattern');
    const st = appMod.state;
    await appMod.loadTemplate('tshirt');

    // B6-01: split_edge and mirror must clear pendingSeamEdge on the modified piece
    const firstPiece = st.pattern.pieces[0];
    st.activeTool = 'split_edge';
    st.pendingSeamEdge = { pieceId: firstPiece.id, edgeIndex: firstPiece.points.length - 1 };
    appMod.cad2D.callbacks.onEdgeToolClick('split_edge', firstPiece.id, 0, 0.5);
    assert.equal(st.pendingSeamEdge, null, 'B6-01: split_edge must clear pendingSeamEdge on that piece');

    st.activeTool = 'mirror';
    const straightIdx = Math.max(0, firstPiece.edges.findIndex((e) => !e?.curve || (!e.curve.cp && !e.curve.cp1)));
    st.pendingSeamEdge = { pieceId: firstPiece.id, edgeIndex: firstPiece.points.length - 1 };
    appMod.cad2D.callbacks.onEdgeToolClick('mirror', firstPiece.id, straightIdx, 0.5);
    assert.equal(st.pendingSeamEdge, null, 'B6-01: mirror must clear pendingSeamEdge on that piece');

    // B6-01: deleting a vertex when pendingSeamEdge points to the last edge on that piece must clear pendingSeamEdge and never throw
    const lastIdx = firstPiece.points.length - 1;
    st.activeTool = 'sew';
    st.selectedPieceId = firstPiece.id;
    st.selectedVertexIndex = lastIdx;
    st.pendingSeamEdge = { pieceId: firstPiece.id, edgeIndex: lastIdx };
    elements.get('studioToast').textContent = '';
    elements.get('btnDeleteSelectedVertex').click();
    assert.equal(st.pendingSeamEdge, null, 'B6-01: deleting vertex must clear pendingSeamEdge on that piece');
    assert.equal(elements.get('studioToast').textContent, '', 'B6-01: deleting vertex must not surface render error toast');
    assert.doesNotThrow(() => {
      for (const fn of windowListeners.get('resize') || []) fn();
    }, 'B6-01: resize after vertex deletion must not throw');

    // B6-02: deleting a piece when pendingSeamEdge points to it must clear pendingSeamEdge & reset selectedVertexIndex
    const targetPiece = st.pattern.pieces[0];
    st.selectedPieceId = targetPiece.id;
    st.selectedVertexIndex = targetPiece.points.length - 1;
    st.pendingSeamEdge = { pieceId: targetPiece.id, edgeIndex: 0 };
    elements.get('btnDeletePiece').click();
    assert.equal(st.pendingSeamEdge, null, 'B6-02: btnDeletePiece must clear pendingSeamEdge referencing deleted piece');
    assert.equal(st.selectedVertexIndex, -1, 'B6-02: btnDeletePiece must reset selectedVertexIndex to -1');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});

test('adv_i7_core_exporters_geometry_quantity_materials: GAP-I7-01, GAP-I7-02, GAP-I7-03, and materials array override guard', () => {
  // 1. GAP-I7-01: exporters.mjs rejects null/non-object/array/missing-points/non-finite-points pieces with ValidationError (never TypeError)
  for (const badPieces of [
    [null],
    [{}],
    [[]],
    [42],
    [{ id: 'p', points: [null, null, null] }],
    [{ id: 'p', points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 10 }] }],
  ]) {
    const badPat = { id: 'bad_exp', name: 'BadExp', unit: 'mm', pieces: badPieces, seams: [] };
    for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
      assert.throws(
        () => exportFn(badPat),
        (err) => err instanceof core.ValidationError,
        `GAP-I7-01: ${exportFn.name} (default layout) must throw ValidationError for ${JSON.stringify(badPieces)}`
      );
      assert.throws(
        () => exportFn(badPat, { layout: 'nested' }),
        (err) => err instanceof core.ValidationError,
        `GAP-I7-01: ${exportFn.name} (nested layout) must throw ValidationError for ${JSON.stringify(badPieces)}`
      );
    }
  }

  // 2. GAP-I7-02: geometry.mjs and all consumers guard null/non-object/non-finite elements inside piece.points
  const badPointsVariants = [
    [null, null, null],
    [{ x: 0, y: 0 }, null, { x: 10, y: 10 }],
    [undefined, 'bad', []],
  ];
  for (const pts of badPointsVariants) {
    assert.equal(core.dist2D(pts[0], pts[1]), 0);
    const lPt = core.lerp2(pts[0], pts[1], 0.5);
    assert.ok(Number.isFinite(lPt.x) && Number.isFinite(lPt.y));
    assert.equal(core.signedPolygonArea(pts), 0);
    assert.equal(core.polygonArea(pts), 0);
    assert.deepEqual(core.ensureCCW(pts), pts.filter((p) => p && typeof p === 'object' && !Array.isArray(p) && Number.isFinite(p.x) && Number.isFinite(p.y)));
    const cent = core.polygonCentroid(pts);
    assert.ok(Number.isFinite(cent.x) && Number.isFinite(cent.y));
    const bnd = core.polygonBounds(pts);
    assert.ok(Number.isFinite(bnd.width) && Number.isFinite(bnd.height));
    assert.equal(core.polygonSelfIntersects(pts), false);
    assert.deepEqual(core.triangulatePolygon(pts).triangles, []);
    assert.deepEqual(core.generateClothMesh2D(pts).triangles, []);

    const badPiece = {
      id: 'bad_pts_piece',
      name: 'BadPts',
      points: pts,
      edges: [{}, {}, {}],
      notches: [{ id: 'n1', edgeIndex: 0, t: 0.5 }],
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 20 }],
    };
    const badPat = {
      id: 'bad_pts_pat',
      name: 'BadPtsPat',
      unit: 'mm',
      pieces: [badPiece],
      seams: [{ id: 's1', pieceA: 'bad_pts_piece', edgeA: 0, pieceB: 'bad_pts_piece', edgeB: 1 }],
    };

    assert.deepEqual(core.samplePieceOutline(badPiece), []);
    assert.deepEqual(core.computePieceCutBoundary(badPiece), []);
    assert.deepEqual(core.computePieceNotches(badPiece), []);
    const grain = core.computePieceGrainline(badPiece);
    assert.ok(Number.isFinite(grain.start.x) && Number.isFinite(grain.end.y));
    const meas = core.computePieceMeasurements(badPiece);
    assert.equal(meas.vertexCount, 0);

    const seamRes = core.validatePatternSeams(badPat);
    assert.equal(seamRes.length, 1);
    assert.equal(seamRes[0].valid, false);
    assert.equal(seamRes[0].status, 'invalid_seam');

    const sim = new core.ClothSimulation(badPat);
    assert.equal(sim.particles.length, 0);

    for (const mutFn of [
      () => core.addDartToPiece(structuredClone(badPiece)),
      () => core.addNotchToPiece(structuredClone(badPiece)),
      () => core.splitPieceEdge(structuredClone(badPiece)),
      () => core.deletePieceVertex({ ...structuredClone(badPiece), points: [...pts, null] }, 0),
      () => core.mirrorPieceAcrossEdge(structuredClone(badPiece)),
      () => core.computeSeamWalkTransform(badPat, 's1'),
      () => core.nestPatternPieces(badPat),
      () => core.exportSVG(badPat),
      () => core.exportDXF(badPat),
      () => core.exportTiledPDF(badPat),
    ]) {
      assert.throws(
        mutFn,
        (err) => err instanceof core.ValidationError,
        'GAP-I7-02: consumer must throw ValidationError (not TypeError) on invalid points array'
      );
    }
  }

  // 3. GAP-I7-03: piece.quantity upper bound (10000) enforced in types.mjs, nesting.mjs, exporters.mjs
  const okQtyPiece = core.createPatternPiece({ id: 'q_ok', name: 'QOk', quantity: 10000 });
  assert.equal(okQtyPiece.quantity, 10000);
  assert.equal(core.validatePatternPiece(okQtyPiece).valid, true);

  for (const extremeQty of [10001, 1e9, Infinity]) {
    assert.throws(
      () => core.createPatternPiece({ id: 'q_bad', name: 'QBad', quantity: extremeQty }),
      (err) => err instanceof core.ValidationError,
      `GAP-I7-03: createPatternPiece must reject quantity=${extremeQty}`
    );
    const rect = core.createRectanglePiece('QExtreme', 60, 120);
    rect.quantity = extremeQty;
    assert.throws(
      () => core.validatePatternPiece(rect),
      (err) => err instanceof core.ValidationError,
      `GAP-I7-03: validatePatternPiece must reject quantity=${extremeQty}`
    );
    const pat = { id: 'q_pat', name: 'QPat', unit: 'mm', pieces: [rect], seams: [] };
    const t0 = Date.now();
    assert.throws(() => core.nestPatternPieces(pat), (err) => err instanceof core.ValidationError);
    assert.throws(() => core.exportSVG(pat), (err) => err instanceof core.ValidationError);
    assert.throws(() => core.exportDXF(pat), (err) => err instanceof core.ValidationError);
    assert.throws(() => core.exportTiledPDF(pat), (err) => err instanceof core.ValidationError);
    assert.throws(() => core.exportSVG(pat, { layout: 'nested' }), (err) => err instanceof core.ValidationError);
    assert.ok(Date.now() - t0 < 1000, `GAP-I7-03: rejecting quantity=${extremeQty} must be instant`);
  }

  // 4. materials.mjs: array overrides are ignored cleanly (no '0', '1' index properties)
  const baseMat = core.getMaterialConfig('cotton_jersey');
  const arrMat = core.getMaterialConfig('cotton_jersey', ['x', 123]);
  assert.equal(Object.hasOwn(arrMat, '0'), false);
  assert.equal(Object.hasOwn(arrMat, '1'), false);
  assert.deepEqual(arrMat, baseMat);
});

test('T5-I7-01: B7-01, B7-02, and LOW-01..03 regressions across CLI, server, and app.mjs', async () => {
  // 1. B7-02 & LOW-02: CLI --page 36x24_MAT (and case-insensitive variants) + accurate seamIssuesCount
  await withTempDir(async (tmpDir) => {
    const outTpl = path.join(tmpDir, 'tpl_mat');
    const tplRes = await runCliProcess([
      'template',
      '--type', 'tshirt',
      '--page', '36x24_MAT',
      '--format', 'pdf,json',
      '--out', outTpl,
    ]);
    assert.equal(tplRes.code, 0, `B7-02: CLI template --page 36x24_MAT failed: ${tplRes.stderr}`);
    const tplSummary = JSON.parse(tplRes.stdout);
    assert.equal(tplSummary.pageFormat, '36x24_MAT');
    assert.equal(tplSummary.seamIssuesCount, 0);

    const tplPdf = await fsp.readFile(path.join(outTpl, 'tshirt.pdf'));
    const tplVer = await runVerifyExports('pdf', tplPdf, {});
    assert.equal(tplVer.ok, true, `B7-02: CLI template 36x24_MAT PDF failed verification: ${JSON.stringify(tplVer)}`);
    assertNear(tplVer.metrics.pageWidthMm, 914.4, 0.1, 'B7-02 template PDF widthMm');
    assertNear(tplVer.metrics.pageHeightMm, 609.6, 0.1, 'B7-02 template PDF heightMm');

    // Lowercase/uppercase case-insensitivity returns canonical key
    const outCase = path.join(tmpDir, 'tpl_case');
    const caseRes = await runCliProcess([
      'template',
      '--type', 'tote_bag',
      '--page', '36X24_MAT',
      '--format', 'json',
      '--out', outCase,
    ]);
    assert.equal(caseRes.code, 0, `B7-02: CLI --page 36X24_MAT failed: ${caseRes.stderr}`);
    assert.equal(JSON.parse(caseRes.stdout).pageFormat, '36x24_MAT');

    // Unwrap with --page 36x24_MAT
    const stlPath = path.join(tmpDir, 'box.stl');
    await fsp.writeFile(stlPath, core.createBoxSTL(40, 40, 40, false), 'utf8');
    const outUnwrap = path.join(tmpDir, 'unwrap_mat');
    const unwrapRes = await runCliProcess([
      'unwrap',
      '--stl', stlPath,
      '--format', 'svg,pdf,dxf,json',
      '--page', '36x24_MAT',
      '--out', outUnwrap,
    ]);
    assert.equal(unwrapRes.code, 0, `B7-02: CLI unwrap --page 36x24_MAT failed: ${unwrapRes.stderr}`);
    const unwrapSummary = JSON.parse(unwrapRes.stdout);
    assert.equal(unwrapSummary.pageFormat, '36x24_MAT');
    assert.equal(unwrapSummary.seamIssuesCount, 0);

    const unwrapPdf = await fsp.readFile(path.join(outUnwrap, 'box_form_shell_cover.pdf'));
    const unwrapVer = await runVerifyExports('pdf', unwrapPdf, {});
    assert.equal(unwrapVer.ok, true, `B7-02: CLI unwrap 36x24_MAT PDF failed verification: ${JSON.stringify(unwrapVer)}`);
    assertNear(unwrapVer.metrics.pageWidthMm, 914.4, 0.1, 'B7-02 unwrap PDF widthMm');
    assertNear(unwrapVer.metrics.pageHeightMm, 609.6, 0.1, 'B7-02 unwrap PDF heightMm');
  });

  // LOW-02: verify src/cli.mjs computes seamIssuesCount from array elements rather than .issues
  const cliSource = await fsp.readFile(CLI_PATH, 'utf8');
  assert.equal(cliSource.includes('seamReport.issues'), false, 'LOW-02: cli.mjs must not read .issues on seamReport array');
  assert.match(cliSource, /seamReport\.filter\(/, 'LOW-02: cli.mjs must count invalid items from seamReport array');

  // 2. B7-01, LOW-01, LOW-03: app.mjs parametric slider resets & sew bounds guard against live server
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const htmlTextI7 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI7.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';
  elements.get('rectWidthInput').value = '100';
  elements.get('rectHeightInput').value = '80';
  elements.get('rectSaInput').value = '10';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener() {},
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl.startsWith('/')) {
        return nativeFetch(`${baseUrl}${sUrl}`, init);
      }
      return nativeFetch(url, init);
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t7i7=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I7-01: initStudio must populate state.pattern');
    const st = appMod.state;
    await appMod.loadTemplate('tshirt');

    // B7-01 part A: split edge on front_bodice (8 -> 9), select edge 8 with sew, then trigger parametric slider input
    const front = st.pattern.pieces.find((p) => p.id === 'front_bodice');
    const back = st.pattern.pieces.find((p) => p.id === 'back_bodice');
    assert.ok(front && back);
    const origPtsCount = front.points.length;

    appMod.cad2D.callbacks.onEdgeToolClick('split_edge', front.id, origPtsCount - 1, 0.5);
    assert.equal(front.points.length, origPtsCount + 1);

    appMod.cad2D.callbacks.onEdgeToolClick('sew', front.id, origPtsCount, 0.5);
    assert.deepEqual(st.pendingSeamEdge, { pieceId: front.id, edgeIndex: origPtsCount });

    st.selectedVertexIndex = origPtsCount;
    st.selectedEdgeIndex = origPtsCount;
    st.seamWalk.seamId = 'stale_custom_seam_id';
    elements.get('seamWalkBar').classList.remove('hidden');

    const sliderRows = elements.get('parametricSlidersContainer').options;
    assert.ok(sliderRows.length > 0, 'B7-01: parametric sliders must render');
    const firstSlider = sliderRows[0].options[1];
    firstSlider.value = String(Number(firstSlider.value) + Number(firstSlider.step || 1));
    firstSlider.dispatchEvent({ type: 'input' });

    assert.equal(st.pendingSeamEdge, null, 'B7-01: slider input must clear pendingSeamEdge');
    assert.equal(st.selectedVertexIndex, -1, 'B7-01: slider input must reset out-of-range selectedVertexIndex');
    assert.equal(st.selectedEdgeIndex, 0, 'B7-01: slider input must clamp out-of-range selectedEdgeIndex');
    assert.equal(st.seamWalk.seamId, null, 'B7-01: slider input must clear stale seamWalk.seamId');
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);

    // Click back_bodice edge 0 with sew tool -> sets pendingSeamEdge instead of creating an invalid out-of-bounds seam
    const seamCountBefore = st.pattern.seams.length;
    appMod.cad2D.callbacks.onEdgeToolClick('sew', back.id, 0, 0.5);
    assert.equal(st.pattern.seams.length, seamCountBefore, 'B7-01: must not create seam from cleared pendingSeamEdge');
    assert.deepEqual(st.pendingSeamEdge, { pieceId: back.id, edgeIndex: 0 });

    // B7-01 part B: even if state.pendingSeamEdge is manually poisoned out-of-bounds, handleEdgeToolAction('sew') validates bounds
    st.pendingSeamEdge = { pieceId: front.id, edgeIndex: 999 };
    appMod.cad2D.callbacks.onEdgeToolClick('sew', back.id, 0, 0.5);
    assert.equal(st.pattern.seams.length, seamCountBefore, 'B7-01: poisoned pendingSeamEdge must be discarded without creating seam');
    assert.deepEqual(st.pendingSeamEdge, { pieceId: back.id, edgeIndex: 0 });

    // Out-of-bounds target edgeIndex on handleEdgeToolAction is also safely ignored
    appMod.cad2D.callbacks.onEdgeToolClick('sew', front.id, 999, 0.5);
    assert.equal(st.pattern.seams.length, seamCountBefore);
    st.pendingSeamEdge = null;

    // Verify resulting state.pattern exports and simulates with HTTP 200 (never 400)
    const expRes = await nativeFetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: st.pattern, format: 'svg' }),
    });
    assert.equal(expRes.status, 200, 'B7-01: /api/export after slider+sew must return 200');
    const simRes = await nativeFetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: st.pattern, steps: 1 }),
    });
    assert.equal(simRes.status, 200, 'B7-01: /api/simulate after slider+sew must return 200');

    // LOW-01: Add Rect, Duplicate, and Freeform reset selectedVertexIndex to -1
    st.selectedVertexIndex = 7;
    elements.get('btnConfirmAddRect').click();
    assert.equal(st.selectedVertexIndex, -1, 'LOW-01: btnConfirmAddRect must reset selectedVertexIndex to -1');
    assert.equal(st.selectedEdgeIndex, 0);

    st.selectedVertexIndex = 3;
    elements.get('btnDuplicatePiece').click();
    assert.equal(st.selectedVertexIndex, -1, 'LOW-01: btnDuplicatePiece must reset selectedVertexIndex to -1');
    assert.equal(st.selectedEdgeIndex, 0);

    st.selectedVertexIndex = 3;
    appMod.cad2D.callbacks.onCreateFreeform([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 80 },
      { x: 0, y: 80 },
    ]);
    assert.equal(st.selectedVertexIndex, -1, 'LOW-01: onCreateFreeform must reset selectedVertexIndex to -1');
    assert.equal(st.selectedEdgeIndex, 0);

    // LOW-03: pieceSaInput initializes missing piece.edges via ensurePieceEdges
    const activePc = st.pattern.pieces.find((p) => p.id === st.selectedPieceId);
    assert.ok(activePc);
    delete activePc.edges;
    const saInput = elements.get('pieceSaInput');
    saInput.value = '15';
    saInput.dispatchEvent({ type: 'change' });
    assert.ok(Array.isArray(activePc.edges) && activePc.edges.length === activePc.points.length, 'LOW-03: pieceSaInput must initialize missing piece.edges');
    assert.ok(activePc.edges.every((ed) => ed.seamAllowance === 15), 'LOW-03: all initialized edges must receive new SA');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});


test('adv_i8_core_geometry_stl_exporters_physics: GAP-I8-01..04, sparse arrays, step cap & core B8-01', async () => {
  // 1. GAP-I8-01: all 9 exported 3D vector helpers guard null/undefined/primitive/Symbol/non-finite inputs
  const sym = Symbol('v3');
  const hostile3DInputs = [
    null,
    undefined,
    42,
    'vec',
    [],
    sym,
    1n,
    { x: NaN, y: Infinity, z: -Infinity },
    { x: sym, y: 1n, z: 'bad' },
  ];
  const valid3 = core.vec3(3, 4, 12);
  for (const bad of hostile3DInputs) {
    for (const r of [
      core.add3(bad, valid3),
      core.add3(valid3, bad),
      core.sub3(bad, valid3),
      core.sub3(valid3, bad),
      core.scale3(bad, 2),
      core.scale3(valid3, bad),
      core.cross3(bad, valid3),
      core.cross3(valid3, bad),
      core.norm3(bad),
      core.lerp3(bad, valid3, 0.5),
      core.lerp3(valid3, bad, bad),
    ]) {
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z), 'GAP-I8-01: 3D vector output must be finite');
    }
    assert.ok(Number.isFinite(core.dot3(bad, valid3)));
    assert.ok(Number.isFinite(core.dot3(valid3, bad)));
    assert.ok(Number.isFinite(core.len3(bad)));
    assert.ok(Number.isFinite(core.dist3(bad, valid3)));
    assert.ok(Number.isFinite(core.dist3(valid3, bad)));
  }

  // 2. GAP-I8-02: stl.mjs triangle & face array element validation raises ValidationError (never TypeError)
  const sparseTriArr = new Array(1);
  for (const badTris of [
    [null],
    [undefined],
    [[]],
    [42],
    [[null, null, null]],
    [[{ x: 0, y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }]],
    [{ a: null }],
    sparseTriArr,
  ]) {
    assert.throws(
      () => core.serializeTrianglesToSTL(badTris),
      (err) => err instanceof core.ValidationError,
      `GAP-I8-02: serializeTrianglesToSTL must throw ValidationError for ${String(badTris)}`
    );
    assert.throws(
      () => core.analyzeSTLTopology({ triangles: badTris }),
      (err) => err instanceof core.ValidationError,
      `GAP-I8-02: analyzeSTLTopology must throw ValidationError for ${String(badTris)}`
    );
  }
  assert.throws(
    () => core.analyzeSTLTopology({ triangles: [] }),
    (err) => err instanceof core.ValidationError && err.code === 'EMPTY_STL'
  );

  const validBoxMesh = core.parseSTL(core.createBoxSTL(20, 20, 20, false), 'box.stl');
  for (const badMesh of [
    { triangles: [null], faces: [null] },
    { triangles: validBoxMesh.triangles, faces: [null] },
    { triangles: validBoxMesh.triangles, faces: [{ area: 10 }] },
    { triangles: validBoxMesh.triangles, faces: validBoxMesh.faces, vertices: [null] },
    { triangles: validBoxMesh.triangles, faces: validBoxMesh.faces, vertices: validBoxMesh.vertices, adjacency: [null] },
  ]) {
    assert.throws(
      () => core.unwrapSTLToPattern(badMesh),
      (err) => err instanceof core.ValidationError,
      'GAP-I8-02: unwrapSTLToPattern must reject malformed mesh objects with ValidationError'
    );
  }

  // 3. GAP-I8-03: exporters.mjs nestingResult & placements validation
  const rectPat = {
    id: 'i8_rect',
    name: 'I8Rect',
    unit: 'mm',
    pieces: [core.createRectanglePiece('R', 80, 60)],
    seams: [],
  };
  const sparsePlacements = new Array(1);
  for (const badNest of [
    42,
    [],
    { placements: 'bad' },
    { placements: [null] },
    { placements: [undefined] },
    { placements: [[]] },
    { placements: [42] },
    { placements: sparsePlacements },
  ]) {
    for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
      assert.throws(
        () => exportFn(rectPat, { nestingResult: badNest }),
        (err) => err instanceof core.ValidationError,
        `GAP-I8-03: ${exportFn.name} must reject malformed nestingResult with ValidationError`
      );
    }
  }
  // Hostile Symbol coordinate in otherwise valid placement falls back cleanly without TypeError
  const symPlaceNest = { placements: [{ pieceIndex: 0, x: sym, y: 10 }] };
  assert.ok(core.exportSVG(rectPat, { nestingResult: symPlaceNest }).includes('<svg'));

  // 4. GAP-I8-04 + sparse array points + <3 point piece parity
  const tPdf0 = Date.now();
  assert.throws(
    () =>
      core.exportTiledPDF(
        { id: 'huge_pdf', name: 'Huge', unit: 'mm', pieces: [core.createRectanglePiece('Big', 1e6, 1e6)], seams: [] },
        { pageFormat: 'LETTER' }
      ),
    (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE'
  );
  assert.ok(Date.now() - tPdf0 < 1000, 'GAP-I8-04: oversized PDF tile count must fail fast');

  const sparsePts = new Array(3);
  const sparsePat = { id: 'sparse_pts', name: 'Sparse', unit: 'mm', pieces: [{ id: 'sp', points: sparsePts }], seams: [] };
  for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
    assert.throws(() => exportFn(sparsePat), (err) => err instanceof core.ValidationError);
    assert.throws(() => exportFn(sparsePat, { layout: 'nested' }), (err) => err instanceof core.ValidationError);
  }

  for (const shortPts of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 50, y: 0 }]]) {
    const shortPat = { id: 'short_pts', name: 'Short', unit: 'mm', pieces: [{ id: 's1', points: shortPts }], seams: [] };
    for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
      assert.throws(
        () => exportFn(shortPat),
        (err) => err instanceof core.ValidationError && err.code === 'INVALID_PIECE',
        `GAP-I8-04: ${exportFn.name} default layout must reject <3-point piece (${shortPts.length} pts)`
      );
      assert.throws(
        () => exportFn(shortPat, { layout: 'nested' }),
        (err) => err instanceof core.ValidationError && err.code === 'INVALID_PIECE',
        `GAP-I8-04: ${exportFn.name} nested layout must reject <3-point piece (${shortPts.length} pts)`
      );
    }
  }
  // Empty pieces:[] pattern still succeeds across all 3 exporters
  const emptyPat = { id: 'empty_ok', name: 'Empty', unit: 'mm', pieces: [], seams: [] };
  assert.ok(core.exportSVG(emptyPat).includes('<svg'));
  assert.ok(core.exportDXF(emptyPat).includes('EOF'));
  assert.equal(core.exportTiledPDF(emptyPat, { pageFormat: 'LETTER' }).pageCount, 1);

  // 5. runSimulationSteps & ClothSimulation.step upper bound (MAX_SIM_STEPS = 10000)
  const tshirt = core.generateTemplatePattern('tshirt');
  for (const badSteps of [10001, 1e9, Infinity, -Infinity, 'Infinity', '100000']) {
    const t0 = Date.now();
    assert.throws(
      () => core.runSimulationSteps(tshirt, { steps: badSteps }),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_OPTIONS',
      `physics.mjs: runSimulationSteps must reject steps=${String(badSteps)}`
    );
    const sim = new core.ClothSimulation(tshirt, { maxEdgeLengthMm: 60 });
    assert.throws(
      () => sim.step(badSteps),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_OPTIONS',
      `physics.mjs: ClothSimulation.step must reject steps=${String(badSteps)}`
    );
    assert.ok(Date.now() - t0 < 1000, `physics.mjs: rejecting steps=${String(badSteps)} must be fast`);
  }

  // 6. B8-01: core.exportTiledPDF case-insensitive 36x24_MAT resolution
  const matCanon = core.exportTiledPDF(tshirt, { pageFormat: '36x24_MAT' });
  const matUpper = core.exportTiledPDF(tshirt, { pageFormat: '36X24_MAT' });
  const matLower = core.exportTiledPDF(tshirt, { pageFormat: '36x24_mat' });
  assert.equal(matCanon.pageFormat, '36x24_MAT');
  assert.equal(matUpper.pageFormat, '36x24_MAT');
  assert.equal(matLower.pageFormat, '36x24_MAT');
  assert.equal(matUpper.pageCount, matCanon.pageCount);
  assert.equal(matLower.pageCount, matCanon.pageCount);
  const verUpper = await runVerifyExports('pdf', matUpper.pdfBytes, {});
  assert.equal(verUpper.ok, true, `B8-01 core 36X24_MAT verify failed: ${JSON.stringify(verUpper.errors)}`);
  assertNear(verUpper.metrics.pageWidthMm, 914.4, 0.1);
  assertNear(verUpper.metrics.pageHeightMm, 609.6, 0.1);
});

test('T5-I8-01: B8-01..03 and OBS-01 regressions across server, app.mjs, and CLI', async () => {
  // 1. OBS-01: dead flags --allow-rotate and --lock-grain removed from BOOLEAN_FLAGS
  for (const deadFlag of ['--allow-rotate', '--lock-grain']) {
    const res = await runCliProcess(['template', '--type', 'tshirt', deadFlag]);
    assert.equal(res.code, 1, `OBS-01: ${deadFlag} must fail cleanly`);
    assert.match(res.stderr, /Unknown flag/, `OBS-01: ${deadFlag} must be rejected as unknown`);
  }

  // 2. B8-01 (Server POST /api/export) + B8-02 & B8-03 (public/app.mjs)
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const tshirt = core.generateTemplatePattern('tshirt');
  const postPdf = async (pageFormat) => {
    const res = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirt, format: 'pdf', options: { pageFormat } }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf };
  };

  const srvCanon = await postPdf('36x24_MAT');
  const srvUpper = await postPdf('36X24_MAT');
  const srvLower = await postPdf('36x24_mat');
  assert.equal(srvCanon.status, 200);
  assert.equal(srvUpper.status, 200, 'B8-01: POST /api/export must accept 36X24_MAT');
  assert.equal(srvLower.status, 200, 'B8-01: POST /api/export must accept 36x24_mat');
  assert.equal(srvUpper.buf.length, srvCanon.buf.length);
  assert.equal(srvLower.buf.length, srvCanon.buf.length);

  // Mock DOM harness for B8-02 & B8-03 in public/app.mjs
  const htmlTextI8 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI8.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';
  const capturedExports = [];

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl === '/api/export' && init?.body) {
        capturedExports.push(JSON.parse(init.body));
      }
      if (sUrl.startsWith('/')) {
        return nativeFetch(`${baseUrl}${sUrl}`, init);
      }
      return nativeFetch(url, init);
    };

    const waitUntil = async (pred, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const appMod = await import(`../public/app.mjs?t8i8=${Date.now()}`);
    await waitUntil(() => appMod.state?.pattern);
    assert.ok(appMod.state?.pattern, 'T5-I8-01: initStudio must populate state.pattern');
    const st = appMod.state;
    await appMod.loadTemplate('tshirt');

    // B8-02: weaveType & color pickers sync state.pattern.material before export
    const weaveSel = elements.get('matWeaveTypeSelect');
    const warpInp = elements.get('matWarpColor');
    const weftInp = elements.get('matWeftColor');
    const stitchInp = elements.get('matStitchColor');
    weaveSel.value = 'plain_weave';
    weaveSel.dispatchEvent({ type: 'change' });
    warpInp.value = '#ff00aa';
    warpInp.dispatchEvent({ type: 'input' });
    weftInp.value = '#112233';
    weftInp.dispatchEvent({ type: 'input' });
    stitchInp.value = '#445566';
    stitchInp.dispatchEvent({ type: 'input' });

    assert.equal(st.pattern.material.weaveType, 'plain_weave', 'B8-02: weaveType must sync to state.pattern.material');
    assert.equal(st.pattern.material.warpColor, '#ff00aa', 'B8-02: warpColor must sync to state.pattern.material');
    assert.equal(st.pattern.material.baseColor, '#ff00aa', 'B8-02: baseColor must sync to state.pattern.material');
    assert.equal(st.pattern.material.weftColor, '#112233', 'B8-02: weftColor must sync to state.pattern.material');
    assert.equal(st.pattern.material.stitchColor, '#445566', 'B8-02: stitchColor must sync to state.pattern.material');

    elements.get('btnExportJSON').click();
    elements.get('btnExportSVG').click();
    await waitUntil(() => capturedExports.length >= 2);
    assert.ok(capturedExports.length >= 2, 'B8-02: expected export payloads');
    for (const payload of capturedExports) {
      assert.equal(payload.pattern.material.weaveType, 'plain_weave');
      assert.equal(payload.pattern.material.warpColor, '#ff00aa');
      assert.equal(payload.pattern.material.weftColor, '#112233');
      assert.equal(payload.pattern.material.stitchColor, '#445566');
    }

    // B8-03: split_edge, mirror, and deleteVertex reconcile stale seamWalk.seamId & hide seamWalkBar
    const activateFirstSeamWalk = () => {
      const seam = st.pattern.seams[0];
      assert.ok(seam, 'expected at least one seam');
      st.seamWalk.seamId = seam.id;
      st.seamWalk.walkT = 0.5;
      elements.get('seamWalkBar').classList.remove('hidden');
      return seam;
    };

    const s1 = activateFirstSeamWalk();
    appMod.cad2D.callbacks.onEdgeToolClick('split_edge', s1.pieceA, s1.edgeA, 0.5);
    assert.equal(st.seamWalk.seamId, null, 'B8-03: split_edge removing walked seam must clear seamWalk.seamId');
    assert.equal(st.seamWalk.walkT, 0);
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);

    await appMod.loadTemplate('tshirt');
    const s2 = activateFirstSeamWalk();
    appMod.cad2D.callbacks.onEdgeToolClick('mirror', s2.pieceA, s2.edgeA, 0.5);
    assert.equal(st.seamWalk.seamId, null, 'B8-03: mirror removing walked seam must clear seamWalk.seamId');
    assert.equal(st.seamWalk.walkT, 0);
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);

    await appMod.loadTemplate('tshirt');
    const s3 = activateFirstSeamWalk();
    st.selectedPieceId = s3.pieceA;
    st.selectedVertexIndex = s3.edgeA;
    elements.get('btnDeleteSelectedVertex').click();
    assert.equal(st.pattern.seams.some((s) => s.id === s3.id), false, 'B8-03: deleting edgeA start vertex must remove walked seam');
    assert.equal(st.seamWalk.seamId, null, 'B8-03: deleteVertex removing walked seam must clear seamWalk.seamId');
    assert.equal(st.seamWalk.walkT, 0);
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});


test('adv_i9_core_stl_sparse_arrays: GAP-I9-01..04, LOW-I9-01 & falsy nestingResult', () => {
  // 1. GAP-I9-01: validateMeshObjectForUnwrap rejects missing or non-finite face.centroid
  const triA = { a: { x: 1000, y: 1000, z: 1000 }, b: { x: 1050, y: 1000, z: 1000 }, c: { x: 1000, y: 1050, z: 1000 } };
  const meshNoCentroid = {
    triangles: [triA],
    vertices: [triA.a, triA.b, triA.c],
    faces: [{ indices: [0, 1, 2], area: 1250, normal: { x: 0, y: 0, z: 1 } }],
    adjacency: [[]],
  };
  const meshNanCentroid = {
    triangles: [triA],
    vertices: [triA.a, triA.b, triA.c],
    faces: [{ indices: [0, 1, 2], area: 1250, normal: { x: 0, y: 0, z: 1 }, centroid: { x: NaN, y: 0, z: 0 } }],
    adjacency: [[]],
  };
  for (const badMesh of [meshNoCentroid, meshNanCentroid]) {
    for (const mode of ['form_shell_cover', 'surface_panels']) {
      assert.throws(
        () => core.unwrapSTLToPattern(badMesh, { mode }),
        (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL',
        `GAP-I9-01: ${mode} must reject missing/non-finite face.centroid with ValidationError`
      );
    }
  }

  // 2. GAP-I9-02: validateMeshObjectForUnwrap rejects missing/short/sparse/OOB edgeVertices & sparse adjList
  const v = [
    { x: 0, y: 0, z: 0 },
    { x: 50, y: 0, z: 0 },
    { x: 0, y: 50, z: 0 },
    { x: 50, y: 50, z: 10 },
  ];
  const baseFaces = [
    { indices: [0, 1, 2], area: 1250, normal: { x: 0, y: 0, z: 1 }, centroid: { x: 16, y: 16, z: 0 } },
    { indices: [1, 3, 2], area: 1250, normal: { x: 0, y: -0.196, z: 0.98 }, centroid: { x: 33, y: 33, z: 3 } },
  ];
  const baseTris = [{ a: v[0], b: v[1], c: v[2] }, { a: v[1], b: v[3], c: v[2] }];
  const sparseEdgeVerts = new Array(2);
  const sparseAdjList = new Array(1);
  const badAdjVariants = [
    [[{ neighbor: 1, dihedralDeg: 45, edgeLength: 70.71 }], [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71 }]],
    [[{ neighbor: 1, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1] }], [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 2] }]],
    [[{ neighbor: 1, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 999] }], [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 2] }]],
    [[{ neighbor: 1, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [-1, 2] }], [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 2] }]],
    [[{ neighbor: 1, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: sparseEdgeVerts }], [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 2] }]],
    [sparseAdjList, [{ neighbor: 0, dihedralDeg: 45, edgeLength: 70.71, edgeVertices: [1, 2] }]],
  ];
  for (const adj of badAdjVariants) {
    const mBadAdj = { triangles: baseTris, vertices: v, faces: baseFaces, adjacency: adj };
    for (const mode of ['surface_panels', 'form_shell_cover']) {
      assert.throws(
        () => core.unwrapSTLToPattern(mBadAdj, { mode }),
        (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL',
        `GAP-I9-02: ${mode} must reject invalid adjacency/edgeVertices with ValidationError`
      );
    }
  }

  // 3. GAP-I9-03: sparse points in nesting.mjs & geometry.mjs + LOW-I9-01 1e308 summary bounds
  const sparseNew3 = new Array(3);
  const sparseHole4 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  delete sparseHole4[1];

  for (const spPts of [sparseNew3, sparseHole4]) {
    for (const unit of ['mm', 'cm']) {
      assert.throws(
        () => core.nestPatternPieces({ unit, pieces: [{ id: 'p1', name: 'S', points: spPts }], seams: [] }),
        (err) => err instanceof core.ValidationError,
        `GAP-I9-03: nestPatternPieces (${unit}) must reject sparse points`
      );
    }
    assert.equal(core.signedPolygonArea(spPts), 0);
    assert.equal(core.polygonArea(spPts), 0);
    assert.equal(core.polygonPerimeter(spPts), 0);
    assert.equal(core.pointInPolygon({ x: 50, y: 50 }, spPts), false);
    const spPiece = { id: 'p1', name: 'S', points: spPts };
    assert.deepEqual(core.samplePieceOutline(spPiece), []);
    assert.deepEqual(core.computePieceCutBoundary(spPiece), []);
    assert.deepEqual(core.computePieceNotches(spPiece), []);
    const g = core.computePieceGrainline(spPiece);
    assert.ok(Number.isFinite(g.start.x) && Number.isFinite(g.end.y));
    assert.equal(core.computePieceMeasurements(spPiece).vertexCount, 0);
  }
  assert.throws(
    () => core.nestPatternPieces({ unit: 'mm', pieces: new Array(1), seams: [] }),
    (err) => err instanceof core.ValidationError
  );

  // LOW-I9-01: extreme 1e308 coordinates stay unfitted with finite summary metrics
  const hugeNest = core.nestPatternPieces({
    unit: 'mm',
    pieces: [
      {
        id: 'huge',
        name: 'Huge',
        points: [{ x: 0, y: 0 }, { x: 1e308, y: 0 }, { x: 1e308, y: 1e308 }, { x: 0, y: 1e308 }],
      },
    ],
    seams: [],
  });
  assert.equal(hugeNest.unfittedPieces.length, 1);
  assert.equal(hugeNest.unfittedPieces[0].reason, 'EXCEEDS_USABLE_SHEET_BOUNDS');
  assert.ok(Number.isFinite(hugeNest.totalCutAreaMm2));
  assert.ok(Number.isFinite(hugeNest.totalNetAreaMm2));
  assert.ok(Number.isFinite(hugeNest.totalCutPerimeterMm));
  assert.ok(Number.isFinite(hugeNest.totalSewPerimeterMm));

  // 4. GAP-I9-04: sparse points & edges in templates.mjs
  const sparseEdges4 = [{}, {}, {}, {}];
  delete sparseEdges4[1];
  for (const badPiece of [
    { id: 'sp1', name: 'S', points: new Array(3) },
    { id: 'sp2', name: 'S', points: sparseHole4 },
    { id: 'sp3', name: 'S', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], edges: sparseEdges4 },
  ]) {
    const spPat = { id: 'sp_pat', name: 'SP', unit: 'mm', pieces: [structuredClone(badPiece)], seams: [{ id: 's1', pieceA: badPiece.id, edgeA: 0, pieceB: badPiece.id, edgeB: 2 }] };
    for (const mutFn of [
      () => core.addDartToPiece(structuredClone(badPiece)),
      () => core.addNotchToPiece(structuredClone(badPiece)),
      () => core.splitPieceEdge(structuredClone(badPiece), 1, 0.5),
      () => core.deletePieceVertex({ ...structuredClone(badPiece), points: badPiece.points.length >= 4 ? badPiece.points : new Array(4) }, 0),
      () => core.mirrorPieceAcrossEdge(structuredClone(badPiece), 0),
      () => core.computeSeamWalkTransform(spPat, 's1'),
    ]) {
      assert.throws(mutFn, (err) => err instanceof core.ValidationError, 'GAP-I9-04: templates.mjs must reject sparse points/edges');
    }
    const seamRep = core.validatePatternSeams(spPat);
    assert.equal(seamRep.length, 1);
    assert.equal(seamRep[0].valid, false);
    assert.equal(seamRep[0].status, 'invalid_seam');
  }

  // 5. LOW-I9-01 (types.mjs): validatePatternPiece & normalizePatternProject reject sparse edges/points
  const validRectPts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  for (const spEdges of [new Array(4), sparseEdges4]) {
    assert.throws(
      () => core.validatePatternPiece({ id: 'p_sp_e', points: validRectPts, edges: spEdges }),
      (err) => err instanceof core.ValidationError
    );
    assert.throws(
      () => core.normalizePatternProject({ unit: 'mm', pieces: [{ id: 'p_sp_e', points: validRectPts, edges: spEdges }] }),
      (err) => err instanceof core.ValidationError
    );
  }
  assert.throws(
    () => core.normalizePatternProject({ unit: 'mm', pieces: new Array(1) }),
    (err) => err instanceof core.ValidationError
  );

  // 6. exporters.mjs Minor Finding 2: falsy primitive nestingResult values must not bypass validation
  const okPat = { id: 'falsy_nest', name: 'FalsyNest', unit: 'mm', pieces: [core.createRectanglePiece('R', 80, 60)], seams: [] };
  for (const falsyNest of [false, 0, '', NaN]) {
    for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
      assert.throws(
        () => exportFn(okPat, { nestingResult: falsyNest }),
        (err) => err instanceof core.ValidationError && err.code === 'INVALID_OPTIONS',
        `exporters.mjs: ${exportFn.name} must reject falsy nestingResult=${String(falsyNest)}`
      );
    }
  }
  assert.ok(core.exportSVG(okPat, { nestingResult: undefined }).includes('<svg'));
  assert.ok(core.exportSVG(okPat, { nestingResult: null }).includes('<svg'));
});

test('T5-I9-01: B9-01 reUnwrapActiveStl preserves material/undo & B9-02 pieceGrainInput clears stale start/end', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const htmlTextI9 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI9.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';
  elements.get('rectWidthInput').value = '80';
  elements.get('rectHeightInput').value = '60';
  elements.get('rectSaInput').value = '10';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl.startsWith('/')) {
        return nativeFetch(`${baseUrl}${sUrl}`, init);
      }
      return nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?t9i9=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;

    // 1. B9-01: Load STL, add piece & customize material, then reUnwrapActiveStl via stlSaInput
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_assembled_view.stl');
    assert.equal(st.templateId, 'stl_cover');
    assert.equal(elements.get('btnUndo').disabled, true, 'Fresh STL load starts with empty undo stack');

    const basePieceCount = st.pattern.pieces.length;
    elements.get('btnConfirmAddRect').click();
    assert.equal(st.pattern.pieces.length, basePieceCount + 1);
    assert.equal(elements.get('btnUndo').disabled, false);

    elements.get('matWeaveTypeSelect').value = 'plain_weave';
    elements.get('matWeaveTypeSelect').dispatchEvent({ type: 'change' });
    elements.get('matWarpColor').value = '#ff1122';
    elements.get('matWarpColor').dispatchEvent({ type: 'input' });

    elements.get('stlSaInput').value = '14';
    elements.get('stlSaInput').dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.params?.seamAllowance === 14);

    assert.equal(st.pattern.params.seamAllowance, 14, 'B9-01: reUnwrapActiveStl updates seamAllowance');
    assert.equal(st.materialOverrides.weaveType, 'plain_weave', 'B9-01: preserves materialOverrides.weaveType');
    assert.equal(st.materialOverrides.warpColor, '#ff1122', 'B9-01: preserves materialOverrides.warpColor');
    assert.equal(st.pattern.material.weaveType, 'plain_weave', 'B9-01: syncs state.pattern.material.weaveType');
    assert.equal(st.pattern.material.warpColor, '#ff1122', 'B9-01: syncs state.pattern.material.warpColor');
    assert.equal(st.sim.material.weaveType, 'plain_weave', 'B9-01: syncs state.sim.material.weaveType');
    assert.equal(elements.get('btnUndo').disabled, false, 'B9-01: reUnwrapActiveStl keeps undo enabled');

    elements.get('btnUndo').click();
    assert.equal(st.pattern.pieces.length, basePieceCount + 1, 'B9-01: Undo restores pre-reunwrap added piece');
    assert.equal(st.pattern.params.seamAllowance, 10, 'B9-01: Undo restores pre-reunwrap seamAllowance');
    assert.equal(st.pattern.material.weaveType, 'plain_weave', 'B9-01: Undo restores customized weaveType');
    assert.equal(st.pattern.material.warpColor, '#ff1122', 'B9-01: Undo restores customized warpColor');

    // Fresh STL load still resets overrides and history cleanly
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_print_ready.stl');
    assert.deepEqual(st.materialOverrides, {}, 'Fresh STL load resets materialOverrides');
    assert.equal(elements.get('btnUndo').disabled, true, 'Fresh STL load clears undo history');

    // 2. B9-02: pieceGrainInput clears stale grainline.start/end so computePieceGrainline & exports use new angleDeg
    const grainJson = JSON.stringify({
      id: 'grain_b9_02',
      name: 'GrainB902',
      templateId: 'custom',
      unit: 'mm',
      pieces: [
        {
          id: 'gp1',
          name: 'GrainPiece',
          points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 160 }, { x: 0, y: 160 }],
          edges: [{}, {}, {}, {}],
          grainline: { start: { x: 50, y: 20 }, end: { x: 50, y: 120 }, angleDeg: 90 },
        },
      ],
      seams: [],
    });
    const jsonInp = elements.get('jsonFileInput');
    jsonInp.files = [{ name: 'grain_b9_02.json', text: async () => grainJson }];
    jsonInp.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.id === 'grain_b9_02');

    elements.get('pieceGrainInput').value = '45';
    elements.get('pieceGrainInput').dispatchEvent({ type: 'change' });

    const gp = st.pattern.pieces[0];
    assert.equal(gp.grainline.angleDeg, 45);
    assert.equal(gp.grainline.start, undefined, 'B9-02: stale grainline.start cleared');
    assert.equal(gp.grainline.end, undefined, 'B9-02: stale grainline.end cleared');
    const computedGrain = core.computePieceGrainline(gp, { worldSpace: true });
    assertNear(computedGrain.angleDeg, 45, 1e-3, 'B9-02: computePieceGrainline honors edited 45 deg');

    const svgOut = core.exportSVG(st.pattern);
    const grainGroupMatch = svgOut.match(/<g id="grainlines"[^>]*>([\s\S]*?)<\/g>/);
    assert.ok(grainGroupMatch, 'B9-02: SVG must contain grainlines group');
    const lineMatch = grainGroupMatch[1].match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/);
    assert.ok(lineMatch, 'B9-02: SVG grainlines group must contain main grainline <line>');
    const svgAngleDeg = (Math.atan2(Number(lineMatch[4]) - Number(lineMatch[2]), Number(lineMatch[3]) - Number(lineMatch[1])) * 180) / Math.PI;
    assertNear(svgAngleDeg, 45, 0.5, 'B9-02: exported SVG grainline must reflect 45 deg');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});


test('adv_i10_core_extremes: I10 Findings 1-6 (cloth DoS, 1e308 templates, mm sparse/viewBox, types Array.from, STL 1e308, stl_cover unwrap return)', () => {
  // 1. Finding 1: generateClothMesh2D NaN vertex-cap bypass DoS (>= 1e155 / 1e308)
  for (const scale of [1e155, 1e308]) {
    const decagon = Array.from({ length: 10 }, (_, i) => ({
      x: Math.cos((i * Math.PI) / 5) * scale,
      y: Math.sin((i * Math.PI) / 5) * scale,
    }));
    const t0 = Date.now();
    const mesh = core.generateClothMesh2D(decagon, 25);
    const dt = Date.now() - t0;
    assert.ok(mesh.vertices.length <= 100000, `Expected <= 100000 vertices for scale=${scale}, got ${mesh.vertices.length}`);
    assert.ok(mesh.triangles.length > 0 && dt < 100, `Expected fast <100ms mesh generation for scale=${scale}, took ${dt}ms`);
    for (const v of mesh.vertices) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), 'Mesh vertices must stay finite');
    }
    const edgeKeys = new Set();
    for (const [a, b, c] of mesh.triangles) {
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        edgeKeys.add(u < v ? `${u}:${v}` : `${v}:${u}`);
      }
    }
    assert.equal(mesh.vertices.length - edgeKeys.size + mesh.triangles.length, 1, 'Euler characteristic V-E+F must remain 1');

    const simT0 = Date.now();
    const extremePat = {
      id: 'ext_cloth',
      name: 'ExtCloth',
      unit: 'mm',
      pieces: [{ id: 'p1', name: 'P1', points: decagon, edges: decagon.map(() => ({})) }],
      seams: [],
    };
    const sim = new core.ClothSimulation(extremePat, { maxEdgeLengthMm: 25 });
    sim.step(1 / 60);
    const simDt = Date.now() - simT0;
    assert.ok(simDt < 100, `ClothSimulation on extreme ${scale} polygon must finish <100ms (took ${simDt}ms)`);
    assert.equal(sim.particles.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)), true);
  }

  // 2. Finding 2: templates.mjs 1e308 NaN/Infinity & hoodie stall guard
  for (const templateId of ['tshirt', 'hoodie', 'pants', 'tote_bag', 'stl_cover']) {
    const t0 = Date.now();
    const pat = core.generateTemplatePattern(templateId, {
      chestMm: 1e308,
      waistMm: 1e308,
      hipMm: 1e308,
      lengthMm: 1e308,
      widthMm: 1e308,
      heightMm: 1e308,
      gussetDepthMm: 1e308,
      strapLengthMm: 1e308,
      inseamMm: 1e308,
      frontRiseMm: 1e308,
      backRiseMm: 1e308,
      sleeveLengthMm: 1e308,
      bicepWidthMm: 1e308,
      hoodHeightMm: 1e308,
      hoodDepthMm: 1e308,
      seamAllowance: 1e308,
      easeMm: 1e308,
      wedgeLengthMm: 1e308,
      wedgeWidthMm: 1e308,
      wedgeHeightMm: 1e308,
      scale: 1e308,
    });
    const validation = core.validatePatternProject(pat, { throwOnError: false });
    assert.equal(validation.valid, true, `${templateId} 1e308 must produce schema-valid PatternProject: ${validation.errors[0]?.message}`);
    assert.ok(core.exportSVG(pat).includes('<svg'));
    assert.ok(core.exportDXF(pat).includes('$INSUNITS'));
    const nested = core.nestPatternPieces(pat);
    assert.ok(nested.placements.length >= 0);
    assert.ok(Date.now() - t0 < 7500, `${templateId} 1e308 generation + exports must not stall (took ${Date.now() - t0}ms)`);
  }

  // 3. Finding 3: exporters.mjs mm/omitted sparse parity & 1e308 SVG/DXF EXPORT_TOO_LARGE
  const okPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
  // Minimal mm input without optional sub-arrays remains accepted
  assert.ok(core.exportSVG({ unit: 'mm', pieces: [{ id: 'min', points: okPts }] }).includes('<svg'));
  assert.ok(core.exportDXF({ pieces: [{ id: 'min_omitted', points: okPts }] }).includes('$INSUNITS'));

  const sparseEdges = new Array(4);
  const sparseNotches = new Array(1);
  const sparseDarts = new Array(1);
  const sparseInternal = new Array(1);
  const sparseIlPts = [{ id: 'il', points: new Array(2) }];
  for (const unitVal of ['mm', undefined, 'cm']) {
    for (const badPat of [
      { ...(unitVal ? { unit: unitVal } : {}), pieces: new Array(1) },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_pts', points: new Array(3) }] },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_edg', points: okPts, edges: sparseEdges }] },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_nt', points: okPts, notches: sparseNotches }] },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_dt', points: okPts, darts: sparseDarts }] },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_il', points: okPts, internalLines: sparseInternal }] },
      { ...(unitVal ? { unit: unitVal } : {}), pieces: [{ id: 'sp_ilp', points: okPts, internalLines: sparseIlPts }] },
    ]) {
      for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
        assert.throws(
          () => exportFn(badPat),
          (err) => err instanceof core.ValidationError,
          `exporters (${String(unitVal)}) ${exportFn.name} must reject sparse arrays`
        );
      }
    }
  }

  for (const hugePts of [
    [{ x: -1e308, y: -1e308 }, { x: 1e308, y: -1e308 }, { x: 1e308, y: 1e308 }, { x: -1e308, y: 1e308 }],
    [{ x: 0, y: 0 }, { x: 1e308, y: 0 }, { x: 1e308, y: 1e308 }, { x: 0, y: 1e308 }],
  ]) {
    const hugePat = { unit: 'mm', pieces: [{ id: 'huge', points: hugePts, edges: [{}, {}, {}, {}] }], seams: [] };
    for (const exportFn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
      assert.throws(
        () => exportFn(hugePat),
        (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
        `${exportFn.name} must throw EXPORT_TOO_LARGE on 1e308 coordinates`
      );
    }
  }

  // 4. Finding 4: types.mjs Array.from dense normalization
  const denseIl = core.createInternalLineSpec({ points: new Array(2) });
  assert.equal(0 in denseIl.points && 1 in denseIl.points, true);
  const densePiece = core.createPatternPiece({
    points: okPts,
    notches: new Array(1),
    darts: new Array(1),
    internalLines: new Array(1),
  });
  assert.equal(0 in densePiece.notches, true);
  assert.equal(0 in densePiece.darts, true);
  assert.equal(0 in densePiece.internalLines, true);
  const denseProj = core.createPatternProject({ pieces: new Array(1), seams: new Array(1) });
  assert.equal(0 in denseProj.pieces, true);
  assert.equal(0 in denseProj.seams, true);

  // 5. Finding 5: stl.mjs rejects 1e308-overflowing triangles cleanly
  const overflowStl = [
    'solid overflow',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1e308 0 0',
    '      vertex 0 1e308 0',
    '    endloop',
    '  endfacet',
    'endsolid overflow',
  ].join('\n');
  assert.throws(
    () => core.parseSTL(overflowStl, 'overflow.stl'),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL'
  );
  assert.throws(
    () => core.analyzeSTLTopology({ triangles: [[{ x: 0, y: 0, z: 0 }, { x: 1e308, y: 0, z: 0 }, { x: 0, y: 1e308, z: 0 }]] }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL'
  );

  // 6. Finding 6: generateSTLCoverPattern validates unwrapFn non-null return
  assert.throws(
    () => core.generateTemplatePattern('stl_cover', {}, { unwrapFn: () => ({ foo: 'bar' }) }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_PATTERN'
  );
  assert.throws(
    () => core.generateTemplatePattern('stl_cover', {}, { unwrapFn: () => [1, 2] }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_PATTERN'
  );
  try {
    core.registerStlCoverGenerator(() => ({ foo: 'bar' }));
    assert.throws(
      () => core.generateTemplatePattern('stl_cover'),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_PATTERN'
    );
  } finally {
    // Re-register M2 STL cover generator so subsequent tests keep real STL unwrapping
    core.registerStlCoverGenerator((userParams = {}, opts = {}) => {
      const matId = typeof userParams?.materialId === 'string' && userParams.materialId.length > 0
        ? userParams.materialId
        : (typeof opts?.materialId === 'string' && opts.materialId.length > 0 ? opts.materialId : 'veg_leather');
      const stlInput = opts?.stlData ?? opts?.stl ?? userParams?.stlData ?? userParams?.stl;
      if (stlInput) {
        const mesh = core.parseSTL(stlInput, opts?.name || userParams?.name || 'model.stl');
        return core.unwrapSTLToPattern(mesh, { ...opts, ...userParams, materialId: matId });
      }
      return null;
    });
  }
});

test('T5-I10-01: B10-01 non-pointer slider input+change Undo/Redo & OBS-05 fresh STL materialId reset', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const htmlTextI10 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI10.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';
  elements.get('rectWidthInput').value = '80';
  elements.get('rectHeightInput').value = '60';
  elements.get('rectSaInput').value = '10';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl.startsWith('/')) {
        return nativeFetch(`${baseUrl}${sUrl}`, init);
      }
      return nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?t10i10=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;

    // 1. B10-01: Keyboard/non-pointer slider edit (input x2 + change without pointerdown)
    assert.equal(elements.get('btnUndo').disabled, true, 'Initial load has empty undo history');
    const initChest = st.pattern.params.chestMm;
    const sliderContainer = elements.get('parametricSlidersContainer');
    assert.ok(sliderContainer.children.length > 0, 'Parametric sliders rendered');
    const firstSlider = sliderContainer.children[0].children[1];

    firstSlider.value = String(initChest + 20);
    firstSlider.dispatchEvent({ type: 'input' });
    firstSlider.value = String(initChest + 40);
    firstSlider.dispatchEvent({ type: 'input' });
    firstSlider.dispatchEvent({ type: 'change' });

    assert.equal(st.pattern.params.chestMm, initChest + 40);
    assert.equal(elements.get('btnUndo').disabled, false, 'B10-01: Non-pointer slider input enables btnUndo');

    // Undo must pop exactly 1 snapshot for the gesture, restoring initial chestMm
    elements.get('btnUndo').click();
    assert.equal(st.pattern.params.chestMm, initChest, 'B10-01: Undo restores pre-edit chestMm');
    assert.equal(elements.get('btnUndo').disabled, true, 'B10-01: Single gesture pushed exactly 1 snapshot');

    // Redo restores edited chestMm
    elements.get('btnRedo').click();
    assert.equal(st.pattern.params.chestMm, initChest + 40, 'B10-01: Redo restores edited chestMm');

    // 2. OBS-05: Fresh STL load resets materialId back to veg_leather while re-unwrap preserves it
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_assembled_view.stl');
    assert.equal(st.templateId, 'stl_cover');
    assert.equal(st.pattern.materialId, 'veg_leather');

    elements.get('materialPresetSelect').value = 'eva_foam_4mm';
    elements.get('materialPresetSelect').dispatchEvent({ type: 'change' });
    assert.equal(st.pattern.materialId, 'eva_foam_4mm');

    // Re-unwrap via stlSaInput change preserves active STL materialId
    elements.get('stlSaInput').value = '12';
    elements.get('stlSaInput').dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.params?.seamAllowance === 12);
    assert.equal(st.pattern.materialId, 'eva_foam_4mm', 'reUnwrapActiveStl preserves active STL materialId');

    // Fresh STL load resets materialId alongside materialOverrides and history
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_print_ready.stl');
    assert.equal(st.pattern.materialId, 'veg_leather', 'OBS-05: Fresh STL load resets materialId to veg_leather');
    assert.deepEqual(st.materialOverrides, {});
    assert.equal(elements.get('btnUndo').disabled, true);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});


test('adv_i11_core_extremes: BUG-I11-01..03 unwrapSTLToPattern 1e308, createFreeformPiece span overflow, nesting unfittedPieces', async () => {
  // 1. BUG-I11-01: unwrapSTLToPattern with extreme / non-finite easeMm, thicknessMm, seamAllowance, scale
  const stlAscii = [
    'solid wedge_box',
    // bottom
    'facet normal 0 0 -1\n outer loop\n  vertex 0 0 0\n  vertex 40 0 0\n  vertex 40 30 0\n endloop\nendfacet',
    'facet normal 0 0 -1\n outer loop\n  vertex 0 0 0\n  vertex 40 30 0\n  vertex 0 30 0\n endloop\nendfacet',
    // top
    'facet normal 0 0 1\n outer loop\n  vertex 0 0 20\n  vertex 40 30 20\n  vertex 40 0 20\n endloop\nendfacet',
    'facet normal 0 0 1\n outer loop\n  vertex 0 0 20\n  vertex 0 30 20\n  vertex 40 30 20\n endloop\nendfacet',
    // front (y=0)
    'facet normal 0 -1 0\n outer loop\n  vertex 0 0 0\n  vertex 40 0 20\n  vertex 40 0 0\n endloop\nendfacet',
    'facet normal 0 -1 0\n outer loop\n  vertex 0 0 0\n  vertex 0 0 20\n  vertex 40 0 20\n endloop\nendfacet',
    // back (y=30)
    'facet normal 0 1 0\n outer loop\n  vertex 0 30 0\n  vertex 40 30 0\n  vertex 40 30 20\n endloop\nendfacet',
    'facet normal 0 1 0\n outer loop\n  vertex 0 30 0\n  vertex 40 30 20\n  vertex 0 30 20\n endloop\nendfacet',
    // left (x=0)
    'facet normal -1 0 0\n outer loop\n  vertex 0 0 0\n  vertex 0 30 20\n  vertex 0 0 20\n endloop\nendfacet',
    'facet normal -1 0 0\n outer loop\n  vertex 0 0 0\n  vertex 0 30 0\n  vertex 0 30 20\n endloop\nendfacet',
    // right (x=40)
    'facet normal 1 0 0\n outer loop\n  vertex 40 0 0\n  vertex 40 0 20\n  vertex 40 30 20\n endloop\nendfacet',
    'facet normal 1 0 0\n outer loop\n  vertex 40 0 0\n  vertex 40 30 20\n  vertex 40 30 0\n endloop\nendfacet',
    'endsolid wedge_box',
  ].join('\n');
  const parsedMesh = core.parseSTL(stlAscii, 'wedge_box.stl');

  for (const mode of ['form_shell_cover', 'surface_panels']) {
    for (const opts of [
      { mode, easeMm: 1e308, thicknessMm: 1e308, seamAllowance: 1e308, scale: 1e308 },
      { mode, easeMm: -1e308, thicknessMm: Infinity, seamAllowance: NaN, scale: -5 },
    ]) {
      const pat = core.unwrapSTLToPattern(parsedMesh, opts);
      const val = core.validatePatternProject(pat, { throwOnError: false });
      assert.equal(val.valid, true, `BUG-I11-01 (${mode}): ${val.errors[0]?.message}`);
      assert.ok(pat.pieces.length >= 1);
      for (const pc of pat.pieces) {
        assert.ok(Number.isFinite(pc.position.x) && Number.isFinite(pc.position.y), 'piece position must be finite');
        for (const pt of pc.points) {
          assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), 'piece vertex must be finite');
        }
      }
      assert.ok(pat.params.easeMm <= 500 && pat.params.easeMm >= 0);
      assert.ok(pat.params.thicknessMm <= 100 && pat.params.thicknessMm >= 0);
      assert.ok(pat.params.seamAllowance <= 200 && pat.params.seamAllowance >= 0);
      assert.ok(pat.params.scale <= 100 && pat.params.scale >= 0.01);
    }
  }

  // Oversized pre-parsed mesh object must be cleanly rejected with ValidationError
  assert.throws(
    () =>
      core.unwrapSTLToPattern({
        vertices: [{ x: -1e308, y: 0, z: 0 }, { x: 1e308, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        triangles: [{ v0: 0, v1: 1, v2: 2 }],
        faces: [{ indices: [0, 1, 2], area: 1, normal: { x: 0, y: 0, z: 1 }, centroid: { x: 0, y: 3, z: 0 } }],
        adjacency: [[]],
      }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_STL'
  );

  // 2. BUG-I11-02: createFreeformPiece rejects [-1e308, +1e308] span or shifted coordinate overflow cleanly
  assert.throws(
    () =>
      core.createFreeformPiece('huge_span', [
        { x: -1e308, y: 0 },
        { x: 1e308, y: 0 },
        { x: 1e308, y: 100 },
        { x: -1e308, y: 100 },
      ]),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.throws(
    () =>
      core.createFreeformPiece(
        'huge_shift_origin',
        [
          { x: -1e308, y: 0 },
          { x: -1e308 + 1e306, y: 0 },
          { x: -1e308 + 1e306, y: 100 },
          { x: -1e308, y: 100 },
        ],
        { rotationOrigin: { x: 1e308, y: 50 } }
      ),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );

  // 3. BUG-I11-03: nestPatternPieces emits finite unfittedPieces dimensions & JSON-safe result on [-1e308, +1e308]
  const rawHugePiece = {
    id: 'huge_raw',
    name: 'Huge Raw Piece',
    points: [
      { x: -1e308, y: 0 },
      { x: 1e308, y: 0 },
      { x: 1e308, y: 100 },
      { x: -1e308, y: 100 },
    ],
    seamAllowance: 0,
    quantity: 1,
  };
  const nestedHuge = core.nestPatternPieces({ unit: 'mm', pieces: [rawHugePiece] });
  assert.equal(nestedHuge.unfittedPieces.length, 1);
  assert.ok(Number.isFinite(nestedHuge.unfittedPieces[0].widthMm), 'unfittedPieces[0].widthMm must be finite');
  assert.ok(Number.isFinite(nestedHuge.unfittedPieces[0].heightMm), 'unfittedPieces[0].heightMm must be finite');
  const roundTrip = JSON.parse(JSON.stringify(nestedHuge));
  assert.equal(typeof roundTrip.unfittedPieces[0].widthMm, 'number');
  assert.equal(typeof roundTrip.unfittedPieces[0].heightMm, 'number');
});

test('T5-I11-01: B11-01 refreshUnitLabelsAndInputs on non-stl_cover tshirt never clobbers #stl* defaults and updates under unit toggles', async () => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  const htmlTextI11 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI11.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';
  elements.get('rectWidthInput').value = '80';
  elements.get('rectHeightInput').value = '60';
  elements.get('rectSaInput').value = '10';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl.startsWith('/')) {
        return nativeFetch(`${baseUrl}${sUrl}`, init);
      }
      return nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?t11i11=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;

    // 1. Default template (tshirt has params.easeMm = 80) MUST NOT clobber #stlEaseInput ('2')
    assert.equal(st.templateId, 'tshirt');
    assert.equal(st.pattern.params.easeMm, 80);
    assert.equal(elements.get('stlEaseInput').value, '2', 'B11-01: default tshirt must not overwrite #stlEaseInput to 80');
    assert.equal(elements.get('stlThicknessInput').value, '0');
    assert.equal(elements.get('stlSaInput').value, '10');
    assert.equal(elements.get('stlScaleInput').value, '1');

    // 2. Unit toggle on non-stl_cover converts #stl* inputs using their own value, never tshirt.params.easeMm
    elements.get('unitSelect').value = 'cm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('stlEaseInput').value, '0.2', 'B11-01: cm toggle converts #stlEaseInput from 2mm to 0.2cm');
    assert.equal(elements.get('stlSaInput').value, '1');

    // 3. Loading STL while in cm unwraps with easeMm=2 (converted from 0.2cm), NOT clamped 50
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_assembled_view.stl');
    assert.equal(st.templateId, 'stl_cover');
    assert.equal(st.pattern.params.easeMm, 2, 'B11-01: fresh STL load unwraps with easeMm=2');
    assert.equal(elements.get('stlEaseInput').value, '0.2');

    // 4. Unit toggle under stl_cover updates #stl* inputs accurately from pattern.params
    elements.get('unitSelect').value = 'mm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('stlEaseInput').value, '2');
    assert.equal(elements.get('stlSaInput').value, '10');

    elements.get('stlEaseInput').value = '4';
    elements.get('stlEaseInput').dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.params?.easeMm === 4);
    assert.equal(st.pattern.params.easeMm, 4);

    elements.get('unitSelect').value = 'cm';
    elements.get('unitSelect').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('stlEaseInput').value, '0.4', 'Unit toggle under stl_cover updates #stlEaseInput to 0.4cm');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});


test('adv_i12_core_extremes: nesting Infinity/NaN, split/mirror overflow, extreme polygon metrics & empty-pattern export bounds', () => {
  // 1. BUG-I12-01: multi-sheet nesting with 1e308 roll/sheet lengths & 1e307 pieces never emits Infinity/NaN
  const bigPieces = [
    {
      id: 'big1',
      name: 'Big1',
      quantity: 1,
      points: [
        { x: 0, y: 0 },
        { x: 9e307, y: 0 },
        { x: 9e307, y: 9e307 },
        { x: 0, y: 9e307 },
      ],
      seamAllowance: 0,
    },
    {
      id: 'big2',
      name: 'Big2',
      quantity: 1,
      points: [
        { x: 0, y: 0 },
        { x: 9e307, y: 0 },
        { x: 9e307, y: 9e307 },
        { x: 0, y: 9e307 },
      ],
      seamAllowance: 0,
    },
  ];
  const nestedHuge = core.nestPatternPieces(
    { unit: 'mm', pieces: bigPieces },
    { fabricWidthMm: 1e308, sheetLengthMm: 1e308, marginMm: 0 }
  );
  assert.equal(nestedHuge.sheets.length, 2, 'two 9e307 pieces require 2 sheets on 1e308 sheetLengthMm');
  for (const field of [
    'requiredLengthMm',
    'usedLengthMm',
    'requiredMeters',
    'requiredYards',
    'utilizationPct',
    'wastePct',
  ]) {
    assert.ok(Number.isFinite(nestedHuge[field]), `BUG-I12-01: ${field} must be finite (got ${nestedHuge[field]})`);
  }
  assert.ok(nestedHuge.utilizationPct > 0 && nestedHuge.utilizationPct <= 100, `utilizationPct valid: ${nestedHuge.utilizationPct}`);
  for (const sh of nestedHuge.sheets) {
    assert.ok(Number.isFinite(sh.usedLengthMm), `sheet ${sh.sheetIndex} usedLengthMm finite`);
    assert.ok(Number.isFinite(sh.utilizationPct) && sh.utilizationPct > 0 && sh.utilizationPct <= 100);
  }
  for (const pl of nestedHuge.placements) {
    assert.ok(Number.isFinite(pl.areaMm2), `placement ${pl.pieceId} areaMm2 finite`);
  }

  // Also test standard fabricWidthMm: 1500 with multi-sheet sheetLengthMm: 1e308 and normal pieces + custom 1e308
  const nestedNormal = core.nestPatternPieces(
    core.generateTemplatePattern('tshirt'),
    { fabricWidthMm: 1500, sheetLengthMm: 1e308 }
  );
  assert.ok(Number.isFinite(nestedNormal.requiredLengthMm) && Number.isFinite(nestedNormal.utilizationPct));

  // 2. BUG-I12-02: lerp2, splitPieceEdge, mirrorPieceAcrossEdge on [-1e308, +1e308] spans
  const midDiag = core.lerp2({ x: -1e308, y: -1e308 }, { x: 1e308, y: 1e308 }, 0.5);
  assert.deepEqual(midDiag, { x: 0, y: 0 });
  assert.deepEqual(core.lerp2({ x: -1e308, y: 0 }, { x: 1e308, y: 0 }, 0.25), { x: -5e307, y: 0 });

  const spanPattern = {
    unit: 'mm',
    pieces: [
      {
        id: 'span_piece',
        name: 'Span',
        points: [
          { x: -1e308, y: 0 },
          { x: 1e308, y: 0 },
          { x: 0, y: 1e307 },
        ],
        edges: [
          { name: 'E0', seamAllowance: 0 },
          { name: 'E1', seamAllowance: 0 },
          { name: 'E2', seamAllowance: 0 },
        ],
      },
    ],
    seams: [
      { id: 's1', pieceA: 'span_piece', edgeA: 0, tStartA: 0, tEndA: 1, pieceB: 'span_piece', edgeB: 1, tStartB: 0, tEndB: 1 },
    ],
  };
  const spanPiece = spanPattern.pieces[0];
  core.splitPieceEdge(spanPiece, 0, 0.5, spanPattern);
  assert.equal(spanPiece.points.length, 4);
  for (const pt of spanPiece.points) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), `BUG-I12-02: split point finite (${pt.x}, ${pt.y})`);
  }
  assert.equal(spanPiece.points[1].x, 0);
  assert.equal(spanPiece.points[1].y, 0);
  for (const sm of spanPattern.seams) {
    assert.ok(Number.isFinite(sm.tStartA) && Number.isFinite(sm.tEndA), 'seam split fractions must be finite');
    assert.ok(Number.isFinite(sm.tStartB) && Number.isFinite(sm.tEndB), 'seam B fractions must be finite');
  }

  // mirrorPieceAcrossEdge on [-1e308, +1e308] refuses non-finite bounds cleanly instead of emitting Infinity vertices
  const mirrorSpanPiece = {
    id: 'mirror_span',
    name: 'MirrorSpan',
    points: [
      { x: -1e308, y: 0 },
      { x: 1e308, y: 0 },
      { x: 0, y: 1e307 },
    ],
  };
  assert.throws(
    () => core.mirrorPieceAcrossEdge(mirrorSpanPiece, 0, { unit: 'mm', pieces: [mirrorSpanPiece], seams: [] }),
    (err) => err?.code === 'INVALID_POINTS'
  );

  // 3. BUG-I12-03: extreme polygon area/centroid/measurements & createRectanglePiece upper bound
  assert.throws(
    () => core.createRectanglePiece('TooBigMax', 1e308, 100),
    (err) => err?.code === 'INVALID_DIMENSIONS'
  );
  assert.throws(
    () => core.createRectanglePiece('TooBigBound', 1e16, 100),
    (err) => err?.code === 'INVALID_DIMENSIONS'
  );
  assert.equal(core.createRectanglePiece('SafeLarge', 1e6, 1e6).points.length, 4);

  const hugeSquare = [
    { x: 0, y: 0 },
    { x: 1e307, y: 0 },
    { x: 1e307, y: 1e307 },
    { x: 0, y: 1e307 },
  ];
  assert.ok(Number.isFinite(core.signedPolygonArea(hugeSquare)), 'signedPolygonArea finite on 1e307 polygon');
  assert.ok(Number.isFinite(core.polygonArea(hugeSquare)), 'polygonArea finite on 1e307 polygon');
  const cent = core.polygonCentroid(hugeSquare);
  assert.ok(Number.isFinite(cent.x) && Number.isFinite(cent.y), `polygonCentroid finite (${cent.x}, ${cent.y})`);
  assertNear(cent.x, 5e306, 1e295, 'polygonCentroid X on 1e307 square');
  assertNear(cent.y, 5e306, 1e295, 'polygonCentroid Y on 1e307 square');

  const hugeMeasMm = core.computePieceMeasurements({ id: 'h', points: hugeSquare }, 'mm');
  const hugeMeasCm = core.computePieceMeasurements({ id: 'h', points: hugeSquare }, 'cm');
  for (const m of [hugeMeasMm, hugeMeasCm]) {
    assert.ok(Number.isFinite(m.netAreaMm2) && Number.isFinite(m.netPerimeterMm));
    assert.ok(Number.isFinite(m.netAreaCm2) && Number.isFinite(m.netPerimeter));
    assert.ok(Number.isFinite(m.centroidMm.x) && Number.isFinite(m.centroidMm.y));
  }

  // 4. BUG-I12-04: empty pattern export with extreme marginMm / pageWidthMm rejects with EXPORT_TOO_LARGE (and PDF clamps marginMm)
  for (const fn of [
    () => core.exportSVG({ unit: 'mm', pieces: [] }, { marginMm: 1e308 }),
    () => core.exportDXF({ unit: 'mm', pieces: [] }, { marginMm: 1e308 }),
    () => core.exportTiledPDF({ unit: 'mm', pieces: [] }, { pageFormat: 'custom', pageWidthMm: 1e308, pageHeightMm: 297 }),
  ]) {
    assert.throws(fn, (err) => err?.code === 'EXPORT_TOO_LARGE');
  }
  const pdfClampedMargin = core.exportTiledPDF({ unit: 'mm', pieces: [] }, { marginMm: 1e308 });
  assert.ok(pdfClampedMargin.pdfString.startsWith('%PDF-1.4'));
});

test('T5-I12-01 (BUG-12-01): app.mjs JSON import sanitizes custom material.id for HTTP 200 export and adopts preset material.id thickness', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', publicDir: PUBLIC_DIR });
  const addr = srv.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const htmlTextI12 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set();
  for (const m of htmlTextI12.matchAll(/\bid="([^"]+)"/g)) {
    htmlIds.add(m[1]);
  }
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';
  const fetchLogs = [];

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      const res = sUrl.startsWith('/') ? await nativeFetch(`${baseUrl}${sUrl}`, init) : await nativeFetch(url, init);
      fetchLogs.push({ url: sUrl, status: res.status });
      return res;
    };

    const appMod = await import(`../public/app.mjs?t12i12=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;

    // A. Custom material.id ('custom_linen') must sanitize materialId -> 'cotton_jersey', strip id from materialOverrides, and export HTTP 200
    const customPattern = core.generateTemplatePattern('tshirt');
    delete customPattern.materialId;
    customPattern.material = { id: 'custom_linen', thicknessMm: 0.9 };
    const customJson = JSON.stringify(customPattern);

    const jsonInput = elements.get('jsonFileInput');
    jsonInput.files = [{ name: 'custom_linen.json', text: async () => customJson }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.materialOverrides?.thicknessMm === 0.9);

    assert.equal(st.pattern.materialId, 'cotton_jersey', 'BUG-12-01: unknown material.id falls back to cotton_jersey');
    assert.equal(Object.prototype.hasOwnProperty.call(st.materialOverrides, 'id'), false, 'id must be stripped from state.materialOverrides');
    assert.equal(elements.get('materialPresetSelect').value, 'cotton_jersey');

    fetchLogs.length = 0;
    elements.get('btnExportSVG').click();
    await waitUntil(() => fetchLogs.some((l) => l.url === '/api/export'));
    const svgResA = fetchLogs.find((l) => l.url === '/api/export');
    assert.equal(svgResA.status, 200, 'BUG-12-01: SVG export after custom material.id JSON import must return HTTP 200');
    assert.equal(elements.get('studioToast').classList.contains('toast-error'), false, 'no error toast on valid SVG export');

    // B. Preset-only material.id ('heavy_fleece') without top-level materialId must adopt 'heavy_fleece' preset & thickness (2.10 mm)
    const presetPattern = core.generateTemplatePattern('tshirt');
    delete presetPattern.materialId;
    presetPattern.material = { id: 'heavy_fleece', gsm: 320 };
    const presetJson = JSON.stringify(presetPattern);

    jsonInput.files = [{ name: 'heavy_fleece.json', text: async () => presetJson }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.materialId === 'heavy_fleece' && st.materialOverrides?.gsm === 320);

    assert.equal(st.pattern.materialId, 'heavy_fleece');
    assert.equal(Object.prototype.hasOwnProperty.call(st.materialOverrides, 'id'), false);
    assert.equal(elements.get('materialPresetSelect').value, 'heavy_fleece');
    assert.equal(
      elements.get('matThickLabel').textContent,
      `${core.MATERIAL_PRESETS.heavy_fleece.thicknessMm.toFixed(2)} mm`,
      'BUG-12-01: preset thicknessMm matches heavy_fleece (2.10 mm)'
    );

    fetchLogs.length = 0;
    elements.get('btnExportSVG').click();
    await waitUntil(() => fetchLogs.some((l) => l.url === '/api/export'));
    const svgResB = fetchLogs.find((l) => l.url === '/api/export');
    assert.equal(svgResB.status, 200);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i13_core_extremes: BUG-I13-01..03 nesting spacingMm/marginMm overflow, exporters nestingResult overflow, computeSeamWalkTransform span, OBS-I13-01 unit overflow', () => {
  // 1. BUG-I13-01: overflowing spacingMm / marginMm options reject cleanly with INVALID_OPTIONS, and multi-sheet 9e307 on infinite roll stays finite with 0 overlaps
  const tshirt = core.generateTemplatePattern('tshirt');
  for (const badNestOpts of [
    { spacingMm: 1e308 },
    { marginMm: 1e308 },
    { fabricWidthMm: 1e308, spacingMm: 1e308, marginMm: 0 },
  ]) {
    assert.throws(
      () => core.nestPatternPieces(tshirt, badNestOpts),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_OPTIONS',
      `BUG-I13-01: expected INVALID_OPTIONS for ${JSON.stringify(badNestOpts)}`
    );
  }

  const bigSq = (id) => ({
    id,
    name: id,
    quantity: 1,
    points: [
      { x: 0, y: 0 },
      { x: 9e307, y: 0 },
      { x: 9e307, y: 9e307 },
      { x: 0, y: 9e307 },
    ],
    seamAllowance: 0,
  });
  const multiRollHuge = core.nestPatternPieces(
    { unit: 'mm', pieces: [bigSq('b1'), bigSq('b2'), bigSq('b3')] },
    { fabricWidthMm: 1e308, sheetLengthMm: null, marginMm: 0 }
  );
  assert.equal(multiRollHuge.placements.length, 3);
  assert.ok(multiRollHuge.placements.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.maxX) && Number.isFinite(p.maxY)));
  assert.ok(Number.isFinite(multiRollHuge.utilizationPct) && multiRollHuge.utilizationPct > 0);

  // 2. BUG-I13-02: options.nestingResult overflow throws EXPORT_TOO_LARGE across SVG, DXF, PDF (single and multi-piece)
  const p1 = { id: 'p1', name: 'P1', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], seamAllowance: 0 };
  const p2 = { id: 'p2', name: 'P2', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], seamAllowance: 0 };
  const singleOverflowNest = {
    sheetLengthMm: 1e200,
    placements: [{ pieceIndex: 0, pieceId: 'p1', sheetIndex: 1e200, x: 0, y: 0 }],
  };
  const multiOverflowNest = {
    sheetLengthMm: 1e200,
    placements: [
      { pieceIndex: 0, pieceId: 'p1', sheetIndex: 0, x: 0, y: 0 },
      { pieceIndex: 1, pieceId: 'p2', sheetIndex: 1e200, x: 0, y: 0 },
    ],
  };
  for (const [pat, nestRes] of [
    [{ unit: 'mm', pieces: [p1], seams: [] }, singleOverflowNest],
    [{ unit: 'mm', pieces: [p1, p2], seams: [] }, multiOverflowNest],
  ]) {
    for (const fn of [
      () => core.exportSVG(pat, { layout: 'nested', nestingResult: nestRes }),
      () => core.exportDXF(pat, { layout: 'nested', nestingResult: nestRes }),
      () => core.exportTiledPDF(pat, { layout: 'nested', nestingResult: nestRes }),
    ]) {
      assert.throws(
        fn,
        (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
        'BUG-I13-02: overflowing nestingResult must throw EXPORT_TOO_LARGE'
      );
    }
  }

  // 3. BUG-I13-03: computeSeamWalkTransform rejects opposite-sign +-1e308 translation overflow with INVALID_POINTS
  const walkSpanPat = {
    unit: 'mm',
    pieces: [
      { id: 'a', position: { x: 1e308, y: 1e308 }, rotation: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { id: 'b', position: { x: 0, y: 0 }, rotation: 0, points: [{ x: -1e308, y: -1e308 }, { x: -1e308 + 10, y: -1e308 }, { x: -1e308 + 10, y: -1e308 + 10 }] },
    ],
    seams: [{ id: 's', pieceA: 'a', edgeA: 0, pieceB: 'b', edgeB: 0 }],
  };
  assert.throws(
    () => core.computeSeamWalkTransform(walkSpanPat, 's', 5),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS',
    'BUG-I13-03: computeSeamWalkTransform overflow must throw INVALID_POINTS'
  );

  // 4. OBS-I13-01: ClothSimulation / runSimulationSteps rejects unit:'in' 1e307 overflow with INVALID_POINTS
  assert.throws(
    () =>
      core.runSimulationSteps(
        {
          unit: 'in',
          pieces: [{ id: 'p', points: [{ x: 0, y: 0 }, { x: 1e307, y: 0 }, { x: 1e307, y: 1e307 }, { x: 0, y: 1e307 }] }],
          seams: [],
        },
        { steps: 5 }
      ),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS',
    'OBS-I13-01: unit=in 1e307 overflow in physics must throw INVALID_POINTS'
  );
});

test('T5-I13-01: BUG-13-01 preset-only pattern.material.id in ClothSimulation & /api/simulate, BUG-13-02 orphan stl_cover slider guard, OBS-13-01..04', async () => {
  // 1. BUG-13-01: Direct ClothSimulation + POST /api/simulate preset-only pattern.material.id parity
  const patWithId = core.generateTemplatePattern('tshirt');
  patWithId.materialId = 'heavy_fleece';
  patWithId.material = { id: 'heavy_fleece', gsm: 320 };

  const patWithoutId = core.generateTemplatePattern('tshirt');
  delete patWithoutId.materialId;
  patWithoutId.material = { id: 'heavy_fleece', gsm: 320 };

  const simWithoutId = new core.ClothSimulation(patWithoutId, {});
  assert.equal(simWithoutId.material.id, 'heavy_fleece');
  assert.equal(simWithoutId.material.name, core.MATERIAL_PRESETS.heavy_fleece.name);
  assert.equal(simWithoutId.material.thicknessMm, core.MATERIAL_PRESETS.heavy_fleece.thicknessMm);
  assert.equal(simWithoutId.material.bendStiffness, core.MATERIAL_PRESETS.heavy_fleece.bendStiffness);
  assert.equal(simWithoutId.material.maxSafeStrainPct, core.MATERIAL_PRESETS.heavy_fleece.maxSafeStrainPct);
  assert.equal(simWithoutId.material.gsm, 320);

  const srv = await startServer({ port: 0, host: '127.0.0.1', publicDir: PUBLIC_DIR });
  const baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
  const htmlTextI13 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlTextI13.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const canvas2dCtx = { ...createMock2DContext(), putImageData() {} };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return id === 'canvas2D' ? canvas2dCtx : { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    const [resWithId, resWithoutId] = await Promise.all([
      nativeFetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: patWithId, steps: 15 }),
      }),
      nativeFetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: patWithoutId, steps: 15 }),
      }),
    ]);
    assert.equal(resWithId.status, 200);
    assert.equal(resWithoutId.status, 200);
    const simWithJson = await resWithId.json();
    const simWithoutJson = await resWithoutId.json();
    assert.equal(simWithoutJson.strainReport.maxSafeStrainPct, 14);
    assert.equal(simWithoutJson.strainReport.fitStatus, simWithJson.strainReport.fitStatus);
    assert.equal(simWithoutJson.strainReport.maxStrainPct, simWithJson.strainReport.maxStrainPct);
    assert.equal(simWithoutJson.avgSewGapMm, simWithJson.avgSewGapMm);
    assert.deepEqual(simWithoutJson.particles[0].pos, simWithJson.particles[0].pos);

    // 2. OBS-13-02: WebGL3DViewport._render2DFallback expands 3-digit #RGB hex (#abc -> #aabbcc)
    const { createViewport3D } = await import(`../public/webgl3d.mjs?obs13=${Date.now()}`);
    const fallbackFills = [];
    const fallbackCtx = {
      ...createMock2DContext(),
      set fillStyle(v) { fallbackFills.push(v); },
      get fillStyle() { return fallbackFills[fallbackFills.length - 1] || ''; },
    };
    const fallbackCanvas = {
      width: 320,
      height: 240,
      getContext(type) { return type === '2d' ? fallbackCtx : null; },
      addEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const vpFallback = createViewport3D(fallbackCanvas);
    const miniSim = new core.ClothSimulation(
      { unit: 'mm', pieces: [core.createRectanglePiece('Mini', 80, 80)], seams: [] },
      { avatar: null }
    );
    vpFallback.setScene({
      sim: miniSim,
      showForm: false,
      showStrainMap: false,
      materialConfig: { warpColor: '#abc' },
    });
    vpFallback.render();
    const triFill3 = fallbackFills.find((f) => typeof f === 'string' && f.startsWith('rgb('));
    assert.ok(triFill3, 'Expected rgb() cloth triangle fill in 2D fallback');
    const [r3, g3, b3] = triFill3.match(/\d+/g).map(Number);
    assert.ok(r3 > 100 && g3 > 100 && b3 > 100, `OBS-13-02: #abc must expand to #aabbcc, not 0x000abc (got ${triFill3})`);

    // 3. Frontend checks: BUG-13-02, OBS-13-01, OBS-13-03, OBS-13-04
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?t13i13=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;

    // OBS-13-03: rectWidthInput / rectHeightInput / rectSaInput bounds match handler clamps
    assert.equal(elements.get('rectWidthInput').max, '3000');
    assert.equal(elements.get('rectHeightInput').max, '3000');
    assert.equal(elements.get('rectSaInput').max, '100');

    // OBS-13-01: Ctrl+F / Meta+F must NOT trigger CAD2D fitToContent/draw2D, whereas plain 'f' does
    const beforeCtrlF = canvas2dCtx.ops.length;
    globalThis.window.dispatchEvent({ type: 'keydown', key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} });
    globalThis.window.dispatchEvent({ type: 'keydown', key: 'f', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, preventDefault() {} });
    assert.equal(canvas2dCtx.ops.length, beforeCtrlF, 'OBS-13-01: Ctrl+F / Cmd+F must not hijack browser find to redraw 2D canvas');
    globalThis.window.dispatchEvent({ type: 'keydown', key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} });
    assert.ok(canvas2dCtx.ops.length > beforeCtrlF, 'Plain "f" shortcut still fits and redraws 2D canvas');

    // BUG-13-02: Orphan stl_cover.json disables parametric sliders & prevents overwriting pattern with M1 wedge stub
    const boxStl = core.parseSTL(core.createBoxSTL(100, 80, 40), 'custom_box.stl');
    const customCover = core.unwrapSTLToPattern(boxStl, { mode: 'form_shell_cover' });
    customCover.pieces[0].name = 'CustomUnwrappedShell';
    const customPieceCount = customCover.pieces.length;
    const jsonInput = elements.get('jsonFileInput');
    jsonInput.files = [{ name: 'orphan_cover.json', text: async () => JSON.stringify(customCover) }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.templateId === 'stl_cover' && st.pattern?.pieces?.[0]?.name === 'CustomUnwrappedShell');

    assert.equal(st.activeStlMesh, null);
    const slidersBox = elements.get('parametricSlidersContainer');
    const sliderRows = slidersBox.children.filter((c) => c.className === 'slider-row');
    assert.equal(sliderRows.length, 4);
    for (const row of sliderRows) {
      assert.equal(row.children[1].disabled, true, 'BUG-13-02: orphan stl_cover sliders must be disabled');
    }
    assert.match(slidersBox.children.at(-1).textContent, /Load matching \.stl/i);

    // Even if an input event fires directly on a slider, it must NOT overwrite imported cover with M1 wedge stub
    sliderRows[0].children[1].value = '5';
    sliderRows[0].children[1].dispatchEvent({ type: 'input' });
    assert.equal(st.pattern.pieces[0].name, 'CustomUnwrappedShell');
    assert.equal(st.pattern.pieces.length, customPieceCount);
    assert.ok(!st.pattern.isStub, 'BUG-13-02: orphan stl_cover slider input must never replace pattern with M1 stub');

    // OBS-13-04: Undo back to initial tshirt leaves state.materialOverrides empty ({})
    elements.get('btnUndo').click();
    assert.equal(st.templateId, 'tshirt');
    assert.equal(Object.keys(st.materialOverrides).length, 0, 'OBS-13-04: Undo back to default preset clears state.materialOverrides');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i14_core_extremes: BUG-I14-01..05 and exporters extreme placement guards', async () => {
  const rect = (w, h) => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];

  // --- BUG-I14-01: segmentIntersection2D & polygonSelfIntersects at extreme magnitudes ---
  for (const M of [1e155, 1e200, 1e300]) {
    const segHit = core.segmentIntersection2D(
      { x: 0, y: 0 },
      { x: M, y: M },
      { x: 0, y: M },
      { x: M, y: 0 },
    );
    assert.ok(segHit !== null, `BUG-I14-01: diagonal X at ${M} should intersect`);
    assert.equal(segHit.collinear, false);
    assert.ok(
      Math.abs(segHit.point.x - 0.5 * M) <= M * 1e-12 && Math.abs(segHit.point.y - 0.5 * M) <= M * 1e-12,
      `BUG-I14-01: midpoint accuracy at ${M}, got (${segHit.point.x}, ${segHit.point.y})`,
    );

    const bowtie = [
      { x: 0, y: 0 },
      { x: M, y: M },
      { x: M, y: 0 },
      { x: 0, y: M },
    ];
    assert.equal(core.polygonSelfIntersects(bowtie), true, `BUG-I14-01: bowtie at ${M} should self-intersect`);

    const cleanSquare = rect(M, M);
    assert.equal(core.polygonSelfIntersects(cleanSquare), false, `BUG-I14-01: clean square at ${M} must not self-intersect`);
  }

  // Span [-1e308, +1e308] intersecting segments & collinear overlap
  const wideHit = core.segmentIntersection2D(
    { x: -1e308, y: -1e308 },
    { x: 1e308, y: 1e308 },
    { x: -1e308, y: 1e308 },
    { x: 1e308, y: -1e308 },
  );
  assert.ok(wideHit !== null, 'BUG-I14-01: [-1e308, 1e308] X segments should intersect');
  assert.ok(Math.abs(wideHit.point.x) <= 1e295 && Math.abs(wideHit.point.y) <= 1e295);

  const collinearOverlap = core.segmentIntersection2D(
    { x: 0, y: 0 },
    { x: 2e200, y: 2e200 },
    { x: 1e200, y: 1e200 },
    { x: 3e200, y: 3e200 },
  );
  assert.ok(collinearOverlap !== null, 'BUG-I14-01: collinear overlap at 1e200 should intersect');
  assert.equal(collinearOverlap.collinear, true);

  // Normal < 1e140 parity check
  const normalHit = core.segmentIntersection2D(
    { x: 10, y: 20 },
    { x: 50, y: 60 },
    { x: 10, y: 60 },
    { x: 50, y: 20 },
  );
  assert.ok(normalHit !== null);
  assert.ok(Math.abs(normalHit.point.x - 30) < 1e-12 && Math.abs(normalHit.point.y - 40) < 1e-12);

  // --- BUG-I14-02: extreme seamAllowance throws ValidationError instead of silently dropping ---
  for (const sa of [1e16, 1e307, 1e308]) {
    assert.throws(
      () => core.offsetPolygonOutward(rect(100, 100), sa),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_DIMENSIONS',
      `BUG-I14-02: offsetPolygonOutward(${sa}) should throw ValidationError`,
    );

    const pieceFast = core.createPatternPiece({
      id: 'sa-fast',
      name: 'SA Fast',
      points: rect(100, 100),
      seamAllowance: sa,
    });
    assert.throws(
      () => core.computePieceCutBoundary(pieceFast),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_DIMENSIONS',
      `BUG-I14-02: computePieceCutBoundary fast path(${sa}) should throw ValidationError`,
    );

    const pieceDarted = core.createPatternPiece({
      id: 'sa-darted',
      name: 'SA Darted',
      points: rect(100, 100),
      seamAllowance: 10,
      edges: [{ index: 0, seamAllowance: sa }],
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 40, folded: true }],
    });
    assert.throws(
      () => core.computePieceCutBoundary(pieceDarted),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_DIMENSIONS',
      `BUG-I14-02: computePieceCutBoundary darted path(${sa}) should throw ValidationError`,
    );
  }

  // Normal seamAllowance on extreme 1e308 polygon must still be allowed (no regression for nesting tests)
  const hugePolyPiece = core.createPatternPiece({
    id: 'huge-sa-ok',
    name: 'Huge Poly',
    points: rect(1e308, 1e308),
    seamAllowance: 10,
  });
  const hugeCut = core.computePieceCutBoundary(hugePolyPiece);
  assert.ok(Array.isArray(hugeCut) && hugeCut.length >= 4);

  // --- BUG-I14-03: folded dart cap peak cancellation & unfolded dart clamping ---
  const baseFolded = core.createPatternPiece({
    id: 'dart-80',
    name: 'Dart 80',
    points: rect(100, 100),
    seamAllowance: 10,
    darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm: 80, folded: true }],
  });
  const baseRes = core.computePieceCutBoundary(baseFolded);
  const peak80 = baseRes.reduce((best, p) => (p.y < best.y ? p : best), { y: Infinity });
  assert.ok(
    Math.abs(peak80.y - (-10.175609923082874)) < 1e-9,
    `BUG-I14-03: depthMm=80 folded dart peak.y expected ~ -10.175609923, got ${peak80.y}`,
  );

  for (const depthMm of [1e16, 1e20, 1e308]) {
    const foldedExtreme = core.createPatternPiece({
      id: `dart-${depthMm}`,
      name: `Dart ${depthMm}`,
      points: rect(100, 100),
      seamAllowance: 10,
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm, folded: true }],
    });
    const res = core.computePieceCutBoundary(foldedExtreme);
    const minY = Math.min(...res.map((p) => p.y));
    assert.ok(
      minY <= -9.9 && minY >= -11,
      `BUG-I14-03: folded dart at depthMm=${depthMm} must stay outward near -10, got minY=${minY}`,
    );

    const unfoldedExtreme = core.createPatternPiece({
      id: `dart-unfolded-${depthMm}`,
      name: `Dart Unfolded ${depthMm}`,
      points: rect(100, 100),
      seamAllowance: 10,
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 10, depthMm, folded: false }],
    });
    const outline = core.samplePieceOutline(unfoldedExtreme);
    const maxApexY = Math.max(...outline.filter((p) => Math.abs(p.x - 50) < 1).map((p) => p.y));
    assert.ok(
      maxApexY > 80 && maxApexY < 100,
      `BUG-I14-03: unfolded dart at depthMm=${depthMm} must clamp onto opposite interior (>80), got maxApexY=${maxApexY}`,
    );
  }

  // --- BUG-I14-04: physics normalizePatternForSimulation non-mm overflow checks ---
  const makePhysPiece = (overrides = {}) => core.createPatternPiece({
    id: 'p1',
    name: 'P1',
    points: rect(10, 10),
    seamAllowance: 1,
    edges: [{ index: 0, seamAllowance: 1 }],
    notches: [{ id: 'n1', edgeIndex: 0, t: 0.5, depthMm: 0.5, style: 'slit' }],
    darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 1, depthMm: 2 }],
    ...overrides,
  });
  const physOverflowCases = [
    ['piece.seamAllowance', { seamAllowance: 1e307 }],
    ['edges[0].seamAllowance', { edges: [{ index: 0, seamAllowance: 1e307 }] }],
    ['notches[0].depthMm', { notches: [{ id: 'n1', edgeIndex: 0, t: 0.5, depthMm: 1e307, style: 'slit' }] }],
    ['darts[0].widthMm', { darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 1e307, depthMm: 2 }] }],
    ['darts[0].depthMm', { darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 1, depthMm: 1e307 }] }],
  ];
  for (const [label, patch] of physOverflowCases) {
    const project = core.createPatternProject({
      name: `Phys ${label}`,
      unit: 'in',
      pieces: [makePhysPiece(patch)],
      seams: [],
    });
    assert.throws(
      () => new core.ClothSimulation(project),
      (err) => err instanceof core.ValidationError,
      `BUG-I14-04: ClothSimulation should throw ValidationError on ${label} overflow`,
    );
    assert.throws(
      () => core.runSimulationSteps(project, 2),
      (err) => err instanceof core.ValidationError,
      `BUG-I14-04: runSimulationSteps should throw ValidationError on ${label} overflow`,
    );
  }

  // --- BUG-I14-05: aggregate quantity cap, fast multi-sheet packing, no spread RangeError ---
  const twoPiecesOverCap = core.createPatternProject({
    name: 'Aggregate Cap 2x7500',
    pieces: [
      core.createPatternPiece({ id: 'a', name: 'A', points: rect(50, 50), seamAllowance: 0, quantity: 7500 }),
      core.createPatternPiece({ id: 'b', name: 'B', points: rect(50, 50), seamAllowance: 0, quantity: 7500 }),
    ],
  });
  assert.throws(
    () => core.nestPatternPieces(twoPiecesOverCap),
    (err) => err instanceof core.ValidationError && err.code === 'TOO_MANY_PIECES',
    'BUG-I14-05: 2 * 7500 total cut pieces should throw TOO_MANY_PIECES',
  );

  // Single piece at MAX_PIECE_QUANTITY=10000 on 1 sheet remains valid
  const singleAtCap = core.createPatternProject({
    name: 'Single 10000 OK',
    pieces: [
      core.createPatternPiece({ id: 's', name: 'S', points: rect(10, 10), seamAllowance: 0, quantity: 10000 }),
    ],
  });
  const singleCapRes = core.nestPatternPieces(singleAtCap, {
    fabricWidthMm: 2000,
    sheetLengthMm: 2000,
    marginMm: 0,
    gapMm: 0,
  });
  assert.equal(singleCapRes.placements.length, 10000);
  assert.equal(singleCapRes.unfittedPieces.length, 0);

  // 4000-sheet packing speed & RangeError safety (both skyline and shelf strategies + mixed tail)
  const fourThousandProj = core.createPatternProject({
    name: '4000 Sheets',
    pieces: [
      core.createPatternPiece({ id: 'big', name: 'Big', points: rect(100, 100), seamAllowance: 0, quantity: 3999 }),
      core.createPatternPiece({ id: 'tiny', name: 'Tiny', points: rect(1, 1), seamAllowance: 0, quantity: 1 }),
    ],
  });
  for (const strategy of ['skyline', 'shelf']) {
    const t0 = performance.now();
    const res = core.nestPatternPieces(fourThousandProj, {
      fabricWidthMm: 120,
      sheetLengthMm: 120,
      marginMm: 5,
      gapMm: 2,
      strategy,
      allowRotation: false,
    });
    const elapsedMs = performance.now() - t0;
    assert.equal(res.placements.length, 4000, `BUG-I14-05(${strategy}): all 4000 placements produced`);
    assert.equal(res.unfittedPieces.length, 0);
    assert.equal(res.sheetCount, 3999, `BUG-I14-05(${strategy}): tiny 1x1 fits into sheet 0 residual space`);
    assert.ok(elapsedMs < 2000, `BUG-I14-05(${strategy}): 4000-sheet nesting must be fast (<2000ms), took ${elapsedMs.toFixed(1)}ms`);
  }

  // Also test exact 4000 full sheets (no residual fit)
  const exact4000Proj = core.createPatternProject({
    name: 'Exact 4000 Sheets',
    pieces: [
      core.createPatternPiece({ id: 'big4k', name: 'Big4k', points: rect(100, 100), seamAllowance: 0, quantity: 4000 }),
    ],
  });
  const res4k = core.nestPatternPieces(exact4000Proj, {
    fabricWidthMm: 120,
    sheetLengthMm: 120,
    marginMm: 5,
    gapMm: 2,
    strategy: 'skyline',
    allowRotation: false,
  });
  assert.equal(res4k.sheetCount, 4000);
  assert.equal(res4k.placements.length, 4000);

  // --- Minor exporters.mjs caveat: extreme single-piece placement pl.x=1e308 / piece.position.x=1e308 ---
  const smallExpProj = core.createPatternProject({
    name: 'Small Export Piece',
    pieces: [
      core.createPatternPiece({ id: 'e1', name: 'E1', points: rect(50, 50), seamAllowance: 5 }),
    ],
  });
  const extremeNesting = {
    fabricWidthMm: 1000,
    sheetLengthMm: 1000,
    sheetCount: 1,
    placements: [{
      pieceId: 'e1',
      pieceName: 'E1',
      instanceIndex: 0,
      sheetIndex: 0,
      x: 1e308,
      y: 0,
      width: 60,
      height: 60,
      rotationDeg: 0,
      mirrored: false,
    }],
    unfittedPieces: [],
  };
  assert.throws(
    () => core.exportSVG(smallExpProj, { nestingResult: extremeNesting }),
    (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
    'exporters caveat: exportSVG with pl.x=1e308 should throw EXPORT_TOO_LARGE',
  );
  assert.throws(
    () => core.exportDXF(smallExpProj, { nestingResult: extremeNesting }),
    (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
    'exporters caveat: exportDXF with pl.x=1e308 should throw EXPORT_TOO_LARGE',
  );
  assert.throws(
    () => core.exportTiledPDF(smallExpProj, { nestingResult: extremeNesting }),
    (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
    'exporters caveat: exportTiledPDF with pl.x=1e308 should throw EXPORT_TOO_LARGE',
  );

  const extremePosProj = core.createPatternProject({
    name: 'Extreme Position Export',
    pieces: [
      core.createPatternPiece({
        id: 'e2',
        name: 'E2',
        points: rect(50, 50),
        seamAllowance: 5,
        position: { x: 1e308, y: 0 },
      }),
    ],
  });
  assert.throws(
    () => core.exportSVG(extremePosProj),
    (err) => err instanceof core.ValidationError && err.code === 'EXPORT_TOO_LARGE',
    'exporters caveat: non-nested piece.position.x=1e308 should throw EXPORT_TOO_LARGE',
  );

  // Normal large coordinate <= 1e10 remains valid
  const normalLargeNesting = {
    ...extremeNesting,
    placements: [{ ...extremeNesting.placements[0], x: 1e9, y: 1e9 }],
  };
  const okSvg = core.exportSVG(smallExpProj, { nestingResult: normalLargeNesting });
  assert.ok(okSvg.includes('<svg'), 'exporters caveat: normal large coordinate 1e9 must still export SVG');
});

test('adv_i15_core_extremes: PROBE-GEO-01, PROBE-GEO-07, PROBE-TYPES-01', () => {
  // --- PROBE-GEO-01: clampDartApexToBoundary on extreme high-aspect-ratio pieces ---
  const arPieceH = core.createPatternPiece({
    id: 'ar-h',
    name: 'AR-H',
    points: [
      { x: 0, y: 0 },
      { x: 1e7, y: 0 },
      { x: 1e7, y: 10 },
      { x: 0, y: 10 },
    ],
    seamAllowance: 0,
    darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 1e7, folded: false }],
  });
  const outlineH = core.samplePieceOutline(arPieceH);
  const apexH = outlineH.find((pt) => Math.abs(pt.x - 5e6) < 1e-3);
  assert.ok(apexH, 'PROBE-GEO-01: unfolded dart apex must exist on 1e7 x 10 piece');
  assert.ok(
    apexH.y > 8.5 && apexH.y < 10,
    `PROBE-GEO-01: unfolded dart apex.y on 1e7 x 10 piece must stay inside (8.5, 10), got ${apexH.y}`
  );
  const cutH = core.computePieceCutBoundary(arPieceH);
  assert.ok(Array.isArray(cutH) && cutH.length >= 4 && !core.polygonSelfIntersects(cutH));

  // Vertical high-aspect-ratio 10 x 1e7 piece
  const arPieceV = core.createPatternPiece({
    id: 'ar-v',
    name: 'AR-V',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 1e7 },
      { x: 0, y: 1e7 },
    ],
    seamAllowance: 0,
    darts: [{ id: 'd1', edgeIndex: 1, t: 0.5, widthMm: 20, depthMm: 1e7, folded: false }],
  });
  const outlineV = core.samplePieceOutline(arPieceV);
  const apexV = outlineV.find((pt) => Math.abs(pt.y - 5e6) < 1e-3);
  assert.ok(apexV, 'PROBE-GEO-01: unfolded dart apex must exist on 10 x 1e7 vertical piece');
  assert.ok(
    apexV.x > 0 && apexV.x < 1.5,
    `PROBE-GEO-01: unfolded dart apex.x on 10 x 1e7 vertical piece must stay inside (0, 1.5), got ${apexV.x}`
  );

  // --- PROBE-GEO-07: segmentIntersection2D mixed extreme vs tiny orthogonal segments ---
  const hit1 = core.segmentIntersection2D(
    { x: 0, y: 0 },
    { x: 2e200, y: 0 },
    { x: 1e200, y: -1e-130 },
    { x: 1e200, y: 1e-130 }
  );
  assert.ok(hit1 !== null, 'PROBE-GEO-07: tiny orthogonal crossing segment at 1e200 must intersect');
  assert.equal(hit1.collinear, false);
  assert.equal(hit1.point.x, 1e200);
  assert.equal(hit1.point.y, 0);
  assert.ok(Math.abs(hit1.t - 0.5) < 1e-12 && Math.abs(hit1.u - 0.5) < 1e-12);

  // Symmetric argument order
  const hit2 = core.segmentIntersection2D(
    { x: 1e200, y: -1e-130 },
    { x: 1e200, y: 1e-130 },
    { x: 0, y: 0 },
    { x: 2e200, y: 0 }
  );
  assert.ok(hit2 !== null, 'PROBE-GEO-07: symmetric order tiny vs huge must intersect');
  assert.equal(hit2.collinear, false);
  assert.equal(hit2.point.x, 1e200);
  assert.equal(hit2.point.y, 0);

  // Non-intersecting offset at 1e200 vs 1e-130
  const miss = core.segmentIntersection2D(
    { x: 0, y: 0 },
    { x: 2e200, y: 0 },
    { x: 1e200, y: 1e-130 },
    { x: 1e200, y: 2e-130 }
  );
  assert.equal(miss, null, 'PROBE-GEO-07: non-intersecting tiny segment near 1e200 must return null');

  // --- PROBE-TYPES-01: unitToMm / mmToUnit finiteness check ---
  for (const [val, unit] of [[1e307, 'in'], [2e307, 'cm'], [1e308, 'cm']]) {
    assert.throws(
      () => core.unitToMm(val, unit),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_DIMENSIONS',
      `PROBE-TYPES-01: unitToMm(${val}, "${unit}") must throw ValidationError on overflow`
    );
  }
  assert.equal(core.unitToMm(1e307, 'cm'), 1e308);
  assert.equal(core.unitToMm(1e307, 'mm'), 1e307);
  assert.ok(Number.isFinite(core.mmToUnit(1e308, 'in')));
});

test('adv_i15_ui_cad2d_transactions: BUG-I15-01..03 transactional UI rollback, CAD2D grid/SA guards, and STL 4xx error handling', async () => {
  // 1. Direct CAD2DViewport checks: BUG-I15-01 (seamAllowance=1e16) & BUG-I15-02 (x=1e19 grid hang)
  const { CAD2DViewport } = await import(`../public/cad2d.mjs?i15=${Date.now()}`);
  const directCtx = { ...createMock2DContext(), putImageData() {} };
  const directCanvas = {
    width: 640,
    height: 480,
    getContext: (type) => (type === '2d' ? directCtx : null),
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  };
  const directCad = new CAD2DViewport(directCanvas);

  // BUG-I15-01: CAD2DViewport fitToContent + render must not throw on seamAllowance=1e16
  const toxicSaScene = {
    unit: 'mm',
    viewMode: '2d',
    activeTool: 'select',
    showCutLine: true,
    showLengths: true,
    showGrain: true,
    showSeams: false,
    pattern: {
      unit: 'mm',
      pieces: [{
        id: 'p_toxic_sa',
        name: 'ToxicSA',
        position: { x: 0, y: 0 },
        rotation: 0,
        seamAllowance: 1e16,
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
        edges: [{}, {}, {}, {}],
      }],
      seams: [],
    },
    selectedPieceId: 'p_toxic_sa',
    selectedEdgeIndex: 0,
    selectedVertexIndex: -1,
  };
  assert.doesNotThrow(() => directCad.fitToContent(toxicSaScene));
  assert.doesNotThrow(() => directCad.render(toxicSaScene));

  // BUG-I15-02: CAD2DViewport _drawGrid must not hang at extreme coordinates (x = 1e19) or invalid zoom
  const extremeGridScene = {
    ...toxicSaScene,
    pattern: {
      unit: 'mm',
      pieces: [{
        id: 'p_1e19',
        name: 'ExtremeX',
        position: { x: 1e19, y: 0 },
        rotation: 0,
        seamAllowance: 0,
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
        edges: [{}, {}, {}, {}],
      }],
      seams: [],
    },
    selectedPieceId: 'p_1e19',
  };
  const tGrid0 = performance.now();
  directCad.fitToContent(extremeGridScene);
  directCad.render(extremeGridScene);
  directCad.cam = { panX: -3.84e19, panY: 48, zoom: 3.84 };
  directCad.render(extremeGridScene);
  directCad.cam = { panX: 0, panY: 0, zoom: 0 };
  directCad.render(extremeGridScene);
  assert.ok(performance.now() - tGrid0 < 1000, 'BUG-I15-02: extreme grid render must terminate promptly');

  // 2. Full Mock-DOM app.mjs checks for BUG-I15-01, BUG-I15-02, BUG-I15-03
  const srv = await startServer({ port: 0, host: '127.0.0.1', publicDir: PUBLIC_DIR });
  const baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
  const htmlTextI15 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlTextI15.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const webglCtx = createStrictMockWebGL2Context();
  const canvas2dCtx = { ...createMock2DContext(), putImageData() {} };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) { const idx = children.indexOf(c); if (idx >= 0) children.splice(idx, 1); return c; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute(k, v) { if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute() { return ''; },
      getContext(type) {
        if (id === 'canvas3D' && type === 'webgl2') return webglCtx;
        if (type === '2d') return id === 'canvas2D' ? canvas2dCtx : { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';
  let forceUnwrap503 = false;

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (forceUnwrap503 && sUrl === '/api/unwrap-stl') {
        return new Response(JSON.stringify({ error: 'Service unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?i15=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;
    const toast = elements.get('studioToast');
    const jsonInput = elements.get('jsonFileInput');

    const initialName = st.pattern.name;
    const initialTemplate = st.templateId;

    // BUG-I15-01a: Rejected toxic SA JSON import rolls back state & history completely
    const toxicSaPat = core.createPatternProject({
      name: 'ToxicSA',
      pieces: [
        core.createPatternPiece({
          id: 'tsa',
          name: 'TSA',
          points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
          seamAllowance: 1e16,
        }),
      ],
      seams: [],
    });
    jsonInput.files = [{ name: 'toxic_sa.json', text: async () => JSON.stringify(toxicSaPat) }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => toast.textContent.includes('JSON Import failed'));

    assert.equal(st.pattern.name, initialName, 'BUG-I15-01: toxic SA import must roll back state.pattern');
    assert.equal(st.templateId, initialTemplate, 'BUG-I15-01: toxic SA import must roll back state.templateId');
    assert.equal(elements.get('btnUndo').disabled, true, 'BUG-I15-01: failed import must not pollute undo stack');
    assert.ok(toast.classList.contains('toast-error'), 'BUG-I15-01: failed import must show error toast');

    // Subsequent unitSelect change + draw2D must NOT throw
    const unitSel = elements.get('unitSelect');
    unitSel.value = 'cm';
    assert.doesNotThrow(() => unitSel.dispatchEvent({ type: 'change' }));
    assert.equal(st.unit, 'cm');
    unitSel.value = 'mm';
    assert.doesNotThrow(() => unitSel.dispatchEvent({ type: 'change' }));

    // BUG-I15-01b: Rejected toxic aggregate quantity JSON import rolls back cleanly
    const toxicQtyPat = core.createPatternProject({
      name: 'ToxicQty',
      pieces: [
        core.createPatternPiece({
          id: 'tq1',
          name: 'TQ1',
          quantity: 6000,
          points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
          seamAllowance: 0,
        }),
        core.createPatternPiece({
          id: 'tq2',
          name: 'TQ2',
          quantity: 6000,
          points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
          seamAllowance: 0,
        }),
      ],
      seams: [],
    });
    toast.textContent = '';
    jsonInput.files = [{ name: 'toxic_qty.json', text: async () => JSON.stringify(toxicQtyPat) }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => toast.textContent.includes('JSON Import failed'));
    assert.equal(st.pattern.name, initialName, 'BUG-I15-01: toxic QTY import must roll back state.pattern');
    assert.equal(elements.get('btnUndo').disabled, true);

    // BUG-I15-02: Uploading 1e150 STL surfaces HTTP 400 error toast without client-side unwrap/hang
    const extremeStlText = [
      'solid extreme',
      '  facet normal 0 0 1',
      '    outer loop',
      '      vertex 0 0 0',
      '      vertex 1e150 0 0',
      '      vertex 0 1e150 0',
      '    endloop',
      '  endfacet',
      '  facet normal 0 0 1',
      '    outer loop',
      '      vertex 1e150 0 0',
      '      vertex 1e150 1e150 0',
      '      vertex 0 1e150 0',
      '    endloop',
      '  endfacet',
      'endsolid extreme',
    ].join('\n');
    const stlBytes = Buffer.from(extremeStlText, 'utf8');
    toast.textContent = '';
    toast.classList.remove('toast-error');
    const stlInput = elements.get('stlFileInput');
    stlInput.files = [{
      name: 'extreme_1e150.stl',
      arrayBuffer: async () => stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength),
    }];
    stlInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => toast.textContent.length > 0);
    assert.ok(toast.classList.contains('toast-error'), `BUG-I15-02: HTTP 400 from /api/unwrap-stl must surface error toast (got "${toast.textContent}")`);
    assert.equal(st.pattern.name, initialName, 'BUG-I15-02: HTTP 400 from /api/unwrap-stl must not overwrite valid pattern via client fallback');

    // Verify HTTP 5xx still falls back cleanly to client-side unwrap for valid STL
    forceUnwrap503 = true;
    const boxStlBytes = Buffer.from(core.createBoxSTL(60, 40, 20), 'utf8');
    toast.textContent = '';
    stlInput.files = [{
      name: 'valid_box.stl',
      arrayBuffer: async () => boxStlBytes.buffer.slice(boxStlBytes.byteOffset, boxStlBytes.byteOffset + boxStlBytes.byteLength),
    }];
    stlInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.templateId === 'stl_cover' && st.activeStlMesh?.name === 'valid_box.stl');
    assert.equal(st.templateId, 'stl_cover', 'BUG-I15-02: 503 server error still allows valid client-side STL fallback');
    forceUnwrap503 = false;

    // BUG-I15-03a: btnDuplicatePiece overflow (>10000) rolls back cleanly with error toast
    const ok6kPat = core.createPatternProject({
      name: 'Ok6k',
      pieces: [
        core.createPatternPiece({
          id: 'p6k',
          name: 'P6K',
          quantity: 6000,
          points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
          seamAllowance: 0,
        }),
      ],
      seams: [],
    });
    jsonInput.files = [{ name: 'ok6k.json', text: async () => JSON.stringify(ok6kPat) }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.name === 'Ok6k');

    const undoCountBeforeDup = elements.get('btnUndo').disabled;
    toast.textContent = '';
    toast.classList.remove('toast-error');
    assert.doesNotThrow(() => elements.get('btnDuplicatePiece').click());
    assert.equal(st.pattern.pieces.length, 1, 'BUG-I15-03: failed duplicate must roll back piece list');
    assert.equal(st.selectedPieceId, 'p6k', 'BUG-I15-03: failed duplicate must restore selectedPieceId');
    assert.equal(elements.get('btnUndo').disabled, undoCountBeforeDup);
    assert.ok(toast.classList.contains('toast-error'), 'BUG-I15-03: failed duplicate must show error toast');

    // BUG-I15-03b: pieceQuantityInput overflow (>10000) rolls back piece.quantity & input value
    const pat9999 = core.createPatternProject({
      name: 'Pat9999',
      pieces: [
        core.createPatternPiece({
          id: 'p9999',
          name: 'P9999',
          quantity: 9999,
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
          seamAllowance: 0,
        }),
        core.createPatternPiece({
          id: 'p1',
          name: 'P1',
          quantity: 1,
          points: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }],
          seamAllowance: 0,
        }),
      ],
      seams: [],
    });
    jsonInput.files = [{ name: 'pat9999.json', text: async () => JSON.stringify(pat9999) }];
    jsonInput.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.name === 'Pat9999');

    const pieceDrop = elements.get('pieceSelectDropdown');
    pieceDrop.value = 'p1';
    pieceDrop.dispatchEvent({ type: 'change' });
    assert.equal(st.selectedPieceId, 'p1');

    const qtyInput = elements.get('pieceQuantityInput');
    qtyInput.value = '2';
    toast.textContent = '';
    toast.classList.remove('toast-error');
    assert.doesNotThrow(() => qtyInput.dispatchEvent({ type: 'change' }));
    assert.equal(st.pattern.pieces[1].quantity, 1, 'BUG-I15-03: failed quantity edit must roll back piece.quantity');
    assert.equal(qtyInput.value, '1', 'BUG-I15-03: failed quantity edit must restore input value');
    assert.ok(toast.classList.contains('toast-error'), 'BUG-I15-03: failed quantity edit must show error toast');

    // BUG-I15-03c: btnConfirmAddRect overflow (>10000) also rolls back cleanly
    elements.get('rectWidthInput').value = '50';
    elements.get('rectHeightInput').value = '50';
    elements.get('rectSaInput').value = '0';
    toast.textContent = '';
    toast.classList.remove('toast-error');
    assert.doesNotThrow(() => elements.get('btnConfirmAddRect').click());
    assert.equal(st.pattern.pieces.length, 2, 'BUG-I15-03: failed Add Rectangle must roll back pieces');
    assert.ok(toast.classList.contains('toast-error'));
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i16_core_extremes: CORE-BUG-I16-01 mirrorPieceAcrossEdge atomic overflow guards & CORE-BUG-I16-02 stl parseBoolFlag', () => {
  // --- CORE-BUG-I16-01a: position.x overflow in non-rotated and rotated mirrorPieceAcrossEdge ---
  const pPos = core.createPatternPiece({
    id: 'm_pos',
    name: 'MPos',
    position: { x: 1.75e308, y: 0 },
    points: [
      { x: 1e307, y: 0 },
      { x: 2e307, y: 0 },
      { x: 2e307, y: 1e307 },
      { x: 1e307, y: 1e307 },
    ],
    seamAllowance: 0,
  });
  const pPosBefore = JSON.stringify(pPos);
  const patPos = { unit: 'mm', pieces: [pPos], seams: [] };
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pPos, 0, patPos),
    (err) => err instanceof core.ValidationError && (err.code === 'INVALID_DIMENSIONS' || err.code === 'INVALID_POINTS')
  );
  assert.equal(JSON.stringify(pPos), pPosBefore, 'CORE-BUG-I16-01: position overflow must leave piece completely unmutated');
  assert.equal(core.validatePatternPiece(pPos).valid, true);

  const pRotPos = core.createPatternPiece({
    id: 'm_rot_pos',
    name: 'MRotPos',
    rotation: 45,
    position: { x: 1.75e308, y: 0 },
    points: [
      { x: 1e307, y: 0 },
      { x: 2e307, y: 0 },
      { x: 2e307, y: 1e307 },
      { x: 1e307, y: 1e307 },
    ],
    seamAllowance: 0,
  });
  const pRotPosBefore = JSON.stringify(pRotPos);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pRotPos, 0),
    (err) => err instanceof core.ValidationError && (err.code === 'INVALID_DIMENSIONS' || err.code === 'INVALID_POINTS')
  );
  assert.equal(JSON.stringify(pRotPos), pRotPosBefore, 'CORE-BUG-I16-01: rotated position overflow must leave piece unmutated');

  // --- CORE-BUG-I16-01b: shiftPt overflow on rotationOrigin, grainline, internalLines, and curve CPs ---
  const baseShiftPts = [
    { x: -1e308, y: -1e308 },
    { x: -0.9e308, y: -1e308 },
    { x: -0.9e308, y: -0.9e308 },
    { x: -1e308, y: -0.9e308 },
  ];
  const pRotOrig = core.createPatternPiece({
    id: 'm_rot_orig',
    name: 'MRotOrig',
    points: baseShiftPts,
    rotationOrigin: { x: 1e308, y: 0 },
    seamAllowance: 0,
  });
  const pRotOrigBefore = JSON.stringify(pRotOrig);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pRotOrig, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.equal(JSON.stringify(pRotOrig), pRotOrigBefore, 'CORE-BUG-I16-01: rotationOrigin overflow must be atomic');

  const pGrain = core.createPatternPiece({
    id: 'm_grain',
    name: 'MGrain',
    points: baseShiftPts,
    grainline: { angleDeg: 90, start: { x: 1e308, y: -0.95e308 }, end: { x: 1e308, y: -0.92e308 } },
    seamAllowance: 0,
  });
  const pGrainBefore = JSON.stringify(pGrain);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pGrain, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.equal(JSON.stringify(pGrain), pGrainBefore, 'CORE-BUG-I16-01: grainline overflow must be atomic');

  const pInternalShift = core.createPatternPiece({
    id: 'm_il_shift',
    name: 'MILShift',
    points: baseShiftPts,
    internalLines: [{ id: 'il1', name: 'IL1', type: 'mark', points: [{ x: 1e308, y: -0.95e308 }, { x: 1e308, y: -0.92e308 }] }],
    seamAllowance: 0,
  });
  const pInternalShiftBefore = JSON.stringify(pInternalShift);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pInternalShift, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.equal(JSON.stringify(pInternalShift), pInternalShiftBefore, 'CORE-BUG-I16-01: internalLines shiftPt overflow must be atomic');

  // --- CORE-BUG-I16-01c: reflectPoint overflow on internalLines and curve CP ---
  const pInternalReflect = core.createPatternPiece({
    id: 'm_il_refl',
    name: 'MILRefl',
    points: [
      { x: 0, y: 1e307 },
      { x: 1e306, y: 1e307 },
      { x: 1e306, y: 2e307 },
      { x: 0, y: 2e307 },
    ],
    internalLines: [
      {
        id: 'il_far',
        name: 'ILFar',
        type: 'mark',
        points: [{ x: 0.5e306, y: -1.75e308 }, { x: 0.6e306, y: -1.75e308 }],
      },
    ],
    seamAllowance: 0,
  });
  const pInternalReflectBefore = JSON.stringify(pInternalReflect);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pInternalReflect, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.equal(JSON.stringify(pInternalReflect), pInternalReflectBefore, 'CORE-BUG-I16-01: internalLines reflectPoint overflow must be atomic');

  const pCurveOverflow = core.createPatternPiece({
    id: 'm_curve_ovf',
    name: 'MCurveOvf',
    points: [
      { x: 0, y: 1e307 },
      { x: 1e306, y: 1e307 },
      { x: 1e306, y: 2e307 },
      { x: 0, y: 2e307 },
    ],
    edges: [
      { name: 'Axis', seamAllowance: 0 },
      { name: 'Right', seamAllowance: 0 },
      { name: 'Top', seamAllowance: 0, curve: { cp: { x: 0.5e306, y: -1.75e308 } } },
      { name: 'Left', seamAllowance: 0 },
    ],
    seamAllowance: 0,
  });
  const pCurveBefore = JSON.stringify(pCurveOverflow);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pCurveOverflow, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
  assert.equal(JSON.stringify(pCurveOverflow), pCurveBefore, 'CORE-BUG-I16-01: curve CP reflect overflow must be atomic');

  // --- CORE-BUG-I16-02: parseBoolFlag parity on binary parameter in stl.mjs ---
  const oneTri = [[{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }]];
  for (const falsyFlag of [false, 'false', 'FALSE', ' false ', '0', 'no', 'off', '']) {
    const ser = core.serializeTrianglesToSTL(oneTri, 'tri', falsyFlag);
    assert.equal(typeof ser, 'string', `serializeTrianglesToSTL binary=${JSON.stringify(falsyFlag)} must return ASCII string`);
    assert.ok(ser.startsWith('solid '), `serializeTrianglesToSTL binary=${JSON.stringify(falsyFlag)} must start with "solid "`);

    const box = core.createBoxSTL(20, 20, 20, falsyFlag);
    assert.equal(typeof box, 'string', `createBoxSTL binary=${JSON.stringify(falsyFlag)} must return ASCII string`);
    assert.ok(box.startsWith('solid '), `createBoxSTL binary=${JSON.stringify(falsyFlag)} must start with "solid "`);
    assert.equal(core.parseSTL(box, 'box.stl').triangleCount, 12);

    const wedge = core.createWedgeSTL(40, 40, 20, 5, falsyFlag);
    assert.equal(typeof wedge, 'string', `createWedgeSTL binary=${JSON.stringify(falsyFlag)} must return ASCII string`);
    assert.ok(wedge.startsWith('solid '), `createWedgeSTL binary=${JSON.stringify(falsyFlag)} must start with "solid "`);
    assert.equal(core.parseSTL(wedge, 'wedge.stl').triangleCount, 12);
  }
  for (const truthyFlag of [true, 'true', '1', 'yes', 'on', Symbol('bin')]) {
    const serBin = core.serializeTrianglesToSTL(oneTri, 'tri', truthyFlag);
    assert.ok(serBin instanceof Uint8Array, `serializeTrianglesToSTL binary=${String(truthyFlag)} must return Uint8Array`);
    assert.ok(core.createBoxSTL(20, 20, 20, truthyFlag) instanceof Uint8Array);
    assert.ok(core.createWedgeSTL(40, 40, 20, 5, truthyFlag) instanceof Uint8Array);
  }
});

test('adv_i16_ui_stl_webgl_and_tx_hardening: UI-BUG-I16-01..02 and undoStack limit=50 / STL clear ordering', async () => {
  // 1. Direct WebGL3DViewport shader-failure fallback with strict HTML5 context lock + DOM canvas swap
  const shadersCreated = new Set();
  const shadersDeleted = new Set();
  const baseGl = createStrictMockWebGL2Context();
  let shaderCreateIdx = 0;
  const failingGl = {
    ...baseGl,
    createShader(type) {
      const sh = baseGl.createShader(type);
      sh.idx = ++shaderCreateIdx;
      shadersCreated.add(sh.id);
      return sh;
    },
    getShaderParameter(sh, pname) {
      if (pname === baseGl.COMPILE_STATUS && sh.idx >= 4) {
        return false; // fail on 2nd program's fragment shader
      }
      return true;
    },
    getShaderInfoLog(sh) {
      return sh.idx >= 4 ? 'Mock GLSL compile failure' : '';
    },
    deleteShader(sh) {
      if (sh) shadersDeleted.add(sh.id);
    },
  };

  const createdSwapCanvases = [];
  const wrapChildren = [];
  const canvasWrap = {
    getBoundingClientRect: () => ({ width: 640, height: 480 }),
    appendChild(node) { wrapChildren.push(node); node.parentNode = canvasWrap; node.parentElement = canvasWrap; return node; },
    replaceChild(newNode, oldNode) {
      const idx = wrapChildren.indexOf(oldNode);
      assert.ok(idx >= 0, 'replaceChild expects existing child');
      wrapChildren[idx] = newNode;
      newNode.parentNode = canvasWrap;
      newNode.parentElement = canvasWrap;
      oldNode.parentNode = null;
      oldNode.parentElement = null;
      return oldNode;
    },
  };
  const makeLockCanvas = (id = '') => {
    let lockedMode = null;
    const listeners = new Map();
    return {
      id,
      className: 'vp-canvas',
      width: 640,
      height: 480,
      parentNode: null,
      parentElement: null,
      _attrs: new Map([['aria-label', '3D Viewport']]),
      getAttribute(k) { return this._attrs.get(k) || ''; },
      setAttribute(k, v) { this._attrs.set(k, String(v)); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      getContext(type) {
        if (lockedMode && lockedMode !== type) return null; // Enforce HTML5 canvas single-context lock
        if (type === 'webgl2') { lockedMode = 'webgl2'; return failingGl; }
        if (type === '2d') { lockedMode = '2d'; return { ...createMock2DContext(), putImageData() {} }; }
        return null;
      },
    };
  };

  const prevDocDirect = globalThis.document;
  try {
    const lockedCanvas = makeLockCanvas('canvas3D');
    canvasWrap.appendChild(lockedCanvas);
    globalThis.document = {
      createElement(tag) {
        assert.equal(String(tag).toLowerCase(), 'canvas');
        const c = makeLockCanvas('');
        createdSwapCanvases.push(c);
        return c;
      },
    };
    const vpFallback = createViewport3D(lockedCanvas);
    assert.equal(vpFallback.mode, '2d', 'UI-BUG-I16-02: failed WebGL2 shader init must degrade cleanly to 2d');
    assert.equal(vpFallback.gl, null, 'UI-BUG-I16-02: failed GL context must be released');
    assert.notEqual(vpFallback.canvas, lockedCanvas, 'UI-BUG-I16-02: must swap out WebGL-locked canvas');
    assert.equal(vpFallback.canvas.id, 'canvas3D');
    assert.equal(vpFallback.canvas.className, 'vp-canvas');
    assert.equal(vpFallback.canvas.getAttribute('aria-label'), '3D Viewport');
    assert.equal(wrapChildren[0], vpFallback.canvas, 'UI-BUG-I16-02: replacement 2D canvas must sit inside parentNode');
    assert.equal(baseGl._state.programs.size, 0, 'UI-BUG-I16-02: partially created programs must be deleted on fallback');
    assert.equal(shadersDeleted.size, shadersCreated.size, 'UI-BUG-I16-02: all shaders must be deleted on fallback');
    assert.doesNotThrow(() => vpFallback.render());
    assert.equal(vpFallback.lastRenderStats.mode, '2d');
    vpFallback.dispose();

    // Detached locked canvas without parentNode degrades safely to 'none'
    const detachedLocked = makeLockCanvas('detached3D');
    const vpDetached = createViewport3D(detachedLocked);
    assert.equal(vpDetached.mode, 'none');
    assert.doesNotThrow(() => vpDetached.render());
    vpDetached.dispose();
  } finally {
    globalThis.document = prevDocDirect;
  }

  // 2. Full app.mjs mock-DOM + live server verification for UI-BUG-I16-01, UI-BUG-I16-02, and tx hardening
  const srv = await startServer({ port: 0, host: '127.0.0.1', publicDir: PUBLIC_DIR });
  const baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
  const htmlTextI16 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlTextI16.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };

  let initFailShaderIdx = 0;
  const initFailGl = {
    ...createStrictMockWebGL2Context(),
    createShader(type) {
      return { id: ++initFailShaderIdx, type, source: '' };
    },
    getShaderParameter() {
      return false; // Immediate first shader compilation failure during initStudio
    },
    getShaderInfoLog() {
      return 'Simulated GPU driver shader compile fail';
    },
  };

  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    let _id = id;
    let lockedCtx = null;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      className: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentNode: null,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) {
        children.push(c);
        c.parentNode = elObj;
        c.parentElement = elObj;
        return c;
      },
      replaceChild(newChild, oldChild) {
        const idx = children.indexOf(oldChild);
        if (idx >= 0) children[idx] = newChild;
        else children.push(newChild);
        newChild.parentNode = elObj;
        newChild.parentElement = elObj;
        oldChild.parentNode = null;
        oldChild.parentElement = null;
        return oldChild;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        return c;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (elObj.tagName === 'CANVAS') {
          if (lockedCtx && lockedCtx !== type) return null;
          if (type === 'webgl2' && elObj.id === 'canvas3D') {
            lockedCtx = 'webgl2';
            return initFailGl;
          }
          if (type === '2d') {
            lockedCtx = '2d';
            return { ...createMock2DContext(), putImageData() {} };
          }
        }
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };

  for (const id of htmlIds) {
    const node = makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id);
    if (id === 'canvas2D' || id === 'canvas3D') {
      const wrap = makeEl('div', '');
      wrap.appendChild(node);
    }
    elements.set(id, node);
  }
  elements.get('stlUnwrapModeSelect').value = 'form_shell_cover';
  elements.get('stlEaseInput').value = '2';
  elements.get('stlThicknessInput').value = '0';
  elements.get('stlSaInput').value = '10';
  elements.get('stlScaleInput').value = '1';
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';
  let bare404StlApiMode = false;
  let releaseDelayedMissingStl = null;

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      if (sUrl.includes('delayed_missing.stl')) {
        await new Promise((r) => { releaseDelayedMissingStl = r; });
        return { ok: false, status: 404, async json() { return { error: 'Workspace STL file not found: delayed_missing.stl' }; } };
      }
      if (bare404StlApiMode && (sUrl.startsWith('/api/stl-content') || sUrl === '/api/unwrap-stl')) {
        return { ok: false, status: 404, async json() { return {}; } };
      }
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?i16=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;
    const toast = elements.get('studioToast');

    // UI-BUG-I16-02: initStudio() succeeded despite WebGL2 shader compile failure and fell back to 2d
    assert.equal(appMod.viewport3D.mode, '2d', 'UI-BUG-I16-02: initStudio must fall back to 2d on shader compile error');
    assert.equal(elements.get('webglBadge').textContent, 'Canvas2D Fallback');
    assert.equal(st.templateId, 'tshirt', 'UI-BUG-I16-02: initStudio must finish loading initial tshirt template');
    assert.doesNotThrow(() => elements.get('btnCamFront').click(), 'UI-BUG-I16-02: camera controls must work in 2d fallback');
    assert.doesNotThrow(() => elements.get('btnSimStep').click(), 'UI-BUG-I16-02: sim step must render in 2d fallback');

    // UI-BUG-I16-01a: loadTemplate('stl_cover') on missing explicit STL (direct & via #templateSelect change) rolls back templateId & #templateSelect
    const tplSelect = elements.get('templateSelect');
    const wsSelect = elements.get('workspaceStlSelect');
    wsSelect.value = 'nonexistent_missing.stl';
    tplSelect.value = 'stl_cover';
    toast.textContent = '';
    toast.classList.remove('toast-error');
    tplSelect.dispatchEvent({ type: 'change' });
    await waitUntil(() => toast.textContent.includes('nonexistent_missing.stl'));
    assert.equal(st.templateId, 'tshirt', 'UI-BUG-I16-01: #templateSelect change to failing stl_cover must restore state.templateId');
    assert.equal(tplSelect.value, 'tshirt', 'UI-BUG-I16-01: #templateSelect change to failing stl_cover must restore #templateSelect.value');

    tplSelect.value = 'stl_cover';
    toast.textContent = '';
    toast.classList.remove('toast-error');
    const okMissingLive = await appMod.loadTemplate('stl_cover');
    assert.equal(okMissingLive, false);
    assert.equal(st.templateId, 'tshirt', 'UI-BUG-I16-01: failed stl_cover load must restore state.templateId to tshirt');
    assert.equal(tplSelect.value, 'tshirt', 'UI-BUG-I16-01: failed stl_cover load must restore #templateSelect.value');
    assert.equal(st.pattern.templateId, 'tshirt');
    assert.ok(toast.classList.contains('toast-error'));
    assert.match(toast.textContent, /nonexistent_missing\.stl/);

    // Subsequent parametric slider edit must still mutate tshirt cleanly
    const prevChest = st.pattern.params.chestMm;
    const firstSlider = elements.get('parametricSlidersContainer').children[0].children[1];
    firstSlider.value = String(prevChest + 20);
    firstSlider.dispatchEvent({ type: 'input' });
    assert.equal(st.templateId, 'tshirt');
    assert.equal(st.pattern.templateId, 'tshirt');
    assert.equal(st.pattern.params.chestMm, prevChest + 20);
    elements.get('btnUndo').click();
    assert.equal(st.pattern.params.chestMm, prevChest);

    // UI-BUG-I16-01b: Static bare-404 API mock must NOT substitute createWedgeSTL for non-default missing file
    bare404StlApiMode = true;
    wsSelect.value = 'nonexistent_missing.stl';
    tplSelect.value = 'stl_cover';
    toast.textContent = '';
    toast.classList.remove('toast-error');
    const okMissingBare = await appMod.loadTemplate('stl_cover');
    assert.equal(okMissingBare, false, 'UI-BUG-I16-01: bare 404 for explicit non-default STL must fail instead of wedge substitution');
    assert.equal(st.templateId, 'tshirt');
    assert.equal(tplSelect.value, 'tshirt');
    assert.equal(st.activeStlMesh, null);
    assert.ok(toast.classList.contains('toast-error'));

    // UI-BUG-I16-01c: Static bare-404 API mock DOES still allow built-in default wedge fallback
    wsSelect.value = 'cutting_mat_wedge_assembled_view.stl';
    tplSelect.value = 'stl_cover';
    const okDefaultStatic = await appMod.loadTemplate('stl_cover');
    assert.equal(okDefaultStatic, true, 'UI-BUG-I16-01: static/default wedge fallback must remain compatible');
    assert.equal(st.templateId, 'stl_cover');
    assert.equal(st.activeStlMesh.name, 'cutting_mat_wedge_assembled_view.stl');
    assert.equal(st.activeStlSource, null);
    bare404StlApiMode = false;

    // UI-BUG-I16-01d: Stale failed stl_cover load must NOT clobber newer loadTemplate('hoodie')
    await appMod.loadTemplate('tshirt');
    wsSelect.value = 'delayed_missing.stl';
    const delayedStlPromise = appMod.loadTemplate('stl_cover');
    await waitUntil(() => Boolean(releaseDelayedMissingStl));
    await appMod.loadTemplate('hoodie');
    assert.equal(st.templateId, 'hoodie');
    releaseDelayedMissingStl();
    await delayedStlPromise;
    assert.equal(st.templateId, 'hoodie', 'UI-BUG-I16-01: stale aborted stl_cover must not overwrite hoodie');
    assert.equal(tplSelect.value, 'hoodie');

    // 3. Reviewer hardening: undoStack preservation at limit=50 & applyStlUnwrapFromMesh tx cleanup
    await appMod.loadTemplate('tshirt');
    const jsonInp = elements.get('jsonFileInput');
    const patLimit = core.createPatternProject({
      name: 'Limit50',
      pieces: [
        core.createPatternPiece({
          id: 'p_lim',
          name: 'InitName',
          quantity: 6000,
          points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
          seamAllowance: 0,
        }),
      ],
      seams: [],
    });
    jsonInp.files = [{ name: 'limit50.json', text: async () => JSON.stringify(patLimit) }];
    jsonInp.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.pattern?.name === 'Limit50');

    // Clear history cleanly via loadWorkspaceSTLFile, then load patLimit? No, loadTemplate clears history!
    // Reset history by switching template then loading patLimit: wait, jsonFileInput pushes 1 entry;
    // undo back to tshirt? Better: we only care that 50 pushes fill undoStack to 50.
    const nameInp = elements.get('pieceNameInput');
    for (let i = 0; i < 50; i++) {
      nameInp.value = `Step_${i}`;
      nameInp.dispatchEvent({ type: 'change' });
    }
    // Now undoStack has 50 entries; the oldest retained entry on stack has name Step_0 (since Step_49 is current and 50 pushes: [json-prev, InitName, Step_0..Step_47] -> push 50 times puts InitName at index 0 after 1 shift? Wait: initial jsonFileInput pushed tshirt (1), then i=0 pushed InitName (2), ..., i=48 pushed Step_47 (50), i=49 shifted tshirt and pushed Step_48 (50)! So oldest snapshot on stack is InitName!)
    // Trigger failed btnDuplicatePiece (quantity 6000 + 6000 > 10000): must NOT shift off oldest snapshot!
    toast.textContent = '';
    elements.get('btnDuplicatePiece').click();
    assert.ok(toast.classList.contains('toast-error'));
    assert.equal(st.pattern.pieces.length, 1);
    assert.equal(st.pattern.pieces[0].name, 'Step_49');

    let undoSteps = 0;
    while (!elements.get('btnUndo').disabled) {
      elements.get('btnUndo').click();
      undoSteps++;
    }
    assert.equal(undoSteps, 50, 'Reviewer tx hardening: failed mutation at undo limit=50 must preserve all 50 undo entries');
    assert.equal(st.pattern.pieces[0].name, 'InitName', 'Reviewer tx hardening: oldest retained snapshot InitName must not be shifted off on rollback');

    // Verify secondary guarded handlers & post-STL-clear undo/redo cleanliness
    assert.doesNotThrow(() => {
      elements.get('pieceGrainInput').value = '30';
      elements.get('pieceGrainInput').dispatchEvent({ type: 'change' });
      elements.get('materialPresetSelect').value = 'heavy_denim';
      elements.get('materialPresetSelect').dispatchEvent({ type: 'change' });
      elements.get('btnResetMaterial').click();
      elements.get('avChestInput').value = '960';
      elements.get('avChestInput').dispatchEvent({ type: 'change' });
      elements.get('fabricRollSelect').value = 'roll_45in';
      elements.get('fabricRollSelect').dispatchEvent({ type: 'change' });
    });
    assert.equal(st.pattern.pieces[0].grainline.angleDeg, 30);

    // Custom seam tool handler + STL load history clear ordering
    await appMod.loadTemplate('tshirt');
    const seamCount0 = st.pattern.seams.length;
    appMod.cad2D.callbacks.onEdgeToolClick('sew', st.pattern.pieces[0].id, 0, 0.5);
    appMod.cad2D.callbacks.onEdgeToolClick('sew', st.pattern.pieces[1].id, 0, 0.5);
    assert.equal(st.pattern.seams.length, seamCount0 + 1);
    assert.equal(elements.get('btnUndo').disabled, false);

    const loadedRealWs = await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_assembled_view.stl');
    assert.equal(loadedRealWs, true);
    assert.equal(elements.get('btnUndo').disabled, true, 'Reviewer tx hardening: loadWorkspaceSTLFile clears undo history cleanly');
    nameInp.value = 'StlEdited';
    nameInp.dispatchEvent({ type: 'change' });
    assert.equal(elements.get('btnUndo').disabled, false);
    elements.get('btnUndo').click();
    assert.equal(elements.get('btnUndo').disabled, true, 'Undo stack after STL clear has no sparse holes');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i17_core_fixes: CORE-BUG-I17-01..05 and CORE-GAP-I17-01', () => {
  // 1. CORE-BUG-I17-01: reflectPoint overflow propagation (narrow strip, diagonal, internalLines, curve.cp) + finite 1e308 reflection
  {
    const narrowStrip = core.createPatternPiece({
      id: 'i17_narrow',
      name: 'NarrowStrip',
      points: [
        { x: 0, y: 1e308 },
        { x: 2e307, y: 1e308 },
        { x: 2e307, y: 0.2e308 },
        { x: 0, y: 0.2e308 },
      ],
      seamAllowance: 0,
    });
    const narrowBefore = JSON.stringify(narrowStrip);
    const narrowPat = { unit: 'mm', pieces: [narrowStrip], seams: [{ id: 's1', pieceA: 'i17_narrow', edgeA: 1, pieceB: 'i17_narrow', edgeB: 3 }] };
    const seamsBefore = JSON.stringify(narrowPat.seams);
    assert.throws(
      () => core.mirrorPieceAcrossEdge(narrowStrip, 0, narrowPat),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
    );
    assert.equal(JSON.stringify(narrowStrip), narrowBefore, 'CORE-BUG-I17-01: narrow strip overflow must be atomic');
    assert.equal(JSON.stringify(narrowPat.seams), seamsBefore);

    const diagOverflow = core.createPatternPiece({
      id: 'i17_diag_ovf',
      name: 'DiagOverflow',
      points: [
        { x: 0.4e308, y: 0.4e308 },
        { x: 1.2e308, y: 1.2e308 },
        { x: -1.4e308, y: 1.2e308 },
      ],
      seamAllowance: 0,
    });
    const diagBefore = JSON.stringify(diagOverflow);
    assert.throws(
      () => core.mirrorPieceAcrossEdge(diagOverflow, 0),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
    );
    assert.equal(JSON.stringify(diagOverflow), diagBefore, 'CORE-BUG-I17-01: diagonal overflow must be atomic');

    const tiltedIL = core.createPatternPiece({
      id: 'i17_tilted_il',
      name: 'TiltedIL',
      points: [
        { x: 0, y: 0 },
        { x: 0.1e308, y: 0.048433e308 },
        { x: 0, y: 0.2e308 },
      ],
      internalLines: [
        { id: 'il1', name: 'IL1', type: 'guide', points: [{ x: 1.5e308, y: 1.5e308 }, { x: 1.6e308, y: 1.5e308 }] },
      ],
      seamAllowance: 0,
    });
    const tiltedILBefore = JSON.stringify(tiltedIL);
    assert.throws(
      () => core.mirrorPieceAcrossEdge(tiltedIL, 0),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
    );
    assert.equal(JSON.stringify(tiltedIL), tiltedILBefore, 'CORE-BUG-I17-01: tilted internalLine reflection overflow must be atomic');

    const tiltedCurve = core.createPatternPiece({
      id: 'i17_tilted_curve',
      name: 'TiltedCurve',
      points: [
        { x: 0, y: 0 },
        { x: 0.1e308, y: 0.048433e308 },
        { x: 0, y: 0.2e308 },
      ],
      edges: [
        { name: 'Axis', seamAllowance: 0 },
        { name: 'Leg', seamAllowance: 0 },
        { name: 'Back', seamAllowance: 0, curve: { cp: { x: 1.5e308, y: 1.5e308 } } },
      ],
      seamAllowance: 0,
    });
    const tiltedCurveBefore = JSON.stringify(tiltedCurve);
    assert.throws(
      () => core.mirrorPieceAcrossEdge(tiltedCurve, 0),
      (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
    );
    assert.equal(JSON.stringify(tiltedCurve), tiltedCurveBefore, 'CORE-BUG-I17-01: tilted curve.cp reflection overflow must be atomic');

    // True finite diagonal reflection at 1e308 (without spurious intermediate overflow)
    const diagFinite = core.createPatternPiece({
      id: 'i17_diag_fin',
      name: 'DiagFinite',
      points: [
        { x: 1e308, y: 1e308 },
        { x: 1.2e308, y: 1.2e308 },
        { x: 0.6e308, y: 1e308 },
      ],
      seamAllowance: 0,
    });
    core.mirrorPieceAcrossEdge(diagFinite, 0);
    assert.equal(diagFinite.points.length, 4);
    for (const pt of diagFinite.points) {
      assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
    }
    const worldPts = diagFinite.points.map((pt) => ({
      x: pt.x + diagFinite.position.x,
      y: pt.y + diagFinite.position.y,
    }));
    assert.ok(
      worldPts.some((pt) => Math.abs(pt.x - 1e308) <= 1e295 && Math.abs(pt.y - 0.6e308) <= 1e295),
      `finite 1e308 diagonal reflected vertex (1e308, 0.6e308) must exist in ${JSON.stringify(worldPts)}`
    );
  }

  // 2. CORE-BUG-I17-02: norm2 and norm3 pre-scaling near ~1.5e308 + Physics & offsetPolygonOutward
  {
    const n2 = core.norm2({ x: 1.5e308, y: 1.5e308 });
    assertNear(n2.x, Math.SQRT1_2, 1e-12, 'norm2(1.5e308, 1.5e308).x');
    assertNear(n2.y, Math.SQRT1_2, 1e-12, 'norm2(1.5e308, 1.5e308).y');

    const n3 = core.norm3({ x: 1.5e308, y: 1.5e308, z: 1.5e308 });
    const invSqrt3 = 1 / Math.sqrt(3);
    assertNear(n3.x, invSqrt3, 1e-12, 'norm3(1.5e308^3).x');
    assertNear(n3.y, invSqrt3, 1e-12, 'norm3(1.5e308^3).y');
    assertNear(n3.z, invSqrt3, 1e-12, 'norm3(1.5e308^3).z');

    assert.deepEqual(core.norm2({ x: 0, y: 0 }), { x: 0, y: 0 });
    assert.deepEqual(core.norm2({ x: 1e-13, y: 0 }), { x: 0, y: 0 });
    assertNear(core.norm2({ x: 8e-13, y: 8e-13 }).x, Math.SQRT1_2, 1e-12);
    assert.deepEqual(core.norm2({ x: NaN, y: Infinity }), { x: 0, y: 0 });

    assert.deepEqual(core.norm3({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
    assert.deepEqual(core.norm3({ x: 5e-13, y: 5e-13, z: 5e-13 }), { x: 0, y: 0, z: 0 });
    assertNear(core.norm3({ x: 7e-13, y: 7e-13, z: 7e-13 }).x, invSqrt3, 1e-12);
    assert.deepEqual(core.norm3({ x: NaN, y: Infinity, z: -Infinity }), { x: 0, y: 0, z: 0 });

    const tan = core.evalEdgeTangentAt({ x: 0, y: 0 }, { x: 1.5e308, y: 1.5e308 }, null, 0.5);
    assertNear(tan.x, Math.SQRT1_2, 1e-12, 'evalEdgeTangentAt 1.5e308');
    assertNear(tan.y, Math.SQRT1_2, 1e-12, 'evalEdgeTangentAt 1.5e308');

    const offDiag = core.offsetPolygonOutward(
      [{ x: 0, y: 0 }, { x: 1.5e308, y: 0 }, { x: 1.5e308, y: 1.5e308 }],
      1e15
    );
    assert.ok(offDiag.length >= 3, 'offsetPolygonOutward 1.5e308 triangle must return valid polygon');
    assert.ok(offDiag.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.ok(
      Math.min(...offDiag.map((p) => p.y)) <= -0.9e15 && Math.min(...offDiag.map((p) => p.x)) <= -0.7e15,
      `offsetPolygonOutward 1.5e308 must expand outward around origin, got ${JSON.stringify(offDiag)}`
    );

    const simPat = core.createPatternProject({
      name: 'Norm3Huge',
      pieces: [
        core.createRectanglePiece('HugeNorm', 100, 100, {
          id: 'p_hn',
          seamAllowance: 0,
          placement3D: {
            offset: { x: 0, y: 120, z: 0 },
            normal: { x: 1.5e308, y: 1.5e308, z: 1.5e308 },
            up: { x: 0, y: 1, z: 0 },
          },
        }),
      ],
      seams: [],
    });
    const sim = new core.ClothSimulation(simPat, { avatar: null });
    const spread = (particles) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of particles) {
        assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z));
        if (p.pos.x < minX) minX = p.pos.x;
        if (p.pos.x > maxX) maxX = p.pos.x;
        if (p.pos.y < minY) minY = p.pos.y;
        if (p.pos.y > maxY) maxY = p.pos.y;
        if (p.pos.z < minZ) minZ = p.pos.z;
        if (p.pos.z > maxZ) maxZ = p.pos.z;
      }
      return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    };
    assert.ok(spread(sim.particles) > 50, 'CORE-BUG-I17-02: ClothSimulation must not collapse on 1.5e308 normal');
    sim.step(5);
    assert.ok(spread(sim.particles) > 50, 'CORE-BUG-I17-02: ClothSimulation post-step spread must remain > 50mm');
  }

  // 3. CORE-BUG-I17-03: extractWindingLoopsAtScale & clipSelfIntersectingLoops at scales >= 1e15
  {
    const makeUPocket = (ox, oy, u) => [
      { x: ox, y: oy },
      { x: ox + 100 * u, y: oy },
      { x: ox + 100 * u, y: oy + 100 * u },
      { x: ox + 60 * u, y: oy + 100 * u },
      { x: ox + 60 * u, y: oy + 40 * u },
      { x: ox + 40 * u, y: oy + 40 * u },
      { x: ox + 40 * u, y: oy + 100 * u },
      { x: ox, y: oy + 100 * u },
    ];
    for (const scale of [1, 1e14, 1e15, 1e16, 1e18, 1e20]) {
      const u = scale === 1 ? 1 : scale * 1e-8;
      const sa = 25 * u;
      const poly = makeUPocket(scale === 1 ? 0 : scale, scale === 1 ? 0 : scale, u);
      const out = core.offsetPolygonOutward(poly, sa);
      assert.equal(core.polygonSelfIntersects(out), false, `CORE-BUG-I17-03: scale=${scale} offset must not self-intersect`);
      assert.equal(out.length, 6, `CORE-BUG-I17-03: scale=${scale} U-pocket clipped to 6 outer vertices`);
    }
    const localSpan1e15 = makeUPocket(0, 0, 1e13);
    const outLocal1e15 = core.offsetPolygonOutward(localSpan1e15, 25 * 1e13);
    assert.equal(core.polygonSelfIntersects(outLocal1e15), false, 'CORE-BUG-I17-03: local 1e15 span must not self-intersect');
    assert.equal(outLocal1e15.length, 6);
  }

  // 4. CORE-BUG-I17-04: splitPieceEdge with opp totalLen 0/Infinity & micro-seams near split t
  {
    // 4a) Partner edge with totalLen === Infinity
    for (const rev of [false, true]) {
      const pA = core.createRectanglePiece('SplitA', 100, 100, { id: 'spA', seamAllowance: 0 });
      const pB = core.createPatternPiece({
        id: 'spBInf',
        name: 'InfPartner',
        points: [{ x: -1e308, y: 0 }, { x: 1e308, y: 0 }, { x: 0, y: 1e307 }],
        seamAllowance: 0,
      });
      const patInf = core.createPatternProject({
        pieces: [pA, pB],
        seams: [core.createSeam({ id: 's_inf', pieceA: 'spA', edgeA: 0, pieceB: 'spBInf', edgeB: 0, reversed: rev })],
      });
      core.splitPieceEdge(pA, 0, 0.5, patInf);
      assert.equal(patInf.seams.length, 2);
      assert.equal(core.validatePatternProject(patInf, { throwOnError: false }).valid, true, `CORE-BUG-I17-04: inf opp rev=${rev} project valid`);
      for (const sm of patInf.seams) {
        assert.ok(sm.tStartA < sm.tEndA && sm.tStartB < sm.tEndB, `CORE-BUG-I17-04: non-degenerate split ranges ${JSON.stringify(sm)}`);
      }
    }

    // 4b) Partner edge with totalLen === 0 (and darted zero-len)
    for (const withDart of [false, true]) {
      for (const rev of [false, true]) {
        const pA = core.createRectanglePiece('SplitA0', 100, 100, { id: 'spA0', seamAllowance: 0 });
        const pB = core.createPatternPiece({
          id: 'spBZero',
          name: 'ZeroPartner',
          points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }],
          darts: withDart ? [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 5, depthMm: 10, folded: false }] : [],
          seamAllowance: 0,
        });
        const patZero = core.createPatternProject({
          pieces: [pA, pB],
          seams: [core.createSeam({ id: 's_z', pieceA: 'spA0', edgeA: 0, pieceB: 'spBZero', edgeB: 0, reversed: rev })],
        });
        core.splitPieceEdge(pA, 0, 0.5, patZero);
        assert.equal(patZero.seams.length, 2);
        assert.equal(
          core.validatePatternProject(patZero, { throwOnError: false }).valid,
          true,
          `CORE-BUG-I17-04: zero-len opp (dart=${withDart}, rev=${rev}) project valid`
        );
      }
    }

    // 4c) Micro-seams near split parameter clampedT = 0.5
    const microCases = [
      { ts: 0.5, te: 0.5 + 5e-7, expectedCount: 1, expectedEdge: 1 },
      { ts: 0.5 - 5e-7, te: 0.5, expectedCount: 1, expectedEdge: 0 },
      { ts: 0.5 - 5e-7, te: 0.5 + 5e-7, expectedCount: 1 },
      { ts: 0.5 - 5e-7, te: 0.5 + 0.3, expectedCount: 1, expectedEdge: 1 },
      { ts: 0.5 - 0.3, te: 0.5 + 5e-7, expectedCount: 1, expectedEdge: 0 },
      { ts: 0.5 - 2e-6, te: 0.5 + 2e-6, expectedCount: 2 },
    ];
    for (const mc of microCases) {
      const pA = core.createRectanglePiece('MicroA', 100, 100, { id: 'mA', seamAllowance: 0 });
      const pB = core.createRectanglePiece('MicroB', 100, 100, { id: 'mB', seamAllowance: 0 });
      const patM = core.createPatternProject({
        pieces: [pA, pB],
        seams: [
          core.createSeam({
            id: 's_micro',
            pieceA: 'mA',
            edgeA: 0,
            tStartA: mc.ts,
            tEndA: mc.te,
            pieceB: 'mB',
            edgeB: 0,
            tStartB: 0,
            tEndB: 1,
          }),
        ],
      });
      assert.equal(core.validatePatternProject(patM, { throwOnError: false }).valid, true);
      core.splitPieceEdge(pA, 0, 0.5, patM);
      assert.equal(patM.seams.length, mc.expectedCount, `microCase [${mc.ts}, ${mc.te}] seam count`);
      if (mc.expectedEdge !== undefined) {
        assert.equal(patM.seams[0].edgeA, mc.expectedEdge, `microCase [${mc.ts}, ${mc.te}] edgeA`);
      }
      const valAfter = core.validatePatternProject(patM, { throwOnError: false });
      assert.equal(
        valAfter.valid,
        true,
        `CORE-BUG-I17-04: micro-seam [${mc.ts}, ${mc.te}] failed post-split validation: ${valAfter.errors.map((e) => e.message).join('; ')}`
      );
    }
  }

  // 5. CORE-BUG-I17-05: exporters.mjs parseBoolFlag parity on pl.rotated90
  {
    const piece = core.createRectanglePiece('ExpRect', 200, 80, { id: 'er1', seamAllowance: 0 });
    const pat = core.createPatternProject({ name: 'RotBoolTest', pieces: [piece], seams: [] });
    for (const falsyRot of [false, 'false', 'FALSE', ' false ', '0', 'no', 'off', '']) {
      const opts = {
        layout: 'nested',
        nestingResult: {
          sheetLengthMm: 300,
          placements: [{ pieceIndex: 0, pieceId: 'er1', x: 0, y: 0, sheetIndex: 0, copyIndex: 0, rotated90: falsyRot }],
        },
      };
      const svg = core.exportSVG(pat, opts);
      assert.match(svg, /width="230\.0000mm" height="176\.0000mm"/, `CORE-BUG-I17-05: rotated90=${JSON.stringify(falsyRot)} must NOT rotate SVG`);
      const dxf = core.exportDXF(pat, opts);
      assert.match(dxf, /\$EXTMAX\s+10\s+295\.0000\s+20\s+110\.0000/, `CORE-BUG-I17-05: rotated90=${JSON.stringify(falsyRot)} must NOT rotate DXF`);
      const pdf = core.exportTiledPDF(pat, { ...opts, pageFormat: 'A0' });
      assert.equal(pdf.pageCount, 1);
    }
    for (const truthyRot of [true, 'true', '1', 'YES']) {
      const opts = {
        layout: 'nested',
        nestingResult: {
          sheetLengthMm: 300,
          placements: [{ pieceIndex: 0, pieceId: 'er1', x: 0, y: 0, sheetIndex: 0, copyIndex: 0, rotated90: truthyRot }],
        },
      };
      const svg = core.exportSVG(pat, opts);
      assert.match(svg, /width="150\.0000mm" height="296\.0000mm"/, `CORE-BUG-I17-05: rotated90=${JSON.stringify(truthyRot)} MUST rotate SVG`);
    }
  }

  // 6. CORE-GAP-I17-01: Self-seam overlap tolerance parity across validateSeam, validatePatternProject, and validatePatternSeams
  {
    const p = core.createRectanglePiece('SelfGap', 100, 100, { id: 'sg1', seamAllowance: 0 });
    const makeSelf = (tEndA, tStartB) =>
      core.createPatternProject({
        pieces: [p],
        seams: [
          core.createSeam({
            id: 's_gap',
            pieceA: 'sg1',
            edgeA: 0,
            tStartA: 0,
            tEndA,
            pieceB: 'sg1',
            edgeB: 0,
            tStartB,
            tEndB: 1,
          }),
        ],
      });
    const ov1e4 = makeSelf(0.5 + 1e-4, 0.5);
    assert.equal(core.validatePatternProject(ov1e4, { throwOnError: false }).valid, false);
    assert.equal(core.validatePatternSeams(ov1e4)[0].status, 'duplicate_edge');
    assert.equal(core.validatePatternSeams(ov1e4)[0].valid, false);

    const ov1e2 = makeSelf(0.5 + 1e-2, 0.5);
    assert.equal(core.validatePatternProject(ov1e2, { throwOnError: false }).valid, false);
    assert.equal(core.validatePatternSeams(ov1e2)[0].status, 'duplicate_edge');

    const disjoint = makeSelf(0.5, 0.5);
    assert.equal(core.validatePatternProject(disjoint, { throwOnError: false }).valid, true);
    assert.equal(core.validatePatternSeams(disjoint)[0].status, 'ok');
    assert.equal(core.validatePatternSeams(disjoint)[0].valid, true);
  }
});

test('adv_i17_ui_and_webgl_coverage: BUG-I17-UI-01..02 and GAP-I17-UI-03 (>65535 Uint32, empty STL, resize(0,0,0))', async () => {
  // 1. GAP-I17-UI-03: WebGL3DViewport mode === 'webgl2' with > 65535 vertices (Uint32Array / UNSIGNED_INT 5125), empty stlMesh, and resize(0, 0, 0)
  {
    const gl = createStrictMockWebGL2Context();
    const uploadedEboTypes = [];
    const origBindBuf = gl.bindBuffer.bind(gl);
    let lastTarget = 0;
    gl.bindBuffer = (target, buf) => {
      lastTarget = target;
      return origBindBuf(target, buf);
    };
    gl.bufferData = (target, data) => {
      if (target === gl.ELEMENT_ARRAY_BUFFER && lastTarget === gl.ELEMENT_ARRAY_BUFFER) {
        uploadedEboTypes.push(data?.constructor?.name || typeof data);
      }
    };
    const canvas = {
      width: 640,
      height: 480,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener() {},
      getContext: (type) => (type === 'webgl2' ? gl : null),
    };
    const vp = createViewport3D(canvas);
    assert.equal(vp.mode, 'webgl2', 'GAP-I17-UI-03: viewport must initialize in webgl2 mode');

    // > 65535 vertices (66,000 particles) with triangles indexing > 65535 and showWire: true
    const numVerts = 66000;
    const particles = new Array(numVerts);
    for (let i = 0; i < numVerts; i++) {
      particles[i] = {
        pos: { x: i % 256, y: Math.floor(i / 256), z: 0 },
        rest2D: { x: i % 256, y: Math.floor(i / 256) },
        color: [0.2, 0.7, 0.5],
        pieceId: 'big_p',
        invMass: 1,
      };
    }
    const triangles = [
      [0, 1, 65535],
      [65535, 65536, 65999],
    ];
    vp.setScene({
      sim: { particles, triangles, sewingConstraints: [] },
      stlMesh: { faces: [], vertices: [] },
      showForm: true,
      showWire: true,
      showThreads: false,
    });
    assert.doesNotThrow(() => vp.resize(0, 0, 0), 'GAP-I17-UI-03: resize(0,0,0) must not crash');
    assert.ok(vp.cssWidth >= 100 && vp.cssHeight >= 100 && vp.dpr >= 1);
    assert.ok(canvas.width >= 1 && canvas.height >= 1);

    const stats = vp.render();
    assert.equal(stats.mode, 'webgl2');
    assert.equal(stats.renderedClothTriangles, 2);
    assert.equal(stats.renderedStlTriangles, 0, 'GAP-I17-UI-03: empty stlMesh renders 0 STL triangles cleanly');
    assert.ok(uploadedEboTypes.includes('Uint32Array'), 'GAP-I17-UI-03: >65535 mesh must upload Uint32Array EBO');
    const elemCalls = gl._state.drawCalls.filter((c) => c.kind === 'drawElements');
    assert.equal(elemCalls.length, 2, 'GAP-I17-UI-03: both cloth triangles and wireframe use drawElements');
    for (const c of elemCalls) {
      assert.equal(c.type, 5125, 'GAP-I17-UI-03: drawElements must use UNSIGNED_INT (5125)');
    }
    vp.dispose();
  }

  // 2. BUG-I17-UI-02 direct CAD2DViewport non-finite pointerdown / pointermove / wheel guards
  {
    const c2 = {
      width: 640,
      height: 480,
      listeners: new Map(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(t, fn) {
        if (!this.listeners.has(t)) this.listeners.set(t, []);
        this.listeners.get(t).push(fn);
      },
      dispatch(t, ev) {
        for (const fn of this.listeners.get(t) || []) fn({ preventDefault() {}, ...ev });
      },
      getContext: () => createMock2DContext(),
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const rectPc = core.createRectanglePiece('CadRect', 100, 100, { id: 'cr1', seamAllowance: 0 });
    rectPc.edges[0].curve = { type: 'quadratic', cp: { x: 50, y: -20 } };
    const pat = core.createPatternProject({ pieces: [rectPc], seams: [] });
    const cad = new CAD2DViewport(c2, {});
    cad._lastScene = { pattern: pat, activeTool: 'select', selectedPieceId: 'cr1', viewMode: '2d' };

    for (const mode of ['piece', 'vertex', 'cp', 'pan']) {
      cad._drag = {
        mode,
        pieceId: 'cr1',
        vertexIndex: 0,
        edgeIndex: 0,
        cpKey: 'cp',
        startWorld: { x: 10, y: 10 },
        pieceStartPos: { x: 0, y: 0 },
        startScreen: { x: 100, y: 100 },
        startPan: { x: cad.cam.panX, y: cad.cam.panY },
        fixedPivot: { x: 50, y: 50 },
      };
      c2.dispatch('pointermove', { clientX: Number.NaN, clientY: 100 });
      c2.dispatch('pointermove', { clientX: 100, clientY: Number.POSITIVE_INFINITY });
      assert.ok(Number.isFinite(rectPc.position.x) && Number.isFinite(rectPc.position.y), `BUG-I17-UI-02 (${mode}): piece.position stayed finite`);
      assert.ok(Number.isFinite(rectPc.points[0].x) && Number.isFinite(rectPc.points[0].y), `BUG-I17-UI-02 (${mode}): vertex stayed finite`);
      assert.ok(Number.isFinite(rectPc.edges[0].curve.cp.x) && Number.isFinite(rectPc.edges[0].curve.cp.y), `BUG-I17-UI-02 (${mode}): cp stayed finite`);
      assert.ok(Number.isFinite(cad.cam.panX) && Number.isFinite(cad.cam.panY), `BUG-I17-UI-02 (${mode}): pan stayed finite`);
      assert.ok(Number.isFinite(cad.mouseWorld.x) && Number.isFinite(cad.mouseWorld.y), `BUG-I17-UI-02 (${mode}): mouseWorld stayed finite`);
    }
    cad._drag = null;
    c2.dispatch('pointerdown', { clientX: Number.NaN, clientY: 100, button: 0 });
    assert.equal(cad._drag, null, 'BUG-I17-UI-02: non-finite pointerdown must not start drag');
    const zoomBefore = cad.cam.zoom;
    c2.dispatch('wheel', { clientX: Number.NaN, clientY: 100, deltaY: -120 });
    c2.dispatch('wheel', { clientX: 100, clientY: 100, deltaY: Number.NaN });
    assert.equal(cad.cam.zoom, zoomBefore, 'BUG-I17-UI-02: non-finite wheel must not mutate zoom');
  }

  // 3. BUG-I17-UI-01 & BUG-I17-UI-02 end-to-end inside app.mjs mock DOM + live server
  const srv = await startServer({ port: 0, host: '127.0.0.1', publicDir: PUBLIC_DIR });
  const baseUrl = `http://127.0.0.1:${srv.server.address().port}`;
  const htmlTextI17 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlTextI17.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      className: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentNode: null,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      appendChild(c) {
        children.push(c);
        c.parentNode = elObj;
        c.parentElement = elObj;
        return c;
      },
      replaceChild(newChild, oldChild) {
        const idx = children.indexOf(oldChild);
        if (idx >= 0) children[idx] = newChild;
        else children.push(newChild);
        newChild.parentNode = elObj;
        newChild.parentElement = elObj;
        oldChild.parentNode = null;
        oldChild.parentElement = null;
        return oldChild;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        return c;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) this.appendChild(n);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (elObj.tagName !== 'CANVAS') return null;
        if (type === 'webgl2') return createStrictMockWebGL2Context();
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    const node = makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id);
    if (id === 'canvas2D' || id === 'canvas3D') {
      const wrap = makeEl('div', '');
      wrap.appendChild(node);
    }
    elements.set(id, node);
  }
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?i17=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;
    const toast = elements.get('studioToast');

    // BUG-I17-UI-01: JSON import with pieces: [] must reject cleanly with error toast & keep prior pattern/history/export intact
    const prevPatSnapshot = JSON.stringify(st.pattern);
    const prevPiecesLen = st.pattern.pieces.length;
    const prevSelectedId = st.selectedPieceId;
    const prevUndoDisabled = elements.get('btnUndo').disabled;
    const jsonInp = elements.get('jsonFileInput');
    jsonInp.value = 'empty.json';
    jsonInp.files = [{ name: 'empty.json', text: async () => JSON.stringify({ version: 2, name: 'EmptyPat', unit: 'mm', pieces: [], seams: [] }) }];
    toast.textContent = '';
    toast.classList.remove('toast-error');
    jsonInp.dispatchEvent({ type: 'change' });
    await waitUntil(() => toast.textContent.includes('JSON Import failed'));
    assert.ok(toast.classList.contains('toast-error'), 'BUG-I17-UI-01: empty pieces JSON import must show error toast');
    assert.equal(st.pattern.pieces.length, prevPiecesLen, 'BUG-I17-UI-01: prior pieces must stay intact');
    assert.equal(JSON.stringify(st.pattern), prevPatSnapshot, 'BUG-I17-UI-01: prior pattern must be unmutated');
    assert.equal(st.selectedPieceId, prevSelectedId);
    assert.equal(elements.get('btnUndo').disabled, prevUndoDisabled);
    assert.equal(jsonInp.value, '');

    // Verify /api/export PDF still succeeds on preserved pattern
    const exportRes = await nativeFetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: st.pattern, format: 'pdf', options: { pageFormat: 'LETTER' } }),
    });
    assert.equal(exportRes.status, 200);

    // BUG-I17-UI-02: pointermove NaN clientX during piece drag + onAfterMutate rollback on invalid pattern mutation
    const canvas2dEl = elements.get('canvas2D');
    const worldStart = appMod.cad2D.worldToScreen(
      st.pattern.pieces[0].points[0].x + (st.pattern.pieces[0].position?.x || 0) + 10,
      st.pattern.pieces[0].points[0].y + (st.pattern.pieces[0].position?.y || 0) + 10
    );
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: worldStart.x, clientY: worldStart.y, button: 0, pointerId: 1 });
    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: Number.NaN, clientY: worldStart.y, pointerId: 1 });
    assert.doesNotThrow(() => canvas2dEl.dispatchEvent({ type: 'pointerup', clientX: worldStart.x, clientY: worldStart.y, pointerId: 1 }));
    assert.ok(Number.isFinite(st.pattern.pieces[0].position.x) && Number.isFinite(st.pattern.pieces[0].position.y));

    // Direct onBeforeMutate -> poisoned vertex mutation -> onAfterMutate rollback check
    const prePoisonPt = { ...st.pattern.pieces[0].points[0] };
    appMod.cad2D.callbacks.onBeforeMutate('Poison drag');
    st.pattern.pieces[0].points[0] = { x: Number.NaN, y: Number.NaN };
    toast.textContent = '';
    toast.classList.remove('toast-error');
    assert.doesNotThrow(() => appMod.cad2D.callbacks.onAfterMutate(), 'BUG-I17-UI-02: onAfterMutate must catch and roll back');
    assert.ok(toast.classList.contains('toast-error'));
    assert.equal(st.pattern.pieces[0].points[0].x, prePoisonPt.x);
    assert.equal(st.pattern.pieces[0].points[0].y, prePoisonPt.y);
    assert.equal(elements.get('btnUndo').disabled, prevUndoDisabled, 'BUG-I17-UI-02: failed drag rollback must restore undoStack');

    // Material slider / weave / color handler rollback on failure
    const origUpdateMat = st.sim.updateMaterial;
    const prevMatJson = JSON.stringify(st.pattern.material);
    const prevOverridesJson = JSON.stringify(st.materialOverrides);
    st.sim.updateMaterial = () => { throw new Error('Mock material failure'); };
    for (const [elId, evType, val] of [
      ['matSlider_roughness', 'input', '0.9'],
      ['matWeaveTypeSelect', 'change', 'leather_grain'],
      ['matWarpColor', 'input', '#ff0000'],
    ]) {
      const ctrl = elements.get(elId);
      if (!ctrl) continue;
      toast.textContent = '';
      toast.classList.remove('toast-error');
      ctrl.value = val;
      assert.doesNotThrow(() => ctrl.dispatchEvent({ type: evType }));
      assert.ok(toast.classList.contains('toast-error'));
      assert.equal(JSON.stringify(st.pattern.material), prevMatJson);
      assert.equal(JSON.stringify(st.materialOverrides), prevOverridesJson);
    }
    st.sim.updateMaterial = origUpdateMat;
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

// ============================================================================
// Iteration 18 Tier-5 Regression Tests (`adv_i18_*`)
// ============================================================================

test('adv_i18_core_fixes: CORE-BUG-I18-01..03, CORE-GAP-I18-01, and zero-length darted split parity', async () => {
  // 1. CORE-BUG-I18-01: Origin-shifted signedPolygonArea & polygonCentroid at 1e10..1e14 + subnormals & 1e307
  for (const offset of [0, 1e10, 1e12, 1e14]) {
    const sqCCW = [
      { x: offset, y: offset },
      { x: offset + 100, y: offset },
      { x: offset + 100, y: offset + 100 },
      { x: offset, y: offset + 100 },
    ];
    const sqCW = [...sqCCW].reverse();

    assertNear(core.signedPolygonArea(sqCCW), 10000, 1e-2, `signedPolygonArea CCW @ ${offset}`);
    assertNear(core.signedPolygonArea(sqCW), -10000, 1e-2, `signedPolygonArea CW @ ${offset}`);

    const centCCW = core.polygonCentroid(sqCCW);
    const centCW = core.polygonCentroid(sqCW);
    const centTol = offset >= 1e14 ? 0.05 : 1e-3;
    assertNear(centCCW.x, offset + 50, centTol, `polygonCentroid CCW X @ ${offset}`);
    assertNear(centCCW.y, offset + 50, centTol, `polygonCentroid CCW Y @ ${offset}`);
    assertNear(centCW.x, offset + 50, centTol, `polygonCentroid CW X @ ${offset}`);
    assertNear(centCW.y, offset + 50, centTol, `polygonCentroid CW Y @ ${offset}`);

    const ff = core.createFreeformPiece(`FF_${offset}`, sqCCW, { seamAllowance: 10 });
    assert.equal(ff.points.length, 4);
    assertNear(core.polygonArea(ff.points), 10000, 1e-2);

    const outOffset = core.offsetPolygonOutward(sqCCW, 10);
    const outBounds = core.polygonBounds(outOffset);
    assertNear(outBounds.width, 120, 0.05, `offsetPolygonOutward width @ ${offset}`);
    assertNear(outBounds.height, 120, 0.05, `offsetPolygonOutward height @ ${offset}`);

    const pieceAtOffset = {
      id: `far_${offset}`,
      name: `Far_${offset}`,
      points: sqCCW,
      edges: [{}, {}, {}, {}],
      seamAllowance: 10,
      notches: [{ id: 'n0', edgeIndex: 0, t: 0.5, type: 'single', depthMm: 5 }],
    };
    const notches = core.computePieceNotches(pieceAtOffset);
    assert.equal(notches.length, 1);
    assertNear(notches[0].normal.x, 0, 1e-6, `notch normal X @ ${offset}`);
    assertNear(notches[0].normal.y, -1, 1e-6, `notch normal Y outward @ ${offset}`);

    const meas = core.computePieceMeasurements(pieceAtOffset);
    assertNear(meas.netAreaMm2, 10000, 1, `computePieceMeasurements netAreaMm2 @ ${offset}`);
    assertNear(meas.cutAreaMm2, 14400, 5, `computePieceMeasurements cutAreaMm2 @ ${offset}`);
    assertNear(meas.centroidMm.x, offset + 50, centTol, `meas centroidMm.x @ ${offset}`);

    const pivot = core.getPieceTransformPivot(pieceAtOffset);
    assertNear(pivot.x, offset + 50, centTol, `getPieceTransformPivot X @ ${offset}`);
    assertNear(pivot.y, offset + 50, centTol, `getPieceTransformPivot Y @ ${offset}`);

    const grain = core.computePieceGrainline(pieceAtOffset, { worldSpace: true });
    assert.ok(
      grain.start.x >= offset - 1 && grain.start.x <= offset + 101 &&
      grain.start.y >= offset - 1 && grain.start.y <= offset + 101,
      `grainline start stays inside piece @ ${offset}`
    );
    assert.ok(
      grain.end.x >= offset - 1 && grain.end.x <= offset + 101 &&
      grain.end.y >= offset - 1 && grain.end.y <= offset + 101,
      `grainline end stays inside piece @ ${offset}`
    );

    const svg = core.exportSVG({ id: `far_svg_${offset}`, unit: 'mm', pieces: [pieceAtOffset], seams: [] });
    const widthMatch = svg.match(/width="([^"]+)mm"/);
    assert.ok(widthMatch, `SVG width present @ ${offset}`);
    const svgWidth = Number(widthMatch[1]);
    assertNear(svgWidth, 150, 0.5, `SVG width @ ${offset} must be ~150mm (not billion-mm cancellation)`);
  }

  // Subnormal and 1e307 extremes remain finite & accurate
  const subTiny = [
    { x: 0, y: 0 },
    { x: 1e-160, y: 0 },
    { x: 1e-160, y: 1e-160 },
    { x: 0, y: 1e-160 },
  ];
  assert.ok(Number.isFinite(core.signedPolygonArea(subTiny)) && core.signedPolygonArea(subTiny) >= 0);
  const subCent = core.polygonCentroid(subTiny);
  assertNear(subCent.x, 0.5e-160, 1e-170);
  const far1e307 = [
    { x: 1e307, y: 1e307 },
    { x: 1e307, y: -1e307 },
    { x: -1e307, y: -1e307 },
    { x: -1e307, y: 1e307 },
  ];
  assert.ok(Number.isFinite(core.signedPolygonArea(far1e307)) && core.signedPolygonArea(far1e307) < 0);
  const farCent307 = core.polygonCentroid(far1e307);
  assertNear(farCent307.x, 0, 1e295);
  assertNear(farCent307.y, 0, 1e295);

  // 2. CORE-BUG-I18-02: exporters.mjs unit === 'mm' rejects non-finite position/rotation/rotationOrigin/curve/internalLines
  const makeBaseRect = () => core.createRectanglePiece('ExpRect', 100, 80, { seamAllowance: 5 });
  const badPieces = [
    (() => { const p = makeBaseRect(); p.position = { x: Number.POSITIVE_INFINITY, y: 0 }; return p; })(),
    (() => { const p = makeBaseRect(); p.position = { x: Number.NaN, y: 0 }; return p; })(),
    (() => { const p = makeBaseRect(); p.position = null; return p; })(),
    (() => { const p = makeBaseRect(); p.rotation = Number.POSITIVE_INFINITY; return p; })(),
    (() => { const p = makeBaseRect(); p.rotation = Number.NaN; return p; })(),
    (() => { const p = makeBaseRect(); p.rotationOrigin = { x: 0, y: Number.NaN }; return p; })(),
    (() => { const p = makeBaseRect(); p.edges[0].curve = { cp: { x: Number.NaN, y: 10 } }; return p; })(),
    (() => { const p = makeBaseRect(); p.edges[0].curve = { cp1: { x: Number.POSITIVE_INFINITY, y: 10 }, cp2: { x: 50, y: 10 } }; return p; })(),
    (() => { const p = makeBaseRect(); p.edges[0].curve = {}; return p; })(),
    (() => { const p = makeBaseRect(); p.internalLines = [{ id: 'il', points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 20 }] }]; return p; })(),
    (() => { const p = makeBaseRect(); p.internalLines = [{ id: 'il', points: [{ x: 0, y: 0 }] }]; return p; })(),
    (() => { const p = makeBaseRect(); p.internalLines = 'not_an_array'; return p; })(),
  ];
  for (const u of ['mm', 'in', 'cm']) {
    for (const bp of badPieces) {
      const badProj = { id: 'bad_exp', unit: u, pieces: [bp], seams: [] };
      for (const fn of [core.exportSVG, core.exportDXF, core.exportTiledPDF]) {
        assert.throws(
          () => fn(badProj),
          (err) => err instanceof core.ValidationError,
          `CORE-BUG-I18-02: ${fn.name} (unit=${u}) must throw ValidationError on malformed piece geometry`
        );
      }
    }
  }
  // Intentional m3 Symbol tolerance on piece.id / piece.quantity remains intact
  const symOk = makeBaseRect();
  symOk.id = Symbol('m3_id');
  symOk.quantity = Symbol('m3_qty');
  assert.ok(core.exportSVG({ unit: 'mm', pieces: [symOk], seams: [] }).includes('<svg'));

  // 3. CORE-BUG-I18-03: splitPieceEdge avoids duplicate seam ID collisions
  const spA = core.createRectanglePiece('SpA', 100, 100, { id: 'a' });
  const spB = core.createRectanglePiece('SpB', 100, 100, { id: 'b' });
  const dupSplitPat = {
    id: 'dup_split',
    name: 'DupSplit',
    unit: 'mm',
    pieces: [spA, spB],
    seams: [
      core.createSeam({ id: 's1', pieceA: 'a', edgeA: 0, pieceB: 'b', edgeB: 0 }),
      core.createSeam({ id: 's1_a', pieceA: 'a', edgeA: 1, pieceB: 'b', edgeB: 1 }),
      core.createSeam({ id: 's1_b', pieceA: 'a', edgeA: 2, pieceB: 'b', edgeB: 2 }),
    ],
  };
  core.splitPieceEdge(spA, 0, 0.5, dupSplitPat);
  const seamIdsAfter = dupSplitPat.seams.map((s) => s.id);
  assert.equal(seamIdsAfter.length, new Set(seamIdsAfter).size, `splitPieceEdge produced duplicate seam IDs: ${JSON.stringify(seamIdsAfter)}`);
  assert.equal(core.validatePatternProject(dupSplitPat, { throwOnError: false }).valid, true);

  // Also test splitting when both s1 and s1_a straddle the SAME split edge
  const spC = core.createRectanglePiece('SpC', 100, 100, { id: 'c' });
  const spD = core.createRectanglePiece('SpD', 100, 100, { id: 'd' });
  const sameEdgePat = {
    id: 'same_edge_dup',
    name: 'SameEdgeDup',
    unit: 'mm',
    pieces: [spC, spD],
    seams: [
      core.createSeam({ id: 's1', pieceA: 'c', edgeA: 0, tStartA: 0, tEndA: 0.45, pieceB: 'd', edgeB: 0, tStartB: 0, tEndB: 0.45 }),
      core.createSeam({ id: 's1_a', pieceA: 'c', edgeA: 0, tStartA: 0.55, tEndA: 1, pieceB: 'd', edgeB: 1, tStartB: 0, tEndB: 0.45 }),
    ],
  };
  // Split at t=0.25 splits s1 ([0,0.45]) into 2 seams, while s1_a stays intact -> s1_a must not collide
  core.splitPieceEdge(spC, 0, 0.25, sameEdgePat);
  assert.equal(sameEdgePat.seams.length, 3);
  assert.equal(
    new Set(sameEdgePat.seams.map((s) => s.id)).size,
    3,
    'splitPieceEdge must not collide with retained s1_a seam on same edge'
  );
  assert.equal(core.validatePatternProject(sameEdgePat, { throwOnError: false }).valid, true);

  // 4. CORE-GAP-I18-01: validatePatternSeams aligns with validateSeam on internalSegmentIndexB: null, internalLineIdB: null, and out-of-range edgeA/edgeB
  const gpA = core.createRectanglePiece('GA', 100, 50, { id: 'ga' });
  const gpB = core.createRectanglePiece('GB', 100, 50, {
    id: 'gb',
    internalLines: [{ id: 'il1', type: 'stitch', points: [{ x: 0, y: 20 }, { x: 100, y: 20 }] }],
  });
  for (const badSeam of [
    { id: 's_null_seg', pieceA: 'ga', edgeA: 0, pieceB: 'gb', internalLineIdB: 'il1', internalSegmentIndexB: null },
    { id: 's_null_il', pieceA: 'ga', edgeA: 0, pieceB: 'gb', edgeB: 0, internalLineIdB: null },
    { id: 's_oob_ea', pieceA: 'ga', edgeA: 99, pieceB: 'gb', edgeB: 0 },
    { id: 's_neg_ea', pieceA: 'ga', edgeA: -1, pieceB: 'gb', edgeB: 0 },
    { id: 's_oob_eb', pieceA: 'ga', edgeA: 0, pieceB: 'gb', edgeB: 4 },
    { id: 's_neg_eb', pieceA: 'ga', edgeA: 0, pieceB: 'gb', edgeB: -2 },
  ]) {
    const badProj = { unit: 'mm', pieces: [gpA, gpB], seams: [badSeam] };
    assert.equal(core.validatePatternProject(badProj, { throwOnError: false }).valid, false);
    const [rep] = core.validatePatternSeams(badProj);
    assert.equal(rep.valid, false, `CORE-GAP-I18-01: validatePatternSeams must reject ${badSeam.id}`);
    assert.equal(rep.status, 'invalid_seam', `CORE-GAP-I18-01: ${badSeam.id} status must be invalid_seam`);
  }
  const okUndefinedSeg = {
    unit: 'mm',
    pieces: [gpA, gpB],
    seams: [{ id: 's_undef_seg', pieceA: 'ga', edgeA: 0, pieceB: 'gb', internalLineIdB: 'il1', internalSegmentIndexB: undefined }],
  };
  assert.equal(core.validatePatternProject(okUndefinedSeg, { throwOnError: false }).valid, true);
  assert.equal(core.validatePatternSeams(okUndefinedSeg)[0].valid, true);

  // 5. Reviewer I17 note: zero-length darted edge in computeOppSplitT splits symmetrically around 0.5 (not skewed to 1e-4)
  for (const rev of [false, true]) {
    const zA = core.createRectanglePiece('ZA', 100, 100, { id: 'zA', seamAllowance: 0 });
    const zB = core.createPatternPiece({
      id: 'zB',
      name: 'ZeroDartB',
      points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }],
      darts: [{ id: 'd1', edgeIndex: 0, t: 0.5, widthMm: 5, depthMm: 10, folded: false }],
      seamAllowance: 0,
    });
    const zPat = core.createPatternProject({
      pieces: [zA, zB],
      seams: [core.createSeam({ id: 'sz', pieceA: 'zA', edgeA: 0, pieceB: 'zB', edgeB: 0, reversed: rev })],
    });
    core.splitPieceEdge(zA, 0, 0.5, zPat);
    assert.equal(zPat.seams.length, 2);
    if (rev) {
      assertNear(zPat.seams[0].tStartB, 0.5, 1e-6, 'zero-len darted opp split (rev=true) seam[0].tStartB');
      assertNear(zPat.seams[1].tEndB, 0.5, 1e-6, 'zero-len darted opp split (rev=true) seam[1].tEndB');
    } else {
      assertNear(zPat.seams[0].tEndB, 0.5, 1e-6, 'zero-len darted opp split (rev=false) seam[0].tEndB');
      assertNear(zPat.seams[1].tStartB, 0.5, 1e-6, 'zero-len darted opp split (rev=false) seam[1].tStartB');
    }
    assert.equal(core.validatePatternProject(zPat, { throwOnError: false }).valid, true);
  }
});

test('adv_i18_cli_server_ui_and_webgl: BUG-I18-CLI-01..02, OBS-I17-01, BUG-I18-UI-01..03, 05..06, and material sim rollback', async () => {
  // 1. BUG-I18-CLI-01 & BUG-I18-CLI-02: --h and --help=false / --help=bogus
  const cliH = await runCliProcess(['--h']);
  assert.equal(cliH.code, 0, cliH.stderr);
  assert.match(cliH.stdout, /Usage:/);

  const cliSubH = await runCliProcess(['template', '--h']);
  assert.equal(cliSubH.code, 0, cliSubH.stderr);
  assert.match(cliSubH.stdout, /Usage:/);

  for (const helpFalseFlag of ['--help=false', '--h=false']) {
    const res = await runCliProcess([helpFalseFlag, 'list']);
    assert.equal(res.code, 0, `${helpFalseFlag} list failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.templates.length, 11);
  }

  const cliHelpTrue = await runCliProcess(['--help=true']);
  assert.equal(cliHelpTrue.code, 0, cliHelpTrue.stderr);
  assert.match(cliHelpTrue.stdout, /Usage:/);

  for (const badBoolArg of ['--help=bogus', '--help=', '--h=maybe']) {
    const res = await runCliProcess([badBoolArg, 'list']);
    assert.equal(res.code, 1, `Expected exit 1 for ${badBoolArg}`);
    assert.match(res.stderr, /Invalid boolean value/);
  }

  // 2. WebGL3DViewport: BUG-I18-UI-01 (non-finite pointers/wheel) & BUG-I18-UI-02 (context lost/restored)
  {
    const gl = createStrictMockWebGL2Context();
    let contextLostFlag = false;
    gl.isContextLost = () => contextLostFlag;

    const canvasListeners = new Map();
    const removedListeners = [];
    const c3 = {
      width: 640,
      height: 480,
      getContext(type) { return type === 'webgl2' ? gl : null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
      addEventListener(type, fn, opts) {
        if (!canvasListeners.has(type)) canvasListeners.set(type, []);
        canvasListeners.get(type).push({ fn, opts });
      },
      removeEventListener(type, fn, opts) {
        removedListeners.push({ type, fn, opts });
        const arr = canvasListeners.get(type) || [];
        canvasListeners.set(type, arr.filter((e) => e.fn !== fn));
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const emitC3 = (type, ev = {}) => {
      for (const entry of canvasListeners.get(type) || []) {
        entry.fn(ev);
      }
    };

    const tshirt = core.generateTemplatePattern('tshirt');
    const avatar = core.createParametricAvatar();
    const sim = new core.ClothSimulation(tshirt, { avatar, maxEdgeLengthMm: 60 });
    const vp3 = createViewport3D(c3);
    assert.equal(vp3.mode, 'webgl2');
    vp3.setScene({
      sim,
      avatar,
      materialConfig: core.getMaterialConfig('cotton_jersey'),
      showForm: true,
      showWire: true,
      showThreads: true,
      pinMode: true,
    });
    vp3.render();

    // Find projected screen pos of particle 0 to test pin-drag poisoning guards
    const { viewProj } = vp3._getCameraMatrices();
    const p0Proj = vp3._projectPoint(sim.particles[0].pos, viewProj);
    assert.ok(p0Proj, 'Particle 0 should project cleanly');
    const initCam = JSON.stringify(vp3.cam);
    const initP0 = { ...sim.particles[0].pos };

    // Non-finite pointerdown / pointermove / wheel / movePinnedParticle / pickParticle
    emitC3('pointerdown', { button: 0, clientX: Number.NaN, clientY: 100, pointerId: 1 });
    emitC3('pointerdown', { button: 0, clientX: 100, clientY: Number.POSITIVE_INFINITY, pointerId: 1 });
    assert.equal(vp3._drag, null);

    // Orbit drag + NaN pointermove
    vp3.setScene({ pinMode: false });
    emitC3('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
    emitC3('pointermove', { clientX: Number.NaN, clientY: Number.POSITIVE_INFINITY, pointerId: 2 });
    emitC3('pointerup', { clientX: 100, clientY: 100, pointerId: 2 });
    assert.equal(JSON.stringify(vp3.cam), initCam, 'BUG-I18-UI-01: NaN pointermove must not poison cam');

    // Pin drag + NaN pointermove + pointercancel does not toggle pin
    vp3.setScene({ pinMode: true });
    const origInvMass0 = sim.particles[0].invMass;
    emitC3('pointerdown', { button: 0, clientX: p0Proj.sx, clientY: p0Proj.sy, pointerId: 3 });
    assert.equal(vp3._drag?.mode, 'pin');
    emitC3('pointermove', { clientX: Number.NaN, clientY: Number.NaN, pointerId: 3 });
    emitC3('pointercancel', { pointerId: 3 });
    assert.equal(sim.particles[0].pos.x, initP0.x);
    assert.equal(sim.particles[0].pos.y, initP0.y);
    assert.equal(sim.particles[0].pos.z, initP0.z);
    assert.equal(sim.particles[0].invMass, origInvMass0, 'pointercancel must not toggle pin');

    vp3.movePinnedParticle(0, Number.NaN, Number.POSITIVE_INFINITY);
    assert.equal(sim.particles[0].pos.x, initP0.x);
    assert.equal(vp3.pickParticle(Number.NaN, 100), null);

    emitC3('wheel', { deltaY: Number.NaN, preventDefault() {} });
    emitC3('wheel', { deltaY: Number.POSITIVE_INFINITY, preventDefault() {} });
    assert.equal(vp3.cam.distance, JSON.parse(initCam).distance);

    // BUG-I18-UI-02: webglcontextlost & webglcontextrestored
    let preventCalled = false;
    contextLostFlag = true;
    emitC3('webglcontextlost', { preventDefault() { preventCalled = true; } });
    assert.equal(preventCalled, true, 'BUG-I18-UI-02: webglcontextlost must call preventDefault()');
    assert.equal(vp3._contextLost, true);

    const drawsBeforeLost = gl._state.drawCalls.length;
    vp3.updateMaterialMaps(core.getMaterialConfig('veg_leather'));
    vp3._markDirty();
    vp3.render();
    assert.equal(gl._state.drawCalls.length, drawsBeforeLost, 'BUG-I18-UI-02: no GL drawCalls while context lost');

    const progsBeforeRestore = gl._state.programs.size;
    contextLostFlag = false;
    emitC3('webglcontextrestored', {});
    assert.equal(vp3._contextLost, false);
    assert.ok(gl._state.programs.size > progsBeforeRestore, 'BUG-I18-UI-02: webglcontextrestored must re-create GL programs');
    vp3.render();
    assert.ok(gl._state.drawCalls.length > drawsBeforeLost, 'BUG-I18-UI-02: rendering resumes after context restore');

    const totalAdded = Array.from(canvasListeners.values()).reduce((sum, a) => sum + a.length, 0);
    assert.ok(totalAdded >= 8, 'Expected pointer/wheel/context listeners registered');
    vp3.dispose();
    assert.equal(removedListeners.length, totalAdded, 'dispose() must remove all canvas listeners');
  }

  // 3. Standalone CAD2DViewport: BUG-I18-UI-03 (pointercancel rollback) & BUG-I18-UI-05 (nested pointerdown + pointerId)
  {
    const c2Listeners = new Map();
    const c2 = {
      width: 640,
      height: 480,
      getContext() { return createMock2DContext(); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
      addEventListener(type, fn) {
        if (!c2Listeners.has(type)) c2Listeners.set(type, []);
        c2Listeners.get(type).push(fn);
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const emitC2 = (type, ev) => {
      for (const fn of c2Listeners.get(type) || []) fn(ev);
    };

    const rect = core.createRectanglePiece('StandaloneDrag', 120, 80, { id: 'sd', seamAllowance: 10 });
    rect.edges[0].curve = { cp1: { x: 40, y: -30 }, cp2: { x: 80, y: -30 } };
    const pat = { id: 'sd_pat', unit: 'mm', pieces: [rect], seams: [] };
    let beforeCalls = 0;
    let afterCalls = 0;
    let cancelCalls = 0;
    const cad = new CAD2DViewport(c2, {
      onBeforeMutate() { beforeCalls += 1; },
      onAfterMutate() { afterCalls += 1; },
      onCancelMutate() { cancelCalls += 1; },
    });
    const scene = {
      pattern: pat,
      unit: 'mm',
      viewMode: '2d',
      activeTool: 'select',
      selectedPieceId: 'sd',
      selectedEdgeIndex: 0,
      selectedVertexIndex: -1,
    };
    cad.fitToContent(scene);
    cad.render(scene);

    // 3a) Vertex drag -> pointercancel restores exact point without calling onAfterMutate
    const origV0 = { ...rect.points[0] };
    const wV0 = cad.pieceLocalToWorld(rect, origV0);
    const sV0 = cad.worldToScreen(wV0.x, wV0.y);
    emitC2('pointerdown', { button: 0, clientX: sV0.x, clientY: sV0.y, pointerId: 10 });
    assert.equal(cad._drag?.mode, 'vertex');
    emitC2('pointermove', { clientX: sV0.x + 40, clientY: sV0.y + 30, pointerId: 10 });
    assert.notEqual(rect.points[0].x, origV0.x);
    emitC2('pointercancel', { pointerId: 10 });
    assert.equal(afterCalls, 0, 'BUG-I18-UI-03: pointercancel must not call onAfterMutate');
    assert.equal(cancelCalls, 1, 'BUG-I18-UI-03: pointercancel must call onCancelMutate');
    assert.deepEqual(rect.points[0], origV0, 'BUG-I18-UI-03: standalone vertex drag cancel restores point');

    // 3b) Curve CP drag -> pointercancel restores exact cp1
    const origCp1 = { ...rect.edges[0].curve.cp1 };
    const wCp1 = cad.pieceLocalToWorld(rect, origCp1);
    const sCp1 = cad.worldToScreen(wCp1.x, wCp1.y);
    emitC2('pointerdown', { button: 0, clientX: sCp1.x, clientY: sCp1.y, pointerId: 11 });
    assert.equal(cad._drag?.mode, 'cp');
    emitC2('pointermove', { clientX: sCp1.x + 25, clientY: sCp1.y - 25, pointerId: 11 });
    assert.notEqual(rect.edges[0].curve.cp1.x, origCp1.x);
    emitC2('pointercancel', { pointerId: 11 });
    assert.equal(afterCalls, 0);
    assert.equal(cancelCalls, 2);
    assert.deepEqual(rect.edges[0].curve.cp1, origCp1, 'BUG-I18-UI-03: standalone CP drag cancel restores cp1');

    // 3c) Piece body drag -> pointercancel restores exact position
    const origPos = { ...rect.position };
    const wCenter = cad.pieceLocalToWorld(rect, { x: 60, y: 40 });
    const sCenter = cad.worldToScreen(wCenter.x, wCenter.y);
    emitC2('pointerdown', { button: 0, clientX: sCenter.x, clientY: sCenter.y, pointerId: 12 });
    assert.equal(cad._drag?.mode, 'piece');
    emitC2('pointermove', { clientX: sCenter.x + 30, clientY: sCenter.y + 20, pointerId: 12 });
    assert.notEqual(rect.position.x, origPos.x);
    emitC2('pointercancel', { pointerId: 12 });
    assert.equal(afterCalls, 0);
    assert.equal(cancelCalls, 3);
    assert.deepEqual(rect.position, origPos, 'BUG-I18-UI-03: standalone piece drag cancel restores position');

    // 3c-pan) Background pan drag -> pointercancel restores panX/panY without calling onAfterMutate/onCancelMutate
    const origPanX = cad.cam.panX;
    const origPanY = cad.cam.panY;
    emitC2('pointerdown', { button: 2, clientX: 5, clientY: 5, pointerId: 13 });
    assert.equal(cad._drag?.mode, 'pan');
    emitC2('pointermove', { clientX: 55, clientY: 45, pointerId: 13 });
    assert.notEqual(cad.cam.panX, origPanX);
    emitC2('pointercancel', { pointerId: 13 });
    assert.equal(cad.cam.panX, origPanX);
    assert.equal(cad.cam.panY, origPanY);
    assert.equal(afterCalls, 0);
    assert.equal(cancelCalls, 3);

    // 3d) Nested pointerdown mid-drag & mismatched pointerId ignored
    const beforeCount0 = beforeCalls;
    emitC2('pointerdown', { button: 0, clientX: sV0.x, clientY: sV0.y, pointerId: 20 });
    assert.equal(beforeCalls, beforeCount0 + 1);
    emitC2('pointermove', { clientX: sV0.x + 20, clientY: sV0.y + 10, pointerId: 20 });
    const draggedX = rect.points[0].x;
    emitC2('pointerdown', { button: 0, clientX: sCp1.x, clientY: sCp1.y, pointerId: 21 });
    assert.equal(beforeCalls, beforeCount0 + 1, 'BUG-I18-UI-05: nested pointerdown must not fire onBeforeMutate');
    emitC2('pointermove', { clientX: sCp1.x + 99, clientY: sCp1.y + 99, pointerId: 21 });
    emitC2('pointerup', { clientX: sCp1.x + 99, clientY: sCp1.y + 99, pointerId: 21 });
    assert.equal(afterCalls, 0, 'BUG-I18-UI-05: mismatched pointerup must not end active drag');
    assert.equal(rect.points[0].x, draggedX, 'Mismatched pointermove must not alter active drag');
    emitC2('pointerup', { clientX: sV0.x + 20, clientY: sV0.y + 10, pointerId: 20 });
    assert.equal(afterCalls, 1, 'Matching pointerup commits cleanly once');
  }

  // 4. Live Server OBS-I17-01 & Integrated app.mjs (BUG-I18-UI-03, 05, 06 & Reviewer I17 material rollback)
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const htmlText = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlText.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      className: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      style: {},
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentNode: null,
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners.has(type)) return;
        listeners.set(type, listeners.get(type).filter((f) => f !== fn));
      },
      dispatchEvent(ev) {
        const event = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(event.type) || []) fn(event);
      },
      appendChild(ch) { children.push(ch); ch.parentElement = elObj; return ch; },
      replaceChildren(...chs) { children.length = 0; chs.forEach((c) => elObj.appendChild(c)); },
      querySelectorAll: () => [],
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (elObj.tagName !== 'CANVAS') return null;
        if (type === 'webgl2') return createStrictMockWebGL2Context();
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    const node = makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id);
    if (id === 'canvas2D' || id === 'canvas3D') {
      const wrap = makeEl('div', '');
      wrap.appendChild(node);
    }
    elements.set(id, node);
  }
  elements.get('unitSelect').value = 'mm';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;
  const toolBtns = [makeEl('button', '')];
  toolBtns[0].dataset.tool = 'select';

  try {
    // 4a) OBS-I17-01: server assertOptionalFiniteInput rejects empty/whitespace strings with 400
    const validPat = core.generateTemplatePattern('tshirt');
    const boxStl = core.createBoxSTL(40, 40, 20);
    for (const [ep, payload] of [
      ['/api/simulate', { pattern: validPat, steps: '' }],
      ['/api/export', { pattern: validPat, format: 'svg', options: { scale: '  ' } }],
      ['/api/unwrap-stl', { stlText: boxStl, easeMm: '' }],
      ['/api/generate-template', { templateId: 'tshirt', thicknessMm: ' ' }],
    ]) {
      const r = await nativeFetch(`${baseUrl}${ep}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 400, `OBS-I17-01: ${ep} ${JSON.stringify(payload)} must return 400`);
    }

    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => (sel === '.tool-btn[data-tool]' ? toolBtns : []),
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?i18=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;
    const toast = elements.get('studioToast');

    // Create 1 valid undoable action first so both undoStack and btnUndo state are nontrivial
    elements.get('btnDuplicatePiece').dispatchEvent({ type: 'click' });
    assert.equal(elements.get('btnUndo').disabled, false);

    // 4b) Integrated BUG-I18-UI-03 & BUG-I18-UI-05 in app.mjs
    const canvas2dEl = elements.get('canvas2D');
    const p0 = st.pattern.pieces[0];
    const v0 = p0.points[0];
    const p0World = appMod.cad2D.pieceLocalToWorld(p0, v0);
    const p0Screen = appMod.cad2D.worldToScreen(p0World.x, p0World.y);
    const preCancelSnap = JSON.stringify(st.pattern);
    const preCancelSim = appMod.viewport3D.scene.sim;
    const preUndoDisabled = elements.get('btnUndo').disabled;
    const preRedoDisabled = elements.get('btnRedo').disabled;

    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: p0Screen.x, clientY: p0Screen.y, button: 0, pointerId: 30 });
    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: p0Screen.x + 35, clientY: p0Screen.y + 25, pointerId: 30 });
    // Nested pointerdown mid-drag must be ignored cleanly
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: p0Screen.x + 5, clientY: p0Screen.y + 5, button: 0, pointerId: 31 });
    canvas2dEl.dispatchEvent({ type: 'pointerup', clientX: p0Screen.x + 5, clientY: p0Screen.y + 5, pointerId: 31 });
    assert.equal(appMod.cad2D._drag?.pointerId, 30);
    // Cancel active drag via pointercancel -> restores pattern, cad2D, viewport3D, and history cleanly
    canvas2dEl.dispatchEvent({ type: 'pointercancel', pointerId: 30 });
    assert.equal(appMod.cad2D._drag, null);
    assert.equal(JSON.stringify(st.pattern), preCancelSnap, 'BUG-I18-UI-03: pointercancel must roll back state.pattern');
    assert.equal(JSON.stringify(appMod.cad2D._lastScene.pattern), preCancelSnap, 'BUG-I18-UI-03: cad2D scene restored');
    assert.equal(appMod.viewport3D.scene.sim, preCancelSim, 'BUG-I18-UI-03: viewport3D sim stays pre-drag');
    assert.equal(elements.get('btnUndo').disabled, preUndoDisabled);
    assert.equal(elements.get('btnRedo').disabled, preRedoDisabled);

    // 4c) BUG-I18-UI-06: #stlFileInput resets e.target.value = '' even on corrupt STL
    const stlInp = elements.get('stlFileInput');
    stlInp.value = 'C:\\fakepath\\corrupt.stl';
    stlInp.files = [{ name: 'corrupt.stl', arrayBuffer: async () => new ArrayBuffer(0) }];
    toast.textContent = '';
    toast.classList.remove('toast-error');
    stlInp.dispatchEvent({ type: 'change' });
    assert.equal(stlInp.value, '', 'BUG-I18-UI-06: #stlFileInput must reset value = "" immediately on change');
    await waitUntil(() => toast.textContent.includes('Invalid STL file'));
    assert.ok(toast.classList.contains('toast-error'));

    // 4d) Reviewer I17 material rollback: if sync3DScene throws AFTER sim.updateMaterial, sim material & alphas also roll back
    const origViewportSetScene = appMod.viewport3D.setScene.bind(appMod.viewport3D);
    const preMatCfgJson = JSON.stringify(st.sim.material);
    const prePatMatJson = JSON.stringify(st.pattern.material);
    const preAlpha0 = st.sim.structuralConstraints[0].alpha;
    appMod.viewport3D.setScene = () => { throw new Error('Mock sync3DScene throw'); };
    for (const [elId, evType, val] of [
      ['matSlider_roughness', 'input', '0.95'],
      ['matWeaveTypeSelect', 'change', 'plain_weave'],
      ['matWarpColor', 'input', '#123456'],
    ]) {
      const ctrl = elements.get(elId);
      if (!ctrl) continue;
      toast.textContent = '';
      toast.classList.remove('toast-error');
      ctrl.value = val;
      assert.doesNotThrow(() => ctrl.dispatchEvent({ type: evType }));
      assert.ok(toast.classList.contains('toast-error'));
      assert.equal(JSON.stringify(st.pattern.material), prePatMatJson);
      assert.equal(JSON.stringify(st.sim.material), preMatCfgJson, `sim.material must roll back on ${elId} error`);
      assert.equal(st.sim.structuralConstraints[0].alpha, preAlpha0, `sim constraint alpha must roll back on ${elId} error`);
    }
    appMod.viewport3D.setScene = origViewportSetScene;
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i19_core_fixes: CORE-BUG-I19-01..03 and CORE-GAP-I19-01', () => {
  const mkBasePiece = (id = 'p1', extra = {}) => ({
    id,
    name: id,
    points: [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 120 },
      { x: 0, y: 120 },
    ],
    edges: [{}, {}, {}, {}],
    seamAllowance: 10,
    ...extra,
  });

  // 1. CORE-BUG-I19-01 & CORE-BUG-I19-02: nesting & exporters must reject ALL invalid piece subfields under unit:'mm' and omitted unit
  const invalidMmPieceCases = [
    ['negative-sa', { seamAllowance: -1 }],
    ['nan-sa', { seamAllowance: Number.NaN }],
    ['non-array-edges', { edges: 'bad' }],
    ['wrong-edges-length', { edges: [{}, {}] }],
    ['sparse-edges-hole', { edges: new Array(4) }],
    ['non-object-edge-elem', { edges: ['bad', {}, {}, {}] }],
    ['negative-edge-sa', { edges: [{ seamAllowance: -2 }, {}, {}, {}] }],
    ['bad-edge-curve', { edges: [{ curve: { type: 'bogus' } }, {}, {}, {}] }],
    ['nan-curve-cp', { edges: [{ curve: { type: 'quadratic', cp: { x: Number.NaN, y: 0 } } }, {}, {}, {}] }],
    ['non-object-grainline', { grainline: 'invalid' }],
    ['nan-grainline-angle', { grainline: { angleDeg: Number.NaN } }],
    ['bad-grainline-coords', { grainline: { start: { x: 0, y: 0 }, end: { x: Number.NaN, y: 10 } } }],
    ['non-array-notches', { notches: 'bad' }],
    ['oob-notch-edgeIndex', { notches: [{ edgeIndex: 99, t: 0.5 }] }],
    ['non-array-darts', { darts: 123 }],
    ['invalid-dart-t', { darts: [{ edgeIndex: 0, t: -0.5, widthMm: 20, depthMm: 80 }] }],
    ['nan-position', { position: { x: Number.NaN, y: 0 } }],
    ['inf-rotation', { rotation: Number.POSITIVE_INFINITY }],
    ['nan-rotationOrigin', { rotationOrigin: { x: 10, y: Number.NaN } }],
    ['bad-internalLines', { internalLines: [{ type: 'fold', points: 'bad' }] }],
    ['nan-placement3D', { placement3D: { offset: { x: Number.NaN, y: 0, z: 0 } } }],
  ];

  for (const unitOpt of ['mm', undefined]) {
    const unitTag = unitOpt === undefined ? 'omitted-unit' : 'unit:mm';
    for (const [label, patch] of invalidMmPieceCases) {
      const badPat = { ...(unitOpt !== undefined ? { unit: unitOpt } : {}), pieces: [mkBasePiece('bad', patch)] };
      assert.throws(
        () => core.nestPatternPieces(badPat),
        core.ValidationError,
        `CORE-BUG-I19-01 (${unitTag}): nestPatternPieces must reject ${label}`
      );
      for (const [expName, expFn] of [
        ['exportSVG', core.exportSVG],
        ['exportDXF', core.exportDXF],
        ['exportTiledPDF', core.exportTiledPDF],
      ]) {
        assert.throws(
          () => expFn(badPat),
          core.ValidationError,
          `CORE-BUG-I19-02 (${unitTag}): ${expName} must reject ${label}`
        );
      }
    }
  }

  // Verify sparse holes in pattern.pieces itself throw cleanly too
  const sparsePiecesArr = new Array(1);
  assert.throws(() => core.nestPatternPieces({ unit: 'mm', pieces: sparsePiecesArr }), core.ValidationError);
  assert.throws(() => core.exportSVG({ unit: 'mm', pieces: sparsePiecesArr }), core.ValidationError);

  // Preserve <3 points INVALID_PIECE error code in exporters, allowEmpty: true, Symbol tolerances, dense null edges (M4 Test 15), and exportPatternJSON
  assert.throws(
    () => core.exportSVG({ unit: 'mm', pieces: [{ id: 'tiny', name: 'Tiny', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] }),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_PIECE'
  );
  assert.equal(core.nestPatternPieces({ unit: 'mm', pieces: [] }).sheets.length, 0);
  assert.ok(core.exportSVG({ unit: 'mm', pieces: [] }).includes('<svg'));

  const symCompatPat = {
    unit: 'mm',
    pieces: [
      {
        id: Symbol('sym_id'),
        name: Symbol('sym_name'),
        quantity: Symbol('sym_qty'),
        points: mkBasePiece().points,
        edges: [{}, null, {}, undefined],
      },
      {
        id: '   ',
        name: 'Dup1',
        quantity: 1,
        points: mkBasePiece().points,
        edges: [{}, {}, {}, {}],
      },
      {
        id: 'dup',
        name: 'Dup2',
        points: mkBasePiece().points,
      },
      {
        id: 'dup',
        name: 'Dup3',
        points: mkBasePiece().points,
      },
    ],
  };
  const nestSym = core.nestPatternPieces(symCompatPat);
  assert.equal(nestSym.placements.length, 4);
  assert.ok(core.exportSVG(symCompatPat).includes('<svg'));
  assert.ok(core.exportDXF(symCompatPat).includes('SECTION'));
  assert.ok(core.exportTiledPDF(symCompatPat).pdfBytes.byteLength > 100);
  assert.doesNotThrow(() => core.exportPatternJSON({ unit: 'mm', pieces: [mkBasePiece('ok', { seamAllowance: -1 })] }));

  // 2. CORE-BUG-I19-03: scale-invariant U-slot self-intersection & offset bowtie clipping across 1e3..1e12
  const mkUSlot = (span, slotW) => {
    const cx = span * 0.5;
    const hw = slotW * 0.5;
    return [
      { x: 0, y: 0 },
      { x: span, y: 0 },
      { x: span, y: 100 },
      { x: cx + hw, y: 100 },
      { x: cx + hw, y: 40 },
      { x: cx - hw, y: 40 },
      { x: cx - hw, y: 100 },
      { x: 0, y: 100 },
    ];
  };
  for (const span of [1e3, 1e6, 2e7, 5e8, 1e9, 1e10, 1e12]) {
    const u10 = mkUSlot(span, 10);
    assert.equal(core.polygonSelfIntersects(u10), false, `CORE-BUG-I19-03: u10 must not false-positive self-intersect at span=${span}`);

    const u20 = mkUSlot(span, 20);
    const out20 = core.offsetPolygonOutward(u20, 15);
    assert.equal(out20.length, 6, `CORE-BUG-I19-03: u20 outward(15) must clip bowtie to 6 vertices at span=${span}, got ${out20.length}`);
    assert.equal(core.polygonSelfIntersects(out20), false, `CORE-BUG-I19-03: u20 offset must not self-intersect at span=${span}`);
    assert.ok(core.polygonArea(out20) > span * 100, `CORE-BUG-I19-03: expected positive expanded area at span=${span}`);
  }
  assert.equal(
    core.segmentIntersection2D({ x: 0, y: 100 }, { x: 5e11 - 5, y: 100 }, { x: 5e11 + 5, y: 100 }, { x: 5e11 + 5, y: 40 }),
    null,
    'CORE-BUG-I19-03: 10mm physical gap at x=5e11 must not false-positive'
  );
  assert.equal(
    core.segmentIntersection2D({ x: 0, y: 100 }, { x: 5e11 - 25, y: 100 }, { x: 5e11 + 25, y: 100 }, { x: 1e12, y: 100 }),
    null,
    'CORE-BUG-I19-03: 50mm collinear gap at x=5e11 must not false-positive'
  );

  // 3. CORE-GAP-I19-01: isValidSeamTRange rejects null tStartA/tEndA/tStartB/tEndB matching types.mjs validateSeam
  const pA = mkBasePiece('sa');
  const pB = mkBasePiece('sb');
  for (const field of ['tStartA', 'tEndA', 'tStartB', 'tEndB']) {
    const pat = {
      unit: 'mm',
      pieces: [pA, pB],
      seams: [{ id: `s_${field}`, pieceA: 'sa', edgeA: 0, pieceB: 'sb', edgeB: 0, [field]: null }],
    };
    const [rep] = core.validatePatternSeams(pat);
    assert.equal(rep.valid, false, `CORE-GAP-I19-01: ${field}=null must yield valid:false`);
    assert.equal(rep.status, 'invalid_seam', `CORE-GAP-I19-01: ${field}=null must yield status:invalid_seam`);
    assert.equal(core.validatePatternProject(pat, { throwOnError: false }).valid, false);
  }
  const okUndefPat = {
    unit: 'mm',
    pieces: [pA, pB],
    seams: [{ id: 's_undef', pieceA: 'sa', edgeA: 0, pieceB: 'sb', edgeB: 0, tStartA: undefined, tEndB: undefined }],
  };
  assert.equal(core.validatePatternSeams(okUndefPat)[0].valid, true);
});

test('adv_i19_ui_drag_and_context_restore: BUG-I19-UI-01..03', async () => {
  // 1. BUG-I19-UI-01: WebGL3DViewport failed webglcontextrestored cleans up partial GL resources & enters 2D fallback (or keeps _contextLost=true)
  {
    const baseGl = createStrictMockWebGL2Context();
    let contextLostFlag = false;
    let createProgCalls = 0;
    let failOnCreateProgCall = Infinity;
    let useNullProgCalls = 0;
    const mockGl = {
      ...baseGl,
      isContextLost: () => contextLostFlag,
      createProgram() {
        createProgCalls += 1;
        if (createProgCalls >= failOnCreateProgCall) return null;
        return baseGl.createProgram();
      },
      useProgram(p) {
        if (!p) useNullProgCalls += 1;
        return baseGl.useProgram(p);
      },
    };
    const c3Listeners = new Map();
    const mkParent = () => {
      const children = [];
      return {
        children,
        appendChild(ch) { children.push(ch); ch.parentNode = this; ch.parentElement = this; return ch; },
        replaceChild(newEl, oldEl) {
          const idx = children.indexOf(oldEl);
          if (idx >= 0) children[idx] = newEl;
          newEl.parentNode = this;
          newEl.parentElement = this;
        },
      };
    };
    const parentEl = mkParent();
    let allow2DOnPrimary = true;
    const c3 = {
      id: 'canvas3d_i19',
      width: 640,
      height: 480,
      getContext(type) {
        if (type === 'webgl2') return mockGl;
        if (type === '2d' && allow2DOnPrimary) return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
      addEventListener(type, fn, opts) {
        if (!c3Listeners.has(type)) c3Listeners.set(type, []);
        c3Listeners.get(type).push({ fn, opts });
      },
      removeEventListener(type, fn) {
        const arr = c3Listeners.get(type) || [];
        c3Listeners.set(type, arr.filter((e) => e.fn !== fn));
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    parentEl.appendChild(c3);
    const emitC3 = (type, ev = {}) => {
      for (const entry of c3Listeners.get(type) || []) entry.fn(ev);
    };

    const tshirt = core.generateTemplatePattern('tshirt');
    const avatar = core.createParametricAvatar();
    const sim = new core.ClothSimulation(tshirt, { avatar, maxEdgeLengthMm: 60 });
    const vp3 = createViewport3D(c3);
    assert.equal(vp3.mode, 'webgl2');
    vp3.setScene({ sim, avatar, materialConfig: core.getMaterialConfig('cotton_jersey'), showForm: true });
    vp3.render();

    // 1a) webglcontextrestored while context STILL reports lost -> _contextLost stays true
    contextLostFlag = true;
    emitC3('webglcontextlost', { preventDefault() {} });
    assert.equal(vp3._contextLost, true);
    emitC3('webglcontextrestored', {});
    assert.equal(vp3._contextLost, true, 'BUG-I19-UI-01: _contextLost must remain true if gl.isContextLost() is still true');

    // 1b) webglcontextrestored where 2nd createProgram returns null mid-_initGL() -> partial GL disposed, enters 2D fallback cleanly
    const progsBeforeFailedRestore = baseGl._state.programs.size;
    contextLostFlag = false;
    createProgCalls = 0;
    failOnCreateProgCall = 2; // grid program succeeds, wire program returns null -> throws partway through _initGL()
    emitC3('webglcontextrestored', {});
    assert.equal(vp3.gl, null, 'BUG-I19-UI-01: gl must be cleared after failed restore');
    assert.equal(baseGl._state.programs.size, progsBeforeFailedRestore, 'BUG-I19-UI-01: partial GL programs created during failed restore must be disposed');
    assert.equal(vp3.mode, '2d', 'BUG-I19-UI-01: must fall back cleanly to 2d mode');
    assert.equal(vp3._contextLost, false, 'BUG-I19-UI-01: 2D fallback clears _contextLost');
    useNullProgCalls = 0;
    const stats = vp3.render();
    assert.equal(stats.mode, '2d');
    assert.ok(stats.renderedClothTriangles > 0 || stats.renderedAvatarTriangles > 0, 'BUG-I19-UI-01: 2D fallback renders triangles');
    assert.equal(useNullProgCalls, 0, 'BUG-I19-UI-01: zero GL draw calls with null programs');
    vp3.dispose();
  }

  // 2. BUG-I19-UI-02 standalone CAD2DViewport OOB & cancelActiveDrag guards
  {
    const c2Listeners = new Map();
    const ctx2d = createMock2DContext();
    const c2 = {
      width: 640,
      height: 480,
      getContext: (t) => (t === '2d' ? ctx2d : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!c2Listeners.has(type)) c2Listeners.set(type, []);
        c2Listeners.get(type).push(fn);
      },
      removeEventListener() {},
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const emitC2 = (type, ev = {}) => {
      for (const fn of c2Listeners.get(type) || []) fn(ev);
    };
    let cancelHits = 0;
    const rect = core.createRectanglePiece('R', 100, 100, { id: 'r1', position: { x: 20, y: 20 } });
    const pat = core.createPatternProject({ pieces: [rect] });
    const cad = new CAD2DViewport(c2, { onCancelMutate: () => { cancelHits += 1; } });
    const scene = { pattern: pat, unit: 'mm', viewMode: 'split', activeTool: 'select', selectedPieceId: 'r1', selectedVertexIndex: 3, selectedEdgeIndex: 0 };
    cad.fitToContent(scene);
    cad.render(scene);

    const wV3 = cad.pieceLocalToWorld(rect, rect.points[3]);
    const sV3 = cad.worldToScreen(wV3.x, wV3.y);
    emitC2('pointerdown', { button: 0, clientX: sV3.x, clientY: sV3.y, pointerId: 1 });
    assert.equal(cad._drag?.mode, 'vertex');
    assert.equal(cad._drag?.vertexIndex, 3);
    // Simulate external deletion of vertex 3 leaving 3 points & 3 edges on the rendered scene
    const scenePiece = cad._lastScene.pattern.pieces[0];
    scenePiece.points.pop();
    scenePiece.edges.pop();
    emitC2('pointermove', { clientX: sV3.x + 20, clientY: sV3.y + 20, pointerId: 1 });
    assert.equal(cad._drag, null, 'BUG-I19-UI-02: OOB vertexIndex on pointermove must cancel active drag');
    assert.equal(scenePiece.points.length, 3, 'BUG-I19-UI-02: pointermove must NEVER extend points past edges.length');
    assert.equal(scenePiece.edges.length, 3);
    assert.equal(cancelHits, 1);

    // Explicit cancelActiveDrag restores piece position cleanly
    const origPos = { ...scenePiece.position };
    const wBody = cad.pieceLocalToWorld(scenePiece, { x: 30, y: 30 });
    const sBody = cad.worldToScreen(wBody.x, wBody.y);
    emitC2('pointerdown', { button: 0, clientX: sBody.x, clientY: sBody.y, pointerId: 2 });
    emitC2('pointermove', { clientX: sBody.x + 40, clientY: sBody.y + 15, pointerId: 2 });
    assert.notEqual(scenePiece.position.x, origPos.x);
    assert.equal(cad.cancelActiveDrag(), 'piece');
    assert.equal(cad._drag, null);
    assert.deepEqual(scenePiece.position, origPos);
    assert.equal(cancelHits, 2);
  }

  // 3. Integrated app.mjs: BUG-I19-UI-02 (mid-drag Delete, Ctrl+Z, loadTemplate) & BUG-I19-UI-03 (penPoints across project changes)
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const htmlText = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(htmlText.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const elements = new Map();
  const windowListeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return Boolean(force);
      },
      contains: (c) => set.has(c),
    };
  };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const attrs = new Map();
    let _id = id;
    const elObj = {
      get id() { return _id; },
      set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
      tagName: tag.toUpperCase(),
      type: '',
      className: '',
      value: '',
      min: '',
      max: '',
      step: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      style: {},
      children,
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentNode: null,
      parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners.has(type)) return;
        listeners.set(type, listeners.get(type).filter((f) => f !== fn));
      },
      dispatchEvent(ev) {
        const event = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(event.type) || []) fn(event);
      },
      appendChild(ch) { children.push(ch); ch.parentElement = elObj; ch.parentNode = elObj; return ch; },
      replaceChildren(...chs) { children.length = 0; chs.forEach((c) => elObj.appendChild(c)); },
      querySelectorAll: () => [],
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'min' || k === 'max' || k === 'step') elObj[k] = String(v); },
      getAttribute(k) { return attrs.get(k) || ''; },
      getContext(type) {
        if (elObj.tagName !== 'CANVAS') return null;
        if (type === 'webgl2') return createStrictMockWebGL2Context();
        if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
        return null;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return elObj;
  };
  for (const id of htmlIds) {
    const node = makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id);
    if (id === 'canvas2D' || id === 'canvas3D') {
      const wrap = makeEl('div', '');
      wrap.appendChild(node);
    }
    elements.set(id, node);
  }
  elements.get('unitSelect').value = 'mm';

  const selectBtn = makeEl('button', '');
  selectBtn.dataset.tool = 'select';
  const drawPolyBtn = makeEl('button', '');
  drawPolyBtn.dataset.tool = 'draw_poly';
  const splitViewBtn = makeEl('button', '');
  splitViewBtn.dataset.view = 'split';
  const nestingViewBtn = makeEl('button', '');
  nestingViewBtn.dataset.view = 'nesting';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const nativeFetch = prevGlobals.fetch;

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of windowListeners.get(ev.type) || []) fn(ev);
      },
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeEl(tag, ''),
      querySelectorAll: (sel) => {
        if (sel === '.tool-btn[data-tool]') return [selectBtn, drawPolyBtn];
        if (sel === '#viewModeGroup .seg-btn') return [splitViewBtn, nestingViewBtn];
        return [];
      },
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init) => {
      const sUrl = String(url);
      return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
    };

    const appMod = await import(`../public/app.mjs?i19=${Date.now()}`);
    const waitUntil = async (pred, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    await waitUntil(() => appMod.state?.pattern);
    const st = appMod.state;
    const canvas2dEl = elements.get('canvas2D');

    // Variant A: Mid-vertex-drag Delete cancels drag & preserves points.length === edges.length
    const p0 = st.pattern.pieces[0];
    assert.ok(p0.points.length >= 5, 'Expected tshirt piece 0 to have >= 5 vertices');
    const origLen = p0.points.length;
    const lastIdx = origLen - 1;
    const wLast = appMod.cad2D.pieceLocalToWorld(p0, p0.points[lastIdx]);
    const sLast = appMod.cad2D.worldToScreen(wLast.x, wLast.y);
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: sLast.x, clientY: sLast.y, button: 0, pointerId: 40 });
    assert.equal(appMod.cad2D._drag?.mode, 'vertex');
    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: sLast.x + 25, clientY: sLast.y + 15, pointerId: 40 });
    globalThis.window.dispatchEvent({ type: 'keydown', key: 'Delete', preventDefault() {} });
    assert.equal(appMod.cad2D._drag, null, 'BUG-I19-UI-02: Delete mid-drag must clear _drag');
    const p0After = st.pattern.pieces[0];
    assert.equal(p0After.points.length, origLen - 1);
    assert.equal(p0After.edges.length, origLen - 1);
    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: sLast.x + 50, clientY: sLast.y + 50, pointerId: 40 });
    canvas2dEl.dispatchEvent({ type: 'pointerup', clientX: sLast.x + 50, clientY: sLast.y + 50, pointerId: 40 });
    const p0PostPointer = st.pattern.pieces[0];
    assert.equal(p0PostPointer.points.length, origLen - 1);
    assert.equal(p0PostPointer.edges.length, origLen - 1);
    assert.equal(core.validatePatternProject(st.pattern, { throwOnError: false }).valid, true);

    // Variant B: Mid-piece-drag Ctrl+Z cancels drag cleanly, restores pre-drag pos, keeps redo disabled, and allows 2nd Ctrl+Z to undo prior edit
    await appMod.loadTemplate('tshirt');
    const beforeDupCount = st.pattern.pieces.length;
    elements.get('btnDuplicatePiece').dispatchEvent({ type: 'click' });
    assert.equal(st.pattern.pieces.length, beforeDupCount + 1);
    assert.equal(elements.get('btnUndo').disabled, false);

    const dupPiece = st.pattern.pieces.find((p) => p.id === st.selectedPieceId);
    const origPos = { ...dupPiece.position };
    const b = core.polygonBounds(dupPiece.points);
    const wInterior = appMod.cad2D.pieceLocalToWorld(dupPiece, { x: (b.minX + b.maxX) * 0.5, y: (b.minY + b.maxY) * 0.5 });
    const sInterior = appMod.cad2D.worldToScreen(wInterior.x, wInterior.y);
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: sInterior.x, clientY: sInterior.y, button: 0, pointerId: 41 });
    assert.equal(appMod.cad2D._drag?.mode, 'piece');
    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: sInterior.x + 60, clientY: sInterior.y + 40, pointerId: 41 });
    assert.notEqual(dupPiece.position.x, origPos.x);

    globalThis.window.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, shiftKey: false, preventDefault() {} });
    assert.equal(appMod.cad2D._drag, null, 'BUG-I19-UI-02: Ctrl+Z mid-drag must clear _drag');
    const afterUndo1 = st.pattern.pieces.find((p) => p.id === st.selectedPieceId);
    assert.equal(st.pattern.pieces.length, beforeDupCount + 1, 'BUG-I19-UI-02: 1st Ctrl+Z cancels active drag without dropping earlier piece');
    assert.deepEqual(afterUndo1.position, origPos, 'BUG-I19-UI-02: pre-drag position restored');
    assert.equal(elements.get('btnRedo').disabled, true, 'BUG-I19-UI-02: no phantom mid-drag state in redoStack');
    assert.equal(elements.get('btnUndo').disabled, false);

    canvas2dEl.dispatchEvent({ type: 'pointermove', clientX: sInterior.x + 90, clientY: sInterior.y + 90, pointerId: 41 });
    canvas2dEl.dispatchEvent({ type: 'pointerup', clientX: sInterior.x + 90, clientY: sInterior.y + 90, pointerId: 41 });
    assert.deepEqual(st.pattern.pieces.find((p) => p.id === st.selectedPieceId).position, origPos);
    assert.equal(elements.get('btnRedo').disabled, true);

    globalThis.window.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, shiftKey: false, preventDefault() {} });
    assert.equal(st.pattern.pieces.length, beforeDupCount, '2nd Ctrl+Z cleanly undoes prior btnDuplicatePiece');

    // Mid-drag loadTemplate clears _drag cleanly
    const t0 = st.pattern.pieces[0];
    const wt0 = appMod.cad2D.pieceLocalToWorld(t0, t0.points[0]);
    const st0 = appMod.cad2D.worldToScreen(wt0.x, wt0.y);
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: st0.x, clientY: st0.y, button: 0, pointerId: 42 });
    assert.equal(appMod.cad2D._drag?.mode, 'vertex');
    await appMod.loadTemplate('tote_bag');
    assert.equal(appMod.cad2D._drag, null, 'BUG-I19-UI-02: loadTemplate clears active _drag');
    assert.equal(st.templateId, 'tote_bag');

    // BUG-I19-UI-03: draw_poly penPoints cleared across loadTemplate, #jsonFileInput, loadWorkspaceSTLFile, and nesting view
    drawPolyBtn.dispatchEvent({ type: 'click' });
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 200, button: 0, pointerId: 50 });
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 260, clientY: 200, button: 0, pointerId: 50 });
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 230, clientY: 260, button: 0, pointerId: 50 });
    assert.equal(appMod.cad2D.penPoints.length, 3);

    await appMod.loadTemplate('tshirt');
    assert.equal(appMod.cad2D.penPoints.length, 0, 'BUG-I19-UI-03: loadTemplate clears penPoints');
    const tshirtCountBeforeClick = st.pattern.pieces.length;
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 200, button: 0, pointerId: 51 });
    assert.equal(st.pattern.pieces.length, tshirtCountBeforeClick, 'BUG-I19-UI-03: no ghost Freeform piece created');
    appMod.cad2D.clearPen();

    // JSON import clears penPoints
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 210, clientY: 210, button: 0, pointerId: 52 });
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 250, clientY: 210, button: 0, pointerId: 52 });
    assert.equal(appMod.cad2D.penPoints.length, 2);
    const toteJson = core.exportPatternJSON(core.generateTemplatePattern('tote_bag'));
    const jsonInp = elements.get('jsonFileInput');
    jsonInp.files = [{ name: 'tote.json', text: async () => toteJson }];
    jsonInp.dispatchEvent({ type: 'change' });
    await waitUntil(() => st.templateId === 'tote_bag');
    assert.equal(appMod.cad2D.penPoints.length, 0, 'BUG-I19-UI-03: #jsonFileInput clears penPoints');

    // STL unwrap clears penPoints
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 200, button: 0, pointerId: 53 });
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 240, clientY: 200, button: 0, pointerId: 53 });
    assert.equal(appMod.cad2D.penPoints.length, 2);
    await appMod.loadWorkspaceSTLFile('cutting_mat_wedge_assembled_view.stl');
    assert.equal(st.templateId, 'stl_cover');
    assert.equal(appMod.cad2D.penPoints.length, 0, 'BUG-I19-UI-03: loadWorkspaceSTLFile clears penPoints');

    // Switching to nesting view clears penPoints
    canvas2dEl.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 200, button: 0, pointerId: 54 });
    assert.equal(appMod.cad2D.penPoints.length, 1);
    nestingViewBtn.dispatchEvent({ type: 'click' });
    assert.equal(appMod.cad2D.penPoints.length, 0, 'BUG-I19-UI-03: setViewMode("nesting") clears penPoints');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
    await closeStudioServer(srv);
  }
});

test('adv_i20_core_fixes: CORE-BUG-I20-01 mirrorPieceAcrossEdge outside-[a,b] collinearity & CORE-BUG-I20-02 surface_panels sub-seam precision', () => {
  // 1. CORE-BUG-I20-01: mirrorPieceAcrossEdge rejects polygons with interior vertices collinear with the mirror axis outside [a, b]
  const transformPts = (pts, angleDeg, tx, ty) => {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return pts.map((p) => ({
      x: tx + p.x * c - p.y * s,
      y: ty + p.x * s + p.y * c,
    }));
  };

  const afterBBase = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0 }, { x: 50, y: 100 }];
  const beforeABase = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }, { x: -50, y: 0 }];
  const midOutsideBase = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 60 }, { x: 140, y: 0 }, { x: 20, y: 90 }];

  const invalidMirrorCases = [
    ['AfterB', afterBBase, false],
    ['BeforeA', beforeABase, false],
    ['MidOutside', midOutsideBase, false],
    ['AfterB_CW', [...afterBBase].reverse(), true],
    ['BeforeA_CW', [...beforeABase].reverse(), true],
    ['AfterB_tilted_37', transformPts(afterBBase, 37, 412.5, -289.25), false],
    ['BeforeA_tilted_m125', transformPts(beforeABase, -125, -1500.75, 2200.5), false],
    ['MidOutside_tilted_23', transformPts(midOutsideBase, 23, 1000, 2000), false],
  ];

  const mate = core.createRectanglePiece('Mate', 100, 40, { id: 'i20_mate' });
  for (const [label, pts, rawCw] of invalidMirrorCases) {
    const edgeIdx = rawCw ? 2 : 0;
    const piece = rawCw
      ? {
          id: `i20_${label}`,
          name: label,
          points: pts,
          edges: pts.map(() => ({ seamAllowance: 10 })),
          seamAllowance: 10,
          notches: [{ id: 'n1', edgeIndex: 1, t: 0.5, type: 'single' }],
          darts: [],
          internalLines: [],
          grainline: { angleDeg: 90 },
          position: { x: 10, y: 20 },
          rotation: 0,
        }
      : core.createFreeformPiece(label, pts, { id: `i20_${label}` });
    const seamTargetEdge = (edgeIdx + 1) % pts.length;
    const pat = {
      unit: 'mm',
      pieces: [piece, mate],
      seams: [{ id: `seam_${label}`, pieceA: piece.id, edgeA: seamTargetEdge, pieceB: mate.id, edgeB: 0 }],
    };
    const pieceSnap = JSON.stringify(piece);
    const seamsSnap = JSON.stringify(pat.seams);

    assert.throws(
      () => core.mirrorPieceAcrossEdge(piece, edgeIdx, pat),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR',
      `CORE-BUG-I20-01: ${label} must throw ValidationError(SELF_INTERSECTING_MIRROR)`
    );
    assert.equal(JSON.stringify(piece), pieceSnap, `CORE-BUG-I20-01: ${label} failure must not mutate piece`);
    assert.equal(JSON.stringify(pat.seams), seamsSnap, `CORE-BUG-I20-01: ${label} failure must not mutate pattern.seams`);
  }

  // Valid negative controls: shared a/b endpoints & curved non-self-intersecting unfolds
  const rightTri = core.createFreeformPiece('ValidRightTri', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }], {
    id: 'i20_tri',
  });
  const triAreaBefore = core.polygonArea(rightTri.points);
  const mirroredTri = core.mirrorPieceAcrossEdge(rightTri, 1);
  assert.equal(core.polygonSelfIntersects(mirroredTri.points), false);
  assertNear(core.polygonArea(mirroredTri.points), triAreaBefore * 2, 1e-6);

  const tiltedTrapPts = transformPts([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 90, y: 80 }, { x: 0, y: 80 }], 29, 250, -120);
  const tiltedTrap = core.createFreeformPiece('ValidTiltedTrap', tiltedTrapPts, { id: 'i20_trap' });
  const trapAreaBefore = core.polygonArea(tiltedTrap.points);
  const mirroredTrap = core.mirrorPieceAcrossEdge(tiltedTrap, 3);
  assert.equal(core.polygonSelfIntersects(mirroredTrap.points), false);
  assertNear(core.polygonArea(mirroredTrap.points), trapAreaBefore * 2, 1e-4);

  const curvedHalf = core.createFreeformPiece(
    'ValidCurvedHalf',
    [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 90, y: 50 }, { x: 70, y: 120 }, { x: 0, y: 120 }],
    {
      id: 'i20_curved',
      edges: [
        { seamAllowance: 10 },
        { seamAllowance: 10, curve: { type: 'quadratic', cp: { x: 95, y: 25 } } },
        { seamAllowance: 10, curve: { type: 'cubic', cp1: { x: 85, y: 70 }, cp2: { x: 80, y: 100 } } },
        { seamAllowance: 10 },
        { seamAllowance: 10 },
      ],
    }
  );
  const mirroredCurved = core.mirrorPieceAcrossEdge(curvedHalf, 4);
  assert.equal(core.polygonSelfIntersects(mirroredCurved.points), false);
  assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(mirroredCurved, 16)), false);
  assert.equal(core.validatePatternProject(core.createPatternProject({ pieces: [mirroredTri, mirroredTrap, mirroredCurved] })).valid, true);

  // 2. CORE-BUG-I20-02: surface_panels sub-seam precision & ultra-degenerate sub-seam filtering
  const buildSliverPrism = (x1, x2, x3, name) => {
    const tris = [];
    const p = (x, y, z) => ({ x, y, z });
    const q = (a, b, c, d) => {
      tris.push({ a, b, c });
      tris.push({ a, b: c, c: d });
    };
    const x0 = 0;
    const yB = 100;
    const zT = 100;
    const zBL = -50;
    q(p(x0, 0, 0), p(x1, 0, 0), p(x1, 0, zT), p(x0, 0, zT));
    q(p(x1, 0, 0), p(x2, 0, 0), p(x2, 0, zT), p(x1, 0, zT));
    q(p(x2, 0, 0), p(x3, 0, 0), p(x3, 0, zT), p(x2, 0, zT));
    q(p(x1, yB, zBL), p(x0, yB, zBL), p(x0, yB, zT), p(x1, yB, zT));
    q(p(x2, yB, 0), p(x1, yB, zBL), p(x1, yB, zT), p(x2, yB, zT));
    q(p(x3, yB, 0), p(x2, yB, 0), p(x2, yB, zT), p(x3, yB, zT));
    q(p(x0, 0, zT), p(x3, 0, zT), p(x3, yB, zT), p(x0, yB, zT));
    q(p(x0, yB, zBL), p(x0, 0, 0), p(x0, 0, zT), p(x0, yB, zT));
    q(p(x3, 0, 0), p(x3, yB, 0), p(x3, yB, zT), p(x3, 0, zT));
    q(p(x0, yB, zBL), p(x1, yB, zBL), p(x1, 0, 0), p(x0, 0, 0));
    q(p(x1, yB, zBL), p(x2, yB, 0), p(x2, 0, 0), p(x1, 0, 0));
    q(p(x2, yB, 0), p(x3, yB, 0), p(x3, 0, 0), p(x2, 0, 0));
    const mesh = core.parseSTL(core.serializeTrianglesToSTL(tris, name), `${name}.stl`);
    return core.unwrapSTLToPattern(mesh, { mode: 'surface_panels', dihedralThresholdDeg: 10 });
  };

  // REPRO-02: 0.001mm sub-edge on 5000mm/2500mm prism (~4e-7 ratio < 5e-7)
  const pat5k = buildSliverPrism(2500, 2500.001, 5000, 'i20_sliver_5k');
  assert.equal(core.validatePatternProject(pat5k, { throwOnError: true }).valid, true);
  const reps5k = core.validatePatternSeams(pat5k);
  assert.equal(reps5k.length, 16, 'REPRO-02: all 16 panel sub-seams preserved at 1e-12 precision');
  assert.ok(reps5k.every((r) => r.valid), `REPRO-02 seams invalid: ${JSON.stringify(reps5k.filter((r) => !r.valid))}`);
  const minSpan5k = Math.min(...pat5k.seams.map((s) => s.tEndA - s.tStartA));
  assert.ok(minSpan5k > 1e-12 && minSpan5k < 5e-7, `Expected <5e-7 sub-seam preserved, got minSpan=${minSpan5k}`);

  // JSON roundtrip keeps sub-5e-7 seam ranges strictly valid
  const round5k = core.importPatternJSON(core.exportPatternJSON(pat5k));
  assert.equal(core.validatePatternProject(round5k, { throwOnError: true }).valid, true);
  assert.ok(core.validatePatternSeams(round5k).every((r) => r.valid));

  // Tighter 1e6 mm prism (~4e-9 ratio)
  const pat1m = buildSliverPrism(500000, 500000.002, 1000000, 'i20_sliver_1m');
  assert.equal(core.validatePatternProject(pat1m, { throwOnError: true }).valid, true);
  const reps1m = core.validatePatternSeams(pat1m);
  assert.equal(reps1m.length, 16);
  assert.ok(reps1m.every((r) => r.valid));
  const minSpan1m = Math.min(...pat1m.seams.map((s) => s.tEndA - s.tStartA));
  assert.ok(minSpan1m > 1e-12 && minSpan1m < 1e-8, `Expected ~4e-9 sub-seam preserved, got minSpan=${minSpan1m}`);

  // Extreme 1e10 mm prism (~4e-13 ratio <= 1e-12) cleanly omits ultra-degenerate sub-seam while preserving valid wiring
  const pat10b = buildSliverPrism(5e9, 5e9 + 0.002, 1e10, 'i20_sliver_10b');
  assert.equal(core.validatePatternProject(pat10b, { throwOnError: true }).valid, true);
  const reps10b = core.validatePatternSeams(pat10b);
  assert.ok(reps10b.length >= 15 && reps10b.every((r) => r.valid));

  for (const [label, pat] of [['5k', pat5k], ['1m', pat1m], ['10b', pat10b]]) {
    pat.seams.forEach((s, idx) => {
      assert.equal(s.id, `seam_panel_${idx + 1}`, `${label}: contiguous seam_panel_* IDs`);
      assert.ok(s.tStartA >= 0 && s.tStartA < s.tEndA && s.tEndA <= 1, `${label}: invalid A range on ${s.id}`);
      assert.ok(s.tStartB >= 0 && s.tStartB < s.tEndB && s.tEndB <= 1, `${label}: invalid B range on ${s.id}`);
    });
  }
});

test('adv_i21_core_fixes: CORE-BUG-I21-01 analytical Bezier mirror axis-excursion & 64-segment self-intersection guard', () => {
  const transformPts = (pts, angleDeg, tx, ty) => {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return pts.map((p) => ({
      x: tx + p.x * c - p.y * s,
      y: ty + p.x * s + p.y * c,
    }));
  };
  const transformPt = (p, angleDeg, tx, ty) => transformPts([p], angleDeg, tx, ty)[0];
  const cubicFromRoots = (tA, tB, tC, amp, offset) => {
    const A = -amp;
    const B = amp * (tA + tB + tC);
    const C = -amp * (tA * tB + tA * tC + tB * tC);
    const D = amp * tA * tB * tC + offset;
    return {
      p0y: D,
      cp1y: D + C / 3,
      cp2y: D + (2 * C) / 3 + B / 3,
      p1y: A + B + C + D,
    };
  };

  // 1. case1_100x80_1handle: cubic Bezier dips below y=0 strictly between t=0 and t=1/16
  const case1Pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0.2 }, { x: 0, y: 80 }];
  const case1Curve = { cp1: { x: 85, y: -6 }, cp2: { x: 40, y: 75 } };

  // 2. case2_midspan_A1000: midspan cubic dip strictly between 8/16 and 9/16 where all k/16 samples stay >= +0.35mm
  const midA = cubicFromRoots(8 / 16, 9 / 16, 1.15, 1000, 0.35);
  const case2Pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: midA.p0y }, { x: 0, y: midA.p1y }];
  const case2Curve = { cp1: { x: 66.6667, y: midA.cp1y }, cp2: { x: 33.3333, y: midA.cp2y } };

  // 3. Sub-1/64 midspan dip strictly between 32/64 and 33/64 (all 64 samples stay >= +0.05mm)
  const sub64 = cubicFromRoots(32 / 64, 33 / 64, 2.5, 4000, 0.05);
  const sub64Pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: sub64.p0y }, { x: 0, y: sub64.p1y }];
  const sub64Curve = { cp1: { x: 66.6667, y: sub64.cp1y }, cp2: { x: 33.3333, y: sub64.cp2y } };

  // 4. Quadratic Bezier sub-interval dip strictly between t=0 and t=1/16
  const quadDipPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0.2 }, { x: 0, y: 400 }];
  const quadDipCurve = { cp: { x: 99, y: -10 } };

  // 5. Quadratic & cubic tangent kisses strictly between endpoints (|d(t*)| <= 1e-3, no negative excursion)
  const quadKissPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }];
  const quadKissCurve = { cp: { x: 50, y: -20 } };
  const cubicKissPts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }];
  const cubicKissCurve = { cp1: { x: 70, y: -20 / 3 }, cp2: { x: 30, y: -20 / 3 } };

  const invalidCases = [
    ['case1_100x80_1handle', case1Pts, case1Curve, false],
    ['case2_midspan_A1000', case2Pts, case2Curve, false],
    ['cubic_sub64_dip', sub64Pts, sub64Curve, false],
    ['quad_sub16_dip', quadDipPts, quadDipCurve, false],
    ['quad_tangent_kiss', quadKissPts, quadKissCurve, false],
    ['cubic_tangent_kiss', cubicKissPts, cubicKissCurve, false],
    [
      'case1_tilted_shifted',
      transformPts(case1Pts, 37, 412.5, -289.25),
      { cp1: transformPt(case1Curve.cp1, 37, 412.5, -289.25), cp2: transformPt(case1Curve.cp2, 37, 412.5, -289.25) },
      false,
    ],
    [
      'case2_tilted_shifted',
      transformPts(case2Pts, -125, -1500.75, 2200.5),
      { cp1: transformPt(case2Curve.cp1, -125, -1500.75, 2200.5), cp2: transformPt(case2Curve.cp2, -125, -1500.75, 2200.5) },
      false,
    ],
    [
      'quad_tilted_shifted',
      transformPts(quadDipPts, 23, 1000, 2000),
      { cp: transformPt(quadDipCurve.cp, 23, 1000, 2000) },
      false,
    ],
    ['case1_raw_cw', [...case1Pts].reverse(), { cp1: case1Curve.cp2, cp2: case1Curve.cp1 }, true],
  ];

  const mate = core.createRectanglePiece('I21Mate', 100, 40, { id: 'i21_mate' });
  for (const [label, pts, curve, rawCw] of invalidCases) {
    const mirrorEdgeIdx = rawCw ? 2 : 0;
    const curvedEdgeIdx = rawCw ? 0 : 2;
    const edges = pts.map((_, idx) => ({
      seamAllowance: 0,
      curve: idx === curvedEdgeIdx ? curve : null,
    }));
    const piece = rawCw
      ? {
          id: `i21_${label}`,
          name: label,
          points: pts,
          edges,
          seamAllowance: 0,
          notches: [],
          darts: [],
          internalLines: [],
          grainline: { angleDeg: 90 },
          position: { x: 0, y: 0 },
          rotation: 0,
        }
      : core.createFreeformPiece(label, pts, { id: `i21_${label}`, edges });
    const seamTargetEdge = (mirrorEdgeIdx + 1) % pts.length;
    const pat = {
      unit: 'mm',
      pieces: [piece, mate],
      seams: [{ id: `seam_${label}`, pieceA: piece.id, edgeA: seamTargetEdge, pieceB: mate.id, edgeB: 0 }],
    };
    const pieceSnap = JSON.stringify(piece);
    const seamsSnap = JSON.stringify(pat.seams);

    assert.throws(
      () => core.mirrorPieceAcrossEdge(piece, mirrorEdgeIdx, pat),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR',
      `CORE-BUG-I21-01: ${label} must throw ValidationError(SELF_INTERSECTING_MIRROR)`
    );
    assert.equal(JSON.stringify(piece), pieceSnap, `CORE-BUG-I21-01: ${label} must not mutate piece`);
    assert.equal(JSON.stringify(pat.seams), seamsSnap, `CORE-BUG-I21-01: ${label} must not mutate pattern.seams`);
  }

  // Positive curved controls: off-axis convex/concave Beziers + tilted curves meeting shared endpoints a/b cleanly
  const validCurved = core.createFreeformPiece(
    'I21ValidCurved',
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }, { x: 0, y: 120 }],
    {
      id: 'i21_valid_curved',
      edges: [
        { seamAllowance: 10, curve: { cp1: { x: 30, y: -30 }, cp2: { x: 70, y: -15 } } },
        { seamAllowance: 0 },
        { seamAllowance: 10, curve: { cp: { x: 50, y: 95 } } },
        { seamAllowance: 10, curve: { cp1: { x: -18, y: 80 }, cp2: { x: 12, y: 40 } } },
      ],
    }
  );
  const mirroredValid = core.mirrorPieceAcrossEdge(validCurved, 1);
  assert.equal(core.polygonSelfIntersects(mirroredValid.points), false);
  assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(mirroredValid, 64)), false);
  assert.equal(core.validatePatternProject(core.createPatternProject({ pieces: [mirroredValid] })).valid, true);

  // Tilted curve whose handle lies tangent on the axis at shared endpoint a without crossing
  const tiltedTangentEnd = core.createFreeformPiece(
    'I21ValidTiltedEndpointTangent',
    transformPts([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }, { x: 0, y: 120 }], 29, 250, -120),
    {
      id: 'i21_tilted_tan_end',
      edges: [
        {
          seamAllowance: 10,
          curve: {
            cp1: transformPt({ x: 30, y: 20 }, 29, 250, -120),
            cp2: transformPt({ x: 100, y: -10 }, 29, 250, -120),
          },
        },
        { seamAllowance: 0 },
        { seamAllowance: 10 },
        { seamAllowance: 10 },
      ],
    }
  );
  const mirroredTanEnd = core.mirrorPieceAcrossEdge(tiltedTangentEnd, 1);
  assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(mirroredTanEnd, 64)), false);
  assert.equal(core.validatePatternProject(core.createPatternProject({ pieces: [mirroredTanEnd] })).valid, true);
});

test('adv_i20_cross_boundary_and_ui_fixes: GAP-I20-CROSS-01 (REPRO-02 sliver.stl Server+CLI) & GAP-I20-CROSS-02 (app.mjs mirror rollback)', async () => {
  // --- 1. GAP-I20-CROSS-01: REPRO-02 sliver.stl across Server (/api/unwrap-stl, /api/simulate, /api/export) & CLI ---
  const buildSliverStlText = (x1, x2, x3, name) => {
    const tris = [];
    const p = (x, y, z) => ({ x, y, z });
    const q = (a, b, c, d) => {
      tris.push({ a, b, c });
      tris.push({ a, b: c, c: d });
    };
    const x0 = 0;
    const yB = 100;
    const zT = 100;
    const zBL = -50;
    q(p(x0, 0, 0), p(x1, 0, 0), p(x1, 0, zT), p(x0, 0, zT));
    q(p(x1, 0, 0), p(x2, 0, 0), p(x2, 0, zT), p(x1, 0, zT));
    q(p(x2, 0, 0), p(x3, 0, 0), p(x3, 0, zT), p(x2, 0, zT));
    q(p(x1, yB, zBL), p(x0, yB, zBL), p(x0, yB, zT), p(x1, yB, zT));
    q(p(x2, yB, 0), p(x1, yB, zBL), p(x1, yB, zT), p(x2, yB, zT));
    q(p(x3, yB, 0), p(x2, yB, 0), p(x2, yB, zT), p(x3, yB, zT));
    q(p(x0, 0, zT), p(x3, 0, zT), p(x3, yB, zT), p(x0, yB, zT));
    q(p(x0, yB, zBL), p(x0, 0, 0), p(x0, 0, zT), p(x0, yB, zT));
    q(p(x3, 0, 0), p(x3, yB, 0), p(x3, yB, zT), p(x3, 0, zT));
    q(p(x0, yB, zBL), p(x1, yB, zBL), p(x1, 0, 0), p(x0, 0, 0));
    q(p(x1, yB, zBL), p(x2, yB, 0), p(x2, 0, 0), p(x1, 0, 0));
    q(p(x2, yB, 0), p(x3, yB, 0), p(x3, 0, 0), p(x2, 0, 0));
    return core.serializeTrianglesToSTL(tris, name);
  };

  const sliverStl = buildSliverStlText(2500, 2500.001, 5000, 'repro02_sliver');
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const baseUrl = `http://127.0.0.1:${srv.port}`;

  try {
    // 1a) /api/unwrap-stl small (< 128KB) & large (>= 128KB rawJsonBytes offload)
    const smallReqBody = JSON.stringify({
      stlText: sliverStl,
      name: 'repro02_sliver.stl',
      mode: 'surface_panels',
    });
    const offloadReqBody = `${smallReqBody}${' '.repeat(132 * 1024)}`;
    assert.ok(Buffer.byteLength(offloadReqBody, 'utf8') >= 128 * 1024);

    let unwrappedPat = null;
    for (const [kind, body] of [['small', smallReqBody], ['offload_128kb', offloadReqBody]]) {
      const res = await fetch(`${baseUrl}/api/unwrap-stl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(res.status, 200, `GAP-I20-CROSS-01 unwrap (${kind}) must return 200`);
      const data = await res.json();
      assert.equal(data.pattern.pieces.length, 8);
      assert.equal(data.pattern.seams.length, 16);
      assert.ok(data.seamReport.every((r) => r.valid), `GAP-I20-CROSS-01 unwrap (${kind}) seams valid`);
      const minSpan = Math.min(...data.pattern.seams.map((s) => s.tEndA - s.tStartA));
      assert.ok(minSpan > 1e-12 && minSpan < 5e-7, `GAP-I20-CROSS-01 (${kind}) expected minSpan < 5e-7, got ${minSpan}`);
      unwrappedPat = data.pattern;
    }

    // 1b) /api/simulate on unscaled 5000mm hits DoS mesh cap HTTP 400 cleanly; scaled 0.25 preserves minSpan < 5e-7 & returns HTTP 200 finiteOk:true
    const sim5kRes = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: unwrappedPat, steps: 2 }),
    });
    assert.equal(sim5kRes.status, 400, 'GAP-I20-CROSS-01 unscaled 5000mm simulate hits triangle cap cleanly');

    const scaledUnwrapRes = await fetch(`${baseUrl}/api/unwrap-stl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stlText: sliverStl,
        name: 'repro02_sliver_scaled.stl',
        mode: 'surface_panels',
        scale: 0.25,
      }),
    });
    assert.equal(scaledUnwrapRes.status, 200);
    const scaledData = await scaledUnwrapRes.json();
    const scaledMinSpan = Math.min(...scaledData.pattern.seams.map((s) => s.tEndA - s.tStartA));
    assert.ok(scaledMinSpan > 1e-12 && scaledMinSpan < 5e-7);

    const simScaledRes = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: scaledData.pattern, steps: 2 }),
    });
    assert.equal(simScaledRes.status, 200, 'GAP-I20-CROSS-01 scale=0.25 simulate must return 200');
    const simScaledData = await simScaledRes.json();
    assert.equal(simScaledData.finiteOk, true);
    assert.ok(simScaledData.particles.length > 0);

    // 1c) /api/export across svg, dxf, pdf, json -> all HTTP 200
    for (const fmt of ['svg', 'dxf', 'pdf', 'json']) {
      const expRes = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: unwrappedPat, format: fmt }),
      });
      assert.equal(expRes.status, 200, `GAP-I20-CROSS-01 export (${fmt}) must return 200`);
      const expBuf = Buffer.from(await expRes.arrayBuffer());
      assert.ok(expBuf.length > 100, `GAP-I20-CROSS-01 export (${fmt}) non-empty`);
    }

    // 1d) CLI unwrap --mode surface_panels on REPRO-02 sliver.stl
    await withTempDir(async (tmpDir) => {
      const stlPath = path.join(tmpDir, 'sliver.stl');
      const outDir = path.join(tmpDir, 'out');
      await fsp.writeFile(stlPath, sliverStl, 'utf8');
      const cliRes = await runCliProcess([
        'unwrap',
        '--stl',
        stlPath,
        '--mode',
        'surface_panels',
        '--out',
        outDir,
        '--format',
        'svg,dxf,pdf,json',
      ]);
      assert.equal(cliRes.code, 0, `GAP-I20-CROSS-01 CLI unwrap failed: ${cliRes.stderr}`);
      const cliJson = JSON.parse(cliRes.stdout);
      assert.equal(cliJson.piecesCount, 8);
      assert.equal(cliJson.seamCount, 16);
      assert.equal(cliJson.seamIssuesCount, 0);
    });

    // --- 2. GAP-I20-CROSS-02: Live app.mjs UI mirror edge tool & #btnQuickUnfold rollback on AfterB collinearity ---
    const htmlText = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const htmlIds = new Set();
    for (const m of htmlText.matchAll(/\bid="([^"]+)"/g)) {
      htmlIds.add(m[1]);
    }
    const elements = new Map();
    const windowListeners = new Map();
    const makeClassList = (initial = []) => {
      const set = new Set(initial);
      return {
        add: (...cls) => cls.forEach((c) => set.add(c)),
        remove: (...cls) => cls.forEach((c) => set.delete(c)),
        toggle: (c, force) => {
          if (force === undefined) {
            if (set.has(c)) { set.delete(c); return false; }
            set.add(c); return true;
          }
          if (force) set.add(c); else set.delete(c);
          return Boolean(force);
        },
        contains: (c) => set.has(c),
      };
    };
    const makeEl = (tag = 'div', id = '') => {
      const listeners = new Map();
      const children = [];
      let _id = id;
      const elObj = {
        get id() { return _id; },
        set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
        tagName: tag.toUpperCase(),
        type: '',
        value: '',
        min: '',
        max: '',
        step: '',
        checked: false,
        disabled: false,
        textContent: '',
        innerHTML: '',
        width: 640,
        height: 480,
        dataset: {},
        files: [],
        style: {},
        children,
        options: children,
        classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
        parentNode: null,
        parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        dispatchEvent(ev) {
          const event = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
          for (const fn of listeners.get(event.type) || []) fn(event);
        },
        click() { this.dispatchEvent({ type: 'click' }); },
        appendChild(ch) { children.push(ch); ch.parentElement = elObj; ch.parentNode = elObj; return ch; },
        replaceChildren(...chs) { children.length = 0; chs.forEach((c) => elObj.appendChild(c)); },
        setAttribute() {},
        getAttribute() { return ''; },
        getContext(type) {
          if (elObj.tagName !== 'CANVAS') return null;
          if (type === 'webgl2') return createStrictMockWebGL2Context();
          if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
          return null;
        },
        setPointerCapture() {},
        releasePointerCapture() {},
      };
      return elObj;
    };
    for (const id of htmlIds) {
      elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
    }
    elements.get('unitSelect').value = 'mm';

    const prevGlobals = {
      document: globalThis.document,
      window: globalThis.window,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      ImageData: globalThis.ImageData,
      fetch: globalThis.fetch,
      URL: globalThis.URL,
    };
    const nativeFetch = prevGlobals.fetch;

    try {
      globalThis.ImageData = class MockImageData {
        constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
      };
      globalThis.requestAnimationFrame = () => 1;
      globalThis.window = {
        devicePixelRatio: 1,
        addEventListener(type, fn) {
          if (!windowListeners.has(type)) windowListeners.set(type, []);
          windowListeners.get(type).push(fn);
        },
      };
      globalThis.document = {
        activeElement: null,
        body: makeEl('body', ''),
        getElementById: (id) => elements.get(id) || null,
        createElement: (tag) => makeEl(tag, ''),
        querySelectorAll: () => [],
      };
      globalThis.URL = class MockURL extends prevGlobals.URL {
        static createObjectURL() { return 'blob:mock'; }
        static revokeObjectURL() {}
      };
      globalThis.fetch = async (url, init) => {
        const sUrl = String(url);
        return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
      };

      const appMod = await import(`../public/app.mjs?i20cross=${Date.now()}`);
      const waitUntil = async (pred, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (!pred() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
        }
      };
      await waitUntil(() => appMod.state?.pattern);
      assert.ok(appMod.state?.pattern, 'GAP-I20-CROSS-02: initStudio must populate state.pattern');
      const st = appMod.state;

      // Seed both non-empty undo & redo history stacks cleanly via duplicate -> duplicate -> undo
      const initPieceCount = st.pattern.pieces.length;
      elements.get('btnDuplicatePiece').click();
      elements.get('btnDuplicatePiece').click();
      assert.equal(st.pattern.pieces.length, initPieceCount + 2);
      elements.get('btnUndo').click();
      assert.equal(st.pattern.pieces.length, initPieceCount + 1);
      assert.equal(elements.get('btnUndo').disabled, false);
      assert.equal(elements.get('btnRedo').disabled, false);

      // Inject an AfterB-collinear piece on active pattern and select its mirror edge 0
      const afterBPiece = core.createFreeformPiece(
        'AfterBCollinear',
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0 }, { x: 50, y: 100 }],
        { id: 'ui_after_b' }
      );
      st.pattern.pieces.push(afterBPiece);
      st.selectedPieceId = afterBPiece.id;
      st.selectedEdgeIndex = 0;

      const patSnap = JSON.stringify(st.pattern);
      const simRef = st.sim;
      const strainRef = st.strainReport;
      const nestRef = st.nestingResult;
      const toastEl = elements.get('studioToast');

      // 2a) Canvas edge tool click ('mirror') on AfterB piece
      toastEl.textContent = '';
      toastEl.classList.remove('toast-error');
      appMod.cad2D.callbacks.onEdgeToolClick('mirror', afterBPiece.id, 0, 0.5);
      assert.equal(toastEl.classList.contains('toast-error'), true, 'onEdgeToolClick mirror must raise toast-error');
      assert.match(toastEl.textContent, /self-intersecting|degenerate/i);
      assert.equal(JSON.stringify(st.pattern), patSnap, 'onEdgeToolClick mirror must preserve exact state.pattern');
      assert.equal(st.sim, simRef);
      assert.equal(st.strainReport, strainRef);
      assert.equal(st.nestingResult, nestRef);
      assert.equal(elements.get('btnUndo').disabled, false);
      assert.equal(elements.get('btnRedo').disabled, false);

      // 2b) Quick Unfold button (#btnQuickUnfold) on AfterB piece
      toastEl.textContent = '';
      toastEl.classList.remove('toast-error');
      elements.get('btnQuickUnfold').click();
      assert.equal(toastEl.classList.contains('toast-error'), true, '#btnQuickUnfold must raise toast-error');
      assert.match(toastEl.textContent, /self-intersecting|degenerate/i);
      assert.equal(JSON.stringify(st.pattern), patSnap, '#btnQuickUnfold must preserve exact state.pattern');
      assert.equal(st.sim, simRef);
      assert.equal(st.strainReport, strainRef);
      assert.equal(st.nestingResult, nestRef);
      assert.equal(elements.get('btnUndo').disabled, false);
      assert.equal(elements.get('btnRedo').disabled, false);

      // 2c) Subsequent Redo and SVG export succeed cleanly
      elements.get('btnRedo').click();
      assert.equal(st.pattern.pieces.length, initPieceCount + 2, 'Redo stack remained intact & usable');
      assert.equal(elements.get('btnRedo').disabled, true);

      const postRedoExp = await nativeFetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: st.pattern, format: 'svg' }),
      });
      assert.equal(postRedoExp.status, 200, 'Post-rollback redo pattern exports cleanly via /api/export');
    } finally {
      globalThis.document = prevGlobals.document;
      globalThis.window = prevGlobals.window;
      globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
      globalThis.ImageData = prevGlobals.ImageData;
      globalThis.fetch = prevGlobals.fetch;
      globalThis.URL = prevGlobals.URL;
    }
  } finally {
    await closeStudioServer(srv);
  }
});

test('adv_i22_core_fixes: CORE-BUG-I22-01 scale-invariant per-point cancellation & dead-zone closure up to 1e15', () => {
  const transformPts = (pts, angleDeg, tx, ty) => {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return pts.map((p) => ({
      x: tx + p.x * c - p.y * s,
      y: ty + p.x * s + p.y * c,
    }));
  };
  const transformPt = (p, angleDeg, tx, ty) => transformPts([p], angleDeg, tx, ty)[0];
  const cubicFromRoots = (tA, tB, tC, amp, offset) => {
    const A = -amp;
    const B = amp * (tA + tB + tC);
    const C = -amp * (tA * tB + tA * tC + tB * tC);
    const D = amp * tA * tB * tC + offset;
    return {
      p0y: D,
      cp1y: D + C / 3,
      cp2y: D + (2 * C) / 3 + B / 3,
      p1y: A + B + C + D,
    };
  };

  // 1. REPRO-A (L=1e13 midspan -0.047275mm), REPRO-B (L=2e14 edge1 -0.498716mm), monotonic sweeps & tilted 1e13..2e14 cubic+quad crossings
  const invalidCases = [];
  {
    const L = 1e13;
    const reproA = cubicFromRoots(32 / 64, 33 / 64, 2.5, 800, 0.05);
    invalidCases.push([
      'REPRO-A_L1e13_midspan',
      [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: reproA.p0y }, { x: 0, y: reproA.p1y }],
      0,
      2,
      { cp1: { x: (2 * L) / 3, y: reproA.cp1y }, cp2: { x: L / 3, y: reproA.cp2y } },
    ]);
    invalidCases.push([
      'REPRO-A_L1e13_tilted37',
      transformPts([{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: reproA.p0y }, { x: 0, y: reproA.p1y }], 37, 412.5, -289.25),
      0,
      2,
      {
        cp1: transformPt({ x: (2 * L) / 3, y: reproA.cp1y }, 37, 412.5, -289.25),
        cp2: transformPt({ x: L / 3, y: reproA.cp2y }, 37, 412.5, -289.25),
      },
    ]);
    // Monotonic midspan sweep at L=1e13: ~ -0.0005, -0.047, -0.5, -1.5 mm
    for (const [tag, amp] of [['m0.0005', 415], ['m0.047', 800], ['m0.5', 4525], ['m1.5', 12750]]) {
      const m = cubicFromRoots(32 / 64, 33 / 64, 2.5, amp, 0.05);
      invalidCases.push([
        `sweep_mid_L1e13_${tag}`,
        [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: m.p0y }, { x: 0, y: m.p1y }],
        0,
        2,
        { cp1: { x: (2 * L) / 3, y: m.cp1y }, cp2: { x: L / 3, y: m.cp2y } },
      ]);
    }
  }
  {
    const L = 2e14;
    const rbPts = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: 100 }, { x: 0, y: 100 }];
    const rbCurve = { cp1: { x: L + 100, y: -240.3846153846154 }, cp2: { x: L + 50, y: 86538.46153846153 } };
    invalidCases.push(['REPRO-B_L2e14_edge1', rbPts, 0, 1, rbCurve]);
    invalidCases.push([
      'REPRO-B_L2e14_tilted37',
      transformPts(rbPts, 37, 412.5, -289.25),
      0,
      1,
      {
        cp1: transformPt(rbCurve.cp1, 37, 412.5, -289.25),
        cp2: transformPt(rbCurve.cp2, 37, 412.5, -289.25),
      },
    ]);
    // Monotonic edge1 sweep at L=2e14: -0.0005, -0.047, -0.5, -1.5 mm
    for (const [tag, scale] of [['m0.0005', 0.001], ['m0.047', 0.09424], ['m0.5', 1.0025], ['m1.5', 3.008]]) {
      invalidCases.push([
        `sweep_edge1_L2e14_${tag}`,
        rbPts,
        0,
        1,
        { cp1: { x: rbCurve.cp1.x, y: rbCurve.cp1.y * scale }, cp2: { x: rbCurve.cp2.x, y: rbCurve.cp2.y * scale } },
      ]);
    }
    // Tilted midspan L=2e14 dip (-0.10mm inside old crossTol band)
    const midSmall = cubicFromRoots(32 / 64, 33 / 64, 2.5, 1250, 0.05);
    invalidCases.push([
      'mid_L2e14_tilted_m125',
      transformPts([{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: midSmall.p0y }, { x: 0, y: midSmall.p1y }], -125, -1500.75, 2200.5),
      0,
      2,
      {
        cp1: transformPt({ x: (2 * L) / 3, y: midSmall.cp1y }, -125, -1500.75, 2200.5),
        cp2: transformPt({ x: L / 3, y: midSmall.cp2y }, -125, -1500.75, 2200.5),
      },
    ]);
  }
  // Quadratic sub-1/64 crossings (axis-aligned & tilted) at 1e13..2e14
  for (const L of [1e13, 2e14]) {
    for (const [tag, dip] of [['m0.047', 0.047], ['m0.5', 0.5]]) {
      const p1y = 50000;
      const y1 = -Math.sqrt(dip * p1y);
      const qPts = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: p1y }, { x: 0, y: p1y }];
      const qCp = { x: L + 50, y: y1 };
      invalidCases.push([`quad_sub64_L${L}_${tag}`, qPts, 0, 1, { cp: qCp }]);
      invalidCases.push([
        `quad_sub64_L${L}_${tag}_tilted29`,
        transformPts(qPts, 29, 250, -120),
        0,
        1,
        { cp: transformPt(qCp, 29, 250, -120) },
      ]);
    }
  }

  const mate = core.createRectanglePiece('I22Mate', 100, 40, { id: 'i22_mate' });
  for (const [label, pts, mirrorEdgeIdx, curvedEdgeIdx, curve] of invalidCases) {
    const edges = pts.map((_, idx) => ({
      seamAllowance: 0,
      curve: idx === curvedEdgeIdx ? curve : null,
    }));
    const piece = core.createFreeformPiece(label, pts, { id: `i22_${label}`, edges });
    const seamTargetEdge = (mirrorEdgeIdx + 1) % pts.length;
    const pat = {
      unit: 'mm',
      pieces: [piece, mate],
      seams: [{ id: `seam_${label}`, pieceA: piece.id, edgeA: seamTargetEdge, pieceB: mate.id, edgeB: 0 }],
    };
    const pieceSnap = JSON.stringify(piece);
    const seamsSnap = JSON.stringify(pat.seams);

    assert.throws(
      () => core.mirrorPieceAcrossEdge(piece, mirrorEdgeIdx, pat),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR',
      `CORE-BUG-I22-01: ${label} must throw ValidationError(SELF_INTERSECTING_MIRROR)`
    );
    assert.equal(JSON.stringify(piece), pieceSnap, `CORE-BUG-I22-01: ${label} must not mutate piece`);
    assert.equal(JSON.stringify(pat.seams), seamsSnap, `CORE-BUG-I22-01: ${label} must not mutate pattern.seams`);
  }

  // 2. Valid positive controls: <=1e11, tri1e14, and 1e8..1e15 1:1 tilted/translated valid endpoint-tangent squares (ValidSq)
  const validChecks2048 = new Set(['valid_1e11', 'tri1e14', 'ValidSq_1e8_flat', 'ValidSq_1e14_flat', 'ValidSq_1e15_flat', 'ValidSq_1e15_tanOut']);
  const validSpecs = [
    [
      'valid_1e11',
      transformPts([{ x: 0, y: 0 }, { x: 1e11, y: 0 }, { x: 1e11, y: 1e11 }, { x: 0, y: 1e11 }], 29, 250, -120),
      1,
      0,
      {
        cp1: transformPt({ x: 0.3e11, y: 0.2e11 }, 29, 250, -120),
        cp2: transformPt({ x: 1e11, y: -0.1e11 }, 29, 250, -120),
      },
    ],
    [
      'tri1e14',
      transformPts([{ x: 0, y: 0 }, { x: 1e14, y: 0 }, { x: 0.3e14, y: 0.8e14 }], 37, 412.5, -289.25),
      0,
      -1,
      null,
    ],
  ];
  for (const L of [1e8, 1e11, 1e13, 1e14, 1e15]) {
    const sq = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: L }, { x: 0, y: L }];
    const bPt = { x: L, y: 0 };
    validSpecs.push([
      `ValidSq_${L}_flat`,
      transformPts(sq, 13.7, 250, -120),
      0,
      1,
      { cp1: transformPt(bPt, 13.7, 250, -120), cp2: transformPt(bPt, 13.7, 250, -120) },
    ]);
    validSpecs.push([
      `ValidSq_${L}_tanOut`,
      transformPts(sq, 29, 250, -120),
      1,
      0,
      {
        cp1: transformPt({ x: 0.3 * L, y: 0.2 * L }, 29, 250, -120),
        cp2: transformPt({ x: L, y: -0.1 * L }, 29, 250, -120),
      },
    ]);
    validSpecs.push([
      `ValidSq_${L}_quadTanB`,
      transformPts(sq, -125, -1500.75, 2200.5),
      0,
      1,
      { cp: transformPt({ x: 1.3 * L, y: 0 }, -125, -1500.75, 2200.5) },
    ]);
  }

  for (const [label, pts, mirrorEdgeIdx, curvedEdgeIdx, curve] of validSpecs) {
    const edges = pts.map((_, idx) => ({
      seamAllowance: 0,
      ...(idx === curvedEdgeIdx && curve ? { curve } : {}),
    }));
    const piece = core.createFreeformPiece(label, pts, { id: `i22_${label}`, edges });
    const res = core.mirrorPieceAcrossEdge(piece, mirrorEdgeIdx);
    assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(res, 64)), false, `${label}: selfIntersects@64`);
    if (validChecks2048.has(label)) {
      assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(res, 2048)), false, `${label}: selfIntersects@2048`);
    }
  }

  // 3. 1e308 overflow inputs still throw INVALID_POINTS / INVALID_DIMENSIONS cleanly
  const pPosOvf = core.createPatternPiece({
    id: 'i22_pos_ovf',
    name: 'PosOvf',
    points: [{ x: 1e307, y: 0 }, { x: 2e307, y: 0 }, { x: 2e307, y: 1e307 }, { x: 1e307, y: 1e307 }],
    position: { x: 1.75e308, y: 0 },
    seamAllowance: 0,
  });
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pPosOvf, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_DIMENSIONS'
  );
  const pCurveOvf = core.createPatternPiece({
    id: 'i22_curve_ovf',
    name: 'CurveOvf',
    points: [{ x: 0, y: 0 }, { x: 0.1e308, y: 0.048433e308 }, { x: 0, y: 0.2e308 }],
    edges: [
      { name: 'Axis', seamAllowance: 0 },
      { name: 'Leg', seamAllowance: 0 },
      { name: 'Back', seamAllowance: 0, curve: { cp: { x: 1.5e308, y: 1.5e308 } } },
    ],
    seamAllowance: 0,
  });
  assert.throws(
    () => core.mirrorPieceAcrossEdge(pCurveOvf, 0),
    (err) => err instanceof core.ValidationError && err.code === 'INVALID_POINTS'
  );
});

test('adv_i23_core_fixes: CORE-BUG-I23-01, CHAL-I23-01 (+UI), Auditor §3, Reviewer 1 CriticA & CORE-BUG-I23-02 nesting ULP guard', async () => {
  const transformPts = (pts, angleDeg, tx, ty) => {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return pts.map((p) => ({
      x: tx + p.x * c - p.y * s,
      y: ty + p.x * s + p.y * c,
    }));
  };
  const transformPt = (p, angleDeg, tx, ty) => transformPts([p], angleDeg, tx, ty)[0];

  // 1. CORE-BUG-I23-01: sub-1e-9 boundary-layer cubic dips on L=1e15 edges[1] & edges[3] + unbounded cp throw SELF_INTERSECTING_MIRROR
  {
    const L = 1e15;
    const a3E1 = core.createPatternPiece({
      id: 'i23_a3_e1',
      name: 'A3_E1',
      points: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: L }, { x: 0, y: L }],
      edges: [{}, { curve: { cp1: { x: L + 50, y: -1.9e6 }, cp2: { x: L + 100, y: L } } }, {}, {}],
    });
    assert.throws(
      () => core.mirrorPieceAcrossEdge(a3E1, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
    );

    const a3E3 = core.createPatternPiece({
      id: 'i23_a3_e3',
      name: 'A3_E3',
      points: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: L }, { x: 0, y: L }],
      edges: [{}, {}, {}, { curve: { cp1: { x: -100, y: L }, cp2: { x: -50, y: -1.9e6 } } }],
    });
    assert.throws(
      () => core.mirrorPieceAcrossEdge(a3E3, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
    );

    const a3Unbounded = {
      id: 'i23_a3_unb',
      name: 'A3_Unb',
      points: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: L }, { x: 0, y: L }],
      edges: [{}, { curve: { cp1: { x: L + 50, y: -1.9e8 }, cp2: { x: L + 100, y: 1e17 } } }, {}, {}],
    };
    assert.throws(
      () => core.mirrorPieceAcrossEdge(a3Unbounded, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
    );

    // ValidSq (1e8..1e15) & tri1e14 still pass cleanly across tilted orientations
    for (const sc of [1e8, 1e11, 1e13, 1e14, 1e15]) {
      const sq = [{ x: 0, y: 0 }, { x: sc, y: 0 }, { x: sc, y: sc }, { x: 0, y: sc }];
      const bPt = { x: sc, y: 0 };
      const mQuad = core.mirrorPieceAcrossEdge(
        core.createFreeformPiece(`i23_vsq_${sc}`, transformPts(sq, -125, -1500.75, 2200.5), {
          edges: [
            { seamAllowance: 0 },
            { seamAllowance: 0, curve: { cp: transformPt({ x: 1.3 * sc, y: 0 }, -125, -1500.75, 2200.5) } },
            { seamAllowance: 0 },
            { seamAllowance: 0 },
          ],
        }),
        0
      );
      assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(mQuad, 64)), false);
    }
    const tri1e14 = core.createFreeformPiece(
      'i23_tri1e14',
      transformPts([{ x: 0, y: 0 }, { x: 1e14, y: 0 }, { x: 0.3e14, y: 0.8e14 }], 37, 412.5, -289.25),
      { seamAllowance: 0 }
    );
    assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(core.mirrorPieceAcrossEdge(tri1e14, 0), 64)), false);
  }

  // 2. CHAL-I23-01 + Auditor §3 + Reviewer 1 Finding 1
  const th = (37 * Math.PI) / 180;
  const dir = { x: Math.cos(th), y: Math.sin(th) };
  const perp = { x: -dir.y, y: dir.x };
  const pt37 = (a, al, off) => ({ x: a.x + dir.x * al + perp.x * off, y: a.y + dir.y * al + perp.y * off });

  // 2a. CHAL-I23-01 L=2e14 k=2411 & L=1e13 k=1452 core rejection + valid near-a/near-b triangles & Mode D symmetry
  const chal2e14Pts = (() => {
    const a = { x: 0, y: 0 };
    const b = pt37(a, 2e14, 0);
    return [a, b, pt37(b, -2411, 0), pt37(a, 1e14, 1000)];
  })();
  const chal2e14Piece = core.createPatternPiece({
    id: 'i23_chal_2e14',
    name: 'Chal2e14',
    points: chal2e14Pts,
    edges: [0, 1, 2, 3].map((i) => ({ name: `E${i}`, seamAllowance: 0 })),
    seamAllowance: 0,
  });
  const chal2e14Snap = JSON.stringify(chal2e14Piece);
  assert.throws(
    () => core.mirrorPieceAcrossEdge(chal2e14Piece, 0),
    (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
  );
  assert.equal(JSON.stringify(chal2e14Piece), chal2e14Snap);

  {
    const a = { x: 0, y: 0 };
    const b = pt37(a, 1e13, 0);
    const chal1e13Piece = core.createPatternPiece({
      id: 'i23_chal_1e13',
      name: 'Chal1e13',
      points: [a, b, pt37(b, -1452, 0), pt37(a, 0.5e13, 1000)],
      edges: [0, 1, 2, 3].map((i) => ({ name: `E${i}`, seamAllowance: 0 })),
      seamAllowance: 0,
    });
    assert.throws(
      () => core.mirrorPieceAcrossEdge(chal1e13Piece, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
    );
  }

  // Valid near-b & near-a L=2e14 tilted triangles
  {
    const a = { x: 1234, y: -567 };
    const b = pt37(a, 2e14, 0);
    for (const k of [10, 163, 401]) {
      const c = pt37(b, -k, 0.05);
      const triB = core.createPatternPiece({ id: `i23_trib_${k}`, points: [a, b, c], seamAllowance: 0 });
      assert.equal(core.mirrorPieceAcrossEdge(triB, 0).points.length, 4);
    }
    const triA = core.createPatternPiece({
      id: 'i23_tria_curved',
      points: [a, b, pt37(a, 500, 0.05)],
      edges: [{ seamAllowance: 0 }, { seamAllowance: 0, curve: { cp: pt37(a, 1e14, 100) } }, { seamAllowance: 0 }],
      seamAllowance: 0,
    });
    assert.equal(core.mirrorPieceAcrossEdge(triA, 0).points.length, 4);
  }

  // Valid L=2e14 quad opposite-side symmetry near b
  {
    const a = { x: 0, y: 0 };
    const b = pt37(a, 2e14, 0);
    const quad = core.createFreeformPiece('i23_modeD', [a, b, pt37(b, -1000, 1.0), pt37(a, 1000, 1.0)], { seamAllowance: 0 });
    const out = core.mirrorPieceAcrossEdge(quad, 0);
    assert.equal(out.points.length, 6);
    const bPt = out.points[0];
    const aPt = out.points[3];
    const ad = core.norm2({ x: bPt.x * 0.5 - aPt.x * 0.5, y: bPt.y * 0.5 - aPt.y * 0.5 });
    const distFrom = (q, ref) => ad.x * (q.y - ref.y) - ad.y * (q.x - ref.x);
    const dOrigC = distFrom(out.points[1], bPt);
    const dReflC = distFrom(out.points[5], bPt);
    assert.ok(dOrigC > 0.9 && dReflC < -0.9, `expected opposite sides, got dOrigC=${dOrigC}, dReflC=${dReflC}`);
    assert.ok(Math.abs(dOrigC + dReflC) < 0.02, `expected symmetry error < 0.02mm, got ${Math.abs(dOrigC + dReflC)}`);
  }

  // 2b. CHAL-I23-01 L=2e14 37° k=2411 quad via live public/app.mjs UI (onEdgeToolClick('mirror') & #btnQuickUnfold atomic rollback + toast-error)
  {
    const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    try {
      const htmlTextI23 = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const htmlIds = new Set(Array.from(htmlTextI23.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
      const elements = new Map();
      const windowListeners = new Map();
      const makeClassList = (initial = []) => {
        const set = new Set(initial);
        return {
          add: (...cls) => cls.forEach((c) => set.add(c)),
          remove: (...cls) => cls.forEach((c) => set.delete(c)),
          toggle: (c, force) => {
            if (force === undefined) {
              if (set.has(c)) { set.delete(c); return false; }
              set.add(c); return true;
            }
            if (force) set.add(c); else set.delete(c);
            return Boolean(force);
          },
          contains: (c) => set.has(c),
        };
      };
      const makeEl = (tag = 'div', id = '') => {
        const listeners = new Map();
        const children = [];
        let _id = id;
        const elObj = {
          get id() { return _id; },
          set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
          tagName: tag.toUpperCase(),
          type: '', value: '', min: '', max: '', step: '', checked: false, disabled: false,
          textContent: '', innerHTML: '', width: 640, height: 480, dataset: {}, files: [], children, options: children,
          classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
          parentElement: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
          addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          dispatchEvent(ev) {
            const event = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
            for (const fn of listeners.get(event.type) || []) fn(event);
          },
          click() { this.dispatchEvent({ type: 'click' }); },
          appendChild(ch) { children.push(ch); ch.parentElement = elObj; ch.parentNode = elObj; return ch; },
          removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); return ch; },
          replaceChildren(...chs) { children.length = 0; chs.forEach((c) => elObj.appendChild(c)); },
          setAttribute() {},
          getAttribute() { return ''; },
          getContext(type) {
            if (elObj.tagName !== 'CANVAS') return null;
            if (type === 'webgl2') return createStrictMockWebGL2Context();
            if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
            return null;
          },
          setPointerCapture() {},
          releasePointerCapture() {},
        };
        return elObj;
      };
      for (const id of htmlIds) {
        elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
      }
      elements.get('unitSelect').value = 'mm';

      const prevGlobals = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        ImageData: globalThis.ImageData,
        fetch: globalThis.fetch,
        URL: globalThis.URL,
      };
      const nativeFetch = prevGlobals.fetch;

      try {
        globalThis.ImageData = class MockImageData {
          constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
        };
        globalThis.requestAnimationFrame = () => 1;
        globalThis.window = {
          devicePixelRatio: 1,
          addEventListener(type, fn) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(fn);
          },
        };
        globalThis.document = {
          activeElement: null,
          body: makeEl('body', ''),
          getElementById: (id) => elements.get(id) || null,
          createElement: (tag) => makeEl(tag, ''),
          querySelectorAll: () => [],
        };
        globalThis.URL = class MockURL extends prevGlobals.URL {
          static createObjectURL() { return 'blob:mock'; }
          static revokeObjectURL() {}
        };
        globalThis.fetch = async (url, init) => {
          const sUrl = String(url);
          return sUrl.startsWith('/') ? nativeFetch(`${baseUrl}${sUrl}`, init) : nativeFetch(url, init);
        };

        const appMod = await import(`../public/app.mjs?i23chal=${Date.now()}`);
        const deadline = Date.now() + 5000;
        while (!appMod.state?.pattern && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.ok(appMod.state?.pattern, 'CHAL-I23-01 UI: initStudio populated state.pattern');
        const st = appMod.state;

        const uiChal = structuredClone(chal2e14Piece);
        uiChal.id = 'ui_chal_2e14';
        st.pattern.pieces.push(uiChal);
        st.selectedPieceId = uiChal.id;
        st.selectedEdgeIndex = 0;

        const patSnap = JSON.stringify(st.pattern);
        const simRef = st.sim;
        const strainRef = st.strainReport;
        const nestRef = st.nestingResult;
        const toastEl = elements.get('studioToast');

        toastEl.textContent = '';
        toastEl.classList.remove('toast-error');
        appMod.cad2D.callbacks.onEdgeToolClick('mirror', uiChal.id, 0, 0.5);
        assert.equal(toastEl.classList.contains('toast-error'), true, 'CHAL-I23-01 UI onEdgeToolClick must raise toast-error');
        assert.match(toastEl.textContent, /self-intersecting|degenerate/i);
        assert.equal(JSON.stringify(st.pattern), patSnap);
        assert.equal(st.sim, simRef);
        assert.equal(st.strainReport, strainRef);
        assert.equal(st.nestingResult, nestRef);

        toastEl.textContent = '';
        toastEl.classList.remove('toast-error');
        elements.get('btnQuickUnfold').click();
        assert.equal(toastEl.classList.contains('toast-error'), true, 'CHAL-I23-01 UI #btnQuickUnfold must raise toast-error');
        assert.match(toastEl.textContent, /self-intersecting|degenerate/i);
        assert.equal(JSON.stringify(st.pattern), patSnap);
        assert.equal(st.sim, simRef);
        assert.equal(st.strainReport, strainRef);
        assert.equal(st.nestingResult, nestRef);
      } finally {
        globalThis.document = prevGlobals.document;
        globalThis.window = prevGlobals.window;
        globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
        globalThis.ImageData = prevGlobals.ImageData;
        globalThis.fetch = prevGlobals.fetch;
        globalThis.URL = prevGlobals.URL;
      }
    } finally {
      await closeStudioServer(srv);
    }
  }

  // 2c. Reviewer 1 Finding 1: CriticA b->a 5-gon spans (L=1e13..1e15)
  for (const [L, ang, sVal] of [[1e13, 37, 1.0], [1e14, 143, 1.0], [2e14, 143, 1.0], [1e15, 37, 1.1]]) {
    const rad = (ang * Math.PI) / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad), px = -dy, py = dx;
    const tp = (x, y) => ({ x: 412.5 + x * dx + y * px, y: -289.25 + x * dy + y * py });
    const p5 = core.createFreeformPiece(`i23_criticA_${L}_${ang}`, [tp(0, 0), tp(L, 0), tp(L, 1), tp(L - 1000, 0.05), tp(0, 100)], {
      edges: [
        { seamAllowance: 0 },
        { seamAllowance: 0 },
        { seamAllowance: 0 },
        { seamAllowance: 0, curve: { cp1: tp(L - 1000 - 200, -55 * sVal), cp2: tp(L - 1000 - 600, 20000) } },
        { seamAllowance: 0 },
      ],
    });
    assert.throws(
      () => core.mirrorPieceAcrossEdge(p5, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR',
      `CriticA L=${L} ang=${ang} must throw`
    );
  }

  // 2d. Auditor §3: (2e14, 2e14) k=0/0.5/2/5 cubic & k=3 quad + L=1e15 37° -0.002/-0.005 mm
  {
    const tx0 = 2e14;
    const a = { x: tx0, y: tx0 };
    const b = { x: tx0 + 1000, y: tx0 + 1000 };
    const p1 = { x: b.x - 2000, y: b.y + 2000 };
    const p2 = { x: a.x - 2000, y: a.y + 2000 };
    const cp2 = { x: b.x - 800, y: b.y + 1200 };
    for (const k of [0.5, 2, 5]) {
      const pCubic = core.createPatternPiece({
        id: `i23_aud_c_${k}`,
        points: [a, b, p1, p2],
        edges: [{ seamAllowance: 0 }, { seamAllowance: 0, curve: { cp1: { x: b.x + 1 + k, y: b.y + 1 - k }, cp2 } }, { seamAllowance: 0 }, { seamAllowance: 0 }],
        seamAllowance: 0,
      });
      assert.throws(
        () => core.mirrorPieceAcrossEdge(pCubic, 0),
        (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
      );
    }
    const pCubicValid = core.createPatternPiece({
      id: 'i23_aud_c_0',
      points: [a, b, p1, p2],
      edges: [{ seamAllowance: 0 }, { seamAllowance: 0, curve: { cp1: { x: b.x + 1, y: b.y + 1 }, cp2 } }, { seamAllowance: 0 }, { seamAllowance: 0 }],
      seamAllowance: 0,
    });
    assert.equal(core.polygonSelfIntersects(core.samplePieceOutline(core.mirrorPieceAcrossEdge(pCubicValid, 0), 2048)), false);

    const pQuad = core.createPatternPiece({
      id: 'i23_aud_q_3',
      points: [a, b, p1, p2],
      edges: [{ seamAllowance: 0 }, { seamAllowance: 0, curve: { cp: { x: b.x + 4, y: b.y - 2 } } }, { seamAllowance: 0 }, { seamAllowance: 0 }],
      seamAllowance: 0,
    });
    assert.throws(
      () => core.mirrorPieceAcrossEdge(pQuad, 0),
      (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
    );

    const a15 = { x: 412.5, y: -289.25 };
    const b15 = pt37(a15, 1e15, 0);
    const c15 = pt37(b15, 0, 1e15);
    const d15 = pt37(a15, 0, 1e15);
    for (const target of [-0.002, -0.005]) {
      const y1 = -Math.sqrt((4 * 1e15 * (-target)) / 3);
      const p15 = core.createPatternPiece({
        id: `i23_aud_15_${target}`,
        points: [a15, b15, c15, d15],
        edges: [{ seamAllowance: 0 }, { seamAllowance: 0, curve: { cp1: pt37(b15, 50, y1), cp2: pt37(b15, 100, 1e15) } }, { seamAllowance: 0 }, { seamAllowance: 0 }],
        seamAllowance: 0,
      });
      assert.throws(
        () => core.mirrorPieceAcrossEdge(p15, 0),
        (err) => err instanceof core.ValidationError && err.code === 'SELF_INTERSECTING_MIRROR'
      );
    }
  }

  // 3. CORE-BUG-I23-02: Option A ULP advancement + verifyNoOverlaps across 1e15 (packShelf, packSkyline, allowRotate90) & 2e17 (spacingMm: 8) + clean SVG export
  {
    const big = core.createRectanglePiece('Big5e14', 5e14, 100, { id: 'i23_big', seamAllowance: 0 });
    const tiny = core.createRectanglePiece('Tiny02', 0.02, 100, { id: 'i23_tiny', seamAllowance: 0, quantity: 3 });
    for (const sheetLengthMm of [100, null]) {
      for (const allowRotate90 of [false, true]) {
        const res = core.nestPatternPieces(
          { unit: 'mm', pieces: [big, tiny], seams: [] },
          { fabricWidthMm: 1e15, sheetLengthMm, marginMm: 0, spacingMm: 0, allowRotate90 }
        );
        assert.equal(res.placements.length, 4);
        const coords = new Set(res.placements.map((p) => `${p.sheetIndex}:${p.x}:${p.y}`));
        assert.equal(coords.size, 4, `ULP placements must be distinct for sheetLen=${sheetLengthMm}, rot=${allowRotate90}`);
        for (const pl of res.placements) {
          assert.ok(pl.minX + pl.width > pl.minX && pl.minY + pl.height > pl.minY, 'no ULP-collapsed placement bbox');
        }
        const svg = core.exportSVG({ unit: 'mm', pieces: [big, tiny], seams: [] }, { layout: 'nested', nestingResult: res });
        assert.ok(svg.includes('<svg') && svg.includes('Tiny02'));
      }
    }

    // Round-down width 0.08 at 5e14 (x + 0.08 rounds down to x + 0.0625 without addCeil)
    const p08 = core.createRectanglePiece('Tiny08', 0.08, 100, { id: 'i23_w08', seamAllowance: 0, quantity: 3 });
    for (const sheetLengthMm of [100, null]) {
      const res08 = core.nestPatternPieces(
        { unit: 'mm', pieces: [big, p08], seams: [] },
        { fabricWidthMm: 1e15, sheetLengthMm, marginMm: 0, spacingMm: 0, allowRotate90: false }
      );
      assert.equal(res08.placements.length, 4);
      const w08Pls = res08.placements.filter((p) => p.pieceId === 'i23_w08');
      for (let i = 0; i < w08Pls.length; i++) {
        for (let j = i + 1; j < w08Pls.length; j++) {
          if (w08Pls[i].sheetIndex === w08Pls[j].sheetIndex && w08Pls[i].y === w08Pls[j].y) {
            assert.ok(Math.abs(w08Pls[j].x - w08Pls[i].x) >= 0.08);
          }
        }
      }
    }

    // 2e17 roll with spacingMm: 8 (Option A: packs cleanly across shelves/sheets with zero identical/overlapping placements)
    const big15 = core.createRectanglePiece('Big1e15', 1e15, 1000, { id: 'i23_big15', seamAllowance: 0, quantity: 150 });
    const tiny1 = core.createRectanglePiece('Tiny1', 1, 1000, { id: 'i23_tiny1', seamAllowance: 0, quantity: 3 });
    for (const sheetLengthMm of [1000, null]) {
      const res2e17 = core.nestPatternPieces(
        { unit: 'mm', pieces: [big15, tiny1], seams: [] },
        { fabricWidthMm: 2e17, sheetLengthMm, marginMm: 0, spacingMm: 8, allowRotate90: false }
      );
      assert.equal(res2e17.placements.length, 153);
      const tinyPls = res2e17.placements.filter((p) => p.pieceId === 'i23_tiny1');
      assert.equal(new Set(tinyPls.map((p) => `${p.sheetIndex}:${p.x}:${p.y}`)).size, 3);
    }
  }
});

test('adv_i24_core_and_cad_fixes: CORE-BUG-I24-01 Repros A-D + Reviewer i23_1 Findings 1-2, CAD-I24-01 & OBS-I24-01', async () => {
  const assertStrictNest = (res, { marginMm, spacingMm, fabricWidthMm, sheetLengthMm = null }) => {
    const bySheet = new Map();
    for (const pl of res.placements) {
      assert.ok(pl.minX >= marginMm, `minX ${pl.minX} < marginMm ${marginMm}`);
      assert.ok(pl.minY >= marginMm, `minY ${pl.minY} < marginMm ${marginMm}`);
      assert.ok(pl.maxX <= fabricWidthMm - marginMm + 1e-6, `maxX ${pl.maxX} > ${fabricWidthMm - marginMm}`);
      if (sheetLengthMm !== null) {
        assert.ok(pl.maxY <= sheetLengthMm - marginMm + 1e-6, `maxY ${pl.maxY} > ${sheetLengthMm - marginMm}`);
      }
      if (!bySheet.has(pl.sheetIndex)) bySheet.set(pl.sheetIndex, []);
      bySheet.get(pl.sheetIndex).push(pl);
    }
    for (const list of bySheet.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const sepX = (b.minX >= a.maxX && b.minX - a.minX >= a.width) || (a.minX >= b.maxX && a.minX - b.minX >= b.width);
          const sepY = (b.minY >= a.maxY && b.minY - a.minY >= a.height) || (a.minY >= b.maxY && a.minY - b.minY >= b.height);
          assert.ok(sepX || sepY, `Overlap detected between ${a.pieceName} and ${b.pieceName}`);
          if (spacingMm > 0) {
            if (!sepY) {
              const gapX =
                b.minX >= a.maxX
                  ? Math.min(b.minX - a.maxX, (b.minX - a.minX) - a.width)
                  : Math.min(a.minX - b.maxX, (a.minX - b.minX) - b.width);
              assert.ok(gapX >= spacingMm, `X spacing violated: ${gapX} < ${spacingMm}`);
            }
            if (!sepX) {
              const gapY =
                b.minY >= a.maxY
                  ? Math.min(b.minY - a.maxY, (b.minY - a.minY) - a.height)
                  : Math.min(a.minY - b.maxY, (a.minY - b.minY) - b.height);
              assert.ok(gapY >= spacingMm, `Y spacing violated: ${gapY} < ${spacingMm}`);
            }
          }
        }
      }
    }
  };

  // 1a. CORE-BUG-I24-01 Repro A: Default marginMm=10 on 2e17 roll
  {
    const bigA = core.createRectanglePiece('BigA', 1e15, 1000, { id: 'i24_biga', seamAllowance: 0, quantity: 150 });
    const resA = core.nestPatternPieces(
      { unit: 'mm', pieces: [bigA], seams: [] },
      { fabricWidthMm: 2e17, sheetLengthMm: null, marginMm: 10, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resA.placements.length, 150);
    assertStrictNest(resA, { marginMm: 10, spacingMm: 0, fabricWidthMm: 2e17, sheetLengthMm: null });
  }

  // 1b. CORE-BUG-I24-01 Repro B: 5e14..1e15 with fractional marginMm=10.03125/10.0625 on packShelf & packSkyline (both X & Y + rot90)
  for (const [scale, marginMm, shelfLen] of [
    [5e14, 10.03125, 1020.0625],
    [1e15, 10.0625, 1020.125],
  ]) {
    const bigB = core.createRectanglePiece('BigB', scale, 1000, { id: 'i24_bigb', seamAllowance: 0 });
    const tinyB = core.createRectanglePiece('TinyB', 0.15, 1000, { id: 'i24_tinyb', seamAllowance: 0, quantity: 6 });
    for (const sheetLengthMm of [shelfLen, null]) {
      const resB = core.nestPatternPieces(
        { unit: 'mm', pieces: [bigB, tinyB], seams: [] },
        { fabricWidthMm: 2 * scale, sheetLengthMm, marginMm, spacingMm: 0, allowRotate90: false }
      );
      assert.equal(resB.placements.length, 7);
      assertStrictNest(resB, { marginMm, spacingMm: 0, fabricWidthMm: 2 * scale, sheetLengthMm });
    }

    // Y-axis stacking at 5e14/1e15
    const bigY = core.createRectanglePiece('BigY', 1000, scale, { id: 'i24_bigy', seamAllowance: 0 });
    const tinyY = core.createRectanglePiece('TinyY', 1000, 0.15, { id: 'i24_tinyy', seamAllowance: 0, quantity: 4 });
    const fwY = 1000 + 2 * marginMm;
    const resY = core.nestPatternPieces(
      { unit: 'mm', pieces: [bigY, tinyY], seams: [] },
      { fabricWidthMm: fwY, sheetLengthMm: null, marginMm, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resY.placements.length, 5);
    assertStrictNest(resY, { marginMm, spacingMm: 0, fabricWidthMm: fwY, sheetLengthMm: null });

    // allowRotate90: true at 5e14/1e15
    const rotR = core.createRectanglePiece('TinyR', 0.15, 100, { id: 'i24_tinyr', seamAllowance: 0, quantity: 4 });
    const bigR = core.createRectanglePiece('BigR', scale, 100, { id: 'i24_bigr', seamAllowance: 0 });
    for (const sheetLengthMm of [160 + 2 * marginMm, null]) {
      const resR = core.nestPatternPieces(
        { unit: 'mm', pieces: [bigR, rotR], seams: [] },
        { fabricWidthMm: 2 * scale, sheetLengthMm, marginMm, spacingMm: 0, allowRotate90: true }
      );
      assert.equal(resR.placements.length, 5);
      assertStrictNest(resR, { marginMm, spacingMm: 0, fabricWidthMm: 2 * scale, sheetLengthMm });
    }
  }

  // 1c. CORE-BUG-I24-01 Repro C: strict non-overlap (< 1e-4 mm not masked) + dx >= width
  for (const sheetLengthMm of [120.0625, null]) {
    const bigC = core.createRectanglePiece('BigC', 5e14, 100, { id: 'i24_bigc', seamAllowance: 0 });
    const tinyC = core.createRectanglePiece('TinyC', 0.12505, 100, { id: 'i24_tinyc', seamAllowance: 0, quantity: 6 });
    const resC = core.nestPatternPieces(
      { unit: 'mm', pieces: [bigC, tinyC], seams: [] },
      { fabricWidthMm: 1e15, sheetLengthMm, marginMm: 10.03125, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resC.placements.length, 7);
    const tPls = resC.placements.filter((p) => p.pieceId === 'i24_tinyc').sort((a, b) => a.x - b.x);
    for (let i = 0; i < tPls.length - 1; i++) {
      assert.ok(tPls[i + 1].x >= tPls[i].maxX, `tiny[${i + 1}].x ${tPls[i + 1].x} < tiny[${i}].maxX ${tPls[i].maxX}`);
      assert.ok(tPls[i + 1].x - tPls[i].x >= tPls[i].width, `dx < width at index ${i}`);
    }
    assertStrictNest(resC, { marginMm: 10.03125, spacingMm: 0, fabricWidthMm: 1e15, sheetLengthMm });
  }

  // 1d. CORE-BUG-I24-01 Repro D: spacingMm preservation (minGap >= 8 on 2e17 & >= 0.02 at 5e14) + exact single-piece fit w/ spacing
  {
    const bigD = core.createRectanglePiece('BigD', 1e15 - 4, 1000, { id: 'i24_bigd', seamAllowance: 0, quantity: 100 });
    const resD = core.nestPatternPieces(
      { unit: 'mm', pieces: [bigD], seams: [] },
      { fabricWidthMm: 2e17, sheetLengthMm: null }
    );
    assert.equal(resD.placements.length, 100);
    assertStrictNest(resD, { marginMm: 10, spacingMm: 8, fabricWidthMm: 2e17, sheetLengthMm: null });

    const big5 = core.createRectanglePiece('Big5e14', 5e14, 100, { id: 'i24_big5', seamAllowance: 0, quantity: 2 });
    const res5 = core.nestPatternPieces(
      { unit: 'mm', pieces: [big5], seams: [] },
      { fabricWidthMm: 1.5e15, sheetLengthMm: null, marginMm: 10, spacingMm: 0.02, allowRotate90: false }
    );
    assert.equal(res5.placements.length, 2);
    assertStrictNest(res5, { marginMm: 10, spacingMm: 0.02, fabricWidthMm: 1.5e15, sheetLengthMm: null });

    // Single piece filling exact usable width/height with spacingMm > 0 & marginMm >= 1e14
    const exactFit = core.createRectanglePiece('ExactFit', 8e14, 100, { id: 'i24_exact', seamAllowance: 0 });
    const resFit = core.nestPatternPieces(
      { unit: 'mm', pieces: [exactFit], seams: [] },
      { fabricWidthMm: 1e15, sheetLengthMm: 2e14 + 120, marginMm: 1e14, spacingMm: 0.02, allowRotate90: false }
    );
    assert.equal(resFit.placements.length, 1);
    assertStrictNest(resFit, { marginMm: 1e14, spacingMm: 0.02, fabricWidthMm: 1e15, sheetLengthMm: 2e14 + 120 });
  }

  // 1e. Reviewer i23_1 Finding 1: packSkyline sub-1e-7 strip (Tiny0 = 5e-8 x 6e8, qty: 3) solo & mixed
  {
    const tiny0 = core.createRectanglePiece('Tiny0', 5e-8, 6e8, { id: 'i24_tiny0', seamAllowance: 0, quantity: 3 });
    const a0 = core.createRectanglePiece('A0', 5e8, 2e8, { id: 'i24_a0', seamAllowance: 0 });
    const b0 = core.createRectanglePiece('B0', 2e8, 4e8, { id: 'i24_b0', seamAllowance: 0, quantity: 2 });

    const resMixed = core.nestPatternPieces(
      { unit: 'mm', pieces: [tiny0, a0, b0], seams: [] },
      { fabricWidthMm: 5.5e8, sheetLengthMm: null, marginMm: 0, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resMixed.placements.length, 6);
    assertStrictNest(resMixed, { marginMm: 0, spacingMm: 0, fabricWidthMm: 5.5e8, sheetLengthMm: null });

    const resSolo = core.nestPatternPieces(
      { unit: 'mm', pieces: [tiny0], seams: [] },
      { fabricWidthMm: 100, sheetLengthMm: null, marginMm: 0, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resSolo.placements.length, 3);
    assertStrictNest(resSolo, { marginMm: 0, spacingMm: 0, fabricWidthMm: 100, sheetLengthMm: null });

    // Horizontal strip height 5e-8 (mergeSkyline exact y comparison)
    const thinH = core.createRectanglePiece('ThinH', 6e8, 5e-8, { id: 'i24_thinh', seamAllowance: 0, quantity: 3 });
    const resThinH = core.nestPatternPieces(
      { unit: 'mm', pieces: [thinH], seams: [] },
      { fabricWidthMm: 8e8, sheetLengthMm: null, marginMm: 0, spacingMm: 0, allowRotate90: false }
    );
    assert.equal(resThinH.placements.length, 3);
    assertStrictNest(resThinH, { marginMm: 0, spacingMm: 0, fabricWidthMm: 8e8, sheetLengthMm: null });
  }

  // 1f. Reviewer i23_1 Finding 2: marginMm=10.0078125, w=1e14 on packShelf & packSkyline
  {
    const bigM = core.createRectanglePiece('BigM', 1e14, 100, { id: 'i24_bigm', seamAllowance: 0 });
    const tinyM = core.createRectanglePiece('TinyM', 0.02, 100, { id: 'i24_tinym', seamAllowance: 0, quantity: 3 });
    for (const sheetLengthMm of [200, null]) {
      const resM = core.nestPatternPieces(
        { unit: 'mm', pieces: [bigM, tinyM], seams: [] },
        { fabricWidthMm: 1e15, sheetLengthMm, marginMm: 10.0078125, spacingMm: 0, allowRotate90: false }
      );
      assert.equal(resM.placements.length, 4);
      assertStrictNest(resM, { marginMm: 10.0078125, spacingMm: 0, fabricWidthMm: 1e15, sheetLengthMm });
    }
  }

  // 2. CAD-I24-01 (Standalone CAD2DViewport realistic browser double-click)
  {
    const ls = new Map();
    const noop = () => {};
    const prevWin = globalThis.window;
    globalThis.window = { devicePixelRatio: 1, addEventListener: noop };
    try {
      const ctx = {
        save: noop, restore: noop, setTransform: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
        beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
        arc: noop, fill: noop, stroke: noop, setLineDash: noop, fillText: noop, translate: noop, rotate: noop,
        measureText: () => ({ width: 10 }),
      };
      const canvas = {
        width: 800, height: 600, style: {},
        parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        getContext: () => ctx,
        addEventListener: (t, fn) => {
          if (!ls.has(t)) ls.set(t, []);
          ls.get(t).push(fn);
        },
        setPointerCapture: noop,
        releasePointerCapture: noop,
      };
      const emit = (t, ev) => {
        for (const fn of ls.get(t) || []) fn({ preventDefault: noop, ...ev });
      };
      const created = [];
      const vp = new CAD2DViewport(canvas, { onCreateFreeform: (pts) => created.push(pts) });
      vp.render({ pattern: { unit: 'mm', pieces: [], seams: [] }, unit: 'mm', viewMode: 'pattern', activeTool: 'draw_poly' });
      const clk = (x, y) => {
        emit('pointerdown', { clientX: x, clientY: y, button: 0, pointerId: 1 });
        emit('pointerup', { clientX: x, clientY: y, button: 0, pointerId: 1 });
      };

      // Realistic browser 3-corner double-click triangle (clk -> clk -> clk -> clk -> dblclick)
      clk(300, 300); clk(500, 300); clk(400, 460); clk(400, 460);
      emit('dblclick', { clientX: 400, clientY: 460, button: 0 });
      assert.equal(created.length, 1);
      assert.equal(created[0].length, 3, 'realistic double-click triangle must emit 3 vertices (no duplicate)');
      const triPc = core.createFreeformPiece('DblTri', created[0], { id: 'i24_dtri', seamAllowance: 10 });
      for (let i = 0; i < triPc.points.length; i++) {
        const m = core.mirrorPieceAcrossEdge(structuredClone(triPc), i);
        assert.ok(m.points.length >= 4, `mirrorPieceAcrossEdge must succeed on triangle edge ${i}`);
      }

      // Realistic browser 4-corner double-click quad
      clk(300, 300); clk(460, 300); clk(460, 420); clk(300, 420); clk(300, 420);
      emit('dblclick', { clientX: 300, clientY: 420, button: 0 });
      assert.equal(created.length, 2);
      assert.equal(created[1].length, 4, 'realistic double-click quad must emit 4 vertices');
      const quadPc = core.createFreeformPiece('DblQuad', created[1], { id: 'i24_dquad', seamAllowance: 10 });
      for (let i = 0; i < quadPc.points.length; i++) {
        const m = core.mirrorPieceAcrossEdge(structuredClone(quadPc), i);
        assert.ok(m.points.length >= 6, `mirrorPieceAcrossEdge must succeed on quad edge ${i}`);
      }

      // Realistic 2 clicks + dblclick clean no-op
      clk(250, 250); clk(400, 250); clk(400, 250);
      emit('dblclick', { clientX: 400, clientY: 250, button: 0 });
      assert.equal(created.length, 2, '2 clicks + dblclick must be a clean no-op');
      vp.clearPen();

      // 3-point degenerate [A, B, A] in penPoints clears penPoints and skips onCreateFreeform
      vp.penPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }];
      emit('dblclick', { clientX: 0, clientY: 0, button: 0 });
      assert.equal(created.length, 2);
      assert.equal(vp.penPoints.length, 0);
    } finally {
      globalThis.window = prevWin;
    }
  }

  // 3. Live public/app.mjs UI: CAD-I24-01 (#canvas2D draw_poly -> #btnQuickUnfold on ALL edges + 2-click no-op) & OBS-I24-01 (#btnExportSVG nested warning)
  {
    const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    try {
      const htmlText = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const htmlIds = new Set(Array.from(htmlText.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
      const elements = new Map();
      const windowListeners = new Map();
      const makeClassList = (initial = []) => {
        const set = new Set(initial);
        return {
          add: (...cls) => cls.forEach((c) => set.add(c)),
          remove: (...cls) => cls.forEach((c) => set.delete(c)),
          toggle: (c, force) => {
            if (force === undefined) {
              if (set.has(c)) { set.delete(c); return false; }
              set.add(c); return true;
            }
            if (force) set.add(c); else set.delete(c);
            return Boolean(force);
          },
          contains: (c) => set.has(c),
        };
      };
      const makeEl = (tag = 'div', id = '') => {
        const listeners = new Map();
        const children = [];
        let _id = id;
        const elObj = {
          get id() { return _id; },
          set id(v) { _id = String(v); if (_id) elements.set(_id, elObj); },
          tagName: tag.toUpperCase(),
          type: '', value: '', min: '', max: '', step: '', checked: false, disabled: false,
          textContent: '', innerHTML: '', width: 800, height: 600, dataset: {}, files: [], children, options: children,
          classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
          parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
          addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          dispatchEvent(ev) {
            const event = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
            for (const fn of listeners.get(event.type) || []) fn(event);
          },
          click() { this.dispatchEvent({ type: 'click' }); },
          appendChild(ch) { children.push(ch); ch.parentElement = elObj; ch.parentNode = elObj; return ch; },
          removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); return ch; },
          replaceChildren(...chs) { children.length = 0; chs.forEach((c) => elObj.appendChild(c)); },
          setAttribute() {},
          getAttribute() { return ''; },
          getContext(type) {
            if (elObj.tagName !== 'CANVAS') return null;
            if (type === 'webgl2') return createStrictMockWebGL2Context();
            if (type === '2d') return { ...createMock2DContext(), putImageData() {} };
            return null;
          },
          setPointerCapture() {},
          releasePointerCapture() {},
        };
        return elObj;
      };
      for (const id of htmlIds) {
        elements.set(id, makeEl(id.includes('Canvas') || id.startsWith('canvas') ? 'canvas' : 'div', id));
      }
      elements.get('unitSelect').value = 'mm';

      const prevGlobals = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        ImageData: globalThis.ImageData,
        fetch: globalThis.fetch,
        URL: globalThis.URL,
      };
      const nativeFetch = prevGlobals.fetch;
      const exportStatuses = [];
      let downloadedBlobs = 0;

      try {
        globalThis.ImageData = class MockImageData {
          constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
        };
        globalThis.requestAnimationFrame = () => 1;
        globalThis.window = {
          devicePixelRatio: 1,
          addEventListener(type, fn) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(fn);
          },
        };
        globalThis.document = {
          activeElement: null,
          body: makeEl('body', ''),
          getElementById: (id) => elements.get(id) || null,
          createElement: (tag) => makeEl(tag, ''),
          querySelectorAll: () => [],
        };
        globalThis.URL = class MockURL extends prevGlobals.URL {
          static createObjectURL() { downloadedBlobs++; return 'blob:mock'; }
          static revokeObjectURL() {}
        };
        globalThis.fetch = async (url, init) => {
          const sUrl = String(url);
          const resp = sUrl.startsWith('/') ? await nativeFetch(`${baseUrl}${sUrl}`, init) : await nativeFetch(url, init);
          if (sUrl.includes('/api/export')) exportStatuses.push(resp.status);
          return resp;
        };

        const appMod = await import(`../public/app.mjs?i24ui=${Date.now()}`);
        const deadline = Date.now() + 5000;
        while (!appMod.state?.pattern && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.ok(appMod.state?.pattern, 'initStudio populated state.pattern');
        const st = appMod.state;
        const c2 = elements.get('canvas2D');
        const toastEl = elements.get('studioToast');
        const clk2d = (x, y) => {
          c2.dispatchEvent({ type: 'pointerdown', clientX: x, clientY: y, button: 0, pointerId: 1 });
          c2.dispatchEvent({ type: 'pointerup', clientX: x, clientY: y, button: 0, pointerId: 1 });
        };

        // 3a. Live app.mjs draw_poly 2 clicks + dblclick clean no-op (zero error toast, pieces unchanged)
        const piecesBefore = st.pattern.pieces.length;
        st.activeTool = 'draw_poly';
        elements.get('btnFit2D').click();
        toastEl.textContent = '';
        toastEl.classList.remove('toast-error');
        clk2d(250, 250); clk2d(400, 250); clk2d(400, 250);
        c2.dispatchEvent({ type: 'dblclick', clientX: 400, clientY: 250, button: 0 });
        assert.equal(st.pattern.pieces.length, piecesBefore, '2 clicks + dblclick must not create piece');
        assert.equal(toastEl.classList.contains('toast-error'), false, '2 clicks + dblclick must not raise toast-error');
        appMod.cad2D.clearPen();

        // 3b. Live app.mjs draw_poly double-click triangle -> 3 vertices, #btnQuickUnfold passes on ALL 3 edges
        clk2d(300, 300); clk2d(500, 300); clk2d(400, 460); clk2d(400, 460);
        c2.dispatchEvent({ type: 'dblclick', clientX: 400, clientY: 460, button: 0 });
        assert.equal(st.pattern.pieces.length, piecesBefore + 1);
        const createdTri = st.pattern.pieces[st.pattern.pieces.length - 1];
        assert.equal(createdTri.points.length, 3, 'live draw_poly double-click triangle must have 3 vertices');
        assert.equal(toastEl.classList.contains('toast-error'), false);

        for (let eIdx = 0; eIdx < 3; eIdx++) {
          st.selectedPieceId = createdTri.id;
          st.selectedEdgeIndex = eIdx;
          toastEl.textContent = '';
          toastEl.classList.remove('toast-error');
          elements.get('btnQuickUnfold').click();
          assert.equal(toastEl.classList.contains('toast-error'), false, `#btnQuickUnfold must succeed on edge ${eIdx}`);
          const unfolded = st.pattern.pieces.find((p) => p.id === createdTri.id);
          assert.equal(unfolded.points.length, 4, `unfolding triangle across edge ${eIdx} yields 4 vertices`);
          elements.get('btnUndo').click();
        }

        // 3c. OBS-I24-01: #btnExportSVG with nested layout and 0 placements shows warning toast while preserving HTTP 200 /api/export
        const ovSq = core.createRectanglePiece('OversizeSq', 800, 800, { id: 'i24_ovsq', seamAllowance: 0 });
        st.pattern = { id: 'i24_obs_pat', name: 'ObsPat', unit: 'mm', pieces: [ovSq], seams: [] };
        st.selectedPieceId = ovSq.id;
        st.nestingOptions.rollPreset = 'custom';
        st.nestingOptions.fabricWidthMm = 200;
        elements.get('exportLayoutSelect').value = 'nested';

        exportStatuses.length = 0;
        downloadedBlobs = 0;
        toastEl.textContent = '';
        toastEl.classList.remove('toast-error');
        elements.get('btnExportSVG').click();
        const waitExp0 = Date.now() + 5000;
        while ((exportStatuses.length < 1 || !toastEl.textContent) && Date.now() < waitExp0) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(exportStatuses[0], 200, 'POST /api/export remains HTTP 200');
        assert.equal(downloadedBlobs, 1);
        assert.equal(toastEl.classList.contains('toast-error'), true, '0-placement nested export must surface warning toast');
        assert.match(toastEl.textContent, /0 pieces fit|unfitted/i);
        assert.equal(toastEl.textContent.includes('Exported 1:1 SVG'), false);

        // Partial fit (1 placed, 1 unfitted) notes unfitted count clearly
        const smSq = core.createRectanglePiece('SmallSq', 100, 100, { id: 'i24_smsq', seamAllowance: 0 });
        st.pattern = { id: 'i24_obs_partial', name: 'ObsPartial', unit: 'mm', pieces: [smSq, ovSq], seams: [] };
        exportStatuses.length = 0;
        downloadedBlobs = 0;
        toastEl.textContent = '';
        toastEl.classList.remove('toast-error');
        elements.get('btnExportSVG').click();
        const waitExp1 = Date.now() + 5000;
        while ((exportStatuses.length < 1 || !toastEl.textContent) && Date.now() < waitExp1) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(exportStatuses[0], 200);
        assert.equal(downloadedBlobs, 1);
        assert.equal(toastEl.classList.contains('toast-error'), false);
        assert.match(toastEl.textContent, /1 placed,\s*1 unfitted/i);
      } finally {
        globalThis.document = prevGlobals.document;
        globalThis.window = prevGlobals.window;
        globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
        globalThis.ImageData = prevGlobals.ImageData;
        globalThis.fetch = prevGlobals.fetch;
        globalThis.URL = prevGlobals.URL;
      }
    } finally {
      await closeStudioServer(srv);
    }
  }
});

