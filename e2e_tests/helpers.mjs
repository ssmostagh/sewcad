import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// Workspace Constants & V1 Isolation Baseline
// ============================================================================

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const V2_ROOT = path.resolve(E2E_DIR, '..');
export const WORKSPACE_ROOT = path.resolve(V2_ROOT, '..');
export const V1_ROOT = path.join(WORKSPACE_ROOT, 'pattern_studio');

export const WEDGE_ASSEMBLED_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_assembled_view.stl');
export const WEDGE_PRINT_READY_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_print_ready.stl');
export const WEDGE_SCAD = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge.scad');

export const V1_BASELINE_SHA256 = Object.freeze({
  'README.md': 'f4d78326562c535e9141e1355cf93358ae2f9b8b8d8c3159d87492160b56185d',
  'package.json': 'e2b7cb69539b422e53a365a7a95a9dbb56044d5e1db820b6ba813f8dbbac7af7',
  'public/app.mjs': '585b4eb49424f854e175c598059f647c42fcdc713ed234fcb8501b956c93137a',
  'public/index.html': '06281e60042762998ef8af47e31065215b606c93f948dbe91f18611450418626',
  'public/styles.css': '7d95c4d6e2ba894c6e7a4a73095670c500dafabf0540d37d1e80c521b938ab1c',
  'src/cli.mjs': '5c7c3a95193b4bddee2de5ae0ea834cb1a0e384e85eec3d8ee6cb7ca13768a1c',
  'src/core/exporters.mjs': '34ce69050509b796ebae9da776d89fe6577d42f66bebce2f214ef8376847e087',
  'src/core/geometry.mjs': '3c8c8f9a91ce31902ab1ade73ae2806bd989309400315a1b8c1235286d1d6dc2',
  'src/core/index.mjs': 'fd729b0427b879170feb56d660abd0e7ccc1b54b4b2f573a125b8cd0ca2e4d9c',
  'src/core/materials.mjs': 'e2f70917070da666fb9706bb2d05cc74d83aaa188fb717ac13ad2bbe2967f59f',
  'src/core/nesting.mjs': 'a3684c275965f226b8c252b7dd5b25a88cf0b89fc2a1305c1081a4a2b858ea6f',
  'src/core/physics.mjs': 'aa49e77656f8665b705150c3c7bc1995fd0b7374f91c46b6612fb52cf43b7072',
  'src/core/stl.mjs': '1f6631e1608b376e24f48a7eca6eeeb183706717ee9aa2c83ea20f6457bebe1e',
  'src/core/templates.mjs': '548ecf651784f984f4c0da72bbfb841088b63f54dbd0354452a651b3ae27a9f6',
  'src/server.mjs': 'bdf1e06e7650c1b35e421f3a5861eccd37ad760d52c548ad5da40cda47547f41',
  'test/studio.test.mjs': 'ecd9b1d8c7585eff6fe298080eb3a13ac18b9359a57d32b3214d2bec0d1f0408',
});

// ============================================================================
// Assertions & Temp Directory
// ============================================================================

export function assert(cond, msg = 'Assertion failed') {
  if (!cond) {
    throw new Error(typeof msg === 'function' ? msg() : String(msg));
  }
}

export function assertNear(actual, expected, tol = 1e-6, msg = '') {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new Error(`${msg ? `${msg}: ` : ''}expected finite number near ${expected}, got ${actual}`);
  }
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    throw new Error(`${msg ? `${msg}: ` : ''}expected reference must be finite, got ${expected}`);
  }
  const diff = Math.abs(actual - expected);
  if (diff > tol) {
    throw new Error(
      `${msg ? `${msg}: ` : ''}expected ${expected} ± ${tol}, got ${actual} (diff=${diff})`
    );
  }
}

export async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psv2-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// Lazy Core Loader (Never Top-Level Import)
// ============================================================================

let _cachedCore = null;

export async function loadCore() {
  if (_cachedCore) return _cachedCore;
  const entryPath = path.join(V2_ROOT, 'src', 'core', 'index.mjs');
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Core module not found at ${entryPath} (implementation not yet present)`);
  }
  const mod = await import(pathToFileURL(entryPath).href);
  _cachedCore = mod;
  return mod;
}

// ============================================================================
// Server & CLI Process Helpers
// ============================================================================

export async function startTestServer({
  host,
  port = 0,
  env = {},
  extraArgs = [],
  timeoutMs = 10000,
} = {}) {
  const serverPath = path.join(V2_ROOT, 'src', 'server.mjs');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Server entry not found at ${serverPath}`);
  }

  const args = [serverPath, `--port=${port ?? 0}`];
  if (host !== undefined) args.push(`--host=${host}`);
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  const child = spawn(process.execPath, args, {
    cwd: V2_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let detectedPort = null;
  let settled = false;

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  };

  await new Promise((resolve, reject) => {
    let settleTimer = null;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop().finally(() =>
        reject(
          new Error(
            `Server failed to start within ${timeoutMs}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
          )
        )
      );
    }, timeoutMs);

    const tryDetect = () => {
      if (settled) return;
      const combined = `${stdoutBuf}\n${stderrBuf}`;
      // Prefer explicit Local URL or any http://<host>:<port>
      const mLocal = combined.match(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\]):(\d+)/i);
      const mAny = combined.match(/https?:\/\/[^\s:]+:(\d+)/i);
      const match = mLocal || mAny;
      if (match) {
        const p = Number.parseInt(match[1], 10);
        if (Number.isFinite(p) && p > 0) {
          detectedPort = p;
          if (!settleTimer) {
            // Brief settle window so all startup banner lines (Local/Remote/SSH) flush to stdout
            settleTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutTimer);
              resolve();
            }, 80);
          }
          if (/ssh\s+-/i.test(combined)) {
            clearTimeout(settleTimer);
            settled = true;
            clearTimeout(timeoutTimer);
            resolve();
          }
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      tryDetect();
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      tryDetect();
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      reject(err);
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      reject(
        new Error(
          `Server exited prematurely (code=${code}, signal=${signal}).\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
        )
      );
    });
  });

  const connectHost = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const baseUrl = `http://${connectHost}:${detectedPort}`;

  const doFetch = async (pathname, init = {}) => {
    const target = pathname.startsWith('http://') || pathname.startsWith('https://')
      ? pathname
      : `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    const opts = { ...init };
    const headers = new Headers(opts.headers || {});
    if (
      opts.body !== undefined &&
      opts.body !== null &&
      typeof opts.body === 'object' &&
      !Buffer.isBuffer(opts.body) &&
      !(opts.body instanceof Uint8Array) &&
      !(opts.body instanceof ArrayBuffer) &&
      typeof opts.body !== 'string'
    ) {
      opts.body = JSON.stringify(opts.body);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
    opts.headers = headers;
    return fetch(target, opts);
  };

  const fetchJson = async (pathname, init = {}) => {
    const res = await doFetch(pathname, init);
    const text = await res.text();
    let data = null;
    let parseError = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      parseError = err.message;
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data,
      json: data,
      body: data,
      text,
      parseError,
    };
  };

  const fetchText = async (pathname, init = {}) => {
    const res = await doFetch(pathname, init);
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      data: text,
    };
  };

  const fetchBuffer = async (pathname, init = {}) => {
    const res = await doFetch(pathname, init);
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buffer,
      data: buffer,
    };
  };

  return {
    port: detectedPort,
    baseUrl,
    url: baseUrl,
    child,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    get stdout() {
      return stdoutBuf;
    },
    get stderr() {
      return stderrBuf;
    },
    fetchJson,
    fetchText,
    fetchBuffer,
    stop,
  };
}

export async function runCli(args = [], { cwd, env = {}, timeoutMs = 30000, input } = {}) {
  const cliPath = path.join(V2_ROOT, 'src', 'cli.mjs');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry not found at ${cliPath}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: cwd ?? V2_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`CLI timed out after ${timeoutMs}ms: node src/cli.mjs ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.once('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });

    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// ============================================================================
// Independent Pure-JS Geometric Oracles (Zero src/core Imports)
// ============================================================================

function ptXY(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]) };
  return { x: Number(p.x), y: Number(p.y) };
}

function ptXYZ(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
  return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
}

export function dist2DIndependent(a, b) {
  const pa = ptXY(a);
  const pb = ptXY(b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

export function shoelaceSignedArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = ptXY(pts[i]);
    const b = ptXY(pts[(i + 1) % pts.length]);
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

export function shoelaceArea(pts) {
  return Math.abs(shoelaceSignedArea(pts));
}

export function calcBounds(pts) {
  if (!Array.isArray(pts) || pts.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const raw of pts) {
    const p = ptXY(raw);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function polylinePerimeter(pts, closed = true) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += dist2DIndependent(pts[i], pts[i + 1]);
  }
  if (closed && pts.length > 2) {
    total += dist2DIndependent(pts[pts.length - 1], pts[0]);
  }
  return total;
}

export function convexHull2DIndependent(pts) {
  if (!Array.isArray(pts) || pts.length === 0) return [];
  const sorted = pts
    .map(ptXY)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

  const unique = [];
  for (const p of sorted) {
    if (
      unique.length === 0 ||
      Math.hypot(p.x - unique[unique.length - 1].x, p.y - unique[unique.length - 1].y) > 1e-9
    ) {
      unique.push(p);
    }
  }
  if (unique.length <= 2) return unique;

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function segmentsIntersectIndependent(a1Raw, a2Raw, b1Raw, b2Raw, eps = 1e-9) {
  const a1 = ptXY(a1Raw);
  const a2 = ptXY(a2Raw);
  const b1 = ptXY(b1Raw);
  const b2 = ptXY(b2Raw);

  if (
    Math.max(a1.x, a2.x) + eps < Math.min(b1.x, b2.x) ||
    Math.max(b1.x, b2.x) + eps < Math.min(a1.x, a2.x) ||
    Math.max(a1.y, a2.y) + eps < Math.min(b1.y, b2.y) ||
    Math.max(b1.y, b2.y) + eps < Math.min(a1.y, a2.y)
  ) {
    return false;
  }

  const cross = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const onSeg = (p, q, r) =>
    q.x <= Math.max(p.x, r.x) + eps &&
    q.x >= Math.min(p.x, r.x) - eps &&
    q.y <= Math.max(p.y, r.y) + eps &&
    q.y >= Math.min(p.y, r.y) - eps;

  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);

  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    return true;
  }

  if (Math.abs(d1) <= eps && onSeg(a1, b1, a2)) return true;
  if (Math.abs(d2) <= eps && onSeg(a1, b2, a2)) return true;
  if (Math.abs(d3) <= eps && onSeg(b1, a1, b2)) return true;
  if (Math.abs(d4) <= eps && onSeg(b1, a2, b2)) return true;

  return false;
}

export function countSelfIntersections(pts, eps = 1e-6) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const cleaned = [];
  for (const raw of pts) {
    const p = ptXY(raw);
    if (cleaned.length === 0 || dist2DIndependent(p, cleaned[cleaned.length - 1]) > eps) {
      cleaned.push(p);
    }
  }
  if (cleaned.length > 2 && dist2DIndependent(cleaned[0], cleaned[cleaned.length - 1]) <= eps) {
    cleaned.pop();
  }
  const n = cleaned.length;
  if (n < 3) return 0;

  let count = 0;
  for (let i = 0; i < n; i++) {
    const a1 = cleaned[i];
    const a2 = cleaned[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const b1 = cleaned[j];
      const b2 = cleaned[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        // Adjacent edges only self-intersect if they fold collinearly back over each other
        const v1x = a2.x - a1.x;
        const v1y = a2.y - a1.y;
        const v2x = b2.x - b1.x;
        const v2y = b2.y - b1.y;
        const len1 = Math.hypot(v1x, v1y);
        const len2 = Math.hypot(v2x, v2y);
        if (len1 > eps && len2 > eps) {
          const crossNorm = Math.abs(v1x * v2y - v1y * v2x) / (len1 * len2);
          const dot = v1x * v2x + v1y * v2y;
          if (crossNorm <= 1e-6 && dot < 0) {
            count++;
          }
        }
        continue;
      }
      if (segmentsIntersectIndependent(a1, a2, b1, b2, eps)) {
        count++;
      }
    }
  }
  return count;
}

export function evalQuadBezierIndependent(p0Raw, cpRaw, p1Raw, t) {
  const p0 = ptXY(p0Raw);
  const cp = ptXY(cpRaw);
  const p1 = ptXY(p1Raw);
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y,
  };
}

export function evalCubicBezierIndependent(p0Raw, cp1Raw, cp2Raw, p1Raw, t) {
  const p0 = ptXY(p0Raw);
  const cp1 = ptXY(cp1Raw);
  const cp2 = ptXY(cp2Raw);
  const p1 = ptXY(p1Raw);
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t2 * t * p1.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t2 * t * p1.y,
  };
}

export function sampleCubicArcLengthIndependent(p0, cp1, cp2, p1, n = 64) {
  const steps = Math.max(2, n | 0);
  let prev = ptXY(p0);
  let len = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cur = cp2
      ? evalCubicBezierIndependent(p0, cp1, cp2, p1, t)
      : cp1
        ? evalQuadBezierIndependent(p0, cp1, p1, t)
        : {
            x: prev.x + (ptXY(p1).x - ptXY(p0).x) * (1 / steps),
            y: prev.y + (ptXY(p1).y - ptXY(p0).y) * (1 / steps),
          };
    len += dist2DIndependent(prev, cur);
    prev = cur;
  }
  return len;
}

export function samplePieceOutlineIndependent(piece, curveSegments = 32) {
  if (!piece || !Array.isArray(piece.points) || piece.points.length < 3) {
    return [];
  }
  const pts = piece.points.map(ptXY);
  const edges = Array.isArray(piece.edges) ? piece.edges : [];
  const n = pts.length;
  const out = [];
  const segs = Math.max(4, curveSegments | 0);

  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const curve = edges[i]?.curve;
    if (curve && curve.cp1 && curve.cp2) {
      for (let s = 0; s < segs; s++) {
        out.push(evalCubicBezierIndependent(p0, curve.cp1, curve.cp2, p1, s / segs));
      }
    } else if (curve && curve.cp) {
      for (let s = 0; s < segs; s++) {
        out.push(evalQuadBezierIndependent(p0, curve.cp, p1, s / segs));
      }
    } else {
      out.push({ x: p0.x, y: p0.y });
    }
  }
  return out;
}

export function buildSeamConnectivity(pattern) {
  const pieces = Array.isArray(pattern?.pieces) ? pattern.pieces : [];
  const seams = Array.isArray(pattern?.seams) ? pattern.seams : [];
  const adjacency = new Map();
  const pieceIds = pieces.map((p) => p.id);
  const pieceSet = new Set(pieceIds);

  for (const id of pieceIds) {
    adjacency.set(id, new Set());
  }

  for (const seam of seams) {
    const a = seam?.pieceA;
    const b = seam?.pieceB;
    if (!a || !b || !pieceSet.has(a) || !pieceSet.has(b)) continue;
    if (a === b) continue; // self-seam does not connect piece to other pieces
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }

  const visited = new Set();
  const components = [];
  for (const id of pieceIds) {
    if (visited.has(id)) continue;
    const comp = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift();
      comp.push(cur);
      for (const nxt of adjacency.get(cur) || []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    components.push(comp);
  }

  const isolatedPieceIds = pieceIds.filter((id) => (adjacency.get(id)?.size ?? 0) === 0);
  const connectedPieceIds = new Set(pieceIds.filter((id) => (adjacency.get(id)?.size ?? 0) > 0));
  const isFullyConnected =
    pieceIds.length <= 1 ? true : components.length === 1 && isolatedPieceIds.length === 0;

  return {
    components,
    componentCount: components.length,
    connectedPieceIds,
    isolatedPieceIds,
    isFullyConnected,
    adjacency,
  };
}

// ============================================================================
// Independent Pure-JS STL & 3D Geometry Oracles
// ============================================================================

function computeTriangleMetrics(triangles) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let surfaceAreaMm2 = 0;
  let signedVol6 = 0;

  for (const tri of triangles) {
    const a = tri[0];
    const b = tri[1];
    const c = tri[2];
    for (const v of [a, b, c]) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    surfaceAreaMm2 += 0.5 * Math.hypot(cx, cy, cz);

    const bxcX = b.y * c.z - b.z * c.y;
    const bxcY = b.z * c.x - b.x * c.z;
    const bxcZ = b.x * c.y - b.y * c.x;
    signedVol6 += a.x * bxcX + a.y * bxcY + a.z * bxcZ;
  }

  if (triangles.length === 0) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  return {
    bounds: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    },
    surfaceAreaMm2,
    signedVolumeMm3: signedVol6 / 6,
  };
}

export function parseAsciiSTLIndependent(text) {
  if (typeof text !== 'string') {
    throw new Error('parseAsciiSTLIndependent requires a string');
  }
  const vertexRegex = /^[ \t]*vertex[ \t]+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)[ \t]+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)[ \t]+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/gim;
  const vertices = [];
  let m;
  while ((m = vertexRegex.exec(text)) !== null) {
    vertices.push({
      x: Number.parseFloat(m[1]),
      y: Number.parseFloat(m[2]),
      z: Number.parseFloat(m[3]),
    });
  }
  const triangles = [];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    triangles.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
  }
  const metrics = computeTriangleMetrics(triangles);
  return {
    format: 'ascii',
    triangleCount: triangles.length,
    triangles,
    vertices,
    ...metrics,
  };
}

export function parseBinarySTLHeaderInfo(bufOrArrayBuffer) {
  let u8;
  if (Buffer.isBuffer(bufOrArrayBuffer)) {
    u8 = bufOrArrayBuffer;
  } else if (bufOrArrayBuffer instanceof ArrayBuffer) {
    u8 = new Uint8Array(bufOrArrayBuffer);
  } else if (ArrayBuffer.isView(bufOrArrayBuffer)) {
    u8 = new Uint8Array(
      bufOrArrayBuffer.buffer,
      bufOrArrayBuffer.byteOffset,
      bufOrArrayBuffer.byteLength
    );
  } else {
    throw new Error('parseBinarySTLHeaderInfo requires Buffer, TypedArray, or ArrayBuffer');
  }

  const byteLength = u8.byteLength;
  if (byteLength < 84) {
    return {
      validHeader: false,
      headerText: Buffer.from(u8).toString('ascii').replace(/\0+$/, ''),
      startsWithSolid: false,
      triangleCount: 0,
      byteLength,
      expectedByteLength: 84,
      matchesLength: false,
      triangles: [],
      bounds: computeTriangleMetrics([]).bounds,
      surfaceAreaMm2: 0,
      signedVolumeMm3: 0,
    };
  }

  const headerText = Buffer.from(u8.subarray(0, 80)).toString('ascii').replace(/\0+$/, '');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const triangleCount = dv.getUint32(80, true);
  const expectedByteLength = 84 + triangleCount * 50;
  const matchesLength = byteLength === expectedByteLength;

  const triangles = [];
  if (matchesLength) {
    for (let i = 0; i < triangleCount; i++) {
      const base = 84 + i * 50;
      // skip 12-byte normal at base..base+11
      const v0 = {
        x: dv.getFloat32(base + 12, true),
        y: dv.getFloat32(base + 16, true),
        z: dv.getFloat32(base + 20, true),
      };
      const v1 = {
        x: dv.getFloat32(base + 24, true),
        y: dv.getFloat32(base + 28, true),
        z: dv.getFloat32(base + 32, true),
      };
      const v2 = {
        x: dv.getFloat32(base + 36, true),
        y: dv.getFloat32(base + 40, true),
        z: dv.getFloat32(base + 44, true),
      };
      triangles.push([v0, v1, v2]);
    }
  }

  const metrics = computeTriangleMetrics(triangles);
  return {
    validHeader: true,
    headerText,
    startsWithSolid: /^solid\b/i.test(headerText.trimStart()),
    triangleCount,
    byteLength,
    expectedByteLength,
    matchesLength,
    triangles,
    ...metrics,
  };
}

function defaultCubeTriangles(size = 20) {
  const s = size / 2;
  const p = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  const idx = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [2, 3, 7], [2, 7, 6], // back
    [1, 2, 6], [1, 6, 5], // right
    [3, 0, 4], [3, 4, 7], // left
  ];
  return idx.map(([a, b, c]) => [p[a], p[b], p[c]]);
}

export function createSyntheticBinarySTLWithSolidHeader(
  triangles = defaultCubeTriangles(20),
  headerText = 'solid synthetic binary stl for E01 disambiguation'
) {
  const tris = Array.isArray(triangles) ? triangles : defaultCubeTriangles(20);
  const buf = Buffer.alloc(84 + tris.length * 50, 0);
  buf.write(headerText.slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);

  for (let i = 0; i < tris.length; i++) {
    const tri = tris[i];
    const a = ptXYZ(Array.isArray(tri) ? tri[0] : (tri.v0 ?? tri.a));
    const b = ptXYZ(Array.isArray(tri) ? tri[1] : (tri.v1 ?? tri.b));
    const c = ptXYZ(Array.isArray(tri) ? tri[2] : (tri.v2 ?? tri.c));

    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    const off = 84 + i * 50;
    buf.writeFloatLE(nx, off);
    buf.writeFloatLE(ny, off + 4);
    buf.writeFloatLE(nz, off + 8);
    buf.writeFloatLE(a.x, off + 12);
    buf.writeFloatLE(a.y, off + 16);
    buf.writeFloatLE(a.z, off + 20);
    buf.writeFloatLE(b.x, off + 24);
    buf.writeFloatLE(b.y, off + 28);
    buf.writeFloatLE(b.z, off + 32);
    buf.writeFloatLE(c.x, off + 36);
    buf.writeFloatLE(c.y, off + 40);
    buf.writeFloatLE(c.z, off + 44);
    buf.writeUInt16LE(0, off + 48);
  }
  return buf;
}

// Exponent-separated 106-bit double-double (DD) arithmetic for cancellation-free
// 3D geometry across the full IEEE-754 float64 dynamic range (subnormals to 1e308,
// including mixed extreme exponents and 1e200 x 1e-200 off-origin offsets).
const DD_ZERO = Object.freeze({ h: 0, l: 0, exp: 0 });

function twoSum(a, b) {
  const s = a + b;
  const v = s - a;
  return [s, (a - (s - v)) + (b - v)];
}

function twoProd(a, b) {
  const p = a * b;
  const ca = 134217729 * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = 134217729 * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

function ddAdd(a0, a1, b0, b1) {
  const [s0, t0] = twoSum(a0, b0);
  const [s1, t1] = twoSum(a1, b1);
  const [hi, lo] = twoSum(s0, t0 + s1);
  return twoSum(hi, lo + t1);
}

function ddMul(a0, a1, b0, b1) {
  const [p0, p1] = twoProd(a0, b0);
  return twoSum(p0, p1 + (a0 * b1 + a1 * b0));
}

function ddDiv(a0, a1, b0, b1) {
  const q1 = a0 / b0;
  const [p0, p1] = ddMul(q1, 0, b0, b1);
  const [r0, r1] = ddAdd(a0, a1, -p0, -p1);
  const q2 = (r0 + r1) / b0;
  return twoSum(q1, q2);
}

function ddSqrt(a0, a1) {
  if (!(a0 > 0)) return [0, 0];
  const x0 = Math.sqrt(a0);
  const [s0, s1] = twoProd(x0, x0);
  const [r0, r1] = ddAdd(a0, a1, -s0, -s1);
  const x1 = (r0 + r1) / (2 * x0);
  return twoSum(x0, x1);
}

function mulPow2(val, exp) {
  if (exp === 0 || val === 0 || !Number.isFinite(exp)) return val;
  if (exp >= -1020 && exp <= 1020) return val * (2 ** exp);
  let v = val;
  let rem = exp;
  while (rem > 1020) {
    v *= 2 ** 512;
    rem -= 512;
    if (!Number.isFinite(v)) return v;
  }
  while (rem < -1020) {
    v *= 2 ** -512;
    rem += 512;
    if (v === 0) return 0;
  }
  return v * (2 ** rem);
}

function toDDScalar(val) {
  if (!Number.isFinite(val) || val === 0) return DD_ZERO;
  const e = Math.floor(Math.log2(Math.abs(val)));
  return { h: mulPow2(val, -e), l: 0, exp: e };
}

function ddNormExp(h, l, exp) {
  const [nh, nl] = twoSum(h, l);
  if (nh === 0 || !Number.isFinite(nh)) return DD_ZERO;
  const e = Math.floor(Math.log2(Math.abs(nh)));
  if (e === 0) return { h: nh, l: nl, exp };
  return { h: mulPow2(nh, -e), l: mulPow2(nl, -e), exp: exp + e };
}

function ddNegExp(a) {
  if (a.h === 0) return DD_ZERO;
  return { h: -a.h, l: -a.l, exp: a.exp };
}

function ddAddExp(a, b) {
  if (a.h === 0) return b;
  if (b.h === 0) return a;
  if (a.exp < b.exp) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const diff = a.exp - b.exp;
  if (diff > 130) return a;
  const [sh, sl] = ddAdd(a.h, a.l, mulPow2(b.h, -diff), mulPow2(b.l, -diff));
  return ddNormExp(sh, sl, a.exp);
}

function ddSubExp(a, b) {
  return ddAddExp(a, ddNegExp(b));
}

function ddMulExp(a, b) {
  if (a.h === 0 || b.h === 0) return DD_ZERO;
  const [ph, pl] = ddMul(a.h, a.l, b.h, b.l);
  return ddNormExp(ph, pl, a.exp + b.exp);
}

function ddDivExp(a, b) {
  if (a.h === 0 || b.h === 0) return DD_ZERO;
  const [qh, ql] = ddDiv(a.h, a.l, b.h, b.l);
  return ddNormExp(qh, ql, a.exp - b.exp);
}

function ddSqrtExp(a) {
  if (!(a.h > 0)) return DD_ZERO;
  if ((a.exp & 1) !== 0) {
    const [sh, sl] = ddSqrt(2 * a.h, 2 * a.l);
    return ddNormExp(sh, sl, (a.exp - 1) / 2);
  }
  const [sh, sl] = ddSqrt(a.h, a.l);
  return ddNormExp(sh, sl, a.exp / 2);
}

function ddCmpMagExp(a, b) {
  if (a.h === 0 && b.h === 0) return 0;
  if (a.h === 0) return -1;
  if (b.h === 0) return 1;
  if (a.exp !== b.exp) return a.exp - b.exp;
  const ma = Math.abs(a.h);
  const mb = Math.abs(b.h);
  if (ma !== mb) return ma - mb;
  return Math.abs(a.l) - Math.abs(b.l);
}

function ddMaxTermExp(a, b) {
  if (a.h === 0) return b;
  if (b.h === 0) return a;
  return ddCmpMagExp(a, b) >= 0 ? a : b;
}

function ddScalarToNumber(s) {
  if (s.h === 0) return 0;
  const sum = s.h + s.l;
  if (sum === 0) return 0;
  if (s.exp > 1025) return sum >= 0 ? Infinity : -Infinity;
  if (s.exp < -1080) return 0;
  return mulPow2(sum, s.exp);
}

function clampCoordFromDD(s) {
  const v = ddScalarToNumber(s);
  if (Number.isFinite(v)) return v;
  return s.h >= 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function exactDiffDDVec(v1, v0) {
  return {
    x: ddSubExp(toDDScalar(v1.x), toDDScalar(v0.x)),
    y: ddSubExp(toDDScalar(v1.y), toDDScalar(v0.y)),
    z: ddSubExp(toDDScalar(v1.z), toDDScalar(v0.z)),
  };
}

function ddSum3Exp(t0, t1, t2) {
  // Add the two largest-magnitude terms first so cancelling pairs don't swallow a tiny third term.
  let a = t0, b = t1, c = t2;
  if (ddCmpMagExp(a, b) < 0) { const t = a; a = b; b = t; }
  if (ddCmpMagExp(b, c) < 0) { const t = b; b = c; c = t; }
  if (ddCmpMagExp(a, b) < 0) { const t = a; a = b; b = t; }
  return ddAddExp(ddAddExp(a, b), c);
}

function ddDotExp(u, v) {
  return ddSum3Exp(
    ddMulExp(u.x, v.x),
    ddMulExp(u.y, v.y),
    ddMulExp(u.z, v.z)
  );
}

function ddCrossExp(u, v) {
  return {
    x: ddSubExp(ddMulExp(u.y, v.z), ddMulExp(u.z, v.y)),
    y: ddSubExp(ddMulExp(u.z, v.x), ddMulExp(u.x, v.z)),
    z: ddSubExp(ddMulExp(u.x, v.y), ddMulExp(u.y, v.x)),
  };
}

function ddNormVecExp(v) {
  return ddSqrtExp(ddDotExp(v, v));
}

function ddMaxDotTermExp(vp, nDD) {
  const tx = ddMulExp(vp.x, nDD.x);
  const ty = ddMulExp(vp.y, nDD.y);
  const tz = ddMulExp(vp.z, nDD.z);
  return ddMaxTermExp(ddMaxTermExp(tx, ty), tz);
}

function closestPointOnSegment3D(p, s0, s1) {
  const seg = exactDiffDDVec(s1, s0);
  const ap = exactDiffDDVec(p, s0);
  const seg2 = ddDotExp(seg, seg);
  if (!(seg2.h > 0)) {
    return { x: s0.x, y: s0.y, z: s0.z, distance: ddScalarToNumber(ddNormVecExp(ap)) };
  }
  const bp = exactDiffDDVec(p, s1);
  const ap2 = ddDotExp(ap, ap);
  const bp2 = ddDotExp(bp, bp);
  // Measure from the closer endpoint so |s0| >> |p - s1| does not absorb p into -s0.
  const apSmaller = ddCmpMagExp(ap2, bp2) <= 0;

  const origin = apSmaller ? s0 : s1;
  const other = apSmaller ? s1 : s0;
  const vp = apSmaller ? ap : bp;
  const vp2 = apSmaller ? ap2 : bp2;
  const otherVp2 = apSmaller ? bp2 : ap2;
  const segDir = apSmaller ? seg : { x: ddNegExp(seg.x), y: ddNegExp(seg.y), z: ddNegExp(seg.z) };

  const dot = ddDotExp(vp, segDir);
  if (!(dot.h > 0)) {
    return { x: origin.x, y: origin.y, z: origin.z, distance: ddScalarToNumber(ddSqrtExp(vp2)) };
  }

  const tDD = ddDivExp(dot, seg2);
  const tVal = ddScalarToNumber(tDD);
  if (!Number.isFinite(tVal) || tVal >= 1) {
    return { x: other.x, y: other.y, z: other.z, distance: ddScalarToNumber(ddSqrtExp(otherVp2)) };
  }

  const qx = clampCoordFromDD(ddAddExp(toDDScalar(origin.x), ddMulExp(tDD, segDir.x)));
  const qy = clampCoordFromDD(ddAddExp(toDDScalar(origin.y), ddMulExp(tDD, segDir.y)));
  const qz = clampCoordFromDD(ddAddExp(toDDScalar(origin.z), ddMulExp(tDD, segDir.z)));

  // Compute perpendicular distance via 106-bit |segDir x vp| / |segDir| to avoid unit-direction cancellation.
  const cross = ddCrossExp(segDir, vp);
  const distDD = ddDivExp(ddNormVecExp(cross), ddSqrtExp(seg2));
  return { x: qx, y: qy, z: qz, distance: ddScalarToNumber(distDD) };
}

function closestPointOnTriangleEdges3D(p, a, b, c) {
  const c0 = closestPointOnSegment3D(p, a, b);
  const c1 = closestPointOnSegment3D(p, b, c);
  const c2 = closestPointOnSegment3D(p, c, a);
  let best = c0;
  if (c1.distance < best.distance) best = c1;
  if (c2.distance < best.distance) best = c2;
  return best;
}

function computeTriangleNormalDataDD(a, b, c) {
  const ab = exactDiffDDVec(b, a);
  const bc = exactDiffDDVec(c, b);
  const ca = exactDiffDDVec(a, c);
  const ab2 = ddDotExp(ab, ab);
  const bc2 = ddDotExp(bc, bc);
  const ca2 = ddDotExp(ca, ca);
  if (!(ab2.h > 0) || !(bc2.h > 0) || !(ca2.h > 0)) return null;

  const neg = (v) => ({ x: ddNegExp(v.x), y: ddNegExp(v.y), z: ddNegExp(v.z) });
  const pairs = [
    { u: ab, v: neg(ca), u2: ab2, v2: ca2 },
    { u: bc, v: neg(ab), u2: bc2, v2: ab2 },
    { u: ca, v: neg(bc), u2: ca2, v2: bc2 },
  ];

  // For each component k in {x, y, z}, select the cyclic vertex pair with smallest operand scale
  // to prevent catastrophic cancellation when one vertex dominates in mixed-exponent triangles.
  const bestComp = (getA1, getB2, getA2, getB1) => {
    let bestDiff = DD_ZERO;
    let bestScale = null;
    let bestRel = 0;
    for (const { u, v } of pairs) {
      const t1 = ddMulExp(getA1(u), getB2(v));
      const t2 = ddMulExp(getA2(u), getB1(v));
      const scale = ddMaxTermExp(t1, t2);
      const diff = ddSubExp(t1, t2);
      const rel = (scale.h !== 0 && diff.h !== 0)
        ? Math.abs(ddScalarToNumber(ddDivExp(diff, scale)))
        : 0;
      if (bestScale === null || ddCmpMagExp(scale, bestScale) < 0) {
        bestScale = scale;
        bestDiff = diff;
        bestRel = Number.isFinite(rel) ? rel : 0;
      }
    }
    return { diff: bestDiff, rel: bestRel };
  };

  const rx = bestComp((u) => u.y, (v) => v.z, (u) => u.z, (v) => v.y);
  const ry = bestComp((u) => u.z, (v) => v.x, (u) => u.x, (v) => v.z);
  const rz = bestComp((u) => u.x, (v) => v.y, (u) => u.y, (v) => v.x);

  const cross = { x: rx.diff, y: ry.diff, z: rz.diff };
  const c2 = ddDotExp(cross, cross);
  if (!(c2.h > 0)) return null;

  let maxSinSq = 0;
  for (const { u2, v2 } of pairs) {
    const s = ddScalarToNumber(ddDivExp(c2, ddMulExp(u2, v2)));
    if (Number.isFinite(s) && s > maxSinSq) maxSinSq = s;
  }
  const maxRelCross = Math.max(rx.rel, ry.rel, rz.rel);
  // Threshold 1e-24 resolves 106-bit needle triangles (e.g. sinSq ~ 1e-14) while rejecting
  // float64 collinearity rounding noise (~1e-32); relCross > 1e-12 preserves extreme mixed-exponent triangles.
  if (!(maxSinSq > 1e-24) && !(maxRelCross > 1e-12)) return null;

  return { ab, bc, ca, cross, c2 };
}

function isInsideTriangleEdgeDD(edd, vpE0, vpE1, nDD, d) {
  if (edd.x.h === 0 && edd.y.h === 0 && edd.z.h === 0) return false;
  const vpE0_2 = ddDotExp(vpE0, vpE0);
  const vpE1_2 = ddDotExp(vpE1, vpE1);
  const vp = ddCmpMagExp(vpE0_2, vpE1_2) <= 0 ? vpE0 : vpE1;
  if (vp.x.h === 0 && vp.y.h === 0 && vp.z.h === 0) return true;

  const vpPlane = {
    x: ddSubExp(vp.x, ddMulExp(d, nDD.x)),
    y: ddSubExp(vp.y, ddMulExp(d, nDD.y)),
    z: ddSubExp(vp.z, ddMulExp(d, nDD.z)),
  };
  if (vpPlane.x.h === 0 && vpPlane.y.h === 0 && vpPlane.z.h === 0) return true;

  const cross = ddCrossExp(edd, vpPlane);
  const total = ddDotExp(cross, nDD);
  return total.h >= 0;
}

export function closestPointOnTriangle3D(pRaw, aRaw, bRaw, cRaw) {
  const p = ptXYZ(pRaw);
  const a = ptXYZ(aRaw);
  const b = ptXYZ(bRaw);
  const c = ptXYZ(cRaw);

  const pa = exactDiffDDVec(p, a);
  const pb = exactDiffDDVec(p, b);
  const pc = exactDiffDDVec(p, c);
  const cands = [
    { v0: a, vp: pa, vp2: ddDotExp(pa, pa) },
    { v0: b, vp: pb, vp2: ddDotExp(pb, pb) },
    { v0: c, vp: pc, vp2: ddDotExp(pc, pc) },
  ];
  cands.sort((x, y) => ddCmpMagExp(x.vp2, y.vp2));

  if (cands[0].vp.x.h === 0 && cands[0].vp.y.h === 0 && cands[0].vp.z.h === 0) {
    return { x: cands[0].v0.x, y: cands[0].v0.y, z: cands[0].v0.z, distance: 0 };
  }

  const normalData = computeTriangleNormalDataDD(a, b, c);
  if (!normalData) {
    return closestPointOnTriangleEdges3D(p, a, b, c);
  }

  const cNorm = ddSqrtExp(normalData.c2);
  const nDD = {
    x: ddDivExp(normalData.cross.x, cNorm),
    y: ddDivExp(normalData.cross.y, cNorm),
    z: ddDivExp(normalData.cross.z, cNorm),
  };

  // Pick the vertex whose (p - v) · nDD has minimal max-term magnitude (least cancellation).
  let bestCand = cands[0];
  let bestMaxTerm = ddMaxDotTermExp(bestCand.vp, nDD);
  for (let i = 1; i < 3; i++) {
    const mt = ddMaxDotTermExp(cands[i].vp, nDD);
    if (ddCmpMagExp(mt, bestMaxTerm) < 0) {
      bestMaxTerm = mt;
      bestCand = cands[i];
    }
  }
  const vBest = bestCand.v0;
  const vpBest = bestCand.vp;
  const d = ddDotExp(vpBest, nDD);

  if (!isInsideTriangleEdgeDD(normalData.ab, pa, pb, nDD, d) ||
      !isInsideTriangleEdgeDD(normalData.bc, pb, pc, nDD, d) ||
      !isInsideTriangleEdgeDD(normalData.ca, pc, pa, nDD, d)) {
    return closestPointOnTriangleEdges3D(p, a, b, c);
  }

  const qx = clampCoordFromDD(
    Math.abs(p.x) <= Math.abs(vBest.x)
      ? ddSubExp(toDDScalar(p.x), ddMulExp(d, nDD.x))
      : ddAddExp(toDDScalar(vBest.x), ddSubExp(vpBest.x, ddMulExp(d, nDD.x)))
  );
  const qy = clampCoordFromDD(
    Math.abs(p.y) <= Math.abs(vBest.y)
      ? ddSubExp(toDDScalar(p.y), ddMulExp(d, nDD.y))
      : ddAddExp(toDDScalar(vBest.y), ddSubExp(vpBest.y, ddMulExp(d, nDD.y)))
  );
  const qz = clampCoordFromDD(
    Math.abs(p.z) <= Math.abs(vBest.z)
      ? ddSubExp(toDDScalar(p.z), ddMulExp(d, nDD.z))
      : ddAddExp(toDDScalar(vBest.z), ddSubExp(vpBest.z, ddMulExp(d, nDD.z)))
  );
  const dist = Math.abs(ddScalarToNumber(d));

  const edgeBest = closestPointOnTriangleEdges3D(p, a, b, c);
  if (edgeBest.distance < dist) {
    return edgeBest;
  }
  return { x: qx, y: qy, z: qz, distance: dist };
}

export function pointToTriangleDist3D(p, a, b, c) {
  return closestPointOnTriangle3D(p, a, b, c).distance;
}

// ============================================================================
// Python Independent Export Validator Bridge
// ============================================================================

export async function verifyExportWithPython(format, contentOrBuffer, expectations = {}) {
  const fmt = String(format || '').toLowerCase();
  if (!['svg', 'pdf', 'dxf'].includes(fmt)) {
    throw new Error(`Unsupported verifyExportWithPython format: ${format}`);
  }

  return withTempDir(async (dir) => {
    const exportPath = path.join(dir, `export.${fmt}`);
    const expPath = path.join(dir, 'expectations.json');
    const verifierPath = path.join(E2E_DIR, 'verify_exports.py');

    if (typeof contentOrBuffer === 'string') {
      await fsp.writeFile(exportPath, contentOrBuffer, 'utf8');
    } else if (
      Buffer.isBuffer(contentOrBuffer) ||
      contentOrBuffer instanceof Uint8Array
    ) {
      await fsp.writeFile(exportPath, contentOrBuffer);
    } else if (contentOrBuffer instanceof ArrayBuffer) {
      await fsp.writeFile(exportPath, Buffer.from(contentOrBuffer));
    } else {
      throw new Error(`verifyExportWithPython expected string or binary buffer, got ${typeof contentOrBuffer}`);
    }

    await fsp.writeFile(expPath, JSON.stringify(expectations ?? {}), 'utf8');

    const res = await new Promise((resolve) => {
      execFile(
        'python3',
        [verifierPath, '--format', fmt, '--file', exportPath, '--expectations', expPath],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
        (error, stdout, stderr) => {
          resolve({ error, stdout, stderr });
        }
      );
    });

    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      throw new Error(
        `verify_exports.py did not return valid JSON (${res.error?.message ?? 'exit non-zero'}).\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
      );
    }

    if (!report.ok && !expectations.allowFail) {
      const err = new Error(
        `Export verification failed (${fmt}): ${(report.errors || []).join(' | ')}`
      );
      err.report = report;
      throw err;
    }

    return report;
  });
}

// ============================================================================
// Headless Chrome CDP Detection & Full UI Check (Node v24 WebSocket)
// ============================================================================

export function detectChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  // Also probe PATH via `which` synchronously if available
  for (const binName of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir, binName));
    }
  }

  for (const cand of candidates) {
    try {
      const real = fs.realpathSync(cand);
      if (fs.existsSync(real) && fs.statSync(real).isFile()) {
        fs.accessSync(real, fs.constants.X_OK);
        return real;
      }
    } catch {
      // dangling symlink, ENOENT, directory, or non-executable -> continue
    }
  }

  throw new Error(
    'BROWSER_UNAVAILABLE: No executable Chrome/Chromium binary found (checked CHROME_BIN, /opt/google/chrome/google-chrome, /usr/bin/google-chrome-stable, /usr/bin/google-chrome, /usr/bin/chromium, /usr/bin/chromium-browser, PATH); /opt may be unmounted in sandbox or Chrome not installed'
  );
}

export async function runChromeCDPCheck(url, options = {}) {
  const chromeBin = detectChromeBinary();
  const timeoutMs = options.timeoutMs ?? 20000;

  return withTempDir(async (tmpDir) => {
    const chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-sandbox',
        '--enable-webgl',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--remote-debugging-port=0',
        `--user-data-dir=${tmpDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stderrBuf = '';
    let cdpPort = null;
    let ws = null;
    let cleanupCdp = null;

    try {
      cdpPort = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Chrome CDP did not start within 10s. stderr:\n${stderrBuf}`));
        }, 10000);

        chrome.stderr.on('data', (chunk) => {
          stderrBuf += chunk.toString('utf8');
          const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number.parseInt(m[1], 10));
          }
        });

        chrome.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        chrome.once('close', (code) => {
          clearTimeout(timer);
          reject(new Error(`Chrome exited prematurely (${code}). stderr:\n${stderrBuf}`));
        });
      });

      let targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      let pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!pageTarget) {
        pageTarget = await (
          await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })
        ).json();
      }
      assert(pageTarget?.webSocketDebuggerUrl, 'No Chrome CDP page target webSocketDebuggerUrl');

      ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('CDP WebSocket open timeout'));
        }, 5000);
        ws.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
        ws.addEventListener('error', (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket error: ${e.message || 'unknown'}`));
        }, { once: true });
        ws.addEventListener('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('CDP WebSocket closed before open'));
        }, { once: true });
      });

      let nextId = 1;
      const pending = new Map();
      const consoleErrors = [];
      const pageErrors = [];
      const logErrors = [];
      const eventWaiters = [];
      let docStatus = null;
      const apiRequests = new Map();
      const apiResponses = [];
      const apiFailures = [];
      let wsClosedErr = null;

      const rejectAllInflight = (err) => {
        if (!wsClosedErr) wsClosedErr = err;
        for (const [id, entry] of pending.entries()) {
          pending.delete(id);
          entry.reject(err);
        }
        while (eventWaiters.length > 0) {
          const w = eventWaiters.pop();
          w.reject(err);
        }
      };
      const closeWsSafely = () => {
        try {
          if (
            ws.readyState === globalThis.WebSocket.CONNECTING ||
            ws.readyState === globalThis.WebSocket.OPEN
          ) {
            ws.close();
          }
        } catch {
          // ignore
        }
      };
      cleanupCdp = () => rejectAllInflight(wsClosedErr || new Error('CDP session closed'));

      ws.addEventListener('close', () => {
        rejectAllInflight(wsClosedErr || new Error('CDP WebSocket closed'));
      });
      ws.addEventListener('error', (e) => {
        rejectAllInflight(new Error(`CDP WebSocket error: ${e?.message || 'unknown'}`));
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch (err) {
          rejectAllInflight(new Error(`Invalid CDP JSON message: ${err.message}`));
          closeWsSafely();
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          rejectAllInflight(new Error('Invalid CDP JSON message: expected JSON object'));
          closeWsSafely();
          return;
        }
        try {
          if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) {
              const errCode = typeof msg.error === 'object' ? msg.error.code : undefined;
              const errMsg = typeof msg.error === 'object' ? msg.error.message : String(msg.error);
              reject(new Error(`CDP ${errCode}: ${errMsg}`));
            } else {
              resolve(msg.result);
            }
            return;
          }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            const rawArgs = msg.params?.args;
            consoleErrors.push(
              Array.isArray(rawArgs)
                ? rawArgs
                    .map((a) =>
                      a && typeof a === 'object'
                        ? (a.value ?? a.description ?? '')
                        : String(a ?? '')
                    )
                    .join(' ')
                : String(rawArgs ?? '')
            );
          } else if (msg.method === 'Runtime.exceptionThrown') {
            const det = msg.params?.exceptionDetails;
            const desc =
              det && typeof det === 'object'
                ? (det.exception && typeof det.exception === 'object'
                    ? det.exception.description
                    : undefined) ?? det.text
                : undefined;
            pageErrors.push(String(desc || 'Uncaught exception'));
          } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
            logErrors.push(String(msg.params?.entry?.text || 'Log error'));
          } else if (msg.method === 'Network.requestWillBeSent') {
            const reqId = msg.params?.requestId;
            const reqUrl = msg.params?.request?.url;
            if (reqId && typeof reqUrl === 'string') {
              apiRequests.set(reqId, reqUrl);
            }
          } else if (msg.method === 'Network.responseReceived') {
            const resp = msg.params?.response;
            if (msg.params?.type === 'Document' && docStatus === null) {
              docStatus = resp && typeof resp === 'object' ? (resp.status ?? null) : null;
            }
            if (typeof resp?.url === 'string' && resp.url.includes('/api/')) {
              apiResponses.push({ url: resp.url, status: resp.status });
            }
          } else if (msg.method === 'Network.loadingFailed') {
            const reqId = msg.params?.requestId;
            const reqUrl = reqId ? apiRequests.get(reqId) : null;
            if (typeof reqUrl === 'string' && reqUrl.includes('/api/')) {
              apiFailures.push({
                url: reqUrl,
                errorText: msg.params?.errorText || 'loadingFailed',
                canceled: Boolean(msg.params?.canceled),
              });
            }
          }
          for (let i = eventWaiters.length - 1; i >= 0; i--) {
            const w = eventWaiters[i];
            if (w.method === msg.method) {
              eventWaiters.splice(i, 1);
              w.resolve(msg.params);
            }
          }
        } catch (err) {
          rejectAllInflight(err instanceof Error ? err : new Error(String(err)));
          closeWsSafely();
        }
      });

      const cdpCall = (method, params = {}) => {
        if (wsClosedErr) return Promise.reject(wsClosedErr);
        if (ws.readyState !== globalThis.WebSocket.OPEN) {
          return Promise.reject(new Error(`CDP WebSocket is not open (readyState=${ws.readyState})`));
        }
        return new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP call timeout: ${method}`));
          }, timeoutMs);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(err);
          }
        });
      };

      const waitForEvent = (method, ms = 10000) => {
        if (wsClosedErr) return Promise.reject(wsClosedErr);
        if (ws.readyState !== globalThis.WebSocket.OPEN) {
          return Promise.reject(new Error(`CDP WebSocket is not open (readyState=${ws.readyState})`));
        }
        return new Promise((resolve, reject) => {
          const waiter = {
            method,
            timer: null,
            resolve: (params) => {
              clearTimeout(waiter.timer);
              resolve(params);
            },
            reject: (err) => {
              clearTimeout(waiter.timer);
              reject(err);
            },
          };
          waiter.timer = setTimeout(() => {
            const idx = eventWaiters.indexOf(waiter);
            if (idx !== -1) eventWaiters.splice(idx, 1);
            reject(new Error(`CDP event timeout: ${method}`));
          }, ms);
          eventWaiters.push(waiter);
        });
      };

      const evalJS = async (expression) => {
        const r = await cdpCall('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r?.exceptionDetails) {
          throw new Error(
            `Page eval exception: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`
          );
        }
        return r?.result?.value;
      };

      await cdpCall('Page.enable');
      await cdpCall('Runtime.enable');
      await cdpCall('Log.enable');
      await cdpCall('Network.enable');

      // Ensure WebGL/WebGL2 retains its drawing buffer for readPixels inspection and tracks draw calls
      await cdpCall('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          window.__psv2WebGLDraws = 0;
          window.__psv2WebGLContexts = 0;
          const origGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type, opts) {
            if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
              const merged = Object.assign({}, opts || {}, { preserveDrawingBuffer: true });
              const ctx = origGetContext.call(this, type, merged);
              if (ctx && !ctx.__psv2Wrapped) {
                ctx.__psv2Wrapped = true;
                window.__psv2WebGLContexts += 1;
                for (const fnName of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
                  if (typeof ctx[fnName] === 'function') {
                    const origDraw = ctx[fnName].bind(ctx);
                    ctx[fnName] = function() {
                      window.__psv2WebGLDraws += 1;
                      return origDraw.apply(this, arguments);
                    };
                  }
                }
              }
              return ctx;
            }
            return origGetContext.call(this, type, opts);
          };
        })();`,
      });

      const loadPromise = waitForEvent('Page.loadEventFired', Math.min(15000, timeoutMs));
      loadPromise.catch(() => {});
      await cdpCall('Page.navigate', { url });
      await loadPromise;

      assert(docStatus === 200, `Expected document HTTP 200, got ${docStatus}`);

      // Poll deterministically until initial async boot (catalog + initial tshirt render) completes
      const bootDeadline = Date.now() + Math.min(5000, timeoutMs);
      let domCheck = null;
      let lastBootErr = null;
      while (Date.now() < bootDeadline) {
        if (wsClosedErr) throw wsClosedErr;
        if (ws.readyState !== globalThis.WebSocket.OPEN) {
          throw new Error(`CDP WebSocket is not open (readyState=${ws.readyState})`);
        }
        try {
          domCheck = await evalJS(`(() => {
            const canvases = Array.from(document.querySelectorAll('canvas'));
            const sized = canvases.filter(c => c.width > 0 && c.height > 0);
            const tplSel = document.querySelector('#templateSelect');
            const pieceOpts = document.querySelectorAll('#pieceSelectDropdown option').length;
            const stlOpts = document.querySelectorAll('#workspaceStlSelect option').length;
            const webglContexts = window.__psv2WebGLContexts || 0;
            const webglDraws = window.__psv2WebGLDraws || 0;
            const renderReady = webglContexts === 0 || webglDraws > 0;
            return {
              title: document.title,
              readyState: document.readyState,
              canvasCount: canvases.length,
              sizedCanvasCount: sized.length,
              bodyTextLen: document.body.innerText.trim().length,
              templateValue: tplSel ? tplSel.value : '',
              pieceOpts,
              stlOpts,
              webglContexts,
              webglDraws,
              bootReady: Boolean(
                document.readyState === 'complete' &&
                sized.length >= 2 &&
                document.body.innerText.trim().length > 0 &&
                (!tplSel || tplSel.value === 'bodice_sloper' || tplSel.value === 'tshirt') &&
                pieceOpts >= 4 &&
                stlOpts > 0 &&
                renderReady
              ),
            };
          })()`);
          lastBootErr = null;
          if (domCheck && domCheck.bootReady === true) {
            break;
          }
        } catch (err) {
          const msg = String(err?.message || err);
          if (
            /Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(
              msg
            ) &&
            !wsClosedErr
          ) {
            lastBootErr = msg;
          } else {
            throw err;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(
        domCheck && domCheck.sizedCanvasCount >= 2,
        `Expected >=2 sized canvases (2D+3D), got ${JSON.stringify(domCheck)}${lastBootErr ? ` (${lastBootErr})` : ''}`
      );
      assert(
        domCheck.bootReady === true,
        `Initial studio boot did not complete within 5000ms: ${JSON.stringify(domCheck)}${lastBootErr ? ` (${lastBootErr})` : ''}`
      );

      // Switch template (select or button) and verify non-<option> DOM / canvas / API change
      const tplApiStartIdx = apiResponses.length;
      const templateSwitch = await evalJS(`(async () => {
        const visibleNonOptionText = () => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const p = node.parentElement;
              if (!p) return NodeFilter.FILTER_REJECT;
              if (p.closest('option, script, style, noscript')) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          const blockSel = 'address,article,aside,blockquote,dd,details,dialog,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul';
          const parts = [];
          let prevBlock = null;
          let cur;
          while ((cur = walker.nextNode())) {
            const t = (cur.nodeValue || '').replace(/\\s+/g, ' ').trim();
            if (!t) continue;
            const p = cur.parentElement;
            const block = (p && typeof p.closest === 'function' && p.closest(blockSel)) || document.body;
            if (parts.length > 0) {
              parts.push(block !== prevBlock ? '\\n' : ' ');
            }
            parts.push(t);
            prevBlock = block;
          }
          return parts.join('').replace(/[ \\t\\r\\f\\v]+/g, ' ').replace(/ *\\n */g, '\\n').replace(/\\n+/g, '\\n').trim();
        };
        const canvas2dSig = () => {
          const c = document.querySelector('#canvas2D') || Array.from(document.querySelectorAll('canvas')).find(cv => {
            if (cv.width <= 0 || cv.height <= 0) return false;
            return Boolean(cv.getContext('2d'));
          });
          if (!c) return '';
          try {
            return c.toDataURL();
          } catch {
            return c.width + 'x' + c.height;
          }
        };

        const stripTplEcho = (s) =>
          String(s || '')
            .replace(
              /(?:\\b(?:selected|active|loaded|current|template|preset|starter\\s+block|block)(?:\\s+(?:template|block|preset))?\\s*[:=\\u2013\\u2014-][ \\t]*|\\bswitched\\s+to(?:\\s*[:=\\u2013\\u2014-][ \\t]*|[ \\t]+))?(?:(?:2\\.\\s*)?pullover\\s+hood(?:ie)?|hoodie)\\s*(?:(?:[+/&:\\u2013\\u2014-]|,|\\bwith\\b)\\s*|\\(\\s*(?:with\\s+)?)\\b(?:front|back|sleeves?|(?:2[-\\s]panel\\s+(?:contoured\\s+)?)?hood(?!\\s*(?:\\((?:left|right)\\)|(?:crown|side|panel|left|right)\\b))|(?:ribbed(?:\\s+|_))?waistband|(?:a\\s+)?kangaroo(?:(?:\\s+|_)[a-z0-9]+){0,5}(?:\\s+|_)pocket)\\b(?:(?:\\s*,\\s*(?:(?:&|\\+|and\\b)\\s*)?|\\s*[+/&:\\u2013\\u2014\\/-]\\s*|\\s+\\b(?:and|with)\\b\\s+|\\s*\\(\\s*(?:with\\s+)?)\\b(?:front|back|sleeves?|(?:2[-\\s]panel\\s+(?:contoured\\s+)?)?hood(?!\\s*(?:\\((?:left|right)\\)|(?:crown|side|panel|left|right)\\b))|(?:ribbed(?:\\s+|_))?waistband|(?:a\\s+)?kangaroo(?:(?:\\s+|_)[a-z0-9]+){0,5}(?:\\s+|_)pocket)\\b)*(?:\\s*\\))?/gi,
              ' '
            )
            .replace(
              /(?:\\b(?:selected|active|loaded|current|template|preset|starter\\s+block|block)(?:\\s+(?:template|block|preset))?\\s*[:=\\u2013\\u2014-][ \\t]*|\\bswitched\\s+to(?:\\s*[:=\\u2013\\u2014-][ \\t]*|[ \\t]+))(?:(?:(?:2\\.\\s*)?pullover\\s+hood(?:ie)?|hood(?:ie)?)(?:\\((?:(?!(?:front|back)\\s+bodice|(?:left|right)\\s+sleeve|\\bhood\\s+(?:crown|side|panel|left|right)|\\bhood\\b|\\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\\b|\\bkangaroo|\\bribbed|\\bwaistband|\\bpieces?\\s*[:=\\u2013\\u2014-])[^()\\n|;])*\\)|(?:(?!(?:front|back)\\s+bodice|(?:left|right)\\s+sleeve|\\bhood\\s+(?:crown|side|panel|left|right)|\\bhood\\b|\\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\\b|\\bkangaroo|\\bribbed|\\bwaistband|\\bpieces?\\s*[:=\\u2013\\u2014-])[^|\\n;]))*|(?:\\((?:(?!(?:front|back)\\s+bodice|(?:left|right)\\s+sleeve|\\bhood\\s+(?:crown|side|panel|left|right)|\\bhood\\b|\\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\\b|\\bkangaroo|\\bribbed|\\bwaistband|\\bpieces?\\s*[:=\\u2013\\u2014-])[^()\\n|;])*\\)|(?:(?!(?:front|back)\\s+bodice|(?:left|right)\\s+sleeve|\\bhood\\s+(?:crown|side|panel|left|right)|\\bhood\\b|\\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\\b|\\bkangaroo|\\bribbed|\\bwaistband|\\bpieces?\\s*[:=\\u2013\\u2014-])[^|\\n;]))*)/gi,
              ' '
            )
            .replace(/(?:2\\.\\s*)?pullover\\s+hood(?:ie)?/gi, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
        const hoodiePatterns = [
          /\\bhood\\b/i,
          /\\bhood\\s+(?:crown|side|panel|left|right)\\b/i,
          /\\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\\b/i,
          /\\bkangaroo(?:(?:\\s+|_)[a-z0-9]+){0,5}(?:\\s+|_)pocket\\b/i,
          /\\bribbed(?:_|\\s+)waistband\\b/i,
          /\\bwaistband(?:_|\\s+)rib\\b/i,
        ];
        const hasNewHoodieText = (before, after) => {
          const b = stripTplEcho(before);
          const a = stripTplEcho(after);
          return hoodiePatterns.some((re) => !re.test(b) && re.test(a));
        };

        const beforeNonOptionText = visibleNonOptionText();
        const beforeSig = canvas2dSig();
        const sel = Array.from(document.querySelectorAll('select')).find(s =>
          Array.from(s.options).some(o => o.value === 'hoodie')
        );
        const btn = sel ? null : Array.from(document.querySelectorAll('button')).find(b =>
          /hoodie/i.test((b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || ''))
        );
        if (!sel && !btn) {
          return {
            controlFound: false,
            stateChanged: false,
            canvasChanged: false,
            hoodieTextAdded: false,
            beforeNonOptionText,
            afterNonOptionText: beforeNonOptionText,
          };
        }

        if (sel) {
          sel.value = 'hoodie';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          btn.click();
        }

        let afterNonOptionText = beforeNonOptionText;
        let afterSig = beforeSig;
        let stateChanged = false;
        let canvasChanged = false;
        let hoodieTextAdded = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
          afterNonOptionText = visibleNonOptionText();
          afterSig = canvas2dSig();
          if (afterSig && afterSig !== beforeSig) {
            canvasChanged = true;
          }
          hoodieTextAdded = hasNewHoodieText(beforeNonOptionText, afterNonOptionText);
          if (afterNonOptionText !== beforeNonOptionText || canvasChanged) {
            stateChanged = true;
            if (canvasChanged || hoodieTextAdded) {
              break;
            }
          }
        }
        return {
          controlFound: true,
          method: sel ? 'select' : 'button',
          stateChanged,
          canvasChanged,
          hoodieTextAdded,
          beforeNonOptionText,
          afterNonOptionText,
        };
      })()`);
      const stripTplEchoNode = (s) =>
        String(s || '')
          .replace(
            /(?:\b(?:selected|active|loaded|current|template|preset|starter\s+block|block)(?:\s+(?:template|block|preset))?\s*[:=\u2013\u2014-][ \t]*|\bswitched\s+to(?:\s*[:=\u2013\u2014-][ \t]*|[ \t]+))?(?:(?:2\.\s*)?pullover\s+hood(?:ie)?|hoodie)\s*(?:(?:[+/&:\u2013\u2014-]|,|\bwith\b)\s*|\(\s*(?:with\s+)?)\b(?:front|back|sleeves?|(?:2[-\s]panel\s+(?:contoured\s+)?)?hood(?!\s*(?:\((?:left|right)\)|(?:crown|side|panel|left|right)\b))|(?:ribbed(?:\s+|_))?waistband|(?:a\s+)?kangaroo(?:(?:\s+|_)[a-z0-9]+){0,5}(?:\s+|_)pocket)\b(?:(?:\s*,\s*(?:(?:&|\+|and\b)\s*)?|\s*[+/&:\u2013\u2014\/-]\s*|\s+\b(?:and|with)\b\s+|\s*\(\s*(?:with\s+)?)\b(?:front|back|sleeves?|(?:2[-\s]panel\s+(?:contoured\s+)?)?hood(?!\s*(?:\((?:left|right)\)|(?:crown|side|panel|left|right)\b))|(?:ribbed(?:\s+|_))?waistband|(?:a\s+)?kangaroo(?:(?:\s+|_)[a-z0-9]+){0,5}(?:\s+|_)pocket)\b)*(?:\s*\))?/gi,
            ' '
          )
          .replace(
            /(?:\b(?:selected|active|loaded|current|template|preset|starter\s+block|block)(?:\s+(?:template|block|preset))?\s*[:=\u2013\u2014-][ \t]*|\bswitched\s+to(?:\s*[:=\u2013\u2014-][ \t]*|[ \t]+))(?:(?:(?:2\.\s*)?pullover\s+hood(?:ie)?|hood(?:ie)?)(?:\((?:(?!(?:front|back)\s+bodice|(?:left|right)\s+sleeve|\bhood\s+(?:crown|side|panel|left|right)|\bhood\b|\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\b|\bkangaroo|\bribbed|\bwaistband|\bpieces?\s*[:=\u2013\u2014-])[^()\n|;])*\)|(?:(?!(?:front|back)\s+bodice|(?:left|right)\s+sleeve|\bhood\s+(?:crown|side|panel|left|right)|\bhood\b|\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\b|\bkangaroo|\bribbed|\bwaistband|\bpieces?\s*[:=\u2013\u2014-])[^|\n;]))*|(?:\((?:(?!(?:front|back)\s+bodice|(?:left|right)\s+sleeve|\bhood\s+(?:crown|side|panel|left|right)|\bhood\b|\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\b|\bkangaroo|\bribbed|\bwaistband|\bpieces?\s*[:=\u2013\u2014-])[^()\n|;])*\)|(?:(?!(?:front|back)\s+bodice|(?:left|right)\s+sleeve|\bhood\s+(?:crown|side|panel|left|right)|\bhood\b|\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\b|\bkangaroo|\bribbed|\bwaistband|\bpieces?\s*[:=\u2013\u2014-])[^|\n;]))*)/gi,
            ' '
          )
          .replace(/(?:2\.\s*)?pullover\s+hood(?:ie)?/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const hoodiePatternsNode = [
        /\bhood\b/i,
        /\bhood\s+(?:crown|side|panel|left|right)\b/i,
        /\bhood_(?:left|right|crown|side|panel)(?:_(?:left|right|panel))?\b/i,
        /\bkangaroo(?:(?:\s+|_)[a-z0-9]+){0,5}(?:\s+|_)pocket\b/i,
        /\bribbed(?:_|\s+)waistband\b/i,
        /\bwaistband(?:_|\s+)rib\b/i,
      ];
      const hasNewHoodieTextNode = (before, after) => {
        const b = stripTplEchoNode(before);
        const a = stripTplEchoNode(after);
        return hoodiePatternsNode.some((re) => !re.test(b) && re.test(a));
      };
      const tplApiOk = apiResponses
        .slice(tplApiStartIdx)
        .some((r) => /\/api\/generate-template/i.test(r.url) && r.status >= 200 && r.status < 400);
      assert(templateSwitch && templateSwitch.controlFound === true, 'Template switch control for hoodie not found in UI');
      assert(
        templateSwitch.stateChanged === true || tplApiOk,
        `Template switch to hoodie produced no DOM/canvas or /api/generate-template state change: ${JSON.stringify(templateSwitch)}`
      );
      assert(
        tplApiOk ||
          templateSwitch.canvasChanged === true ||
          (templateSwitch.hoodieTextAdded === true &&
            hasNewHoodieTextNode(templateSwitch.beforeNonOptionText || '', templateSwitch.afterNonOptionText || '')),
        `Template switch to hoodie did not render hoodie pieces, update 2D canvas, or trigger /api/generate-template: ${JSON.stringify(templateSwitch)}`
      );

      // Trigger STL unwrap via UI control and verify real option + trigger + post-action update
      const stlApiStartIdx = apiResponses.length;
      const stlCheck = await evalJS(`(async () => {
        const visibleNonOptionText = () => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const p = node.parentElement;
              if (!p) return NodeFilter.FILTER_REJECT;
              if (p.closest('option, script, style, noscript')) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          const blockSel = 'address,article,aside,blockquote,dd,details,dialog,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul';
          const parts = [];
          let prevBlock = null;
          let cur;
          while ((cur = walker.nextNode())) {
            const t = (cur.nodeValue || '').replace(/\\s+/g, ' ').trim();
            if (!t) continue;
            const p = cur.parentElement;
            const block = (p && typeof p.closest === 'function' && p.closest(blockSel)) || document.body;
            if (parts.length > 0) {
              parts.push(block !== prevBlock ? '\\n' : ' ');
            }
            parts.push(t);
            prevBlock = block;
          }
          return parts.join('').replace(/[ \\t\\r\\f\\v]+/g, ' ').replace(/ *\\n */g, '\\n').replace(/\\n+/g, '\\n').trim();
        };
        const canvas2dSig = () => {
          const c = document.querySelector('#canvas2D') || Array.from(document.querySelectorAll('canvas')).find(cv => {
            if (cv.width <= 0 || cv.height <= 0) return false;
            return Boolean(cv.getContext('2d'));
          });
          if (!c) return '';
          try {
            return c.toDataURL();
          } catch {
            return c.width + 'x' + c.height;
          }
        };

        const stripStlEcho = (s) =>
          String(s || '')
            .replace(/cutting_mat_wedge_(?:assembled_view|print_ready)\\.stl\\b(?:(?:[ \\t]*[:=\\u2013\\u2014-][ \\t]*|[ \\t]+|[ \\t]*(?=\\())(?:(?!(?:\\b[1-9]\\d*(?:,\\d{3})*\\s*(?:tris|triangles|vertices|verts|faces)\\b|\\b(?:tris?|triangles?|vertices|verts|faces)\\s*[:=\\u2013\\u2014-]\\s*[1-9]\\d*(?:,\\d{3})*\\b|(?<!\\d(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*)(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*))?\\s*mm\\b(?!\\s*[×x]\\s*\\d)|\\bunwrapped\\b(?:\\s+(?:width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,24}(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*mm\\b|(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*cm(?:²(?!\\w)|2\\b)|(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%\\s*(?:\\(\\s*developable\\s*\\)|developable\\b)|\\b[1-9]\\d*\\s+developable\\s+(?:panels?|charts?)\\b|\\bdevelopable\\b\\s*[:=\\u2013\\u2014-]\\s*(?:true|yes|(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%?)|\\bdistortion\\s*[:=\\u2013\\u2014-]\\s*(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%|\\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\\b|(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\b|\\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\s*[:=\\u2013\\u2014-]\\s*0+(?:\\.0+)?(?![.\\d])|\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?\\b(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,16}(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*mm\\b|\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-]\\s*|\\s+)(?:0+(?:\\.0+)?(?![.\\d])\\s*mm|failed|error)\\b|\\b(?:failed|error)\\s+(?:to\\s+)?unwrap(?:p(?:ed|ing))?\\b|\\bdevelopable\\s*(?:[:=\\u2013\\u2014-]\\s*(?:false\\b|no\\b|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%?)|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%)|(?<![.\\d])0+(?:\\.0+)?%\\s*developable\\b|(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*cm(?:²(?!\\w)|2\\b)|(?<![.\\d])(?=\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?(?:(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?)?\\s*mm\\b)(?:0+(?:\\.0+)?(?![.\\d])(?:\\s*mm)?\\s*[×x]|\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*0+(?:\\.0+)?(?![.\\d])(?:\\s*mm\\b|(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?\\s*mm\\b)|(?:\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*){2}0+(?:\\.0+)?(?![.\\d])\\s*mm\\b)|\\b(?:triangles\\s*\\/\\s*vertices|tris?\\s*\\/\\s*verts?|bounding\\s+box|surface\\s+area|mean\\s+distortion)\\s*[:=\\u2013\\u2014-]\\s*(?:[-\\u2014\\u2013]+(?:\\s*\\/\\s*[-\\u2014\\u2013]+)?|n\\/a\\b|none\\b)(?=\\s|$|[|,;])))[^|\\n;])*)?/gi, ' ')
            .replace(/\\(\\s*built-in\\s+wedge\\s*\\)/gi, ' ')
            .replace(
              /(?:\\b(?:selected|active(?:\\s+3d)?|loaded|current|template|preset|stl|mode|strategy|unwrap\\s+mode|unwrapping\\s+strategy)(?:\\s+(?:stl|template|file|model|mode|strategy|preset))?\\s*[:=\\u2013\\u2014-][ \\t]*|\\bswitched\\s+to(?:\\s*[:=\\u2013\\u2014-][ \\t]*|[ \\t]+))(?:(?!(?:\\b[1-9]\\d*(?:,\\d{3})*\\s*(?:tris|triangles|vertices|verts|faces)\\b|\\b(?:tris?|triangles?|vertices|verts|faces)\\s*[:=\\u2013\\u2014-]\\s*[1-9]\\d*(?:,\\d{3})*\\b|(?<!\\d(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*)(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*))?\\s*mm\\b(?!\\s*[×x]\\s*\\d)|\\bunwrapped\\b(?:\\s+(?:width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,24}(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*mm\\b|(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*cm(?:²(?!\\w)|2\\b)|(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%\\s*(?:\\(\\s*developable\\s*\\)|developable\\b)|\\b[1-9]\\d*\\s+developable\\s+(?:panels?|charts?)\\b|\\bdevelopable\\b\\s*[:=\\u2013\\u2014-]\\s*(?:true|yes|(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%?)|\\bdistortion\\s*[:=\\u2013\\u2014-]\\s*(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%|\\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\\b|(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\b|\\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\s*[:=\\u2013\\u2014-]\\s*0+(?:\\.0+)?(?![.\\d])|\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?\\b(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,16}(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*mm\\b|\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-]\\s*|\\s+)(?:0+(?:\\.0+)?(?![.\\d])\\s*mm|failed|error)\\b|\\b(?:failed|error)\\s+(?:to\\s+)?unwrap(?:p(?:ed|ing))?\\b|\\bdevelopable\\s*(?:[:=\\u2013\\u2014-]\\s*(?:false\\b|no\\b|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%?)|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%)|(?<![.\\d])0+(?:\\.0+)?%\\s*developable\\b|(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*cm(?:²(?!\\w)|2\\b)|(?<![.\\d])(?=\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?(?:(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?)?\\s*mm\\b)(?:0+(?:\\.0+)?(?![.\\d])(?:\\s*mm)?\\s*[×x]|\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*0+(?:\\.0+)?(?![.\\d])(?:\\s*mm\\b|(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?\\s*mm\\b)|(?:\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*){2}0+(?:\\.0+)?(?![.\\d])\\s*mm\\b)|\\b(?:triangles\\s*\\/\\s*vertices|tris?\\s*\\/\\s*verts?|bounding\\s+box|surface\\s+area|mean\\s+distortion)\\s*[:=\\u2013\\u2014-]\\s*(?:[-\\u2014\\u2013]+(?:\\s*\\/\\s*[-\\u2014\\u2013]+)?|n\\/a\\b|none\\b)(?=\\s|$|[|,;])))[^|\\n;])*/gi,
              ' '
            )
            .replace(/(?:5\\.\\s*)?custom\\s+3d\\s+\\.?stl\\s+object\\s+cover/gi, ' ')
            .replace(/tailored\\s+form-shell\\s+cover\\s*\\(\\s*side\\s+profiles\\s*\\+\\s*wrap\\s+gussets\\s*\\)/gi, ' ')
            .replace(/multi-panel\\s+6-axis\\s+surface\\s+chart\\s+flattening/gi, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
        const stlOutputPatterns = [
          /\\b984\\b/,
          /\\b[1-9]\\d*(?:,\\d{3})*\\s*(?:tris|triangles|vertices|verts|faces)\\b/i,
          /\\b(?:tris?|triangles?|vertices|verts|faces)\\s*[:=\\u2013\\u2014-]\\s*[1-9]\\d*(?:,\\d{3})*\\b/i,
          /(?<!\\d(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*)(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)(?:(?:\\s*mm)?\\s*[×x]\\s*(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*))?\\s*mm\\b(?!\\s*[×x]\\s*\\d)/i,
          /\\bunwrapped\\b(?:\\s+(?:width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,24}(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*mm\\b/i,
          /(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)\\s*cm(?:²(?!\\w)|2\\b)/i,
          /(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%\\s*(?:\\(\\s*developable\\s*\\)|developable\\b)/i,
          /\\b[1-9]\\d*\\s+developable\\s+(?:panels?|charts?)\\b/i,
          /\\bdevelopable\\b\\s*[:=\\u2013\\u2014-]\\s*(?:true|yes|(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%?)/i,
          /\\bdistortion\\s*[:=\\u2013\\u2014-]\\s*(?<![.\\d])(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d*[1-9]\\d*)%/i,
          /\\b(?:wedge|cover|shell|side|base|stl)\\s+gussets?\\b/i,
          /\\b(?:shell|wedge|stl)\\s+cover\\s+(?:panel|piece|top|bottom|side|gusset)\\b/i,
          /\\b(?:surface|top|bottom|side|front|back|wedge)\\s+panels?\\b/i,
          /\\bwedge\\s+(?:shell|top|bottom|gusset|panel)\\b/i,
          /\\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\\b/i,
        ];
        const hasZeroStlMetric = (s) =>
          /(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\b/i.test(s) ||
          /\\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\\s+gussets?)\\s*[:=\\u2013\\u2014-]\\s*0+(?:\\.0+)?(?![.\\d])/i.test(s) ||
          /\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?\\b(?:\\s*[:=\\u2013\\u2014-])?[^|\\n;:]{0,16}(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*mm\\b/i.test(s) ||
          /\\bunwrap(?:p(?:ed|ing))?(?:\\s+(?:status|width|height|length|area|size))?(?:\\s*[:=\\u2013\\u2014-]\\s*|\\s+)(?:0+(?:\\.0+)?(?![.\\d])\\s*mm|failed|error)\\b/i.test(s) ||
          /\\b(?:failed|error)\\s+(?:to\\s+)?unwrap(?:p(?:ed|ing))?\\b/i.test(s) ||
          /\\bdevelopable\\s*(?:[:=\\u2013\\u2014-]\\s*(?:false\\b|no\\b|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%?)|\\(\\s*0+(?:\\.0+)?(?![.\\d])%\\s*\\)|0+(?:\\.0+)?(?![.\\d])%)/i.test(s) ||
          /(?<![.\\d])0+(?:\\.0+)?%\\s*developable\\b/i.test(s) ||
          /(?<![.\\d])0+(?:\\.0+)?(?![.\\d])\\s*cm(?:²(?!\\w)|2\\b)/i.test(s) ||
          /(?<![.\\d])(?=\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?(?:(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?)?\\s*mm\\b)(?:0+(?:\\.0+)?(?![.\\d])(?:\\s*mm)?\\s*[×x]|\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*0+(?:\\.0+)?(?![.\\d])(?:\\s*mm\\b|(?:\\s*mm)?\\s*[×x]\\s*\\d+(?:\\.\\d+)?\\s*mm\\b)|(?:\\d+(?:\\.\\d+)?(?:\\s*mm)?\\s*[×x]\\s*){2}0+(?:\\.0+)?(?![.\\d])\\s*mm\\b)/i.test(s) ||
          /\\b(?:triangles\\s*\\/\\s*vertices|tris?\\s*\\/\\s*verts?|bounding\\s+box|surface\\s+area|mean\\s+distortion)\\s*[:=\\u2013\\u2014-]\\s*(?:[-\\u2014\\u2013]+(?:\\s*\\/\\s*[-\\u2014\\u2013]+)?|n\\/a\\b|none\\b)(?=\\s|$|[|,;])/i.test(s);
        const hasNewStlOutput = (before, after) => {
          if (hasZeroStlMetric(after)) return false;
          const b = stripStlEcho(before);
          const a = stripStlEcho(after);
          if (hasZeroStlMetric(a)) return false;
          if (stlOutputPatterns.some((re) => !re.test(b) && re.test(a))) return true;
          return false;
        };

        const beforeNonOptionText = visibleNonOptionText();
        const beforeSig = canvas2dSig();
        const tplSel = Array.from(document.querySelectorAll('select')).find(s =>
          Array.from(s.options).some(o => o.value === 'stl_cover')
        );
        const beforeTplVal = tplSel ? tplSel.value : '';

        const opt = Array.from(document.querySelectorAll('select option')).find(o =>
          /cutting_mat_wedge_assembled_view\\.stl/i.test((o.value || '') + ' ' + (o.textContent || ''))
        );
        const unwrapBtn = Array.from(document.querySelectorAll('button')).find(b =>
          /unwrap|load.*stl|stl.*cover/i.test((b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || ''))
        );
        const optSelect = opt ? ((typeof opt.closest === 'function' && opt.closest('select')) || opt.parentElement) : null;
        const hasStlOption = Boolean(opt && optSelect);
        const hasUnwrapControl = Boolean(unwrapBtn || (opt && optSelect));
        if (!hasStlOption || !hasUnwrapControl) {
          return {
            hasStlOption,
            hasUnwrapControl,
            domUpdated: false,
            canvasChanged: false,
            unwrapOutputChanged: false,
            templateValue: beforeTplVal,
            beforeNonOptionText,
            afterNonOptionText: beforeNonOptionText,
          };
        }

        optSelect.value = opt.value;
        optSelect.dispatchEvent(new Event('change', { bubbles: true }));
        if (unwrapBtn) {
          unwrapBtn.click();
        }

        let domUpdated = false;
        let canvasChanged = false;
        let unwrapOutputChanged = false;
        let afterNonOptionText = beforeNonOptionText;
        let afterTplVal = beforeTplVal;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
          afterNonOptionText = visibleNonOptionText();
          const afterSig = canvas2dSig();
          afterTplVal = tplSel ? tplSel.value : '';
          if (afterSig && afterSig !== beforeSig) {
            canvasChanged = true;
          }
          unwrapOutputChanged = hasNewStlOutput(beforeNonOptionText, afterNonOptionText);
          if (canvasChanged || unwrapOutputChanged) {
            domUpdated = true;
            break;
          }
        }
        return {
          hasStlOption,
          hasUnwrapControl,
          domUpdated,
          canvasChanged,
          unwrapOutputChanged,
          templateValue: afterTplVal,
          textChanged: afterNonOptionText !== beforeNonOptionText,
          beforeNonOptionText,
          afterNonOptionText,
        };
      })()`);
      const stripStlEchoNode = (s) =>
        String(s || '')
          .replace(/cutting_mat_wedge_(?:assembled_view|print_ready)\.stl\b(?:(?:[ \t]*[:=\u2013\u2014-][ \t]*|[ \t]+|[ \t]*(?=\())(?:(?!(?:\b[1-9]\d*(?:,\d{3})*\s*(?:tris|triangles|vertices|verts|faces)\b|\b(?:tris?|triangles?|vertices|verts|faces)\s*[:=\u2013\u2014-]\s*[1-9]\d*(?:,\d{3})*\b|(?<!\d(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*)(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))?\s*mm\b(?!\s*[×x]\s*\d)|\bunwrapped\b(?:\s+(?:width|height|length|area|size))?(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,24}(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*mm\b|(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*cm(?:²(?!\w)|2\b)|(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%\s*(?:\(\s*developable\s*\)|developable\b)|\b[1-9]\d*\s+developable\s+(?:panels?|charts?)\b|\bdevelopable\b\s*[:=\u2013\u2014-]\s*(?:true|yes|(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%?)|\bdistortion\s*[:=\u2013\u2014-]\s*(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%|\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\b|(?<![.\d])0+(?:\.0+)?(?![.\d])\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\b|\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\s*[:=\u2013\u2014-]\s*0+(?:\.0+)?(?![.\d])|\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?\b(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,16}(?<![.\d])0+(?:\.0+)?(?![.\d])\s*mm\b|\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?(?:\s*[:=\u2013\u2014-]\s*|\s+)(?:0+(?:\.0+)?(?![.\d])\s*mm|failed|error)\b|\b(?:failed|error)\s+(?:to\s+)?unwrap(?:p(?:ed|ing))?\b|\bdevelopable\s*(?:[:=\u2013\u2014-]\s*(?:false\b|no\b|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%?)|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%)|(?<![.\d])0+(?:\.0+)?%\s*developable\b|(?<![.\d])0+(?:\.0+)?(?![.\d])\s*cm(?:²(?!\w)|2\b)|(?<![.\d])(?=\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?(?:(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?)?\s*mm\b)(?:0+(?:\.0+)?(?![.\d])(?:\s*mm)?\s*[×x]|\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*0+(?:\.0+)?(?![.\d])(?:\s*mm\b|(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?\s*mm\b)|(?:\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*){2}0+(?:\.0+)?(?![.\d])\s*mm\b)|\b(?:triangles\s*\/\s*vertices|tris?\s*\/\s*verts?|bounding\s+box|surface\s+area|mean\s+distortion)\s*[:=\u2013\u2014-]\s*(?:[-\u2014\u2013]+(?:\s*\/\s*[-\u2014\u2013]+)?|n\/a\b|none\b)(?=\s|$|[|,;])))[^|\n;])*)?/gi, ' ')
          .replace(/\(\s*built-in\s+wedge\s*\)/gi, ' ')
          .replace(
            /(?:\b(?:selected|active(?:\s+3d)?|loaded|current|template|preset|stl|mode|strategy|unwrap\s+mode|unwrapping\s+strategy)(?:\s+(?:stl|template|file|model|mode|strategy|preset))?\s*[:=\u2013\u2014-][ \t]*|\bswitched\s+to(?:\s*[:=\u2013\u2014-][ \t]*|[ \t]+))(?:(?!(?:\b[1-9]\d*(?:,\d{3})*\s*(?:tris|triangles|vertices|verts|faces)\b|\b(?:tris?|triangles?|vertices|verts|faces)\s*[:=\u2013\u2014-]\s*[1-9]\d*(?:,\d{3})*\b|(?<!\d(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*)(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))?\s*mm\b(?!\s*[×x]\s*\d)|\bunwrapped\b(?:\s+(?:width|height|length|area|size))?(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,24}(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*mm\b|(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*cm(?:²(?!\w)|2\b)|(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%\s*(?:\(\s*developable\s*\)|developable\b)|\b[1-9]\d*\s+developable\s+(?:panels?|charts?)\b|\bdevelopable\b\s*[:=\u2013\u2014-]\s*(?:true|yes|(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%?)|\bdistortion\s*[:=\u2013\u2014-]\s*(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%|\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\b|(?<![.\d])0+(?:\.0+)?(?![.\d])\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\b|\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\s*[:=\u2013\u2014-]\s*0+(?:\.0+)?(?![.\d])|\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?\b(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,16}(?<![.\d])0+(?:\.0+)?(?![.\d])\s*mm\b|\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?(?:\s*[:=\u2013\u2014-]\s*|\s+)(?:0+(?:\.0+)?(?![.\d])\s*mm|failed|error)\b|\b(?:failed|error)\s+(?:to\s+)?unwrap(?:p(?:ed|ing))?\b|\bdevelopable\s*(?:[:=\u2013\u2014-]\s*(?:false\b|no\b|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%?)|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%)|(?<![.\d])0+(?:\.0+)?%\s*developable\b|(?<![.\d])0+(?:\.0+)?(?![.\d])\s*cm(?:²(?!\w)|2\b)|(?<![.\d])(?=\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?(?:(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?)?\s*mm\b)(?:0+(?:\.0+)?(?![.\d])(?:\s*mm)?\s*[×x]|\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*0+(?:\.0+)?(?![.\d])(?:\s*mm\b|(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?\s*mm\b)|(?:\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*){2}0+(?:\.0+)?(?![.\d])\s*mm\b)|\b(?:triangles\s*\/\s*vertices|tris?\s*\/\s*verts?|bounding\s+box|surface\s+area|mean\s+distortion)\s*[:=\u2013\u2014-]\s*(?:[-\u2014\u2013]+(?:\s*\/\s*[-\u2014\u2013]+)?|n\/a\b|none\b)(?=\s|$|[|,;])))[^|\n;])*/gi,
            ' '
          )
          .replace(/(?:5\.\s*)?custom\s+3d\s+\.?stl\s+object\s+cover/gi, ' ')
          .replace(/tailored\s+form-shell\s+cover\s*\(\s*side\s+profiles\s*\+\s*wrap\s+gussets\s*\)/gi, ' ')
          .replace(/multi-panel\s+6-axis\s+surface\s+chart\s+flattening/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const stlOutputPatternsNode = [
        /\b984\b/,
        /\b[1-9]\d*(?:,\d{3})*\s*(?:tris|triangles|vertices|verts|faces)\b/i,
        /\b(?:tris?|triangles?|vertices|verts|faces)\s*[:=\u2013\u2014-]\s*[1-9]\d*(?:,\d{3})*\b/i,
        /(?<!\d(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*)(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:(?:\s*mm)?\s*[×x]\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))?\s*mm\b(?!\s*[×x]\s*\d)/i,
        /\bunwrapped\b(?:\s+(?:width|height|length|area|size))?(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,24}(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*mm\b/i,
        /(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*cm(?:²(?!\w)|2\b)/i,
        /(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%\s*(?:\(\s*developable\s*\)|developable\b)/i,
        /\b[1-9]\d*\s+developable\s+(?:panels?|charts?)\b/i,
        /\bdevelopable\b\s*[:=\u2013\u2014-]\s*(?:true|yes|(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%?)/i,
        /\bdistortion\s*[:=\u2013\u2014-]\s*(?<![.\d])(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%/i,
        /\b(?:wedge|cover|shell|side|base|stl)\s+gussets?\b/i,
        /\b(?:shell|wedge|stl)\s+cover\s+(?:panel|piece|top|bottom|side|gusset)\b/i,
        /\b(?:surface|top|bottom|side|front|back|wedge)\s+panels?\b/i,
        /\bwedge\s+(?:shell|top|bottom|gusset|panel)\b/i,
        /\b(?:wedge_(?:top|bottom|side|shell|panel|gusset)|surface_panel)\b/i,
      ];
      const hasZeroStlMetricNode = (s) =>
        /(?<![.\d])0+(?:\.0+)?(?![.\d])\s*(?:tris|triangles|vertices|verts|faces|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\b/i.test(s) ||
        /\b(?:tris?|triangles?|vertices|verts|faces|developable|(?:(?:developable|surface|top|bottom|side|front|back|wedge|cover|shell|stl|unwrapped|pattern|flat|generated)\s+){0,5}(?:pieces?|panels?|charts?)|(?:wedge|cover|shell|side|base|stl)\s+gussets?)\s*[:=\u2013\u2014-]\s*0+(?:\.0+)?(?![.\d])/i.test(s) ||
        /\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?\b(?:\s*[:=\u2013\u2014-])?[^|\n;:]{0,16}(?<![.\d])0+(?:\.0+)?(?![.\d])\s*mm\b/i.test(s) ||
        /\bunwrap(?:p(?:ed|ing))?(?:\s+(?:status|width|height|length|area|size))?(?:\s*[:=\u2013\u2014-]\s*|\s+)(?:0+(?:\.0+)?(?![.\d])\s*mm|failed|error)\b/i.test(s) ||
        /\b(?:failed|error)\s+(?:to\s+)?unwrap(?:p(?:ed|ing))?\b/i.test(s) ||
        /\bdevelopable\s*(?:[:=\u2013\u2014-]\s*(?:false\b|no\b|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%?)|\(\s*0+(?:\.0+)?(?![.\d])%\s*\)|0+(?:\.0+)?(?![.\d])%)/i.test(s) ||
        /(?<![.\d])0+(?:\.0+)?%\s*developable\b/i.test(s) ||
        /(?<![.\d])0+(?:\.0+)?(?![.\d])\s*cm(?:²(?!\w)|2\b)/i.test(s) ||
        /(?<![.\d])(?=\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?(?:(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?)?\s*mm\b)(?:0+(?:\.0+)?(?![.\d])(?:\s*mm)?\s*[×x]|\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*0+(?:\.0+)?(?![.\d])(?:\s*mm\b|(?:\s*mm)?\s*[×x]\s*\d+(?:\.\d+)?\s*mm\b)|(?:\d+(?:\.\d+)?(?:\s*mm)?\s*[×x]\s*){2}0+(?:\.0+)?(?![.\d])\s*mm\b)/i.test(s) ||
        /\b(?:triangles\s*\/\s*vertices|tris?\s*\/\s*verts?|bounding\s+box|surface\s+area|mean\s+distortion)\s*[:=\u2013\u2014-]\s*(?:[-\u2014\u2013]+(?:\s*\/\s*[-\u2014\u2013]+)?|n\/a\b|none\b)(?=\s|$|[|,;])/i.test(s);
      const hasNewStlOutputNode = (before, after) => {
        if (hasZeroStlMetricNode(after)) return false;
        const b = stripStlEchoNode(before);
        const a = stripStlEchoNode(after);
        if (hasZeroStlMetricNode(a)) return false;
        if (stlOutputPatternsNode.some((re) => !re.test(b) && re.test(a))) return true;
        return false;
      };
      const stlUnwrapApiOk = apiResponses
        .slice(stlApiStartIdx)
        .some((r) => /\/api\/(?:unwrap-stl|stl-content)/i.test(r.url) && r.status >= 200 && r.status < 400);
      const tplCoverApiOk = apiResponses
        .slice(stlApiStartIdx)
        .some((r) => /\/api\/generate-template/i.test(r.url) && r.status >= 200 && r.status < 400);
      assert(stlCheck && stlCheck.hasStlOption === true, 'Workspace STL option matching cutting_mat_wedge_assembled_view.stl not found in UI');
      assert(stlCheck.hasUnwrapControl === true, 'STL unwrap trigger control not found in UI');
      const stlOutputVerified =
        stlCheck.canvasChanged === true ||
        (stlCheck.unwrapOutputChanged === true &&
          hasNewStlOutputNode(stlCheck.beforeNonOptionText || '', stlCheck.afterNonOptionText || ''));
      assert(
        stlUnwrapApiOk || stlOutputVerified,
        `STL unwrap UI action produced neither /api/unwrap-stl|/api/stl-content 2xx nor 2D canvas/unwrapped output update (tplCoverApiOk=${tplCoverApiOk}): ${JSON.stringify(stlCheck)}`
      );

      // Check 3D canvas non-blank pixel variance across center + full-canvas stride / quadrants
      const canvas3dCheck = await evalJS(`(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => c.width > 0 && c.height > 0);
        const preferred3d = document.querySelector('#canvas3D');
        const ordered = preferred3d && canvases.includes(preferred3d)
          ? [preferred3d, ...canvases.filter(c => c !== preferred3d)]
          : canvases;

        for (const c of ordered) {
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          if (gl) {
            const colors = new Set();
            const collectBuf = (buf, stridePixels) => {
              const step = Math.max(4, stridePixels * 4);
              for (let i = 0; i < buf.length; i += step) {
                colors.add(buf[i] + ',' + buf[i + 1] + ',' + buf[i + 2] + ',' + buf[i + 3]);
              }
            };
            let readMethod = 'readPixels';
            try {
              const cw = Math.min(c.width, 320);
              const ch = Math.min(c.height, 320);
              const cx = Math.max(0, Math.floor((c.width - cw) / 2));
              const cy = Math.max(0, Math.floor((c.height - ch) / 2));
              const centerBuf = new Uint8Array(cw * ch * 4);
              gl.readPixels(cx, cy, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, centerBuf);
              collectBuf(centerBuf, 4);

              if (c.width * c.height <= 2500000) {
                const fullBuf = new Uint8Array(c.width * c.height * 4);
                gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, fullBuf);
                const stride = Math.max(1, Math.floor((c.width * c.height) / 16000));
                collectBuf(fullBuf, stride);
              } else {
                const qw = Math.min(c.width, 64);
                const qh = Math.min(c.height, 64);
                const qBuf = new Uint8Array(qw * qh * 4);
                for (const [qx, qy] of [
                  [Math.floor(c.width * 0.25 - qw / 2), Math.floor(c.height * 0.25 - qh / 2)],
                  [Math.floor(c.width * 0.75 - qw / 2), Math.floor(c.height * 0.25 - qh / 2)],
                  [Math.floor(c.width * 0.25 - qw / 2), Math.floor(c.height * 0.75 - qh / 2)],
                  [Math.floor(c.width * 0.75 - qw / 2), Math.floor(c.height * 0.75 - qh / 2)],
                ]) {
                  gl.readPixels(Math.max(0, qx), Math.max(0, qy), qw, qh, gl.RGBA, gl.UNSIGNED_BYTE, qBuf);
                  collectBuf(qBuf, 2);
                }
              }
            } catch {
              readMethod = 'toDataURL';
              const tmp = document.createElement('canvas');
              tmp.width = Math.min(c.width, 320);
              tmp.height = Math.min(c.height, 320);
              const tctx = tmp.getContext('2d');
              if (tctx) {
                tctx.drawImage(c, 0, 0, tmp.width, tmp.height);
                const d = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
                collectBuf(d, 4);
              } else {
                const urlLen = c.toDataURL().length;
                if (urlLen > 256) colors.add('dataurl_' + urlLen);
              }
            }
            return {
              kind: 'webgl2',
              readMethod,
              width: c.width,
              height: c.height,
              distinctColors: colors.size,
              drawCalls: typeof window.__psv2WebGLDraws === 'number' ? window.__psv2WebGLDraws : null,
              webglContexts: typeof window.__psv2WebGLContexts === 'number' ? window.__psv2WebGLContexts : 0,
            };
          }
        }
        const last = canvases[canvases.length - 1];
        const ctx = last?.getContext('2d');
        if (ctx) {
          const w = Math.min(last.width, 320);
          const h = Math.min(last.height, 320);
          const x0 = Math.max(0, Math.floor((last.width - w) / 2));
          const y0 = Math.max(0, Math.floor((last.height - h) / 2));
          const d = ctx.getImageData(x0, y0, w, h).data;
          const colors = new Set();
          for (let i = 0; i < d.length; i += 16) colors.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ',' + d[i + 3]);
          return { kind: '2d', width: last.width, height: last.height, distinctColors: colors.size, drawCalls: null, webglContexts: 0 };
        }
        return { kind: 'none', distinctColors: 0, drawCalls: null, webglContexts: 0 };
      })()`);
      assert(canvas3dCheck.distinctColors > 1, `3D canvas appears blank: ${JSON.stringify(canvas3dCheck)}`);
      if (canvas3dCheck.kind === 'webgl2' && canvas3dCheck.webglContexts > 0) {
        assert(
          typeof canvas3dCheck.drawCalls === 'number' && canvas3dCheck.drawCalls > 0,
          `WebGL2 canvas recorded 0 draw calls: ${JSON.stringify(canvas3dCheck)}`
        );
      }

      // Trigger export control and verify real blob creation, anchor download click, or /api/export 2xx
      const exportApiStartIdx = apiResponses.length;
      const exportCheck = await evalJS(`(async () => {
        let objectUrlCalled = false;
        let blobSize = 0;
        let blobType = '';
        let anchorDownloadClicked = false;
        let anchorHref = '';

        const origCreate = URL.createObjectURL;
        const origAnchorClick = HTMLAnchorElement.prototype.click;
        URL.createObjectURL = function(blob) {
          objectUrlCalled = true;
          blobSize = blob && typeof blob.size === 'number' ? blob.size : 0;
          blobType = blob && typeof blob.type === 'string' ? blob.type : '';
          return origCreate.apply(this, arguments);
        };
        HTMLAnchorElement.prototype.click = function() {
          const href = String(this.getAttribute('href') || this.href || '');
          if (this.hasAttribute('download') || /^blob:|^data:/i.test(href)) {
            anchorDownloadClicked = true;
            anchorHref = href;
          }
          return origAnchorClick.apply(this, arguments);
        };

        try {
          const btn =
            document.querySelector('#btnExportSVG, [data-export="svg"]') ||
            Array.from(document.querySelectorAll('button')).find(b =>
              /export\\s*svg|1:1\\s*svg|\\bsvg\\b/i.test((b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || ''))
            );
          if (!btn) {
            return {
              foundButton: false,
              objectUrlCalled: false,
              blobSize: 0,
              blobType: '',
              anchorDownloadClicked: false,
              anchorHref: '',
            };
          }
          btn.click();
          const hasValidExportSignal = () =>
            (objectUrlCalled && blobSize > 0) ||
            (anchorDownloadClicked && !objectUrlCalled && /^data:[^,]*,[\\s\\S]*\\S/.test(anchorHref));
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && !hasValidExportSignal()) {
            await new Promise(r => setTimeout(r, 100));
          }
          return {
            foundButton: true,
            objectUrlCalled,
            blobSize,
            blobType,
            anchorDownloadClicked,
            anchorHref,
          };
        } finally {
          URL.createObjectURL = origCreate;
          HTMLAnchorElement.prototype.click = origAnchorClick;
        }
      })()`);
      const exportApiOk = apiResponses
        .slice(exportApiStartIdx)
        .some((r) => /\/api\/export/i.test(r.url) && r.status >= 200 && r.status < 400);
      assert(exportCheck && exportCheck.foundButton === true, 'Could not find SVG export button in UI');
      const validBlobExport = exportCheck.objectUrlCalled && exportCheck.blobSize > 0;
      const validDataAnchor =
        exportCheck.anchorDownloadClicked &&
        !exportCheck.objectUrlCalled &&
        /^data:[^,]*,[\s\S]*\S/.test(exportCheck.anchorHref || '');
      const exportTriggered = validBlobExport || validDataAnchor || exportApiOk;
      assert(
        exportTriggered,
        `Export button click did not produce non-empty Blob URL, download click, or /api/export 2xx: ${JSON.stringify(exportCheck)}`
      );

      assert(
        apiFailures.length === 0,
        `Failed /api/ requests: ${apiFailures.map((f) => `${f.url} (${f.errorText})`).join('; ')}`
      );
      assert(apiResponses.length > 0, 'Expected >=1 /api/ response during studio UI workflow, got 0');
      assert(
        apiResponses.every((r) => Number.isFinite(r.status) && r.status >= 200 && r.status < 400),
        `HTTP error in /api/ responses: ${JSON.stringify(apiResponses.filter((r) => !(r.status >= 200 && r.status < 400)))}`
      );

      assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
      assert(pageErrors.length === 0, `Page exceptions: ${pageErrors.join('; ')}`);
      assert(logErrors.length === 0, `Log errors: ${logErrors.join('; ')}`);

      return {
        ok: true,
        docStatus,
        domCheck,
        templateSwitched: true,
        templateSwitch,
        stlChecked: true,
        stlCheck,
        canvas3dCheck,
        exportTriggered: true,
        exportCheck,
        apiResponses,
        apiFailures,
        consoleErrors,
        pageErrors,
        logErrors,
      };
    } finally {
      try {
        cleanupCdp?.();
      } catch {
        // ignore
      }
      try {
        if (
          ws &&
          (ws.readyState === globalThis.WebSocket.CONNECTING ||
            ws.readyState === globalThis.WebSocket.OPEN)
        ) {
          ws.close();
        }
      } catch {
        // ignore
      }
      if (chrome.exitCode === null && chrome.signalCode === null) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(killTimer);
            resolve();
          };
          const killTimer = setTimeout(() => {
            try {
              chrome.kill('SIGKILL');
            } catch {
              // ignore
            }
            setTimeout(finish, 200);
          }, 2000);
          chrome.once('close', finish);
          try {
            chrome.kill('SIGTERM');
          } catch {
            finish();
          }
        });
      }
    }
  });
}

// ============================================================================
// pattern_studio/ V1 Isolation SHA-256 Verifier
// ============================================================================

async function collectFilesRecursive(rootDir, baseDir = rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      files.push(...(await collectFilesRecursive(full, baseDir)));
    } else if (ent.isFile()) {
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      files.push({ rel, full });
    }
  }
  return files;
}

export async function verifyPatternStudioIsolation() {
  assert(fs.existsSync(V1_ROOT), `V1 baseline directory missing: ${V1_ROOT}`);
  const found = await collectFilesRecursive(V1_ROOT);
  const actualHashes = {};
  for (const { rel, full } of found) {
    const data = await fsp.readFile(full);
    actualHashes[rel] = crypto.createHash('sha256').update(data).digest('hex');
  }

  const expectedKeys = Object.keys(V1_BASELINE_SHA256).sort();
  const actualKeys = Object.keys(actualHashes).sort();

  const missing = expectedKeys.filter((k) => !(k in actualHashes));
  const extra = actualKeys.filter((k) => !(k in V1_BASELINE_SHA256));
  const mismatched = expectedKeys.filter(
    (k) => k in actualHashes && actualHashes[k] !== V1_BASELINE_SHA256[k]
  );

  if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) {
    throw new Error(
      `pattern_studio/ isolation violation! missing=[${missing.join(', ')}] extra=[${extra.join(', ')}] mismatched=[${mismatched.join(', ')}]`
    );
  }

  return {
    ok: true,
    checkedCount: expectedKeys.length,
    hashes: actualHashes,
  };
}
