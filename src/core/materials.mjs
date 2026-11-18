/**
 * Substance 3D-inspired Procedural PBR Material Studio & Physical Textile Presets.
 * Isomorphic pure ES module (Node.js v24 + WebGL2 browsers, zero DOM dependencies).
 */

export const WEAVE_TYPES = Object.freeze([
  'plain_weave',
  'twill_3x1',
  'knit_jersey',
  'ripstop_grid',
  'leather_grain',
  'eva_microcell',
]);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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

function normalizeHexColor(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const s = val.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}

function hexToRgb(hex) {
  const clean = normalizeHexColor(hex, '#808080').slice(1);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function escapeXmlAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makePreset(spec) {
  return Object.freeze({
    ...spec,
    albedo: spec.baseColor,
    grainColor: spec.weftColor,
    weaveScale: spec.threadScaleMm,
    stretchWarp: spec.warpStiffness,
    stretchWeft: spec.weftStiffness,
  });
}

export const MATERIAL_PRESETS = Object.freeze({
  cotton_jersey: makePreset({
    id: 'cotton_jersey',
    name: 'Cotton Knit Jersey',
    category: 'Knit',
    weaveType: 'knit_jersey',
    gsm: 180,
    thicknessMm: 0.65,
    stretchStiffness: 0.65,
    warpStiffness: 0.68,
    weftStiffness: 0.56,
    shearStiffness: 0.44,
    bendStiffness: 0.22,
    damping: 0.96,
    friction: 0.45,
    maxSafeStrainPct: 18.0,
    baseColor: '#4e79a7',
    warpColor: '#4e79a7',
    weftColor: '#6996c2',
    stitchColor: '#d9e6f2',
    normal: 0.55,
    roughness: 0.78,
    metallic: 0.0,
    ao: 0.45,
    sheen: 0.16,
    threadScaleMm: 1.2,
  }),
  heavy_fleece: makePreset({
    id: 'heavy_fleece',
    name: 'Heavy Brushed Fleece',
    category: 'Knit',
    weaveType: 'knit_jersey',
    gsm: 380,
    thicknessMm: 2.1,
    stretchStiffness: 0.78,
    warpStiffness: 0.80,
    weftStiffness: 0.70,
    shearStiffness: 0.62,
    bendStiffness: 0.46,
    damping: 0.95,
    friction: 0.58,
    maxSafeStrainPct: 14.0,
    baseColor: '#5b6472',
    warpColor: '#5b6472',
    weftColor: '#768190',
    stitchColor: '#cbd3de',
    normal: 0.65,
    roughness: 0.88,
    metallic: 0.0,
    ao: 0.55,
    sheen: 0.10,
    threadScaleMm: 1.6,
  }),
  heavy_denim: makePreset({
    id: 'heavy_denim',
    name: '12oz Indigo Denim (3x1 Twill)',
    category: 'Woven',
    weaveType: 'twill_3x1',
    gsm: 400,
    thicknessMm: 1.15,
    stretchStiffness: 0.95,
    warpStiffness: 0.96,
    weftStiffness: 0.91,
    shearStiffness: 0.84,
    bendStiffness: 0.68,
    damping: 0.94,
    friction: 0.52,
    maxSafeStrainPct: 5.0,
    baseColor: '#274060',
    warpColor: '#274060',
    weftColor: '#d9d3c7',
    stitchColor: '#e08e36',
    normal: 0.72,
    roughness: 0.82,
    metallic: 0.0,
    ao: 0.50,
    sheen: 0.12,
    threadScaleMm: 1.4,
  }),
  duck_canvas: makePreset({
    id: 'duck_canvas',
    name: '10oz Duck Canvas',
    category: 'Woven',
    weaveType: 'plain_weave',
    gsm: 340,
    thicknessMm: 1.0,
    stretchStiffness: 0.96,
    warpStiffness: 0.97,
    weftStiffness: 0.95,
    shearStiffness: 0.88,
    bendStiffness: 0.74,
    damping: 0.93,
    friction: 0.56,
    maxSafeStrainPct: 4.0,
    baseColor: '#c2a67d',
    warpColor: '#c2a67d',
    weftColor: '#d4bd98',
    stitchColor: '#5e4b35',
    normal: 0.65,
    roughness: 0.74,
    metallic: 0.0,
    ao: 0.48,
    sheen: 0.20,
    threadScaleMm: 1.3,
  }),
  ripstop_nylon: makePreset({
    id: 'ripstop_nylon',
    name: 'Ripstop Technical Nylon',
    category: 'Technical',
    weaveType: 'ripstop_grid',
    gsm: 75,
    thicknessMm: 0.22,
    stretchStiffness: 0.97,
    warpStiffness: 0.98,
    weftStiffness: 0.97,
    shearStiffness: 0.82,
    bendStiffness: 0.18,
    damping: 0.97,
    friction: 0.26,
    maxSafeStrainPct: 3.0,
    baseColor: '#2f8f83',
    warpColor: '#2f8f83',
    weftColor: '#48ab9e',
    stitchColor: '#d8f3ee',
    normal: 0.48,
    roughness: 0.32,
    metallic: 0.05,
    ao: 0.35,
    sheen: 0.68,
    threadScaleMm: 2.0,
  }),
  veg_leather: makePreset({
    id: 'veg_leather',
    name: 'Vegetable-Tanned Leather',
    category: 'Leather / Hide',
    weaveType: 'leather_grain',
    gsm: 950,
    thicknessMm: 1.4,
    stretchStiffness: 0.98,
    warpStiffness: 0.98,
    weftStiffness: 0.98,
    shearStiffness: 0.94,
    bendStiffness: 0.86,
    damping: 0.92,
    friction: 0.62,
    maxSafeStrainPct: 3.5,
    baseColor: '#8d5330',
    warpColor: '#8d5330',
    weftColor: '#6f3e21',
    stitchColor: '#efe1c6',
    normal: 0.85,
    roughness: 0.45,
    metallic: 0.02,
    ao: 0.60,
    sheen: 0.55,
    threadScaleMm: 1.5,
  }),
  eva_foam_4mm: makePreset({
    id: 'eva_foam_4mm',
    name: '4mm High-Density EVA Foam',
    category: 'Foam / Structural',
    weaveType: 'eva_microcell',
    gsm: 420,
    thicknessMm: 4.0,
    stretchStiffness: 0.99,
    warpStiffness: 0.99,
    weftStiffness: 0.99,
    shearStiffness: 0.96,
    bendStiffness: 0.94,
    damping: 0.91,
    friction: 0.68,
    maxSafeStrainPct: 3.0,
    baseColor: '#2e3440',
    warpColor: '#2e3440',
    weftColor: '#434c5e',
    stitchColor: '#88c0d0',
    normal: 0.52,
    roughness: 0.62,
    metallic: 0.0,
    ao: 0.42,
    sheen: 0.28,
    threadScaleMm: 1.0,
  }),
  cotton_poplin: makePreset({
    id: 'cotton_poplin',
    name: 'Crisp Cotton Poplin',
    category: 'Woven',
    weaveType: 'plain_weave',
    gsm: 130,
    thicknessMm: 0.35,
    stretchStiffness: 0.95,
    warpStiffness: 0.96,
    weftStiffness: 0.94,
    shearStiffness: 0.78,
    bendStiffness: 0.34,
    damping: 0.96,
    friction: 0.38,
    maxSafeStrainPct: 3.5,
    baseColor: '#d9dfe6',
    warpColor: '#d9dfe6',
    weftColor: '#edf1f5',
    stitchColor: '#6b7785',
    normal: 0.42,
    roughness: 0.66,
    metallic: 0.0,
    ao: 0.36,
    sheen: 0.22,
    threadScaleMm: 0.9,
  }),
  calico_muslin: makePreset({
    id: 'calico_muslin',
    name: 'Couturier Calico Muslin (Fitting Toile)',
    category: 'Woven',
    weaveType: 'plain_weave',
    gsm: 155,
    thicknessMm: 0.42,
    stretchStiffness: 0.94,
    warpStiffness: 0.95,
    weftStiffness: 0.92,
    shearStiffness: 0.74,
    bendStiffness: 0.32,
    damping: 0.96,
    friction: 0.42,
    maxSafeStrainPct: 16.0,
    baseColor: '#e4dac6',
    warpColor: '#e4dac6',
    weftColor: '#ede5d5',
    stitchColor: '#b85d43',
    normal: 0.48,
    roughness: 0.80,
    metallic: 0.0,
    ao: 0.38,
    sheen: 0.14,
    threadScaleMm: 0.9,
  }),
  cotton_sateen: makePreset({
    id: 'cotton_sateen',
    name: 'Stretch Cotton Sateen (Terracotta Rose)',
    category: 'Woven',
    weaveType: 'twill_3x1',
    gsm: 210,
    thicknessMm: 0.52,
    stretchStiffness: 0.86,
    warpStiffness: 0.90,
    weftStiffness: 0.78,
    shearStiffness: 0.68,
    bendStiffness: 0.36,
    damping: 0.96,
    friction: 0.36,
    maxSafeStrainPct: 18.0,
    baseColor: '#b5655b',
    warpColor: '#b5655b',
    weftColor: '#c97c72',
    stitchColor: '#f2dcd8',
    normal: 0.42,
    roughness: 0.62,
    metallic: 0.0,
    ao: 0.36,
    sheen: 0.44,
    threadScaleMm: 0.85,
  }),
  silk_charmeuse: makePreset({
    id: 'silk_charmeuse',
    name: 'Mulberry Silk Charmeuse (Dusty Mauve)',
    category: 'Silk / Dressmaking',
    weaveType: 'twill_3x1',
    gsm: 95,
    thicknessMm: 0.24,
    stretchStiffness: 0.88,
    warpStiffness: 0.91,
    weftStiffness: 0.84,
    shearStiffness: 0.46,
    bendStiffness: 0.12,
    damping: 0.97,
    friction: 0.22,
    maxSafeStrainPct: 18.0,
    baseColor: '#9e6b78',
    warpColor: '#9e6b78',
    weftColor: '#ba8996',
    stitchColor: '#ebd8dd',
    normal: 0.28,
    roughness: 0.52,
    metallic: 0.0,
    ao: 0.28,
    sheen: 0.72,
    threadScaleMm: 0.65,
  }),
  linen_flax: makePreset({
    id: 'linen_flax',
    name: 'Washed Belgian Flax Linen (Sage)',
    category: 'Woven',
    weaveType: 'plain_weave',
    gsm: 195,
    thicknessMm: 0.58,
    stretchStiffness: 0.94,
    warpStiffness: 0.95,
    weftStiffness: 0.93,
    shearStiffness: 0.72,
    bendStiffness: 0.38,
    damping: 0.95,
    friction: 0.44,
    maxSafeStrainPct: 16.0,
    baseColor: '#768c7d',
    warpColor: '#768c7d',
    weftColor: '#8fa696',
    stitchColor: '#e3ebe5',
    normal: 0.62,
    roughness: 0.76,
    metallic: 0.0,
    ao: 0.44,
    sheen: 0.22,
    threadScaleMm: 1.15,
  }),
  wool_crepe: makePreset({
    id: 'wool_crepe',
    name: 'Tailored Suiting Wool Crepe (Warm Espresso)',
    category: 'Woven / Suiting',
    weaveType: 'plain_weave',
    gsm: 265,
    thicknessMm: 0.78,
    stretchStiffness: 0.90,
    warpStiffness: 0.92,
    weftStiffness: 0.87,
    shearStiffness: 0.66,
    bendStiffness: 0.42,
    damping: 0.96,
    friction: 0.46,
    maxSafeStrainPct: 17.0,
    baseColor: '#4c433e',
    warpColor: '#4c433e',
    weftColor: '#615650',
    stitchColor: '#cbbeb5',
    normal: 0.54,
    roughness: 0.72,
    metallic: 0.0,
    ao: 0.46,
    sheen: 0.26,
    threadScaleMm: 0.95,
  }),
});

export function getMaterialConfig(materialId = 'cotton_jersey', overrides = {}) {
  const key = typeof materialId === 'string' && Object.hasOwn(MATERIAL_PRESETS, materialId)
    ? materialId
    : 'cotton_jersey';
  const base = MATERIAL_PRESETS[key];
  const ov = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};

  const gsm = clamp(finiteOr(ov.gsm, base.gsm), 10, 5000);

  let thicknessMm = base.thicknessMm;
  const tNum = finiteOr(ov.thicknessMm, NaN);
  if (Number.isFinite(tNum)) {
    thicknessMm = clamp(tNum, 0, 50);
  }

  const stretchOverrideNum = finiteOr(ov.stretchStiffness, NaN);
  const hasStretchOverride = Number.isFinite(stretchOverrideNum);
  const rawStretch = hasStretchOverride ? clamp(stretchOverrideNum, 0, 1) : base.stretchStiffness;

  const warpOverrideNum = finiteOr(ov.warpStiffness, finiteOr(ov.stretchWarp, NaN));
  const hasWarpOverride = Number.isFinite(warpOverrideNum);
  const warpStiffness = hasWarpOverride
    ? clamp(warpOverrideNum, 0, 1)
    : (hasStretchOverride ? rawStretch : base.warpStiffness);

  const weftOverrideNum = finiteOr(ov.weftStiffness, finiteOr(ov.stretchWeft, NaN));
  const hasWeftOverride = Number.isFinite(weftOverrideNum);
  const weftStiffness = hasWeftOverride
    ? clamp(weftOverrideNum, 0, 1)
    : (hasStretchOverride ? rawStretch : base.weftStiffness);

  const stretchStiffness = hasStretchOverride
    ? rawStretch
    : clamp((warpStiffness + weftStiffness) * 0.5, 0, 1);

  const shearStiffness = clamp(finiteOr(ov.shearStiffness, base.shearStiffness), 0, 1);
  const bendStiffness = clamp(finiteOr(ov.bendStiffness, base.bendStiffness), 0, 1);
  const damping = clamp(finiteOr(ov.damping, base.damping), 0, 1);
  const friction = clamp(finiteOr(ov.friction, base.friction), 0, 1);
  const maxSafeStrainPct = clamp(finiteOr(ov.maxSafeStrainPct, base.maxSafeStrainPct), 0.1, 300);

  const roughness = clamp(finiteOr(ov.roughness, base.roughness), 0, 1);
  const metallic = clamp(finiteOr(ov.metallic, base.metallic), 0, 1);
  const ao = clamp(finiteOr(ov.ao, base.ao), 0, 1);
  const sheen = clamp(finiteOr(ov.sheen, base.sheen), 0, 1);
  const normal = clamp(finiteOr(ov.normal, base.normal), 0, 2);

  const threadScaleMm = clamp(finiteOr(ov.threadScaleMm ?? ov.weaveScale, base.threadScaleMm), 0.1, 20);
  const weaveType = typeof ov.weaveType === 'string' && WEAVE_TYPES.includes(ov.weaveType)
    ? ov.weaveType
    : base.weaveType;

  const warpColor = normalizeHexColor(ov.warpColor ?? ov.baseColor ?? ov.albedo, base.warpColor);
  const weftColor = normalizeHexColor(ov.weftColor ?? ov.grainColor, base.weftColor);
  const baseColor = normalizeHexColor(ov.baseColor ?? ov.albedo, warpColor);
  const stitchColor = normalizeHexColor(ov.stitchColor, base.stitchColor);

  return {
    id: typeof ov.id === 'string' && ov.id.length > 0 ? ov.id : base.id,
    name: typeof ov.name === 'string' && ov.name.length > 0 ? ov.name : base.name,
    category: typeof ov.category === 'string' && ov.category.length > 0 ? ov.category : base.category,
    weaveType,
    gsm,
    thicknessMm,
    stretchStiffness,
    warpStiffness,
    weftStiffness,
    stretchWarp: warpStiffness,
    stretchWeft: weftStiffness,
    shearStiffness,
    bendStiffness,
    damping,
    friction,
    maxSafeStrainPct,
    albedo: baseColor,
    baseColor,
    grainColor: weftColor,
    warpColor,
    weftColor,
    stitchColor,
    normal,
    roughness,
    metallic,
    ao,
    sheen,
    weaveScale: threadScaleMm,
    threadScaleMm,
  };
}

export const getMaterialPreset = getMaterialConfig;

function hash2D(ix, iy, seed = 1337) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function periodicWorley(u, v, cells, seed) {
  const px = u * cells;
  const py = v * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let d1 = 1e9;
  let d2 = 1e9;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const cx = ((ix + ox) % cells + cells) % cells;
      const cy = ((iy + oy) % cells + cells) % cells;
      const jx = ix + ox + 0.15 + 0.7 * hash2D(cx, cy, seed);
      const jy = iy + oy + 0.15 + 0.7 * hash2D(cx, cy, seed + 97);
      const dx = px - jx;
      const dy = py - jy;
      const d = Math.hypot(dx, dy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return { d1, d2 };
}

function periodicNoise(u, v, freq, seed) {
  const px = u * freq;
  const py = v * freq;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % freq) + freq) % freq;
  const y0 = ((iy % freq) + freq) % freq;
  const x1 = (x0 + 1) % freq;
  const y1 = (y0 + 1) % freq;
  const n00 = hash2D(x0, y0, seed);
  const n10 = hash2D(x1, y0, seed);
  const n01 = hash2D(x0, y1, seed);
  const n11 = hash2D(x1, y1, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/**
 * Generates seamless tileable RGBA PBR texture maps in pure JS (no DOM canvas).
 * @param {object} materialConfig
 * @param {number} sizePx
 * @returns {{size: number, width: number, heightPx: number, albedo: object, normal: object, roughness: object, ao: object, height: object, heightMap: Uint8Array, channels: object}}
 */
export function generateProceduralPBRMaps(materialConfig = {}, sizePx = 128) {
  const cfg = getMaterialConfig(materialConfig?.id || 'cotton_jersey', materialConfig || {});
  const rawSize = finiteOr(sizePx, 128);
  const size = clamp(Math.trunc(rawSize), 16, 512);
  const count = size * size;

  const heightField = new Float32Array(count);
  const warpMaskField = new Float32Array(count);

  const warpRgb = hexToRgb(cfg.warpColor);
  const weftRgb = hexToRgb(cfg.weftColor);
  const stitchRgb = hexToRgb(cfg.stitchColor);

  const scaleFactor = clamp(1.4 / Math.max(0.4, cfg.threadScaleMm), 0.5, 2.5);
  const rawPeriods = Math.max(4, Math.round((size >= 32 ? 8 : 4) * scaleFactor));
  const periodStep =
    cfg.weaveType === 'twill_3x1' ? 4 : cfg.weaveType === 'plain_weave' || cfg.weaveType === 'ripstop_grid' ? 2 : 1;
  const periods = Math.max(4, Math.round(rawPeriods / periodStep) * periodStep);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      let h = 0.5;
      let warpMix = 0.5;

      if (cfg.weaveType === 'plain_weave') {
        const gu = u * periods;
        const gv = v * periods;
        const cellX = Math.floor(gu);
        const cellY = Math.floor(gv);
        const fx = gu - cellX;
        const fy = gv - cellY;
        const warpArch = Math.sin(fx * Math.PI);
        const weftArch = Math.sin(fy * Math.PI);
        const isWarpTop = ((cellX + cellY) & 1) === 0;
        const topVal = isWarpTop ? warpArch : weftArch;
        const underVal = isWarpTop ? weftArch : warpArch;
        h = 0.25 + 0.65 * Math.max(topVal, underVal * 0.45);
        warpMix = isWarpTop ? 0.85 : 0.15;
      } else if (cfg.weaveType === 'twill_3x1') {
        const gu = u * periods;
        const gv = v * periods;
        const cellX = Math.floor(gu);
        const cellY = Math.floor(gv);
        const fx = gu - cellX;
        const fy = gv - cellY;
        const phase = ((cellX + cellY) % 4 + 4) % 4;
        const isWarpTop = phase < 3;
        const warpWave = 0.5 + 0.5 * Math.sin(fx * Math.PI);
        const weftWave = 0.5 + 0.5 * Math.sin(fy * Math.PI);
        h = isWarpTop ? 0.35 + 0.55 * warpWave : 0.22 + 0.42 * weftWave;
        warpMix = isWarpTop ? 0.88 : 0.14;
      } else if (cfg.weaveType === 'knit_jersey') {
        const gu = u * periods;
        const gv = v * periods;
        const fx = gu - Math.floor(gu);
        const fy = gv - Math.floor(gv);
        const vRib = Math.abs(fx - 0.5) * 2;
        const wShape = Math.sin(((fx < 0.5 ? fx * 2 : (1 - fx) * 2) * 0.8 + fy * 0.4) * Math.PI);
        const loop = 0.5 + 0.5 * Math.cos((fy - 0.5 + vRib * 0.35) * Math.PI * 2);
        h = clamp(0.2 + 0.48 * wShape + 0.28 * loop, 0.05, 0.98);
        warpMix = 0.5 + 0.35 * Math.cos(fx * Math.PI * 2);
      } else if (cfg.weaveType === 'ripstop_grid') {
        const gridN = Math.max(2, Math.round(periods / 2));
        const gu = u * periods;
        const gv = v * periods;
        const fx = gu - Math.floor(gu);
        const fy = gv - Math.floor(gv);
        const base = 0.38 + 0.22 * Math.sin(fx * Math.PI) * Math.sin(fy * Math.PI);
        const rx = (u * gridN) % 1;
        const ry = (v * gridN) % 1;
        const onRib = rx < 0.16 || ry < 0.16;
        h = onRib ? 0.88 : base;
        warpMix = onRib ? 0.92 : 0.3 + 0.4 * Math.sin((fx + fy) * Math.PI);
      } else if (cfg.weaveType === 'leather_grain') {
        const cellCount = Math.max(4, periods);
        const w = periodicWorley(u, v, cellCount, 42);
        const edge = clamp((w.d2 - w.d1) * 2.4, 0, 1);
        const micro = periodicNoise(u, v, cellCount * 2, 19);
        h = clamp(0.22 + 0.58 * Math.pow(edge, 0.75) + 0.16 * micro, 0.05, 0.98);
        warpMix = clamp(0.35 + 0.55 * edge, 0, 1);
      } else {
        // eva_microcell
        const cellCount = Math.max(4, periods);
        const w = periodicWorley(u, v, cellCount, 88);
        const pore = clamp(w.d1 * 2.1, 0, 1);
        const ripple = periodicNoise(u, v, cellCount * 2, 71);
        h = clamp(0.28 + 0.5 * pore + 0.18 * ripple, 0.05, 0.98);
        warpMix = clamp(0.25 + 0.65 * pore, 0, 1);
      }

      const grainJitter = (periodicNoise(u, v, Math.max(4, periods * 2), 303) - 0.5) * 0.08;
      heightField[idx] = clamp(h + grainJitter, 0.02, 0.99);
      warpMaskField[idx] = clamp(warpMix, 0, 1);
    }
  }

  const albedoBuf = new Uint8Array(count * 4);
  const normalBuf = new Uint8Array(count * 4);
  const roughBuf = new Uint8Array(count * 4);
  const aoBuf = new Uint8Array(count * 4);
  const heightBuf = new Uint8Array(count * 4);

  const normalStrength = clamp(cfg.normal * 3.2, 0.25, 6.0);

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const idx = y * size + x;
      const p4 = idx * 4;

      const h = heightField[idx];
      const wMix = warpMaskField[idx];

      // Ambient occlusion
      const aoFactor = clamp(1.0 - cfg.ao * Math.pow(1.0 - h, 1.3), 0.12, 1.0);
      const aoByte = Math.round(aoFactor * 255);

      // Albedo blended between warp and weft/grain, modulated by subtle micro-AO
      const shade = 0.78 + 0.28 * h;
      const r = clamp(Math.round((weftRgb[0] * (1 - wMix) + warpRgb[0] * wMix) * shade * (0.72 + 0.28 * aoFactor)), 0, 255);
      const g = clamp(Math.round((weftRgb[1] * (1 - wMix) + warpRgb[1] * wMix) * shade * (0.72 + 0.28 * aoFactor)), 0, 255);
      const b = clamp(Math.round((weftRgb[2] * (1 - wMix) + warpRgb[2] * wMix) * shade * (0.72 + 0.28 * aoFactor)), 0, 255);

      // Slight stitch accent on ripstop rib highlights
      if (cfg.weaveType === 'ripstop_grid' && wMix > 0.9) {
        albedoBuf[p4] = Math.round(r * 0.8 + stitchRgb[0] * 0.2);
        albedoBuf[p4 + 1] = Math.round(g * 0.8 + stitchRgb[1] * 0.2);
        albedoBuf[p4 + 2] = Math.round(b * 0.8 + stitchRgb[2] * 0.2);
      } else {
        albedoBuf[p4] = r;
        albedoBuf[p4 + 1] = g;
        albedoBuf[p4 + 2] = b;
      }
      albedoBuf[p4 + 3] = 255;

      // Sobel/central finite-difference tangent-space normal
      const hL = heightField[y * size + xm];
      const hR = heightField[y * size + xp];
      const hD = heightField[ym * size + x];
      const hU = heightField[yp * size + x];
      const dx = (hR - hL) * normalStrength;
      const dy = (hU - hD) * normalStrength;
      const invLen = 1 / Math.hypot(-dx, -dy, 1.0);
      const nx = (-dx * invLen) * 0.5 + 0.5;
      const ny = (-dy * invLen) * 0.5 + 0.5;
      const nz = (1.0 * invLen) * 0.5 + 0.5;
      normalBuf[p4] = clamp(Math.round(nx * 255), 0, 255);
      normalBuf[p4 + 1] = clamp(Math.round(ny * 255), 0, 255);
      normalBuf[p4 + 2] = clamp(Math.round(nz * 255), 0, 255);
      normalBuf[p4 + 3] = 255;

      // Roughness map (crevices rougher, raised yarn slightly smoother with sheen)
      const rVal = clamp(cfg.roughness + 0.16 * (1 - h) - 0.10 * h - 0.06 * cfg.sheen * h, 0.04, 1.0);
      const rByte = Math.round(rVal * 255);
      roughBuf[p4] = rByte;
      roughBuf[p4 + 1] = rByte;
      roughBuf[p4 + 2] = rByte;
      roughBuf[p4 + 3] = 255;

      aoBuf[p4] = aoByte;
      aoBuf[p4 + 1] = aoByte;
      aoBuf[p4 + 2] = aoByte;
      aoBuf[p4 + 3] = 255;

      const hByte = clamp(Math.round(h * 255), 0, 255);
      heightBuf[p4] = hByte;
      heightBuf[p4 + 1] = hByte;
      heightBuf[p4 + 2] = hByte;
      heightBuf[p4 + 3] = 255;
    }
  }

  const albedo = { width: size, height: size, data: albedoBuf };
  const normal = { width: size, height: size, data: normalBuf };
  const roughness = { width: size, height: size, data: roughBuf };
  const ao = { width: size, height: size, data: aoBuf };
  const height = { width: size, height: size, data: heightBuf };

  return {
    size,
    width: size,
    heightPx: size,
    albedo,
    normal,
    roughness,
    ao,
    height,
    heightMap: heightBuf,
    channels: { albedo, normal, roughness, ao, height },
  };
}

/**
 * Generates a tileable SVG material swatch reflecting weave structure and yarn/grain colors.
 * @param {object} materialConfig
 * @param {number} sizePx
 * @returns {string}
 */
export function generateProceduralWeaveSVG(materialConfig = {}, sizePx = 120) {
  const cfg = getMaterialConfig(materialConfig?.id || 'cotton_jersey', materialConfig || {});
  const size = clamp(Math.trunc(finiteOr(sizePx, 120)), 32, 512);
  const warp = escapeXmlAttr(cfg.warpColor);
  const weft = escapeXmlAttr(cfg.weftColor);
  const stitch = escapeXmlAttr(cfg.stitchColor);

  const elements = [];
  elements.push(`<rect x="0" y="0" width="${size}" height="${size}" fill="${weft}"/>`);

  if (cfg.weaveType === 'leather_grain' || cfg.weaveType === 'eva_microcell') {
    const step = Math.max(8, Math.round(size / 8));
    for (let y = 0; y < size; y += step) {
      for (let x = 0; x < size; x += step) {
        const jx = Math.round((hash2D(x, y, 17) - 0.5) * step * 0.45);
        const jy = Math.round((hash2D(x, y, 53) - 0.5) * step * 0.45);
        const r = Math.max(2, Math.round(step * (cfg.weaveType === 'eva_microcell' ? 0.25 : 0.36)));
        const cx = x + Math.round(step * 0.5) + jx;
        const cy = y + Math.round(step * 0.5) + jy;
        elements.push(
          `<path d="M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0" fill="${warp}" fill-opacity="0.72"/>`
        );
      }
    }
    elements.push(`<line x1="6" y1="${size - 10}" x2="${size - 6}" y2="${size - 10}" stroke="${stitch}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
  } else if (cfg.weaveType === 'knit_jersey') {
    const cols = 6;
    const rows = 6;
    const cw = size / cols;
    const rh = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * cw;
        const y0 = r * rh;
        const xm = x0 + cw * 0.5;
        const y1 = y0 + rh;
        elements.push(
          `<path d="M ${x0 + 2} ${y0 + 1} L ${xm} ${y1 - 2} L ${x0 + cw - 2} ${y0 + 1}" fill="none" stroke="${warp}" stroke-width="${Math.max(2, cw * 0.22).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`
        );
      }
    }
  } else {
    // plain_weave, twill_3x1, ripstop_grid
    const cells = cfg.weaveType === 'ripstop_grid' ? 8 : 6;
    const step = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const isWarp = cfg.weaveType === 'twill_3x1' ? ((c + r) % 4) < 3 : ((c + r) & 1) === 0;
        const fill = isWarp ? warp : weft;
        const x = (c * step).toFixed(1);
        const y = (r * step).toFixed(1);
        const w = (step - 1).toFixed(1);
        elements.push(`<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="1.5" fill="${fill}" stroke="${stitch}" stroke-opacity="0.22" stroke-width="0.6"/>`);
      }
    }
    if (cfg.weaveType === 'ripstop_grid') {
      for (let i = 0; i <= cells; i += 4) {
        const pos = (i * step).toFixed(1);
        elements.push(`<line x1="${pos}" y1="0" x2="${pos}" y2="${size}" stroke="${stitch}" stroke-width="1.6" stroke-opacity="0.75"/>`);
        elements.push(`<line x1="0" y1="${pos}" x2="${size}" y2="${pos}" stroke="${stitch}" stroke-width="1.6" stroke-opacity="0.75"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" data-weave="${escapeXmlAttr(cfg.weaveType)}">\n  ${elements.join('\n  ')}\n</svg>`;
}
