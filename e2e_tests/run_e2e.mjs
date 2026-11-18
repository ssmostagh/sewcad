#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

const TIER_MODULES = [
  { tier: 1, file: 'tier1_cad_blocks.mjs' },
  { tier: 1, file: 'tier1_sim_export_ui.mjs' },
  { tier: 2, file: 'tier2_boundaries.mjs' },
  { tier: 3, file: 'tier3_pairwise.mjs' },
  { tier: 4, file: 'tier4_scenarios.mjs' },
];

function parseCliArgs(argv) {
  const opts = {
    tiers: null, // null => all
    features: null,
    idSubstr: null,
    format: 'text',
    list: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--list') {
      opts.list = true;
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg.startsWith('--tier=')) {
      opts.tiers = parseTierValue(arg.slice('--tier='.length));
    } else if (arg === '--tier' && i + 1 < argv.length) {
      opts.tiers = parseTierValue(argv[++i]);
    } else if (arg.startsWith('--feature=')) {
      opts.features = parseFeatureValue(arg.slice('--feature='.length));
    } else if (arg === '--feature' && i + 1 < argv.length) {
      opts.features = parseFeatureValue(argv[++i]);
    } else if (arg.startsWith('--id=')) {
      opts.idSubstr = arg.slice('--id='.length);
    } else if (arg === '--id' && i + 1 < argv.length) {
      opts.idSubstr = argv[++i];
    } else if (arg.startsWith('--format=')) {
      opts.format = arg.slice('--format='.length).toLowerCase();
    } else if (arg === '--format' && i + 1 < argv.length) {
      opts.format = argv[++i].toLowerCase();
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (!['text', 'json'].includes(opts.format)) {
    throw new Error(`Unsupported --format=${opts.format} (expected text or json)`);
  }

  return opts;
}

function parseTierValue(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (!val || val === 'all') return null;
  const set = new Set();
  for (const part of val.split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (![1, 2, 3, 4].includes(n)) {
      throw new Error(`Invalid tier value "${part}" (expected 1, 2, 3, 4, or all)`);
    }
    set.add(n);
  }
  return set;
}

function parseFeatureValue(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}

function matchesFeature(test, featureSet) {
  if (!featureSet) return true;
  const tokens = new Set();
  if (test.feature) {
    for (const tok of String(test.feature).toUpperCase().split(/[+,/\s]+/)) {
      if (tok) tokens.add(tok);
    }
  }
  if (Array.isArray(test.features)) {
    for (const f of test.features) {
      tokens.add(String(f).toUpperCase());
    }
  }
  for (const req of featureSet) {
    if (tokens.has(req)) return true;
  }
  return false;
}

function matchesId(test, idSubstr) {
  if (!idSubstr) return true;
  const needle = idSubstr.toLowerCase();
  return (
    String(test.id || '').toLowerCase().includes(needle) ||
    String(test.name || '').toLowerCase().includes(needle)
  );
}

const USAGE_TEXT = `Usage: node e2e_tests/run_e2e.mjs [options]

Options:
  --tier=1|2|3|4|all      Run/list specific tier(s) (comma-separated or 'all', default: all)
  --feature=F01[,F02]     Filter tests by feature ID(s)
  --id=<substr>           Filter tests by ID or name substring
  --format=text|json      Output format (default: text)
  --list                  List matching tests without running them
  --verbose, -v           Show failure stack traces and detailed timing
  --help, -h              Show this help message`;

function writeStreamAndWait(stream, text) {
  return new Promise((resolve) => {
    const onError = () => resolve();
    stream.once('error', onError);
    stream.write(text, 'utf8', () => {
      stream.removeListener('error', onError);
      resolve();
    });
  });
}

async function exitWith(code, stdoutText = null, stderrText = null) {
  if (stdoutText !== null) await writeStreamAndWait(process.stdout, stdoutText);
  if (stderrText !== null) await writeStreamAndWait(process.stderr, stderrText);
  process.exit(code);
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    await exitWith(2, null, `Error: ${err.message}\n${USAGE_TEXT}\n`);
  }

  if (opts.help) {
    await exitWith(0, `${USAGE_TEXT}\n`);
  }

  const selectedModules = TIER_MODULES.filter((m) => !opts.tiers || opts.tiers.has(m.tier));
  const missingFiles = [];
  const allTests = [];

  for (const entry of selectedModules) {
    const modPath = path.join(E2E_DIR, entry.file);
    if (!fs.existsSync(modPath)) {
      if (opts.list) {
        console.error(`[WARN] Missing tier module skipped during --list: ${entry.file}`);
        missingFiles.push(entry.file);
        continue;
      }
      missingFiles.push(entry.file);
      continue;
    }

    const mod = await import(pathToFileURL(modPath).href);
    if (typeof mod.getTests !== 'function') {
      throw new Error(`Tier module ${entry.file} does not export getTests()`);
    }
    const tests = mod.getTests();
    if (!Array.isArray(tests)) {
      throw new Error(`Tier module ${entry.file} getTests() did not return an Array`);
    }
    for (const t of tests) {
      allTests.push({
        id: String(t.id),
        tier: Number(t.tier ?? entry.tier),
        feature: String(t.feature ?? ''),
        features: Array.isArray(t.features) ? t.features : undefined,
        name: String(t.name ?? ''),
        fn: t.fn,
        file: entry.file,
      });
    }
  }

  if (!opts.list && missingFiles.length > 0) {
    const msg = `Requested tier module(s) missing: ${missingFiles.join(', ')}`;
    if (opts.format === 'json') {
      const payload =
        JSON.stringify(
          {
            summary: { total: 0, passed: 0, failed: missingFiles.length, durationMs: 0, error: msg },
            tests: [],
          },
          null,
          2
        ) + '\n';
      await exitWith(1, payload);
    } else {
      await exitWith(1, null, `ERROR: ${msg}\n`);
    }
  }

  const matched = allTests.filter(
    (t) =>
      (!opts.tiers || opts.tiers.has(t.tier)) &&
      matchesFeature(t, opts.features) &&
      matchesId(t, opts.idSubstr)
  );

  if (opts.list) {
    if (opts.format === 'json') {
      const payload =
        JSON.stringify(
          {
            total: matched.length,
            missingFiles,
            tests: matched.map(({ id, tier, feature, name, file }) => ({
              id,
              tier,
              feature,
              name,
              file,
            })),
          },
          null,
          2
        ) + '\n';
      await exitWith(0, payload);
    } else {
      const lines = matched.map((t) => `[T${t.tier}] ${t.id} (${t.feature}) - ${t.name}`);
      lines.push(`\nListed ${matched.length} test(s).`);
      await exitWith(0, lines.join('\n') + '\n');
    }
  }

  if (matched.length === 0) {
    const msg = 'No tests matched the specified filters (total === 0).';
    if (opts.format === 'json') {
      const payload =
        JSON.stringify(
          {
            summary: { total: 0, passed: 0, failed: 0, durationMs: 0, error: msg, byTier: {} },
            tests: [],
          },
          null,
          2
        ) + '\n';
      await exitWith(1, payload);
    } else {
      await exitWith(1, null, `FAIL: ${msg}\n`);
    }
  }

  const suiteStart = performance.now();
  const results = [];
  const byTier = {};

  for (const t of matched) {
    const t0 = performance.now();
    let status = 'PASS';
    let errorMsg = null;
    let stack = null;

    try {
      if (typeof t.fn !== 'function') {
        throw new Error(`Test ${t.id} has non-function fn`);
      }
      await t.fn();
    } catch (err) {
      status = 'FAIL';
      errorMsg = err instanceof Error ? err.message : String(err);
      stack = err instanceof Error ? err.stack : null;
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;
    const rec = {
      id: t.id,
      tier: t.tier,
      feature: t.feature,
      name: t.name,
      status,
      durationMs,
    };
    if (errorMsg !== null) rec.error = errorMsg;
    if (opts.verbose && stack) rec.stack = stack;
    results.push(rec);

    const tierKey = `T${t.tier}`;
    if (!byTier[tierKey]) byTier[tierKey] = { total: 0, passed: 0, failed: 0 };
    byTier[tierKey].total++;
    if (status === 'PASS') byTier[tierKey].passed++;
    else byTier[tierKey].failed++;

    if (opts.format === 'text') {
      const timing = opts.verbose ? ` (${durationMs.toFixed(1)}ms)` : '';
      if (status === 'PASS') {
        console.log(`PASS ${t.id} [${t.feature}] ${t.name}${timing}`);
      } else {
        console.log(`FAIL ${t.id} [${t.feature}] ${t.name}${timing}`);
        console.log(`     -> ${errorMsg}`);
        if (opts.verbose && stack) {
          console.log(
            stack
              .split('\n')
              .slice(1)
              .map((l) => `     ${l}`)
              .join('\n')
          );
        }
      }
    }
  }

  const totalDurationMs = Math.round((performance.now() - suiteStart) * 100) / 100;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  const exitCode = failed === 0 && results.length > 0 ? 0 : 1;

  if (opts.format === 'json') {
    const payload =
      JSON.stringify(
        {
          summary: {
            total: results.length,
            passed,
            failed,
            durationMs: totalDurationMs,
            byTier,
          },
          tests: results,
        },
        null,
        2
      ) + '\n';
    await exitWith(exitCode, payload);
  } else {
    const summaryLines = ['\n=== E2E Tier Summary ==='];
    for (const key of Object.keys(byTier).sort()) {
      const s = byTier[key];
      summaryLines.push(`  ${key}: ${s.passed}/${s.total} passed (${s.failed} failed)`);
    }
    summaryLines.push(
      `Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Time: ${(
        totalDurationMs / 1000
      ).toFixed(2)}s`
    );
    await exitWith(exitCode, summaryLines.join('\n') + '\n');
  }
}

main().catch(async (err) => {
  await exitWith(1, null, `Runner fatal error: ${err?.stack || err}\n`);
});
