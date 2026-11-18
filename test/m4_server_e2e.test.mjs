/**
 * Milestone M4 Integration & E2E Test Suite (`test/m4_server_e2e.test.mjs`)
 * Zero-external-dependency `node:test` verification covering:
 *  1. Core barrel (133 exports) & `pattern_studio/` 16-file SHA-256 isolation
 *  2. Server startup banner, HOST/PORT config & EADDRINUSE error handling
 *  3. Static assets, path-traversal guards & frontend XSS/CDN/WebGL2/syntax checks
 *  4. REST API contract & hostile input handling (400/403/404/413)
 *  5. CLI contract (`list`, `--help`, `template`, `unwrap`, `verify-sim`, error exits)
 *  6. Frontend module logic (`WebGL3DViewport` Canvas2D fallback + `CAD2DViewport`)
 *  7. Conditional Headless Chrome CDP smoke test (skips cleanly if unmounted)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as core from '../src/core/index.mjs';
import { CAD2DViewport } from '../public/cad2d.mjs';
import { createViewport3D } from '../public/webgl3d.mjs';
import { parseServerArgs, startServer } from '../src/server.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const V1_ROOT = path.join(WORKSPACE_ROOT, 'pattern_studio');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const SERVER_PATH = path.join(PROJECT_ROOT, 'src', 'server.mjs');
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs');
const WEDGE_ASSEMBLED_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_assembled_view.stl');

const V1_BASELINE_SHA256 = Object.freeze({
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
// Helpers
// ============================================================================

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psv2-m4-test-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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
}

async function startStudioServerProcess({
  args = ['--host=0.0.0.0', '--port=0'],
  env = {},
  timeoutMs = 10000,
} = {}) {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let port = null;
  let settled = false;

  await new Promise((resolve, reject) => {
    let settleTimer = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopChildProcess(child).finally(() =>
        reject(new Error(`Server start timeout (${timeoutMs}ms).\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      );
    }, timeoutMs);

    const checkBanner = () => {
      if (settled) return;
      const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        port = Number.parseInt(m[1], 10);
        if (/ssh\s+-L\s+\d+:localhost:\d+/.test(stdout)) {
          if (settleTimer) clearTimeout(settleTimer);
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (!settleTimer) {
          settleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
          }, 120);
        }
      }
    };

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      checkBanner();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      reject(new Error(`Server exited early (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop: () => stopChildProcess(child),
  };
}

async function runCliProcess(args, { cwd = PROJECT_ROOT, env = {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
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

function createMock2DContext() {
  const ops = [];
  const noop = (name) => (...args) => {
    ops.push({ op: name, argsCount: args.length });
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
    arc: noop('arc'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    setLineDash: noop('setLineDash'),
    fillText: noop('fillText'),
  };
}

function createMockCanvas({ width = 640, height = 480, allowWebGL2 = false } = {}) {
  const ctx2d = createMock2DContext();
  const listeners = new Map();
  return {
    width,
    height,
    ctx2d,
    getContext(type) {
      if (type === 'webgl2') return allowWebGL2 ? {} : null;
      if (type === '2d') return ctx2d;
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

async function detectLaunchableChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      fs.accessSync(real, fs.constants.X_OK);
      const { stdout } = await execFileAsync(real, ['--version'], { timeout: 5000 });
      if (stdout && /chrom/i.test(stdout)) {
        return { bin: real, version: stdout.trim() };
      }
    } catch {
      // candidate absent or unexecutable
    }
  }
  return null;
}

// ============================================================================
// 1. Core Barrel & Baseline Isolation
// ============================================================================

test('1. Core barrel exposes all 133 M1+M2+M3 exports with zero undefined bindings', () => {
  const keys = Object.keys(core);
  assert.equal(keys.length, 133, `Expected 133 barrel exports, got ${keys.length}`);

  const undefinedExports = keys.filter((k) => core[k] === undefined);
  assert.deepEqual(undefinedExports, [], `Undefined barrel exports: ${undefinedExports.join(', ')}`);

  const expectedSymbols = [
    'SCHEMA_VERSION',
    'ValidationError',
    'TEMPLATE_CATALOG',
    'generateTemplatePattern',
    'createFreeformPiece',
    'createRectanglePiece',
    'validatePatternSeams',
    'computeSeamWalkTransform',
    'parseSTL',
    'analyzeSTLTopology',
    'unwrapSTLToPattern',
    'MATERIAL_PRESETS',
    'getMaterialConfig',
    'generateProceduralPBRMaps',
    'DEFAULT_AVATAR',
    'createParametricAvatar',
    'ClothSimulation',
    'runSimulationSteps',
    'nestPatternPieces',
    'FABRIC_ROLL_PRESETS',
    'exportSVG',
    'exportTiledPDF',
    'exportDXF',
    'exportPatternJSON',
    'importPatternJSON',
    'PAGE_FORMATS',
  ];
  for (const sym of expectedSymbols) {
    assert.notEqual(core[sym], undefined, `Missing expected export: ${sym}`);
  }
});

test('1b. pattern_studio/ baseline isolation: all 16 files match exact SHA-256 checksums', async () => {
  assert.ok(fs.existsSync(V1_ROOT), `Missing baseline dir: ${V1_ROOT}`);

  async function walk(dir) {
    const out = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...(await walk(full)));
      } else if (ent.isFile()) {
        out.push({
          rel: path.relative(V1_ROOT, full).split(path.sep).join('/'),
          full,
        });
      }
    }
    return out;
  }

  const files = await walk(V1_ROOT);
  assert.equal(files.length, 16, `Expected 16 baseline files, found ${files.length}`);

  const actualMap = {};
  for (const { rel, full } of files) {
    const buf = await fsp.readFile(full);
    actualMap[rel] = crypto.createHash('sha256').update(buf).digest('hex');
  }

  for (const [rel, expectedSha] of Object.entries(V1_BASELINE_SHA256)) {
    assert.equal(actualMap[rel], expectedSha, `SHA-256 mismatch for pattern_studio/${rel}`);
  }
});

// ============================================================================
// 2. Server Startup Banner, Config & Error Handling (`src/server.mjs`)
// ============================================================================

test('2. Server startup banner prints Local, Remote, and SSH port-forward command', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=0.0.0.0', '--port=0'] });
  try {
    const out = srv.getStdout();
    const p = srv.port;
    const expectedHost = os.hostname() || 'localhost';
    assert.ok(p > 0, `Expected ephemeral port > 0, got ${p}`);
    assert.ok(out.includes(`http://127.0.0.1:${p}`), `Missing Local URL in banner:\n${out}`);
    assert.ok(out.includes(`${expectedHost}:${p}`), `Missing Remote URL in banner:\n${out}`);
    assert.ok(
      out.includes(`ssh -L ${p}:localhost:${p} ${expectedHost}`),
      `Missing SSH tunnel command in banner:\n${out}`
    );
  } finally {
    await srv.stop();
  }
});

test('2b. Server honors HOST/PORT env overrides and exits non-zero on EADDRINUSE', async () => {
  // Verify HOST and PORT env var override
  const envSrv = await startStudioServerProcess({
    args: [],
    env: { HOST: '127.0.0.1', PORT: '0' },
  });
  try {
    const res = await fetch(`${envSrv.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.port, envSrv.port);
  } finally {
    await envSrv.stop();
  }

  // Verify EADDRINUSE exits non-zero cleanly
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const occupiedPort = holder.address().port;

  try {
    const conflict = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [SERVER_PATH, '--host=127.0.0.1', `--port=${occupiedPort}`],
        { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error('Expected EADDRINUSE server process to exit quickly'));
      }, 8000);
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    assert.notEqual(conflict.code, 0, 'Server must exit non-zero on EADDRINUSE');
    assert.match(conflict.stderr, /EADDRINUSE|already in use/i);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

// ============================================================================
// 3. Static Assets, Security Guards & Frontend Integrity
// ============================================================================

test('3. Static assets, isomorphic /src/core/* serving, path traversal blocks & public/* static audit', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  try {
    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/i);
    const html = await htmlRes.text();
    assert.ok(html.includes('canvas2D') && html.includes('canvas3D'));
    assert.ok(html.includes('<link rel="icon"'), 'index.html missing <link rel="icon"');

    const cssRes = await fetch(`${srv.baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/i);

    const jsRoutes = [
      '/cad2d.mjs',
      '/webgl3d.mjs',
      '/app.mjs',
      '/src/core/index.mjs',
      '/src/core/nesting.mjs',
      '/src/core/exporters.mjs',
    ];
    for (const route of jsRoutes) {
      const res = await fetch(`${srv.baseUrl}${route}`);
      assert.equal(res.status, 200, `Expected 200 for ${route}, got ${res.status}`);
      assert.match(res.headers.get('content-type') || '', /application\/javascript/i);
      const body = await res.text();
      assert.ok(body.length > 50, `${route} returned unexpectedly small content`);
    }

    for (const favMethod of ['GET', 'HEAD']) {
      const favRes = await fetch(`${srv.baseUrl}/favicon.ico`, { method: favMethod });
      assert.equal(favRes.status, 204, `Expected 204 for ${favMethod} /favicon.ico, got ${favRes.status}`);
      assert.equal(favRes.headers.get('content-length'), '0');
      const favBytes = Buffer.from(await favRes.arrayBuffer());
      assert.equal(favBytes.length, 0, `Expected empty body for ${favMethod} /favicon.ico`);
    }

    const optFavRes = await fetch(`${srv.baseUrl}/favicon.ico`, { method: 'OPTIONS' });
    assert.equal(optFavRes.status, 204, `Expected 204 for OPTIONS /favicon.ico, got ${optFavRes.status}`);
    assert.match(optFavRes.headers.get('allow') || '', /\bGET\b.*\bHEAD\b.*\bOPTIONS\b/);
    assert.equal(optFavRes.headers.get('content-length'), '0');
    assert.equal(Buffer.from(await optFavRes.arrayBuffer()).length, 0);

    const missingIcoRes = await fetch(`${srv.baseUrl}/nonexistent.ico`);
    assert.equal(missingIcoRes.status, 404, `Expected 404 for /nonexistent.ico, got ${missingIcoRes.status}`);
    await missingIcoRes.arrayBuffer();

    const protoRelResp = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write('GET //favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        data += chunk;
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(protoRelResp, /^HTTP\/1\.1 400 /);
    assert.equal(protoRelResp.includes('<!DOCTYPE html'), false);

    // Traversal attempts must return 403 or 404 (never 200) via raw HTTP path (without fetch URL normalization)
    for (const badPath of ['/../etc/passwd', '/..%2F..%2Fetc%2Fpasswd', '/src/core/../server.mjs', '/.git/config']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.get(`${srv.baseUrl}${badPath}`, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
      });
      assert.ok(status === 403 || status === 404, `Traversal ${badPath} returned ${status}, expected 403/404`);
    }
  } finally {
    await srv.stop();
  }

  // Static security & WebGL2 audit on public/*
  const publicFiles = await fsp.readdir(PUBLIC_DIR);
  assert.ok(publicFiles.length >= 5);
  for (const file of publicFiles) {
    const full = path.join(PUBLIC_DIR, file);
    const content = await fsp.readFile(full, 'utf8');
    for (const forbidden of [/innerHTML/g, /outerHTML/g, /insertAdjacentHTML/g, /\beval\s*\(/g, /new\s+Function\b/g, /https?:\/\//gi]) {
      assert.equal(content.match(forbidden), null, `Forbidden pattern ${forbidden} found in public/${file}`);
    }
    if (file.endsWith('.mjs')) {
      await execFileAsync(process.execPath, ['--check', full]);
    }
  }

  const webglSrc = await fsp.readFile(path.join(PUBLIC_DIR, 'webgl3d.mjs'), 'utf8');
  for (const tok of ['#version 300 es', 'webgl2', 'gl_Position', 'void main(', 'createShader', 'createProgram']) {
    assert.ok(webglSrc.includes(tok), `public/webgl3d.mjs missing required WebGL2 token: ${tok}`);
  }
});

// ============================================================================
// 4. REST API Contract & Hostile Input Handling
// ============================================================================

test('4. REST API endpoints (health, catalog, workspace-stls, stl-content, generate-template, unwrap-stl, simulate, export) & hostile inputs', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  try {
    // 4.1 /api/health
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.port, srv.port);
    assert.ok(health.version);
    assert.ok(health.host);

    // 4.2 /api/catalog
    const catRes = await fetch(`${srv.baseUrl}/api/catalog`);
    assert.equal(catRes.status, 200);
    const catalog = await catRes.json();
    assert.equal(catalog.templates.length, 11);
    assert.ok(catalog.materials.length >= 7);
    assert.ok(Array.isArray(catalog.rolls) && catalog.rolls.length >= 4);
    assert.ok(catalog.pageFormats && catalog.pageFormats.LETTER && catalog.pageFormats.A4);
    assert.ok(catalog.defaultAvatar && catalog.defaultAvatar.measurements);

    // 4.3 /api/workspace-stls
    const stlsRes = await fetch(`${srv.baseUrl}/api/workspace-stls`);
    assert.equal(stlsRes.status, 200);
    const stlsData = await stlsRes.json();
    const stlNames = stlsData.files.map((f) => f.name);
    assert.ok(stlNames.includes('cutting_mat_wedge_assembled_view.stl'));
    assert.ok(stlNames.includes('cutting_mat_wedge_print_ready.stl'));
    for (const f of stlsData.files) {
      assert.equal('fullPath' in f, false, 'fullPath must not leak in /api/workspace-stls');
      assert.equal('dir' in f, false, 'dir must not leak in /api/workspace-stls');
    }

    // 4.4 /api/stl-content
    const rawStlRes = await fetch(`${srv.baseUrl}/api/stl-content?file=cutting_mat_wedge_assembled_view.stl`);
    assert.equal(rawStlRes.status, 200);
    const rawStlBuf = Buffer.from(await rawStlRes.arrayBuffer());
    const parsedMesh = core.parseSTL(rawStlBuf, 'cutting_mat_wedge_assembled_view.stl');
    assert.equal(parsedMesh.triangleCount, 984);

    const badStlRes = await fetch(`${srv.baseUrl}/api/stl-content?file=../../etc/passwd`);
    assert.equal(badStlRes.status, 404);
    const badStlJson = await badStlRes.json();
    assert.ok(typeof badStlJson.error === 'string');

    // 4.5 /api/generate-template (all 5 templates + malformed JSON)
    let tshirtPattern = null;
    let stlCoverPattern = null;
    for (const templateId of ['tshirt', 'hoodie', 'pants', 'tote_bag', 'stl_cover']) {
      const payload =
        templateId === 'stl_cover'
          ? { templateId, workspaceFile: 'cutting_mat_wedge_assembled_view.stl' }
          : { templateId };
      const r = await fetch(`${srv.baseUrl}/api/generate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 200, `Template ${templateId} failed with ${r.status}`);
      const d = await r.json();
      assert.ok(d.pattern && Array.isArray(d.pattern.pieces) && d.pattern.pieces.length >= 1);
      assert.ok(d.seamReport && d.nesting);
      if (templateId === 'tshirt') tshirtPattern = d.pattern;
      if (templateId === 'stl_cover') stlCoverPattern = d.pattern;
    }

    const malRes = await fetch(`${srv.baseUrl}/api/generate-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"templateId": ',
    });
    assert.equal(malRes.status, 400);

    // 4.6 /api/unwrap-stl (both wedge STLs + empty/corrupt STL)
    for (const stlFile of ['cutting_mat_wedge_assembled_view.stl', 'cutting_mat_wedge_print_ready.stl']) {
      const unwrapRes = await fetch(`${srv.baseUrl}/api/unwrap-stl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceFile: stlFile,
          mode: 'form_shell_cover',
          easeMm: 3,
          seamAllowance: 10,
          materialId: 'veg_leather',
        }),
      });
      assert.equal(unwrapRes.status, 200, `unwrap-stl failed for ${stlFile}`);
      const unwrapData = await unwrapRes.json();
      assert.equal(unwrapData.stlSummary.triangleCount, 984);
      assert.ok(unwrapData.pattern.pieces.length >= 2);
    }

    for (const badBody of [{ stlText: '' }, { stlText: 'not-an-stl-payload' }]) {
      const r = await fetch(`${srv.baseUrl}/api/unwrap-stl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(badBody),
      });
      assert.equal(r.status, 400);
    }

    // 4.7 /api/simulate (tshirt + stl_cover)
    const simTshirtRes = await fetch(`${srv.baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, steps: 25 }),
    });
    assert.equal(simTshirtRes.status, 200);
    const simTshirt = await simTshirtRes.json();
    assert.equal(simTshirt.finiteOk, true);
    assert.ok(simTshirt.particles.length > 0);
    assert.ok(simTshirt.strainReport && Number.isFinite(simTshirt.strainReport.meanStrainPct));

    const simStlRes = await fetch(`${srv.baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: stlCoverPattern,
        workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
        steps: 25,
      }),
    });
    assert.equal(simStlRes.status, 200);
    const simStl = await simStlRes.json();
    assert.equal(simStl.finiteOk, true);
    assert.ok(simStl.particles.length > 0);
    assert.ok(simStl.strainReport && Number.isFinite(simStl.strainReport.maxStrainPct));

    // 4.8 /api/export (svg, pdf, dxf, json, unsupported 'bmp', options: null)
    const svgExp = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, format: 'svg', options: null }),
    });
    assert.equal(svgExp.status, 200);
    assert.match(svgExp.headers.get('content-type') || '', /image\/svg\+xml/i);
    assert.match(svgExp.headers.get('content-disposition') || '', /attachment;\s*filename=/i);
    assert.ok((await svgExp.text()).includes('<svg'));

    const pdfExp = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, format: 'pdf', options: { pageFormat: 'LETTER' } }),
    });
    assert.equal(pdfExp.status, 200);
    assert.match(pdfExp.headers.get('content-type') || '', /application\/pdf/i);
    assert.match(pdfExp.headers.get('content-disposition') || '', /attachment;\s*filename=/i);
    const pdfBuf = Buffer.from(await pdfExp.arrayBuffer());
    assert.ok(pdfBuf.toString('latin1').startsWith('%PDF-1.4'));

    const dxfExp = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, format: 'dxf' }),
    });
    assert.equal(dxfExp.status, 200);
    assert.match(dxfExp.headers.get('content-type') || '', /application\/dxf/i);
    assert.match(dxfExp.headers.get('content-disposition') || '', /attachment;\s*filename=/i);
    assert.ok((await dxfExp.text()).includes('$INSUNITS'));

    const jsonExp = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, format: 'json' }),
    });
    assert.equal(jsonExp.status, 200);
    assert.match(jsonExp.headers.get('content-type') || '', /application\/json/i);
    assert.match(jsonExp.headers.get('content-disposition') || '', /attachment;\s*filename=/i);
    const imported = core.importPatternJSON(await jsonExp.text());
    assert.equal(imported.pieces.length, tshirtPattern.pieces.length);

    const bmpExp = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: tshirtPattern, format: 'bmp' }),
    });
    assert.equal(bmpExp.status, 400);

    // 4.9 Unknown /api/unknown -> 404
    const unknownRes = await fetch(`${srv.baseUrl}/api/unknown`);
    assert.equal(unknownRes.status, 404);

    // 4.10 Oversized Content-Length -> 413
    const status413 = await new Promise((resolve, reject) => {
      const req = http.request(
        `${srv.baseUrl}/api/generate-template`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(30 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', () => {
        // Connection reset after 413 response is expected if server destroys socket
      });
      req.on('close', () => {});
      req.flushHeaders();
      setTimeout(() => reject(new Error('Timed out waiting for 413 response')), 5000).unref();
    });
    assert.equal(status413, 413);
  } finally {
    await srv.stop();
  }
});

// ============================================================================
// 5. CLI Contract (`src/cli.mjs`)
// ============================================================================

test('5. CLI subcommands (list, --help, template, unwrap, verify-sim) & invalid invocations', async () => {
  const helpRes = await runCliProcess(['--help']);
  assert.equal(helpRes.code, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /Usage:/);

  const listRes = await runCliProcess(['list']);
  assert.equal(listRes.code, 0, listRes.stderr);
  const listJson = JSON.parse(listRes.stdout);
  assert.equal(listJson.templates.length, 11);
  assert.ok(listJson.materials.length >= 7);

  await withTempDir(async (tmpDir) => {
    const tplOut = path.join(tmpDir, 'tshirt_out');
    const tplRes = await runCliProcess([
      'template',
      '--type', 'tshirt',
      '--out', tplOut,
      '--format', 'svg,pdf,dxf,json',
      '--page', 'LETTER',
    ]);
    assert.equal(tplRes.code, 0, tplRes.stderr);

    const tplFiles = await fsp.readdir(tplOut);
    const svgF = tplFiles.find((f) => f.endsWith('.svg'));
    const pdfF = tplFiles.find((f) => f.endsWith('.pdf'));
    const dxfF = tplFiles.find((f) => f.endsWith('.dxf'));
    const jsonF = tplFiles.find((f) => f.endsWith('.json'));
    assert.ok(svgF && pdfF && dxfF && jsonF, `Missing expected files: ${tplFiles.join(', ')}`);

    assert.ok((await fsp.readFile(path.join(tplOut, svgF), 'utf8')).includes('<svg'));
    assert.ok((await fsp.readFile(path.join(tplOut, pdfF))).toString('latin1').startsWith('%PDF-1.4'));
    assert.ok((await fsp.readFile(path.join(tplOut, dxfF), 'utf8')).includes('$INSUNITS'));
    assert.ok(core.importPatternJSON(await fsp.readFile(path.join(tplOut, jsonF), 'utf8')).pieces.length >= 4);

    const unwrapOut = path.join(tmpDir, 'unwrap_out');
    const unwrapRes = await runCliProcess([
      'unwrap',
      '--stl', '../cutting_mat_wedge_assembled_view.stl',
      '--mode=form_shell_cover',
      '--ease=4',
      '--sa=10',
      '--out', unwrapOut,
      '--format=svg,pdf,dxf,json',
    ]);
    assert.equal(unwrapRes.code, 0, unwrapRes.stderr);
    const unwrapFiles = await fsp.readdir(unwrapOut);
    assert.ok(unwrapFiles.some((f) => f.endsWith('.svg')));
    assert.ok(unwrapFiles.some((f) => f.endsWith('.pdf')));
    assert.ok(unwrapFiles.some((f) => f.endsWith('.dxf')));
    assert.ok(unwrapFiles.some((f) => f.endsWith('.json')));
  });

  const simTplRes = await runCliProcess([
    'verify-sim',
    '--template', 'tshirt',
    '--material', 'veg_leather',
    '--steps', '40',
  ]);
  assert.equal(simTplRes.code, 0, simTplRes.stderr);
  const simTplJson = JSON.parse(simTplRes.stdout);
  assert.equal(simTplJson.finiteOk, true);

  const simStlRes = await runCliProcess([
    'verify-sim',
    '--stl', '../cutting_mat_wedge_assembled_view.stl',
    '--steps', '40',
  ]);
  assert.equal(simStlRes.code, 0, simStlRes.stderr);
  const simStlJson = JSON.parse(simStlRes.stdout);
  assert.equal(simStlJson.finiteOk, true);

  // Error exit checks
  const unknownCmd = await runCliProcess(['nonexistent-subcommand']);
  assert.notEqual(unknownCmd.code, 0);

  const missingStl = await runCliProcess(['unwrap']);
  assert.notEqual(missingStl.code, 0);
});

// ============================================================================
// 6. Frontend Module Logic & Fallback Execution (`cad2d.mjs` + `webgl3d.mjs`)
// ============================================================================

test('6. WebGL3DViewport Canvas2D fallback (984/984 STL + avatar + cloth + pinning) & CAD2DViewport rotation/SeamWalk/nesting', async () => {
  // 6.1 WebGL3DViewport Canvas2D fallback on STL + pinning
  const stlText = await fsp.readFile(WEDGE_ASSEMBLED_STL, 'utf8');
  const stlMesh = core.parseSTL(stlText, 'cutting_mat_wedge_assembled_view.stl');
  const stlPattern = core.unwrapSTLToPattern(stlMesh, { materialId: 'veg_leather' });
  const stlMat = core.getMaterialConfig('veg_leather');
  const stlSim = new core.ClothSimulation(stlPattern, { stlMesh, material: stlMat });
  stlSim.step(5);

  const mockCanvasStl = createMockCanvas({ allowWebGL2: false });
  const vp3d = createViewport3D(mockCanvasStl);
  assert.equal(vp3d.mode, '2d');

  vp3d.setScene({
    sim: stlSim,
    stlMesh,
    avatar: null,
    materialConfig: stlMat,
    showStrainMap: true,
    showForm: true,
    showWire: true,
    showThreads: true,
  });
  vp3d.fitToScene();
  const stlStats = vp3d.render();
  assert.equal(stlStats.mode, '2d');
  assert.equal(stlStats.renderedStlTriangles, 984, 'Must render 100% (984/984) STL faces without decimation');
  assert.ok(stlStats.renderedClothTriangles > 0);
  assert.ok(stlStats.drawCalls > 0);

  // Test particle pinning & dragging
  const beforePinMass = stlSim.particles[0].invMass;
  assert.ok(beforePinMass > 0);
  const pinnedState = vp3d.togglePinParticle(0);
  assert.equal(pinnedState, true);
  assert.equal(stlSim.particles[0].invMass, 0);

  const x0 = stlSim.particles[0].pos.x;
  vp3d.movePinnedParticle(0, 20, -10);
  assert.ok(Number.isFinite(stlSim.particles[0].pos.x));
  assert.notEqual(stlSim.particles[0].pos.x, x0);

  const statsAfterPin = vp3d.render();
  assert.ok(statsAfterPin.drawCalls > 0);

  vp3d.clearPins();
  assert.ok(stlSim.particles[0].invMass > 0);
  vp3d.dispose();

  // 6.2 WebGL3DViewport Canvas2D fallback on Avatar + T-shirt cloth
  const tshirt = core.generateTemplatePattern('tshirt');
  const avatar = core.createParametricAvatar();
  const tshirtSim = new core.ClothSimulation(tshirt, { avatar });
  tshirtSim.step(5);

  const mockCanvasAv = createMockCanvas({ allowWebGL2: false });
  const vpAv = createViewport3D(mockCanvasAv);
  vpAv.setScene({
    sim: tshirtSim,
    avatar,
    stlMesh: null,
    materialConfig: core.getMaterialConfig('cotton_jersey'),
    showForm: true,
    showThreads: true,
  });
  vpAv.fitToScene();
  const avStats = vpAv.render();
  assert.equal(avStats.mode, '2d');
  assert.equal(avStats.renderedStlTriangles, 0);
  assert.ok(avStats.renderedClothTriangles > 0);
  assert.ok(avStats.drawCalls > 0);
  vpAv.dispose();

  // 6.3 CAD2DViewport rotation roundtrip + Seam Walk + Multi-copy Nesting
  const mockCanvas2D = createMockCanvas({ allowWebGL2: false });
  const cad2d = new CAD2DViewport(mockCanvas2D);

  const rect = core.createRectanglePiece('RotTest', 200, 120, { seamAllowance: 10, quantity: 2 });
  rect.position = { x: 150, y: 80 };
  rect.rotation = 45;
  const localPt = { x: 175, y: 30 };
  const worldPt = cad2d.pieceLocalToWorld(rect, localPt);
  const backLocal = cad2d.worldToPieceLocal(rect, worldPt.x, worldPt.y);
  assert.ok(Math.hypot(backLocal.x - localPt.x, backLocal.y - localPt.y) < 1e-9);

  // Seam Walk render on tshirt
  const seamId = tshirt.seams[0].id;
  cad2d.fitToContent({ pattern: tshirt, viewMode: '2d' });
  cad2d.render({
    pattern: tshirt,
    viewMode: '2d',
    selectedPieceId: tshirt.pieces[0].id,
    selectedEdgeIndex: 0,
    showCutLine: true,
    showSeams: true,
    showLengths: true,
    showGrain: true,
    seamWalk: { seamId, walkT: 0.5 },
    unit: 'mm',
  });
  assert.ok(mockCanvas2D.ctx2d.ops.length > 50);

  // Multi-copy Nesting render
  const nestPattern = { id: 'nest_test', name: 'Nest Test', unit: 'mm', pieces: [rect], seams: [] };
  const nestResult = core.nestPatternPieces(nestPattern, { rollPreset: 'roll_54in' });
  assert.equal(nestResult.placements.length, 2);

  const opsBeforeNest = mockCanvas2D.ctx2d.ops.length;
  cad2d.fitToContent({ viewMode: 'nesting', nestingResult: nestResult, activeSheetIndex: 0 });
  cad2d.render({
    pattern: nestPattern,
    viewMode: 'nesting',
    nestingResult: nestResult,
    activeSheetIndex: 0,
    selectedPieceId: rect.id,
    unit: 'mm',
  });
  assert.ok(mockCanvas2D.ctx2d.ops.length > opsBeforeNest);
});

// ============================================================================
// 7. Conditional Headless Chrome CDP Check
// ============================================================================

test('7. Conditional Headless Chrome CDP E2E check (skips cleanly if Chrome binary is unmounted)', async (t) => {
  const chromeInfo = await detectLaunchableChrome();
  if (!chromeInfo) {
    t.skip(
      'Headless Chrome binary not launchable/mounted in sandbox (probed CHROME_BIN, /opt/google/chrome/google-chrome, /usr/bin/google-chrome-stable, /usr/bin/chromium)'
    );
    return;
  }

  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  let chrome = null;
  let ws = null;
  let rejectAllInflight = null;
  await withTempDir(async (profileDir) => {
    try {
      chrome = spawn(
        chromeInfo.bin,
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
          `--user-data-dir=${profileDir}`,
          'about:blank',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stderr = '';
      const wsUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Chrome DevTools WS timeout:\n${stderr}`)), 15000);
        chrome.stderr.on('data', (d) => {
          stderr += d.toString('utf8');
          const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        chrome.once('close', (code) => {
          clearTimeout(timer);
          reject(new Error(`Chrome exited early (${code}):\n${stderr}`));
        });
      });

      const verRes = await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '/json/list'));
      const targets = await verRes.json();
      const pageTarget = targets.find((tg) => tg.type === 'page') || targets[0];
      assert.ok(pageTarget?.webSocketDebuggerUrl, 'Missing page CDP WebSocket URL');

      ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(arg);
        };
        const timer = setTimeout(() => finish(reject, new Error('CDP WebSocket open timeout')), 5000);
        ws.addEventListener('open', () => finish(resolve), { once: true });
        ws.addEventListener(
          'error',
          (e) => finish(reject, new Error(`CDP WS error: ${e.message || 'unknown'}`)),
          { once: true }
        );
        ws.addEventListener('close', () => finish(reject, new Error('CDP WS closed before open')), {
          once: true,
        });
      });

      let nextId = 1;
      const pending = new Map();
      const eventWaiters = [];
      const consoleErrors = [];
      const pageErrors = [];
      let wsClosedErr = null;
      rejectAllInflight = (err) => {
        if (!wsClosedErr) wsClosedErr = err;
        for (const [id, entry] of pending.entries()) {
          pending.delete(id);
          entry.reject(err);
        }
        while (eventWaiters.length > 0) {
          eventWaiters.pop().reject(err);
        }
      };
      ws.addEventListener('close', () => {
        rejectAllInflight(wsClosedErr || new Error('CDP WebSocket closed'));
      });
      ws.addEventListener('error', (e) => {
        rejectAllInflight(new Error(`CDP WebSocket error: ${e?.message || 'unknown'}`));
      });
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else {
          if (msg.method === 'Runtime.exceptionThrown') {
            pageErrors.push(msg.params?.exceptionDetails?.text || 'Runtime exception');
          } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description).join(' '));
          }
          for (let i = eventWaiters.length - 1; i >= 0; i--) {
            const w = eventWaiters[i];
            if (w.method === msg.method) {
              eventWaiters.splice(i, 1);
              w.resolve(msg.params);
            }
          }
        }
      });

      const cdp = (method, params = {}) => {
        if (wsClosedErr) return Promise.reject(wsClosedErr);
        if (ws.readyState !== globalThis.WebSocket.OPEN) {
          return Promise.reject(new Error(`CDP WebSocket is not open (readyState=${ws.readyState})`));
        }
        return new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP call timeout: ${method}`));
          }, 15000);
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

      const waitForEventWithFallback = (method, fallbackMs = 5000) => {
        if (wsClosedErr) {
          return { promise: Promise.reject(wsClosedErr), cancel: () => {} };
        }
        if (ws.readyState !== globalThis.WebSocket.OPEN) {
          return {
            promise: Promise.reject(new Error(`CDP WebSocket is not open (readyState=${ws.readyState})`)),
            cancel: () => {},
          };
        }
        let waiter = null;
        const promise = new Promise((resolve, reject) => {
          waiter = {
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
            resolve(null);
          }, fallbackMs);
          eventWaiters.push(waiter);
        });
        const cancel = () => {
          if (!waiter) return;
          clearTimeout(waiter.timer);
          const idx = eventWaiters.indexOf(waiter);
          if (idx !== -1) eventWaiters.splice(idx, 1);
        };
        return { promise, cancel };
      };

      const evalJS = async (expression) => {
        const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res?.exceptionDetails) {
          throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
        }
        return res?.result?.value;
      };

      const pollEval = async (
        label,
        expression,
        predicate = (v) => Boolean(v),
        { intervalMs = 50, timeoutMs = 10000 } = {}
      ) => {
        const deadline = Date.now() + timeoutMs;
        let lastVal;
        let lastTransientErr = null;
        while (Date.now() < deadline) {
          if (wsClosedErr) throw wsClosedErr;
          try {
            lastVal = await evalJS(expression);
            lastTransientErr = null;
            if (predicate(lastVal)) {
              return lastVal;
            }
          } catch (err) {
            const msg = String(err?.message || err);
            if (
              /Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(
                msg
              ) &&
              !wsClosedErr
            ) {
              lastTransientErr = msg;
            } else {
              throw err;
            }
          }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        throw new Error(
          `CDP poll timeout (${timeoutMs}ms) waiting for ${label}; last=${JSON.stringify(lastVal)}${
            lastTransientErr ? `; lastErr=${lastTransientErr}` : ''
          }`
        );
      };

      await cdp('Page.enable');
      await cdp('Runtime.enable');
      const loadWait = waitForEventWithFallback('Page.loadEventFired', 5000);
      loadWait.promise.catch(() => {});
      try {
        await cdp('Page.navigate', { url: `${srv.baseUrl}/` });
        await loadWait.promise;
      } finally {
        loadWait.cancel();
      }

      const status = await pollEval(
        'initial template boot + WebGL2 draw',
        `(() => {
          const canvas2D = document.querySelector('#canvas2D');
          const canvas3D = document.querySelector('#canvas3D');
          const pieceOpts = document.querySelectorAll('#pieceSelectDropdown option').length;
          const stlOpts = document.querySelectorAll('#workspaceStlSelect option').length;
          const templates = document.querySelectorAll('#templateSelect option').length;
          const webglDraws = window.__psv2WebGLDraws || 0;
          return {
            ready: Boolean(
              document.readyState === 'complete' &&
              canvas2D && canvas2D.width > 0 && canvas2D.height > 0 &&
              canvas3D && canvas3D.width > 0 && canvas3D.height > 0 &&
              templates >= 11 &&
              stlOpts > 0 &&
              pieceOpts >= 4 &&
              webglDraws > 0
            ),
            readyState: document.readyState,
            title: document.title,
            hasCanvas3D: Boolean(canvas3D),
            webglDraws,
            templates,
            pieceOpts,
            stlOpts,
            webglBadge: document.querySelector('#webglBadge')?.textContent || '',
            hud2D: document.querySelector('#hud2D')?.textContent || '',
          };
        })()`,
        (v) => v?.ready === true
      );

      assert.equal(status.hasCanvas3D, true);
      assert.ok(status.templates >= 11, `Expected >= 11 templates, got ${status.templates}`);
      assert.ok(status.webglDraws > 0, `Expected WebGL draws > 0, got ${status.webglDraws}`);

      // Switch template to 'hoodie' and wait deterministically for DOM/canvas/WebGL update
      await evalJS(`(() => {
        window.__psv2TestPrevDraws = window.__psv2WebGLDraws || 0;
        window.__psv2TestPrevCanvas2D = document.querySelector('#canvas2D')?.toDataURL() || '';
        const sel = document.querySelector('#templateSelect');
        sel.value = 'hoodie';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);

      const hoodieStatus = await pollEval(
        'hoodie template switch',
        `(() => {
          const selVal = document.querySelector('#templateSelect')?.value || '';
          const pieceNames = Array.from(document.querySelectorAll('#pieceSelectDropdown option')).map(
            (o) => o.textContent || ''
          );
          const sliderText = document.querySelector('#parametricSlidersContainer')?.textContent || '';
          const draws = window.__psv2WebGLDraws || 0;
          const canvas2dSig = document.querySelector('#canvas2D')?.toDataURL() || '';
          const hasHoodPiece =
            pieceNames.some((n) => /hood/i.test(n)) && pieceNames.some((n) => /kangaroo/i.test(n));
          return {
            ready: Boolean(
              selVal === 'hoodie' &&
              hasHoodPiece &&
              pieceNames.length >= 8 &&
              /Hood Crown Height/i.test(sliderText) &&
              draws > (window.__psv2TestPrevDraws || 0) &&
              canvas2dSig.length > 0 &&
              canvas2dSig !== (window.__psv2TestPrevCanvas2D || '')
            ),
            selVal,
            pieceCount: pieceNames.length,
            hasHoodPiece,
            draws,
            prevDraws: window.__psv2TestPrevDraws || 0,
          };
        })()`,
        (v) => v?.ready === true
      );

      assert.equal(hoodieStatus.selVal, 'hoodie');
      assert.equal(hoodieStatus.hasHoodPiece, true);

      // Unwrap cutting_mat_wedge_assembled_view.stl and poll until metadata, 2D canvas & WebGL update
      await evalJS(`(() => {
        const wsSel = document.querySelector('#workspaceStlSelect');
        if (wsSel) {
          const targetOpt = Array.from(wsSel.options).find((o) =>
            /cutting_mat_wedge_assembled_view/i.test(o.value || '')
          );
          if (targetOpt) wsSel.value = targetOpt.value;
        }
        window.__psv2TestPrevDraws = window.__psv2WebGLDraws || 0;
        window.__psv2TestPrevCanvas2D = document.querySelector('#canvas2D')?.toDataURL() || '';
        document.querySelector('#btnLoadWorkspaceStl').click();
      })()`);

      const stlStatus = await pollEval(
        'workspace STL unwrap',
        `(() => {
          const selVal = document.querySelector('#templateSelect')?.value || '';
          const stlName = document.querySelector('#metaStlName')?.textContent || '';
          const stlTris = document.querySelector('#metaStlTris')?.textContent || '';
          const draws = window.__psv2WebGLDraws || 0;
          const canvas2dSig = document.querySelector('#canvas2D')?.toDataURL() || '';
          return {
            ready: Boolean(
              selVal === 'stl_cover' &&
              stlName.includes('cutting_mat_wedge_assembled_view') &&
              !stlName.includes('STL not loaded') &&
              stlTris.includes('984') &&
              draws > (window.__psv2TestPrevDraws || 0) &&
              canvas2dSig.length > 0 &&
              canvas2dSig !== (window.__psv2TestPrevCanvas2D || '')
            ),
            selVal,
            stlName,
            stlTris,
            draws,
            prevDraws: window.__psv2TestPrevDraws || 0,
          };
        })()`,
        (v) => v?.ready === true
      );

      assert.ok(
        stlStatus.stlName.includes('cutting_mat_wedge_assembled_view'),
        `Unexpected STL meta: ${stlStatus.stlName}`
      );

      // Trigger SVG export with URL.createObjectURL hook and poll until blobCreated === true
      await evalJS(`(() => {
        window.__psv2TestBlobCreated = false;
        window.__psv2TestBlobSize = 0;
        window.__psv2TestOrigCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function(b) {
          if (b && b.size > 0) {
            window.__psv2TestBlobCreated = true;
            window.__psv2TestBlobSize = b.size;
          }
          return window.__psv2TestOrigCreateObjectURL.apply(this, arguments);
        };
        document.querySelector('#btnExportSVG').click();
      })()`);

      let expResult;
      try {
        expResult = await pollEval(
          'SVG export blob creation',
          `(() => ({
            ready: window.__psv2TestBlobCreated === true,
            stlName: document.querySelector('#metaStlName')?.textContent || '',
            blobCreated: Boolean(window.__psv2TestBlobCreated),
            blobSize: window.__psv2TestBlobSize || 0,
          }))()`,
          (v) => v?.ready === true
        );
      } finally {
        await evalJS(`(() => {
          if (window.__psv2TestOrigCreateObjectURL) {
            URL.createObjectURL = window.__psv2TestOrigCreateObjectURL;
            delete window.__psv2TestOrigCreateObjectURL;
          }
        })()`).catch(() => {});
      }

      assert.ok(
        expResult.stlName.includes('cutting_mat_wedge_assembled_view'),
        `Unexpected STL meta: ${expResult.stlName}`
      );
      assert.equal(
        expResult.blobCreated,
        true,
        `Expected SVG export blobCreated === true, got ${JSON.stringify(expResult)}`
      );
      assert.ok(expResult.blobSize > 0, `Expected SVG export blobSize > 0, got ${expResult.blobSize}`);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(pageErrors, []);
    } finally {
      try {
        rejectAllInflight?.(new Error('CDP session closed'));
      } catch {
        // ignore
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      await stopChildProcess(chrome);
      await srv.stop();
    }
  });
});

// ============================================================================
// 8. Iteration 2 Regression Tests (WebGL2 Wireframe VAO, Server/CLI Hardening, App State)
// ============================================================================

function createSwappedLocWebGL2Context() {
  const ARRAY_BUFFER = 0x8892;
  const ELEMENT_ARRAY_BUFFER = 0x8893;
  const VERTEX_SHADER = 0x8b31;
  const FRAGMENT_SHADER = 0x8b30;
  const COMPILE_STATUS = 0x8b81;
  const LINK_STATUS = 0x8b82;
  const TRIANGLES = 0x0004;
  const LINES = 0x0001;
  const POINTS = 0x0000;
  const TEXTURE_2D = 0x0de1;
  const TEXTURE0 = 0x84c0;
  const UNSIGNED_INT = 0x1405;

  let nextId = 1;
  const shaders = new Map();
  const programs = new Map();
  const textures = new Map();
  const vaos = new Map();
  const buffers = new Map();
  const deletedPrograms = new Set();
  const deletedTextures = new Set();
  const deletedVaos = new Set();
  const deletedBuffers = new Set();
  let boundVao = null;
  let boundArrayBuf = null;
  let boundElemBuf = null;
  let activeProgram = null;
  const drawCalls = [];

  const getAttribMap = (prog) => {
    const vs = shaders.get(prog.vsId)?.src || '';
    // Deliberately swap VS_GRID locations (aColor=0, aPos=1) and assign VS_WIRE aPos=2
    if (vs.includes('in vec3 aColor') && !vs.includes('uPointSize') && !vs.includes('in vec3 aNormal')) {
      return { aColor: 0, aPos: 1 };
    }
    if (vs.includes('in vec3 aPos') && !vs.includes('in vec3 aColor') && !vs.includes('in vec3 aNormal')) {
      return { aPos: 2 };
    }
    return { aPos: 0, aNormal: 1, aColor: 2, aUv: 2, aStrainColor: 3, aSelected: 4 };
  };

  return {
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    VERTEX_SHADER,
    FRAGMENT_SHADER,
    COMPILE_STATUS,
    LINK_STATUS,
    TRIANGLES,
    LINES,
    POINTS,
    TEXTURE_2D,
    TEXTURE0,
    TEXTURE1: TEXTURE0 + 1,
    TEXTURE2: TEXTURE0 + 2,
    TEXTURE3: TEXTURE0 + 3,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    REPEAT: 0x2901,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT,
    FLOAT: 0x1406,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    _state: {
      programs,
      textures,
      vaos,
      buffers,
      deletedPrograms,
      deletedTextures,
      deletedVaos,
      deletedBuffers,
      drawCalls,
    },

    createShader(type) {
      const id = nextId++;
      shaders.set(id, { id, type, src: '' });
      return { id };
    },
    shaderSource(shader, src) {
      const s = shaders.get(shader.id);
      if (s) s.src = src;
    },
    compileShader() {},
    getShaderParameter(_s, pname) {
      return pname === COMPILE_STATUS ? true : null;
    },
    getShaderInfoLog() { return ''; },
    deleteShader() {},
    createProgram() {
      const id = nextId++;
      programs.set(id, { id, vsId: null, fsId: null });
      return { id };
    },
    attachShader(prog, shader) {
      const p = programs.get(prog.id);
      const s = shaders.get(shader.id);
      if (!p || !s) return;
      if (s.type === VERTEX_SHADER) p.vsId = s.id;
      else p.fsId = s.id;
    },
    linkProgram() {},
    getProgramParameter(_p, pname) {
      return pname === LINK_STATUS ? true : null;
    },
    getProgramInfoLog() { return ''; },
    deleteProgram(prog) {
      if (prog) deletedPrograms.add(prog.id);
    },
    useProgram(prog) {
      activeProgram = prog ? programs.get(prog.id) : null;
    },
    getAttribLocation(prog, name) {
      const p = programs.get(prog.id);
      if (!p) return -1;
      const map = getAttribMap(p);
      return Object.hasOwn(map, name) ? map[name] : -1;
    },
    getUniformLocation(prog, name) {
      return { progId: prog.id, name };
    },
    uniformMatrix4fv() {},
    uniform3f() {},
    uniform4f() {},
    uniform1f() {},
    uniform1i() {},
    activeTexture() {},
    createTexture() {
      const id = nextId++;
      textures.set(id, { id });
      return { id };
    },
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    generateMipmap() {},
    deleteTexture(tex) {
      if (tex) deletedTextures.add(tex.id);
    },
    createVertexArray() {
      const id = nextId++;
      vaos.set(id, { id, attribs: new Map(), eboId: null });
      return { id };
    },
    deleteVertexArray(vao) {
      if (vao) deletedVaos.add(vao.id);
    },
    bindVertexArray(vao) {
      boundVao = vao ? vaos.get(vao.id) : null;
      boundElemBuf = boundVao?.eboId || null;
    },
    createBuffer() {
      const id = nextId++;
      buffers.set(id, { id, target: null, byteLength: 0 });
      return { id };
    },
    deleteBuffer(buf) {
      if (buf) deletedBuffers.add(buf.id);
    },
    bindBuffer(target, buf) {
      if (target === ARRAY_BUFFER) {
        boundArrayBuf = buf ? buf.id : null;
      } else if (target === ELEMENT_ARRAY_BUFFER) {
        boundElemBuf = buf ? buf.id : null;
        if (boundVao) boundVao.eboId = boundElemBuf;
      }
    },
    bufferData(_target, data) {
      const bId = _target === ELEMENT_ARRAY_BUFFER ? boundElemBuf : boundArrayBuf;
      const b = buffers.get(bId);
      if (b && data) b.byteLength = data.byteLength || 0;
    },
    enableVertexAttribArray(loc) {
      if (boundVao && loc >= 0) {
        const prev = boundVao.attribs.get(loc) || {};
        boundVao.attribs.set(loc, { ...prev, enabled: true });
      }
    },
    vertexAttribPointer(loc, size) {
      if (boundVao && loc >= 0) {
        const prev = boundVao.attribs.get(loc) || {};
        boundVao.attribs.set(loc, { ...prev, size, bufferId: boundArrayBuf });
      }
    },
    viewport() {},
    enable() {},
    disable() {},
    clearColor() {},
    clear() {},
    drawArrays(mode, first, count) {
      drawCalls.push({
        kind: 'drawArrays',
        mode,
        first,
        count,
        progId: activeProgram?.id,
        vaoId: boundVao?.id || null,
      });
    },
    drawElements(mode, count, type, offset) {
      drawCalls.push({
        kind: 'drawElements',
        mode,
        count,
        type,
        offset,
        progId: activeProgram?.id,
        vaoId: boundVao?.id || null,
        eboId: boundVao ? boundVao.eboId : boundElemBuf,
      });
    },
  };
}

test('8. WebGL2 wireframe uses dedicated wire program & clothWireVao (swapped VS_GRID locations) and sets stats.mode=webgl2', () => {
  const gl = createSwappedLocWebGL2Context();
  const canvas = {
    width: 640,
    height: 480,
    getContext(type) {
      return type === 'webgl2' ? gl : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    },
    addEventListener() {},
  };

  const tshirt = core.generateTemplatePattern('tshirt');
  const avatar = core.createParametricAvatar();
  const sim = new core.ClothSimulation(tshirt, { avatar });
  sim.step(3);

  const vp = createViewport3D(canvas);
  assert.equal(vp.mode, 'webgl2');

  vp.setScene({
    sim,
    avatar,
    materialConfig: core.getMaterialConfig('cotton_jersey'),
    showForm: true,
    showWire: true,
    showThreads: true,
  });
  vp.fitToScene();

  const stats = vp.render();
  assert.equal(stats.mode, 'webgl2');
  assert.ok(stats.renderedClothTriangles > 0);
  assert.ok(stats.renderedAvatarTriangles > 0);
  assert.ok(stats.drawCalls > 0);

  const triDraws = gl._state.drawCalls.filter((d) => d.kind === 'drawElements' && d.mode === gl.TRIANGLES);
  const wireDraws = gl._state.drawCalls.filter((d) => d.kind === 'drawElements' && d.mode === gl.LINES);
  assert.equal(triDraws.length, 1);
  assert.equal(wireDraws.length, 1);

  const triCall = triDraws[0];
  const wireCall = wireDraws[0];
  assert.notEqual(wireCall.progId, vp._progs.grid.id, 'Wireframe must NOT reuse _progs.grid');
  assert.equal(wireCall.progId, vp._progs.wire.id, 'Wireframe must use dedicated _progs.wire');
  assert.notEqual(wireCall.vaoId, triCall.vaoId, 'Wireframe must use dedicated clothWireVao');
  assert.equal(wireCall.vaoId, vp._buf.clothWireVao.id);

  // Verify clothVao kept clothEbo and clothWireVao bound clothPos at VS_WIRE aPos=2
  const clothVaoState = gl._state.vaos.get(vp._buf.clothVao.id);
  const wireVaoState = gl._state.vaos.get(vp._buf.clothWireVao.id);
  assert.equal(clothVaoState.eboId, vp._buf.clothEbo.id, 'clothVao EBO must not be mutated by wireframe pass');
  assert.equal(wireVaoState.eboId, vp._buf.clothWireEbo.id);
  assert.equal(wireVaoState.attribs.get(2)?.bufferId, vp._buf.clothPos.id);
  assert.equal(wireVaoState.attribs.get(2)?.enabled, true);

  vp.dispose();
  assert.equal(gl._state.deletedPrograms.size, gl._state.programs.size, 'dispose() must delete all programs');
  assert.equal(gl._state.deletedTextures.size, gl._state.textures.size, 'dispose() must delete all textures');
  assert.equal(gl._state.deletedVaos.size, 6, 'dispose() must delete all 6 VAOs');
  assert.equal(gl._state.deletedBuffers.size, 15, 'dispose() must delete all 15 buffers');
  assert.equal(vp.gl, null);
  assert.equal(vp._buf, null);
});

test('9. Server & CLI Iteration 2/3 hardening: safePatternName/piece labels, malformed URL, invalid pieces/points, --port/--host, verify-sim --mode', async () => {
  assert.throws(() => parseServerArgs(['--port=']), /Invalid port/i);
  assert.throws(() => parseServerArgs(['--port', '']), /Invalid port/i);
  assert.throws(() => parseServerArgs(['--port']), /Missing value.*--port/i);
  assert.throws(() => parseServerArgs(['--host']), /Missing value.*--host/i);

  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  try {
    const tshirt = core.generateTemplatePattern('tshirt');

    // Hostile pattern.name object with non-callable toString must not 500
    const badNameRes = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: { name: { toString: 'nope' }, pieces: tshirt.pieces },
        format: 'svg',
      }),
    });
    assert.equal(badNameRes.status, 200);
    assert.ok((await badNameRes.text()).includes('<svg'));

    // Hostile piece.name / piece.id objects with non-callable toString must not 500
    const safePiece = {
      ...tshirt.pieces[0],
      id: { toString: 'nope' },
      name: { toString: 'nope' },
    };
    const badPieceNameRes = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: { name: 'HostilePieceName', pieces: [safePiece] },
        format: 'svg',
      }),
    });
    assert.equal(badPieceNameRes.status, 200);
    assert.ok((await badPieceNameRes.text()).includes('<svg'));

    // Invalid pieces & non-numeric (null/"") point coords in POST /api/export must return 400 (never 500)
    for (const badPieces of [
      [{}],
      [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }],
      [{ name: 'NullCoord', points: [{ x: null, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] }],
      [{ name: 'EmptyStrCoord', points: [{ x: '', y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] }],
    ]) {
      const badPieceRes = await fetch(`${srv.baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: { name: 'BadPiece', pieces: badPieces },
          format: 'svg',
        }),
      });
      assert.equal(badPieceRes.status, 400);
    }

    // Malformed req.url reaching new URL(...) must return 400 JSON (not 500)
    const rawResp = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write('GET //:80/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => { data += chunk; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(rawResp, /^HTTP\/1\.1 400 /);
  } finally {
    await srv.stop();
  }

  const badModeCli = await runCliProcess([
    'unwrap',
    '--stl', '../cutting_mat_wedge_assembled_view.stl',
    '--mode', 'bogus',
  ]);
  assert.equal(badModeCli.code, 1);
  assert.match(badModeCli.stderr, /Unsupported --mode/i);

  const badVerifySimModeCli = await runCliProcess([
    'verify-sim',
    '--stl', '../cutting_mat_wedge_assembled_view.stl',
    '--mode', 'bogus',
  ]);
  assert.equal(badVerifySimModeCli.code, 1);
  assert.match(badVerifySimModeCli.stderr, /Unsupported --mode/i);
});

test('10. app.mjs mock-DOM regression: local STL re-unwrap, JSON import clears STL, SeamWalk reset, idle rAF, nested sheetLengthMm', async () => {
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));

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

  const webglCtx = createSwappedLocWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const elObj = {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: {
        getBoundingClientRect: () => ({ width: 640, height: 480 }),
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() {
        this.dispatchEvent({ type: 'click' });
      },
      appendChild(c) {
        children.push(c);
        return c;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        return c;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        children.push(...nodes);
      },
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
  elements.get('workspaceStlSelect').value = 'cutting_mat_wedge_assembled_view.stl';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };

  const fetchCalls = [];
  const rafQueue = [];

  // Import before setting globalThis.document so top-level auto-init does not race our awaited initStudio()
  const appMod = await import(`../public/app.mjs?regression=${Date.now()}`);

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) {
        this.data = data;
        this.width = w;
        this.height = h;
      }
    };
    globalThis.requestAnimationFrame = (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    };
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener() {},
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById(id) {
        return elements.get(id) || null;
      },
      createElement(tag) {
        return makeEl(tag, '');
      },
      querySelectorAll() {
        return [];
      },
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url) === '/api/unwrap-stl') {
        const body = JSON.parse(init.body || '{}');
        if (body.stlBase64) {
          const buf = Buffer.from(body.stlBase64, 'base64');
          const mesh = core.parseSTL(buf, body.name || 'upload.stl');
          const pattern = core.unwrapSTLToPattern(mesh, {
            name: body.name || mesh.name,
            mode: body.mode,
            easeMm: body.easeMm,
            thicknessMm: body.thicknessMm,
            seamAllowance: body.seamAllowance,
            scale: body.scale,
            materialId: body.materialId,
          });
          return { ok: true, async json() { return { pattern }; } };
        }
      }
      if (String(url) === '/api/export') {
        return { ok: true, async blob() { return new Blob(['<svg/>'], { type: 'image/svg+xml' }); } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };

    await appMod.initStudio();
    const st = appMod.state;

    // Wait briefly for initial async initStudio tasks
    assert.equal(st.templateId, 'tshirt');
    assert.ok(st.pattern.seams.length > 0);

    // 1) Idle rAF guard: stationary WebGL2 scene must NOT issue draw calls
    assert.ok(rafQueue.length > 0);
    const rafFn = rafQueue[rafQueue.length - 1];
    const drawsBeforeIdle = globalThis.window.__psv2WebGLDraws;
    rafFn();
    assert.equal(globalThis.window.__psv2WebGLDraws, drawsBeforeIdle, 'Idle rAF must not re-render stationary WebGL2 scene');

    // 2) Open Seam Walk on tshirt, then upload custom local STL -> clears Seam Walk
    const firstSeamId = st.pattern.seams[0].id;
    elements.get('seamWalkSelect').value = firstSeamId;
    elements.get('seamWalkSelect').dispatchEvent({ type: 'change' });
    elements.get('seamWalkBar').classList.remove('hidden');
    assert.equal(st.seamWalk.seamId, firstSeamId);

    const boxStl = core.createBoxSTL(80, 60, 40);
    const boxBuf = Buffer.from(boxStl, 'utf8');
    elements.get('stlFileInput').files = [{
      name: 'custom_box.stl',
      async arrayBuffer() { return boxBuf.buffer.slice(boxBuf.byteOffset, boxBuf.byteOffset + boxBuf.byteLength); },
    }];
    elements.get('stlFileInput').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(st.templateId, 'stl_cover');
    assert.equal(st.activeStlMesh.name, 'custom_box.stl');
    assert.ok(st.sim.stlCollider !== null, 'STL unwrap simulation must use stlCollider');
    assert.equal(st.sim.avatar, null);
    assert.ok(st.activeStlSource?.stlBase64, 'Uploaded STL must set activeStlSource.stlBase64');
    assert.equal(st.activeStlSource?.workspaceFile, undefined);
    assert.equal(st.seamWalk.seamId, null, 'STL unwrap must clear stale seamWalk.seamId');
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);

    // 3) Re-unwrap via stlUnwrapModeSelect -> must send stlBase64, NOT workspaceFile
    fetchCalls.length = 0;
    elements.get('stlUnwrapModeSelect').value = 'surface_panels';
    elements.get('stlUnwrapModeSelect').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    const unwrapReq = fetchCalls.find((c) => c.url === '/api/unwrap-stl');
    assert.ok(unwrapReq, 'Expected /api/unwrap-stl request on re-unwrap');
    const unwrapPayload = JSON.parse(unwrapReq.init.body);
    assert.ok(unwrapPayload.stlBase64, 'reUnwrapActiveStl must resend uploaded stlBase64');
    assert.equal(unwrapPayload.workspaceFile, undefined, 'reUnwrapActiveStl must NOT overwrite with workspaceFile');
    assert.equal(st.activeStlMesh.name, 'custom_box.stl');

    // 4) Import tshirt JSON -> clears activeStlMesh & activeStlSource, restores avatar collider
    const tshirtJson = core.exportPatternJSON(core.generateTemplatePattern('tshirt'));
    elements.get('jsonFileInput').files = [{
      name: 'tshirt.json',
      async text() { return tshirtJson; },
    }];
    elements.get('jsonFileInput').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(st.templateId, 'tshirt');
    assert.equal(st.activeStlMesh, null, 'JSON import must clear stale activeStlMesh');
    assert.equal(st.activeStlSource, null);
    assert.equal(elements.get('metaStlName').textContent, 'None loaded');
    assert.ok(st.sim.avatar !== null, 'Simulation must collide against avatar after garment JSON import');
    assert.equal(st.sim.stlCollider, null, 'Simulation must clear stlCollider after garment JSON import');

    // 5) Deleting a piece referenced by active Seam Walk clears Seam Walk
    const walkSeam = st.pattern.seams[0];
    st.seamWalk.seamId = walkSeam.id;
    elements.get('seamWalkBar').classList.remove('hidden');
    st.selectedPieceId = walkSeam.pieceA;
    elements.get('btnDeletePiece').click();
    assert.equal(st.seamWalk.seamId, null);
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);

    // 6) Nested export with cutting_mat_36x24 includes sheetLengthMm & paginateSheets
    fetchCalls.length = 0;
    elements.get('fabricRollSelect').value = 'cutting_mat_36x24';
    elements.get('fabricRollSelect').dispatchEvent({ type: 'change' });
    elements.get('exportLayoutSelect').value = 'nested';
    elements.get('btnExportSVG').click();
    await new Promise((r) => setTimeout(r, 30));

    const expReq = fetchCalls.find((c) => c.url === '/api/export');
    assert.ok(expReq);
    const expPayload = JSON.parse(expReq.init.body);
    assert.equal(expPayload.options.layout, 'nested');
    assert.equal(expPayload.options.nestingOptions.sheetLengthMm, 609.6);
    assert.equal(expPayload.options.nestingOptions.paginateSheets, true);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});

test('11. app.mjs Iteration 3 regressions: inspector Undo button, STL->JSON Undo/Redo sync, SeamWalk clear select, idle rAF suspension', async () => {
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));

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

  const webglCtx = createSwappedLocWebGL2Context();
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const elObj = {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      disabled: id === 'btnUndo' || id === 'btnRedo',
      textContent: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: {
        getBoundingClientRect: () => ({ width: 640, height: 480 }),
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() {
        this.dispatchEvent({ type: 'click' });
      },
      appendChild(c) {
        children.push(c);
        return c;
      },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        return c;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        children.push(...nodes);
      },
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
  elements.get('workspaceStlSelect').value = 'cutting_mat_wedge_assembled_view.stl';

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };

  const rafQueue = [];
  const appMod = await import(`../public/app.mjs?iter3=${Date.now()}`);

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) {
        this.data = data;
        this.width = w;
        this.height = h;
      }
    };
    globalThis.requestAnimationFrame = (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    };
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener() {},
    };
    globalThis.document = {
      activeElement: null,
      body: makeEl('body', ''),
      getElementById(id) {
        return elements.get(id) || null;
      },
      createElement(tag) {
        return makeEl(tag, '');
      },
      querySelectorAll() {
        return [];
      },
    };
    globalThis.URL = class MockURL extends prevGlobals.URL {
      static createObjectURL() { return 'blob:mock'; }
      static revokeObjectURL() {}
    };
    globalThis.fetch = async (url, init = {}) => {
      if (String(url) === '/api/unwrap-stl') {
        const body = JSON.parse(init.body || '{}');
        if (body.stlBase64) {
          const buf = Buffer.from(body.stlBase64, 'base64');
          const mesh = core.parseSTL(buf, body.name || 'upload.stl');
          const pattern = core.unwrapSTLToPattern(mesh, {
            name: body.name || mesh.name,
            mode: body.mode,
            easeMm: body.easeMm,
            thicknessMm: body.thicknessMm,
            seamAllowance: body.seamAllowance,
            scale: body.scale,
            materialId: body.materialId,
          });
          return { ok: true, async json() { return { pattern }; } };
        }
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };

    await appMod.initStudio();
    const st = appMod.state;

    // 1) Idle rAF suspension & wakeup
    assert.ok(rafQueue.length > 0, 'Initial rAF should be scheduled');
    while (rafQueue.length > 0) {
      rafQueue.shift()();
    }
    assert.equal(rafQueue.length, 0, 'Idle rAF must suspend when !simRunning && !dirty');

    // Wakes on sim start and loops while running, then suspends on pause
    elements.get('btnSimToggle').click();
    assert.equal(st.simRunning, true);
    assert.equal(rafQueue.length, 1, 'Starting simulation must wake rAF');
    const stepBefore = st.strainReport.stepCount;
    rafQueue.shift()();
    assert.ok(st.strainReport.stepCount > stepBefore);
    assert.equal(rafQueue.length, 1, 'Running simulation must continue scheduling rAF');

    elements.get('btnSimToggle').click();
    assert.equal(st.simRunning, false);
    rafQueue.shift()();
    assert.equal(rafQueue.length, 0, 'Pausing simulation must re-suspend rAF once idle');

    // Wakes when viewport becomes dirty (e.g., wheel zoom or camera preset) and suspends again
    elements.get('btnCamSide').click();
    while (rafQueue.length > 0) rafQueue.shift()();
    assert.equal(rafQueue.length, 0);
    elements.get('canvas3D').dispatchEvent({ type: 'wheel', deltaY: -120 });
    assert.equal(rafQueue.length, 1, '3D viewport dirty must wake rAF');
    while (rafQueue.length > 0) rafQueue.shift()();
    assert.equal(rafQueue.length, 0);

    // 2) Inspector edits must immediately enable #btnUndo
    assert.equal(elements.get('btnUndo').disabled, true);
    const origName = st.pattern.pieces[0].name;
    elements.get('pieceNameInput').value = 'Edited Front';
    elements.get('pieceNameInput').dispatchEvent({ type: 'change' });
    assert.equal(st.pattern.pieces[0].name, 'Edited Front');
    assert.equal(elements.get('btnUndo').disabled, false, '#btnUndo must be enabled after #pieceNameInput edit');

    elements.get('btnUndo').click();
    assert.equal(st.pattern.pieces[0].name, origName);
    assert.equal(elements.get('btnUndo').disabled, true);
    assert.equal(elements.get('btnRedo').disabled, false);

    elements.get('pieceGrainInput').value = '45';
    elements.get('pieceGrainInput').dispatchEvent({ type: 'change' });
    assert.equal(st.pattern.pieces[0].grainline.angleDeg, 45);
    assert.equal(elements.get('btnUndo').disabled, false, '#btnUndo must be enabled after #pieceGrainInput edit');

    elements.get('edgeSaInput').value = '15';
    elements.get('edgeSaInput').dispatchEvent({ type: 'change' });
    assert.equal(elements.get('btnUndo').disabled, false, '#btnUndo must be enabled after #edgeSaInput edit');

    // 3) Load STL -> Import tshirt.json -> Undo restores STL mesh/collider/metadata -> Redo restores tshirt
    const boxStl = core.createBoxSTL(80, 60, 40);
    const boxBuf = Buffer.from(boxStl, 'utf8');
    elements.get('stlFileInput').files = [{
      name: 'custom_box.stl',
      async arrayBuffer() { return boxBuf.buffer.slice(boxBuf.byteOffset, boxBuf.byteOffset + boxBuf.byteLength); },
    }];
    elements.get('stlFileInput').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(st.templateId, 'stl_cover');
    assert.equal(st.activeStlMesh?.name, 'custom_box.stl');
    assert.equal(elements.get('metaStlName').textContent, 'custom_box.stl');

    const tshirtJson = core.exportPatternJSON(core.generateTemplatePattern('tshirt'));
    elements.get('jsonFileInput').files = [{
      name: 'tshirt.json',
      async text() { return tshirtJson; },
    }];
    elements.get('jsonFileInput').dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(st.templateId, 'tshirt');
    assert.equal(st.activeStlMesh, null);
    assert.equal(elements.get('metaStlName').textContent, 'None loaded');
    assert.equal(st.sim.stlCollider, null);
    assert.ok(st.sim.avatar !== null);

    // Undo across JSON import -> restores stl_cover + STL mesh + STL collider + metadata UI
    elements.get('btnUndo').click();
    assert.equal(st.templateId, 'stl_cover');
    assert.ok(st.activeStlMesh !== null, 'Undo across JSON import must restore activeStlMesh');
    assert.equal(st.activeStlMesh.name, 'custom_box.stl');
    assert.ok(st.activeStlSource?.stlBase64, 'Undo across JSON import must restore activeStlSource');
    assert.equal(elements.get('metaStlName').textContent, 'custom_box.stl');
    assert.ok(st.sim.stlCollider !== null, 'Undo back to stl_cover must restore STL collider');
    assert.equal(st.sim.avatar, null, 'Undo back to stl_cover must not drape onto human avatar');

    // Redo forward -> restores tshirt + clears STL mesh & collider + restores avatar
    elements.get('btnRedo').click();
    assert.equal(st.templateId, 'tshirt');
    assert.equal(st.activeStlMesh, null);
    assert.equal(st.activeStlSource, null);
    assert.equal(elements.get('metaStlName').textContent, 'None loaded');
    assert.equal(st.sim.stlCollider, null);
    assert.ok(st.sim.avatar !== null);

    // 4) btnSeamWalkClear clears #seamWalkSelect.value to ''
    const firstSeamId = st.pattern.seams[0].id;
    elements.get('seamWalkSelect').value = firstSeamId;
    elements.get('seamWalkSelect').dispatchEvent({ type: 'change' });
    elements.get('seamWalkBar').classList.remove('hidden');
    assert.equal(st.seamWalk.seamId, firstSeamId);
    assert.equal(elements.get('seamWalkSelect').value, firstSeamId);

    elements.get('btnSeamWalkClear').click();
    assert.equal(st.seamWalk.seamId, null);
    assert.equal(elements.get('seamWalkBar').classList.contains('hidden'), true);
    assert.equal(elements.get('seamWalkSelect').value, '', '#seamWalkSelect.value must be cleared to ""');
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});

test('12. Iteration 4 frontend regressions: Bezier curve handles, freeform undo leak, orphan stl_cover.json, 2D fallback rAF', async () => {
  const { CAD2DViewport, inferCurveType } = await import(`../public/cad2d.mjs?r4=${Date.now()}`);

  // 1) inferCurveType & built-in curved edges across tshirt, hoodie, pants
  assert.equal(inferCurveType(null), 'straight');
  assert.equal(inferCurveType({}), 'straight');
  assert.equal(inferCurveType({ type: 'straight' }), 'straight');
  assert.equal(inferCurveType({ cp: { x: 1, y: 2 } }), 'quadratic');
  assert.equal(inferCurveType({ cp1: { x: 1, y: 2 } }), 'quadratic');
  assert.equal(inferCurveType({ cp1: { x: 1, y: 2 }, cp2: { x: 3, y: 4 } }), 'cubic');

  let totalCurved = 0;
  for (const tid of ['tshirt', 'hoodie', 'pants']) {
    const p = core.generateTemplatePattern(tid);
    for (const pc of p.pieces) {
      for (const e of pc.edges || []) {
        if (e.curve && (e.curve.cp || e.curve.cp1 || e.curve.cp2 || (e.curve.type && e.curve.type !== 'straight'))) {
          totalCurved += 1;
          const inferred = inferCurveType(e.curve);
          assert.ok(inferred === 'cubic' || inferred === 'quadratic', `Expected cubic/quadratic for ${tid}.${pc.id}, got ${inferred}`);
        }
      }
    }
  }
  assert.ok(totalCurved >= 30, `Expected >= 30 built-in curved edges across tshirt/hoodie/pants, got ${totalCurved}`);

  // 2) Direct CAD2DViewport render, hit-test, and pointer drag for built-in cubic AND quadratic { cp1 }
  const mockCanvas = createMockCanvas({ width: 640, height: 480 });
  const dragCalls = [];
  const vp = new CAD2DViewport(mockCanvas, {
    onDragBezierCP(pieceId, edgeIdx, cpKey, pt) {
      dragCalls.push({ pieceId, edgeIdx, cpKey, pt });
    },
  });
  const quadCp1Piece = {
    id: 'quad_cp1_piece',
    name: 'Quad CP1 Piece',
    position2D: { x: 0, y: 0 },
    rotation2D: 0,
    points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }],
    edges: [
      { curve: { cp1: { x: 60, y: -40 } }, seamAllowance: 10, notches: [] },
      { curve: null, seamAllowance: 10, notches: [] },
      { curve: null, seamAllowance: 10, notches: [] },
      { curve: null, seamAllowance: 10, notches: [] },
    ],
    grainline: { start: { x: 60, y: 20 }, end: { x: 60, y: 100 } },
    internalLines: [],
  };
  const quadPattern = {
    schemaVersion: core.SCHEMA_VERSION,
    id: 'quad_test',
    name: 'Quad Test',
    unit: 'mm',
    pieces: [quadCp1Piece],
    seams: [],
  };
  vp.fitToContent({ pattern: quadPattern });
  mockCanvas.ctx2d.ops.length = 0;
  vp.render({ pattern: quadPattern, selectedPieceId: 'quad_cp1_piece', selectedEdgeIndex: 0 });
  const arcCountQuad = mockCanvas.ctx2d.ops.filter((o) => o.op === 'arc').length;
  assert.equal(arcCountQuad, 1, `Expected 1 quadratic handle arc, got ${arcCountQuad}`);

  const cp1World = vp.pieceLocalToWorld(quadCp1Piece, quadCp1Piece.edges[0].curve.cp1);
  const cp1Screen = vp.worldToScreen(cp1World.x, cp1World.y);
  const hitQuad = vp._hitTestCurveHandles(quadCp1Piece, cp1Screen.x, cp1Screen.y);
  assert.ok(hitQuad, 'Expected _hitTestCurveHandles to hit quadratic { cp1 } handle');
  assert.equal(hitQuad.type, 'cp');
  assert.equal(hitQuad.cpKey, 'cp1');
  assert.equal(hitQuad.edgeIndex, 0);

  // 3) Full app.mjs mock-DOM harness with WebGL2 disabled to also cover 2D fallback rAF
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
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
  const canvas2dCtx = { ...createMock2DContext(), putImageData() {} };
  const makeEl = (tag = 'div', id = '') => {
    const listeners = new Map();
    const children = [];
    const elObj = {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      width: 640,
      height: 480,
      dataset: {},
      files: [],
      options: children,
      classList: makeClassList(id === 'seamWalkBar' || id === 'studioToast' ? ['hidden'] : []),
      parentElement: {
        getBoundingClientRect: () => ({ width: 640, height: 480 }),
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        const evt = { target: elObj, currentTarget: elObj, preventDefault() {}, ...ev };
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      click() {
        this.dispatchEvent({ type: 'click' });
      },
      appendChild(c) { children.push(c); return c; },
      removeChild(c) {
        const idx = children.indexOf(c);
        if (idx >= 0) children.splice(idx, 1);
        return c;
      },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      setAttribute() {},
      getAttribute() { return ''; },
      getContext(type) {
        // Return null for webgl2 so WebGL3DViewport exercises '2d' fallback mode
        if (id === 'canvas3D' && type === 'webgl2') return null;
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

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ImageData: globalThis.ImageData,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
  };
  const rafQueue = [];
  const appMod = await import(`../public/app.mjs?r4_app=${Date.now()}`);

  try {
    globalThis.ImageData = class MockImageData {
      constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
    };
    globalThis.requestAnimationFrame = (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    };
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
    globalThis.fetch = async () => ({ ok: false, status: 404, async json() { return {}; } });

    await appMod.initStudio();
    const st = appMod.state;
    const { cad2D, viewport3D } = appMod;

    // 3a) 2D fallback mode rAF dirty flag drainage
    assert.equal(viewport3D.mode, '2d');
    assert.ok(rafQueue.length > 0);
    viewport3D._markDirty();
    assert.equal(viewport3D._dirty, true);
    const rafCb = rafQueue[rafQueue.length - 1];
    rafCb(performance.now());
    assert.equal(viewport3D._dirty, false, 'animationLoop must drain _dirty in 2d fallback mode');

    // 3b) Built-in curved edge in tshirt exposes cubic/quadratic in #edgeCurveSelect & draws + hits + drags handles
    const frontPiece = st.pattern.pieces.find((pc) => pc.edges?.some((e) => inferCurveType(e.curve) !== 'straight'));
    assert.ok(frontPiece, 'tshirt must have a piece with curved edges');
    const curvedIdx = frontPiece.edges.findIndex((e) => inferCurveType(e.curve) !== 'straight');
    const expectedCurveType = inferCurveType(frontPiece.edges[curvedIdx].curve);
    canvas2dCtx.ops.length = 0;
    cad2D.callbacks.onSelectPiece(frontPiece.id, null, curvedIdx);
    assert.equal(elements.get('edgeCurveSelect').value, expectedCurveType);
    assert.ok(
      canvas2dCtx.ops.some((o) => o.op === 'arc'),
      'CAD2DViewport must draw Bezier handle arcs when curved piece is selected'
    );

    // Verify canvas2dCtx drew handle arcs and _hitTestCurveHandles hits cp1/cp
    const hitCpKey = frontPiece.edges[curvedIdx].curve.cp1 ? 'cp1' : 'cp';
    const cpLocal = frontPiece.edges[curvedIdx].curve[hitCpKey];
    const cpW = cad2D.pieceLocalToWorld(frontPiece, cpLocal);
    const cpS = cad2D.worldToScreen(cpW.x, cpW.y);
    const hitBuiltin = cad2D._hitTestCurveHandles(frontPiece, cpS.x, cpS.y);
    assert.ok(hitBuiltin, 'Expected _hitTestCurveHandles to hit built-in tshirt Bezier handle');
    assert.equal(hitBuiltin.cpKey, hitCpKey);

    // Drag the built-in handle via pointerdown -> pointermove -> pointerup
    const canvas2D = elements.get('canvas2D');
    const beforeCpX = frontPiece.edges[curvedIdx].curve[hitCpKey].x;
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: cpS.x, clientY: cpS.y, pointerId: 1 });
    canvas2D.dispatchEvent({ type: 'pointermove', button: 0, clientX: cpS.x + 15, clientY: cpS.y + 10, pointerId: 1 });
    canvas2D.dispatchEvent({ type: 'pointerup', button: 0, clientX: cpS.x + 15, clientY: cpS.y + 10, pointerId: 1 });
    assert.notEqual(frontPiece.edges[curvedIdx].curve[hitCpKey].x, beforeCpX, 'Dragging Bezier handle should update CP coordinates');

    // Undo that drag so undo stack returns to empty
    elements.get('btnUndo').click();
    assert.equal(elements.get('btnUndo').disabled, true);

    // 3c) Split Bezier edge via #btnSplitSelectedEdge keeps cubic/quadratic type & draggable handles
    const splitTarget = st.pattern.pieces.find((p) => p.id === frontPiece.id);
    cad2D.callbacks.onSelectPiece(splitTarget.id, null, curvedIdx);
    const edgeCountBeforeSplit = splitTarget.edges.length;
    elements.get('btnSplitSelectedEdge').click();
    assert.equal(splitTarget.edges.length, edgeCountBeforeSplit + 1);
    const splitEdgeA = splitTarget.edges[curvedIdx];
    const splitEdgeB = splitTarget.edges[curvedIdx + 1];
    assert.equal(inferCurveType(splitEdgeA.curve), expectedCurveType);
    assert.equal(inferCurveType(splitEdgeB.curve), expectedCurveType);
    assert.equal(elements.get('edgeCurveSelect').value, expectedCurveType);

    const splitCpKey = splitEdgeA.curve.cp1 ? 'cp1' : 'cp';
    const splitCpW = cad2D.pieceLocalToWorld(splitTarget, splitEdgeA.curve[splitCpKey]);
    const splitCpS = cad2D.worldToScreen(splitCpW.x, splitCpW.y);
    const hitSplit = cad2D._hitTestCurveHandles(splitTarget, splitCpS.x, splitCpS.y);
    assert.ok(hitSplit, 'Expected _hitTestCurveHandles to hit freshly split Bezier edge handle');
    assert.equal(hitSplit.cpKey, splitCpKey);

    // Reset back to clean state (undo split)
    elements.get('btnUndo').click();
    assert.equal(elements.get('btnUndo').disabled, true);

    // 3d) onCreateFreeform error (collinear points) must NOT leak duplicate snapshot onto undoStack
    // Case A: empty undo stack stays empty on failure
    st.activeTool = 'draw_poly';
    cad2D.callbacks.onRedraw();
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 100, clientY: 100, pointerId: 2 });
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 150, clientY: 100, pointerId: 2 });
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 200, clientY: 100, pointerId: 2 });
    canvas2D.dispatchEvent({ type: 'dblclick', button: 0, clientX: 200, clientY: 100 });
    assert.equal(elements.get('studioToast').classList.contains('hidden'), false);
    assert.match(elements.get('studioToast').textContent, /collinear|degenerate|area|polygon/i);
    assert.equal(elements.get('btnUndo').disabled, true, 'Failed freeform with empty stack must keep Undo disabled');

    // Case B: prior real edit is undone in ONE click after a failed freeform attempt
    st.activeTool = 'select';
    cad2D.callbacks.onRedraw();
    const renameTarget = st.pattern.pieces.find((p) => p.id === frontPiece.id);
    cad2D.callbacks.onSelectPiece(renameTarget.id);
    const originalName = renameTarget.name;
    elements.get('pieceNameInput').value = 'Real Rename';
    elements.get('pieceNameInput').dispatchEvent({ type: 'change' });
    assert.equal(renameTarget.name, 'Real Rename');
    assert.equal(elements.get('btnUndo').disabled, false);

    st.activeTool = 'draw_poly';
    cad2D.callbacks.onRedraw();
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 110, clientY: 120, pointerId: 3 });
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 160, clientY: 120, pointerId: 3 });
    canvas2D.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 210, clientY: 120, pointerId: 3 });
    canvas2D.dispatchEvent({ type: 'dblclick', button: 0, clientX: 210, clientY: 120 });
    assert.match(elements.get('studioToast').textContent, /collinear|degenerate|area|polygon/i);
    assert.equal(elements.get('btnUndo').disabled, false);
    elements.get('btnUndo').click();
    assert.equal(
      st.pattern.pieces.find((p) => p.id === frontPiece.id).name,
      originalName,
      'Single #btnUndo click after failed freeform must undo the prior real edit immediately',
    );
    assert.equal(elements.get('btnUndo').disabled, true);
    st.activeTool = 'select';
    cad2D.callbacks.onRedraw();

    // 3e) Orphan stl_cover.json import without loaded STL surfaces warning + avoids human avatar drape
    const boxStl = core.createBoxSTL(180, 120, 80);
    const stlPattern = core.generateTemplatePattern('stl_cover', { stlMesh: boxStl });
    const orphanJson = core.exportPatternJSON(stlPattern);
    const jsonInput = elements.get('jsonFileInput');
    jsonInput.files = [{ name: 'orphan_stl_cover.json', async text() { return orphanJson; } }];
    jsonInput.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(st.activeStlMesh, null);
    assert.match(elements.get('metaStlName').textContent, /STL not loaded/i);
    assert.equal(elements.get('studioToast').classList.contains('hidden'), false);
    assert.match(elements.get('studioToast').textContent, /STL not loaded|reload .*\.stl/i);
    assert.equal(st.sim.avatar, null, 'Orphan stl_cover must not drape onto human avatar when activeStlMesh is null');
    assert.equal(st.sim.stlCollider, null);
  } finally {
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
    globalThis.ImageData = prevGlobals.ImageData;
    globalThis.fetch = prevGlobals.fetch;
    globalThis.URL = prevGlobals.URL;
  }
});

test('13. Iteration 4 server regressions: hostile { toString: "nope" } & malformed /api/nest inputs return 400 with zero 500s', async () => {
  const srv = await startStudioServerProcess();
  try {
    const validPattern = core.generateTemplatePattern('tshirt');
    const hostileObj = { toString: 'nope' };

    const postJson = async (pathname, payload) => {
      const res = await fetch(`${srv.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return { status: res.status, json };
    };

    // 1) POST /api/export hostile unit, rollPreset, nestingOptions.rollPreset, pageFormat -> 400 (never 500)
    for (const format of ['svg', 'pdf', 'dxf']) {
      const badUnit = await postJson('/api/export', {
        format,
        pattern: { ...validPattern, unit: hostileObj },
      });
      assert.equal(badUnit.status, 400, `Expected 400 for ${format} hostile unit, got ${badUnit.status}`);

      const badRoll = await postJson('/api/export', {
        format,
        pattern: validPattern,
        options: { rollPreset: hostileObj },
      });
      assert.equal(badRoll.status, 400, `Expected 400 for ${format} hostile rollPreset, got ${badRoll.status}`);

      const badNestedRoll = await postJson('/api/export', {
        format,
        pattern: validPattern,
        options: { nestingOptions: { rollPreset: hostileObj } },
      });
      assert.equal(badNestedRoll.status, 400, `Expected 400 for ${format} hostile nestingOptions.rollPreset, got ${badNestedRoll.status}`);
    }
    const badPageFormat = await postJson('/api/export', {
      format: 'pdf',
      pattern: validPattern,
      options: { pageFormat: hostileObj },
    });
    assert.equal(badPageFormat.status, 400);

    // 2) POST /api/nest hostile unit, rollPreset, options, and malformed points/pieces -> 400
    const nestHostileCases = [
      { pattern: { ...validPattern, unit: hostileObj } },
      { pattern: validPattern, rollPreset: hostileObj },
      { pattern: validPattern, options: { rollPreset: hostileObj } },
      { pattern: validPattern, options: { marginMm: hostileObj } },
      { pattern: validPattern, fabricWidthMm: hostileObj },
      {
        pattern: {
          ...validPattern,
          pieces: [null],
        },
      },
      {
        pattern: {
          ...validPattern,
          pieces: [
            {
              ...validPattern.pieces[0],
              points: [{ x: null, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
            },
          ],
        },
      },
      {
        pattern: {
          ...validPattern,
          pieces: [
            {
              ...validPattern.pieces[0],
              points: [{ x: '', y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
            },
          ],
        },
      },
    ];
    for (const [idx, body] of nestHostileCases.entries()) {
      const r = await postJson('/api/nest', body);
      assert.equal(r.status, 400, `Expected 400 for /api/nest hostile case #${idx}, got ${r.status}: ${JSON.stringify(r.json)}`);
    }

    // POST /api/nest with hostile labels (pattern.name, piece.id, piece.name) on valid geometry sanitizes safely -> 200
    const nestSanitized = await postJson('/api/nest', {
      pattern: {
        ...validPattern,
        name: hostileObj,
        pieces: validPattern.pieces.map((pc, i) => ({
          ...pc,
          id: i === 0 ? hostileObj : pc.id,
          name: i === 0 ? hostileObj : pc.name,
        })),
      },
    });
    assert.equal(nestSanitized.status, 200);
    assert.ok(Array.isArray(nestSanitized.json.nesting.placements));

    // 3) POST /api/generate-template hostile templateId / materialId -> 400
    const badTpl = await postJson('/api/generate-template', { templateId: hostileObj });
    assert.equal(badTpl.status, 400);
    const badTplMat = await postJson('/api/generate-template', { templateId: 'tshirt', materialId: hostileObj });
    assert.equal(badTplMat.status, 400);

    // 4) POST /api/unwrap-stl hostile mode / materialId / numeric inputs -> 400
    for (const extra of [
      { mode: hostileObj },
      { materialId: hostileObj },
      { thicknessMm: hostileObj },
      { easeMm: hostileObj },
      { seamAllowance: hostileObj },
      { scale: hostileObj },
    ]) {
      const r = await postJson('/api/unwrap-stl', {
        workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
        ...extra,
      });
      assert.equal(r.status, 400, `Expected 400 for /api/unwrap-stl with ${Object.keys(extra)[0]}, got ${r.status}`);
    }

    // 5) POST /api/simulate hostile materialId / steps -> 400
    const badSimMat = await postJson('/api/simulate', { pattern: validPattern, materialId: hostileObj });
    assert.equal(badSimMat.status, 400);
    const badSimSteps = await postJson('/api/simulate', { pattern: validPattern, steps: hostileObj });
    assert.equal(badSimSteps.status, 400);
  } finally {
    await srv.stop();
  }
});

test('14. Iteration 5 server regressions: PDF default pageFormat (no body.format leak), nestingResult validation, /api/simulate pattern/internalLines/seams validation', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  try {
    const validPattern = core.generateTemplatePattern('tshirt');

    const postJson = async (pathname, payload) => {
      const res = await fetch(`${srv.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return { status: res.status, json };
    };

    // 1) POST /api/export with { pattern, format: 'pdf' } omitting options.pageFormat must emit LETTER 1:1 (not | pdf 1:1)
    for (const extra of [{}, { options: { marginMm: 10 } }, { options: { pageFormat: null } }]) {
      const pdfRes = await fetch(`${srv.baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: validPattern, format: 'pdf', ...extra }),
      });
      assert.equal(pdfRes.status, 200);
      const pdfText = Buffer.from(await pdfRes.arrayBuffer()).toString('latin1');
      assert.ok(pdfText.startsWith('%PDF-1.4'));
      assert.ok(pdfText.includes('LETTER 1:1'), `Expected LETTER 1:1 in PDF header, extra=${JSON.stringify(extra)}`);
      assert.equal(pdfText.includes('| pdf 1:1'), false, 'PDF header must NOT contain leaked "| pdf 1:1"');
    }

    // Top-level pageFormat: 'A4' still works when passed explicitly
    const topA4Res = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: validPattern, format: 'pdf', pageFormat: 'A4' }),
    });
    assert.equal(topA4Res.status, 200);
    const topA4Text = Buffer.from(await topA4Res.arrayBuffer()).toString('latin1');
    assert.ok(topA4Text.includes('A4 1:1'));

    // 2) POST /api/export (svg, pdf, dxf) rejects malformed options.nestingResult.placements & sheets with 400 (never 500)
    const badNestingResults = [
      { nestingResult: { placements: 123 } },
      { nestingResult: { placements: [null] } },
      { nestingResult: { placements: [{ pieceIndex: 0, x: { toString: 'nope' }, y: 0 }] } },
      { nestingResult: { sheets: 'bad' } },
      { nestingResult: { sheets: [null] } },
      { nestingOptions: { nestingResult: { placements: [null] } } },
    ];
    for (const format of ['svg', 'pdf', 'dxf']) {
      for (const [idx, opts] of badNestingResults.entries()) {
        const r = await postJson('/api/export', {
          format,
          pattern: validPattern,
          options: opts,
        });
        assert.equal(
          r.status,
          400,
          `Expected 400 for ${format} malformed nestingResult #${idx}, got ${r.status}: ${JSON.stringify(r.json)}`
        );
      }
    }

    // Valid precomputed nestingResult still exports cleanly with 200
    const validNestResult = core.nestPatternPieces(validPattern, { rollPreset: 'roll_54in' });
    const validNestedSvg = await fetch(`${srv.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'svg',
        pattern: validPattern,
        options: { nestingResult: validNestResult },
      }),
    });
    assert.equal(validNestedSvg.status, 200);
    assert.ok((await validNestedSvg.text()).includes('<svg'));

    // 3) POST /api/simulate rejects malformed pieces, points, internalLines, and seams with 400 (never 500 or silent 200)
    const squarePts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    for (const unit of ['mm', 'cm']) {
      const badSimPayloads = [
        { pattern: { name: 'NullPiece', unit, pieces: [null] }, steps: 2 },
        { pattern: { name: 'NullPts', unit, pieces: [{ id: 'p1', points: [null, null, null] }] }, steps: 2 },
        {
          pattern: {
            name: 'OneNullPt',
            unit,
            pieces: [{ id: 'p1', points: [null, { x: 10, y: 0 }, { x: 0, y: 10 }] }],
          },
          steps: 2,
        },
        {
          pattern: {
            name: 'BadInternalPts',
            unit,
            pieces: [{ id: 'p1', points: squarePts, internalLines: [{ id: 'l1', points: [null, null] }] }],
            seams: [{ pieceA: 'p1', edgeA: 0, pieceB: 'p1', internalLineIdB: 'l1', internalSegmentIndexB: 0 }],
          },
          steps: 2,
        },
        {
          pattern: {
            name: 'BadInternalArray',
            unit,
            pieces: [{ id: 'p1', points: squarePts, internalLines: 'bad' }],
          },
          steps: 2,
        },
        {
          pattern: {
            name: 'BadSeamsArray',
            unit,
            pieces: [{ id: 'p1', points: squarePts }],
            seams: 'bad',
          },
          steps: 2,
        },
        {
          pattern: {
            name: 'NullSeamElem',
            unit,
            pieces: [{ id: 'p1', points: squarePts }],
            seams: [null],
          },
          steps: 2,
        },
      ];
      for (const [idx, payload] of badSimPayloads.entries()) {
        const r = await postJson('/api/simulate', payload);
        assert.equal(
          r.status,
          400,
          `Expected 400 for /api/simulate (${unit}) malformed case #${idx}, got ${r.status}: ${JSON.stringify(r.json)}`
        );
      }
    }

    // Valid pattern with internalLines + seams simulates cleanly with 200
    const goodInternalSim = await postJson('/api/simulate', {
      pattern: {
        name: 'GoodInternalSim',
        unit: 'mm',
        pieces: [
          {
            id: 'p1',
            points: squarePts,
            internalLines: [{ id: 'l1', points: [{ x: 20, y: 20 }, { x: 80, y: 20 }] }],
          },
        ],
        seams: [{ pieceA: 'p1', edgeA: 0, pieceB: 'p1', internalLineIdB: 'l1', internalSegmentIndexB: 0 }],
      },
      steps: 2,
    });
    assert.equal(goodInternalSim.status, 200);
    assert.equal(goodInternalSim.json.finiteOk, true);
  } finally {
    await srv.stop();
  }
});

test('15. Iteration 6 server regressions: edge.curve, darts, nestingResult numeric coercion, and subfield sweep', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  try {
    const postReq = async (pathname, payload) => {
      const res = await fetch(`${srv.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, text, buf, json };
    };

    const basePiece = {
      id: 'p1',
      name: 'Square',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    };

    // 1. Defect 1: Hostile edges / edge.curve payloads across /api/simulate (mm & cm), /api/nest, /api/export (svg, pdf, dxf)
    const hostileEdgePayloads = [
      { ...basePiece, edges: 'bad' },
      { ...basePiece, edges: ['bad'] },
      { ...basePiece, edges: [{ curve: 'bad' }] },
      { ...basePiece, edges: [{ curve: { cp: { toString: 'nope' } } }] },
      { ...basePiece, edges: [{ curve: { cp: { toString: null, valueOf: null } } }] },
      {
        ...basePiece,
        edges: [{ curve: { type: 'cubic', cp1: { x: { toString: 'nope' }, y: 10 }, cp2: { x: 80, y: 10 } } }],
      },
      {
        ...basePiece,
        edges: [{ curve: { type: 'cubic', cp1: { x: 20, y: 10 }, cp2: 'bad' } }],
      },
      { ...basePiece, edges: [{ curve: { type: 123, cp: { x: 50, y: -10 } } }] },
    ];

    for (const badPiece of hostileEdgePayloads) {
      for (const unit of ['mm', 'cm']) {
        const simRes = await postReq('/api/simulate', {
          pattern: { name: 'BadCurve', unit, pieces: [badPiece] },
          steps: 1,
        });
        assert.equal(simRes.status, 400, `Expected 400 on /api/simulate (${unit}), got ${simRes.status}`);
      }
      const nestRes = await postReq('/api/nest', {
        pattern: { name: 'BadCurve', unit: 'mm', pieces: [badPiece] },
      });
      assert.equal(nestRes.status, 400, `Expected 400 on /api/nest, got ${nestRes.status}`);

      for (const format of ['svg', 'pdf', 'dxf']) {
        const expRes = await postReq('/api/export', {
          format,
          pattern: { name: 'BadCurve', unit: 'mm', pieces: [badPiece] },
        });
        assert.equal(expRes.status, 400, `Expected 400 on /api/export (${format}), got ${expRes.status}`);
      }
    }

    // 2. Defect 2: Hostile darts[] payloads across /api/export (svg, pdf, dxf) and /api/simulate
    const hostileDartPayloads = [
      { ...basePiece, darts: 'bad' },
      { ...basePiece, darts: [null] },
      { ...basePiece, darts: [{ edgeIndex: 0, t: 0.5, widthMm: { toString: 'nope' }, depthMm: 40 }] },
      { ...basePiece, darts: [{ edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: { toString: null, valueOf: null } }] },
      { ...basePiece, darts: [{ edgeIndex: { toString: 'nope' }, t: 0.5, widthMm: 20, depthMm: 40 }] },
      { ...basePiece, darts: [{ edgeIndex: 0, t: '0.5', widthMm: 20, depthMm: 40 }] },
      { ...basePiece, darts: [{ edgeIndex: 0, t: 0.5, widthMm: null, depthMm: 40 }] },
      { ...basePiece, darts: [{ edgeIndex: 0, t: 0.5, widthMm: 20, depthMm: 40, folded: 'false' }] },
    ];

    for (const badPiece of hostileDartPayloads) {
      const simRes = await postReq('/api/simulate', {
        pattern: { name: 'BadDart', unit: 'mm', pieces: [badPiece] },
        steps: 1,
      });
      assert.equal(simRes.status, 400, `Expected 400 on /api/simulate for bad dart, got ${simRes.status}`);

      for (const format of ['svg', 'pdf', 'dxf']) {
        const expRes = await postReq('/api/export', {
          format,
          pattern: { name: 'BadDart', unit: 'mm', pieces: [badPiece] },
        });
        assert.equal(expRes.status, 400, `Expected 400 on /api/export (${format}) for bad dart, got ${expRes.status}`);
      }
    }

    // 3. Defect 3: options.nestingResult numeric strings must not concatenate into huge SVG coordinates
    const stringNestResultRes = await postReq('/api/export', {
      format: 'svg',
      pattern: { name: 'NestStr', unit: 'mm', pieces: [basePiece] },
      options: {
        nestingResult: {
          sheetLengthMm: '500',
          placements: [
            { pieceIndex: '0', x: '10', y: '20', sheetIndex: '1', copyIndex: '0' },
          ],
        },
      },
    });
    assert.ok(
      stringNestResultRes.status === 200 || stringNestResultRes.status === 400,
      `Expected 200 or 400, got ${stringNestResultRes.status}`
    );
    if (stringNestResultRes.status === 200) {
      assert.ok(!stringNestResultRes.text.includes('50020'), 'SVG must not contain string-concatenated 50020');
      const pathMatches = [...stringNestResultRes.text.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(pathMatches.length > 0);
      for (const d of pathMatches) {
        const nums = d.match(/-?\d+(?:\.\d+)?/g) || [];
        for (const numStr of nums) {
          const val = Number(numStr);
          assert.ok(Number.isFinite(val) && Math.abs(val) < 2000, `Unexpected coordinate ${numStr} in path ${d}`);
        }
      }
    }

    const nestedOptsNestResultRes = await postReq('/api/export', {
      format: 'svg',
      pattern: { name: 'NestOptsStr', unit: 'mm', pieces: [basePiece] },
      options: {
        nestingOptions: {
          nestingResult: {
            sheetLengthMm: '500',
            placements: [{ pieceIndex: 0, x: '15', y: '25', sheetIndex: '1' }],
          },
        },
      },
    });
    assert.ok(
      nestedOptsNestResultRes.status === 200 || nestedOptsNestResultRes.status === 400,
      `Expected 200 or 400, got ${nestedOptsNestResultRes.status}`
    );
    if (nestedOptsNestResultRes.status === 200) {
      assert.ok(!nestedOptsNestResultRes.text.includes('50020'));
    }

    for (const badNest of [
      { sheetLengthMm: { toString: 'nope' }, placements: [{ pieceIndex: 0, x: 10, y: 20 }] },
      { sheetLengthMm: 500, placements: [{ pieceIndex: 0, x: '', y: 20 }] },
      { sheetLengthMm: 500, placements: [{ pieceIndex: 0, x: 'bad', y: 20 }] },
    ]) {
      const badNestRes = await postReq('/api/export', {
        format: 'svg',
        pattern: { name: 'BadNest', unit: 'mm', pieces: [basePiece] },
        options: { nestingResult: badNest },
      });
      assert.equal(badNestRes.status, 400);
      assert.match(badNestRes.json.error, /nestingResult/i);
    }

    // 4. Subfield sweep: hostile notches, grainline, placement3D, position, rotationOrigin, seams -> 400 (0 500s)
    const hostileSweepPayloads = [
      { pieces: [{ ...basePiece, notches: [{ edgeIndex: 0, t: { toString: 'nope' }, depthMm: 4 }] }] },
      { pieces: [{ ...basePiece, notches: [null] }] },
      { pieces: [{ ...basePiece, grainline: { angleDeg: 90, start: { x: { toString: 'nope' }, y: 0 } } }] },
      { pieces: [{ ...basePiece, placement3D: { offset: { x: { toString: 'nope' }, y: 0, z: 0 } } }] },
      { pieces: [{ ...basePiece, position: { x: { toString: 'nope' }, y: 0 } }] },
      { pieces: [{ ...basePiece, rotationOrigin: { x: 50, y: { toString: null, valueOf: null } } }] },
      {
        pieces: [basePiece],
        seams: [{ pieceA: { toString: 'nope' }, pieceB: 'p1', edgeA: 0, edgeB: 1 }],
      },
      {
        pieces: [basePiece],
        seams: [{ pieceA: 'p1', pieceB: 'p1', edgeA: { toString: 'nope' }, edgeB: 1 }],
      },
    ];
    for (const badPatternBody of hostileSweepPayloads) {
      const simRes = await postReq('/api/simulate', {
        pattern: { name: 'SweepBad', unit: 'mm', ...badPatternBody },
        steps: 1,
      });
      assert.equal(simRes.status, 400);
      const nestRes = await postReq('/api/nest', {
        pattern: { name: 'SweepBad', unit: 'mm', ...badPatternBody },
      });
      assert.equal(nestRes.status, 400);
      const svgRes = await postReq('/api/export', {
        format: 'svg',
        pattern: { name: 'SweepBad', unit: 'mm', ...badPatternBody },
      });
      assert.equal(svgRes.status, 400);
    }

    // 5. Positive controls: valid quadratic/cubic curves, valid darts, and valid numeric nestingResult return 200
    const validRichPattern = {
      name: 'ValidRich',
      unit: 'mm',
      pieces: [
        {
          id: 'front',
          name: 'Front',
          points: [
            { x: 0, y: 0 },
            { x: 160, y: 0 },
            { x: 160, y: 180 },
            { x: 0, y: 180 },
          ],
          edges: [
            { curve: { type: 'quadratic', cp: { x: 80, y: -15 } } },
            null,
            { curve: { type: 'cubic', cp1: { x: 110, y: 195 }, cp2: { x: 50, y: 195 } } },
            undefined,
          ],
          darts: [{ id: 'waist_dart', edgeIndex: 1, t: 0.5, widthMm: 18, depthMm: 45, folded: false }],
          notches: [{ id: 'n1', edgeIndex: 0, t: 0.5, type: 'v', depthMm: 4 }],
          grainline: { angleDeg: 90, start: { x: 80, y: 20 }, end: { x: 80, y: 160 } },
        },
      ],
    };

    const goodRichSim = await postReq('/api/simulate', {
      pattern: validRichPattern,
      steps: 2,
    });
    assert.equal(goodRichSim.status, 200);
    assert.equal(goodRichSim.json.finiteOk, true);

    const goodRichNest = await postReq('/api/nest', {
      pattern: validRichPattern,
      options: { rollPreset: 'roll_54in' },
    });
    assert.equal(goodRichNest.status, 200);
    assert.equal(goodRichNest.json.nesting.placements.length, 1);

    for (const format of ['svg', 'pdf', 'dxf']) {
      const goodRichExp = await postReq('/api/export', {
        format,
        pattern: validRichPattern,
        options: {
          nestingResult: {
            sheetLengthMm: 500,
            placements: [{ pieceIndex: 0, x: 10, y: 20, sheetIndex: 1, copyIndex: 0 }],
          },
        },
      });
      assert.equal(goodRichExp.status, 200, `Expected 200 for valid rich pattern export (${format})`);
      if (format === 'svg') {
        assert.ok(goodRichExp.text.includes('<svg'));
        assert.ok(!goodRichExp.text.includes('50020'));
      }
    }
  } finally {
    await srv.stop();
  }
});

test('16. Iteration 7 server regressions: heightMm/option sweep, Defect A omitted x/y, Defect B PDF/sim DoS caps, seamAllowance cm/mm consistency', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function postReq(pathname, payload) {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // raw response
    }
    return { status: res.status, text, json, elapsedMs };
  }

  const basePiece = {
    id: 'p1',
    name: 'Rect',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ],
    seamAllowance: 0,
    edges: [{}, {}, {}, {}],
  };

  try {
    // 1. heightMm & option sweep: hostile objects must return 400 (zero 500s)
    const hostileObjs = [{ toString: 'nope' }, { toString: null, valueOf: null }];
    for (const hostile of hostileObjs) {
      const rOpt = await postReq('/api/export', {
        format: 'pdf',
        pattern: { name: 'HeightOpt', unit: 'mm', pieces: [basePiece] },
        options: { pageFormat: 'custom', widthMm: 210, heightMm: hostile },
      });
      assert.equal(rOpt.status, 400, `Expected 400 for hostile options.heightMm, got ${rOpt.status}`);

      const rTop = await postReq('/api/export', {
        format: 'pdf',
        pattern: { name: 'HeightTop', unit: 'mm', pieces: [basePiece] },
        widthMm: 210,
        heightMm: hostile,
      });
      assert.equal(rTop.status, 400, `Expected 400 for hostile body.heightMm, got ${rTop.status}`);

      for (const extraKey of ['scale', 'tileMarginMm', 'tileOverlapMm', 'fontSize', 'lineWidth', 'allowRotate90', 'lockGrainline', 'paginateSheets']) {
        const rExtra = await postReq('/api/export', {
          format: 'pdf',
          pattern: { name: 'ExtraOpt', unit: 'mm', pieces: [basePiece] },
          options: { [extraKey]: hostile },
        });
        assert.equal(rExtra.status, 400, `Expected 400 for hostile options.${extraKey}, got ${rExtra.status}`);
      }
    }

    // __proto__ pollution attempt in top-level body does not crash or pollute Object.prototype
    const protoRes = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"format":"pdf","pattern":{"name":"Proto","unit":"mm","pieces":[{"id":"p1","name":"Rect","points":[{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":80},{"x":0,"y":80}],"seamAllowance":0}]},"__proto__":{"polluted":true}}',
    });
    assert.equal(protoRes.status, 200);
    assert.equal(({}).polluted, undefined);

    // 2. Defect A: omitted x or y in nestingResult.placements -> 400 (never silent 200 zero-area 0.0000)
    const missingCoordCases = [
      [{ pieceId: 'p1', pieceIndex: 0 }],
      [{ pieceId: 'p1', pieceIndex: 0, x: 10 }],
      [{ pieceId: 'p1', pieceIndex: 0, y: 20 }],
    ];
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      for (const placements of missingCoordCases) {
        const r = await postReq('/api/export', {
          format: fmt,
          pattern: { name: 'MissingXY', unit: 'mm', pieces: [basePiece] },
          options: { nestingResult: { placements } },
        });
        assert.equal(r.status, 400, `Expected 400 for ${fmt} missing x/y placements ${JSON.stringify(placements)}, got ${r.status}`);
        assert.match(r.json?.error || '', /placement/i);

        const rNested = await postReq('/api/export', {
          format: fmt,
          pattern: { name: 'MissingXYNested', unit: 'mm', pieces: [basePiece] },
          options: { nestingOptions: { nestingResult: { placements } } },
        });
        assert.equal(rNested.status, 400, `Expected 400 for ${fmt} nestingOptions missing x/y, got ${rNested.status}`);
      }
    }

    // offsetX / offsetY fallback works cleanly when both are finite (non-collapsed)
    const offsetRes = await postReq('/api/export', {
      format: 'svg',
      pattern: { name: 'OffsetXY', unit: 'mm', pieces: [basePiece] },
      options: {
        nestingResult: {
          placements: [{ pieceId: 'p1', pieceIndex: 0, offsetX: 10, offsetY: 20 }],
        },
      },
    });
    assert.equal(offsetRes.status, 200, `Expected 200 for offsetX/offsetY fallback, got ${offsetRes.status}: ${offsetRes.text}`);
    assert.ok(offsetRes.text.includes('<svg'));
    assert.ok(!offsetRes.text.includes('M 0.0000 0.0000 L 0.0000 0.0000'), 'Must not emit zero-area collapsed geometry');

    // 3. Defect B: Unbounded DoS caps on large coordinates, PDF tile explosion, tiny page sizes, and giant cloth sim
    const huge1e6Pattern = {
      name: 'Huge1e6',
      unit: 'mm',
      pieces: [
        {
          id: 'huge',
          name: 'Huge',
          points: [
            { x: 0, y: 0 },
            { x: 1e6, y: 0 },
            { x: 1e6, y: 1e6 },
            { x: 0, y: 1e6 },
          ],
          seamAllowance: 0,
        },
      ],
    };

    const hugePdfRes = await postReq('/api/export', {
      format: 'pdf',
      pattern: huge1e6Pattern,
      options: { pageFormat: 'LETTER' },
    });
    assert.equal(hugePdfRes.status, 400, `Expected 400 for 1e6 PDF export, got ${hugePdfRes.status}`);
    assert.ok(hugePdfRes.elapsedMs < 1000, `Expected 1e6 PDF guard in <1s, took ${hugePdfRes.elapsedMs}ms`);

    const hugeSimRes = await postReq('/api/simulate', {
      pattern: huge1e6Pattern,
      steps: 1,
    });
    assert.equal(hugeSimRes.status, 400, `Expected 400 for 1e6 simulate, got ${hugeSimRes.status}`);
    assert.ok(hugeSimRes.elapsedMs < 1000, `Expected 1e6 simulate guard in <1s, took ${hugeSimRes.elapsedMs}ms`);

    // Medium-huge 40000x40000 mm (within 50m pattern span) still triggers PDF tile cap (>2000 tiles) and sim triangle cap (>50000)
    const tileBombPattern = {
      name: 'TileBomb40m',
      unit: 'mm',
      pieces: [
        {
          id: 'bomb',
          name: 'Bomb',
          points: [
            { x: 0, y: 0 },
            { x: 40000, y: 0 },
            { x: 40000, y: 40000 },
            { x: 0, y: 40000 },
          ],
          seamAllowance: 0,
        },
      ],
    };
    const tileBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: tileBombPattern,
      options: { pageFormat: 'LETTER' },
    });
    assert.equal(tileBombPdf.status, 400);
    assert.match(tileBombPdf.json?.error || '', /tile limit/i);
    assert.ok(tileBombPdf.elapsedMs < 1000);

    const meshBombSim = await postReq('/api/simulate', {
      pattern: tileBombPattern,
      steps: 1,
    });
    assert.equal(meshBombSim.status, 400);
    assert.match(meshBombSim.json?.error || '', /exceeds maximum/i);
    assert.ok(meshBombSim.elapsedMs < 1000);

    // Tiny pageWidthMm / degenerate printable area -> 400 (no silent LETTER fallback or hang)
    for (const badPageOpts of [
      { pageFormat: 'custom', pageWidthMm: 1, pageHeightMm: 297 },
      { pageFormat: 'custom', pageWidthMm: 0.1, pageHeightMm: 297 },
      { pageFormat: 'custom', widthMm: 210, heightMm: 10 },
      { pageFormat: 'LETTER', marginMm: 200 },
    ]) {
      const tinyRes = await postReq('/api/export', {
        format: 'pdf',
        pattern: { name: 'TinyPage', unit: 'mm', pieces: [basePiece] },
        options: badPageOpts,
      });
      assert.equal(tinyRes.status, 400, `Expected 400 for bad PDF page options ${JSON.stringify(badPageOpts)}, got ${tinyRes.status}`);
      assert.ok(tinyRes.elapsedMs < 1000);
    }

    // 4. Consistency of numeric-string seamAllowance/quantity/rotation across mm and cm
    for (const unit of ['mm', 'cm']) {
      const strPiece = {
        id: 'p1',
        name: 'Consistency',
        points:
          unit === 'cm'
            ? [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 8 },
                { x: 0, y: 8 },
              ]
            : basePiece.points,
        seamAllowance: unit === 'cm' ? '1' : '10',
        quantity: '2',
        rotation: '0',
      };
      const unitSvgRes = await postReq('/api/export', {
        format: 'svg',
        pattern: { name: `Cons_${unit}`, unit, pieces: [strPiece] },
      });
      assert.equal(unitSvgRes.status, 200, `Expected 200 for ${unit} string seamAllowance/quantity/rotation, got ${unitSvgRes.status}: ${unitSvgRes.text}`);
    }

    // 5. Positive controls: valid PDF with heightMm/widthMm, valid nestingResult, valid simulation -> 200
    const goodCustomPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'GoodCustomPDF', unit: 'mm', pieces: [basePiece] },
      options: { pageFormat: 'custom', widthMm: 210, heightMm: 297, marginMm: 10, overlapMm: 15 },
    });
    assert.equal(goodCustomPdf.status, 200);
    assert.ok(goodCustomPdf.text.startsWith('%PDF-'));

    const goodSim = await postReq('/api/simulate', {
      templateId: 'tshirt',
      steps: 2,
    });
    assert.equal(goodSim.status, 200);
    assert.equal(goodSim.json?.finiteOk, true);
  } finally {
    await srv.stop();
  }
});

test('17. Iteration 8 server regressions: C1 curve CP bounds, Finding 2 PDF placement bounds, C2 cut-piece cap, C3 sim work budget, D nestingResult.placements', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function postReq(pathname, payload) {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response
    }
    return { status: res.status, text, json, elapsedMs };
  }

  const square100 = {
    id: 'p1',
    name: 'Square100',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    seamAllowance: 0,
  };

  try {
    // 1. Defect C1 & Finding 1: Curve CPs in validateAndSanitizePattern & assertSimulationWithinBounds -> 400 in < 1s
    const curveBombCases = [
      {
        label: 'mm cp=(24000,-24000) maxEdgeLengthMm=8',
        unit: 'mm',
        pts: square100.points,
        cp: { x: 24000, y: -24000 },
        maxEdgeLengthMm: 8,
      },
      {
        label: 'mm cp=(90000,90000) maxEdgeLengthMm=38',
        unit: 'mm',
        pts: square100.points,
        cp: { x: 90000, y: 90000 },
        maxEdgeLengthMm: 38,
      },
      {
        label: 'cm cp=(90000,90000) maxEdgeLengthMm=38',
        unit: 'cm',
        pts: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        cp: { x: 90000, y: 90000 },
        maxEdgeLengthMm: 38,
      },
      {
        label: 'cm cp=(9000,9000) maxEdgeLengthMm=38',
        unit: 'cm',
        pts: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        cp: { x: 9000, y: 9000 },
        maxEdgeLengthMm: 38,
      },
      {
        label: 'cm cp=(2400,-2400) maxEdgeLengthMm=8',
        unit: 'cm',
        pts: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        cp: { x: 2400, y: -2400 },
        maxEdgeLengthMm: 8,
      },
    ];
    for (const c of curveBombCases) {
      const r = await postReq('/api/simulate', {
        pattern: {
          name: 'CurveBomb',
          unit: c.unit,
          pieces: [
            {
              id: 'p1',
              points: c.pts,
              edges: [{ curve: { type: 'quadratic', cp: c.cp } }, {}, {}, {}],
            },
          ],
        },
        maxEdgeLengthMm: c.maxEdgeLengthMm,
        steps: 1,
      });
      assert.equal(r.status, 400, `Expected 400 for C1 ${c.label}, got ${r.status}`);
      assert.ok(r.elapsedMs < 1000, `Expected C1 ${c.label} in <1s, took ${r.elapsedMs}ms`);
    }

    // 2. Reviewer Finding 2: assertExportPdfWithinBounds placement bounds & pieceIndex/pieceId consistency -> 400 in < 1s
    const huge40mPiece = {
      id: 'p1',
      name: 'Huge40m',
      points: [
        { x: 0, y: 0 },
        { x: 40000, y: 0 },
        { x: 40000, y: 40000 },
        { x: 0, y: 40000 },
      ],
      seamAllowance: 0,
    };
    const spoofedPlacementPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'SpoofedPlacement', unit: 'mm', pieces: [huge40mPiece] },
      options: {
        pageFormat: 'LETTER',
        nestingResult: {
          placements: [{ pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, widthMm: 10, heightMm: 10 }],
        },
      },
    });
    assert.equal(spoofedPlacementPdf.status, 400, `Expected 400 for spoofed widthMm/heightMm PDF, got ${spoofedPlacementPdf.status}`);
    assert.match(spoofedPlacementPdf.json?.error || '', /tile limit/i);
    assert.ok(spoofedPlacementPdf.elapsedMs < 1000);

    const mismatchedIndexPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: {
        name: 'MismatchPlacement',
        unit: 'mm',
        pieces: [
          square100,
          { ...huge40mPiece, id: 'p2', name: 'Huge40mP2' },
        ],
      },
      options: {
        pageFormat: 'LETTER',
        nestingResult: {
          placements: [{ pieceIndex: 0, pieceId: 'p2', x: 0, y: 0, widthMm: 10, heightMm: 10 }],
        },
      },
    });
    assert.equal(mismatchedIndexPdf.status, 400, `Expected 400 for mismatched pieceIndex/pieceId PDF, got ${mismatchedIndexPdf.status}`);
    assert.match(mismatchedIndexPdf.json?.error || '', /tile limit/i);
    assert.ok(mismatchedIndexPdf.elapsedMs < 1000);

    // 3. Defect C2: Total cut-piece quantity & piece count cap on /api/nest and /api/export -> 400 in < 1s
    const qtyBombPieces = Array.from({ length: 30 }, (_, idx) => ({
      ...square100,
      id: `q_${idx}`,
      name: `Q_${idx}`,
      quantity: 1000,
    }));
    const qtyNestRes = await postReq('/api/nest', {
      pattern: { name: 'QtyBomb', unit: 'mm', pieces: qtyBombPieces },
    });
    assert.equal(qtyNestRes.status, 400, `Expected 400 for C2 /api/nest, got ${qtyNestRes.status}`);
    assert.ok(qtyNestRes.elapsedMs < 1000);

    const qtyExportPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'QtyBombPdf', unit: 'mm', pieces: qtyBombPieces },
      options: { layout: 'nested' },
    });
    assert.equal(qtyExportPdf.status, 400, `Expected 400 for C2 /api/export pdf nested, got ${qtyExportPdf.status}`);
    assert.ok(qtyExportPdf.elapsedMs < 1000);

    const manyPieces = Array.from({ length: 201 }, (_, idx) => ({
      ...square100,
      id: `m_${idx}`,
      name: `M_${idx}`,
      quantity: 1,
    }));
    const manyNestRes = await postReq('/api/nest', {
      pattern: { name: 'ManyPieces', unit: 'mm', pieces: manyPieces },
    });
    assert.equal(manyNestRes.status, 400);
    assert.ok(manyNestRes.elapsedMs < 1000);

    // 4. Defect C3: Combined simulation work budget (triangles * steps * substeps) -> 400 in < 1s
    const square1100 = {
      id: 'big1100',
      name: 'Square1100',
      points: [
        { x: 0, y: 0 },
        { x: 1100, y: 0 },
        { x: 1100, y: 1100 },
        { x: 0, y: 1100 },
      ],
    };
    const workBomb1100 = await postReq('/api/simulate', {
      pattern: { name: 'WorkBomb1100', unit: 'mm', pieces: [square1100] },
      maxEdgeLengthMm: 8,
      steps: 600,
      substeps: 24,
    });
    assert.equal(workBomb1100.status, 400, `Expected 400 for C3 1100x1100 work bomb, got ${workBomb1100.status}`);
    assert.ok(workBomb1100.elapsedMs < 1000);

    const square500 = {
      id: 'med500',
      name: 'Square500',
      points: [
        { x: 0, y: 0 },
        { x: 500, y: 0 },
        { x: 500, y: 500 },
        { x: 0, y: 500 },
      ],
    };
    const workBomb500 = await postReq('/api/simulate', {
      pattern: { name: 'WorkBomb500', unit: 'mm', pieces: [square500] },
      maxEdgeLengthMm: 8,
      steps: 600,
      substeps: 24,
    });
    assert.equal(workBomb500.status, 400, `Expected 400 for C3 500x500 work-budget bomb, got ${workBomb500.status}`);
    assert.match(workBomb500.json?.error || '', /work budget/i);
    assert.ok(workBomb500.elapsedMs < 1000);

    // 5. Defect D: options.nestingResult missing placements -> 400 (never silent 200 empty export)
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const missingPlacements = await postReq('/api/export', {
        format: fmt,
        pattern: { name: 'MissingPlacements', unit: 'mm', pieces: [square100] },
        options: { nestingResult: { sheetLengthMm: 500 } },
      });
      assert.equal(missingPlacements.status, 400, `Expected 400 for ${fmt} nestingResult missing placements, got ${missingPlacements.status}`);
      assert.match(missingPlacements.json?.error || '', /placements/i);
    }

    // 6. Positive controls: valid curved piece, valid tshirt/hoodie sim at steps=120, and valid nestingResult with placements: [] / placements
    const validCurvedPiece = {
      ...square100,
      edges: [{ curve: { type: 'quadratic', cp: { x: 50, y: -20 } } }, {}, {}, {}],
    };
    const validCurvedSim = await postReq('/api/simulate', {
      pattern: { name: 'ValidCurveSim', unit: 'mm', pieces: [validCurvedPiece] },
      steps: 5,
    });
    assert.equal(validCurvedSim.status, 200);
    assert.equal(validCurvedSim.json?.finiteOk, true);

    const validCurvedPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'ValidCurvePdf', unit: 'mm', pieces: [validCurvedPiece] },
    });
    assert.equal(validCurvedPdf.status, 200);
    assert.ok(validCurvedPdf.text.startsWith('%PDF-'));

    for (const templateId of ['tshirt', 'hoodie']) {
      const tplSim = await postReq('/api/simulate', { templateId, steps: 120 });
      assert.equal(tplSim.status, 200, `Expected 200 for ${templateId} simulation at steps=120, got ${tplSim.status}`);
      assert.equal(tplSim.json?.finiteOk, true);
    }

    const emptyPlacementsSvg = await postReq('/api/export', {
      format: 'svg',
      pattern: { name: 'EmptyPlacements', unit: 'mm', pieces: [square100] },
      options: { nestingResult: { sheetLengthMm: 500, placements: [] } },
    });
    assert.equal(emptyPlacementsSvg.status, 200);
    assert.ok(emptyPlacementsSvg.text.includes('<svg'));

    const validPlacementsPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'ValidPlacements', unit: 'mm', pieces: [square100] },
      options: {
        nestingResult: {
          sheetLengthMm: 500,
          placements: [{ pieceIndex: 0, pieceId: 'p1', x: 10, y: 20 }],
        },
      },
    });
    assert.equal(validPlacementsPdf.status, 200);
    assert.ok(validPlacementsPdf.text.startsWith('%PDF-'));
  } finally {
    await srv.stop();
  }
});

test('18. Iteration 9 server regressions: E1a-E1d, E2, E3 & positive controls', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function postReq(pathname, payload) {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response
    }
    return { status: res.status, text, json, elapsedMs };
  }

  const makeRect = (id, w, h) => ({
    id,
    name: id,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    seamAllowance: 0,
  });

  const square100 = makeRect('p1', 100, 100);

  try {
    // 1. E1a: negative sheetLengthMm / requiredLengthMm rejected with 400; sheetOffsetY uses +20
    const negSheetLen = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'NegSheetLen', unit: 'mm', pieces: [square100] },
      options: {
        nestingResult: {
          sheetLengthMm: -25,
          placements: [{ pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, sheetIndex: 120000 }],
        },
      },
    });
    assert.equal(negSheetLen.status, 400, `Expected 400 for negative sheetLengthMm, got ${negSheetLen.status}`);
    assert.ok(negSheetLen.elapsedMs < 1000);

    const negRequiredLen = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'NegRequiredLen', unit: 'mm', pieces: [square100] },
      options: {
        nestingResult: {
          requiredLengthMm: -10,
          placements: [{ pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, sheetIndex: 0 }],
        },
      },
    });
    assert.equal(negRequiredLen.status, 400, `Expected 400 for negative requiredLengthMm, got ${negRequiredLen.status}`);
    assert.ok(negRequiredLen.elapsedMs < 1000);

    const sheetOffsetBomb = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'SheetOffsetBomb', unit: 'mm', pieces: [square100] },
      options: {
        nestingResult: {
          sheetLengthMm: 20,
          placements: [
            { pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, sheetIndex: 0 },
            { pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, sheetIndex: 120000 },
          ],
        },
      },
    });
    assert.equal(sheetOffsetBomb.status, 400, `Expected 400 for multi-sheet offset bomb, got ${sheetOffsetBomb.status}`);
    assert.ok(sheetOffsetBomb.elapsedMs < 1000);

    // 2. E1b: options.nestingOptions.nestingResult must NOT bypass layout: 'nested' tile bounds
    const fiftyHugePieces = Array.from({ length: 50 }, (_, idx) => makeRect(`huge_${idx}`, 15000, 15000));
    const shadowNestedPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'ShadowNestBypass', unit: 'mm', pieces: fiftyHugePieces },
      options: {
        layout: 'nested',
        nestingOptions: {
          fabricWidthMm: 20000,
          nestingResult: { placements: [] },
        },
      },
    });
    assert.equal(shadowNestedPdf.status, 400, `Expected 400 for shadowed nestingOptions.nestingResult, got ${shadowNestedPdf.status}`);
    assert.ok(shadowNestedPdf.elapsedMs < 1000);

    // 3. E1c: piece.rotationOrigin lever-arm accounted for in PDF bounds
    const rotatedFarPiece = {
      ...makeRect('p_rot', 100, 100),
      rotation: 180,
      rotationOrigin: { x: 40000, y: 40000 },
    };
    const rotOriginBomb = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'RotOriginBomb', unit: 'mm', pieces: [square100, rotatedFarPiece] },
    });
    assert.equal(rotOriginBomb.status, 400, `Expected 400 for rotationOrigin lever-arm PDF bomb, got ${rotOriginBomb.status}`);
    assert.ok(rotOriginBomb.elapsedMs < 1000);

    const validRotOriginPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: {
        name: 'ValidRotOrigin',
        unit: 'mm',
        pieces: [{ ...square100, rotation: 45, rotationOrigin: { x: 50, y: 50 } }],
      },
    });
    assert.equal(validRotOriginPdf.status, 200);
    assert.ok(validRotOriginPdf.text.startsWith('%PDF-'));

    // 4. E1d: notches[].depthMm, grainline.{start,end}, internalLines[].points[], seamAllowance & dart bounds
    const notchBombPiece = {
      ...square100,
      notches: [{ edgeIndex: 0, t: 0.5, depthMm: 80000 }],
    };
    const notchBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'NotchBomb', unit: 'mm', pieces: [notchBombPiece] },
    });
    assert.equal(notchBombPdf.status, 400);
    assert.ok(notchBombPdf.elapsedMs < 1000);

    const grainlineBombPiece = {
      ...square100,
      grainline: { start: { x: 0, y: 0 }, end: { x: 80000, y: 80000 } },
    };
    const grainlineBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'GrainlineBomb', unit: 'mm', pieces: [grainlineBombPiece] },
    });
    assert.equal(grainlineBombPdf.status, 400);
    assert.ok(grainlineBombPdf.elapsedMs < 1000);

    const internalLineBombPiece = {
      ...square100,
      internalLines: [{ id: 'il1', points: [{ x: 0, y: 0 }, { x: 80000, y: 80000 }] }],
    };
    const internalLineBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'InternalLineBomb', unit: 'mm', pieces: [internalLineBombPiece] },
    });
    assert.equal(internalLineBombPdf.status, 400);
    assert.ok(internalLineBombPdf.elapsedMs < 1000);

    // Internal line within MAX_PATTERN_SPAN_MM (40m) must STILL be caught under layout: 'nested'
    const nestedInternalLineOverflow = await postReq('/api/export', {
      format: 'pdf',
      pattern: {
        name: 'NestedInternalLineOverflow',
        unit: 'mm',
        pieces: [{
          ...square100,
          internalLines: [{ id: 'il_ov', points: [{ x: 0, y: 0 }, { x: 40000, y: 40000 }] }],
        }],
      },
      options: { layout: 'nested', fabricWidthMm: 1000 },
    });
    assert.equal(nestedInternalLineOverflow.status, 400);
    assert.ok(nestedInternalLineOverflow.elapsedMs < 1000);

    const saBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'SaBomb', unit: 'mm', pieces: [{ ...square100, seamAllowance: 20000 }] },
    });
    assert.equal(saBombPdf.status, 400);
    assert.ok(saBombPdf.elapsedMs < 1000);

    const edgeSaBombPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: {
        name: 'EdgeSaBomb',
        unit: 'mm',
        pieces: [{ ...square100, edges: [{ seamAllowance: 20000 }, {}, {}, {}] }],
      },
    });
    assert.equal(edgeSaBombPdf.status, 400);
    assert.ok(edgeSaBombPdf.elapsedMs < 1000);

    const dartBombSim = await postReq('/api/simulate', {
      pattern: {
        name: 'DartBomb',
        unit: 'mm',
        pieces: [{ ...square100, darts: [{ edgeIndex: 0, t: 0.5, widthMm: 20000, depthMm: 20000 }] }],
      },
      steps: 1,
    });
    assert.equal(dartBombSim.status, 400);
    assert.ok(dartBombSim.elapsedMs < 1000);

    // 5. E2: bisection-aware simulation bounds catch 400x400/600x600/800x800/890x890 @8mm bombs in <1s
    const simBombCases = [
      { size: 400, steps: 260, substeps: 6 },
      { size: 600, steps: 120, substeps: 6 },
      { size: 800, steps: 120, substeps: 6 },
      { size: 890, steps: 90, substeps: 6 },
    ];
    for (const c of simBombCases) {
      const res = await postReq('/api/simulate', {
        pattern: { name: `SimBomb_${c.size}`, unit: 'mm', pieces: [makeRect(`s_${c.size}`, c.size, c.size)] },
        maxEdgeLengthMm: 8,
        steps: c.steps,
        substeps: c.substeps,
      });
      assert.equal(res.status, 400, `Expected 400 for E2 ${c.size}x${c.size} @8mm (${c.steps}x${c.substeps}), got ${res.status}`);
      assert.ok(res.elapsedMs < 1000, `Expected E2 ${c.size}x${c.size} rejection in <1s, got ${res.elapsedMs}ms`);
    }

    // 6. E3: 12,000-vertex 80x80 circle rejected fast (<1s) on /api/simulate and /api/export
    const circlePts = Array.from({ length: 12000 }, (_, idx) => {
      const a = (idx / 12000) * Math.PI * 2;
      return { x: 40 + 40 * Math.cos(a), y: 40 + 40 * Math.sin(a) };
    });
    const circlePiece = { id: 'circle_12k', name: 'Circle12k', points: circlePts, seamAllowance: 0 };

    const circleSim = await postReq('/api/simulate', {
      pattern: { name: 'CircleSim12k', unit: 'mm', pieces: [circlePiece] },
      steps: 1,
    });
    assert.equal(circleSim.status, 400, `Expected 400 for 12k-vertex simulate, got ${circleSim.status}`);
    assert.ok(circleSim.elapsedMs < 1000, `Expected 12k-vertex simulate rejection in <1s, got ${circleSim.elapsedMs}ms`);

    const circlePdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: 'CirclePdf12k', unit: 'mm', pieces: [circlePiece] },
    });
    assert.equal(circlePdf.status, 400, `Expected 400 for 12k-vertex pdf export, got ${circlePdf.status}`);
    assert.ok(circlePdf.elapsedMs < 1000, `Expected 12k-vertex export rejection in <1s, got ${circlePdf.elapsedMs}ms`);

    // 7. Positive controls: all 5 starter templates at steps=120, substeps=6 + STL unwrap+simulate
    for (const templateId of ['tshirt', 'hoodie', 'pants', 'tote_bag', 'stl_cover']) {
      const tplSim = await postReq('/api/simulate', {
        templateId,
        steps: 120,
        substeps: 6,
      });
      assert.equal(tplSim.status, 200, `Expected 200 for ${templateId} at steps=120, substeps=6, got ${tplSim.status}: ${tplSim.text}`);
      assert.equal(tplSim.json?.finiteOk, true);
    }

    const hoodieMaxSim = await postReq('/api/simulate', {
      templateId: 'hoodie',
      params: { chest: 120, length: 80, shoulderWidth: 54, sleeveLength: 74, hoodHeight: 42 },
      steps: 120,
      substeps: 6,
    });
    assert.equal(hoodieMaxSim.status, 200, `Expected 200 for hoodie max params at 120x6, got ${hoodieMaxSim.status}: ${hoodieMaxSim.text}`);
    assert.equal(hoodieMaxSim.json?.finiteOk, true);

    const unwrapRes = await postReq('/api/unwrap-stl', {
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      mode: 'form_shell_cover',
    });
    assert.equal(unwrapRes.status, 200, `Expected 200 for wedge STL unwrap, got ${unwrapRes.status}: ${unwrapRes.text}`);
    const wedgeSim = await postReq('/api/simulate', {
      pattern: unwrapRes.json.pattern,
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      steps: 120,
      substeps: 6,
    });
    assert.equal(wedgeSim.status, 200, `Expected 200 for wedge STL sim at 120x6, got ${wedgeSim.status}: ${wedgeSim.text}`);
    assert.equal(wedgeSim.json?.finiteOk, true);
  } finally {
    await srv.stop();
  }
});

test('19. Iteration 10 remediation: E1a parity, E2/E3 bounds, STL/param/unwrap parity, worker pool concurrency/timeout/abort & positive controls', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function req(method, pathname, payload, timeoutMs = 540_000) {
    const t0 = Date.now();
    const bodyStr = payload !== undefined ? JSON.stringify(payload) : null;
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postReq = (p, body, timeoutMs) => req('POST', p, body, timeoutMs);

  const makeRect = (id, w, h, sa = 0) => ({
    id,
    name: id,
    points: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    seamAllowance: sa,
  });

  const makeStar = (id, numPoints, rOuter = 120, rInner = 50, sa = 0, qty = 1) => {
    const count = Math.max(4, numPoints);
    const points = Array.from({ length: count }, (_, idx) => {
      const a = (idx / count) * Math.PI * 2;
      const r = idx % 2 === 0 ? rOuter : rInner;
      return { x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) };
    });
    return { id, name: id, points, seamAllowance: sa, quantity: qty };
  };

  const makeCurvedPoly = (id, numEdges, r = 80, sa = 0) => {
    const points = [];
    const edges = [];
    for (let i = 0; i < numEdges; i++) {
      const a0 = (i / numEdges) * Math.PI * 2;
      const aMid = ((i + 0.5) / numEdges) * Math.PI * 2;
      points.push({ x: r + r * Math.cos(a0), y: r + r * Math.sin(a0) });
      edges.push({
        curve: {
          type: 'quadratic',
          cp: { x: r + r * 1.12 * Math.cos(aMid), y: r + r * 1.12 * Math.sin(aMid) },
        },
      });
    }
    return { id, name: id, points, edges, seamAllowance: sa };
  };

  const square100 = makeRect('p1', 100, 100, 0);

  try {
    // 1. E1a: fractional sheetIndex & invalid sheet/fabric/margin bounds across pdf/svg/dxf/nest
    for (const badSheetIdx of [0.9, 1.999]) {
      for (const fmt of ['pdf', 'svg', 'dxf']) {
        const res = await postReq('/api/export', {
          format: fmt,
          pattern: { name: 'FracSheetIdx', unit: 'mm', pieces: [square100] },
          options: {
            nestingResult: {
              sheetLengthMm: 1000,
              placements: [{ pieceIndex: 0, pieceId: 'p1', x: 0, y: 0, sheetIndex: badSheetIdx }],
            },
          },
        });
        assert.equal(res.status, 400, `Expected 400 for fractional sheetIndex=${badSheetIdx} on ${fmt}, got ${res.status}`);
        assert.ok(res.elapsedMs < 1000);
      }
    }

    for (const badOpt of [
      { sheetLengthMm: 5 },
      { sheetLengthMm: 60_000 },
      { fabricWidthMm: 5 },
      { fabricWidthMm: 60_000 },
      { fabricWidthMm: 200, marginMm: 100 },
      { fabricWidthMm: 500, marginMm: -1 },
      { fabricWidthMm: 500, marginMm: 6_000 },
    ]) {
      const nestRes = await postReq('/api/nest', {
        pattern: { name: 'BadNestOpt', unit: 'mm', pieces: [square100] },
        options: badOpt,
      });
      assert.equal(nestRes.status, 400, `Expected 400 on /api/nest for ${JSON.stringify(badOpt)}, got ${nestRes.status}`);
      for (const fmt of ['pdf', 'svg', 'dxf']) {
        const expRes = await postReq('/api/export', {
          format: fmt,
          pattern: { name: 'BadExpOpt', unit: 'mm', pieces: [square100] },
          options: { layout: 'nested', ...badOpt },
        });
        assert.equal(expRes.status, 400, `Expected 400 on /api/export ${fmt} for ${JSON.stringify(badOpt)}, got ${expRes.status}`);
      }
    }

    // 2. E2 bypasses: 512x256 @8mm 300x6, concave stars (1x999 & 5x999), 999-curved circle, oversized stlMesh & 25001-tri binary STL
    const rect512 = await postReq('/api/simulate', {
      pattern: { name: 'E2_512x256', unit: 'mm', pieces: [makeRect('r512', 512, 256)] },
      maxEdgeLengthMm: 8,
      steps: 300,
      substeps: 6,
    });
    assert.equal(rect512.status, 400, `Expected 400 for 512x256 @8mm 300x6, got ${rect512.status}`);
    assert.ok(rect512.elapsedMs < 1000, `Expected <1s rejection for 512x256, got ${rect512.elapsedMs}ms`);

    const star1x999 = await postReq('/api/simulate', {
      pattern: { name: 'Star1x999', unit: 'mm', pieces: [makeStar('s1', 999)] },
      steps: 10,
      substeps: 4,
    });
    assert.equal(star1x999.status, 400);
    assert.ok(star1x999.elapsedMs < 1000);

    const star5x999 = await postReq('/api/simulate', {
      pattern: {
        name: 'Star5x999',
        unit: 'mm',
        pieces: Array.from({ length: 5 }, (_, idx) => makeStar(`s_${idx}`, 999)),
      },
      steps: 10,
      substeps: 4,
    });
    assert.equal(star5x999.status, 400);
    assert.ok(star5x999.elapsedMs < 1000);

    const curved999Sim = await postReq('/api/simulate', {
      pattern: { name: 'Curved999', unit: 'mm', pieces: [makeCurvedPoly('c999', 999, 80, 0)] },
      steps: 10,
      substeps: 4,
    });
    assert.equal(curved999Sim.status, 400);
    assert.ok(curved999Sim.elapsedMs < 1000);

    const hugeStlMesh = {
      triangles: Array.from({ length: 25_001 }, () => [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
      ]),
    };
    const stlMeshSim = await postReq('/api/simulate', {
      pattern: { name: 'StlMesh25k', unit: 'mm', pieces: [square100] },
      stlMesh: hugeStlMesh,
      steps: 1,
    });
    assert.equal(stlMeshSim.status, 400);
    assert.ok(stlMeshSim.elapsedMs < 1000);

    const binStlBuf = Buffer.alloc(84 + 25_001 * 50);
    binStlBuf.write('binary_stl_25001', 0, 'ascii');
    binStlBuf.writeUInt32LE(25_001, 80);
    const binStlB64 = binStlBuf.toString('base64');

    const unwrap25k = await postReq('/api/unwrap-stl', { stlBase64: binStlB64, name: '25001.stl' });
    assert.equal(unwrap25k.status, 400);
    assert.ok(unwrap25k.elapsedMs < 1000);

    const tpl25k = await postReq('/api/generate-template', {
      templateId: 'stl_cover',
      stlBase64: binStlB64,
      stlName: '25001.stl',
    });
    assert.equal(tpl25k.status, 400);
    assert.ok(tpl25k.elapsedMs < 1000);

    const sim25k = await postReq('/api/simulate', {
      pattern: { name: 'SimBinStl25k', unit: 'mm', pieces: [square100] },
      stlBase64: binStlB64,
      steps: 1,
    });
    assert.equal(sim25k.status, 400);
    assert.ok(sim25k.elapsedMs < 1000);

    // 3. E3 bypasses: curved SA=10, 1000-curved SA=0, qty:1000 x 200/500-pt nested, 250/1000-pt star SA=15
    for (const edgeCount of [100, 200, 300]) {
      const pat = { name: `CurvedSa_${edgeCount}`, unit: 'mm', pieces: [makeCurvedPoly('cs', edgeCount, 80, 10)] };
      assert.equal((await postReq('/api/nest', { pattern: pat })).status, 400);
      for (const fmt of ['svg', 'pdf', 'dxf']) {
        const res = await postReq('/api/export', { format: fmt, pattern: pat });
        assert.equal(res.status, 400, `Expected 400 for ${edgeCount} curved edges SA=10 on ${fmt}`);
        assert.ok(res.elapsedMs < 1000);
      }
    }

    {
      const pat1000CurveNoSa = {
        name: 'Curved1000NoSa',
        unit: 'mm',
        pieces: [makeCurvedPoly('c1000', 1000, 80, 0)],
      };
      assert.equal((await postReq('/api/nest', { pattern: pat1000CurveNoSa })).status, 400);
      for (const fmt of ['svg', 'pdf', 'dxf']) {
        const res = await postReq('/api/export', { format: fmt, pattern: pat1000CurveNoSa });
        assert.equal(res.status, 400, `Expected 400 for 1000 curved edges SA=0 on ${fmt}`);
        assert.ok(res.elapsedMs < 1000);
      }
    }

    for (const ptCount of [200, 500]) {
      const patQty = { name: `QtyStar_${ptCount}`, unit: 'mm', pieces: [makeStar('qs', ptCount, 60, 40, 0, 1000)] };
      assert.equal((await postReq('/api/nest', { pattern: patQty })).status, 400);
      for (const fmt of ['svg', 'pdf', 'dxf']) {
        const res = await postReq('/api/export', {
          format: fmt,
          pattern: patQty,
          options: { layout: 'nested' },
        });
        assert.equal(res.status, 400, `Expected 400 for qty=1000 x ${ptCount}-pt nested on ${fmt}`);
        assert.ok(res.elapsedMs < 1000);
      }
    }

    for (const ptCount of [250, 1000]) {
      const patStarSa = { name: `StarSa_${ptCount}`, unit: 'mm', pieces: [makeStar('ss', ptCount, 120, 50, 15, 1)] };
      assert.equal((await postReq('/api/nest', { pattern: patStarSa })).status, 400);
      for (const fmt of ['svg', 'pdf', 'dxf']) {
        const res = await postReq('/api/export', { format: fmt, pattern: patStarSa });
        assert.equal(res.status, 400, `Expected 400 for ${ptCount}-pt star SA=15 on ${fmt}`);
        assert.ok(res.elapsedMs < 1000);
      }
    }

    // 4. Cross-endpoint parity: param & unwrap bounds
    for (const ep of ['/api/generate-template', '/api/patterns/generate']) {
      const badChest = await postReq(ep, {
        templateId: 'tshirt',
        params: { chestMm: 1e9 },
      });
      assert.equal(badChest.status, 400, `Expected 400 for chestMm=1e9 on ${ep}`);
      assert.ok(badChest.elapsedMs < 1000);
    }
    const simBadParam = await postReq('/api/simulate', {
      templateId: 'tshirt',
      params: { chestMm: 1e9 },
      steps: 1,
    });
    assert.equal(simBadParam.status, 400);

    const unwrapBadScale = await postReq('/api/unwrap-stl', {
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      scale: 1e9,
    });
    assert.equal(unwrapBadScale.status, 400);
    assert.ok(unwrapBadScale.elapsedMs < 1000);

    // 5. Worker thread non-blocking concurrency: hoodie 120x6 concurrent with 10x GET /api/health < 250ms
    const hoodiePromise = postReq('/api/simulate', {
      templateId: 'hoodie',
      steps: 120,
      substeps: 6,
    });
    const healthChecks = [];
    for (let i = 0; i < 10; i++) {
      healthChecks.push(req('GET', '/api/health'));
    }
    const [hoodieRes, ...healthResults] = await Promise.all([hoodiePromise, ...healthChecks]);
    assert.equal(hoodieRes.status, 200);
    assert.equal(hoodieRes.json?.finiteOk, true);
    for (let i = 0; i < healthResults.length; i++) {
      assert.equal(healthResults[i].status, 200);
      assert.ok(
        healthResults[i].elapsedMs < 250,
        `Expected /api/health #${i} < 250ms during concurrent sim, got ${healthResults[i].elapsedMs}ms`
      );
    }

    // 6. Legitimate positive controls
    const tplVariants = [
      { id: 'tshirt', min: { chestMm: 750, lengthMm: 520 }, max: { chestMm: 1350, lengthMm: 820 } },
      { id: 'hoodie', min: { chestMm: 800, lengthMm: 540 }, max: { chestMm: 1400, lengthMm: 840 } },
      { id: 'pants', min: { waistMm: 620, hipMm: 840 }, max: { waistMm: 1250, hipMm: 1450 } },
      { id: 'tote_bag', min: { widthMm: 220, heightMm: 260 }, max: { widthMm: 520, heightMm: 560 } },
      { id: 'stl_cover', min: { easeMm: 0 }, max: { easeMm: 30 } },
    ];
    for (const v of tplVariants) {
      for (const p of [v.min, {}, v.max]) {
        const gRes = await postReq('/api/generate-template', { templateId: v.id, params: p });
        assert.equal(gRes.status, 200, `Expected 200 generating ${v.id} with ${JSON.stringify(p)}, got ${gRes.status}: ${gRes.text}`);
        const sRes = await postReq('/api/simulate', { templateId: v.id, params: p, steps: 2, substeps: 4 });
        assert.equal(sRes.status, 200, `Expected 200 simulating ${v.id} with ${JSON.stringify(p)}, got ${sRes.status}: ${sRes.text}`);
        assert.equal(sRes.json?.finiteOk, true);
      }
    }

    const wsList = await req('GET', '/api/workspace-stls');
    assert.equal(wsList.status, 200);
    const stlFiles = wsList.json?.files || [];
    assert.ok(stlFiles.length >= 1);
    for (const f of stlFiles) {
      for (const sc of [0.1, 1.0, 5.0]) {
        const uRes = await postReq('/api/unwrap-stl', { workspaceFile: f.name, scale: sc });
        assert.equal(uRes.status, 200, `Expected 200 unwrapping ${f.name} scale=${sc}, got ${uRes.status}: ${uRes.text}`);
      }
    }

    const pat3000 = { name: 'Rect3000', unit: 'mm', pieces: [makeRect('r3000', 3000, 3000, 0)] };
    assert.equal((await postReq('/api/nest', { pattern: pat3000, options: { fabricWidthMm: 4000 } })).status, 200);
    assert.equal((await postReq('/api/export', { format: 'svg', pattern: pat3000 })).status, 200);
    assert.equal((await postReq('/api/export', { format: 'pdf', pattern: pat3000, options: { format: 'A0' } })).status, 200);
    assert.equal((await postReq('/api/export', { format: 'dxf', pattern: pat3000 })).status, 200);
    const sim3000 = await postReq('/api/simulate', { pattern: pat3000, maxEdgeLengthMm: 100, steps: 2, substeps: 4 });
    assert.equal(sim3000.status, 200);
    assert.equal(sim3000.json?.finiteOk, true);

    const pat1000x24Sa10 = { name: 'Poly1000x24', unit: 'mm', pieces: [makeStar('p24', 24, 30, 22, 10, 1000)] };
    assert.equal((await postReq('/api/nest', { pattern: pat1000x24Sa10 })).status, 200);
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const r = await postReq('/api/export', {
        format: fmt,
        pattern: pat1000x24Sa10,
        options: { layout: 'nested' },
      });
      assert.equal(r.status, 200, `Expected 200 for 1000x24-pt SA=10 ${fmt}, got ${r.status}: ${r.text}`);
    }

    const patCricut = { name: 'Cricut24x12', unit: 'mm', pieces: [makeRect('cricut_p', 120, 80, 10)] };
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const r = await postReq('/api/export', {
        format: fmt,
        pattern: patCricut,
        options: {
          layout: 'nested',
          nestingOptions: { fabricWidthMm: 304.8, sheetLengthMm: 609.6 },
        },
      });
      assert.equal(r.status, 200, `Expected 200 for cricut_24x12 ${fmt}, got ${r.status}: ${r.text}`);
    }
  } finally {
    await srv.stop();
  }

  // 7. Worker timeout (504 + recovery) & early client abort + clean close
  const { server, port } = await startServer({
    host: '127.0.0.1',
    port: 0,
    quiet: true,
    simTimeoutMs: 1200,
  });
  try {
    const tUrl = `http://127.0.0.1:${port}`;
    const timeoutRes = await fetch(`${tUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'hoodie', steps: 120, substeps: 6 }),
    });
    assert.equal(timeoutRes.status, 504, `Expected 504 on simTimeoutMs=1200, got ${timeoutRes.status}`);

    const recoverRes = await fetch(`${tUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: { name: 'TinyRecover', unit: 'mm', pieces: [makeRect('tr', 50, 50, 0)] },
        maxEdgeLengthMm: 40,
        steps: 1,
        substeps: 4,
      }),
    });
    assert.equal(recoverRes.status, 200, `Expected 200 recovery after timeout, got ${recoverRes.status}`);

    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 20);
    await assert.rejects(
      () =>
        fetch(`${tUrl}/api/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: 'hoodie', steps: 200, substeps: 8 }),
          signal: ac.signal,
        }),
      (err) => err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    );
    clearTimeout(abortTimer);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('20. Iteration 11 regressions: export O(N^4) multiplicity, SA=0+dart bounds, internalLines x PDF tiles, malformed stlMesh, hoodie_max qty=20 & surface_panels scale=5.0 120x6 sim', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function req(method, pathname, payload, timeoutMs = 540_000) {
    const t0 = Date.now();
    const bodyStr = payload !== undefined ? JSON.stringify(payload) : null;
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postReq = (p, body, timeoutMs) => req('POST', p, body, timeoutMs);

  const makeStar = (id, numPoints, rOuter = 120, rInner = 50, sa = 0, qty = 1, extra = {}) => {
    const count = Math.max(4, numPoints);
    const points = Array.from({ length: count }, (_, idx) => {
      const a = (idx / count) * Math.PI * 2;
      const r = idx % 2 === 0 ? rOuter : rInner;
      return { x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) };
    });
    return { id, name: id, points, seamAllowance: sa, quantity: qty, ...extra };
  };

  const makeCurvedPoly = (id, numEdges, r = 80, sa = 0, qty = 1, curveType = 'quadratic', extra = {}) => {
    const points = [];
    const edges = [];
    for (let i = 0; i < numEdges; i++) {
      const a0 = (i / numEdges) * Math.PI * 2;
      const a1 = ((i + 1) / numEdges) * Math.PI * 2;
      const aMid = ((i + 0.5) / numEdges) * Math.PI * 2;
      points.push({ x: r + r * Math.cos(a0), y: r + r * Math.sin(a0) });
      if (curveType === 'cubic') {
        edges.push({
          curve: {
            type: 'cubic',
            cp1: { x: r + r * 1.1 * Math.cos((2 * a0 + a1) / 3), y: r + r * 1.1 * Math.sin((2 * a0 + a1) / 3) },
            cp2: { x: r + r * 1.1 * Math.cos((a0 + 2 * a1) / 3), y: r + r * 1.1 * Math.sin((a0 + 2 * a1) / 3) },
          },
        });
      } else {
        edges.push({
          curve: {
            type: 'quadratic',
            cp: { x: r + r * 1.12 * Math.cos(aMid), y: r + r * 1.12 * Math.sin(aMid) },
          },
        });
      }
    }
    return { id, name: id, points, edges, seamAllowance: sa, quantity: qty, ...extra };
  };

  try {
    // 1. Export O(N^4) multiplicity via layout:'nested' quantity AND options.nestingResult.placements
    const star120Nested = makeStar('star120', 120, 120, 50, 10, 500);
    const placements500 = Array.from({ length: 500 }, (_, i) => ({
      pieceIndex: 0,
      pieceId: 'star120',
      x: (i % 20) * 260,
      y: Math.floor(i / 20) * 260,
      sheetIndex: 0,
    }));
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const resQty = await postReq('/api/export', {
        format: fmt,
        pattern: { name: 'Star120Qty500', unit: 'mm', pieces: [star120Nested] },
        options: { layout: 'nested' },
      });
      assert.equal(resQty.status, 400, `Expected 400 for 120-pt star qty=500 nested ${fmt}, got ${resQty.status}`);
      assert.ok(resQty.elapsedMs < 1000, `120-pt star qty=500 ${fmt} took ${resQty.elapsedMs}ms`);

      const resNest = await postReq('/api/export', {
        format: fmt,
        pattern: { name: 'Star120Placements500', unit: 'mm', pieces: [makeStar('star120', 120, 120, 50, 10, 1)] },
        options: { nestingResult: { sheetLengthMm: 8000, placements: placements500 } },
      });
      assert.equal(resNest.status, 400, `Expected 400 for 120-pt star 500 placements ${fmt}, got ${resNest.status}`);
      assert.ok(resNest.elapsedMs < 1000, `120-pt star 500 placements ${fmt} took ${resNest.elapsedMs}ms`);
    }

    // 2. SA=0 + darts cut-clipping & dart-apex bounds across nest/svg/dxf/pdf
    const dartDef = [{ edgeIndex: 0, positionT: 0.5, widthMm: 20, depthMm: 80 }];
    const curved43Dart = makeCurvedPoly('c43d', 43, 5000, 0, 5, 'quadratic', { darts: dartDef });
    const star1000Dart = makeStar('s1000d', 1000, 120, 50, 0, 60, { darts: dartDef });
    const manyDarts = Array.from({ length: 100 }, () => ({ edgeIndex: 0, positionT: 0.5, widthMm: 10, depthMm: 40 }));
    const cubic128Darts = Array.from({ length: 3 }, (_, idx) =>
      makeCurvedPoly(`d100_${idx}`, 128, 300, 0, 1, 'cubic', { darts: manyDarts })
    );

    for (const [label, pieces, layoutOpt] of [
      ['43-curved SA=0+dart qty=5', [curved43Dart], { layout: 'nested' }],
      ['1000-pt SA=0+dart qty=60', [star1000Dart], { layout: 'nested' }],
      ['3x100 darts x 128 cubic SA=0', cubic128Darts, {}],
    ]) {
      const nestRes = await postReq('/api/nest', {
        pattern: { name: label, unit: 'mm', pieces },
      });
      assert.equal(nestRes.status, 400, `Expected 400 on /api/nest for ${label}, got ${nestRes.status}`);
      assert.ok(nestRes.elapsedMs < 1000, `/api/nest ${label} took ${nestRes.elapsedMs}ms`);

      for (const fmt of label === '3x100 darts x 128 cubic SA=0' ? ['svg', 'pdf'] : ['svg', 'dxf', 'pdf']) {
        const expRes = await postReq('/api/export', {
          format: fmt,
          pattern: { name: label, unit: 'mm', pieces },
          options: layoutOpt,
        });
        assert.equal(expRes.status, 400, `Expected 400 on /api/export ${fmt} for ${label}, got ${expRes.status}`);
        assert.ok(expRes.elapsedMs < 1000, `/api/export ${fmt} ${label} took ${expRes.elapsedMs}ms`);
      }
    }

    // Other SA quadratic bounds must still reject 400
    for (const [label, piece] of [
      ['1000x200 SA=10', makeStar('s200', 200, 120, 50, 10, 1000)],
      ['1000x150 SA=10', makeStar('s150', 150, 120, 50, 10, 1000)],
      ['50x24-curved SA=10', makeCurvedPoly('c24', 24, 5000, 10, 50, 'quadratic')],
    ]) {
      const res = await postReq('/api/export', {
        format: 'svg',
        pattern: { name: label, unit: 'mm', pieces: [piece] },
        options: { layout: 'nested' },
      });
      assert.equal(res.status, 400, `Expected 400 for ${label}, got ${res.status}`);
      assert.ok(res.elapsedMs < 1000);
    }

    // 3. internalLines point cap & PDF tile emission bound + 1000x24-pt SA=10 positive control
    const makeWideRectWithLines = (id, lineCount, ptsPerLine) => ({
      id,
      name: id,
      points: [
        { x: 0, y: 0 },
        { x: 40000, y: 0 },
        { x: 40000, y: 400 },
        { x: 0, y: 400 },
      ],
      seamAllowance: 0,
      internalLines: Array.from({ length: lineCount }, (_, l) => ({
        type: 'grain',
        points: Array.from({ length: ptsPerLine }, (__, p) => ({
          x: (p / Math.max(1, ptsPerLine - 1)) * 40000,
          y: 10 + (l % 30) * 10,
        })),
      })),
    });

    for (const [label, linesPerPiece] of [
      ['10x50x500 internalLines', 50],
      ['10x5x500 internalLines', 5],
    ]) {
      const pieces = Array.from({ length: 10 }, (_, idx) => makeWideRectWithLines(`il_${idx}`, linesPerPiece, 500));
      const res = await postReq('/api/export', {
        format: 'pdf',
        pattern: { name: label, unit: 'mm', pieces },
      });
      assert.equal(res.status, 400, `Expected 400 for ${label} PDF, got ${res.status}`);
      assert.ok(res.elapsedMs < 1000, `${label} PDF took ${res.elapsedMs}ms`);
    }

    const ok1000x24 = await postReq('/api/export', {
      format: 'pdf',
      pattern: { name: '1000x24 SA=10', unit: 'mm', pieces: [makeStar('s24', 24, 120, 50, 10, 1000)] },
      options: { layout: 'nested' },
    });
    assert.equal(ok1000x24.status, 200, `Expected 200 for 1000x24-pt SA=10 nested PDF, got ${ok1000x24.status}: ${ok1000x24.text}`);

    // 4. Malformed stlMesh must reject 400 INVALID_STL (not fall back to avatar)
    const badStlMeshRes = await postReq('/api/simulate', {
      templateId: 'hoodie',
      stlMesh: { faces: [[0, 1, 2]], vertices: 'not-an-array' },
      steps: 20,
      substeps: 2,
    });
    assert.equal(badStlMeshRes.status, 400, `Expected 400 for malformed stlMesh, got ${badStlMeshRes.status}`);
    assert.ok(badStlMeshRes.elapsedMs < 1000);

    // 5. E2 512x256 @8mm (300x6) must still reject 400
    const simE2 = await postReq('/api/simulate', {
      pattern: {
        name: 'Rect512x256',
        unit: 'mm',
        pieces: [{ id: 'r1', name: 'r1', points: [{ x: 0, y: 0 }, { x: 512, y: 0 }, { x: 512, y: 256 }, { x: 0, y: 256 }], seamAllowance: 0 }],
      },
      maxEdgeLengthMm: 8,
      steps: 300,
      substeps: 6,
    });
    assert.equal(simE2.status, 400, `Expected 400 for 512x256 @8mm 300x6, got ${simE2.status}`);
    assert.ok(simE2.elapsedMs < 1000);

    // 6. Positive control: hoodie UI-max sliders + qty=20 across /api/nest and /api/export (nested svg/pdf/dxf) -> 200
    const hoodieMaxRes = await postReq('/api/generate-template', {
      templateId: 'hoodie',
      params: {
        chestMm: 1480,
        lengthMm: 920,
        shoulderWidthMm: 620,
        sleeveLengthMm: 740,
        hoodHeightMm: 460,
        hoodDepthMm: 360,
        easeMm: 280,
        seamAllowance: 30,
      },
    });
    assert.equal(hoodieMaxRes.status, 200);
    const hoodieMaxPattern = {
      ...hoodieMaxRes.json.pattern,
      pieces: hoodieMaxRes.json.pattern.pieces.map((p) => ({ ...p, quantity: 20 })),
    };
    const hoodieNest = await postReq('/api/nest', { pattern: hoodieMaxPattern });
    assert.equal(hoodieNest.status, 200, `Expected 200 for hoodie_max qty=20 /api/nest, got ${hoodieNest.status}: ${hoodieNest.text}`);
    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const hoodieExp = await postReq('/api/export', {
        format: fmt,
        pattern: hoodieMaxPattern,
        options: { layout: 'nested' },
      });
      assert.equal(hoodieExp.status, 200, `Expected 200 for hoodie_max qty=20 nested ${fmt}, got ${hoodieExp.status}: ${hoodieExp.text}`);
    }

    // 7. Positive control: cutting_mat_wedge_assembled_view.stl surface_panels scale=5.0 unwrap + 120x6 sim -> 200 & finiteOk:true
    assert.ok(fs.existsSync(WEDGE_ASSEMBLED_STL), 'cutting_mat_wedge_assembled_view.stl missing');
    const spUnwrap = await postReq('/api/unwrap-stl', {
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      mode: 'surface_panels',
      scale: 5.0,
      easeMm: 2,
      thicknessMm: 1.5,
      seamAllowance: 10,
    });
    assert.equal(spUnwrap.status, 200, `Expected 200 for surface_panels scale=5.0 unwrap, got ${spUnwrap.status}: ${spUnwrap.text}`);

    const simPromise = postReq('/api/simulate', {
      pattern: spUnwrap.json.pattern,
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      steps: 120,
      substeps: 6,
    });
    // Verify /api/health stays non-blocked (< 200ms) while heavy worker sim runs
    await new Promise((r) => setTimeout(r, 500));
    const healthDuringSim = await req('GET', '/api/health');
    assert.equal(healthDuringSim.status, 200);
    assert.ok(healthDuringSim.elapsedMs < 200, `Expected /api/health < 200ms during sim, got ${healthDuringSim.elapsedMs}ms`);

    const spSim = await simPromise;
    assert.equal(spSim.status, 200, `Expected 200 for surface_panels scale=5.0 120x6 sim, got ${spSim.status}: ${spSim.text}`);
    assert.equal(spSim.json?.finiteOk, true);
  } finally {
    await srv.stop();
  }
});

test('21. Gate 11 regressions: PDF notch/vertex tile-bombs, stlMesh bypasses & array vertices, 32-pt multiplicity, SA=0+dart bounds, nestingResult roundtrip & concurrent 2-worker scale=5.0 sims', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function req(method, pathname, payload, timeoutMs = 540_000) {
    const t0 = Date.now();
    const bodyStr = payload !== undefined ? JSON.stringify(payload) : null;
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postReq = (p, body, timeoutMs) => req('POST', p, body, timeoutMs);

  const makeStar = (id, numPoints, rOuter = 120, rInner = 50, sa = 0, qty = 1, extra = {}) => {
    const count = Math.max(4, numPoints);
    const points = Array.from({ length: count }, (_, idx) => {
      const a = (idx / count) * Math.PI * 2;
      const r = idx % 2 === 0 ? rOuter : rInner;
      return { x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) };
    });
    return { id, name: id, points, seamAllowance: sa, quantity: qty, ...extra };
  };

  const makeCurvedPoly = (id, numEdges, r = 80, sa = 0, qty = 1, extra = {}) => {
    const points = [];
    const edges = [];
    for (let i = 0; i < numEdges; i++) {
      const a0 = (i / numEdges) * Math.PI * 2;
      const a1 = ((i + 1) / numEdges) * Math.PI * 2;
      points.push({ x: r + r * Math.cos(a0), y: r + r * Math.sin(a0) });
      edges.push({
        curve: {
          type: 'cubic',
          cp1: { x: r + r * 1.1 * Math.cos((2 * a0 + a1) / 3), y: r + r * 1.1 * Math.sin((2 * a0 + a1) / 3) },
          cp2: { x: r + r * 1.1 * Math.cos((a0 + 2 * a1) / 3), y: r + r * 1.1 * Math.sin((a0 + 2 * a1) / 3) },
        },
      });
    }
    return { id, name: id, points, edges, seamAllowance: sa, quantity: qty, ...extra };
  };

  const makeSpanningQuad = (id, sizeMm, notchCount = 0, vertexCount = 4) => {
    const points = [];
    const perSide = Math.max(1, Math.floor(vertexCount / 4));
    for (let i = 0; i < perSide; i++) points.push({ x: (i / perSide) * sizeMm, y: 0 });
    for (let i = 0; i < perSide; i++) points.push({ x: sizeMm, y: (i / perSide) * sizeMm });
    for (let i = 0; i < perSide; i++) points.push({ x: sizeMm * (1 - i / perSide), y: sizeMm });
    for (let i = 0; i < perSide; i++) points.push({ x: 0, y: sizeMm * (1 - i / perSide) });
    const notches = Array.from({ length: notchCount }, (_, idx) => ({
      edgeIndex: idx % points.length,
      t: 0.5,
      type: 'single',
    }));
    return { id, name: id, points, notches, seamAllowance: 0, quantity: 1 };
  };

  try {
    // 1. PDF tile-bomb DoS via notches & contour vertices across LETTER tiles + positive controls
    const notchBombPattern = {
      name: 'pdf_notch_bomb',
      unit: 'mm',
      pieces: Array.from({ length: 10 }, (_, i) => makeSpanningQuad(`nb_${i}`, 9000, 200, 4)),
    };
    const notchBombRes = await postReq('/api/export', {
      format: 'pdf',
      pattern: notchBombPattern,
      options: { layout: 'cad', pageFormat: 'LETTER' },
    });
    assert.equal(notchBombRes.status, 400, `Expected 400 for 10x200 PDF notch tile-bomb, got ${notchBombRes.status}`);
    assert.ok(notchBombRes.elapsedMs < 1000, `PDF notch tile-bomb took ${notchBombRes.elapsedMs}ms`);

    const vertBombPattern = {
      name: 'pdf_vert_bomb',
      unit: 'mm',
      pieces: Array.from({ length: 10 }, (_, i) => makeSpanningQuad(`vb_${i}`, 9000, 0, 500)),
    };
    const vertBombRes = await postReq('/api/export', {
      format: 'pdf',
      pattern: vertBombPattern,
      options: { layout: 'cad', pageFormat: 'LETTER' },
    });
    assert.equal(vertBombRes.status, 400, `Expected 400 for 10x500 PDF vertex tile-bomb, got ${vertBombRes.status}`);
    assert.ok(vertBombRes.elapsedMs < 1000, `PDF vertex tile-bomb took ${vertBombRes.elapsedMs}ms`);

    // Positive control: 1000 x 24-pt SA=10 nested LETTER PDF -> 200
    const safe24NestPdf = await postReq('/api/export', {
      format: 'pdf',
      pattern: {
        name: 'safe_24pt_1000',
        unit: 'mm',
        pieces: [makeStar('s24', 24, 60, 30, 10, 1000)],
      },
      options: { layout: 'nested', pageFormat: 'LETTER' },
    });
    assert.equal(safe24NestPdf.status, 200, `Expected 200 for 1000x24-pt nested PDF, got ${safe24NestPdf.status}: ${safe24NestPdf.text}`);

    // 2. validateSimulationStlMesh bypasses + array-form [x,y,z] vertex normalization
    const tinyCloth = {
      name: 'tiny_cloth',
      unit: 'mm',
      pieces: [
        {
          id: 'patch',
          name: 'Patch',
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 60 },
            { x: 0, y: 60 },
          ],
          placement3D: { offset: { x: 0, y: 80, z: 0 }, normal: { x: 0, y: 1, z: 0 } },
        },
      ],
    };

    const badStlPayloads = [
      { triangles: [] },
      { faces: [], vertices: [[0, 0, 0], [50, 0, 0], [0, 50, 0]] },
      { faces: [[0, 1, 2]], vertices: [[0, 0, 0], [50, 0, 0]] },
      {
        triangles: [],
        faces: [[0, 1, 2]],
        vertices: [
          { x: 0, y: 0, z: 0 },
          { x: 50, y: 0, z: 0 },
          { x: 0, y: 50, z: 0 },
        ],
      },
    ];
    for (const badMesh of badStlPayloads) {
      const r = await postReq('/api/simulate', {
        pattern: tinyCloth,
        stlMesh: badMesh,
        steps: 5,
        substeps: 4,
      });
      assert.equal(r.status, 400, `Expected 400 INVALID_STL for ${JSON.stringify(badMesh)}, got ${r.status}`);
    }

    // Positive controls: array-form [x,y,z] vertices in faces & triangles -> 200 with non-null stlBounds
    const arrayFacesRes = await postReq('/api/simulate', {
      pattern: tinyCloth,
      stlMesh: {
        vertices: [
          [0, 0, 0],
          [80, 0, 0],
          [0, 80, 0],
          [0, 0, 80],
        ],
        faces: [
          [0, 1, 2],
          [0, 1, 3],
          [1, 2, 3],
          [2, 0, 3],
        ],
      },
      steps: 10,
      substeps: 4,
    });
    assert.equal(arrayFacesRes.status, 200, `Expected 200 for array-form faces stlMesh, got ${arrayFacesRes.status}: ${arrayFacesRes.text}`);
    assert.ok(arrayFacesRes.json?.stlBounds !== null && arrayFacesRes.json?.stlBounds !== undefined, 'Expected non-null stlBounds for array-form faces');
    assert.equal(arrayFacesRes.json?.finiteOk, true);

    const arrayTrisRes = await postReq('/api/simulate', {
      pattern: tinyCloth,
      stlMesh: {
        triangles: [
          [[0, 0, 0], [80, 0, 0], [0, 80, 0]],
          [[0, 0, 0], [80, 0, 0], [0, 0, 80]],
          [[80, 0, 0], [0, 80, 0], [0, 0, 80]],
          [[0, 80, 0], [0, 0, 0], [0, 0, 80]],
        ],
      },
      steps: 10,
      substeps: 4,
    });
    assert.equal(arrayTrisRes.status, 200, `Expected 200 for array-form triangles stlMesh, got ${arrayTrisRes.status}: ${arrayTrisRes.text}`);
    assert.ok(arrayTrisRes.json?.stlBounds !== null && arrayTrisRes.json?.stlBounds !== undefined, 'Expected non-null stlBounds for array-form triangles');
    assert.equal(arrayTrisRes.json?.finiteOk, true);

    // 3. Export O(N^4) multiplicity bypass for rawPoints <= 32 (32-pt star x 1875 & qty=1000) -> 400 < 1s
    const star32Piece = makeStar('star32', 32, 120, 50, 10, 1);
    const star1875Placements = Array.from({ length: 1875 }, (_, i) => ({
      pieceId: 'star32',
      pieceIndex: 0,
      sheetIndex: 0,
      x: (i % 50) * 300,
      y: Math.floor(i / 50) * 300,
      rotationDeg: 0,
      widthMm: 260,
      heightMm: 260,
    }));
    const exp1875P = postReq('/api/export', {
      format: 'svg',
      pattern: { name: 'star32_x1875', unit: 'mm', pieces: [star32Piece] },
      options: {
        layout: 'nested',
        nestingResult: {
          sheetCount: 1,
          sheetLengthMm: 20000,
          fabricWidthMm: 20000,
          placements: star1875Placements,
        },
      },
    });
    const healthStar = await req('GET', '/api/health');
    assert.equal(healthStar.status, 200);
    assert.ok(healthStar.elapsedMs < 100, `Expected /api/health < 100ms during rejected 32-pt x1875 check, got ${healthStar.elapsedMs}ms`);
    const exp1875 = await exp1875P;
    assert.equal(exp1875.status, 400, `Expected 400 for 32-pt star x1875 SVG, got ${exp1875.status}`);
    assert.ok(exp1875.elapsedMs < 1000, `32-pt star x1875 took ${exp1875.elapsedMs}ms`);

    for (const fmt of ['svg', 'pdf', 'dxf']) {
      const exp1000 = await postReq('/api/export', {
        format: fmt,
        pattern: { name: 'star32_1000', unit: 'mm', pieces: [makeStar('s32', 32, 80, 35, 10, 1000)] },
        options: { layout: 'nested', pageFormat: 'LETTER' },
      });
      assert.equal(exp1000.status, 400, `Expected 400 for 32-pt star qty=1000 nested ${fmt}, got ${exp1000.status}`);
      assert.ok(exp1000.elapsedMs < 1000, `32-pt star qty=1000 nested ${fmt} took ${exp1000.elapsedMs}ms`);
    }

    // 4. SA=0 + dart boundary freeze & /api/simulate pre-check spike + pants positive control
    const bigDartList = Array.from({ length: 42 }, (_, idx) => ({
      edgeIndex: idx % 32,
      t: ((idx % 5) + 1) / 6,
      widthMm: 18,
      depthMm: 9999,
      foldDirection: 'left',
    }));
    const dartBombPattern = {
      name: 'sa0_dart_bomb',
      unit: 'mm',
      pieces: [makeCurvedPoly('db', 9, 100, 0, 2, { darts: bigDartList })],
    };
    const nestDartBomb = await postReq('/api/nest', { pattern: dartBombPattern });
    assert.equal(nestDartBomb.status, 400, `Expected 400 for 42-dart SA=0 /api/nest, got ${nestDartBomb.status}`);
    assert.ok(nestDartBomb.elapsedMs < 1000, `42-dart /api/nest took ${nestDartBomb.elapsedMs}ms`);

    for (const fmt of ['svg', 'pdf']) {
      const expDartBomb = await postReq('/api/export', {
        format: fmt,
        pattern: dartBombPattern,
        options: { layout: 'nested', pageFormat: 'LETTER' },
      });
      assert.equal(expDartBomb.status, 400, `Expected 400 for 42-dart SA=0 /api/export ${fmt}, got ${expDartBomb.status}`);
      assert.ok(expDartBomb.elapsedMs < 1000, `42-dart /api/export ${fmt} took ${expDartBomb.elapsedMs}ms`);
    }

    const simDartSpikePattern = {
      name: 'sim_1000cubic_100dart',
      unit: 'mm',
      pieces: [
        makeCurvedPoly('big_c', 1000, 120, 0, 1, {
          darts: Array.from({ length: 100 }, (_, i) => ({
            edgeIndex: i * 10,
            t: 0.5,
            widthMm: 10,
            depthMm: 50,
            foldDirection: 'left',
          })),
        }),
      ],
    };
    const simSpikeRes = await postReq('/api/simulate', { pattern: simDartSpikePattern, steps: 20, substeps: 4 });
    assert.equal(simSpikeRes.status, 400, `Expected 400 for 1000-cubic 100-dart /api/simulate, got ${simSpikeRes.status}`);
    assert.ok(simSpikeRes.elapsedMs < 200, `1000-cubic 100-dart /api/simulate took ${simSpikeRes.elapsedMs}ms`);

    const pantsGen = await postReq('/api/generate-template', { templateId: 'pants', params: {} });
    assert.equal(pantsGen.status, 200);
    const pantsSim = await postReq('/api/simulate', { pattern: pantsGen.json.pattern, steps: 10, substeps: 4 });
    assert.equal(pantsSim.status, 200, `Expected 200 for pants sim positive control, got ${pantsSim.status}: ${pantsSim.text}`);
    assert.equal(pantsSim.json?.finiteOk, true);

    // 5. hoodie_max qty=20 /api/nest -> /api/export { nestingResult } 200 roundtrip + LETTER/A4/A0 PDFs
    const hoodieMaxRes = await postReq('/api/generate-template', {
      templateId: 'hoodie',
      params: {
        chestMm: 1480,
        lengthMm: 920,
        shoulderWidthMm: 620,
        sleeveLengthMm: 740,
        hoodHeightMm: 460,
        hoodDepthMm: 360,
        easeMm: 280,
        seamAllowance: 30,
      },
    });
    assert.equal(hoodieMaxRes.status, 200);
    const hoodieMaxPattern = {
      ...hoodieMaxRes.json.pattern,
      pieces: hoodieMaxRes.json.pattern.pieces.map((p) => ({ ...p, quantity: 20 })),
    };

    for (const rollPreset of ['roll_45in', 'roll_60in']) {
      const nestRes = await postReq('/api/nest', {
        pattern: hoodieMaxPattern,
        options: { rollPreset },
      });
      assert.equal(nestRes.status, 200, `Expected 200 for hoodie_max qty=20 ${rollPreset}, got ${nestRes.status}`);
      const nestObj = nestRes.json?.nesting;
      assert.ok(
        nestObj?.sheets?.[0]?.usedLengthMm > 50_000,
        `Expected nesting.sheets[0].usedLengthMm > 50000 for ${rollPreset}, got ${nestObj?.sheets?.[0]?.usedLengthMm}`
      );
      const roundtripPdf = await postReq('/api/export', {
        format: 'pdf',
        pattern: hoodieMaxPattern,
        options: {
          layout: 'nested',
          pageFormat: 'LETTER',
          nestingResult: nestObj,
        },
      });
      assert.equal(
        roundtripPdf.status,
        200,
        `Expected 200 for /api/nest -> /api/export { nestingResult } ${rollPreset} roundtrip, got ${roundtripPdf.status}: ${roundtripPdf.text}`
      );
      assert.ok(roundtripPdf.text.startsWith('%PDF'), 'Expected PDF output from roundtrip');
    }

    for (const pageFormat of ['LETTER', 'A4', 'A0']) {
      const hmPdf = await postReq('/api/export', {
        format: 'pdf',
        pattern: hoodieMaxPattern,
        options: { layout: 'nested', pageFormat },
      });
      assert.equal(hmPdf.status, 200, `Expected 200 for hoodie_max qty=20 nested ${pageFormat} PDF, got ${hmPdf.status}`);
    }

    // 6. Concurrent 2-worker surface_panels scale=5.0 simulation: print_ready 120x6 + assembled_view 60x6
    const WEDGE_PRINT_READY_STL = path.join(WORKSPACE_ROOT, 'cutting_mat_wedge_print_ready.stl');
    assert.ok(fs.existsSync(WEDGE_PRINT_READY_STL), 'cutting_mat_wedge_print_ready.stl missing');
    assert.ok(fs.existsSync(WEDGE_ASSEMBLED_STL), 'cutting_mat_wedge_assembled_view.stl missing');

    const prUnwrap = await postReq('/api/unwrap-stl', {
      workspaceFile: 'cutting_mat_wedge_print_ready.stl',
      mode: 'surface_panels',
      scale: 5.0,
      easeMm: 2,
      thicknessMm: 1.5,
      seamAllowance: 10,
    });
    assert.equal(prUnwrap.status, 200, `Expected 200 for print_ready scale=5.0 unwrap, got ${prUnwrap.status}`);

    const avUnwrap = await postReq('/api/unwrap-stl', {
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      mode: 'surface_panels',
      scale: 5.0,
      easeMm: 2,
      thicknessMm: 1.5,
      seamAllowance: 10,
    });
    assert.equal(avUnwrap.status, 200, `Expected 200 for assembled_view scale=5.0 unwrap, got ${avUnwrap.status}`);

    const prSimP = postReq('/api/simulate', {
      pattern: prUnwrap.json.pattern,
      workspaceFile: 'cutting_mat_wedge_print_ready.stl',
      steps: 120,
      substeps: 6,
    });
    const avSimP = postReq('/api/simulate', {
      pattern: avUnwrap.json.pattern,
      workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
      steps: 60,
      substeps: 6,
    });

    await new Promise((r) => setTimeout(r, 800));
    const health2Workers = await req('GET', '/api/health');
    assert.equal(health2Workers.status, 200);
    assert.ok(
      health2Workers.elapsedMs < 200,
      `Expected /api/health < 200ms while 2 worker sims run, got ${health2Workers.elapsedMs}ms`
    );

    const [prSim, avSim] = await Promise.all([prSimP, avSimP]);
    assert.equal(prSim.status, 200, `Expected 200 for print_ready scale=5.0 120x6 sim, got ${prSim.status}: ${prSim.text}`);
    assert.equal(prSim.json?.finiteOk, true);
    assert.equal(avSim.status, 200, `Expected 200 for assembled_view scale=5.0 60x6 sim, got ${avSim.status}: ${avSim.text}`);
    assert.equal(avSim.json?.finiteOk, true);
  } finally {
    await srv.stop();
  }
});

test('22. Gate 12 regressions: curved rawPoints<=24 SA copy budget, 100k PDF tile-intersection cap, export worker pool non-blocking /api/health < 200ms & hoodie_max qty=20 positive controls', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function req(method, pathname, payload, timeoutMs = 180_000) {
    const t0 = Date.now();
    const bodyStr = payload !== undefined ? JSON.stringify(payload) : null;
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postReq = (p, body, timeoutMs) => req('POST', p, body, timeoutMs);

  async function withHealthPolling(fn) {
    let maxHealthMs = 0;
    let healthErrors = 0;
    let running = true;
    const poll = (async () => {
      while (running) {
        try {
          const h = await req('GET', '/api/health', undefined, 5000);
          if (h.status !== 200) healthErrors++;
          if (h.elapsedMs > maxHealthMs) maxHealthMs = h.elapsedMs;
        } catch {
          healthErrors++;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
    try {
      const result = await fn();
      return { result, maxHealthMs, healthErrors };
    } finally {
      running = false;
      await poll;
    }
  }

  const makeStar = (id, numPoints, rOuter = 120, rInner = 50, sa = 0, qty = 1) => {
    const points = Array.from({ length: numPoints }, (_, idx) => {
      const a = (idx / numPoints) * Math.PI * 2;
      const r = idx % 2 === 0 ? rOuter : rInner;
      return { x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) };
    });
    return { id, name: id, points, seamAllowance: sa, quantity: qty };
  };

  const makeCurvedStar = (id, numPairs, rOuter = 50, rInner = 8, sa = 40, qty = 48) => {
    const count = numPairs * 2;
    const points = [];
    const edges = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = i % 2 === 0 ? rOuter : rInner;
      points.push({ x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) });
    }
    for (let i = 0; i < count; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % count];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      edges.push({
        curve: {
          type: 'cubic',
          cp1: { x: p0.x + dx * 0.3 - dy * 0.25, y: p0.y + dy * 0.3 + dx * 0.25 },
          cp2: { x: p0.x + dx * 0.7 + dy * 0.25, y: p0.y + dy * 0.7 - dx * 0.25 },
        },
      });
    }
    return { id, name: id, points, edges, seamAllowance: sa, quantity: qty };
  };

  const makeCurvedConvex = (id, numEdges, r = 80, sa = 40, qty = 48) => {
    const points = [];
    const edges = [];
    for (let i = 0; i < numEdges; i++) {
      const a0 = (i / numEdges) * Math.PI * 2;
      const a1 = ((i + 1) / numEdges) * Math.PI * 2;
      points.push({ x: r + r * Math.cos(a0), y: r + r * Math.sin(a0) });
      edges.push({
        curve: {
          type: 'cubic',
          cp1: { x: r + r * 1.1 * Math.cos((2 * a0 + a1) / 3), y: r + r * 1.1 * Math.sin((2 * a0 + a1) / 3) },
          cp2: { x: r + r * 1.1 * Math.cos((a0 + 2 * a1) / 3), y: r + r * 1.1 * Math.sin((a0 + 2 * a1) / 3) },
        },
      });
    }
    return { id, name: id, points, edges, seamAllowance: sa, quantity: qty };
  };

  try {
    // 1. Defect 1: curved rawPoints <= 24 SA > 0 high-copy / multi-placement explosions -> 400 < 500ms & health < 200ms
    const curvedStar48 = makeCurvedStar('cs10_48', 5, 50, 8, 40, 48);
    const curvedPlacements48 = Array.from({ length: 48 }, (_, i) => ({
      pieceIndex: 0,
      pieceId: 'cs10_1',
      x: (i % 8) * 200,
      y: Math.floor(i / 8) * 200,
      sheetIndex: 0,
      widthMm: 180,
      heightMm: 180,
    }));
    for (const [label, body] of [
      ['10pt curved star SA=40 qty=48', { format: 'svg', pattern: { name: 'cs10_q48', unit: 'mm', pieces: [curvedStar48] }, options: { layout: 'nested' } }],
      ['10pt curved star SA=40 48 placements', { format: 'svg', pattern: { name: 'cs10_p48', unit: 'mm', pieces: [{ ...curvedStar48, id: 'cs10_1', quantity: 1 }] }, options: { layout: 'nested', nestingResult: { sheetLengthMm: 2000, placements: curvedPlacements48 } } }],
      ['10pt curved convex SA=40 qty=48', { format: 'svg', pattern: { name: 'cc10_40', unit: 'mm', pieces: [makeCurvedConvex('cc10_40', 10, 80, 40, 48)] }, options: { layout: 'nested' } }],
      ['10pt curved convex SA=10 qty=48', { format: 'svg', pattern: { name: 'cc10_10', unit: 'mm', pieces: [makeCurvedConvex('cc10_10', 10, 80, 10, 48)] }, options: { layout: 'nested' } }],
      ['10pt curved star r=80 SA=40 qty=20', { format: 'svg', pattern: { name: 'cs10_20', unit: 'mm', pieces: [makeCurvedStar('cs10_20', 5, 80, 10, 40, 20)] }, options: { layout: 'nested' } }],
    ]) {
      const { result, maxHealthMs, healthErrors } = await withHealthPolling(() => postReq('/api/export', body));
      assert.equal(result.status, 400, `Expected 400 for ${label}, got ${result.status}`);
      assert.ok(result.elapsedMs < 500, `Expected ${label} rejection < 500ms, got ${result.elapsedMs}ms`);
      assert.equal(healthErrors, 0);
      assert.ok(maxHealthMs < 200, `Expected /api/health < 200ms during ${label}, got ${maxHealthMs}ms`);
    }

    // 2. Defect 2: 100k-class PDF tile-piece intersection boundary -> 400 < 500ms & health < 200ms
    const pieces60 = Array.from({ length: 60 }, (_, i) => makeStar(`st_${i}`, 24, 300, 150, 0, 2));
    const placements167 = Array.from({ length: 167 }, (_, i) => ({
      pieceIndex: i % 60,
      pieceId: `st_${i % 60}`,
      x: 0,
      y: 0,
      sheetIndex: 0,
      widthMm: 6000,
      heightMm: 6000,
    }));
    for (const pageFormat of ['LETTER', 'A4']) {
      const { result, maxHealthMs, healthErrors } = await withHealthPolling(() =>
        postReq('/api/export', {
          format: 'pdf',
          pattern: { name: 'pdf_100k_167', unit: 'mm', pieces: pieces60 },
          options: {
            layout: 'nested',
            pageFormat,
            nestingResult: { sheetLengthMm: 20000, placements: placements167 },
          },
        })
      );
      assert.equal(result.status, 400, `Expected 400 for 60x24-pt 167-placement ${pageFormat} PDF, got ${result.status}`);
      assert.ok(result.elapsedMs < 500, `Expected 167-placement ${pageFormat} rejection < 500ms, got ${result.elapsedMs}ms`);
      assert.equal(healthErrors, 0);
      assert.ok(maxHealthMs < 200, `Expected /api/health < 200ms during ${pageFormat} rejection, got ${maxHealthMs}ms`);
    }

    const pieces100 = Array.from({ length: 100 }, (_, i) => ({
      id: `q_${i}`,
      name: `q_${i}`,
      seamAllowance: 0,
      quantity: 1,
      points: Array.from({ length: 20 }, (__, k) => {
        const a = (k / 20) * Math.PI * 2;
        return { x: 2500 + 2500 * Math.cos(a), y: 2500 + 2500 * Math.sin(a) };
      }),
    }));
    const { result: pdf100Res, maxHealthMs: pdf100Health, healthErrors: pdf100HealthErrs } = await withHealthPolling(() =>
      postReq('/api/export', {
        format: 'pdf',
        pattern: { name: 'pdf_100k_cad', unit: 'mm', pieces: pieces100 },
        options: { layout: 'cad', pageFormat: 'LETTER' },
      })
    );
    assert.equal(pdf100Res.status, 400, `Expected 400 for 100x20-pt 1000-tile PDF, got ${pdf100Res.status}`);
    assert.ok(pdf100Res.elapsedMs < 500, `Expected 100x20-pt rejection < 500ms, got ${pdf100Res.elapsedMs}ms`);
    assert.equal(pdf100HealthErrs, 0);
    assert.ok(pdf100Health < 200, `Expected /api/health < 200ms during 100x20-pt rejection, got ${pdf100Health}ms`);

    // 3. Positive controls: hoodie_max qty=20 (dart + cubic + allowRotate90:false) across all 6 roll presets & formats + roundtrip, keeping /api/health < 200ms
    const hmGen = await postReq('/api/generate-template', {
      templateId: 'hoodie',
      params: {
        chestMm: 1480,
        lengthMm: 920,
        shoulderWidthMm: 620,
        sleeveLengthMm: 740,
        hoodHeightMm: 460,
        hoodDepthMm: 360,
        easeMm: 280,
        seamAllowance: 30,
      },
    });
    assert.equal(hmGen.status, 200);
    const hmPattern = {
      ...hmGen.json.pattern,
      pieces: hmGen.json.pattern.pieces.map((p, i) => {
        const copy = { ...p, quantity: 20 };
        if (i === 0) {
          const p0 = copy.points[0];
          const p1 = copy.points[1];
          copy.edges = [...(copy.edges || [])];
          copy.edges[0] = {
            ...(copy.edges[0] || {}),
            curve: {
              type: 'cubic',
              cp1: { x: p0.x + 20, y: p0.y + 10 },
              cp2: { x: p1.x - 20, y: p1.y + 10 },
            },
          };
          copy.darts = [
            ...(copy.darts || []),
            { id: 'd_test', edgeIndex: 1, t: 0.5, widthMm: 20, depthMm: 80, foldDirection: 'left' },
          ];
        }
        return copy;
      }),
    };

    for (const rollPreset of ['roll_45in', 'roll_54in', 'roll_60in', 'cricut_24x12', 'cutting_mat_36x24', 'a0']) {
      const { result: nestR, maxHealthMs: nh } = await withHealthPolling(() =>
        postReq('/api/nest', { pattern: hmPattern, options: { rollPreset, allowRotate90: false } })
      );
      assert.equal(nestR.status, 200, `Expected 200 for hoodie_max ${rollPreset} nest, got ${nestR.status}: ${nestR.text}`);
      assert.ok(nh < 200, `Expected /api/health < 200ms during ${rollPreset} nest, got ${nh}ms`);

      const { result: rtPdf, maxHealthMs: rtPdfH } = await withHealthPolling(() =>
        postReq('/api/export', {
          format: 'pdf',
          pattern: hmPattern,
          options: { layout: 'nested', rollPreset, allowRotate90: false, pageFormat: 'LETTER', nestingResult: nestR.json.nesting },
        })
      );
      assert.equal(rtPdf.status, 200, `Expected 200 for ${rollPreset} roundtrip PDF, got ${rtPdf.status}: ${rtPdf.text}`);
      assert.ok(rtPdf.text.startsWith('%PDF'));
      assert.ok(rtPdfH < 200, `Expected /api/health < 200ms during ${rollPreset} roundtrip PDF, got ${rtPdfH}ms`);

      const { result: rtSvg, maxHealthMs: rtSvgH } = await withHealthPolling(() =>
        postReq('/api/export', {
          format: 'svg',
          pattern: hmPattern,
          options: { layout: 'nested', rollPreset, allowRotate90: false, nestingResult: nestR.json.nesting },
        })
      );
      assert.equal(rtSvg.status, 200, `Expected 200 for ${rollPreset} roundtrip SVG, got ${rtSvg.status}`);
      assert.ok(rtSvg.text.includes('<svg'));
      assert.ok(rtSvgH < 200, `Expected /api/health < 200ms during ${rollPreset} roundtrip SVG, got ${rtSvgH}ms`);
    }

    for (const fmtCase of [
      { format: 'dxf', opts: { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false } },
      { format: 'json', opts: {} },
      { format: 'pdf', opts: { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false, pageFormat: 'A4' } },
      { format: 'pdf', opts: { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false, pageFormat: 'A0' } },
    ]) {
      const { result: expR, maxHealthMs: expH } = await withHealthPolling(() =>
        postReq('/api/export', { format: fmtCase.format, pattern: hmPattern, options: fmtCase.opts })
      );
      assert.equal(expR.status, 200, `Expected 200 for hoodie_max ${fmtCase.format} export, got ${expR.status}`);
      assert.ok(expR.text.length > 100);
      assert.ok(expH < 200, `Expected /api/health < 200ms during hoodie_max ${fmtCase.format}, got ${expH}ms`);
    }

    // 4. Positive controls: 1000 x 24-pt SA=10 SVG & 24-pt qty=20 SA=10 nested PDF with /api/health < 200ms
    const { result: svg1000, maxHealthMs: hSvg1000 } = await withHealthPolling(() =>
      postReq('/api/export', {
        format: 'svg',
        pattern: { name: 'safe_1000_svg', unit: 'mm', pieces: [makeStar('s24', 24, 60, 30, 10, 1000)] },
        options: { layout: 'nested' },
      })
    );
    assert.equal(svg1000.status, 200);
    assert.ok(svg1000.text.includes('<svg'));
    assert.ok(hSvg1000 < 200, `Expected /api/health < 200ms during 1000x24-pt SVG, got ${hSvg1000}ms`);

    const { result: pdf20, maxHealthMs: hPdf20 } = await withHealthPolling(() =>
      postReq('/api/export', {
        format: 'pdf',
        pattern: { name: 'safe_20_pdf', unit: 'mm', pieces: [makeStar('s24', 24, 60, 30, 10, 20)] },
        options: { layout: 'nested', pageFormat: 'LETTER' },
      })
    );
    assert.equal(pdf20.status, 200);
    assert.ok(pdf20.text.startsWith('%PDF'));
    assert.ok(hPdf20 < 200, `Expected /api/health < 200ms during 24-pt qty=20 PDF, got ${hPdf20}ms`);

    // 5. Export worker timeout (504 + clean recovery 200)
    const { server: tSrv, port: tPort } = await startServer({
      host: '127.0.0.1',
      port: 0,
      quiet: true,
      exportTimeoutMs: 800,
    });
    try {
      const tUrl = `http://127.0.0.1:${tPort}`;
      const timeoutRes = await fetch(`${tUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'pdf',
          pattern: hmPattern,
          options: { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false, pageFormat: 'LETTER' },
        }),
      });
      assert.equal(timeoutRes.status, 504, `Expected 504 on exportTimeoutMs=800, got ${timeoutRes.status}`);

      const recoverRes = await fetch(`${tUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'svg',
          pattern: {
            name: 'TinyExportRecover',
            unit: 'mm',
            pieces: [{ id: 'r1', name: 'r1', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], seamAllowance: 0 }],
          },
        }),
      });
      assert.equal(recoverRes.status, 200, `Expected 200 recovery after export timeout, got ${recoverRes.status}`);
    } finally {
      await new Promise((resolve) => tSrv.close(resolve));
    }
  } finally {
    await srv.stop();
  }
});

test('23. Gate 13 regressions: JSON export bounds & worker offload, 25k-tri STL unwrap/template worker offload /api/health < 200ms & positive controls', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function reqRaw(method, pathname, bodyStr = null, timeoutMs = 180_000) {
    const t0 = Date.now();
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const buf = Buffer.concat(chunks);
            const text = buf.toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, headers: res.headers, buf, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postRaw = (p, bodyStr, timeoutMs) => reqRaw('POST', p, bodyStr, timeoutMs);
  const postJson = (p, obj, timeoutMs) => reqRaw('POST', p, JSON.stringify(obj), timeoutMs);

  // Separate OS thread (worker_threads) HTTP poller so synchronous freezes cannot hide behind setTimeout
  async function withWorkerHealthPolling(fn) {
    const poller = new Worker(
      `
      import { parentPort, workerData } from 'node:worker_threads';
      let running = true;
      parentPort.on('message', (m) => { if (m === 'stop') running = false; });
      let maxHealthMs = 0;
      let healthErrors = 0;
      let samples = 0;
      while (running) {
        const t0 = performance.now();
        try {
          const r = await fetch(workerData.url + '/api/health');
          if (r.status !== 200) healthErrors++;
          await r.text();
        } catch {
          healthErrors++;
        }
        const dt = performance.now() - t0;
        if (dt > maxHealthMs) maxHealthMs = dt;
        samples++;
        await new Promise((r) => setTimeout(r, 25));
      }
      parentPort.postMessage({ maxHealthMs: Math.round(maxHealthMs), healthErrors, samples });
      `,
      { eval: true, workerData: { url: baseUrl } }
    );
    await new Promise((r) => setTimeout(r, 100));
    let result;
    try {
      result = await fn();
    } finally {
      poller.postMessage('stop');
    }
    const stats = await new Promise((resolve) => poller.once('message', resolve));
    await poller.terminate();
    return { result, ...stats };
  }

  function makeBinaryStlBase64(tris) {
    const buf = Buffer.alloc(84 + tris.length * 50);
    buf.write('gate13_synthetic_stl', 0, 'ascii');
    buf.writeUInt32LE(tris.length, 80);
    let off = 84;
    for (const [n, a, b, c] of tris) {
      for (const v of [n, a, b, c]) {
        buf.writeFloatLE(v[0], off);
        buf.writeFloatLE(v[1], off + 4);
        buf.writeFloatLE(v[2], off + 8);
        off += 12;
      }
      off += 2;
    }
    return buf.toString('base64');
  }

  function makeDisjoint25kBase64() {
    const tris = [];
    for (let i = 0; i < 25_000; i++) {
      const x = (i % 200) * 10;
      const y = Math.floor(i / 200) * 10;
      tris.push([[0, 0, 1], [x, y, 0], [x + 5, y, 0], [x, y + 5, 0]]);
    }
    return makeBinaryStlBase64(tris);
  }

  function makeDome24864Base64() {
    const pts = [];
    for (let j = 0; j < 112; j++) {
      for (let i = 0; i < 113; i++) {
        const u = (i / 112 - 0.5) * 120;
        const v = (j / 111 - 0.5) * 120;
        const z = 40 * Math.exp(-(u * u + v * v) / (2 * 60 * 60));
        pts.push([u, v, z]);
      }
    }
    const tris = [];
    for (let j = 0; j < 111; j++) {
      for (let i = 0; i < 112; i++) {
        const a = pts[j * 113 + i];
        const b = pts[j * 113 + i + 1];
        const c = pts[(j + 1) * 113 + i];
        const d = pts[(j + 1) * 113 + i + 1];
        tris.push([[0, 0, 1], a, b, d]);
        tris.push([[0, 0, 1], a, d, c]);
      }
    }
    return makeBinaryStlBase64(tris);
  }

  const makeStar = (id, numPoints, rOuter = 120, rInner = 50, sa = 0, qty = 1) => {
    const points = Array.from({ length: numPoints }, (_, idx) => {
      const a = (idx / numPoints) * Math.PI * 2;
      const r = idx % 2 === 0 ? rOuter : rInner;
      return { x: rOuter + r * Math.cos(a), y: rOuter + r * Math.sin(a) };
    });
    return { id, name: id, points, seamAllowance: sa, quantity: qty };
  };

  try {
    // Warm up /api/health and the export worker pool so cold-start Worker ESM import doesn't skew latency checks
    const warmH = await reqRaw('GET', '/api/health');
    assert.equal(warmH.status, 200);
    const warmExport = await postJson('/api/export', {
      format: 'json',
      pattern: {
        name: 'WarmExportWorker',
        unit: 'mm',
        pieces: [{ id: 'w1', name: 'w1', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], seamAllowance: 0 }],
      },
    });
    assert.equal(warmExport.status, 200);

    // 1. Defect A: POST /api/export (format: 'json') internalLines point cap & worker offload
    const overCapSmallPieces = Array.from({ length: 60 }, (_, i) => ({
      id: `il_s_${i}`,
      name: `il_s_${i}`,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      seamAllowance: 10,
      internalLines: Array.from({ length: 10 }, (__, l) => ({
        id: `l_${l}`,
        points: Array.from({ length: 50 }, (___, k) => ({ x: k, y: l })),
      })),
    }));
    const { result: jsonFastReject, maxHealthMs: hJsonFast, healthErrors: eJsonFast } =
      await withWorkerHealthPolling(() =>
        postJson('/api/export', { format: 'json', pattern: { name: 'json_30k', unit: 'mm', pieces: overCapSmallPieces } })
      );
    assert.equal(jsonFastReject.status, 400);
    assert.ok(jsonFastReject.elapsedMs < 500, `Expected 30k-pt JSON rejection < 500ms, got ${jsonFastReject.elapsedMs}ms`);
    assert.equal(eJsonFast, 0);
    assert.ok(hJsonFast < 200, `Expected /api/health < 200ms, got ${hJsonFast}ms`);

    // Exact Defect A payload: 200 pieces x 50 internalLines x 130 points = 1.3M points
    const pieces200 = Array.from({ length: 200 }, (_, i) => ({
      id: `p_${i}`,
      name: `p_${i}`,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      seamAllowance: 10,
      internalLines: Array.from({ length: 50 }, (__, l) => ({
        id: `l_${l}`,
        points: Array.from({ length: 130 }, (___, k) => ({ x: k * 0.5, y: l })),
      })),
    }));
    const defectABodyStr = JSON.stringify({
      format: 'json',
      pattern: { name: 'json_1_3M', unit: 'mm', pieces: pieces200 },
    });
    const { result: json13mRes, maxHealthMs: hJson13m, healthErrors: eJson13m } =
      await withWorkerHealthPolling(() => postRaw('/api/export', defectABodyStr));
    assert.equal(json13mRes.status, 400);
    assert.equal(eJson13m, 0);
    assert.ok(hJson13m < 200, `Expected /api/health < 200ms during 1.3M-pt JSON export, got ${hJson13m}ms`);

    // Valid large JSON export (40 x 20 x 30 = 24,000 internalLine points) -> 200, exact byte parity & health < 200ms
    const validLargePattern = {
      name: 'Valid Large JSON',
      unit: 'mm',
      pieces: Array.from({ length: 40 }, (_, i) => ({
        id: `vp_${i}`,
        name: `vp_${i}`,
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        seamAllowance: 10,
        internalLines: Array.from({ length: 20 }, (__, l) => ({
          id: `vl_${l}`,
          points: Array.from({ length: 30 }, (___, k) => ({ x: k * 2, y: l * 3 })),
        })),
      })),
    };
    const expectedLargeJson = core.exportPatternJSON(validLargePattern);
    const { result: validLargeRes, maxHealthMs: hValidLarge, healthErrors: eValidLarge } =
      await withWorkerHealthPolling(() =>
        postJson('/api/export', { format: 'json', pattern: validLargePattern })
      );
    assert.equal(validLargeRes.status, 200);
    assert.ok(String(validLargeRes.headers['content-type'] || '').includes('application/json'));
    assert.equal(validLargeRes.headers['content-disposition'], 'attachment; filename="Valid_Large_JSON.json"');
    assert.equal(validLargeRes.text, expectedLargeJson);
    assert.equal(eValidLarge, 0);
    assert.ok(hValidLarge < 200, `Expected /api/health < 200ms during valid large JSON export, got ${hValidLarge}ms`);

    // 2. Defect B: 25,000-tri disjoint STL & 24,864-tri connected dome STL across /api/unwrap-stl & /api/generate-template (stl_cover)
    const b64Disjoint = makeDisjoint25kBase64();
    for (const [label, ep, payloadObj] of [
      ['unwrap disjoint25k form_shell_cover', '/api/unwrap-stl', { stlBase64: b64Disjoint, mode: 'form_shell_cover' }],
      ['unwrap disjoint25k surface_panels', '/api/unwrap-stl', { stlBase64: b64Disjoint, mode: 'surface_panels' }],
      ['template stl_cover disjoint25k', '/api/generate-template', { templateId: 'stl_cover', stlBase64: b64Disjoint }],
    ]) {
      const bodyStr = JSON.stringify(payloadObj);
      const { result, maxHealthMs, healthErrors } = await withWorkerHealthPolling(() => postRaw(ep, bodyStr));
      assert.equal(result.status, 400, `Expected 400 for ${label}, got ${result.status}`);
      assert.equal(healthErrors, 0);
      assert.ok(maxHealthMs < 200, `Expected /api/health < 200ms during ${label}, got ${maxHealthMs}ms`);
    }

    const b64Dome = makeDome24864Base64();
    const { result: domeShellRes, maxHealthMs: hDomeShell, healthErrors: eDomeShell } =
      await withWorkerHealthPolling(() =>
        postRaw('/api/unwrap-stl', JSON.stringify({ stlBase64: b64Dome, mode: 'form_shell_cover' }))
      );
    assert.equal(domeShellRes.status, 200);
    assert.equal(domeShellRes.json?.stlSummary?.triangleCount, 24_864);
    assert.ok(Array.isArray(domeShellRes.json?.pattern?.pieces) && domeShellRes.json.pattern.pieces.length > 0);
    assert.ok(domeShellRes.json?.seamReport && domeShellRes.json?.nesting);
    assert.equal(eDomeShell, 0);
    assert.ok(hDomeShell < 200, `Expected /api/health < 200ms during 24.8k dome form_shell_cover, got ${hDomeShell}ms`);

    const { result: domePanelsRes, maxHealthMs: hDomePanels, healthErrors: eDomePanels } =
      await withWorkerHealthPolling(() =>
        postRaw('/api/unwrap-stl', JSON.stringify({ stlBase64: b64Dome, mode: 'surface_panels' }))
      );
    assert.equal(domePanelsRes.status, 400);
    assert.equal(eDomePanels, 0);
    assert.ok(hDomePanels < 200, `Expected /api/health < 200ms during 24.8k dome surface_panels, got ${hDomePanels}ms`);

    const { result: domeTplRes, maxHealthMs: hDomeTpl, healthErrors: eDomeTpl } =
      await withWorkerHealthPolling(() =>
        postRaw('/api/generate-template', JSON.stringify({ templateId: 'stl_cover', stlBase64: b64Dome }))
      );
    assert.equal(domeTplRes.status, 200);
    assert.equal(domeTplRes.json?.stlSummary?.triangleCount, 24_864);
    assert.ok(Array.isArray(domeTplRes.json?.pattern?.pieces) && domeTplRes.json.pattern.pieces.length > 0);
    assert.ok(domeTplRes.json?.seamReport && domeTplRes.json?.nesting);
    assert.equal(eDomeTpl, 0);
    assert.ok(hDomeTpl < 200, `Expected /api/health < 200ms during 24.8k dome stl_cover template, got ${hDomeTpl}ms`);

    // 3. Positive regression controls: real workspace STLs, all 5 templates, hoodie_max qty=20 + roundtrip PDF, 1000x24-pt SVG & 24-pt qty=20 PDF
    for (const wsFile of ['cutting_mat_wedge_assembled_view.stl', 'cutting_mat_wedge_print_ready.stl']) {
      for (const mode of ['form_shell_cover', 'surface_panels']) {
        const { result, maxHealthMs, healthErrors } = await withWorkerHealthPolling(() =>
          postJson('/api/unwrap-stl', { workspaceFile: wsFile, mode })
        );
        assert.equal(result.status, 200, `Expected 200 for ${wsFile} (${mode}), got ${result.status}`);
        assert.ok(result.json?.stlSummary && result.json?.pattern && result.json?.seamReport && result.json?.nesting);
        assert.equal(healthErrors, 0);
        assert.ok(maxHealthMs < 200, `Expected /api/health < 200ms during ${wsFile} (${mode}), got ${maxHealthMs}ms`);
      }
      const { result: tplWs, maxHealthMs: hTplWs, healthErrors: eTplWs } = await withWorkerHealthPolling(() =>
        postJson('/api/generate-template', { templateId: 'stl_cover', workspaceFile: wsFile })
      );
      assert.equal(tplWs.status, 200);
      assert.ok(tplWs.json?.stlSummary && tplWs.json?.pattern && tplWs.json?.seamReport && tplWs.json?.nesting);
      assert.equal(eTplWs, 0);
      assert.ok(hTplWs < 200, `Expected /api/health < 200ms during stl_cover ${wsFile}, got ${hTplWs}ms`);
    }

    for (const templateId of ['tshirt', 'hoodie', 'pants', 'tote_bag', 'stl_cover']) {
      const genRes = await postJson('/api/generate-template', { templateId });
      assert.equal(genRes.status, 200, `Expected 200 for template ${templateId}`);
      assert.ok(genRes.json?.pattern && genRes.json?.seamReport && genRes.json?.nesting);
      const jsonExp = await postJson('/api/export', { format: 'json', pattern: genRes.json.pattern });
      assert.equal(jsonExp.status, 200);
      assert.equal(jsonExp.text, core.exportPatternJSON(genRes.json.pattern));
    }

    const hmGen = await postJson('/api/generate-template', {
      templateId: 'hoodie',
      params: {
        chestMm: 1480,
        lengthMm: 920,
        shoulderWidthMm: 620,
        sleeveLengthMm: 740,
        hoodHeightMm: 460,
        hoodDepthMm: 360,
        easeMm: 280,
        seamAllowance: 30,
      },
    });
    assert.equal(hmGen.status, 200);
    const hmPattern = {
      ...hmGen.json.pattern,
      pieces: hmGen.json.pattern.pieces.map((p) => ({ ...p, quantity: 20 })),
    };

    const { result: hmNest, maxHealthMs: hHmNest } = await withWorkerHealthPolling(() =>
      postJson('/api/nest', { pattern: hmPattern, options: { rollPreset: 'roll_54in', allowRotate90: false } })
    );
    assert.equal(hmNest.status, 200);
    assert.ok(hHmNest < 200, `Expected /api/health < 200ms during hoodie_max nest, got ${hHmNest}ms`);

    const rtPdfBody = JSON.stringify({
      format: 'pdf',
      pattern: hmPattern,
      options: {
        layout: 'nested',
        rollPreset: 'roll_54in',
        allowRotate90: false,
        pageFormat: 'LETTER',
        nestingResult: hmNest.json.nesting,
      },
    });
    const { result: hmRtPdf, maxHealthMs: hHmRtPdf } = await withWorkerHealthPolling(() =>
      postRaw('/api/export', rtPdfBody)
    );
    assert.equal(hmRtPdf.status, 200);
    assert.ok(hmRtPdf.text.startsWith('%PDF'));
    assert.ok(hHmRtPdf < 200, `Expected /api/health < 200ms during hoodie_max roundtrip PDF, got ${hHmRtPdf}ms`);

    for (const [fmt, opts] of [
      ['svg', { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false }],
      ['dxf', { layout: 'nested', rollPreset: 'roll_54in', allowRotate90: false }],
      ['json', {}],
    ]) {
      const { result, maxHealthMs } = await withWorkerHealthPolling(() =>
        postJson('/api/export', { format: fmt, pattern: hmPattern, options: opts })
      );
      assert.equal(result.status, 200);
      assert.ok(maxHealthMs < 200, `Expected /api/health < 200ms during hoodie_max ${fmt}, got ${maxHealthMs}ms`);
    }

    const { result: svg1000, maxHealthMs: hSvg1000 } = await withWorkerHealthPolling(() =>
      postJson('/api/export', {
        format: 'svg',
        pattern: { name: 'g13_1000_svg', unit: 'mm', pieces: [makeStar('s24', 24, 60, 30, 10, 1000)] },
        options: { layout: 'nested' },
      })
    );
    assert.equal(svg1000.status, 200);
    assert.ok(svg1000.text.includes('<svg'));
    assert.ok(hSvg1000 < 200, `Expected /api/health < 200ms during 1000x24-pt SVG, got ${hSvg1000}ms`);

    const { result: pdf20, maxHealthMs: hPdf20 } = await withWorkerHealthPolling(() =>
      postJson('/api/export', {
        format: 'pdf',
        pattern: { name: 'g13_20_pdf', unit: 'mm', pieces: [makeStar('s24', 24, 60, 30, 10, 20)] },
        options: { layout: 'nested', pageFormat: 'LETTER' },
      })
    );
    assert.equal(pdf20.status, 200);
    assert.ok(pdf20.text.startsWith('%PDF'));
    assert.ok(hPdf20 < 200, `Expected /api/health < 200ms during 24-pt qty=20 PDF, got ${hPdf20}ms`);
  } finally {
    await srv.stop();
  }
});

test('24. Gate 14 regression: POST /api/simulate worker offload for 25k-tri STLs, 22MB JSON & stlMesh keeps /api/health < 200ms', async () => {
  const srv = await startStudioServerProcess({ args: ['--host=127.0.0.1', '--port=0'] });
  const baseUrl = srv.baseUrl;

  async function reqRaw(method, pathname, bodyStr = null, timeoutMs = 180_000) {
    const t0 = Date.now();
    const url = new URL(`${baseUrl}${pathname}`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          timeout: timeoutMs,
          headers:
            bodyStr !== null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(bodyStr),
                }
              : undefined,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const elapsedMs = Date.now() - t0;
            const buf = Buffer.concat(chunks);
            const text = buf.toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // non-JSON
            }
            resolve({ status: res.statusCode, headers: res.headers, buf, text, json, elapsedMs });
          });
        }
      );
      r.on('timeout', () => {
        r.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${pathname}`));
      });
      r.on('error', reject);
      if (bodyStr !== null) r.write(bodyStr);
      r.end();
    });
  }
  const postRaw = (p, bodyStr, timeoutMs) => reqRaw('POST', p, bodyStr, timeoutMs);
  const postJson = (p, obj, timeoutMs) => reqRaw('POST', p, JSON.stringify(obj), timeoutMs);

  async function withWorkerHealthPolling(fn) {
    const poller = new Worker(
      `
      import { parentPort, workerData } from 'node:worker_threads';
      let running = true;
      parentPort.on('message', (m) => { if (m === 'stop') running = false; });
      let maxHealthMs = 0;
      let healthErrors = 0;
      let samples = 0;
      while (running) {
        const t0 = performance.now();
        try {
          const r = await fetch(workerData.url + '/api/health');
          if (r.status !== 200) healthErrors++;
          await r.text();
        } catch {
          healthErrors++;
        }
        const dt = performance.now() - t0;
        if (dt > maxHealthMs) maxHealthMs = dt;
        samples++;
        await new Promise((r) => setTimeout(r, 20));
      }
      parentPort.postMessage({ maxHealthMs: Math.round(maxHealthMs), healthErrors, samples });
      `,
      { eval: true, workerData: { url: baseUrl } }
    );
    await new Promise((r) => setTimeout(r, 100));
    let result;
    try {
      result = await fn();
    } finally {
      poller.postMessage('stop');
    }
    const stats = await new Promise((resolve) => poller.once('message', resolve));
    await poller.terminate();
    return { result, ...stats };
  }

  function makeBinaryStlBase64(tris, header = 'gate14_synthetic_stl') {
    const buf = Buffer.alloc(84 + tris.length * 50);
    buf.write(header, 0, 'ascii');
    buf.writeUInt32LE(tris.length, 80);
    let off = 84;
    for (const [n, a, b, c] of tris) {
      for (const v of [n, a, b, c]) {
        buf.writeFloatLE(v[0], off);
        buf.writeFloatLE(v[1], off + 4);
        buf.writeFloatLE(v[2], off + 8);
        off += 12;
      }
      off += 2;
    }
    return buf.toString('base64');
  }

  function makeDisjointTris(count) {
    const tris = [];
    for (let i = 0; i < count; i++) {
      const x = (i % 200) * 10;
      const y = Math.floor(i / 200) * 10;
      tris.push([[0, 0, 1], [x, y, 0], [x + 5, y, 0], [x, y + 5, 0]]);
    }
    return tris;
  }

  function makeAsciiStl25k() {
    const lines = ['solid g14_ascii_25k'];
    for (let i = 0; i < 25_000; i++) {
      const x = (i % 200) * 10;
      const y = Math.floor(i / 200) * 10;
      lines.push(
        `facet normal 0 0 1\nouter loop\nvertex ${x} ${y} 0\nvertex ${x + 5} ${y} 0\nvertex ${x} ${y + 5} 0\nendloop\nendfacet`
      );
    }
    lines.push('endsolid g14_ascii_25k\n');
    return lines.join('\n');
  }

  function makeDome24864Base64() {
    const pts = [];
    for (let j = 0; j < 112; j++) {
      for (let i = 0; i < 113; i++) {
        const u = (i / 112 - 0.5) * 120;
        const v = (j / 111 - 0.5) * 120;
        const z = 40 * Math.exp(-(u * u + v * v) / (2 * 60 * 60));
        pts.push([u, v, z]);
      }
    }
    const tris = [];
    for (let j = 0; j < 111; j++) {
      for (let i = 0; i < 112; i++) {
        const a = pts[j * 113 + i];
        const b = pts[j * 113 + i + 1];
        const c = pts[(j + 1) * 113 + i];
        const d = pts[(j + 1) * 113 + i + 1];
        tris.push([[0, 0, 1], a, b, d]);
        tris.push([[0, 0, 1], a, d, c]);
      }
    }
    return makeBinaryStlBase64(tris);
  }

  function assertSimShape(res, label, expectedSteps = null) {
    assert.equal(res.status, 200, `Expected 200 for ${label}, got ${res.status}: ${res.text?.slice(0, 300)}`);
    if (expectedSteps !== null) {
      assert.equal(res.json?.stepCount, expectedSteps, `Unexpected stepCount for ${label}`);
    } else {
      assert.equal(typeof res.json?.stepCount, 'number', `Missing stepCount for ${label}`);
    }
    assert.ok(Array.isArray(res.json?.particles) && res.json.particles.length > 0, `Missing particles for ${label}`);
    assert.ok(res.json?.strainReport && typeof res.json.strainReport === 'object', `Missing strainReport for ${label}`);
    assert.equal(typeof res.json?.avgSewGapMm, 'number', `Missing avgSewGapMm for ${label}`);
    assert.equal(res.json?.finiteOk, true, `Expected finiteOk=true for ${label}`);
  }

  try {
    // Warm up /api/health and the simulation worker pool so cold-start Worker ESM import doesn't skew latency checks
    const warmH = await reqRaw('GET', '/api/health');
    assert.equal(warmH.status, 200);
    const warmSim = await postJson('/api/simulate', {
      pattern: {
        name: 'WarmSimWorker',
        unit: 'mm',
        pieces: [{
          id: 'w1',
          name: 'w1',
          points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
          edges: [{}, {}, {}, {}],
          seamAllowance: 0,
        }],
        seams: [],
      },
      steps: 0,
    });
    assert.equal(warmSim.status, 200);

    // 1. 25,000-tri disjoint binary stlBase64 (tote_bag, steps: 10)
    const disjointTris = makeDisjointTris(25_000);
    const b64Disjoint = makeBinaryStlBase64(disjointTris);
    const { result: simBin25k, maxHealthMs: hBin25k, healthErrors: eBin25k } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', { templateId: 'tote_bag', stlBase64: b64Disjoint, steps: 10 })
      );
    assertSimShape(simBin25k, '25k disjoint binary stlBase64', 10);
    assert.equal(eBin25k, 0);
    assert.ok(hBin25k < 200, `Expected /api/health < 200ms during 25k disjoint binary simulate, got ${hBin25k}ms`);

    // 2. 25,000-tri ASCII stlText (tote_bag, steps: 10)
    const ascii25k = makeAsciiStl25k();
    const { result: simAscii25k, maxHealthMs: hAscii25k, healthErrors: eAscii25k } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', { templateId: 'tote_bag', stlText: ascii25k, steps: 10 })
      );
    assertSimShape(simAscii25k, '25k disjoint ASCII stlText', 10);
    assert.equal(eAscii25k, 0);
    assert.ok(hAscii25k < 200, `Expected /api/health < 200ms during 25k ASCII simulate, got ${hAscii25k}ms`);

    // 3. 24,864-tri connected dome stlBase64 (tote_bag steps: 0 & stl_cover steps: 10)
    const b64Dome = makeDome24864Base64();
    const { result: simDome0, maxHealthMs: hDome0, healthErrors: eDome0 } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', { templateId: 'tote_bag', stlBase64: b64Dome, steps: 0 })
      );
    assertSimShape(simDome0, '24.8k dome tote_bag steps:0', 0);
    assert.equal(eDome0, 0);
    assert.ok(hDome0 < 200, `Expected /api/health < 200ms during 24.8k dome steps:0, got ${hDome0}ms`);

    const { result: simDomeCover, maxHealthMs: hDomeCover, healthErrors: eDomeCover } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', { templateId: 'stl_cover', stlBase64: b64Dome, steps: 10 })
      );
    assertSimShape(simDomeCover, '24.8k dome stl_cover steps:10', 10);
    assert.equal(eDomeCover, 0);
    assert.ok(hDomeCover < 200, `Expected /api/health < 200ms during 24.8k dome stl_cover steps:10, got ${hDomeCover}ms`);

    // 4. 25,000-tri stlMesh JSON
    const stlMesh25k = {
      name: 'g14_mesh_25k',
      triangles: disjointTris.map(([, a, b, c]) => [
        { x: a[0], y: a[1], z: a[2] },
        { x: b[0], y: b[1], z: b[2] },
        { x: c[0], y: c[1], z: c[2] },
      ]),
    };
    const { result: simMesh25k, maxHealthMs: hMesh25k, healthErrors: eMesh25k } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', { templateId: 'tote_bag', stlMesh: stlMesh25k, steps: 0 })
      );
    assertSimShape(simMesh25k, '25k stlMesh JSON', 0);
    assert.equal(eMesh25k, 0);
    assert.ok(hMesh25k < 200, `Expected /api/health < 200ms during 25k stlMesh simulate, got ${hMesh25k}ms`);

    // 5. ~22 MB 200 x 50 x 130 internalLines JSON -> 400, /api/health < 200ms
    const pieces200 = Array.from({ length: 200 }, (_, i) => ({
      id: `sp_${i}`,
      name: `sp_${i}`,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      seamAllowance: 10,
      internalLines: Array.from({ length: 50 }, (__, l) => ({
        id: `l_${l}`,
        points: Array.from({ length: 130 }, (___, k) => ({ x: k * 0.5, y: l })),
      })),
    }));
    const bigIlBody = JSON.stringify({
      pattern: { name: 'sim_22mb_il', unit: 'mm', pieces: pieces200 },
      steps: 1,
    });
    assert.ok(Buffer.byteLength(bigIlBody) > 20 * 1024 * 1024);
    const { result: simBigIl, maxHealthMs: hBigIl, healthErrors: eBigIl } =
      await withWorkerHealthPolling(() => postRaw('/api/simulate', bigIlBody));
    assert.equal(simBigIl.status, 400, `Expected 400 for 22MB internalLines JSON, got ${simBigIl.status}`);
    assert.equal(eBigIl, 0);
    assert.ok(hBigIl < 200, `Expected /api/health < 200ms during 22MB internalLines reject, got ${hBigIl}ms`);

    // 6. >= 128 KB invalid JSON (400), non-object JSON (400), 25,001-tri STL (400), traversal (404), real workspace STL (200)
    const badJsonLarge = '{"templateId":"tote_bag","pad":"' + 'a'.repeat(140_000) + '"';
    const { result: simBadJson, maxHealthMs: hBadJson } = await withWorkerHealthPolling(() =>
      postRaw('/api/simulate', badJsonLarge)
    );
    assert.equal(simBadJson.status, 400);
    assert.ok(hBadJson < 200, `Expected /api/health < 200ms during >=128KB invalid JSON, got ${hBadJson}ms`);

    for (const nonObjBody of [
      '[' + '"x",'.repeat(35_000) + '"x"]',
      ' '.repeat(140_000) + 'null',
      ' '.repeat(140_000) + '123',
    ]) {
      const rNonObj = await postRaw('/api/simulate', nonObjBody);
      assert.equal(rNonObj.status, 400, `Expected 400 for >=128KB non-object JSON, got ${rNonObj.status}`);
    }

    const bin25001Buf = Buffer.alloc(84 + 25_001 * 50);
    bin25001Buf.write('g14_over_limit', 0, 'ascii');
    bin25001Buf.writeUInt32LE(25_001, 80);
    const { result: sim25001, maxHealthMs: h25001 } = await withWorkerHealthPolling(() =>
      postJson('/api/simulate', {
        templateId: 'tote_bag',
        stlBase64: bin25001Buf.toString('base64'),
        steps: 1,
      })
    );
    assert.equal(sim25001.status, 400);
    assert.ok(h25001 < 200, `Expected /api/health < 200ms during 25001-tri reject, got ${h25001}ms`);

    for (const badWs of ['../pattern_studio/package.json', '../../etc/passwd', '/etc/passwd', 'missing_xyz.stl']) {
      const rTrav = await postJson('/api/simulate', {
        templateId: 'tote_bag',
        workspaceFile: badWs,
        steps: 1,
      });
      assert.equal(rTrav.status, 404, `Expected 404 for workspaceFile=${badWs}, got ${rTrav.status}`);
    }

    const { result: simRealWs, maxHealthMs: hRealWs, healthErrors: eRealWs } =
      await withWorkerHealthPolling(() =>
        postJson('/api/simulate', {
          templateId: 'stl_cover',
          workspaceFile: 'cutting_mat_wedge_assembled_view.stl',
          steps: 10,
        })
      );
    assertSimShape(simRealWs, 'cutting_mat_wedge_assembled_view.stl', 10);
    assert.equal(eRealWs, 0);
    assert.ok(hRealWs < 200, `Expected /api/health < 200ms during real workspace STL simulate, got ${hRealWs}ms`);
  } finally {
    await srv.stop();
  }
});

test('25. Server immediate SIGINT/SIGTERM upon SSH Tunnel banner exits cleanly with code 0 & programmatic startServer leaks 0 signal listeners', async () => {
  const probeImmediateSignal = (sig) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER_PATH, '--port=0'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let sent = false;
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`Timed out waiting for immediate ${sig} shutdown.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 10000);

      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
        if (!sent && stdout.includes('SSH Tunnel:')) {
          sent = true;
          child.kill(sig);
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, sent, stdout, stderr });
      });
    });

  for (let i = 0; i < 5; i++) {
    const res = await probeImmediateSignal('SIGINT');
    assert.equal(res.sent, true, `Trial ${i}: SSH Tunnel banner not observed`);
    assert.equal(res.code, 0, `Trial ${i} immediate SIGINT expected exitCode 0, got code=${res.code} signal=${res.signal}\nstderr:\n${res.stderr}`);
    assert.equal(res.signal, null);
  }

  for (let i = 0; i < 2; i++) {
    const res = await probeImmediateSignal('SIGTERM');
    assert.equal(res.sent, true, `SIGTERM trial ${i}: SSH Tunnel banner not observed`);
    assert.equal(res.code, 0, `SIGTERM trial ${i} expected exitCode 0, got code=${res.code} signal=${res.signal}\nstderr:\n${res.stderr}`);
    assert.equal(res.signal, null);
  }

  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  for (let i = 0; i < 2; i++) {
    const { server } = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(process.listenerCount('SIGINT'), sigintBefore, 'Programmatic startServer must not leak SIGINT listeners');
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore, 'Programmatic startServer must not leak SIGTERM listeners');
});
