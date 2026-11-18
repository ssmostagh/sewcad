#!/usr/bin/env node
/**
 * Command-Line Interface for pattern_studio_v2.
 * Supports: list, template, unwrap, verify-sim, and --help.
 * Accepts both `--flag value` and `--flag=value` argument forms.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEMPLATE_CATALOG,
  MATERIAL_PRESETS,
  FABRIC_ROLL_PRESETS,
  PAGE_FORMATS,
  generateTemplatePattern,
  validatePatternSeams,
  parseSTL,
  unwrapSTLToPattern,
  getMaterialConfig,
  runSimulationSteps,
  nestPatternPieces,
  exportSVG,
  exportTiledPDF,
  exportDXF,
  exportPatternJSON,
} from './core/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');

const BOOLEAN_FLAGS = new Set(['help', 'h']);
const KNOWN_VALUE_FLAGS = new Set([
  'type',
  'template',
  'material',
  'stl',
  'out',
  'format',
  'page',
  'sa',
  'ease',
  'mode',
  'thickness',
  'scale',
  'steps',
]);
const SUPPORTED_FORMATS = new Set(['svg', 'pdf', 'dxf', 'json']);
const SUPPORTED_UNWRAP_MODES = new Set(['form_shell_cover', 'surface_panels', 'chart_unfold']);
const COMMAND_ALLOWED_FLAGS = Object.freeze({
  list: new Set(),
  template: new Set(['type', 'template', 'material', 'stl', 'out', 'format', 'page', 'sa', 'ease', 'thickness', 'scale']),
  unwrap: new Set(['stl', 'mode', 'ease', 'sa', 'thickness', 'scale', 'material', 'out', 'format', 'page']),
  'verify-sim': new Set(['template', 'stl', 'material', 'steps', 'mode']),
});

function assertAllowedFlags(command, flags) {
  const allowed = COMMAND_ALLOWED_FLAGS[command];
  if (!allowed) return;
  for (const key of Object.keys(flags)) {
    if (key === 'help' || key === 'h') continue;
    if (!allowed.has(key)) {
      throw new Error(`Flag --${key} is not supported for command "${command}".`);
    }
  }
}

function resolveOutDirFlag(rawOut) {
  if (rawOut === undefined) return '.';
  const trimmed = typeof rawOut === 'string' ? rawOut.trim() : '';
  if (!trimmed) {
    throw new Error('Invalid --out value: directory path must be non-empty when --out is specified.');
  }
  return trimmed;
}

function printUsage(stream = process.stdout) {
  stream.write(
    [
      'pattern_studio_v2 CLI — 2D/3D Pattern CAD, Cloth Sim, STL Unwrap & 1:1 Export',
      '',
      'Usage:',
      '  node src/cli.mjs <command> [options]',
      '',
      'Commands:',
      '  list',
      '      List available templates, materials, roll presets, page formats, and workspace STLs.',
      '',
      '  template --type <tshirt|hoodie|pants|tote_bag|stl_cover> [options]',
      '      --type, --template <id>   Template ID (required)',
      '      --material <id>           Material preset ID (optional)',
      '      --stl <path>              STL file path (optional for stl_cover)',
      '      --out <dir>               Output directory (default: ".")',
      '      --format <list>           Comma-separated: svg,pdf,dxf,json (default: "svg,json")',
      '      --page <fmt>              PDF page format: LETTER|A4|A0|36x24_MAT|TABLOID (default: LETTER)',
      '      --sa <mm>                 Seam allowance override in mm (optional)',
      '      --ease <mm>               Ease override in mm (optional)',
      '',
      '  unwrap --stl <path> [options]',
      '      --stl <path>              Path to binary or ASCII .stl file (required)',
      '      --mode <mode>             form_shell_cover | surface_panels (default: form_shell_cover)',
      '      --ease <mm>               Cover ease in mm (default: 2)',
      '      --sa <mm>                 Seam allowance in mm (default: 10)',
      '      --thickness <mm>          Material thickness compensation in mm (optional)',
      '      --scale <factor>          Scale multiplier (default: 1)',
      '      --material <id>           Material preset ID (default: veg_leather)',
      '      --out <dir>               Output directory (default: ".")',
      '      --format <list>           Comma-separated: svg,pdf,dxf,json (default: "svg,dxf,json")',
      '      --page <fmt>              PDF page format: LETTER|A4|A0|36x24_MAT|TABLOID (default: LETTER)',
      '',
      '  verify-sim (--template <id> | --stl <path>) [options]',
      '      --template <id>           Starter template ID to simulate',
      '      --stl <path>              STL path to unwrap and drape onto the STL collider',
      '      --material <id>           Material preset ID (optional)',
      '      --steps <n>               Number of XPBD simulation steps (1-600, default: 60)',
      '',
      'Options:',
      '  --help, -h                    Show this help message',
      '',
    ].join('\n')
  );
}

export function parseCliArgs(argv = []) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (token === '-h' || token === '--help') {
      flags.help = true;
      continue;
    }

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx).trim();
        const val = token.slice(eqIdx + 1);
        if (!key) throw new Error(`Invalid flag syntax: "${token}"`);
        if (!BOOLEAN_FLAGS.has(key) && !KNOWN_VALUE_FLAGS.has(key)) {
          throw new Error(`Unknown flag --${key}`);
        }
        if (BOOLEAN_FLAGS.has(key)) {
          const norm = val.trim().toLowerCase();
          if (norm === 'true') {
            flags.help = true;
          } else if (norm === 'false') {
            flags.help = false;
          } else {
            throw new Error(`Invalid boolean value "${val}" for flag --${key} (expected "true" or "false").`);
          }
        } else {
          flags[key] = val;
        }
      } else {
        const key = token.slice(2).trim();
        if (!key) throw new Error(`Invalid flag syntax: "${token}"`);
        if (!BOOLEAN_FLAGS.has(key) && !KNOWN_VALUE_FLAGS.has(key)) {
          throw new Error(`Unknown flag --${key}`);
        }
        if (BOOLEAN_FLAGS.has(key)) {
          if (key === 'h' || key === 'help') {
            flags.help = true;
          } else {
            flags[key] = true;
          }
        } else {
          if (i + 1 >= argv.length) {
            throw new Error(`Missing value for flag --${key}`);
          }
          const next = String(argv[i + 1]);
          if (next.startsWith('--')) {
            throw new Error(`Missing value for flag --${key} (got ${next})`);
          }
          flags[key] = next;
          i++;
        }
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command: positionals[0] || '',
    positionals,
    flags,
  };
}

function makeFileSlug(name, fallback = 'pattern') {
  const safe =
    typeof name === 'symbol' ? fallback : String(name ?? fallback);
  const slug = safe
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (slug || fallback).slice(0, 64);
}

function resolvePageFormat(rawPage) {
  if (rawPage === undefined || rawPage === null) return 'LETTER';
  if (rawPage === true) {
    throw new Error('Missing value for --page.');
  }
  const trimmed = String(rawPage).trim();
  const norm = trimmed.toUpperCase();
  const canonical = Object.keys(PAGE_FORMATS).find((k) => k.toUpperCase() === norm);
  if (!trimmed || !canonical) {
    throw new Error(
      `Unsupported --page format "${rawPage}". Valid values: ${Object.keys(PAGE_FORMATS).join(', ')}`
    );
  }
  return canonical;
}

function resolveUnwrapMode(rawModeFlag) {
  if (rawModeFlag === undefined) return 'form_shell_cover';
  const rawMode = String(rawModeFlag).trim();
  if (!SUPPORTED_UNWRAP_MODES.has(rawMode)) {
    throw new Error(
      `Unsupported --mode "${rawModeFlag}". Expected one of: form_shell_cover, surface_panels, chart_unfold.`
    );
  }
  return rawMode === 'chart_unfold' ? 'surface_panels' : rawMode;
}

function parseFormats(rawFormats, defaultFormats) {
  const src = rawFormats !== undefined ? String(rawFormats) : defaultFormats;
  const list = src
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    throw new Error('At least one export format must be specified via --format.');
  }
  for (const fmt of list) {
    if (!SUPPORTED_FORMATS.has(fmt)) {
      throw new Error(
        `Unsupported export format "${fmt}". Expected one of: svg, pdf, dxf, json.`
      );
    }
  }
  return Array.from(new Set(list));
}

function parseOptionalFinite(raw, name, opts = {}) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw new Error(`Invalid numeric value for --${name}: "${raw}"`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for --${name}: "${raw}"`);
  }
  if (opts.min !== undefined) {
    if (opts.exclusiveMin ? n <= opts.min : n < opts.min) {
      throw new Error(
        `Invalid value for --${name} (${n}): must be ${opts.exclusiveMin ? '>' : '>='} ${opts.min}.`
      );
    }
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`Invalid value for --${name} (${n}): must be <= ${opts.max}.`);
  }
  return n;
}

function resolveValidatedMaterialId(rawMaterial, fallbackId) {
  if (rawMaterial === undefined || rawMaterial === null) return fallbackId;
  const trimmed = String(rawMaterial).trim();
  if (trimmed.length === 0 || !Object.hasOwn(MATERIAL_PRESETS, trimmed)) {
    throw new Error(
      `Unknown --material "${rawMaterial}". Valid materials: ${Object.keys(MATERIAL_PRESETS).join(', ')}`
    );
  }
  return trimmed;
}

function writePatternArtifacts(pattern, outDir, formats, pageFormat, baseSlug) {
  const absOut = path.resolve(outDir || '.');
  fs.mkdirSync(absOut, { recursive: true });

  const safePattern = {
    ...pattern,
    name:
      typeof pattern.name === 'symbol'
        ? 'Pattern'
        : String(pattern.name ?? 'Pattern'),
  };
  const slug = makeFileSlug(baseSlug || safePattern.name, 'pattern');
  const exportOpts = { pageFormat };

  const writtenFiles = [];
  for (const fmt of formats) {
    const outPath = path.join(absOut, `${slug}.${fmt}`);
    if (fmt === 'svg') {
      const svg = exportSVG(safePattern, exportOpts);
      fs.writeFileSync(outPath, svg, 'utf8');
    } else if (fmt === 'pdf') {
      const pdfRes = exportTiledPDF(safePattern, exportOpts);
      const buf = pdfRes.pdfBytes || Buffer.from(pdfRes.pdfString, 'latin1');
      fs.writeFileSync(outPath, buf);
    } else if (fmt === 'dxf') {
      const dxf = exportDXF(safePattern, exportOpts);
      fs.writeFileSync(outPath, dxf, 'utf8');
    } else if (fmt === 'json') {
      const jsonStr = exportPatternJSON(safePattern);
      fs.writeFileSync(outPath, jsonStr, 'utf8');
    }
    writtenFiles.push(outPath);
  }
  return { absOut, writtenFiles };
}

function discoverCliWorkspaceStls() {
  const out = [];
  const seen = new Set();
  for (const dir of [PROJECT_ROOT, WORKSPACE_ROOT]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.stl')) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ name: entry.name, path: path.join(dir, entry.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function runListCommand() {
  const payload = {
    templates: TEMPLATE_CATALOG.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      defaultMaterial: t.defaultMaterial,
    })),
    materials: Object.values(MATERIAL_PRESETS).map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      gsm: m.gsm,
      thicknessMm: m.thicknessMm,
    })),
    rolls: FABRIC_ROLL_PRESETS.map((r) => ({
      id: r.id,
      name: r.name,
      widthMm: r.widthMm,
    })),
    pageFormats: Object.values(PAGE_FORMATS).map((p) => ({
      id: p.id,
      name: p.name,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
    })),
    workspaceStls: discoverCliWorkspaceStls(),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function runTemplateCommand(flags) {
  if (
    flags.type !== undefined &&
    flags.template !== undefined &&
    String(flags.type).trim() !== String(flags.template).trim()
  ) {
    throw new Error(
      `Conflicting --type "${flags.type}" and --template "${flags.template}" flags.`
    );
  }
  const templateId = String(flags.type ?? flags.template ?? '').trim();
  if (!templateId) {
    throw new Error('Missing required --type <tshirt|hoodie|pants|tote_bag|stl_cover> flag.');
  }

  const tplMeta = TEMPLATE_CATALOG.find((t) => t.id === templateId);
  if (!tplMeta) {
    throw new Error(
      `Unknown template "${templateId}". Valid templates: ${TEMPLATE_CATALOG.map((t) => t.id).join(', ')}`
    );
  }

  const matId = resolveValidatedMaterialId(
    flags.material,
    tplMeta.defaultMaterial || 'cotton_jersey'
  );
  const material = getMaterialConfig(matId);

  const params = {};
  const sa = parseOptionalFinite(flags.sa, 'sa', { min: 0, max: 1000 });
  const ease = parseOptionalFinite(flags.ease, 'ease', {
    min: 0,
    max: templateId === 'stl_cover' ? 1000 : 5000,
  });
  const thickness = parseOptionalFinite(flags.thickness, 'thickness', { min: 0, max: 1000 });
  const scale = parseOptionalFinite(flags.scale, 'scale', { min: 0.01, max: 100 });
  if (sa !== undefined) params.seamAllowance = sa;
  if (ease !== undefined) params.easeMm = ease;
  if (thickness !== undefined) params.thicknessMm = thickness;
  if (scale !== undefined) params.scale = scale;

  let stlMesh;
  if (flags.stl !== undefined) {
    if (templateId !== 'stl_cover') {
      throw new Error(`Flag --stl is only supported for template "stl_cover" (got "${templateId}").`);
    }
    const rawStl = typeof flags.stl === 'string' ? flags.stl.trim() : '';
    if (!rawStl) {
      throw new Error('Invalid --stl value: path must be non-empty when --stl is specified.');
    }
    const stlPath = path.resolve(rawStl);
    if (!fs.existsSync(stlPath) || !fs.statSync(stlPath).isFile()) {
      throw new Error(`STL file does not exist: ${stlPath}`);
    }
    stlMesh = parseSTL(fs.readFileSync(stlPath), path.basename(stlPath));
  }

  const pattern = generateTemplatePattern(templateId, params, {
    materialId: material.id,
    stlMesh,
  });
  pattern.materialId = material.id;
  pattern.material = material;

  const formats = parseFormats(flags.format, 'svg,json');
  const pageFormat = resolvePageFormat(flags.page);
  const outDir = resolveOutDirFlag(flags.out);
  const { absOut, writtenFiles } = writePatternArtifacts(
    pattern,
    outDir,
    formats,
    pageFormat,
    templateId
  );

  const seamReport = validatePatternSeams(pattern);
  const nesting = nestPatternPieces(pattern, {});

  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'template',
        templateId,
        materialId: material.id,
        pageFormat,
        outDir: absOut,
        files: writtenFiles,
        piecesCount: pattern.pieces.length,
        seamCount: pattern.seams.length,
        seamIssuesCount: Array.isArray(seamReport) ? seamReport.filter((r) => !r?.valid).length : 0,
        nesting: {
          requiredLengthMm: nesting.requiredLengthMm,
          utilizationPct: nesting.utilizationPct,
        },
      },
      null,
      2
    )}\n`
  );
}

function runUnwrapCommand(flags) {
  const rawStl = typeof flags.stl === 'string' ? flags.stl.trim() : '';
  if (!rawStl) {
    throw new Error('Missing required --stl <path> flag for unwrap command.');
  }
  const stlPath = path.resolve(rawStl);
  if (!fs.existsSync(stlPath) || !fs.statSync(stlPath).isFile()) {
    throw new Error(`STL file does not exist: ${stlPath}`);
  }

  const mode = resolveUnwrapMode(flags.mode);
  const easeMm = parseOptionalFinite(flags.ease, 'ease', { min: 0, max: 1000 }) ?? 2;
  const seamAllowance = parseOptionalFinite(flags.sa, 'sa', { min: 0, max: 1000 }) ?? 10;
  const scale = parseOptionalFinite(flags.scale, 'scale', { min: 0.01, max: 100 }) ?? 1;
  const hasMat = flags.material !== undefined && flags.material !== null;
  const materialId = resolveValidatedMaterialId(flags.material, 'veg_leather');
  const material = getMaterialConfig(materialId);
  const explicitThickness = parseOptionalFinite(flags.thickness, 'thickness', { min: 0, max: 1000 });
  const thicknessMm =
    explicitThickness !== undefined
      ? explicitThickness
      : hasMat
        ? material.thicknessMm
        : 0;

  const stlBuf = fs.readFileSync(stlPath);
  const baseName = path.basename(stlPath);
  const mesh = parseSTL(stlBuf, baseName);

  const pattern = unwrapSTLToPattern(mesh, {
    name: `${path.basename(stlPath, path.extname(stlPath))} Cover`,
    mode,
    easeMm,
    thicknessMm,
    seamAllowance,
    scale,
    materialId: material.id,
  });
  pattern.materialId = material.id;
  pattern.material = material;

  const formats = parseFormats(flags.format, 'svg,dxf,json');
  const pageFormat = resolvePageFormat(flags.page);
  const outDir = resolveOutDirFlag(flags.out);
  const slug = `${path.basename(stlPath, path.extname(stlPath))}_${mode}`;
  const { absOut, writtenFiles } = writePatternArtifacts(
    pattern,
    outDir,
    formats,
    pageFormat,
    slug
  );

  const seamReport = validatePatternSeams(pattern);
  const nesting = nestPatternPieces(pattern, {});

  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'unwrap',
        stlFile: stlPath,
        triangleCount: mesh.triangleCount,
        mode,
        materialId: material.id,
        easeMm,
        seamAllowance,
        thicknessMm,
        pageFormat,
        outDir: absOut,
        files: writtenFiles,
        piecesCount: pattern.pieces.length,
        seamCount: pattern.seams.length,
        seamIssuesCount: Array.isArray(seamReport) ? seamReport.filter((r) => !r?.valid).length : 0,
        nesting: {
          requiredLengthMm: nesting.requiredLengthMm,
          utilizationPct: nesting.utilizationPct,
        },
      },
      null,
      2
    )}\n`
  );
}

function runVerifySimCommand(flags) {
  if (flags.template !== undefined && flags.stl !== undefined) {
    throw new Error('verify-sim accepts either --template or --stl, not both.');
  }
  const templateId = typeof flags.template === 'string' ? flags.template.trim() : '';
  if (flags.template !== undefined && !templateId) {
    throw new Error('Invalid --template value: template ID must be non-empty when --template is specified.');
  }
  const rawStl = typeof flags.stl === 'string' ? flags.stl.trim() : '';
  if (flags.stl !== undefined && !rawStl) {
    throw new Error('Invalid --stl value: path must be non-empty when --stl is specified.');
  }
  if (!templateId && !rawStl) {
    throw new Error('verify-sim requires either --template <id> or --stl <path>.');
  }
  if (flags.mode !== undefined && !rawStl) {
    throw new Error('Flag --mode in verify-sim is only supported with --stl.');
  }

  const mode = resolveUnwrapMode(flags.mode);
  const stepsRaw = parseOptionalFinite(flags.steps, 'steps');
  if (stepsRaw !== undefined && (!Number.isInteger(stepsRaw) || stepsRaw < 1 || stepsRaw > 600)) {
    throw new Error(`Invalid --steps "${flags.steps}": must be an integer between 1 and 600.`);
  }
  const steps = stepsRaw !== undefined ? stepsRaw : 60;

  let pattern;
  let stlMesh;
  let defaultMatId = 'cotton_jersey';
  let sourceLabel = templateId;

  if (rawStl) {
    const stlPath = path.resolve(rawStl);
    if (!fs.existsSync(stlPath) || !fs.statSync(stlPath).isFile()) {
      throw new Error(`STL file does not exist: ${stlPath}`);
    }
    const stlBuf = fs.readFileSync(stlPath);
    stlMesh = parseSTL(stlBuf, path.basename(stlPath));
    defaultMatId = 'veg_leather';
    const matId = resolveValidatedMaterialId(flags.material, defaultMatId);
    const matCfg = getMaterialConfig(matId);
    pattern = unwrapSTLToPattern(stlMesh, {
      name: `${path.basename(stlPath, path.extname(stlPath))} Cover`,
      mode,
      materialId: matCfg.id,
      thicknessMm: matCfg.thicknessMm,
    });
    pattern.materialId = matCfg.id;
    pattern.material = matCfg;
    sourceLabel = stlPath;
  } else {
    const tplMeta = TEMPLATE_CATALOG.find((t) => t.id === templateId);
    if (!tplMeta) {
      throw new Error(
        `Unknown template "${templateId}". Valid templates: ${TEMPLATE_CATALOG.map((t) => t.id).join(', ')}`
      );
    }
    defaultMatId = tplMeta.defaultMaterial || 'cotton_jersey';
    const matId = resolveValidatedMaterialId(flags.material, defaultMatId);
    const matCfg = getMaterialConfig(matId);
    pattern = generateTemplatePattern(templateId, {}, { materialId: matCfg.id });
    pattern.materialId = matCfg.id;
    pattern.material = matCfg;
  }

  const sim = runSimulationSteps(pattern, {
    steps,
    materialId: pattern.materialId,
    material: pattern.material,
    stlMesh,
  });

  const allCoordsFinite =
    Array.isArray(sim.particles) &&
    sim.particles.length > 0 &&
    sim.particles.every(
      (p) =>
        Number.isFinite(p.pos?.x) &&
        Number.isFinite(p.pos?.y) &&
        Number.isFinite(p.pos?.z)
    );
  const metricsFinite =
    Number.isFinite(sim.avgSewGapMm) &&
    Number.isFinite(sim.strainReport?.meanStrainPct) &&
    Number.isFinite(sim.strainReport?.maxStrainPct);

  const finiteOk = Boolean(sim.finiteOk && allCoordsFinite && metricsFinite);
  const summary = {
    command: 'verify-sim',
    source: sourceLabel,
    materialId: pattern.materialId,
    stepCount: sim.stepCount,
    particlesCount: sim.particles.length,
    triangleCount: sim.triangles.length,
    avgSewGapMm: Number(sim.avgSewGapMm.toFixed(4)),
    strainReport: {
      meanStrainPct: Number(sim.strainReport.meanStrainPct.toFixed(4)),
      maxStrainPct: Number(sim.strainReport.maxStrainPct.toFixed(4)),
      fitStatus: sim.strainReport.fitStatus,
    },
    finiteOk,
  };

  if (!finiteOk) {
    process.stderr.write(`Simulation stability check failed: ${JSON.stringify(summary)}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

export async function runCliMain(argv = process.argv.slice(2)) {
  try {
    const { command, positionals, flags } = parseCliArgs(argv);

    if (flags.help || flags.h || command === 'help') {
      printUsage(process.stdout);
      return 0;
    }

    if (!command) {
      printUsage(process.stderr);
      return 1;
    }

    if (positionals.length > 1) {
      throw new Error(`Unexpected positional argument(s): ${positionals.slice(1).join(', ')}`);
    }

    assertAllowedFlags(command, flags);

    switch (command) {
      case 'list':
        runListCommand();
        return 0;
      case 'template':
        runTemplateCommand(flags);
        return 0;
      case 'unwrap':
        runUnwrapCommand(flags);
        return 0;
      case 'verify-sim':
        return runVerifySimCommand(flags);
      default:
        process.stderr.write(`Unknown CLI command: "${command}". Run --help for usage.\n`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`CLI Error: ${err?.message || String(err)}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const exitCode = await runCliMain(process.argv.slice(2));
  process.exit(exitCode);
}
