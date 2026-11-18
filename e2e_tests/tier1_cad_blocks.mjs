import fs from 'node:fs';
import {
  WEDGE_ASSEMBLED_STL,
  assert,
  assertNear,
  loadCore,
  dist2DIndependent,
  shoelaceSignedArea,
  shoelaceArea,
  calcBounds,
  polylinePerimeter,
  countSelfIntersections,
  evalQuadBezierIndependent,
  evalCubicBezierIndependent,
  sampleCubicArcLengthIndependent,
  samplePieceOutlineIndependent,
  buildSeamConnectivity,
  parseAsciiSTLIndependent,
} from './helpers.mjs';

function assertAllPiecesCCWAndSimple(core, pattern, label) {
  assert(pattern && Array.isArray(pattern.pieces) && pattern.pieces.length > 0, `${label}: missing pieces`);
  for (const piece of pattern.pieces) {
    const netPts = samplePieceOutlineIndependent(piece, 32);
    assert(netPts.length >= 3, `${label} (${piece.id}): net outline has < 3 points`);
    const netSigned = shoelaceSignedArea(netPts);
    assert(netSigned > 0, `${label} (${piece.id}): net outline must be CCW (signedArea=${netSigned})`);
    const netIntersections = countSelfIntersections(netPts);
    assert(
      netIntersections === 0,
      `${label} (${piece.id}): net outline has ${netIntersections} self-intersection(s)`
    );

    const cutPts = core.computePieceCutBoundary(piece, 24);
    assert(Array.isArray(cutPts) && cutPts.length >= 3, `${label} (${piece.id}): cut boundary empty`);
    const cutSigned = shoelaceSignedArea(cutPts);
    assert(cutSigned > 0, `${label} (${piece.id}): cut boundary must be CCW (signedArea=${cutSigned})`);
    const cutIntersections = countSelfIntersections(cutPts);
    assert(
      cutIntersections === 0,
      `${label} (${piece.id}): cut boundary has ${cutIntersections} self-intersection(s)`
    );
    assert(
      shoelaceArea(cutPts) >= shoelaceArea(netPts) - 1e-3,
      `${label} (${piece.id}): cut area should be >= net area`
    );
  }
}

function assertAllSeamsValidAndConnected(core, pattern, label) {
  const conn = buildSeamConnectivity(pattern);
  assert(
    conn.isFullyConnected,
    `${label}: pattern seam graph is disconnected (components=${conn.componentCount}, isolated=[${conn.isolatedPieceIds.join(', ')}])`
  );
  const reports = core.validatePatternSeams(pattern);
  assert(Array.isArray(reports) && reports.length === pattern.seams.length, `${label}: seam report count mismatch`);
  assert(reports.length > 0, `${label}: expected at least 1 seam`);
  for (const r of reports) {
    assert(
      r.valid === true && (r.status === 'ok' || r.status === 'ease'),
      `${label}: seam "${r.seamId}" invalid (status=${r.status}, deltaMm=${r.deltaMm})`
    );
  }
  return { conn, reports };
}

function getPatternParams(pattern) {
  return pattern?.params ?? pattern?.parameters ?? {};
}

function getUnwrappedWedgePattern(core, opts = {}) {
  assert(fs.existsSync(WEDGE_ASSEMBLED_STL), `Missing verification STL: ${WEDGE_ASSEMBLED_STL}`);
  const stlText = fs.readFileSync(WEDGE_ASSEMBLED_STL, 'utf8');
  const stlOracle = parseAsciiSTLIndependent(stlText);
  assert(stlOracle.triangleCount === 984, `Expected 984 tris in wedge STL, got ${stlOracle.triangleCount}`);

  if (typeof core.parseSTL === 'function' && typeof core.unwrapSTLToPattern === 'function') {
    const mesh = core.parseSTL(stlText, 'cutting_mat_wedge_assembled_view.stl');
    const pattern = core.unwrapSTLToPattern(mesh, {
      name: 'cutting_mat_wedge_assembled_view',
      mode: opts.mode ?? 'form_shell_cover',
      easeMm: opts.easeMm ?? 2,
      thicknessMm: opts.thicknessMm ?? 2,
      seamAllowance: opts.seamAllowance ?? 10,
      scale: opts.scale ?? 1,
    });
    return { pattern, stlOracle };
  }

  const pattern = core.generateTemplatePattern('stl_cover', {
    stlText,
    stlName: 'cutting_mat_wedge_assembled_view.stl',
    mode: opts.mode ?? 'form_shell_cover',
    easeMm: opts.easeMm ?? 2,
    thicknessMm: opts.thicknessMm ?? 2,
    seamAllowance: opts.seamAllowance ?? 10,
    scale: opts.scale ?? 1,
  });
  return { pattern, stlOracle };
}

export function getTests() {
  return [
    // =========================================================================
    // F01: Canonical Pattern Project Schema (T1-F01-1..5)
    // =========================================================================
    {
      id: 'T1-F01-1',
      tier: 1,
      feature: 'F01',
      name: 'Default project & template emit canonical mm schema',
      fn: async () => {
        const core = await loadCore();
        const proj = core.createPatternProject({ name: 'Unit Check' });
        assert(proj && typeof proj === 'object', 'createPatternProject must return an object');
        assert(proj.unit === 'mm', `Expected unit="mm", got ${proj.unit}`);
        assert(Array.isArray(proj.pieces), 'pieces must be an array');
        assert(Array.isArray(proj.seams), 'seams must be an array');
        assert(typeof proj.materialId === 'string' && proj.materialId.length > 0, 'materialId required');
        assert(typeof proj.version === 'string' && proj.version.length > 0, 'version required');

        const tshirt = core.generateTemplatePattern('tshirt');
        assert(tshirt.unit === 'mm', `Template unit must be "mm", got ${tshirt.unit}`);
        assert(tshirt.templateId === 'tshirt', `Expected templateId="tshirt", got ${tshirt.templateId}`);
        const p = getPatternParams(tshirt);
        assert(typeof p === 'object' && p !== null && Object.keys(p).length > 0, 'params/parameters must be populated');
      },
    },
    {
      id: 'T1-F01-2',
      tier: 1,
      feature: 'F01',
      name: 'PatternPiece required fields, edge count parity, and CCW outline',
      fn: async () => {
        const core = await loadCore();
        const tshirt = core.generateTemplatePattern('tshirt');
        assert(tshirt.pieces.length >= 5, 'Expected >=5 pieces');
        for (const piece of tshirt.pieces) {
          assert(typeof piece.id === 'string' && piece.id.length > 0, 'piece.id required');
          assert(typeof piece.name === 'string' && piece.name.length > 0, 'piece.name required');
          assert(typeof piece.role === 'string' && piece.role.length > 0, 'piece.role required');
          assert(
            piece.position && Number.isFinite(piece.position.x) && Number.isFinite(piece.position.y),
            `piece ${piece.id} position invalid`
          );
          assert(Number.isFinite(piece.rotation), `piece ${piece.id} rotation must be finite`);
          assert(
            Number.isFinite(piece.seamAllowance) && piece.seamAllowance >= 0,
            `piece ${piece.id} seamAllowance must be >= 0`
          );
          assert(Array.isArray(piece.points) && piece.points.length >= 3, `piece ${piece.id} needs >= 3 points`);
          assert(
            Array.isArray(piece.edges) && piece.edges.length === piece.points.length,
            `piece ${piece.id} edges.length must equal points.length`
          );
          assert(Array.isArray(piece.notches), `piece ${piece.id} notches must be array`);
          assert(Array.isArray(piece.darts), `piece ${piece.id} darts must be array`);
          assert(Array.isArray(piece.internalLines), `piece ${piece.id} internalLines must be array`);
          assert(
            piece.grainline && Number.isFinite(piece.grainline.angleDeg),
            `piece ${piece.id} grainline.angleDeg must be finite`
          );
          assert(
            piece.placement3D && piece.placement3D.offset && piece.placement3D.normal,
            `piece ${piece.id} placement3D required`
          );
          const outline = samplePieceOutlineIndependent(piece, 24);
          assert(shoelaceSignedArea(outline) > 0, `piece ${piece.id} must be CCW`);
        }
      },
    },
    {
      id: 'T1-F01-3',
      tier: 1,
      feature: 'F01',
      name: 'Seam references resolve to valid pieces, edges/internalLines, and ranges',
      fn: async () => {
        const core = await loadCore();
        for (const tid of ['tshirt', 'hoodie', 'pants', 'tote_bag']) {
          const pattern = core.generateTemplatePattern(tid);
          const byId = new Map(pattern.pieces.map((p) => [p.id, p]));
          assert(pattern.seams.length > 0, `${tid}: expected seams`);
          for (const seam of pattern.seams) {
            assert(typeof seam.id === 'string' && seam.id.length > 0, `${tid}: seam.id required`);
            const pA = byId.get(seam.pieceA);
            const pB = byId.get(seam.pieceB);
            assert(pA, `${tid}: seam ${seam.id} missing pieceA=${seam.pieceA}`);
            assert(pB, `${tid}: seam ${seam.id} missing pieceB=${seam.pieceB}`);
            assert(
              Number.isInteger(seam.edgeA) && seam.edgeA >= 0 && seam.edgeA < pA.points.length,
              `${tid}: seam ${seam.id} invalid edgeA=${seam.edgeA}`
            );
            if (seam.internalLineIdB) {
              const il = pB.internalLines.find((l) => l.id === seam.internalLineIdB);
              assert(il && il.points.length >= 2, `${tid}: seam ${seam.id} missing internalLineIdB`);
            } else {
              assert(
                Number.isInteger(seam.edgeB) && seam.edgeB >= 0 && seam.edgeB < pB.points.length,
                `${tid}: seam ${seam.id} invalid edgeB=${seam.edgeB}`
              );
            }
            const tsA = seam.tStartA ?? 0;
            const teA = seam.tEndA ?? 1;
            const tsB = seam.tStartB ?? 0;
            const teB = seam.tEndB ?? 1;
            assert(tsA >= 0 && teA <= 1 && tsA < teA, `${tid}: seam ${seam.id} invalid range A`);
            assert(tsB >= 0 && teB <= 1 && tsB < teB, `${tid}: seam ${seam.id} invalid range B`);
          }
        }
      },
    },
    {
      id: 'T1-F01-4',
      tier: 1,
      feature: 'F01',
      name: 'Schema includes avatar/material/stlMetadata keys and normalizes cm/in + legacy parameters',
      fn: async () => {
        const core = await loadCore();
        const raw = {
          name: 'Legacy Inch Project',
          unit: 'in',
          parameters: { chestMm: 1000 },
          avatar: { chestMm: 980, waistMm: 800 },
          material: { id: 'duck_canvas', gsm: 340 },
          stlMetadata: { source: 'test.stl', triangleCount: 12 },
          pieces: [
            {
              id: 'p1',
              name: 'Square 4in',
              seamAllowance: 0.5,
              points: [
                { x: 0, y: 0 },
                { x: 4, y: 0 },
                { x: 4, y: 4 },
                { x: 0, y: 4 },
              ],
            },
          ],
          seams: [],
        };
        const norm = core.normalizePatternProject(raw);
        assert(norm.unit === 'mm', `Normalized unit must be mm, got ${norm.unit}`);
        assert(norm.params?.chestMm === 1000, 'Legacy parameters should populate params');
        assert(norm.avatar && norm.avatar.chestMm === 980, 'avatar metadata preserved');
        assert(norm.material && norm.material.gsm === 340, 'material metadata preserved');
        assert(norm.stlMetadata && norm.stlMetadata.triangleCount === 12, 'stlMetadata preserved');
        const b = calcBounds(norm.pieces[0].points);
        assertNear(b.width, 4 * 25.4, 1e-6, '4 in normalized width');
        assertNear(b.height, 4 * 25.4, 1e-6, '4 in normalized height');
        assertNear(norm.pieces[0].seamAllowance, 0.5 * 25.4, 1e-6, '0.5 in normalized SA');
      },
    },
    {
      id: 'T1-F01-5',
      tier: 1,
      feature: 'F01',
      name: 'Invalid <3 points or NaN coords throws ValidationError',
      fn: async () => {
        const core = await loadCore();
        let threwLessThan3 = false;
        try {
          core.validatePatternProject({
            unit: 'mm',
            pieces: [
              {
                id: 'bad',
                name: 'Two Points',
                points: [{ x: 0, y: 0 }, { x: 50, y: 0 }],
                edges: [{ name: 'a' }, { name: 'b' }],
              },
            ],
            seams: [],
          });
        } catch (err) {
          threwLessThan3 = err instanceof core.ValidationError || err?.name === 'ValidationError';
        }
        assert(threwLessThan3, 'Expected ValidationError for piece with < 3 points');

        let threwNaN = false;
        try {
          core.validatePatternProject({
            unit: 'mm',
            pieces: [
              {
                id: 'bad_nan',
                name: 'NaN Piece',
                points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 0, y: 50 }],
                edges: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
              },
            ],
            seams: [],
          });
        } catch (err) {
          threwNaN = err instanceof core.ValidationError || err?.name === 'ValidationError';
        }
        assert(threwNaN, 'Expected ValidationError for NaN coordinate');
      },
    },

    // =========================================================================
    // F02: Parametric T-Shirt (tshirt) (T1-F02-1..5)
    // =========================================================================
    {
      id: 'T1-F02-1',
      tier: 1,
      feature: 'F02',
      name: 'T-shirt generates 5 pieces (front, back, 2 sleeves, neckband)',
      fn: async () => {
        const core = await loadCore();
        const tshirt = core.generateTemplatePattern('tshirt');
        assert(tshirt.pieces.length === 5, `Expected 5 tshirt pieces, got ${tshirt.pieces.length}`);
        const ids = tshirt.pieces.map((p) => p.id);
        assert(new Set(ids).size === 5, 'T-shirt piece IDs must be unique');
        const namesLower = tshirt.pieces.map((p) => `${p.id} ${p.name}`.toLowerCase());
        assert(namesLower.some((s) => s.includes('front')), 'Missing front bodice');
        assert(namesLower.some((s) => s.includes('back')), 'Missing back bodice');
        assert(namesLower.filter((s) => s.includes('sleeve')).length === 2, 'Expected 2 sleeves');
        assert(namesLower.some((s) => s.includes('neck')), 'Missing neckband piece');
      },
    },
    {
      id: 'T1-F02-2',
      tier: 1,
      feature: 'F02',
      name: 'T-shirt all 5 pieces have CCW non-self-intersecting net and cut outlines',
      fn: async () => {
        const core = await loadCore();
        const tshirt = core.generateTemplatePattern('tshirt');
        assertAllPiecesCCWAndSimple(core, tshirt, 'tshirt');
      },
    },
    {
      id: 'T1-F02-3',
      tier: 1,
      feature: 'F02',
      name: 'T-shirt neckband is wired into main seam graph (catches v1 disconnected neckband)',
      fn: async () => {
        const core = await loadCore();
        const tshirt = core.generateTemplatePattern('tshirt');
        const { conn } = assertAllSeamsValidAndConnected(core, tshirt, 'tshirt');
        const neckPiece = tshirt.pieces.find((p) => `${p.id} ${p.name}`.toLowerCase().includes('neck'));
        assert(neckPiece, 'Neckband piece missing');
        assert(conn.connectedPieceIds.has(neckPiece.id), 'Neckband is isolated from seam graph');
        assert((conn.adjacency.get(neckPiece.id)?.size ?? 0) >= 2, 'Neckband should connect to both front and back');
      },
    },
    {
      id: 'T1-F02-4',
      tier: 1,
      feature: 'F02',
      name: 'T-shirt shoulder, side, armhole, and neckband seams validate cleanly',
      fn: async () => {
        const core = await loadCore();
        const tshirt = core.generateTemplatePattern('tshirt');
        const reports = core.validatePatternSeams(tshirt);
        assert(reports.length >= 8, `Expected >= 8 tshirt seams, got ${reports.length}`);
        for (const r of reports) {
          assert(r.valid === true, `T-shirt seam ${r.seamId} invalid: ${r.status} delta=${r.deltaMm}mm`);
        }
      },
    },
    {
      id: 'T1-F02-5',
      tier: 1,
      feature: 'F02',
      name: 'T-shirt custom chestMm and sleeveLengthMm scale dimensions monotonically',
      fn: async () => {
        const core = await loadCore();
        const small = core.generateTemplatePattern('tshirt', { chestMm: 840, sleeveLengthMm: 180 });
        const large = core.generateTemplatePattern('tshirt', { chestMm: 1200, sleeveLengthMm: 280 });

        const frontS = small.pieces.find((p) => p.id.includes('front'));
        const frontL = large.pieces.find((p) => p.id.includes('front'));
        const sleeveS = small.pieces.find((p) => p.id.includes('sleeve'));
        const sleeveL = large.pieces.find((p) => p.id.includes('sleeve'));

        const bFrontS = calcBounds(samplePieceOutlineIndependent(frontS, 24));
        const bFrontL = calcBounds(samplePieceOutlineIndependent(frontL, 24));
        assert(bFrontL.width > bFrontS.width + 60, `Expected front width to scale with chestMm (${bFrontS.width} -> ${bFrontL.width})`);

        const bSleeveS = calcBounds(samplePieceOutlineIndependent(sleeveS, 24));
        const bSleeveL = calcBounds(samplePieceOutlineIndependent(sleeveL, 24));
        assert(bSleeveL.height > bSleeveS.height + 50, `Expected sleeve height to scale with sleeveLengthMm (${bSleeveS.height} -> ${bSleeveL.height})`);
      },
    },

    // =========================================================================
    // F03: Parametric Hoodie (hoodie) (T1-F03-1..5)
    // =========================================================================
    {
      id: 'T1-F03-1',
      tier: 1,
      feature: 'F03',
      name: 'Hoodie generates >= 8 pieces including hood panels, kangaroo pocket, and waistband',
      fn: async () => {
        const core = await loadCore();
        const hoodie = core.generateTemplatePattern('hoodie');
        assert(hoodie.pieces.length >= 8, `Expected >= 8 hoodie pieces, got ${hoodie.pieces.length}`);
        const idsAndNames = hoodie.pieces.map((p) => `${p.id} ${p.name}`.toLowerCase());
        assert(idsAndNames.filter((s) => s.includes('hood')).length >= 2, 'Expected 2 hood panels');
        assert(idsAndNames.some((s) => s.includes('pocket')), 'Expected kangaroo pocket');
        assert(idsAndNames.some((s) => s.includes('waist') || s.includes('rib')), 'Expected waistband rib');
        assert(idsAndNames.filter((s) => s.includes('sleeve')).length === 2, 'Expected 2 sleeves');
      },
    },
    {
      id: 'T1-F03-2',
      tier: 1,
      feature: 'F03',
      name: 'Hoodie all pieces have CCW non-self-intersecting net and cut outlines',
      fn: async () => {
        const core = await loadCore();
        const hoodie = core.generateTemplatePattern('hoodie');
        assertAllPiecesCCWAndSimple(core, hoodie, 'hoodie');
      },
    },
    {
      id: 'T1-F03-3',
      tier: 1,
      feature: 'F03',
      name: 'Hoodie hood-to-neck, pocket, and waistband seams are wired into main graph',
      fn: async () => {
        const core = await loadCore();
        const hoodie = core.generateTemplatePattern('hoodie');
        const { conn } = assertAllSeamsValidAndConnected(core, hoodie, 'hoodie');
        for (const piece of hoodie.pieces) {
          assert(conn.connectedPieceIds.has(piece.id), `Hoodie piece ${piece.id} must not be isolated`);
        }
      },
    },
    {
      id: 'T1-F03-4',
      tier: 1,
      feature: 'F03',
      name: 'Hoodie front bodice includes kangaroo pocket placement internalLines inside bounds',
      fn: async () => {
        const core = await loadCore();
        const hoodie = core.generateTemplatePattern('hoodie');
        const front = hoodie.pieces.find((p) => `${p.id} ${p.name}`.toLowerCase().includes('front'));
        assert(front, 'Hoodie front bodice missing');
        const pocketGuides = (front.internalLines || []).filter(
          (il) => il.type === 'pocket' || /pocket/i.test(`${il.id} ${il.name}`)
        );
        assert(pocketGuides.length >= 1, 'Expected kangaroo pocket placement internalLine on hoodie front');
        const fb = calcBounds(samplePieceOutlineIndependent(front, 24));
        for (const il of pocketGuides) {
          assert(Array.isArray(il.points) && il.points.length >= 2, 'Pocket internalLine needs >= 2 points');
          for (const pt of il.points) {
            assert(
              pt.x >= fb.minX - 1 && pt.x <= fb.maxX + 1 && pt.y >= fb.minY - 1 && pt.y <= fb.maxY + 1,
              `Pocket placement point (${pt.x},${pt.y}) outside front bodice bounds`
            );
          }
        }
      },
    },
    {
      id: 'T1-F03-5',
      tier: 1,
      feature: 'F03',
      name: 'Hoodie custom chestMm and lengthMm scale garment dimensions accurately',
      fn: async () => {
        const core = await loadCore();
        const small = core.generateTemplatePattern('hoodie', { chestMm: 900, lengthMm: 580 });
        const large = core.generateTemplatePattern('hoodie', { chestMm: 1280, lengthMm: 760 });
        const fS = small.pieces.find((p) => p.id.includes('front'));
        const fL = large.pieces.find((p) => p.id.includes('front'));
        const bS = calcBounds(samplePieceOutlineIndependent(fS, 24));
        const bL = calcBounds(samplePieceOutlineIndependent(fL, 24));
        assert(bL.width > bS.width + 70, `Hoodie width did not scale (${bS.width} -> ${bL.width})`);
        assert(bL.height > bS.height + 100, `Hoodie length did not scale (${bS.height} -> ${bL.height})`);
      },
    },

    // =========================================================================
    // F04: Parametric Pants (pants) (T1-F04-1..5)
    // =========================================================================
    {
      id: 'T1-F04-1',
      tier: 1,
      feature: 'F04',
      name: 'Pants generate 5 pieces (L/R front legs, L/R back legs, contoured waistband)',
      fn: async () => {
        const core = await loadCore();
        const pants = core.generateTemplatePattern('pants');
        assert(pants.pieces.length === 5, `Expected 5 pants pieces, got ${pants.pieces.length}`);
        const labels = pants.pieces.map((p) => `${p.id} ${p.name}`.toLowerCase());
        assert(labels.filter((s) => s.includes('front')).length >= 2, 'Expected 2 front legs');
        assert(labels.filter((s) => s.includes('back')).length >= 2, 'Expected 2 back legs');
        assert(labels.some((s) => s.includes('waist')), 'Expected contoured waistband');
      },
    },
    {
      id: 'T1-F04-2',
      tier: 1,
      feature: 'F04',
      name: 'Pants legs feature J-crotch Bezier curves, waist darts, and CCW non-self-intersecting outlines',
      fn: async () => {
        const core = await loadCore();
        const pants = core.generateTemplatePattern('pants');
        assertAllPiecesCCWAndSimple(core, pants, 'pants');
        const legs = pants.pieces.filter((p) => !`${p.id} ${p.name}`.toLowerCase().includes('waist'));
        assert(legs.length === 4, 'Expected 4 leg pieces');
        for (const leg of legs) {
          assert(
            leg.edges.some((e) => Boolean(e.curve)),
            `Leg ${leg.id} missing J-crotch Bezier curve`
          );
          assert(
            Array.isArray(leg.darts) && leg.darts.length >= 1,
            `Leg ${leg.id} missing waist dart`
          );
        }
      },
    },
    {
      id: 'T1-F04-3',
      tier: 1,
      feature: 'F04',
      name: 'Pants waistband, inseam, outseam, and crotch seams are wired and valid',
      fn: async () => {
        const core = await loadCore();
        const pants = core.generateTemplatePattern('pants');
        const { conn } = assertAllSeamsValidAndConnected(core, pants, 'pants');
        const wb = pants.pieces.find((p) => `${p.id} ${p.name}`.toLowerCase().includes('waist'));
        assert(wb && conn.connectedPieceIds.has(wb.id), 'Pants waistband must be wired into seam graph');
      },
    },
    {
      id: 'T1-F04-4',
      tier: 1,
      feature: 'F04',
      name: 'Pants leg pieces include knee balance internalLines inside leg bounds',
      fn: async () => {
        const core = await loadCore();
        const pants = core.generateTemplatePattern('pants');
        const legs = pants.pieces.filter((p) => !`${p.id} ${p.name}`.toLowerCase().includes('waist'));
        for (const leg of legs) {
          const kneeLines = (leg.internalLines || []).filter(
            (il) => il.type === 'balance' || /knee/i.test(`${il.id} ${il.name}`)
          );
          assert(kneeLines.length >= 1, `Leg ${leg.id} missing knee balance internalLine`);
          const b = calcBounds(samplePieceOutlineIndependent(leg, 24));
          for (const kl of kneeLines) {
            assert(kl.points.length >= 2, 'Knee line needs >= 2 points');
            for (const pt of kl.points) {
              assert(
                pt.y >= b.minY - 1 && pt.y <= b.maxY + 1,
                `Knee line Y=${pt.y} outside leg bounds [${b.minY}, ${b.maxY}]`
              );
            }
          }
        }
      },
    },
    {
      id: 'T1-F04-5',
      tier: 1,
      feature: 'F04',
      name: 'Pants custom hipMm and inseamMm scale leg width and length monotonically',
      fn: async () => {
        const core = await loadCore();
        const small = core.generateTemplatePattern('pants', { hipMm: 860, inseamMm: 650 });
        const large = core.generateTemplatePattern('pants', { hipMm: 1200, inseamMm: 880 });
        const legS = small.pieces.find((p) => p.id.includes('front'));
        const legL = large.pieces.find((p) => p.id.includes('front'));
        const bS = calcBounds(samplePieceOutlineIndependent(legS, 24));
        const bL = calcBounds(samplePieceOutlineIndependent(legL, 24));
        assert(bL.width > bS.width + 40, `Hip scaling failed (${bS.width} -> ${bL.width})`);
        assert(bL.height > bS.height + 150, `Inseam scaling failed (${bS.height} -> ${bL.height})`);
      },
    },

    // =========================================================================
    // F05: Parametric Tote Bag (tote_bag) (T1-F05-1..5)
    // =========================================================================
    {
      id: 'T1-F05-1',
      tier: 1,
      feature: 'F05',
      name: 'Tote bag generates 7 pieces (front, back, 3 gussets, 2 carry straps)',
      fn: async () => {
        const core = await loadCore();
        const tote = core.generateTemplatePattern('tote_bag');
        assert(tote.pieces.length === 7, `Expected 7 tote_bag pieces, got ${tote.pieces.length}`);
        assertAllPiecesCCWAndSimple(core, tote, 'tote_bag');
      },
    },
    {
      id: 'T1-F05-2',
      tier: 1,
      feature: 'F05',
      name: 'Tote bag gusset-to-panel seams have exact 0.0 mm length deltas',
      fn: async () => {
        const core = await loadCore();
        const tote = core.generateTemplatePattern('tote_bag');
        const reports = core.validatePatternSeams(tote);
        const gussetReports = reports.filter((r) => /gusset|base/i.test(`${r.seamId} ${r.name} ${r.pieceA} ${r.pieceB}`));
        assert(gussetReports.length >= 6, `Expected >= 6 gusset seams, got ${gussetReports.length}`);
        for (const r of gussetReports) {
          assertNear(r.deltaMm, 0, 0.05, `Gusset seam ${r.seamId} deltaMm`);
          assert(r.status === 'ok', `Expected status='ok' on gusset seam ${r.seamId}, got ${r.status}`);
        }
      },
    },
    {
      id: 'T1-F05-3',
      tier: 1,
      feature: 'F05',
      name: 'Tote bag straps are wired into main seam graph with placement notches',
      fn: async () => {
        const core = await loadCore();
        const tote = core.generateTemplatePattern('tote_bag');
        const { conn } = assertAllSeamsValidAndConnected(core, tote, 'tote_bag');
        const straps = tote.pieces.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes('strap'));
        assert(straps.length === 2, 'Expected 2 carry straps');
        for (const strap of straps) {
          assert(conn.connectedPieceIds.has(strap.id), `Strap ${strap.id} must be connected in seam graph`);
        }
        const totalNotches = tote.pieces.reduce((acc, p) => acc + (p.notches?.length ?? 0), 0);
        assert(totalNotches >= 4, `Expected strap/gusset alignment notches, got ${totalNotches}`);
      },
    },
    {
      id: 'T1-F05-4',
      tier: 1,
      feature: 'F05',
      name: 'Tote bag carry straps include fold internalLines',
      fn: async () => {
        const core = await loadCore();
        const tote = core.generateTemplatePattern('tote_bag');
        const straps = tote.pieces.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes('strap'));
        for (const strap of straps) {
          const folds = (strap.internalLines || []).filter((il) => il.type === 'fold');
          assert(folds.length >= 1, `Strap ${strap.id} missing fold internalLine`);
          assert(folds[0].points.length >= 2, 'Fold internalLine must have >= 2 points');
        }
      },
    },
    {
      id: 'T1-F05-5',
      tier: 1,
      feature: 'F05',
      name: 'Tote bag custom widthMm, heightMm, and gussetDepthMm scale piece bounds accurately',
      fn: async () => {
        const core = await loadCore();
        const tote = core.generateTemplatePattern('tote_bag', {
          widthMm: 420,
          heightMm: 460,
          gussetDepthMm: 140,
        });
        const front = tote.pieces.find((p) => p.id.includes('front') && !p.id.includes('strap'));
        const base = tote.pieces.find((p) => p.id.includes('base') || p.id.includes('bottom'));
        assert(front && base, 'Missing tote front or base gusset');
        const bf = calcBounds(samplePieceOutlineIndependent(front, 16));
        const bb = calcBounds(samplePieceOutlineIndependent(base, 16));
        assertNear(bf.width, 420, 0.1, 'Tote front width');
        assertNear(bf.height, 460, 0.1, 'Tote front height');
        assert(Math.abs(Math.min(bb.width, bb.height) - 140) <= 0.1, `Base gusset depth expected 140mm, got ${bb.width}x${bb.height}`);
      },
    },

    // =========================================================================
    // F06: Custom .STL Object Cover (stl_cover) (T1-F06-1..5)
    // =========================================================================
    {
      id: 'T1-F06-1',
      tier: 1,
      feature: 'F06',
      name: 'Default stl_cover wedge fallback generates non-empty CCW cover pieces with valid seams',
      fn: async () => {
        const core = await loadCore();
        const cover = core.generateTemplatePattern('stl_cover');
        assert(cover.templateId === 'stl_cover', 'Expected templateId="stl_cover"');
        assert(cover.pieces.length >= 4, `Expected >= 4 default wedge cover pieces, got ${cover.pieces.length}`);
        assertAllPiecesCCWAndSimple(core, cover, 'stl_cover_default');
        assertAllSeamsValidAndConnected(core, cover, 'stl_cover_default');
      },
    },
    {
      id: 'T1-F06-2',
      tier: 1,
      feature: 'F06',
      name: 'cutting_mat_wedge_assembled_view.stl produces real non-stub sewable cover pieces',
      fn: async () => {
        const core = await loadCore();
        const { pattern } = getUnwrappedWedgePattern(core, { easeMm: 2, thicknessMm: 2 });
        assert(!pattern.isStub, 'stl_cover on real STL must not return an M1 stub');
        assert(pattern.pieces.length >= 3, `Expected >= 3 unwrapped cover panels, got ${pattern.pieces.length}`);
        assert(pattern.pieces.every((p) => p.seamAllowance === 10), 'All stl_cover pieces should honor seamAllowance: 10');
        assertAllPiecesCCWAndSimple(core, pattern, 'stl_cover_assembled');
      },
    },
    {
      id: 'T1-F06-3',
      tier: 1,
      feature: 'F06',
      name: 'stl_cover easeMm + thicknessMm compensation measurably expands panel dimensions',
      fn: async () => {
        const core = await loadCore();
        const { pattern: tight } = getUnwrappedWedgePattern(core, { easeMm: 0, thicknessMm: 0 });
        const { pattern: padded } = getUnwrappedWedgePattern(core, { easeMm: 5, thicknessMm: 4 });
        assert(!tight.isStub && !padded.isStub, 'stl_cover must use real STL unwrapper (non-stub)');

        const sumArea = (pat) =>
          pat.pieces.reduce((acc, p) => acc + shoelaceArea(samplePieceOutlineIndependent(p, 16)), 0);
        const areaTight = sumArea(tight);
        const areaPadded = sumArea(padded);
        assert(
          areaPadded > areaTight * 1.03,
          `Expected easeMm + thicknessMm to expand total cover area (tight=${areaTight.toFixed(1)}, padded=${areaPadded.toFixed(1)})`
        );
      },
    },
    {
      id: 'T1-F06-4',
      tier: 1,
      feature: 'F06',
      name: 'stl_cover populates stlMetadata matching parsed STL geometry',
      fn: async () => {
        const core = await loadCore();
        const { pattern, stlOracle } = getUnwrappedWedgePattern(core, { easeMm: 2, thicknessMm: 2 });
        assert(
          pattern.stlMetadata && typeof pattern.stlMetadata === 'object',
          'stlMetadata must be populated (non-null) for unwrapped STL cover'
        );
        const triCount =
          pattern.stlMetadata.triangleCount ??
          pattern.stlMetadata.triangles ??
          pattern.stlMetadata.faces ??
          pattern.stlMetadata.sourceTriangleCount ??
          pattern.stlMetadata.mesh?.triangleCount;
        assert(
          triCount === stlOracle.triangleCount,
          `Expected stlMetadata triangleCount=${stlOracle.triangleCount}, got ${triCount}`
        );
      },
    },
    {
      id: 'T1-F06-5',
      tier: 1,
      feature: 'F06',
      name: 'Unwrapped stl_cover pattern has connected valid seams and alignment notches',
      fn: async () => {
        const core = await loadCore();
        const { pattern } = getUnwrappedWedgePattern(core, { easeMm: 2, thicknessMm: 2 });
        assert(!pattern.isStub, 'stl_cover must be non-stub');
        assertAllSeamsValidAndConnected(core, pattern, 'stl_cover_assembled');
        const totalNotches = pattern.pieces.reduce((acc, p) => acc + (p.notches?.length ?? 0), 0);
        assert(totalNotches >= 1, `Expected >= 1 alignment notch on stl_cover pieces, got ${totalNotches}`);
      },
    },

    // =========================================================================
    // F07: Freeform Polygon & Rect Drawing (T1-F07-1..5)
    // =========================================================================
    {
      id: 'T1-F07-1',
      tier: 1,
      feature: 'F07',
      name: 'createRectanglePiece creates exact WxH bounds and area with CCW winding',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Pocket Panel', 140, 95, { seamAllowance: 10 });
        assert(rect.name === 'Pocket Panel', `Unexpected name: ${rect.name}`);
        assertNear(rect.seamAllowance, 10, 1e-6, 'seamAllowance');
        assert(shoelaceSignedArea(rect.points) > 0, 'Rectangle points must be CCW');
        const b = calcBounds(rect.points);
        assertNear(b.width, 140, 1e-6, 'Rectangle width');
        assertNear(b.height, 95, 1e-6, 'Rectangle height');
        assertNear(shoelaceArea(rect.points), 140 * 95, 1e-4, 'Rectangle area');
      },
    },
    {
      id: 'T1-F07-2',
      tier: 1,
      feature: 'F07',
      name: 'createFreeformPiece emits closed polygon preserving exact geometric area',
      fn: async () => {
        const core = await loadCore();
        const pts = [
          { x: 10, y: 20 },
          { x: 110, y: 20 },
          { x: 130, y: 80 },
          { x: 60, y: 120 },
          { x: 10, y: 80 },
        ];
        const expectedArea = shoelaceArea(pts);
        const piece = core.createFreeformPiece('Pentagon', pts, { seamAllowance: 8 });
        assert(piece.name === 'Pentagon', 'Piece name mismatch');
        assert(piece.points.length === 5, `Expected 5 points, got ${piece.points.length}`);
        assertNear(shoelaceArea(piece.points), expectedArea, 1e-4, 'Freeform area');
        assert(countSelfIntersections(piece.points) === 0, 'Pentagon should not self-intersect');
      },
    },
    {
      id: 'T1-F07-3',
      tier: 1,
      feature: 'F07',
      name: 'createFreeformPiece normalizes clockwise (CW) input points to CCW',
      fn: async () => {
        const core = await loadCore();
        const cwPts = [
          { x: 0, y: 0 },
          { x: 0, y: 100 },
          { x: 120, y: 100 },
          { x: 120, y: 0 },
        ];
        assert(shoelaceSignedArea(cwPts) < 0, 'Test input must be CW');
        const piece = core.createFreeformPiece('CW Rect', cwPts, { seamAllowance: 12 });
        assert(shoelaceSignedArea(piece.points) > 0, 'createFreeformPiece must normalize CW -> CCW');
        assertNear(shoelaceArea(piece.points), 12000, 1e-4, 'Normalized area');
      },
    },
    {
      id: 'T1-F07-4',
      tier: 1,
      feature: 'F07',
      name: 'Freeform and rectangle creators auto-populate edges, grainline, and placement3D',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece('Hex', [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
          { x: 80, y: 40 },
          { x: 60, y: 80 },
          { x: 0, y: 80 },
          { x: -20, y: 40 },
        ]);
        assert(typeof piece.id === 'string' && piece.id.length > 0, 'Missing auto id');
        assert(Array.isArray(piece.edges) && piece.edges.length === 6, 'edges length must match 6 points');
        assert(piece.grainline && Number.isFinite(piece.grainline.angleDeg), 'grainline.angleDeg required');
        assert(piece.placement3D && piece.placement3D.offset && piece.placement3D.normal, 'placement3D required');
      },
    },
    {
      id: 'T1-F07-5',
      tier: 1,
      feature: 'F07',
      name: 'createFreeformPiece rejects < 3 points and createRectanglePiece rejects <= 0 dims',
      fn: async () => {
        const core = await loadCore();
        assert(
          typeof core.createFreeformPiece === 'function' && typeof core.createRectanglePiece === 'function',
          'createFreeformPiece and createRectanglePiece must be functions'
        );
        let threwPts = false;
        try {
          core.createFreeformPiece('Bad', [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
        } catch (err) {
          threwPts = err instanceof core.ValidationError || err?.name === 'ValidationError';
        }
        assert(threwPts, 'Expected ValidationError for < 3 points');

        let threwDim = false;
        try {
          core.createRectanglePiece('BadRect', 0, 50);
        } catch (err) {
          threwDim = err instanceof core.ValidationError || err?.name === 'ValidationError';
        }
        assert(threwDim, 'Expected ValidationError for widthMm <= 0');
      },
    },

    // =========================================================================
    // F08: Vertex, Edge & Bezier Editing (T1-F08-1..5)
    // =========================================================================
    {
      id: 'T1-F08-1',
      tier: 1,
      feature: 'F08',
      name: 'Moving a vertex updates polygon area and bounds accurately',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Quad', 100, 100);
        assertNear(core.polygonArea(rect.points), 10000, 1e-4, 'Initial area');
        // Pull top-right corner out by +40 in X -> trapezoid area = ((100 + 140)/2)*100 = 12000
        rect.points[2].x += 40;
        const indepArea = shoelaceArea(rect.points);
        assertNear(indepArea, 12000, 1e-4, 'Independent trapezoid area');
        assertNear(core.polygonArea(rect.points), indepArea, 1e-4, 'Core polygonArea after vertex move');
        assertNear(core.polygonBounds(rect.points).width, 140, 1e-4, 'Core bounds width after vertex move');
      },
    },
    {
      id: 'T1-F08-2',
      tier: 1,
      feature: 'F08',
      name: 'splitPieceEdge De Casteljau subdivision preserves cubic Bezier arc length <= 0.05 mm',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 0, y: 0 };
        const p1 = { x: 200, y: 0 };
        const cp1 = { x: 50, y: -90 };
        const cp2 = { x: 160, y: -70 };
        const piece = core.createFreeformPiece('Curved', [p0, p1, { x: 200, y: 120 }, { x: 0, y: 120 }], {
          edges: [
            { name: 'Curved Top', seamAllowance: 10, curve: { cp1, cp2 } },
            { name: 'Right', seamAllowance: 10 },
            { name: 'Bottom', seamAllowance: 10 },
            { name: 'Left', seamAllowance: 10 },
          ],
        });

        const origLen = sampleCubicArcLengthIndependent(p0, cp1, cp2, p1, 128);
        const tSplit = 0.4;
        const expectedMid = evalCubicBezierIndependent(p0, cp1, cp2, p1, tSplit);

        core.splitPieceEdge(piece, 0, tSplit);
        assert(piece.points.length === 5, `Expected 5 vertices after split, got ${piece.points.length}`);
        assert(piece.edges.length === 5, `Expected 5 edges after split, got ${piece.edges.length}`);

        const inserted = piece.points[1];
        assertNear(dist2DIndependent(inserted, expectedMid), 0, 1e-4, 'Split vertex must lie on cubic Bezier');

        const cA = piece.edges[0].curve;
        const cB = piece.edges[1].curve;
        assert(cA?.cp1 && cA?.cp2 && cB?.cp1 && cB?.cp2, 'Both split sub-edges must preserve cubic Bezier CPs');
        const lenA = sampleCubicArcLengthIndependent(piece.points[0], cA.cp1, cA.cp2, piece.points[1], 128);
        const lenB = sampleCubicArcLengthIndependent(piece.points[1], cB.cp1, cB.cp2, piece.points[2], 128);
        assertNear(lenA + lenB, origLen, 0.05, 'Sum of split sub-curve arc lengths');
      },
    },
    {
      id: 'T1-F08-3',
      tier: 1,
      feature: 'F08',
      name: 'splitPieceEdge remaps notches and darts onto split sub-edges without physical drift',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('Panel', 200, 100);
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.25, type: 'single' });
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.8, type: 'double' });
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.75, widthMm: 20, depthMm: 40 });

        const beforeNotches = core.computePieceNotches(piece).map((n) => ({ ...n.position }));
        core.splitPieceEdge(piece, 0, 0.5);
        const afterNotches = core.computePieceNotches(piece).map((n) => ({ ...n.position }));

        assert(afterNotches.length === 2, 'Notches preserved across split');
        for (let i = 0; i < 2; i++) {
          assertNear(dist2DIndependent(beforeNotches[i], afterNotches[i]), 0, 0.1, `Notch ${i} physical position`);
        }
        assert(piece.darts.length === 1, 'Dart preserved across split');
        assert(piece.darts[0].edgeIndex === 1, `Dart at t=0.75 should remap to edgeIndex=1, got ${piece.darts[0].edgeIndex}`);
        assertNear(piece.darts[0].t, 0.5, 1e-4, 'Dart remapped t on second half');
      },
    },
    {
      id: 'T1-F08-4',
      tier: 1,
      feature: 'F08',
      name: 'deletePieceVertex removes vertex cleanly and rejects deletion on 3-vertex triangle',
      fn: async () => {
        const core = await loadCore();
        const pent = core.createFreeformPiece('Pent', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 120, y: 50 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ]);
        core.deletePieceVertex(pent, 2);
        assert(pent.points.length === 4, `Expected 4 vertices after delete, got ${pent.points.length}`);
        assert(pent.edges.length === 4, `Expected 4 edges after delete, got ${pent.edges.length}`);
        assert(shoelaceSignedArea(pent.points) > 0, 'Remaining polygon must stay CCW');
        assertNear(shoelaceArea(pent.points), 10000, 1e-3, 'Deleted tip restores 100x100 square area');

        assert(typeof core.deletePieceVertex === 'function', 'deletePieceVertex must be a function');
        const tri = core.createFreeformPiece('Tri', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 50, y: 80 },
        ]);
        let threwMin = false;
        try {
          core.deletePieceVertex(tri, 0);
        } catch (err) {
          threwMin = err instanceof core.ValidationError || err?.name === 'ValidationError';
        }
        assert(threwMin, 'Deleting vertex from 3-vertex triangle must throw ValidationError');
      },
    },
    {
      id: 'T1-F08-5',
      tier: 1,
      feature: 'F08',
      name: 'evalQuadBezier, evalCubicBezier, and edgeArcLength match independent Bernstein oracle',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 10, y: 20 };
        const qcp = { x: 80, y: -40 };
        const p1 = { x: 170, y: 30 };
        const cp1 = { x: 40, y: -60 };
        const cp2 = { x: 140, y: 110 };

        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const qAct = core.evalQuadBezier(p0, qcp, p1, t);
          const qExp = evalQuadBezierIndependent(p0, qcp, p1, t);
          assertNear(dist2DIndependent(qAct, qExp), 0, 1e-6, `evalQuadBezier t=${t}`);

          const cAct = core.evalCubicBezier(p0, cp1, cp2, p1, t);
          const cExp = evalCubicBezierIndependent(p0, cp1, cp2, p1, t);
          assertNear(dist2DIndependent(cAct, cExp), 0, 1e-6, `evalCubicBezier t=${t}`);
        }

        const arcCore = core.edgeArcLength(p0, p1, { cp1, cp2 }, 64);
        const arcOracle = sampleCubicArcLengthIndependent(p0, cp1, cp2, p1, 128);
        assertNear(arcCore, arcOracle, 0.05, 'edgeArcLength vs independent cubic sampler');
      },
    },

    // =========================================================================
    // F09: Seam Allowance Offsetting (T1-F09-1..5)
    // =========================================================================
    {
      id: 'T1-F09-1',
      tier: 1,
      feature: 'F09',
      name: 'Uniform 10mm SA expands 100x80 rect to 120x100 cut boundary (area=12000)',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rect', 100, 80, { seamAllowance: 10 });
        const cut = core.computePieceCutBoundary(rect);
        const b = calcBounds(cut);
        assertNear(b.width, 120, 0.05, 'Cut width');
        assertNear(b.height, 100, 0.05, 'Cut height');
        assertNear(shoelaceArea(cut), 12000, 0.5, 'Cut area');
        assert(countSelfIntersections(cut) === 0, 'Cut boundary must not self-intersect');
      },
    },
    {
      id: 'T1-F09-2',
      tier: 1,
      feature: 'F09',
      name: 'offsetPolygonOutward and computePieceCutBoundary are CW/CCW winding-invariant',
      fn: async () => {
        const core = await loadCore();
        const ccw = [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 80 },
          { x: 0, y: 80 },
        ];
        const cw = [...ccw].reverse();

        const cutCCW = core.computePieceCutBoundary({ points: ccw, seamAllowance: 10 });
        const cutCW = core.computePieceCutBoundary({ points: cw, seamAllowance: 10 });
        assertNear(shoelaceArea(cutCCW), 12000, 0.5, 'CCW cut area');
        assertNear(shoelaceArea(cutCW), 12000, 0.5, 'CW cut area must also offset outward');

        assert(typeof core.offsetPolygonOutward === 'function', 'core.offsetPolygonOutward must be exported');
        const offCW = core.offsetPolygonOutward(cw, 10);
        assertNear(shoelaceArea(offCW), 12000, 0.5, 'offsetPolygonOutward CW outward area');
      },
    },
    {
      id: 'T1-F09-3',
      tier: 1,
      feature: 'F09',
      name: 'Per-edge SA [0,10,20,10] and stepped collinear [0,12] edges step perpendicularly',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createFreeformPiece(
          'PerEdge',
          [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
          {
            edges: [
              { name: 'Top', seamAllowance: 0 },
              { name: 'Right', seamAllowance: 10 },
              { name: 'Bottom', seamAllowance: 20 },
              { name: 'Left', seamAllowance: 10 },
            ],
          }
        );
        const cut = core.computePieceCutBoundary(rect);
        const b = calcBounds(cut);
        assertNear(b.width, 120, 0.05, 'Per-edge SA cut width (100+10+10)');
        assertNear(b.height, 120, 0.05, 'Per-edge SA cut height (100+0+20)');
        assertNear(b.minY, 0, 0.05, 'Top edge SA=0 stays at minY=0');
        assertNear(b.maxY, 120, 0.05, 'Bottom edge SA=20 extends to maxY=120');

        // Collinear split edge with [0, 12] SA must create a perpendicular step (not slanted diagonal)
        const stepped = core.createRectanglePiece('Stepped', 100, 100, { seamAllowance: 10 });
        core.splitPieceEdge(stepped, 0, 0.5);
        stepped.edges[0].seamAllowance = 0;
        stepped.edges[1].seamAllowance = 12;
        const stepCut = core.computePieceCutBoundary(stepped);
        assert(countSelfIntersections(stepCut) === 0, 'Stepped cut boundary must not self-intersect');
        const stepPtsNearMid = stepCut.filter((p) => Math.abs(p.x - 50) < 0.2);
        assert(
          stepPtsNearMid.length >= 2,
          `Expected perpendicular step (>=2 points near x=50), got ${stepPtsNearMid.length}`
        );
      },
    },
    {
      id: 'T1-F09-4',
      tier: 1,
      feature: 'F09',
      name: 'Seam allowance = 0 produces cut boundary identical to net outline',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('ZeroSA', 130, 75, { seamAllowance: 0 });
        const net = samplePieceOutlineIndependent(rect, 16);
        const cut = core.computePieceCutBoundary(rect);
        assertNear(shoelaceArea(cut), shoelaceArea(net), 0.1, 'SA=0 cut area equals net area');
        const bNet = calcBounds(net);
        const bCut = calcBounds(cut);
        assertNear(bCut.width, bNet.width, 0.05, 'SA=0 width');
        assertNear(bCut.height, bNet.height, 0.05, 'SA=0 height');
      },
    },
    {
      id: 'T1-F09-5',
      tier: 1,
      feature: 'F09',
      name: 'piece.rotation = 90 swaps world-space cut boundary width and height (catches v1 ignored rotation)',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rotated', 100, 200, { seamAllowance: 10, rotation: 90 });
        const cutWorld = core.computePieceCutBoundary(rect, 16, { worldSpace: true });
        const b = calcBounds(cutWorld);
        // 100x200 + 10mm all around = 120x220 local -> rotated 90 deg = 220x120 world
        assertNear(b.width, 220, 0.1, 'Rotated 90deg cut width');
        assertNear(b.height, 120, 0.1, 'Rotated 90deg cut height');
      },
    },

    // =========================================================================
    // F10: V-Darts: Create, Fold & True (T1-F10-1..5)
    // =========================================================================
    {
      id: 'T1-F10-1',
      tier: 1,
      feature: 'F10',
      name: 'addDartToPiece attaches a valid dart entry on target edge',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Bodice', 200, 220, { seamAllowance: 10 });
        core.addDartToPiece(rect, { edgeIndex: 0, t: 0.5, widthMm: 25, depthMm: 80 });
        assert(rect.darts.length === 1, 'Expected 1 dart');
        const d = rect.darts[0];
        assert(typeof d.id === 'string' && d.id.length > 0, 'Dart id required');
        assert(d.edgeIndex === 0, 'Dart edgeIndex mismatch');
        assertNear(d.widthMm, 25, 1e-6, 'Dart widthMm');
        assertNear(d.depthMm, 80, 1e-6, 'Dart depthMm');
      },
    },
    {
      id: 'T1-F10-2',
      tier: 1,
      feature: 'F10',
      name: 'computePieceCutBoundary reflects open V-dart cutout (catches v1 ignored darts)',
      fn: async () => {
        const core = await loadCore();
        const plain = core.createRectanglePiece('Plain', 200, 200, { seamAllowance: 10 });
        const darted = core.createRectanglePiece('Darted', 200, 200, { seamAllowance: 10 });
        core.addDartToPiece(darted, { edgeIndex: 0, t: 0.5, widthMm: 30, depthMm: 80 });

        const cutPlain = core.computePieceCutBoundary(plain);
        const cutDarted = core.computePieceCutBoundary(darted);
        const areaPlain = shoelaceArea(cutPlain);
        const areaDarted = shoelaceArea(cutDarted);
        assert(
          areaDarted < areaPlain - 400,
          `Open V-dart cutout must reduce cut area (plain=${areaPlain.toFixed(1)}, darted=${areaDarted.toFixed(1)})`
        );
        assert(
          cutDarted.some((p) => p.y > 50 && p.x > 80 && p.x < 120),
          'Cut boundary must include dart apex penetrating interior'
        );
      },
    },
    {
      id: 'T1-F10-3',
      tier: 1,
      feature: 'F10',
      name: 'toggleDartFold folds dart closed and trues cut boundary cap',
      fn: async () => {
        const core = await loadCore();
        const plain = core.createRectanglePiece('Plain', 200, 200, { seamAllowance: 10 });
        const piece = core.createRectanglePiece('Darted', 200, 200, { seamAllowance: 10 });
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 30, depthMm: 80 });

        const unfoldedArea = shoelaceArea(core.computePieceCutBoundary(piece));
        core.toggleDartFold(piece, 0);
        assert(piece.darts[0].folded === true, 'toggleDartFold should set folded=true');

        const foldedCut = core.computePieceCutBoundary(piece);
        const foldedArea = shoelaceArea(foldedCut);
        const plainArea = shoelaceArea(core.computePieceCutBoundary(plain));
        assert(
          foldedArea > unfoldedArea + 400 && foldedArea >= plainArea - 5,
          `Folded dart cap must close cutout & true cap (unfolded=${unfoldedArea.toFixed(1)}, folded=${foldedArea.toFixed(1)}, plain=${plainArea.toFixed(1)})`
        );

        core.toggleDartFold(piece, piece.darts[0].id);
        assert(piece.darts[0].folded === false, 'Second toggleDartFold by ID should set folded=false');
      },
    },
    {
      id: 'T1-F10-4',
      tier: 1,
      feature: 'F10',
      name: 'Net sewn edge length subtracts dart intake widthMm in seam validation and measurements',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 200, 150, { id: 'pA' });
        core.addDartToPiece(pA, { edgeIndex: 0, t: 0.5, widthMm: 25, depthMm: 70 });
        const pB = core.createRectanglePiece('B', 175, 150, { id: 'pB' });

        const proj = core.createPatternProject({
          pieces: [pA, pB],
          seams: [{ id: 's1', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0 }],
        });
        const [rep] = core.validatePatternSeams(proj);
        assertNear(rep.lengthAMm, 175, 0.05, 'Darted edge net sewn length (200 - 25)');
        assertNear(rep.lengthBMm, 175, 0.05, 'Mating edge length');
        assert(rep.status === 'ok' && rep.valid === true, `Expected 'ok', got ${rep.status}`);
      },
    },
    {
      id: 'T1-F10-5',
      tier: 1,
      feature: 'F10',
      name: 'Darted net and cut outlines remain CCW and non-self-intersecting in both states',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('Darted', 220, 220, { seamAllowance: 10 });
        core.addDartToPiece(piece, { edgeIndex: 0, t: 0.5, widthMm: 25, depthMm: 80 });

        for (const folded of [false, true]) {
          core.toggleDartFold(piece, 0, folded);
          const net = samplePieceOutlineIndependent(piece, 16);
          const cut = core.computePieceCutBoundary(piece, 16);
          assert(shoelaceSignedArea(net) > 0, `folded=${folded}: net must be CCW`);
          assert(shoelaceSignedArea(cut) > 0, `folded=${folded}: cut must be CCW`);
          assert(countSelfIntersections(net) === 0, `folded=${folded}: net self-intersects`);
          assert(countSelfIntersections(cut) === 0, `folded=${folded}: cut self-intersects`);
        }
      },
    },

    // =========================================================================
    // F11: Alignment Notches (T1-F11-1..5)
    // =========================================================================
    {
      id: 'T1-F11-1',
      tier: 1,
      feature: 'F11',
      name: 'Single notch computes 1 line with outward normal and depthMm length',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rect', 100, 100);
        core.addNotchToPiece(rect, { edgeIndex: 0, t: 0.5, type: 'single', depthMm: 6 });
        const [n] = core.computePieceNotches(rect);
        assert(n && n.type === 'single', 'Expected single notch');
        assert(n.lines.length === 1, `Single notch should emit 1 line, got ${n.lines.length}`);
        assertNear(n.position.x, 50, 0.05, 'Single notch X');
        assertNear(n.position.y, 0, 0.05, 'Single notch Y');
        assertNear(Math.hypot(n.normal.x, n.normal.y), 1, 1e-4, 'Outward unit normal');
        assert(n.normal.y < -0.9, `Top edge outward normal should point -Y, got (${n.normal.x}, ${n.normal.y})`);
        const segLen = dist2DIndependent(n.lines[0][0], n.lines[0][1]);
        assertNear(segLen, 6, 0.1, 'Single notch line length == depthMm');
      },
    },
    {
      id: 'T1-F11-2',
      tier: 1,
      feature: 'F11',
      name: 'Double notch computes 2 parallel spaced lines',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rect', 120, 100);
        core.addNotchToPiece(rect, { edgeIndex: 0, t: 0.5, type: 'double', depthMm: 5 });
        const [n] = core.computePieceNotches(rect);
        assert(n.type === 'double', 'Expected double notch');
        assert(n.lines.length === 2, `Double notch should emit 2 lines, got ${n.lines.length}`);
        const mid0 = (n.lines[0][0].x + n.lines[0][1].x) * 0.5;
        const mid1 = (n.lines[1][0].x + n.lines[1][1].x) * 0.5;
        assert(Math.abs(mid0 - mid1) > 1, 'Double notch lines must be spaced apart along edge');
        assertNear((mid0 + mid1) * 0.5, 60, 0.1, 'Double notch centered at t=0.5');
      },
    },
    {
      id: 'T1-F11-3',
      tier: 1,
      feature: 'F11',
      name: 'V notch computes 2 angled converging lines',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rect', 120, 100);
        core.addNotchToPiece(rect, { edgeIndex: 0, t: 0.5, type: 'v', depthMm: 6 });
        const [n] = core.computePieceNotches(rect);
        assert(n.type === 'v', 'Expected v notch');
        assert(n.lines.length === 2, `V notch should emit 2 lines, got ${n.lines.length}`);
        const dTip = Math.min(
          dist2DIndependent(n.lines[0][0], n.lines[1][0]),
          dist2DIndependent(n.lines[0][1], n.lines[1][1]),
          dist2DIndependent(n.lines[0][0], n.lines[1][1]),
          dist2DIndependent(n.lines[0][1], n.lines[1][0])
        );
        assertNear(dTip, 0, 0.1, 'V notch legs must meet at apex');
      },
    },
    {
      id: 'T1-F11-4',
      tier: 1,
      feature: 'F11',
      name: 'T notch computes 2 perpendicular stem + crossbar lines',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Rect', 120, 100);
        core.addNotchToPiece(rect, { edgeIndex: 0, t: 0.5, type: 't', depthMm: 6 });
        const [n] = core.computePieceNotches(rect);
        assert(n.type === 't', 'Expected t notch');
        assert(n.lines.length === 2, `T notch should emit 2 lines, got ${n.lines.length}`);
        const v0 = { x: n.lines[0][1].x - n.lines[0][0].x, y: n.lines[0][1].y - n.lines[0][0].y };
        const v1 = { x: n.lines[1][1].x - n.lines[1][0].x, y: n.lines[1][1].y - n.lines[1][0].y };
        const dot = v0.x * v1.x + v0.y * v1.y;
        assertNear(dot, 0, 1e-3, 'T notch stem and crossbar must be perpendicular');
      },
    },
    {
      id: 'T1-F11-5',
      tier: 1,
      feature: 'F11',
      name: 'Notch t is clamped inside (0,1) and curved edge notch lies on Bezier curve',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 0, y: 0 };
        const p1 = { x: 200, y: 0 };
        const cp1 = { x: 50, y: -80 };
        const cp2 = { x: 150, y: -80 };
        const piece = core.createFreeformPiece('Curved', [p0, p1, { x: 200, y: 120 }, { x: 0, y: 120 }], {
          edges: [
            { name: 'Curve', seamAllowance: 10, curve: { cp1, cp2 } },
            { name: 'R', seamAllowance: 10 },
            { name: 'B', seamAllowance: 10 },
            { name: 'L', seamAllowance: 10 },
          ],
        });
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.5, type: 'single' });
        core.addNotchToPiece(piece, { edgeIndex: 1, t: 5.0, type: 'single' });

        const notches = core.computePieceNotches(piece);
        assert(notches.length === 2, 'Expected 2 notches');
        const curvePos = evalCubicBezierIndependent(p0, cp1, cp2, p1, 0.5);
        assertNear(dist2DIndependent(notches[0].position, curvePos), 0, 0.1, 'Curved notch on Bezier');
        assert(notches[1].t > 0 && notches[1].t < 1, `Out-of-range t should clamp to (0,1), got ${notches[1].t}`);
      },
    },

    // =========================================================================
    // F12: Mirror / Unfold Across Edge (T1-F12-1..5)
    // =========================================================================
    {
      id: 'T1-F12-1',
      tier: 1,
      feature: 'F12',
      name: 'Mirroring 100x80 rect across right edge doubles area to 16000 and width to 200',
      fn: async () => {
        const core = await loadCore();
        const half = core.createRectanglePiece('Half', 100, 80, { seamAllowance: 10 });
        core.mirrorPieceAcrossEdge(half, 1);
        const b = calcBounds(half.points);
        assertNear(b.width, 200, 0.05, 'Mirrored width');
        assertNear(b.height, 80, 0.05, 'Mirrored height');
        assertNear(shoelaceArea(half.points), 16000, 0.5, 'Mirrored area');
      },
    },
    {
      id: 'T1-F12-2',
      tier: 1,
      feature: 'F12',
      name: 'Mirroring reflects cubic Bezier control points symmetrically across mirror axis',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece(
          'NeckHalf',
          [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 120 },
            { x: 0, y: 120 },
          ],
          {
            edges: [
              {
                name: 'Curved Top',
                seamAllowance: 10,
                curve: { cp1: { x: 30, y: -30 }, cp2: { x: 70, y: -15 } },
              },
              { name: 'Center Axis', seamAllowance: 0 },
              { name: 'Bottom', seamAllowance: 10 },
              { name: 'Side', seamAllowance: 10 },
            ],
          }
        );
        const halfArea = shoelaceArea(samplePieceOutlineIndependent(piece, 32));
        core.mirrorPieceAcrossEdge(piece, 1);
        const outline = samplePieceOutlineIndependent(piece, 32);
        const fullArea = shoelaceArea(outline);
        assertNear(fullArea, halfArea * 2, 2.0, 'Mirrored curved outline area doubles');
        const curvedEdges = piece.edges.filter((e) => e.curve && e.curve.cp1 && e.curve.cp2);
        assert(curvedEdges.length === 2, `Expected 2 symmetric curved edges after mirror, got ${curvedEdges.length}`);
      },
    },
    {
      id: 'T1-F12-3',
      tier: 1,
      feature: 'F12',
      name: 'Mirroring reflects notches and darts onto mirrored edges symmetrically',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('BodiceHalf', 100, 150);
        core.addNotchToPiece(piece, { edgeIndex: 0, t: 0.3, type: 'single' });
        core.addDartToPiece(piece, { edgeIndex: 2, t: 0.5, widthMm: 20, depthMm: 50 });

        core.mirrorPieceAcrossEdge(piece, 1);
        assert(piece.notches.length === 2, `Expected 2 notches after mirror, got ${piece.notches.length}`);
        assert(piece.darts.length === 2, `Expected 2 darts after mirror, got ${piece.darts.length}`);

        const notches = core.computePieceNotches(piece);
        const xs = notches.map((n) => n.position.x).sort((a, b) => a - b);
        assertNear(xs[0] + xs[1], 200, 0.1, 'Mirrored notches symmetric about x=100');
      },
    },
    {
      id: 'T1-F12-4',
      tier: 1,
      feature: 'F12',
      name: 'Mirroring adds a center fold internalLine along the mirror axis',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createRectanglePiece('Half', 90, 140);
        core.mirrorPieceAcrossEdge(piece, 1);
        const folds = (piece.internalLines || []).filter((il) => il.type === 'fold');
        assert(folds.length >= 1, 'Expected fold internalLine after mirror');
        const fold = folds[folds.length - 1];
        assert(fold.points.length >= 2, 'Fold line needs >= 2 points');
        const len = dist2DIndependent(fold.points[0], fold.points[1]);
        assertNear(len, 140, 0.1, 'Fold internalLine spans full mirror edge height');
        assertNear(fold.points[0].x, 90, 0.1, 'Fold line centered at mirror axis x=90');
      },
    },
    {
      id: 'T1-F12-5',
      tier: 1,
      feature: 'F12',
      name: 'Mirrored piece preserves strict CCW winding and zero self-intersections',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece('L-Half', [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
          { x: 80, y: 120 },
          { x: 20, y: 120 },
          { x: 20, y: 60 },
          { x: 0, y: 60 },
        ]);
        core.mirrorPieceAcrossEdge(piece, 1);
        assert(shoelaceSignedArea(piece.points) > 0, 'Mirrored concave polygon must remain CCW');
        assert(countSelfIntersections(piece.points) === 0, 'Mirrored concave polygon must not self-intersect');
        const cut = core.computePieceCutBoundary(piece);
        assert(shoelaceSignedArea(cut) > 0 && countSelfIntersections(cut) === 0, 'Mirrored cut boundary valid');
      },
    },

    // =========================================================================
    // F13: Seam-Length Matching & Walking (T1-F13-1..5)
    // =========================================================================
    {
      id: 'T1-F13-1',
      tier: 1,
      feature: 'F13',
      name: 'validatePatternSeams returns status="ok" for matching curved and straight edges',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 180, 100, { id: 'pA' });
        const pB = core.createRectanglePiece('B', 180, 100, { id: 'pB' });
        const proj = core.createPatternProject({
          pieces: [pA, pB],
          seams: [{ id: 's1', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 2 }],
        });
        const [rep] = core.validatePatternSeams(proj);
        assert(rep.status === 'ok' && rep.valid === true, `Expected ok, got ${rep.status}`);
        assertNear(rep.deltaMm, 0, 0.05, 'Exact match deltaMm');

        const cA = core.createRectanglePiece('CurvedA', 180, 100, { id: 'cA' });
        const cB = core.createRectanglePiece('CurvedB', 180, 100, { id: 'cB' });
        cA.edges[0].curve = { cp1: { x: 60, y: -30 }, cp2: { x: 120, y: 30 } };
        cB.edges[0].curve = { cp1: { x: 60, y: 30 }, cp2: { x: 120, y: -30 } };
        const curvedProj = core.createPatternProject({
          pieces: [cA, cB],
          seams: [{ id: 's_curved', pieceA: cA.id, edgeA: 0, pieceB: cB.id, edgeB: 0 }],
        });
        const [repCurved] = core.validatePatternSeams(curvedProj);
        assert(repCurved.status === 'ok' && repCurved.valid === true, `Expected ok for curved seam, got ${repCurved.status}`);
        assertNear(repCurved.deltaMm, 0, 0.05, 'Curved seam deltaMm');
      },
    },
    {
      id: 'T1-F13-2',
      tier: 1,
      feature: 'F13',
      name: 'validatePatternSeams returns status="ease" when difference is within maxEasePct with allowEase',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 200, 100, { id: 'pA' });
        const pB = core.createRectanglePiece('B', 216, 100, { id: 'pB' });
        const proj = core.createPatternProject({
          pieces: [pA, pB],
          seams: [{ id: 's_ease', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0, allowEase: true }],
        });
        const [rep] = core.validatePatternSeams(proj, 5.0, 18.0);
        assert(rep.status === 'ease' && rep.valid === true, `Expected 'ease', got ${rep.status}`);
        assertNear(rep.deltaMm, 16, 0.05, 'Ease deltaMm');
      },
    },
    {
      id: 'T1-F13-3',
      tier: 1,
      feature: 'F13',
      name: 'validatePatternSeams flags status="mismatch" when delta exceeds tolerance without ease',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 150, 100, { id: 'pA' });
        const pB = core.createRectanglePiece('B', 210, 100, { id: 'pB' });
        const proj = core.createPatternProject({
          pieces: [pA, pB],
          seams: [{ id: 's_bad', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0, allowEase: false }],
        });
        const [rep] = core.validatePatternSeams(proj, 5.0, 18.0);
        assert(rep.status === 'mismatch' && rep.valid === false, `Expected 'mismatch', got ${rep.status}`);
        assertNear(rep.deltaMm, 60, 0.05, 'Mismatch deltaMm');
      },
    },
    {
      id: 'T1-F13-4',
      tier: 1,
      feature: 'F13',
      name: 'validatePatternSeams flags status="duplicate_edge" when two seams overlap on same edge',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 150, 100, { id: 'pA' });
        const pB = core.createRectanglePiece('B', 150, 100, { id: 'pB' });
        const pC = core.createRectanglePiece('C', 150, 100, { id: 'pC' });
        const proj = core.createPatternProject({
          pieces: [pA, pB, pC],
          seams: [
            { id: 's1', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 0 },
            { id: 's2', pieceA: 'pA', edgeA: 0, pieceB: 'pC', edgeB: 0 },
          ],
        });
        const reps = core.validatePatternSeams(proj);
        assert(
          reps.every((r) => r.status === 'duplicate_edge' && r.valid === false),
          `Expected duplicate_edge on both overlapping seams, got ${reps.map((r) => r.status)}`
        );
      },
    },
    {
      id: 'T1-F13-5',
      tier: 1,
      feature: 'F13',
      name: 'computeSeamWalkTransform aligns piece B seam edge onto piece A in world space',
      fn: async () => {
        const core = await loadCore();
        const pA = core.createRectanglePiece('A', 160, 100, { id: 'pA', position: { x: 50, y: 40 } });
        const pB = core.createRectanglePiece('B', 160, 100, { id: 'pB', position: { x: 300, y: 200 } });
        const proj = core.createPatternProject({
          pieces: [pA, pB],
          seams: [{ id: 's_walk', pieceA: 'pA', edgeA: 0, pieceB: 'pB', edgeB: 2, reversed: true }],
        });

        const walk = core.computeSeamWalkTransform(proj, 's_walk', 0);
        assert(walk && typeof walk === 'object', 'computeSeamWalkTransform must return an object');

        let ptB0;
        let ptBEnd;
        if (typeof walk.applyTransform === 'function') {
          ptB0 = walk.applyTransform(pB.points[3]);
          ptBEnd = walk.applyTransform(pB.points[2]);
        } else if (Array.isArray(walk.transformedPointsB)) {
          ptB0 = walk.transformedPointsB[3];
          ptBEnd = walk.transformedPointsB[2];
        } else if (Array.isArray(walk.matrix) && walk.matrix.length >= 6) {
          const [a, b, c, d, tx, ty] = walk.matrix;
          const applyM = (pt) => ({ x: a * pt.x + c * pt.y + tx, y: b * pt.x + d * pt.y + ty });
          ptB0 = applyM(pB.points[3]);
          ptBEnd = applyM(pB.points[2]);
        } else {
          throw new Error('computeSeamWalkTransform returned unsupported transform shape');
        }

        const worldA0 = { x: pA.position.x + pA.points[0].x, y: pA.position.y + pA.points[0].y };
        const worldA1 = { x: pA.position.x + pA.points[1].x, y: pA.position.y + pA.points[1].y };
        assertNear(dist2DIndependent(ptB0, worldA0), 0, 0.1, 'Walked seam start alignment');
        assertNear(dist2DIndependent(ptBEnd, worldA1), 0, 0.1, 'Walked seam end alignment');
      },
    },

    // =========================================================================
    // F14: Live Millimeter Dimensions & Units (T1-F14-1..5)
    // =========================================================================
    {
      id: 'T1-F14-1',
      tier: 1,
      feature: 'F14',
      name: 'mmToUnit and unitToMm convert mm/cm/in using exact 1 / 10 / 25.4 factors',
      fn: async () => {
        const core = await loadCore();
        assertNear(core.UNIT_FACTORS.mm, 1, 1e-12, 'mm factor');
        assertNear(core.UNIT_FACTORS.cm, 10, 1e-12, 'cm factor');
        assertNear(core.UNIT_FACTORS.in, 25.4, 1e-12, 'in factor');

        assertNear(core.mmToUnit(254, 'mm'), 254, 1e-9, '254mm -> mm');
        assertNear(core.mmToUnit(254, 'cm'), 25.4, 1e-9, '254mm -> cm');
        assertNear(core.mmToUnit(254, 'in'), 10, 1e-9, '254mm -> in');

        assertNear(core.unitToMm(10, 'in'), 254, 1e-9, '10in -> mm');
        assertNear(core.unitToMm(25.4, 'cm'), 254, 1e-9, '25.4cm -> mm');
      },
    },
    {
      id: 'T1-F14-2',
      tier: 1,
      feature: 'F14',
      name: 'computePieceMeasurements reports edge lengths matching independent curve oracle <= 0.05 mm',
      fn: async () => {
        const core = await loadCore();
        const p0 = { x: 0, y: 0 };
        const p1 = { x: 180, y: 0 };
        const cp1 = { x: 40, y: -50 };
        const cp2 = { x: 140, y: -50 };
        const piece = core.createFreeformPiece('Curved', [p0, p1, { x: 180, y: 100 }, { x: 0, y: 100 }], {
          seamAllowance: 10,
          edges: [
            { name: 'Curved', seamAllowance: 10, curve: { cp1, cp2 } },
            { name: 'Right', seamAllowance: 10 },
            { name: 'Bottom', seamAllowance: 10 },
            { name: 'Left', seamAllowance: 10 },
          ],
        });

        const meas = core.computePieceMeasurements(piece, 'mm');
        const expectedCurveLen = sampleCubicArcLengthIndependent(p0, cp1, cp2, p1, 128);
        assertNear(meas.edges[0].lengthMm, expectedCurveLen, 0.05, 'Curved edge lengthMm');
        assertNear(meas.edges[1].lengthMm, 100, 0.05, 'Right edge lengthMm');
        assertNear(meas.edges[2].lengthMm, 180, 0.05, 'Bottom edge lengthMm');
        assertNear(meas.edges[3].lengthMm, 100, 0.05, 'Left edge lengthMm');
      },
    },
    {
      id: 'T1-F14-3',
      tier: 1,
      feature: 'F14',
      name: 'computePieceMeasurements reports net and cut bounding box WxH within <= 0.1 mm',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('Box', 150, 90, { seamAllowance: 12 });
        const meas = core.computePieceMeasurements(rect, 'mm');
        const netB = calcBounds(samplePieceOutlineIndependent(rect, 16));
        const cutB = calcBounds(core.computePieceCutBoundary(rect, 16));

        assertNear(meas.netWidthMm, netB.width, 0.1, 'netWidthMm');
        assertNear(meas.netHeightMm, netB.height, 0.1, 'netHeightMm');
        assertNear(meas.cutWidthMm, cutB.width, 0.1, 'cutWidthMm');
        assertNear(meas.cutHeightMm, cutB.height, 0.1, 'cutHeightMm');
        assertNear(meas.cutWidthMm, 174, 0.1, '150 + 2*12 cut width');
        assertNear(meas.cutHeightMm, 114, 0.1, '90 + 2*12 cut height');
      },
    },
    {
      id: 'T1-F14-4',
      tier: 1,
      feature: 'F14',
      name: 'computePieceMeasurements reports accurate area and perimeter vs Shoelace oracle',
      fn: async () => {
        const core = await loadCore();
        const piece = core.createFreeformPiece(
          'Trapezoid',
          [
            { x: 0, y: 0 },
            { x: 160, y: 0 },
            { x: 130, y: 100 },
            { x: 30, y: 100 },
          ],
          { seamAllowance: 10 }
        );
        const netPts = samplePieceOutlineIndependent(piece, 16);
        const cutPts = core.computePieceCutBoundary(piece, 16);
        const meas = core.computePieceMeasurements(piece, 'mm');

        assertNear(meas.netAreaMm2, shoelaceArea(netPts), 0.5, 'netAreaMm2');
        assertNear(meas.cutAreaMm2, shoelaceArea(cutPts), 1.0, 'cutAreaMm2');
        assertNear(meas.netPerimeterMm, polylinePerimeter(netPts, true), 0.1, 'netPerimeterMm');
        assertNear(meas.cutPerimeterMm, polylinePerimeter(cutPts, true), 0.1, 'cutPerimeterMm');
      },
    },
    {
      id: 'T1-F14-5',
      tier: 1,
      feature: 'F14',
      name: 'Switching measurement display units (mm -> cm -> in -> mm) causes zero internal mm drift',
      fn: async () => {
        const core = await loadCore();
        const rect = core.createRectanglePiece('DriftCheck', 254, 127, { seamAllowance: 12.7 });
        const origPts = rect.points.map((p) => ({ ...p }));

        const mMm = core.computePieceMeasurements(rect, 'mm');
        const mCm = core.computePieceMeasurements(rect, 'cm');
        const mIn = core.computePieceMeasurements(rect, 'in');

        assertNear(mCm.width, 25.4, 1e-6, '254mm in cm');
        assertNear(mIn.width, 10.0, 1e-6, '254mm in in');
        assertNear(mIn.height, 5.0, 1e-6, '127mm in in');
        assertNear(mCm.netAreaMm2, mMm.netAreaMm2, 1e-6, 'netAreaMm2 invariant across units');
        assertNear(mIn.netAreaMm2, mMm.netAreaMm2, 1e-6, 'netAreaMm2 invariant in inches mode');

        for (let i = 0; i < origPts.length; i++) {
          assertNear(dist2DIndependent(rect.points[i], origPts[i]), 0, 1e-9, `Point ${i} untouched`);
        }

        const projIn = core.normalizePatternProject({ ...core.createPatternProject({ pieces: [rect] }), unit: 'mm' });
        const projBack = core.normalizePatternProject({
          ...projIn,
          unit: 'in',
          pieces: projIn.pieces.map((p) => ({
            ...p,
            position: { x: core.mmToUnit(p.position.x, 'in'), y: core.mmToUnit(p.position.y, 'in') },
            seamAllowance: core.mmToUnit(p.seamAllowance, 'in'),
            points: p.points.map((pt) => ({ x: core.mmToUnit(pt.x, 'in'), y: core.mmToUnit(pt.y, 'in') })),
            edges: p.edges.map((e) => ({ ...e, seamAllowance: core.mmToUnit(e.seamAllowance, 'in') })),
            grainline: { angleDeg: p.grainline.angleDeg },
            placement3D: {
              offset: {
                x: core.mmToUnit(p.placement3D.offset.x, 'in'),
                y: core.mmToUnit(p.placement3D.offset.y, 'in'),
                z: core.mmToUnit(p.placement3D.offset.z, 'in'),
              },
              normal: p.placement3D.normal,
              up: p.placement3D.up,
            },
          })),
        });
        assertNear(shoelaceArea(projBack.pieces[0].points), 254 * 127, 1e-5, 'mm->in->mm area roundtrip');
      },
    },
  ];
}
