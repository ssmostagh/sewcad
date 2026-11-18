/**
 * Hardware-Accelerated WebGL2 GLSL 300 es PBR 3D Viewport (`webgl3d.mjs`)
 * Features:
 * - 100% STL triangle rendering (zero decimation) aligned in raw STL world space
 * - Articulated dress-form avatar (torso/neck mesh + head, arms, legs, stand, seam tape rings)
 * - Procedural Substance-style PBR cloth shading (Albedo, Normal via dFdx/dFdy TBN, Roughness, AO, GGX + Sheen)
 * - Toggleable Strain / Fit tension heatmap + wireframe + 3D sewing seam threads
 * - Interactive ray/screen-space particle picking & pinning (`p.invMass = 0`)
 * - Graceful Canvas2D fallback when WebGL2 is unavailable (e.g., headless Node/no-GPU)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generateProceduralPBRMaps } from '../src/core/materials.mjs';

const VS_GRID = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const FS_GRID = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(vColor, 1.0);
}
`;

const VS_WIRE = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const FS_WIRE = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}
`;

const VS_SOLID = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vWorldPos = aPos;
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const FS_SOLID = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vColor;
uniform vec3 uCamPos;
uniform float uAlpha;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vWorldPos);

  vec3 L1 = normalize(vec3(0.55, 0.80, 0.65));
  vec3 L2 = normalize(vec3(-0.75, 0.35, -0.45));
  vec3 L3 = normalize(vec3(0.15, -0.55, 0.70));

  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0);
  float diff3 = max(dot(N, L3), 0.0);

  vec3 H1 = normalize(L1 + V);
  float spec1 = pow(max(dot(N, H1), 0.0), 42.0) * 0.28;
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.18;

  vec3 hemi = mix(vec3(0.16, 0.19, 0.24), vec3(0.32, 0.37, 0.45), N.y * 0.5 + 0.5);
  vec3 lit = vColor * (hemi + diff1 * vec3(0.88, 0.86, 0.82) + diff2 * vec3(0.28, 0.38, 0.52) + diff3 * vec3(0.16, 0.16, 0.18));
  lit += vec3(spec1) + vec3(0.35, 0.65, 0.95) * fresnel;
  fragColor = vec4(clamp(lit, 0.0, 1.0), uAlpha);
}
`;

const VS_CLOTH = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
in vec3 aStrainColor;
in float aSelected;
uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec3 vStrainColor;
out float vSelected;
void main() {
  vWorldPos = aPos;
  vNormal = aNormal;
  vUv = aUv;
  vStrainColor = aStrainColor;
  vSelected = aSelected;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const FS_CLOTH = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec3 vStrainColor;
in float vSelected;

uniform vec3 uCamPos;
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughnessMap;
uniform sampler2D uAoMap;
uniform float uNormalStrength;
uniform float uRoughness;
uniform float uMetallic;
uniform float uAoStrength;
uniform float uSheen;
uniform float uShowStrainMap;

out vec4 fragColor;

const float PI = 3.14159265359;

vec3 perturbNormal(vec3 N, vec3 pos, vec2 uv, vec3 mapN, float strength) {
  vec3 dp1 = dFdx(pos);
  vec3 dp2 = dFdy(pos);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-8);
  mat3 TBN = mat3(T * invmax, B * invmax, N);
  vec3 nLocal = mapN * 2.0 - 1.0;
  nLocal.xy *= strength;
  return normalize(TBN * nLocal);
}

float distributionGGX(vec3 N, vec3 H, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 1e-5);
}

float geometrySchlickGGX(float NdotV, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  return NdotV / max(NdotV * (1.0 - k) + k, 1e-5);
}

void main() {
  vec3 geoN = normalize(vNormal);
  if (!gl_FrontFacing) geoN = -geoN;

  vec3 albedoSample = texture(uAlbedoMap, vUv).rgb;
  vec3 normalSample = texture(uNormalMap, vUv).rgb;
  float roughSample = texture(uRoughnessMap, vUv).r;
  float aoSample = texture(uAoMap, vUv).r;

  vec3 N = perturbNormal(geoN, vWorldPos, vUv, normalSample, uNormalStrength);
  vec3 V = normalize(uCamPos - vWorldPos);
  float rough = clamp(mix(uRoughness, roughSample, 0.65), 0.08, 0.98);
  float ao = mix(1.0, aoSample, uAoStrength);

  vec3 baseAlbedo = mix(albedoSample, vStrainColor, clamp(uShowStrainMap, 0.0, 1.0) * 0.86);
  vec3 F0 = mix(vec3(0.04), baseAlbedo, uMetallic);

  vec3 lightDirs[3];
  lightDirs[0] = normalize(vec3(0.55, 0.85, 0.65));
  lightDirs[1] = normalize(vec3(-0.70, 0.40, -0.50));
  lightDirs[2] = normalize(vec3(0.10, -0.35, -0.85));

  vec3 lightCols[3];
  lightCols[0] = vec3(1.18, 1.15, 1.10);
  lightCols[1] = vec3(0.36, 0.46, 0.62);
  lightCols[2] = vec3(0.28, 0.34, 0.42);

  vec3 Lo = vec3(0.0);
  float NdotV = max(dot(N, V), 0.001);

  for (int i = 0; i < 3; i++) {
    vec3 L = lightDirs[i];
    vec3 H = normalize(V + L);
    float NdotL = max(dot(N, L), 0.0);
    if (NdotL > 0.0) {
      float NDF = distributionGGX(N, H, rough);
      float G = geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
      vec3 F = F0 + (1.0 - F0) * pow(clamp(1.0 - max(dot(H, V), 0.0), 0.0, 1.0), 5.0);
      vec3 spec = (NDF * G * F) / max(4.0 * NdotV * NdotL, 0.001);
      vec3 kD = (vec3(1.0) - F) * (1.0 - uMetallic);
      Lo += (kD * baseAlbedo / PI + spec) * lightCols[i] * NdotL;
    }
  }

  float grazing = pow(clamp(1.0 - NdotV, 0.0, 1.0), 3.5);
  vec3 sheenTerm = baseAlbedo * uSheen * grazing * 0.45;
  vec3 ambient = mix(vec3(0.14, 0.17, 0.22), vec3(0.26, 0.30, 0.36), N.y * 0.5 + 0.5) * baseAlbedo * ao;

  vec3 color = ambient + Lo + sheenTerm;
  if (vSelected > 0.5 && uShowStrainMap < 0.5) {
    color += vec3(0.08, 0.24, 0.38) * (0.25 + grazing * 0.75);
  }
  color = color / (color + vec3(1.0));
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;

const VS_OVERLAY = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aColor;
uniform mat4 uViewProj;
uniform float uPointSize;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}
`;

const FS_OVERLAY = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uIsPoints;
out vec4 fragColor;
void main() {
  if (uIsPoints > 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float ring = r > 0.32 ? 1.0 : 0.75;
    fragColor = vec4(vColor * ring, 1.0);
    return;
  }
  fragColor = vec4(vColor, 1.0);
}
`;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mulMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function perspectiveMat4(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad * 0.5);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / Math.max(0.1, aspect);
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function lookAtMat4(eye, target, up) {
  let zx = eye.x - target.x;
  let zy = eye.y - target.y;
  let zz = eye.z - target.z;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const m = new Float32Array(16);
  m[0] = xx; m[4] = xy; m[8] = xz;   m[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
  m[1] = yx; m[5] = yy; m[9] = yz;   m[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  m[2] = zx; m[6] = zy; m[10] = zz;  m[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  m[3] = 0;  m[7] = 0;  m[11] = 0;   m[15] = 1;
  return m;
}

function appendEllipsoid(posArr, normArr, colArr, center, radii, color, segU = 14, segV = 10) {
  const ring = (iu, iv) => {
    const theta = (iu / segU) * Math.PI * 2;
    const phi = (iv / segV) * Math.PI;
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);
    return {
      p: [center.x + nx * radii.x, center.y + ny * radii.y, center.z + nz * radii.z],
      n: [nx / Math.max(1e-4, radii.x), ny / Math.max(1e-4, radii.y), nz / Math.max(1e-4, radii.z)],
    };
  };
  const normVec = (n) => {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  for (let iv = 0; iv < segV; iv++) {
    for (let iu = 0; iu < segU; iu++) {
      const a = ring(iu, iv);
      const b = ring(iu + 1, iv);
      const c = ring(iu + 1, iv + 1);
      const d = ring(iu, iv + 1);
      for (const v of [a, c, b, a, d, c]) {
        const nn = normVec(v.n);
        posArr.push(v.p[0], v.p[1], v.p[2]);
        normArr.push(nn[0], nn[1], nn[2]);
        colArr.push(color[0], color[1], color[2]);
      }
    }
  }
}

function appendCylinder(posArr, normArr, colArr, p0, p1, r0, r1, color, seg = 14) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  const up = Math.abs(ay) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let tx = ay * up.z - az * up.y;
  let ty = az * up.x - ax * up.z;
  let tz = ax * up.y - ay * up.x;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ay * tz - az * ty;
  const by = az * tx - ax * tz;
  const bz = ax * ty - ay * tx;

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const n0 = [tx * c0 + bx * s0, ty * c0 + by * s0, tz * c0 + bz * s0];
    const n1 = [tx * c1 + bx * s1, ty * c1 + by * s1, tz * c1 + bz * s1];

    const v00 = [p0.x + n0[0] * r0, p0.y + n0[1] * r0, p0.z + n0[2] * r0];
    const v01 = [p0.x + n1[0] * r0, p0.y + n1[1] * r0, p0.z + n1[2] * r0];
    const v10 = [p1.x + n0[0] * r1, p1.y + n0[1] * r1, p1.z + n0[2] * r1];
    const v11 = [p1.x + n1[0] * r1, p1.y + n1[1] * r1, p1.z + n1[2] * r1];

    const tris = [
      [v00, n0], [v11, n1], [v01, n1],
      [v00, n0], [v10, n0], [v11, n1],
    ];
    for (const [vp, vn] of tris) {
      posArr.push(vp[0], vp[1], vp[2]);
      normArr.push(vn[0], vn[1], vn[2]);
      colArr.push(color[0], color[1], color[2]);
    }
  }
}

export class WebGL3DViewport {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;

    this.cssWidth = Math.max(100, canvas?.width || 640);
    this.cssHeight = Math.max(100, canvas?.height || 480);
    this.dpr = 1;

    this.cam = {
      yaw: 0.45,
      pitch: 0.24,
      distance: 1150,
      target: { x: 0, y: 110, z: 0 },
    };

    this.scene = {
      sim: null,
      avatar: null,
      stlMesh: null,
      materialConfig: null,
      showStrainMap: false,
      showForm: true,
      showWire: false,
      showThreads: true,
      selectedPieceId: null,
      pinMode: false,
    };

    this.lastRenderStats = {
      mode: 'none',
      renderedStlTriangles: 0,
      renderedClothTriangles: 0,
      renderedAvatarTriangles: 0,
      drawCalls: 0,
    };

    this._drag = null;
    this._dirty = true;
    this._disposed = false;
    this._rafId = null;

    this._stlCacheRef = null;
    this._stlTriCount = 0;
    this._avatarCacheRef = null;
    this._avatarVertCount = 0;
    this._materialSig = '';

    this.gl = null;
    this.ctx2d = null;
    this.mode = 'none';
    this._contextLost = false;
    this._boundEvents = [];
    this._contextOptions = {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    };

    try {
      this.gl = canvas?.getContext?.('webgl2', this._contextOptions) || null;
    } catch {
      this.gl = null;
    }

    if (this.gl) {
      try {
        this._initGL();
        this.mode = 'webgl2';
        if (typeof window !== 'undefined') {
          window.__psv2WebGLContexts = (window.__psv2WebGLContexts || 0) + 1;
          window.__psv2WebGLDraws = window.__psv2WebGLDraws || 0;
        }
      } catch {
        this._disposeGLResources();
        this._activate2DFallback(canvas);
      }
    } else {
      this._activate2DFallback(canvas);
    }

    this._bindEvents();
  }

  _activate2DFallback(canvas) {
    let ctx2d = null;
    try {
      ctx2d = canvas?.getContext?.('2d') || null;
    } catch {
      ctx2d = null;
    }
    if (ctx2d) {
      this.canvas = canvas;
      this.ctx2d = ctx2d;
      this.mode = '2d';
      return;
    }

    const parent = canvas?.parentNode || canvas?.parentElement || null;
    if (parent && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      try {
        const rep = document.createElement('canvas');
        if (rep) {
          if (canvas.id) rep.id = canvas.id;
          if (canvas.className) rep.className = canvas.className;
          if (typeof canvas.getAttribute === 'function' && typeof rep.setAttribute === 'function') {
            for (const attr of ['aria-label', 'role', 'style', 'title']) {
              const val = canvas.getAttribute(attr);
              if (val) rep.setAttribute(attr, val);
            }
          }
          rep.width = canvas.width || 640;
          rep.height = canvas.height || 480;
          const repCtx = rep.getContext?.('2d') || null;
          if (repCtx) {
            let swapped = false;
            if (typeof parent.replaceChild === 'function') {
              try {
                parent.replaceChild(rep, canvas);
                swapped = true;
              } catch {
                swapped = false;
              }
            }
            if (!swapped && typeof canvas.replaceWith === 'function') {
              try {
                canvas.replaceWith(rep);
                swapped = true;
              } catch {
                swapped = false;
              }
            }
            if (swapped || (typeof parent.replaceChild !== 'function' && typeof canvas.replaceWith !== 'function')) {
              try {
                if (!rep.parentElement) rep.parentElement = parent;
              } catch {
                // Ignore read-only parentElement on live DOM elements
              }
              this.canvas = rep;
              this.ctx2d = repCtx;
              this.mode = '2d';
              return;
            }
          }
        }
      } catch {
        // Fall through to 'none'
      }
    }

    this.ctx2d = null;
    this.mode = 'none';
  }

  _recordDrawCall() {
    this.lastRenderStats.drawCalls += 1;
    if (typeof window !== 'undefined') {
      window.__psv2WebGLDraws = (window.__psv2WebGLDraws || 0) + 1;
    }
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('WebGL2 createShader returned null');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader?.(shader);
      throw new Error(`WebGL2 shader compile failed: ${log}`);
    }
    return shader;
  }

  _createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    let vs = null;
    let fs = null;
    let prog = null;
    try {
      vs = this._compileShader(gl.VERTEX_SHADER, vsSrc);
      fs = this._compileShader(gl.FRAGMENT_SHADER, fsSrc);
      prog = gl.createProgram();
      if (!prog) {
        throw new Error('WebGL2 createProgram returned null');
      }
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        throw new Error(`WebGL2 program link failed: ${log}`);
      }
      return prog;
    } catch (err) {
      if (prog) gl.deleteProgram?.(prog);
      throw err;
    } finally {
      if (vs) gl.deleteShader?.(vs);
      if (fs) gl.deleteShader?.(fs);
    }
  }

  _createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fallback = new Uint8Array([180, 190, 200, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, fallback);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  _isContextUnavailable() {
    return !this.gl || this._contextLost || Boolean(this.gl.isContextLost?.());
  }

  _uploadTexture(tex, map) {
    if (this._isContextUnavailable() || !tex || !map?.data || !map.width || !map.height) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const bytes = map.data instanceof Uint8Array ? map.data : new Uint8Array(map.data.buffer || map.data);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, map.width, map.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  _initGL() {
    const gl = this.gl;
    this._progs = {};
    this._tex = {};
    this._buf = {};

    this._progs.grid = this._createProgram(VS_GRID, FS_GRID);
    this._progs.wire = this._createProgram(VS_WIRE, FS_WIRE);
    this._progs.solid = this._createProgram(VS_SOLID, FS_SOLID);
    this._progs.cloth = this._createProgram(VS_CLOTH, FS_CLOTH);
    this._progs.overlay = this._createProgram(VS_OVERLAY, FS_OVERLAY);

    this._tex.albedo = this._createTexture();
    this._tex.normal = this._createTexture();
    this._tex.roughness = this._createTexture();
    this._tex.ao = this._createTexture();

    this._buf.gridVao = gl.createVertexArray();
    this._buf.gridVbo = gl.createBuffer();
    this._buf.gridCount = 0;

    this._buf.stlVao = gl.createVertexArray();
    this._buf.stlPos = gl.createBuffer();
    this._buf.stlNorm = gl.createBuffer();
    this._buf.stlCol = gl.createBuffer();

    this._buf.avatarVao = gl.createVertexArray();
    this._buf.avatarPos = gl.createBuffer();
    this._buf.avatarNorm = gl.createBuffer();
    this._buf.avatarCol = gl.createBuffer();

    this._buf.clothVao = gl.createVertexArray();
    this._buf.clothPos = gl.createBuffer();
    this._buf.clothNorm = gl.createBuffer();
    this._buf.clothUv = gl.createBuffer();
    this._buf.clothStrain = gl.createBuffer();
    this._buf.clothSel = gl.createBuffer();
    this._buf.clothEbo = gl.createBuffer();
    this._buf.clothWireVao = gl.createVertexArray();
    this._buf.clothWireEbo = gl.createBuffer();

    this._buf.overlayVao = gl.createVertexArray();
    this._buf.overlayVbo = gl.createBuffer();

    this._buildGridBuffer(-420);
  }

  _buildGridBuffer(yFloor) {
    if (this._isContextUnavailable()) return;
    const gl = this.gl;
    const cx = this.cam.target.x;
    const cz = this.cam.target.z;
    const span = 600;
    const step = 100;
    const verts = [];
    for (let d = -span; d <= span; d += step) {
      const c = d === 0 ? [0.22, 0.42, 0.62] : [0.14, 0.18, 0.25];
      verts.push(cx + d, yFloor, cz - span, c[0], c[1], c[2]);
      verts.push(cx + d, yFloor, cz + span, c[0], c[1], c[2]);
      verts.push(cx - span, yFloor, cz + d, c[0], c[1], c[2]);
      verts.push(cx + span, yFloor, cz + d, c[0], c[1], c[2]);
    }
    const data = new Float32Array(verts);
    this._buf.gridCount = data.length / 6;

    gl.bindVertexArray(this._buf.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf.gridVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this._progs.grid, 'aPos');
    const aCol = gl.getAttribLocation(this._progs.grid, 'aColor');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  _uploadSTLMesh(stlMesh) {
    if (this._isContextUnavailable() || !stlMesh) return;
    const gl = this.gl;
    const faces = stlMesh.faces || [];
    const verts = stlMesh.vertices || [];
    const count = faces.length * 3;
    const pos = new Float32Array(count * 3);
    const norm = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);

    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const v0 = verts[f.indices[0]];
      const v1 = verts[f.indices[1]];
      const v2 = verts[f.indices[2]];
      if (!v0 || !v1 || !v2) continue;
      let nx = f.normal?.x ?? 0;
      let ny = f.normal?.y ?? 0;
      let nz = f.normal?.z ?? 1;
      if (Math.hypot(nx, ny, nz) < 1e-6) {
        const ux = v1.x - v0.x, uy = v1.y - v0.y, uz = v1.z - v0.z;
        const wx = v2.x - v0.x, wy = v2.y - v0.y, wz = v2.z - v0.z;
        nx = uy * wz - uz * wy;
        ny = uz * wx - ux * wz;
        nz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
      }
      const triVerts = [v0, v1, v2];
      for (let k = 0; k < 3; k++) {
        const idx = (i * 3 + k) * 3;
        pos[idx] = triVerts[k].x;
        pos[idx + 1] = triVerts[k].y;
        pos[idx + 2] = triVerts[k].z;
        norm[idx] = nx;
        norm[idx + 1] = ny;
        norm[idx + 2] = nz;
        col[idx] = 0.52;
        col[idx + 1] = 0.60;
        col[idx + 2] = 0.72;
      }
    }

    this._stlTriCount = faces.length;
    gl.bindVertexArray(this._buf.stlVao);

    const bindAttr = (buf, name, data) => {
      const loc = gl.getAttribLocation(this._progs.solid, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      }
    };

    bindAttr(this._buf.stlPos, 'aPos', pos);
    bindAttr(this._buf.stlNorm, 'aNormal', norm);
    bindAttr(this._buf.stlCol, 'aColor', col);
    gl.bindVertexArray(null);
  }

  _buildAvatarGeometry(avatar) {
    const pos = [];
    const norm = [];
    const col = [];
    const formCol = [0.46, 0.43, 0.40];
    const jointCol = [0.34, 0.36, 0.40];
    const metalCol = [0.58, 0.62, 0.68];

    // 1. Lofted torso & neck
    const tris = avatar.triangles || [];
    const verts = avatar.vertices || [];
    const norms = avatar.normals || [];
    for (let i = 0; i < tris.length; i++) {
      const [ia, ib, ic] = tris[i];
      const va = verts[ia], vb = verts[ib], vc = verts[ic];
      if (!va || !vb || !vc) continue;
      const na = norms[ia] || { x: 0, y: 1, z: 0 };
      const nb = norms[ib] || { x: 0, y: 1, z: 0 };
      const nc = norms[ic] || { x: 0, y: 1, z: 0 };
      pos.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
      norm.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
      col.push(...formCol, ...formCol, ...formCol);
    }

    // 2. Articulated dress-form head, limbs & stand from colliders + measurements
    const hScale = (avatar.measurements?.heightMm || 1750) / 1750;
    const neckCol = avatar.colliders?.find((c) => c.name === 'neck');
    const neckTopY = neckCol ? neckCol.center.y + neckCol.radii.y * 0.9 : 415 * hScale;

    // Finial / Head oval
    appendEllipsoid(pos, norm, col, { x: 0, y: neckTopY + 95 * hScale, z: 4 }, { x: 72, y: 98 * hScale, z: 85 }, jointCol, 14, 10);

    // Shoulder caps & articulated arms/legs from colliders
    const shoulderCol = avatar.colliders?.find((c) => c.name === 'shoulders');
    const shHalf = shoulderCol ? shoulderCol.radii.x * 0.88 : 205;
    const shY = shoulderCol ? shoulderCol.center.y : 295 * hScale;

    for (const side of [-1, 1]) {
      const shJoint = { x: side * shHalf, y: shY, z: 0 };
      const elbow = { x: side * (shHalf + 48), y: shY - 245 * hScale, z: -8 };
      const wrist = { x: side * (shHalf + 62), y: shY - 475 * hScale, z: 18 };
      appendEllipsoid(pos, norm, col, shJoint, { x: 42, y: 42, z: 42 }, jointCol, 10, 8);
      appendCylinder(pos, norm, col, shJoint, elbow, 36, 30, formCol, 12);
      appendEllipsoid(pos, norm, col, elbow, { x: 30, y: 30, z: 30 }, jointCol, 10, 8);
      appendCylinder(pos, norm, col, elbow, wrist, 28, 22, formCol, 12);

      const hipTop = { x: side * 88, y: -195 * hScale, z: 0 };
      const knee = { x: side * 90, y: -490 * hScale, z: 6 };
      const ankle = { x: side * 88, y: (avatar.floorY || -980) * 0.82, z: 0 };
      appendCylinder(pos, norm, col, hipTop, knee, 66, 46, jointCol, 12);
      appendCylinder(pos, norm, col, knee, ankle, 44, 30, jointCol, 12);
    }

    // Dress form stand pole & base
    const standTop = { x: 0, y: -195 * hScale, z: 0 };
    const standBot = { x: 0, y: (avatar.floorY || -980) * 0.85, z: 0 };
    appendCylinder(pos, norm, col, standTop, standBot, 16, 16, metalCol, 12);
    appendCylinder(pos, norm, col, standBot, { x: 0, y: standBot.y - 14, z: 0 }, 190, 195, metalCol, 18);

    return {
      pos: new Float32Array(pos),
      norm: new Float32Array(norm),
      col: new Float32Array(col),
      vertCount: pos.length / 3,
    };
  }

  _uploadAvatar(avatar) {
    if (this._isContextUnavailable() || !avatar) return;
    const gl = this.gl;
    const geom = this._buildAvatarGeometry(avatar);
    this._avatarVertCount = geom.vertCount;
    gl.bindVertexArray(this._buf.avatarVao);

    const bindAttr = (buf, name, data) => {
      const loc = gl.getAttribLocation(this._progs.solid, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      }
    };

    bindAttr(this._buf.avatarPos, 'aPos', geom.pos);
    bindAttr(this._buf.avatarNorm, 'aNormal', geom.norm);
    bindAttr(this._buf.avatarCol, 'aColor', geom.col);
    gl.bindVertexArray(null);
  }

  _markDirty() {
    this._dirty = true;
    if (!this._disposed) {
      this.callbacks.onDirty?.();
    }
  }

  updateMaterialMaps(materialConfig) {
    if (!materialConfig) return;
    const sig = JSON.stringify({
      weaveType: materialConfig.weaveType,
      warpColor: materialConfig.warpColor,
      weftColor: materialConfig.weftColor,
      stitchColor: materialConfig.stitchColor,
      normal: materialConfig.normal,
      roughness: materialConfig.roughness,
      ao: materialConfig.ao,
      threadScaleMm: materialConfig.threadScaleMm,
    });
    if (this.gl && (this._contextLost || this.gl.isContextLost?.())) return;
    if (sig === this._materialSig) return;
    this._materialSig = sig;
    if (!this.gl) return;
    const maps = generateProceduralPBRMaps(materialConfig, 128);
    this._uploadTexture(this._tex.albedo, maps.albedo);
    this._uploadTexture(this._tex.normal, maps.normal);
    this._uploadTexture(this._tex.roughness, maps.roughness);
    this._uploadTexture(this._tex.ao, maps.ao);
    this._markDirty();
  }

  setScene(partialScene = {}) {
    Object.assign(this.scene, partialScene);
    if (partialScene.materialConfig) {
      this.updateMaterialMaps(partialScene.materialConfig);
    }
    this._markDirty();
  }

  resize(widthCss, heightCss, dpr = 1) {
    const safeW = Number.isFinite(widthCss) && widthCss > 0 ? widthCss : 640;
    const safeH = Number.isFinite(heightCss) && heightCss > 0 ? heightCss : 480;
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.cssWidth = Math.max(100, safeW);
    this.cssHeight = Math.max(100, safeH);
    this.dpr = Math.max(1, safeDpr);
    const pxW = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const pxH = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas && (this.canvas.width !== pxW || this.canvas.height !== pxH)) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }
    if (!this._isContextUnavailable()) {
      this.gl.viewport(0, 0, pxW, pxH);
    }
    this._markDirty();
  }

  fitToScene() {
    const stl = this.scene.stlMesh;
    const avatar = this.scene.avatar;
    if (stl?.bounds?.center && stl?.bounds?.size) {
      const c = stl.bounds.center;
      const s = stl.bounds.size;
      const radius = Math.hypot(s.x, s.y, s.z) * 0.5;
      this.cam.target = { x: c.x, y: c.y, z: c.z };
      this.cam.distance = clamp(radius * 2.45, 160, 3200);
      this._buildGridBuffer((stl.bounds.min?.y ?? c.y - s.y * 0.5) - 6);
    } else if (avatar) {
      const hScale = (avatar.measurements?.heightMm || 1750) / 1750;
      this.cam.target = { x: 0, y: 110 * hScale, z: 0 };
      this.cam.distance = 1150 * hScale;
      this._buildGridBuffer((avatar.floorY || -980) * 0.86);
    } else {
      this.cam.target = { x: 0, y: 0, z: 0 };
      this.cam.distance = 900;
    }
    this._markDirty();
  }

  setCameraPreset(preset) {
    if (preset === 'front') {
      this.cam.yaw = 0;
      this.cam.pitch = 0.08;
    } else if (preset === 'side') {
      this.cam.yaw = Math.PI * 0.5;
      this.cam.pitch = 0.08;
    } else if (preset === 'top') {
      this.cam.yaw = 0.15;
      this.cam.pitch = 1.25;
    } else {
      this.cam.yaw = 0.45;
      this.cam.pitch = 0.24;
    }
    this._markDirty();
  }

  _getCameraMatrices() {
    const { yaw, pitch, distance, target } = this.cam;
    const cp = Math.cos(pitch);
    const eye = {
      x: target.x + distance * cp * Math.sin(yaw),
      y: target.y + distance * Math.sin(pitch),
      z: target.z + distance * cp * Math.cos(yaw),
    };
    const aspect = this.cssWidth / Math.max(1, this.cssHeight);
    const near = Math.max(4, distance * 0.02);
    const far = Math.max(6000, distance * 8);
    const proj = perspectiveMat4((42 * Math.PI) / 180, aspect, near, far);
    const view = lookAtMat4(eye, target, { x: 0, y: 1, z: 0 });
    const viewProj = mulMat4(proj, view);
    return { eye, view, proj, viewProj };
  }

  _projectPoint(p, viewProj) {
    const x = p.x, y = p.y, z = p.z;
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cz = viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 1e-4) return null;
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const ndcZ = cz / cw;
    return {
      sx: (ndcX * 0.5 + 0.5) * this.cssWidth,
      sy: (0.5 - ndcY * 0.5) * this.cssHeight,
      ndcZ,
    };
  }

  pickParticle(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const sim = this.scene.sim;
    if (!sim || !Array.isArray(sim.particles) || !this.canvas?.getBoundingClientRect) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
    const { viewProj } = this._getCameraMatrices();

    let bestIdx = -1;
    let bestScore = Infinity;
    let bestDist = Infinity;

    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i];
      if (!p?.pos) continue;
      const proj = this._projectPoint(p.pos, viewProj);
      if (!proj) continue;
      const d = Math.hypot(mx - proj.sx, my - proj.sy);
      if (d <= 18) {
        const score = d + proj.ndcZ * 4;
        if (score < bestScore) {
          bestScore = score;
          bestDist = d;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) return null;
    return {
      particleIndex: bestIdx,
      distancePx: bestDist,
      worldPos: { ...sim.particles[bestIdx].pos },
    };
  }

  togglePinParticle(idx) {
    const sim = this.scene.sim;
    const p = sim?.particles?.[idx];
    if (!p) return false;
    if (p.invMass <= 0) {
      p.invMass = p._origInvMass > 0 ? p._origInvMass : 1.0;
    } else {
      p._origInvMass = p.invMass;
      p.invMass = 0;
    }
    this._markDirty();
    return p.invMass <= 0;
  }

  movePinnedParticle(idx, dxScreen, dyScreen) {
    if (!Number.isFinite(dxScreen) || !Number.isFinite(dyScreen)) return;
    const sim = this.scene.sim;
    const p = sim?.particles?.[idx];
    if (!p) return;
    const { eye } = this._getCameraMatrices();
    const fwd = {
      x: this.cam.target.x - eye.x,
      y: this.cam.target.y - eye.y,
      z: this.cam.target.z - eye.z,
    };
    const fLen = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
    fwd.x /= fLen; fwd.y /= fLen; fwd.z /= fLen;

    let rx = -fwd.z;
    let ry = 0;
    let rz = fwd.x;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen; rz /= rLen;

    const ux = ry * fwd.z - rz * fwd.y;
    const uy = rz * fwd.x - rx * fwd.z;
    const uz = rx * fwd.y - ry * fwd.x;

    const scale = (this.cam.distance * 0.78) / Math.max(200, this.cssHeight);
    const nx = p.pos.x + (rx * dxScreen - ux * dyScreen) * scale;
    const ny = p.pos.y + (ry * dxScreen - uy * dyScreen) * scale;
    const nz = p.pos.z + (rz * dxScreen - uz * dyScreen) * scale;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return;
    if (p.invMass > 0) {
      p._origInvMass = p.invMass;
      p.invMass = 0;
    }
    p.pos.x = nx;
    p.pos.y = ny;
    p.pos.z = nz;
    p.prevPos.x = p.pos.x;
    p.prevPos.y = p.pos.y;
    p.prevPos.z = p.pos.z;
    p.lastFinitePos.x = p.pos.x;
    p.lastFinitePos.y = p.pos.y;
    p.lastFinitePos.z = p.pos.z;
    this._markDirty();
  }

  clearPins() {
    const sim = this.scene.sim;
    if (!sim || !Array.isArray(sim.particles)) return;
    for (const p of sim.particles) {
      if (p.invMass <= 0) {
        p.invMass = p._origInvMass > 0 ? p._origInvMass : 1.0;
      }
    }
    this._markDirty();
  }

  _bindEvents() {
    if (!this.canvas || typeof this.canvas.addEventListener !== 'function') return;

    const addListener = (type, fn, opts) => {
      this.canvas.addEventListener(type, fn, opts);
      this._boundEvents.push([this.canvas, type, fn, opts]);
    };

    const isMatchingPointer = (drag, e) =>
      drag.pointerId === undefined || e?.pointerId === undefined || e.pointerId === drag.pointerId;

    addListener('pointerdown', (e) => {
      if (this._drag) return;
      if (!Number.isFinite(e?.clientX) || !Number.isFinite(e?.clientY)) return;
      const rect = this.canvas.getBoundingClientRect?.();
      if (rect && (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || (rect.width !== undefined && !Number.isFinite(rect.width)) || (rect.height !== undefined && !Number.isFinite(rect.height)))) {
        return;
      }
      const wantsPin = this.scene.pinMode || e.ctrlKey || e.altKey;
      if (wantsPin && e.button === 0) {
        const hit = this.pickParticle(e.clientX, e.clientY);
        if (hit) {
          this._drag = {
            mode: 'pin',
            pointerId: e?.pointerId,
            particleIndex: hit.particleIndex,
            lastX: e.clientX,
            lastY: e.clientY,
            moved: false,
          };
          this.canvas.setPointerCapture?.(e.pointerId);
          return;
        }
      }

      const mode = e.shiftKey || e.button === 1 || e.button === 2 ? 'pan' : 'orbit';
      this._drag = {
        mode,
        pointerId: e?.pointerId,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      this.canvas.setPointerCapture?.(e.pointerId);
    });

    addListener('pointermove', (e) => {
      if (!this._drag) return;
      if (!isMatchingPointer(this._drag, e)) return;
      if (!Number.isFinite(e?.clientX) || !Number.isFinite(e?.clientY)) return;
      const dx = e.clientX - this._drag.lastX;
      const dy = e.clientY - this._drag.lastY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      this._drag.lastX = e.clientX;
      this._drag.lastY = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 1) this._drag.moved = true;

      if (this._drag.mode === 'pin') {
        this.movePinnedParticle(this._drag.particleIndex, dx, dy);
        this.callbacks.onPinChange?.(this._drag.particleIndex);
        this.render();
      } else if (this._drag.mode === 'orbit') {
        const nextYaw = this.cam.yaw - dx * 0.008;
        const nextPitch = clamp(this.cam.pitch + dy * 0.008, -1.42, 1.42);
        if (!Number.isFinite(nextYaw) || !Number.isFinite(nextPitch)) return;
        this.cam.yaw = nextYaw;
        this.cam.pitch = nextPitch;
        this._markDirty();
        this.render();
      } else if (this._drag.mode === 'pan') {
        const scale = this.cam.distance * 0.0014;
        const rightX = Math.cos(this.cam.yaw);
        const rightZ = -Math.sin(this.cam.yaw);
        const nextTx = this.cam.target.x - rightX * dx * scale;
        const nextTz = this.cam.target.z - rightZ * dx * scale;
        const nextTy = this.cam.target.y + dy * scale;
        if (!Number.isFinite(nextTx) || !Number.isFinite(nextTy) || !Number.isFinite(nextTz)) return;
        this.cam.target.x = nextTx;
        this.cam.target.z = nextTz;
        this.cam.target.y = nextTy;
        this._markDirty();
        this.render();
      }
    });

    const endDrag = (e) => {
      if (!this._drag) return;
      if (!isMatchingPointer(this._drag, e)) return;
      if (this._drag.mode === 'pin' && !this._drag.moved) {
        this.togglePinParticle(this._drag.particleIndex);
        this.callbacks.onPinChange?.(this._drag.particleIndex);
        this.render();
      }
      this._drag = null;
      try {
        this.canvas.releasePointerCapture?.(e?.pointerId);
      } catch {
        // ignore
      }
    };

    const cancelDrag = (e) => {
      if (!this._drag) return;
      if (!isMatchingPointer(this._drag, e)) return;
      this._drag = null;
      try {
        this.canvas.releasePointerCapture?.(e?.pointerId);
      } catch {
        // ignore
      }
    };

    addListener('pointerup', endDrag);
    addListener('pointercancel', cancelDrag);

    addListener(
      'wheel',
      (e) => {
        e?.preventDefault?.();
        if (!Number.isFinite(e?.deltaY)) return;
        const factor = e.deltaY < 0 ? 0.9 : 1.11;
        const nextDistance = clamp(this.cam.distance * factor, 80, 4500);
        if (!Number.isFinite(nextDistance)) return;
        this.cam.distance = nextDistance;
        this._markDirty();
        this.render();
      },
      { passive: false }
    );

    addListener('contextmenu', (e) => e?.preventDefault?.());

    addListener('webglcontextlost', (e) => {
      e?.preventDefault?.();
      if (this.mode !== 'webgl2' && !this.gl) return;
      this._contextLost = true;
      this._drag = null;
      this._stlCacheRef = null;
      this._avatarCacheRef = null;
      this._materialSig = '';
    });

    addListener('webglcontextrestored', () => {
      if (this._disposed) return;
      if (this.mode !== 'webgl2' && !this.gl) return;
      this._stlCacheRef = null;
      this._avatarCacheRef = null;
      this._materialSig = '';
      if ((!this.gl || this.gl.isContextLost?.()) && this.canvas?.getContext) {
        try {
          this.gl = this.canvas.getContext('webgl2', this._contextOptions) || this.gl;
        } catch {
          // keep existing reference
        }
      }
      if (this.gl && !this.gl.isContextLost?.()) {
        try {
          this._contextLost = false;
          this._initGL();
          this.mode = 'webgl2';
          if (this.scene.materialConfig) {
            this.updateMaterialMaps(this.scene.materialConfig);
          }
          if (this.scene.stlMesh) {
            this._stlCacheRef = this.scene.stlMesh;
            this._uploadSTLMesh(this.scene.stlMesh);
          }
          if (this.scene.avatar) {
            this._avatarCacheRef = this.scene.avatar;
            this._uploadAvatar(this.scene.avatar);
          }
          this.gl.viewport(0, 0, this.canvas.width || 1, this.canvas.height || 1);
          this._markDirty();
          return;
        } catch {
          this._contextLost = true;
          this._disposeGLResources();
          const prevCanvas = this.canvas;
          this._activate2DFallback(prevCanvas);
          if (this.mode === '2d') {
            this._contextLost = false;
            if (this.canvas && this.canvas !== prevCanvas) {
              if (Array.isArray(this._boundEvents)) {
                for (const [target, type, fn, opts] of this._boundEvents) {
                  target?.removeEventListener?.(type, fn, opts);
                }
                this._boundEvents = [];
              }
              this._bindEvents();
            }
          } else {
            this.mode = 'none';
          }
          this._markDirty();
          return;
        }
      }
      this._contextLost = true;
    });
  }

  _buildClothBuffers(sim) {
    const gl = this.gl;
    const particles = sim.particles || [];
    const triangles = sim.triangles || [];
    const n = particles.length;
    const pos = new Float32Array(n * 3);
    const norm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const strain = new Float32Array(n * 3);
    const sel = new Float32Array(n);

    const tileMm = clamp((this.scene.materialConfig?.threadScaleMm || 1.4) * 18, 12, 180);
    const selId = this.scene.selectedPieceId;

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      pos[i * 3] = p.pos.x;
      pos[i * 3 + 1] = p.pos.y;
      pos[i * 3 + 2] = p.pos.z;
      uv[i * 2] = (p.rest2D?.x || 0) / tileMm;
      uv[i * 2 + 1] = (p.rest2D?.y || 0) / tileMm;
      const c = p.color || [0.22, 0.72, 0.56];
      strain[i * 3] = c[0];
      strain[i * 3 + 1] = c[1];
      strain[i * 3 + 2] = c[2];
      sel[i] = selId && p.pieceId === selId ? 1.0 : 0.0;
    }

    const indices = new Uint32Array(triangles.length * 3);
    const wireIndices = this.scene.showWire ? new Uint32Array(triangles.length * 6) : null;

    for (let t = 0; t < triangles.length; t++) {
      const [ia, ib, ic] = triangles[t];
      indices[t * 3] = ia;
      indices[t * 3 + 1] = ib;
      indices[t * 3 + 2] = ic;
      if (wireIndices) {
        wireIndices[t * 6] = ia;
        wireIndices[t * 6 + 1] = ib;
        wireIndices[t * 6 + 2] = ib;
        wireIndices[t * 6 + 3] = ic;
        wireIndices[t * 6 + 4] = ic;
        wireIndices[t * 6 + 5] = ia;
      }

      const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
      const bx = pos[ib * 3] - ax, by = pos[ib * 3 + 1] - ay, bz = pos[ib * 3 + 2] - az;
      const cx = pos[ic * 3] - ax, cy = pos[ic * 3 + 1] - ay, cz = pos[ic * 3 + 2] - az;
      const nx = by * cz - bz * cy;
      const ny = bz * cx - bx * cz;
      const nz = bx * cy - by * cx;
      norm[ia * 3] += nx; norm[ia * 3 + 1] += ny; norm[ia * 3 + 2] += nz;
      norm[ib * 3] += nx; norm[ib * 3 + 1] += ny; norm[ib * 3 + 2] += nz;
      norm[ic * 3] += nx; norm[ic * 3 + 1] += ny; norm[ic * 3 + 2] += nz;
    }

    for (let i = 0; i < n; i++) {
      const nx = norm[i * 3], ny = norm[i * 3 + 1], nz = norm[i * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-6) {
        norm[i * 3] = nx / len;
        norm[i * 3 + 1] = ny / len;
        norm[i * 3 + 2] = nz / len;
      } else {
        norm[i * 3 + 1] = 1;
      }
    }

    gl.bindVertexArray(this._buf.clothVao);
    const bindDynamic = (buf, name, data, size) => {
      const loc = gl.getAttribLocation(this._progs.cloth, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      }
    };
    bindDynamic(this._buf.clothPos, 'aPos', pos, 3);
    bindDynamic(this._buf.clothNorm, 'aNormal', norm, 3);
    bindDynamic(this._buf.clothUv, 'aUv', uv, 2);
    bindDynamic(this._buf.clothStrain, 'aStrainColor', strain, 3);
    bindDynamic(this._buf.clothSel, 'aSelected', sel, 1);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._buf.clothEbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);

    if (wireIndices) {
      gl.bindVertexArray(this._buf.clothWireVao);
      const wirePosLoc = gl.getAttribLocation(this._progs.wire, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf.clothPos);
      if (wirePosLoc >= 0) {
        gl.enableVertexAttribArray(wirePosLoc);
        gl.vertexAttribPointer(wirePosLoc, 3, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._buf.clothWireEbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndices, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
    }

    return { triIndexCount: indices.length, wireIndexCount: wireIndices ? wireIndices.length : 0 };
  }

  _renderWebGL2() {
    if (this._isContextUnavailable()) return;
    const gl = this.gl;
    const { eye, viewProj } = this._getCameraMatrices();
    const { sim, avatar, stlMesh, materialConfig, showStrainMap, showForm, showWire, showThreads } = this.scene;

    if (stlMesh && stlMesh !== this._stlCacheRef) {
      this._stlCacheRef = stlMesh;
      this._uploadSTLMesh(stlMesh);
    }
    if (avatar && avatar !== this._avatarCacheRef) {
      this._avatarCacheRef = avatar;
      this._uploadAvatar(avatar);
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.043, 0.063, 0.094, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.lastRenderStats.mode = 'webgl2';
    this.lastRenderStats.renderedStlTriangles = 0;
    this.lastRenderStats.renderedClothTriangles = 0;
    this.lastRenderStats.renderedAvatarTriangles = 0;
    this.lastRenderStats.drawCalls = 0;

    // Pass 1: Grid
    gl.useProgram(this._progs.grid);
    gl.uniformMatrix4fv(gl.getUniformLocation(this._progs.grid, 'uViewProj'), false, viewProj);
    gl.bindVertexArray(this._buf.gridVao);
    gl.drawArrays(gl.LINES, 0, this._buf.gridCount);
    this._recordDrawCall();

    // Pass 2: 100% STL Mesh OR Articulated Dress-Form Avatar
    if (showForm) {
      gl.useProgram(this._progs.solid);
      gl.uniformMatrix4fv(gl.getUniformLocation(this._progs.solid, 'uViewProj'), false, viewProj);
      gl.uniform3f(gl.getUniformLocation(this._progs.solid, 'uCamPos'), eye.x, eye.y, eye.z);
      gl.uniform1f(gl.getUniformLocation(this._progs.solid, 'uAlpha'), 1.0);

      if (stlMesh && this._stlTriCount > 0) {
        gl.bindVertexArray(this._buf.stlVao);
        gl.drawArrays(gl.TRIANGLES, 0, this._stlTriCount * 3);
        this.lastRenderStats.renderedStlTriangles = this._stlTriCount;
        this._recordDrawCall();
      } else if (avatar && this._avatarVertCount > 0) {
        gl.bindVertexArray(this._buf.avatarVao);
        gl.drawArrays(gl.TRIANGLES, 0, this._avatarVertCount);
        this.lastRenderStats.renderedAvatarTriangles = Math.floor(this._avatarVertCount / 3);
        this._recordDrawCall();
      }
    }

    // Pass 3: Draped Cloth PBR / Strain
    if (sim && Array.isArray(sim.triangles) && sim.triangles.length > 0) {
      const { triIndexCount, wireIndexCount } = this._buildClothBuffers(sim);
      const p = this._progs.cloth;
      gl.useProgram(p);
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uViewProj'), false, viewProj);
      gl.uniform3f(gl.getUniformLocation(p, 'uCamPos'), eye.x, eye.y, eye.z);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._tex.albedo);
      gl.uniform1i(gl.getUniformLocation(p, 'uAlbedoMap'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._tex.normal);
      gl.uniform1i(gl.getUniformLocation(p, 'uNormalMap'), 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._tex.roughness);
      gl.uniform1i(gl.getUniformLocation(p, 'uRoughnessMap'), 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._tex.ao);
      gl.uniform1i(gl.getUniformLocation(p, 'uAoMap'), 3);

      gl.uniform1f(gl.getUniformLocation(p, 'uNormalStrength'), materialConfig?.normal ?? 0.6);
      gl.uniform1f(gl.getUniformLocation(p, 'uRoughness'), materialConfig?.roughness ?? 0.72);
      gl.uniform1f(gl.getUniformLocation(p, 'uMetallic'), materialConfig?.metallic ?? 0.0);
      gl.uniform1f(gl.getUniformLocation(p, 'uAoStrength'), materialConfig?.ao ?? 0.55);
      gl.uniform1f(gl.getUniformLocation(p, 'uSheen'), materialConfig?.sheen ?? 0.25);
      gl.uniform1f(gl.getUniformLocation(p, 'uShowStrainMap'), showStrainMap ? 1.0 : 0.0);

      gl.bindVertexArray(this._buf.clothVao);
      gl.drawElements(gl.TRIANGLES, triIndexCount, gl.UNSIGNED_INT, 0);
      this.lastRenderStats.renderedClothTriangles = sim.triangles.length;
      this._recordDrawCall();

      if (showWire && wireIndexCount > 0) {
        gl.useProgram(this._progs.wire);
        gl.uniformMatrix4fv(gl.getUniformLocation(this._progs.wire, 'uViewProj'), false, viewProj);
        gl.uniform4f(gl.getUniformLocation(this._progs.wire, 'uColor'), 0.85, 0.90, 0.96, 0.72);
        gl.bindVertexArray(this._buf.clothWireVao);
        gl.drawElements(gl.LINES, wireIndexCount, gl.UNSIGNED_INT, 0);
        this._recordDrawCall();
      }
      gl.bindVertexArray(null);
    }

    // Pass 4: 3D Sewing Seam Threads, Avatar Circumference Tape Rings & Pinned Particle Handles
    const overlayProg = this._progs.overlay;
    gl.useProgram(overlayProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(overlayProg, 'uViewProj'), false, viewProj);

    const lineVerts = [];
    if (showThreads && sim && Array.isArray(sim.sewingConstraints)) {
      for (const sew of sim.sewingConstraints) {
        const pa = sim.particles[sew.a];
        const pb = sim.particles[sew.b];
        if (!pa || !pb) continue;
        lineVerts.push(pa.pos.x, pa.pos.y, pa.pos.z, 0.22, 0.84, 0.98);
        lineVerts.push(pb.pos.x, pb.pos.y, pb.pos.z, 0.98, 0.78, 0.25);
      }
    }

    if (showForm && !stlMesh && avatar?.measurements) {
      const m = avatar.measurements;
      const hScale = (m.heightMm || 1750) / 1750;
      const rings = [
        { y: 205 * hScale, rx: (m.chestMm || 980) / (2 * Math.PI) * 1.15, rz: (m.chestMm || 980) / (2 * Math.PI) * 0.85 },
        { y: 35 * hScale, rx: (m.waistMm || 820) / (2 * Math.PI) * 1.15, rz: (m.waistMm || 820) / (2 * Math.PI) * 0.85 },
        { y: -135 * hScale, rx: (m.hipMm || 1000) / (2 * Math.PI) * 1.15, rz: (m.hipMm || 1000) / (2 * Math.PI) * 0.85 },
      ];
      for (const r of rings) {
        for (let k = 0; k < 28; k++) {
          const a0 = (k / 28) * Math.PI * 2;
          const a1 = ((k + 1) / 28) * Math.PI * 2;
          lineVerts.push(Math.cos(a0) * r.rx, r.y, Math.sin(a0) * r.rz, 0.12, 0.14, 0.18);
          lineVerts.push(Math.cos(a1) * r.rx, r.y, Math.sin(a1) * r.rz, 0.12, 0.14, 0.18);
        }
      }
    }

    if (lineVerts.length > 0) {
      const lineData = new Float32Array(lineVerts);
      gl.bindVertexArray(this._buf.overlayVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf.overlayVbo);
      gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
      const aPos = gl.getAttribLocation(overlayProg, 'aPos');
      const aCol = gl.getAttribLocation(overlayProg, 'aColor');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
      gl.uniform1f(gl.getUniformLocation(overlayProg, 'uIsPoints'), 0.0);
      gl.uniform1f(gl.getUniformLocation(overlayProg, 'uPointSize'), 1.0);
      gl.drawArrays(gl.LINES, 0, lineData.length / 6);
      this._recordDrawCall();
    }

    // Pinned particles
    if (sim && Array.isArray(sim.particles)) {
      const pinVerts = [];
      for (const p of sim.particles) {
        if (p.invMass <= 0) {
          pinVerts.push(p.pos.x, p.pos.y, p.pos.z, 0.98, 0.32, 0.72);
        }
      }
      if (pinVerts.length > 0) {
        const pinData = new Float32Array(pinVerts);
        gl.bindVertexArray(this._buf.overlayVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buf.overlayVbo);
        gl.bufferData(gl.ARRAY_BUFFER, pinData, gl.DYNAMIC_DRAW);
        const aPos = gl.getAttribLocation(overlayProg, 'aPos');
        const aCol = gl.getAttribLocation(overlayProg, 'aColor');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
        gl.uniform1f(gl.getUniformLocation(overlayProg, 'uIsPoints'), 1.0);
        gl.uniform1f(gl.getUniformLocation(overlayProg, 'uPointSize'), 11.0);
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.POINTS, 0, pinData.length / 6);
        gl.enable(gl.DEPTH_TEST);
        this._recordDrawCall();
      }
    }

    gl.bindVertexArray(null);
  }

  _render2DFallback() {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const w = this.cssWidth;
    const h = this.cssHeight;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b1018';
    ctx.fillRect(0, 0, w, h);

    const { viewProj } = this._getCameraMatrices();
    const { sim, avatar, stlMesh, materialConfig, showStrainMap, showForm, showWire, showThreads } = this.scene;
    const drawList = [];

    const lightDir = { x: 0.45, y: 0.75, z: 0.48 };
    const lLen = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
    lightDir.x /= lLen; lightDir.y /= lLen; lightDir.z /= lLen;

    const pushTri = (a, b, c, baseRgb, strokeColor = null) => {
      const pa = this._projectPoint(a, viewProj);
      const pb = this._projectPoint(b, viewProj);
      const pc = this._projectPoint(c, viewProj);
      if (!pa || !pb || !pc) return;
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
      const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const ndotl = Math.abs(nx * lightDir.x + ny * lightDir.y + nz * lightDir.z);
      const shade = 0.35 + 0.65 * ndotl;
      const r = Math.min(255, Math.round(baseRgb[0] * shade));
      const g = Math.min(255, Math.round(baseRgb[1] * shade));
      const bl = Math.min(255, Math.round(baseRgb[2] * shade));
      drawList.push({
        depth: (pa.ndcZ + pb.ndcZ + pc.ndcZ) / 3,
        pa,
        pb,
        pc,
        fill: `rgb(${r},${g},${bl})`,
        stroke: strokeColor,
      });
    };

    let stlCount = 0;
    let avatarCount = 0;
    if (showForm) {
      if (stlMesh && Array.isArray(stlMesh.faces) && Array.isArray(stlMesh.vertices)) {
        // Render 100% of STL faces (zero stride decimation)
        for (let i = 0; i < stlMesh.faces.length; i++) {
          const f = stlMesh.faces[i];
          const va = stlMesh.vertices[f.indices[0]];
          const vb = stlMesh.vertices[f.indices[1]];
          const vc = stlMesh.vertices[f.indices[2]];
          if (va && vb && vc) {
            pushTri(va, vb, vc, [130, 152, 184], showWire ? 'rgba(200,220,255,0.2)' : null);
            stlCount++;
          }
        }
      } else if (avatar && Array.isArray(avatar.triangles) && Array.isArray(avatar.vertices)) {
        for (let i = 0; i < avatar.triangles.length; i++) {
          const [ia, ib, ic] = avatar.triangles[i];
          const va = avatar.vertices[ia];
          const vb = avatar.vertices[ib];
          const vc = avatar.vertices[ic];
          if (va && vb && vc) {
            pushTri(va, vb, vc, [120, 114, 108]);
            avatarCount++;
          }
        }
      }
    }

    let clothCount = 0;
    const rawHex = String(materialConfig?.warpColor || '#2b5b84').trim().replace('#', '');
    const baseHex = /^[0-9a-f]{3}$/i.test(rawHex)
      ? rawHex.split('').map((c) => c + c).join('')
      : rawHex;
    const hexNum = /^[0-9a-f]{6}$/i.test(baseHex) ? parseInt(baseHex, 16) : NaN;
    const clothRgb = Number.isFinite(hexNum)
      ? [(hexNum >> 16) & 255, (hexNum >> 8) & 255, hexNum & 255]
      : [56, 145, 200];

    if (sim && Array.isArray(sim.triangles) && Array.isArray(sim.particles)) {
      for (let i = 0; i < sim.triangles.length; i++) {
        const [ia, ib, ic] = sim.triangles[i];
        const pa = sim.particles[ia];
        const pb = sim.particles[ib];
        const pc = sim.particles[ic];
        if (!pa || !pb || !pc) continue;
        let rgb = clothRgb;
        if (showStrainMap && pa.color && pb.color && pc.color) {
          rgb = [
            Math.round(((pa.color[0] + pb.color[0] + pc.color[0]) / 3) * 255),
            Math.round(((pa.color[1] + pb.color[1] + pc.color[1]) / 3) * 255),
            Math.round(((pa.color[2] + pb.color[2] + pc.color[2]) / 3) * 255),
          ];
        }
        pushTri(pa.pos, pb.pos, pc.pos, rgb, showWire ? 'rgba(226,232,240,0.28)' : null);
        clothCount++;
      }
    }

    drawList.sort((a, b) => b.depth - a.depth);
    for (const item of drawList) {
      ctx.beginPath();
      ctx.moveTo(item.pa.sx, item.pa.sy);
      ctx.lineTo(item.pb.sx, item.pb.sy);
      ctx.lineTo(item.pc.sx, item.pc.sy);
      ctx.closePath();
      ctx.fillStyle = item.fill;
      ctx.fill();
      if (item.stroke) {
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }

    if (showThreads && sim && Array.isArray(sim.sewingConstraints)) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.1;
      for (const sew of sim.sewingConstraints) {
        const pa = sim.particles[sew.a];
        const pb = sim.particles[sew.b];
        if (!pa || !pb) continue;
        const sa = this._projectPoint(pa.pos, viewProj);
        const sb = this._projectPoint(pb.pos, viewProj);
        if (!sa || !sb) continue;
        ctx.beginPath();
        ctx.moveTo(sa.sx, sa.sy);
        ctx.lineTo(sb.sx, sb.sy);
        ctx.stroke();
      }
    }

    if (sim && Array.isArray(sim.particles)) {
      ctx.fillStyle = '#f472b6';
      for (const p of sim.particles) {
        if (p.invMass <= 0) {
          const sp = this._projectPoint(p.pos, viewProj);
          if (sp) {
            ctx.beginPath();
            ctx.arc(sp.sx, sp.sy, 4.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    this.lastRenderStats = {
      mode: '2d',
      renderedStlTriangles: stlCount,
      renderedClothTriangles: clothCount,
      renderedAvatarTriangles: avatarCount,
      drawCalls: drawList.length + 1,
    };
    ctx.restore();
  }

  render() {
    if (this._disposed) return this.lastRenderStats;
    if (this.mode === 'webgl2') {
      this._renderWebGL2();
    } else if (this.mode === '2d') {
      this._render2DFallback();
    }
    this._dirty = false;
    return this.lastRenderStats;
  }

  _disposeGLResources() {
    const gl = this.gl;
    if (gl && !gl.isContextLost?.()) {
      gl.bindVertexArray?.(null);
      for (const p of Object.values(this._progs || {})) {
        if (p) gl.deleteProgram?.(p);
      }
      for (const t of Object.values(this._tex || {})) {
        if (t) gl.deleteTexture?.(t);
      }
      if (this._buf) {
        const vaoKeys = ['gridVao', 'stlVao', 'avatarVao', 'clothVao', 'clothWireVao', 'overlayVao'];
        const bufKeys = [
          'gridVbo',
          'stlPos',
          'stlNorm',
          'stlCol',
          'avatarPos',
          'avatarNorm',
          'avatarCol',
          'clothPos',
          'clothNorm',
          'clothUv',
          'clothStrain',
          'clothSel',
          'clothEbo',
          'clothWireEbo',
          'overlayVbo',
        ];
        for (const k of vaoKeys) {
          if (this._buf[k]) gl.deleteVertexArray?.(this._buf[k]);
        }
        for (const k of bufKeys) {
          if (this._buf[k]) gl.deleteBuffer?.(this._buf[k]);
        }
      }
    }
    this._progs = null;
    this._tex = null;
    this._buf = null;
    this._stlCacheRef = null;
    this._avatarCacheRef = null;
    this.gl = null;
  }

  dispose() {
    this._disposed = true;
    this._drag = null;
    if (this._rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (Array.isArray(this._boundEvents)) {
      for (const [target, type, fn, opts] of this._boundEvents) {
        target?.removeEventListener?.(type, fn, opts);
      }
      this._boundEvents = [];
    }
    this._disposeGLResources();
    this.ctx2d = null;
  }
}

// ============================================================================
// Three.js Hardware-Accelerated Studio PBR 3D Garment & Form Viewport
// ============================================================================

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function projectOutsideAvatarRenderSafe(avatar, xIn, yIn, zIn, marginMm = 2.6) {
  let px = xIn;
  let py = yIn;
  let pz = zIn;
  const st = avatar?.torsoStations;
  if (Array.isArray(st) && st.length >= 2) {
    const n = st.length;
    const yMin = st[0].y;
    const yMax = st[n - 1].y;
    if (py >= yMin - marginMm && py <= yMax + marginMm) {
      const yc = clampNum(py, yMin, yMax);
      let lo = 0;
      let hi = n - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (st[mid].y <= yc) lo = mid;
        else hi = mid;
      }
      const a = st[lo];
      const b = st[hi];
      const t = b.y > a.y ? clampNum((yc - a.y) / (b.y - a.y), 0, 1) : 0;
      const rx = Math.max(2, a.rx + (b.rx - a.rx) * t + marginMm);
      const rz = Math.max(2, a.rz + (b.rz - a.rz) * t + marginMm);
      const cz = a.cz + (b.cz - a.cz) * t;
      const dx = px / rx;
      const dz = (pz - cz) / rz;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.0 && d2 > 1e-8) {
        const inv = 1 / Math.sqrt(d2);
        px = dx * inv * rx;
        pz = cz + dz * inv * rz;
      }
    }
  }
  const caps = avatar?.capsules;
  if (Array.isArray(caps)) {
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i];
      const abx = c.b.x - c.a.x;
      const aby = c.b.y - c.a.y;
      const abz = c.b.z - c.a.z;
      const abSq = abx * abx + aby * aby + abz * abz;
      const t = abSq > 1e-6 ? clampNum(((px - c.a.x) * abx + (py - c.a.y) * aby + (pz - c.a.z) * abz) / abSq, 0, 1) : 0;
      const qx = c.a.x + abx * t;
      const qy = c.a.y + aby * t;
      const qz = c.a.z + abz * t;
      const r = Math.max(2, c.rA + (c.rB - c.rA) * t + marginMm);
      const vx = px - qx;
      const vy = py - qy;
      const vz = pz - qz;
      const dSq = vx * vx + vy * vy + vz * vz;
      if (dSq < r * r && dSq > 1e-8) {
        const s = r / Math.sqrt(dSq);
        px = qx + vx * s;
        py = qy + vy * s;
        pz = qz + vz * s;
      }
    }
  }
  return { x: px, y: py, z: pz };
}

function buildBackdropTexture() {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const r2 = Math.min(1.35, nx * nx * 0.65 + (ny - 0.08) * (ny - 0.08) * 0.75);
      const t = clampNum(1 - r2 * 0.72, 0, 1);
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(18 + 20 * t);
      data[idx + 1] = Math.round(22 + 23 * t);
      data[idx + 2] = Math.round(30 + 28 * t);
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildCapsuleBufferGeometry(cap, radSeg = 36, capSeg = 8) {
  const a = cap.a;
  const b = cap.b;
  const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const L = ab.length();
  if (L < 1e-4) return new THREE.BufferGeometry();
  const axis = ab.clone().divideScalar(L);
  const refUp = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(axis, refUp).normalize();
  const t2 = new THREE.Vector3().crossVectors(axis, t1).normalize();

  const rings = [];
  for (let k = capSeg; k >= 1; k--) {
    const phi = (k / capSeg) * (Math.PI * 0.5);
    rings.push({
      c: new THREE.Vector3(a.x, a.y, a.z).addScaledVector(axis, -Math.sin(phi) * cap.rA),
      r: Math.max(0.25, Math.cos(phi) * cap.rA),
    });
  }
  const bodySteps = 10;
  for (let k = 0; k <= bodySteps; k++) {
    const u = k / bodySteps;
    rings.push({
      c: new THREE.Vector3(a.x + ab.x * u, a.y + ab.y * u, a.z + ab.z * u),
      r: cap.rA + (cap.rB - cap.rA) * u,
    });
  }
  for (let k = 1; k <= capSeg; k++) {
    const phi = (k / capSeg) * (Math.PI * 0.5);
    rings.push({
      c: new THREE.Vector3(b.x, b.y, b.z).addScaledVector(axis, Math.sin(phi) * cap.rB),
      r: Math.max(0.25, Math.cos(phi) * cap.rB),
    });
  }

  const positions = [];
  const indices = [];
  const cols = radSeg + 1;
  for (let ri = 0; ri < rings.length; ri++) {
    const rg = rings[ri];
    for (let j = 0; j <= radSeg; j++) {
      const ang = (j / radSeg) * Math.PI * 2;
      const ca = Math.cos(ang) * rg.r;
      const sa = Math.sin(ang) * rg.r;
      positions.push(
        rg.c.x + t1.x * ca + t2.x * sa,
        rg.c.y + t1.y * ca + t2.y * sa,
        rg.c.z + t1.z * ca + t2.z * sa
      );
    }
  }
  for (let ri = 0; ri < rings.length - 1; ri++) {
    const row0 = ri * cols;
    const row1 = (ri + 1) * cols;
    for (let j = 0; j < radSeg; j++) {
      const i0 = row0 + j;
      const i1 = row0 + j + 1;
      const i2 = row1 + j + 1;
      const i3 = row1 + j;
      indices.push(i0, i2, i1, i0, i3, i2);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export class ThreeStudioViewport3D {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.cssWidth = Math.max(100, canvas?.clientWidth || canvas?.width || 640);
    this.cssHeight = Math.max(100, canvas?.clientHeight || canvas?.height || 480);
    this.dpr = 1;
    this.mode = 'webgl2';
    this._disposed = false;
    this._boundEvents = [];
    this._pinDrag = null;

    this.scene = {
      sim: null,
      avatar: null,
      stlMesh: null,
      materialConfig: null,
      showStrainMap: false,
      showForm: true,
      showWire: false,
      showThreads: false,
      selectedPieceId: null,
      pinMode: false,
    };

    this.lastRenderStats = {
      mode: 'webgl2',
      renderedStlTriangles: 0,
      renderedClothTriangles: 0,
      renderedAvatarTriangles: 0,
      drawCalls: 0,
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    if (typeof window !== 'undefined') {
      window.__psv2WebGLContexts = (window.__psv2WebGLContexts || 0) + 1;
      window.__psv2WebGLDraws = window.__psv2WebGLDraws || 0;
    }

    this.threeScene = new THREE.Scene();
    this._backdropTex = buildBackdropTexture();
    this.threeScene.background = this._backdropTex;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this._envRT = pmrem.fromScene(roomEnv, 0.04);
    this.threeScene.environment = this._envRT.texture;
    this.threeScene.environmentIntensity = 0.34;
    roomEnv.dispose();
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(36, this.cssWidth / Math.max(1, this.cssHeight), 8, 12000);
    this.camera.position.set(340, 210, 960);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.target.set(0, 95, 0);
    this.controls.minDistance = 90;
    this.controls.maxDistance = 4800;
    this.controls.update();
    this.controls.addEventListener('change', () => {
      if (!this._disposed) this.render();
    });

    // Studio 3-point lighting rig
    const hemi = new THREE.HemisphereLight(0xe6eef8, 0x242a34, 0.65);
    this.threeScene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfffaf2, 1.48);
    keyLight.position.set(480, 860, 680);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 120;
    keyLight.shadow.camera.far = 3200;
    keyLight.shadow.camera.left = -850;
    keyLight.shadow.camera.right = 850;
    keyLight.shadow.camera.top = 850;
    keyLight.shadow.camera.bottom = -1050;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 1.5;
    this.threeScene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xaac8f0, 0.58);
    rimLight.position.set(-540, 460, -560);
    this.threeScene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0xdce4f0, 0.28);
    fillLight.position.set(-280, -180, 520);
    this.threeScene.add(fillLight);

    // Studio floor pedestal + tailoring scale rings
    this.floorGroup = new THREE.Group();
    const floorDisc = new THREE.Mesh(
      new THREE.CircleGeometry(960, 72),
      new THREE.MeshStandardMaterial({
        color: 0x181c24,
        roughness: 0.92,
        metalness: 0.04,
      })
    );
    floorDisc.rotation.x = -Math.PI * 0.5;
    floorDisc.receiveShadow = true;
    this.floorGroup.add(floorDisc);

    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(960, 72),
      new THREE.ShadowMaterial({ opacity: 0.34 })
    );
    shadowCatcher.rotation.x = -Math.PI * 0.5;
    shadowCatcher.position.y = 0.4;
    shadowCatcher.receiveShadow = true;
    this.floorGroup.add(shadowCatcher);

    const ringPts = [];
    for (const rad of [200, 400, 600, 850]) {
      const segs = 96;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        ringPts.push(Math.cos(a0) * rad, 0.8, Math.sin(a0) * rad);
        ringPts.push(Math.cos(a1) * rad, 0.8, Math.sin(a1) * rad);
      }
    }
    ringPts.push(-880, 0.8, 0, 880, 0.8, 0, 0, 0.8, -880, 0, 0.8, 880);
    const ringGeom = new THREE.BufferGeometry();
    ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
    const ringLines = new THREE.LineSegments(
      ringGeom,
      new THREE.LineBasicMaterial({ color: 0x3b4658, transparent: true, opacity: 0.42 })
    );
    this.floorGroup.add(ringLines);
    this.floorGroup.position.y = -840;
    this.threeScene.add(this.floorGroup);

    // Scene groups
    this.avatarGroup = new THREE.Group();
    this.stlGroup = new THREE.Group();
    this.clothGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.threeScene.add(this.avatarGroup, this.stlGroup, this.clothGroup, this.overlayGroup);

    // Cloth material & meshes
    this._pbrTextures = { albedo: null, normal: null, roughness: null, ao: null };
    this._materialSig = '';
    this.clothMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.0,
      sheen: 0.55,
      sheenRoughness: 0.62,
      sheenColor: new THREE.Color(0xdbe4f0),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.clothGeom = new THREE.BufferGeometry();
    this.clothMesh = new THREE.Mesh(this.clothGeom, this.clothMaterial);
    this.clothMesh.castShadow = true;
    this.clothMesh.receiveShadow = true;
    this.clothMesh.frustumCulled = false;
    this.clothGroup.add(this.clothMesh);

    this.clothWireMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      wireframe: true,
      transparent: true,
      opacity: 0.2,
    });
    this.clothWireMesh = new THREE.Mesh(this.clothGeom, this.clothWireMat);
    this.clothWireMesh.visible = false;
    this.clothWireMesh.frustumCulled = false;
    this.clothGroup.add(this.clothWireMesh);

    // Topstitching & optional open-air sewing threads
    this.topstitchGeom = new THREE.BufferGeometry();
    this.topstitchMat = new THREE.LineBasicMaterial({
      color: 0xdbe4f0,
      transparent: true,
      opacity: 0.62,
    });
    this.topstitchLines = new THREE.LineSegments(this.topstitchGeom, this.topstitchMat);
    this.topstitchLines.frustumCulled = false;
    this.overlayGroup.add(this.topstitchLines);

    this.threadsGeom = new THREE.BufferGeometry();
    this.threadsMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.75,
    });
    this.threadsLines = new THREE.LineSegments(this.threadsGeom, this.threadsMat);
    this.threadsLines.visible = false;
    this.threadsLines.frustumCulled = false;
    this.overlayGroup.add(this.threadsLines);

    this.pinsGroup = new THREE.Group();
    this._pinSphereGeom = new THREE.SphereGeometry(4.8, 14, 10);
    this._pinSphereMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.25,
      metalness: 0.65,
    });
    this.overlayGroup.add(this.pinsGroup);

    this._avatarCacheRef = null;
    this._avatarTriCount = 0;
    this._stlCacheRef = null;
    this._stlTriCount = 0;
    this._clothTopoRef = null;
    this._clothTopoTriLen = -1;
    this._clothAdj = null;
    this._raycaster = new THREE.Raycaster();

    this._bindPinEvents();
  }

  _bindPinEvents() {
    if (!this.canvas || typeof this.canvas.addEventListener !== 'function') return;
    const onDown = (e) => {
      const wantsPin = this.scene.pinMode || e.ctrlKey || e.altKey;
      if (!wantsPin || e.button !== 0) return;
      const hit = this.pickParticle(e.clientX, e.clientY);
      if (!hit) return;
      e.stopImmediatePropagation();
      this.controls.enabled = false;
      this._pinDrag = {
        pointerId: e.pointerId,
        particleIndex: hit.particleIndex,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!this._pinDrag || (e.pointerId !== undefined && e.pointerId !== this._pinDrag.pointerId)) return;
      const dx = e.clientX - this._pinDrag.lastX;
      const dy = e.clientY - this._pinDrag.lastY;
      this._pinDrag.lastX = e.clientX;
      this._pinDrag.lastY = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 1) this._pinDrag.moved = true;
      this.movePinnedParticle(this._pinDrag.particleIndex, dx, dy);
      this.callbacks.onPinChange?.(this._pinDrag.particleIndex);
      this.render();
    };
    const onUp = (e) => {
      if (!this._pinDrag || (e.pointerId !== undefined && e.pointerId !== this._pinDrag.pointerId)) return;
      if (!this._pinDrag.moved) {
        this.togglePinParticle(this._pinDrag.particleIndex);
        this.callbacks.onPinChange?.(this._pinDrag.particleIndex);
      }
      this._pinDrag = null;
      this.controls.enabled = true;
      try {
        this.canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      this.render();
    };
    this.canvas.addEventListener('pointerdown', onDown, true);
    this.canvas.addEventListener('pointermove', onMove, true);
    this.canvas.addEventListener('pointerup', onUp, true);
    this.canvas.addEventListener('pointercancel', onUp, true);
    this._boundEvents.push(
      [this.canvas, 'pointerdown', onDown, true],
      [this.canvas, 'pointermove', onMove, true],
      [this.canvas, 'pointerup', onUp, true],
      [this.canvas, 'pointercancel', onUp, true]
    );
  }

  _makeDataTex(mapObj, isSrgb = false) {
    const tex = new THREE.DataTexture(mapObj.data, mapObj.width, mapObj.height, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 4);
    if (isSrgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  updateMaterialMaps(materialConfig) {
    if (!materialConfig) return;
    const sig = JSON.stringify({
      id: materialConfig.id,
      weaveType: materialConfig.weaveType,
      warpColor: materialConfig.warpColor,
      weftColor: materialConfig.weftColor,
      stitchColor: materialConfig.stitchColor,
      normal: materialConfig.normal,
      roughness: materialConfig.roughness,
      ao: materialConfig.ao,
      sheen: materialConfig.sheen,
      threadScaleMm: materialConfig.threadScaleMm,
    });
    if (sig === this._materialSig) return;
    this._materialSig = sig;

    for (const k of ['albedo', 'normal', 'roughness', 'ao']) {
      if (this._pbrTextures[k]) {
        this._pbrTextures[k].dispose();
        this._pbrTextures[k] = null;
      }
    }

    const maps = generateProceduralPBRMaps(materialConfig, 256);
    this._pbrTextures.albedo = this._makeDataTex(maps.albedo, true);
    this._pbrTextures.normal = this._makeDataTex(maps.normal, false);
    this._pbrTextures.roughness = this._makeDataTex(maps.roughness, false);
    this._pbrTextures.ao = this._makeDataTex(maps.ao, false);

    this.clothMaterial.map = this._pbrTextures.albedo;
    this.clothMaterial.normalMap = this._pbrTextures.normal;
    this.clothMaterial.roughnessMap = this._pbrTextures.roughness;
    this.clothMaterial.aoMap = this._pbrTextures.ao;
    const nScale = clampNum((materialConfig.normal ?? 0.55) * 1.15, 0.05, 1.8);
    this.clothMaterial.normalScale.set(nScale, nScale);
    this.clothMaterial.roughness = clampNum(materialConfig.roughness ?? 0.72, 0.08, 1.0);
    this.clothMaterial.metalness = clampNum(materialConfig.metallic ?? 0.0, 0.0, 0.5);
    this.clothMaterial.aoMapIntensity = clampNum(materialConfig.ao ?? 0.45, 0.0, 1.0);
    this.clothMaterial.sheen = clampNum(materialConfig.sheen ?? 0.52, 0.08, 1.0);
    this.clothMaterial.sheenRoughness = clampNum(0.35 + (materialConfig.roughness ?? 0.7) * 0.45, 0.2, 0.95);
    try {
      this.clothMaterial.sheenColor.set(materialConfig.weftColor || materialConfig.warpColor || '#dbe4f0');
    } catch {
      this.clothMaterial.sheenColor.set(0xdbe4f0);
    }
    try {
      this.topstitchMat.color.set(materialConfig.stitchColor || '#e2e8f0');
    } catch {
      this.topstitchMat.color.set(0xe2e8f0);
    }
    this.clothMaterial.needsUpdate = true;
    this._clothTopoTriLen = -1; // refresh UV scale
  }

  _clearGroup(grp) {
    while (grp.children.length > 0) {
      const ch = grp.children.pop();
      ch.geometry?.dispose?.();
      if (Array.isArray(ch.material)) ch.material.forEach((m) => m?.dispose?.());
      else ch.material?.dispose?.();
    }
  }

  _rebuildMannequin(avatar) {
    if (this._avatarCacheRef === avatar) return;
    this._avatarCacheRef = avatar;
    this._clearGroup(this.avatarGroup);
    this._avatarTriCount = 0;
    if (!avatar) return;

    const linenMat = new THREE.MeshPhysicalMaterial({
      color: 0xc5beb2,
      roughness: 0.78,
      metalness: 0.01,
      sheen: 0.25,
      sheenRoughness: 0.8,
      sheenColor: new THREE.Color(0xeae4da),
    });
    const limbMat = new THREE.MeshPhysicalMaterial({
      color: 0xbab3a7,
      roughness: 0.72,
      metalness: 0.02,
      sheen: 0.18,
      sheenRoughness: 0.82,
      sheenColor: new THREE.Color(0xe5dfd5),
    });
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x9aa3b0,
      roughness: 0.28,
      metalness: 0.82,
    });
    const tapeMat = new THREE.LineBasicMaterial({
      color: 0x2e323b,
      transparent: true,
      opacity: 0.72,
    });

    let triTotal = 0;
    const st = avatar.torsoStations;
    const bustG = avatar.bustGeometry;
    const evalBustSurfacePoint = (vx, vy, vz) => {
      if (!bustG?.isWomens || vz <= -10) return { x: vx, y: vy, z: vz };
      let bestZ = vz;
      const rB = bustG.rBust;
      const rSq = rB * rB;
      for (const side of [-1, 1]) {
        const cxB = side * bustG.xBustApex;
        const cyB = bustG.yBustApex;
        const czB = bustG.zBustCenter;
        const dx = vx - cxB;
        const dy = (vy - cyB) * 0.92;
        const d2 = dx * dx + dy * dy;
        if (d2 < rSq * 1.18) {
          const t = Math.max(0, 1 - d2 / (rSq * 1.18));
          // Smooth C2 cosine-bell mound matched to SDF bust sphere
          const lobeZ = czB + rB * Math.pow(t, 0.72);
          if (lobeZ > bestZ) {
            const blend = Math.min(1, t * 1.65);
            bestZ = bestZ + (lobeZ - bestZ) * blend;
          }
        }
      }
      return { x: vx, y: vy, z: bestZ };
    };

    if (Array.isArray(st) && st.length >= 2) {
      const radSeg = 72;
      const cols = radSeg + 1;
      const pos = [];
      const idx = [];
      for (let i = 0; i < st.length; i++) {
        const row = st[i];
        for (let j = 0; j <= radSeg; j++) {
          const ang = (j / radSeg) * Math.PI * 2;
          const rawX = Math.cos(ang) * row.rx;
          const rawZ = row.cz + Math.sin(ang) * row.rz;
          const pt = evalBustSurfacePoint(rawX, row.y, rawZ);
          pos.push(pt.x, pt.y, pt.z);
        }
      }
      for (let i = 0; i < st.length - 1; i++) {
        const r0 = i * cols;
        const r1 = (i + 1) * cols;
        for (let j = 0; j < radSeg; j++) {
          const a = r0 + j;
          const b = r0 + j + 1;
          const c = r1 + j + 1;
          const d = r1 + j;
          idx.push(a, c, b, a, d, c);
          triTotal += 2;
        }
      }
      // Top & bottom caps
      const botIdx = pos.length / 3;
      pos.push(0, st[0].y, st[0].cz);
      const topIdx = pos.length / 3;
      const topSt = st[st.length - 1];
      pos.push(0, topSt.y, topSt.cz);
      const lastRow = (st.length - 1) * cols;
      for (let j = 0; j < radSeg; j++) {
        idx.push(botIdx, j, j + 1);
        idx.push(topIdx, lastRow + j + 1, lastRow + j);
        triTotal += 2;
      }

      const torsoGeom = new THREE.BufferGeometry();
      torsoGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      torsoGeom.setIndex(idx);
      torsoGeom.computeVertexNormals();
      const torsoMesh = new THREE.Mesh(torsoGeom, linenMat);
      torsoMesh.castShadow = true;
      torsoMesh.receiveShadow = true;
      this.avatarGroup.add(torsoMesh);

      // Tailor's dress-form anatomical style-tape rings + CF/CB + Princess lines
      const hScale = avatar.armPose?.hScale ?? 1;
      const yAt = (yb) => 40 + (yb - 40) * hScale;
      const sampleAtY = (yVal) => {
        const yc = clampNum(yVal, st[0].y, st[st.length - 1].y);
        for (let k = 0; k < st.length - 1; k++) {
          if (st[k + 1].y >= yc) {
            const u = st[k + 1].y > st[k].y ? (yc - st[k].y) / (st[k + 1].y - st[k].y) : 0;
            return {
              rx: st[k].rx + (st[k + 1].rx - st[k].rx) * u + 0.65,
              rz: st[k].rz + (st[k + 1].rz - st[k].rz) * u + 0.65,
              cz: st[k].cz + (st[k + 1].cz - st[k].cz) * u,
              y: yc,
            };
          }
        }
        return { ...st[st.length - 1], rx: st[st.length - 1].rx + 0.65, rz: st[st.length - 1].rz + 0.65 };
      };

      const tapePts = [];
      const ringLevels = bustG?.isWomens
        ? [bustG.yFullHip, bustG.yHighHip, bustG.yWaist, bustG.yUnderbust, bustG.yBustApex, bustG.yHps ?? yAt(386)]
        : [yAt(-92), yAt(42), yAt(192), yAt(336)];
      for (const yRing of ringLevels) {
        const pr = sampleAtY(yRing);
        const segs = 80;
        for (let j = 0; j < segs; j++) {
          const a0 = (j / segs) * Math.PI * 2;
          const a1 = ((j + 1) / segs) * Math.PI * 2;
          const p0 = evalBustSurfacePoint(Math.cos(a0) * pr.rx, pr.y, pr.cz + Math.sin(a0) * pr.rz);
          const p1 = evalBustSurfacePoint(Math.cos(a1) * pr.rx, pr.y, pr.cz + Math.sin(a1) * pr.rz);
          tapePts.push(p0.x, p0.y, p0.z + (p0.z > 0 ? 0.4 : 0), p1.x, p1.y, p1.z + (p1.z > 0 ? 0.4 : 0));
        }
      }
      // CF & CB vertical plumb lines
      for (const zSign of [-1, 1]) {
        for (let k = 0; k < st.length - 1; k++) {
          const s0 = st[k];
          const s1 = st[k + 1];
          const p0 = evalBustSurfacePoint(0, s0.y, s0.cz + zSign * (s0.rz + 0.65));
          const p1 = evalBustSurfacePoint(0, s1.y, s1.cz + zSign * (s1.rz + 0.65));
          tapePts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
      // Women's Left & Right Front Princess Style-Tape Lines (passing over both bust apexes)
      if (bustG?.isWomens) {
        for (const side of [-1, 1]) {
          for (let k = 0; k < st.length - 3; k++) {
            const s0 = st[k];
            const s1 = st[k + 1];
            const x0 = clampNum(side * bustG.xBustApex, -s0.rx * 0.88, s0.rx * 0.88);
            const x1 = clampNum(side * bustG.xBustApex, -s1.rx * 0.88, s1.rx * 0.88);
            const z0Base = s0.cz + Math.sqrt(Math.max(0, 1 - (x0 / s0.rx) ** 2)) * (s0.rz + 0.7);
            const z1Base = s1.cz + Math.sqrt(Math.max(0, 1 - (x1 / s1.rx) ** 2)) * (s1.rz + 0.7);
            const p0 = evalBustSurfacePoint(x0, s0.y, z0Base);
            const p1 = evalBustSurfacePoint(x1, s1.y, z1Base);
            tapePts.push(p0.x, p0.y, p0.z + 0.5, p1.x, p1.y, p1.z + 0.5);
          }
        }
      }
      const tapeGeom = new THREE.BufferGeometry();
      tapeGeom.setAttribute('position', new THREE.Float32BufferAttribute(tapePts, 3));
      this.avatarGroup.add(new THREE.LineSegments(tapeGeom, tapeMat));

      // Brushed-steel neck finial cap
      const capCylinder = new THREE.Mesh(
        new THREE.CylinderGeometry(topSt.rx * 0.96, topSt.rx * 1.02, 14 * hScale, 40),
        metalMat
      );
      capCylinder.position.set(0, topSt.y + 6 * hScale, topSt.cz);
      capCylinder.castShadow = true;
      this.avatarGroup.add(capCylinder);
    }

    if (Array.isArray(avatar.capsules)) {
      for (const cap of avatar.capsules) {
        if (cap.name === 'bust_left' || cap.name === 'bust_right') continue;
        const cGeom = buildCapsuleBufferGeometry(cap, 32, 7);
        const cMesh = new THREE.Mesh(cGeom, cap.name === 'head' ? linenMat : limbMat);
        cMesh.castShadow = true;
        cMesh.receiveShadow = true;
        this.avatarGroup.add(cMesh);
        triTotal += (cGeom.index?.count || 0) / 3;
      }
    }

    // Brushed metal floor stand pole & weighted base
    const floorY = Number.isFinite(avatar.floorY) ? avatar.floorY : -980;
    const pelvisY = Array.isArray(st) && st.length > 0 ? st[0].y : -195;
    const poleH = Math.max(40, pelvisY - floorY);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(14, 16, poleH, 24), metalMat);
    pole.position.set(0, floorY + poleH * 0.5, -4);
    pole.castShadow = true;
    this.avatarGroup.add(pole);

    const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(175, 185, 14, 48), metalMat);
    baseDisc.position.set(0, floorY + 7, -4);
    baseDisc.castShadow = true;
    baseDisc.receiveShadow = true;
    this.avatarGroup.add(baseDisc);

    this._avatarTriCount = Math.round(triTotal);
  }

  _rebuildSTL(stlMesh) {
    if (this._stlCacheRef === stlMesh) return;
    this._stlCacheRef = stlMesh;
    this._clearGroup(this.stlGroup);
    this._stlTriCount = 0;
    if (!stlMesh || !Array.isArray(stlMesh.faces) || !Array.isArray(stlMesh.vertices)) return;

    const faces = stlMesh.faces;
    const verts = stlMesh.vertices;
    const pos = new Float32Array(faces.length * 9);
    let validFaces = 0;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const v0 = verts[f.indices[0]];
      const v1 = verts[f.indices[1]];
      const v2 = verts[f.indices[2]];
      if (!v0 || !v1 || !v2) continue;
      const base = validFaces * 9;
      pos[base] = v0.x; pos[base + 1] = v0.y; pos[base + 2] = v0.z;
      pos[base + 3] = v1.x; pos[base + 4] = v1.y; pos[base + 5] = v1.z;
      pos[base + 6] = v2.x; pos[base + 7] = v2.y; pos[base + 8] = v2.z;
      validFaces++;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, validFaces * 9), 3));
    geom.computeVertexNormals();
    const stlMat = new THREE.MeshPhysicalMaterial({
      color: 0x8ea0b8,
      roughness: 0.42,
      metalness: 0.18,
      clearcoat: 0.15,
    });
    const mesh = new THREE.Mesh(geom, stlMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.stlGroup.add(mesh);

    const edgesGeom = new THREE.EdgesGeometry(geom, 24);
    const edgesLine = new THREE.LineSegments(
      edgesGeom,
      new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.28 })
    );
    this.stlGroup.add(edgesLine);
    this._stlTriCount = validFaces;
  }

  _syncClothAndOverlays() {
    const { sim, avatar, materialConfig, showStrainMap, showWire, showThreads } = this.scene;
    if (!sim || !Array.isArray(sim.particles) || !Array.isArray(sim.triangles) || sim.triangles.length === 0) {
      this.clothMesh.visible = false;
      this.clothWireMesh.visible = false;
      this.topstitchLines.visible = false;
      this.threadsLines.visible = false;
      this._clearGroup(this.pinsGroup);
      return 0;
    }

    this.clothMesh.visible = true;
    this.clothWireMesh.visible = Boolean(showWire);

    const nVerts = sim.particles.length;
    const nTris = sim.triangles.length;

    if (this._clothTopoRef !== sim || this._clothTopoTriLen !== nTris) {
      this._clothTopoRef = sim;
      this._clothTopoTriLen = nTris;

      const idxArr = new Uint32Array(nTris * 3);
      const adjSets = Array.from({ length: nVerts }, () => new Set());
      const edgeCounts = new Map();
      for (let i = 0; i < nTris; i++) {
        const [a, b, c] = sim.triangles[i];
        idxArr[i * 3] = a;
        idxArr[i * 3 + 1] = b;
        idxArr[i * 3 + 2] = c;
        adjSets[a].add(b); adjSets[a].add(c);
        adjSets[b].add(a); adjSets[b].add(c);
        adjSets[c].add(a); adjSets[c].add(b);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          const k = u < v ? `${u}_${v}` : `${v}_${u}`;
          edgeCounts.set(k, (edgeCounts.get(k) || 0) + 1);
        }
      }
      const isBoundary = new Uint8Array(nVerts);
      for (const [k, cnt] of edgeCounts) {
        if (cnt === 1) {
          const sep = k.indexOf('_');
          isBoundary[Number(k.slice(0, sep))] = 1;
          isBoundary[Number(k.slice(sep + 1))] = 1;
        }
      }
      this._clothAdj = adjSets.map((s) => Array.from(s));
      this._clothIsBoundary = isBoundary;

      const uvScale = 1 / Math.max(4, (materialConfig?.threadScaleMm || 1.2) * 5.8);
      const uvArr = new Float32Array(nVerts * 2);
      for (let i = 0; i < nVerts; i++) {
        const r2 = sim.particles[i].rest2D || { x: 0, y: 0 };
        uvArr[i * 2] = r2.x * uvScale;
        uvArr[i * 2 + 1] = r2.y * uvScale;
      }

      this.clothGeom.dispose();
      this.clothGeom = new THREE.BufferGeometry();
      this.clothGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3));
      this.clothGeom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3));
      this.clothGeom.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      this.clothGeom.setAttribute('uv1', new THREE.BufferAttribute(uvArr, 2));
      this.clothGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3));
      this.clothGeom.setIndex(new THREE.BufferAttribute(idxArr, 1));
      this.clothMesh.geometry = this.clothGeom;
      this.clothWireMesh.geometry = this.clothGeom;
    }

    const posAttr = this.clothGeom.getAttribute('position');
    const normAttr = this.clothGeom.getAttribute('normal');
    const colAttr = this.clothGeom.getAttribute('color');
    const posBuf = posAttr.array;
    const normBuf = normAttr.array;
    const colBuf = colAttr.array;

    // Copy raw positions & apply 1 lightweight SDF-safe Taubin smoothing pass for silky folds
    const tmp = new Float32Array(nVerts * 3);
    for (let i = 0; i < nVerts; i++) {
      const p = sim.particles[i].pos;
      posBuf[i * 3] = p.x;
      posBuf[i * 3 + 1] = p.y;
      posBuf[i * 3 + 2] = p.z;
    }

    const adj = this._clothAdj;
    const isBnd = this._clothIsBoundary;
    if (adj && sim.stepCount > 0) {
      for (const weight of [0.26, -0.27]) {
        for (let i = 0; i < nVerts; i++) {
          const nb = adj[i];
          const w = isBnd[i] ? weight * 0.35 : weight;
          if (!nb || nb.length === 0) {
            tmp[i * 3] = posBuf[i * 3];
            tmp[i * 3 + 1] = posBuf[i * 3 + 1];
            tmp[i * 3 + 2] = posBuf[i * 3 + 2];
            continue;
          }
          let sx = 0, sy = 0, sz = 0;
          for (let k = 0; k < nb.length; k++) {
            const j = nb[k] * 3;
            sx += posBuf[j];
            sy += posBuf[j + 1];
            sz += posBuf[j + 2];
          }
          const invN = 1 / nb.length;
          tmp[i * 3] = posBuf[i * 3] + w * (sx * invN - posBuf[i * 3]);
          tmp[i * 3 + 1] = posBuf[i * 3 + 1] + w * (sy * invN - posBuf[i * 3 + 1]);
          tmp[i * 3 + 2] = posBuf[i * 3 + 2] + w * (sz * invN - posBuf[i * 3 + 2]);
        }
        posBuf.set(tmp);
      }

      // CLO-style visual seam & dart vertex welding across converged stitch pairs (watertight zero-sliver seams)
      const weldRules = [
        ...(Array.isArray(sim.sewingConstraints) ? sim.sewingConstraints : []),
        ...(Array.isArray(sim.dartConstraints) ? sim.dartConstraints : []),
      ];
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < weldRules.length; i++) {
          const sc = weldRules[i];
          const a3 = sc.a * 3;
          const b3 = sc.b * 3;
          const dx = posBuf[b3] - posBuf[a3];
          const dy = posBuf[b3 + 1] - posBuf[a3 + 1];
          const dz = posBuf[b3 + 2] - posBuf[a3 + 2];
          const maxWeldSq = sc.isDart ? 484 : 576; // <= 22mm darts, <= 24mm seams
          if (dx * dx + dy * dy + dz * dz <= maxWeldSq) {
            const mx = (posBuf[a3] + posBuf[b3]) * 0.5;
            const my = (posBuf[a3 + 1] + posBuf[b3 + 1]) * 0.5;
            const mz = (posBuf[a3 + 2] + posBuf[b3 + 2]) * 0.5;
            posBuf[a3] = mx; posBuf[a3 + 1] = my; posBuf[a3 + 2] = mz;
            posBuf[b3] = mx; posBuf[b3 + 1] = my; posBuf[b3 + 2] = mz;
          }
        }
      }

      if (avatar && this.scene.showForm) {
        const minSkinGap = Math.max((materialConfig?.thicknessMm || 0.65) + 2.2, 2.8);
        for (let i = 0; i < nVerts; i++) {
          const safe = projectOutsideAvatarRenderSafe(
            avatar,
            posBuf[i * 3],
            posBuf[i * 3 + 1],
            posBuf[i * 3 + 2],
            minSkinGap
          );
          posBuf[i * 3] = safe.x;
          posBuf[i * 3 + 1] = safe.y;
          posBuf[i * 3 + 2] = safe.z;
        }
      }
    }

    // Compute smooth area-weighted vertex normals + cross-seam normal welding
    normBuf.fill(0);
    const idxBuf = this.clothGeom.index.array;
    for (let i = 0; i < idxBuf.length; i += 3) {
      const ia = idxBuf[i] * 3;
      const ib = idxBuf[i + 1] * 3;
      const ic = idxBuf[i + 2] * 3;
      const ux = posBuf[ib] - posBuf[ia];
      const uy = posBuf[ib + 1] - posBuf[ia + 1];
      const uz = posBuf[ib + 2] - posBuf[ia + 2];
      const vx = posBuf[ic] - posBuf[ia];
      const vy = posBuf[ic + 1] - posBuf[ia + 1];
      const vz = posBuf[ic + 2] - posBuf[ia + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      normBuf[ia] += nx; normBuf[ia + 1] += ny; normBuf[ia + 2] += nz;
      normBuf[ib] += nx; normBuf[ib + 1] += ny; normBuf[ib + 2] += nz;
      normBuf[ic] += nx; normBuf[ic + 1] += ny; normBuf[ic + 2] += nz;
    }

    const stitchRules = [
      ...(Array.isArray(sim.sewingConstraints) ? sim.sewingConstraints : []),
      ...(Array.isArray(sim.dartConstraints) ? sim.dartConstraints : []),
    ];
    if (stitchRules.length > 0) {
      for (let i = 0; i < stitchRules.length; i++) {
        const sc = stitchRules[i];
        const a3 = sc.a * 3;
        const b3 = sc.b * 3;
        const dx = posBuf[b3] - posBuf[a3];
        const dy = posBuf[b3 + 1] - posBuf[a3 + 1];
        const dz = posBuf[b3 + 2] - posBuf[a3 + 2];
        if (dx * dx + dy * dy + dz * dz <= 225) {
          // Align orientation across closed seams & closed darts so busts, waists & shoulders shade smoothly
          const dotN =
            normBuf[a3] * normBuf[b3] +
            normBuf[a3 + 1] * normBuf[b3 + 1] +
            normBuf[a3 + 2] * normBuf[b3 + 2];
          const signB = dotN < 0 ? -1 : 1;
          const sx = normBuf[a3] + signB * normBuf[b3];
          const sy = normBuf[a3 + 1] + signB * normBuf[b3 + 1];
          const sz = normBuf[a3 + 2] + signB * normBuf[b3 + 2];
          normBuf[a3] = sx; normBuf[a3 + 1] = sy; normBuf[a3 + 2] = sz;
          normBuf[b3] = signB * sx; normBuf[b3 + 1] = signB * sy; normBuf[b3 + 2] = signB * sz;
        }
      }
    }

    for (let i = 0; i < nVerts; i++) {
      const i3 = i * 3;
      const l = Math.hypot(normBuf[i3], normBuf[i3 + 1], normBuf[i3 + 2]) || 1;
      normBuf[i3] /= l;
      normBuf[i3 + 1] /= l;
      normBuf[i3 + 2] /= l;

      const p = sim.particles[i];
      if (showStrainMap && p.color) {
        colBuf[i3] = p.color[0];
        colBuf[i3 + 1] = p.color[1];
        colBuf[i3 + 2] = p.color[2];
      } else if (this.scene.selectedPieceId && p.pieceId === this.scene.selectedPieceId) {
        colBuf[i3] = 1.08;
        colBuf[i3 + 1] = 1.08;
        colBuf[i3 + 2] = 1.12;
      } else {
        colBuf[i3] = 1.0;
        colBuf[i3 + 1] = 1.0;
        colBuf[i3 + 2] = 1.0;
      }
    }

    if (this.clothMaterial.vertexColors !== Boolean(showStrainMap)) {
      this.clothMaterial.vertexColors = Boolean(showStrainMap);
      this.clothMaterial.map = showStrainMap ? null : this._pbrTextures.albedo;
      this.clothMaterial.needsUpdate = true;
    }

    posAttr.needsUpdate = true;
    normAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.clothGeom.computeBoundingSphere();

    // Build subtle 3D surface topstitching & optional open-air sewing threads
    const stitchPts = [];
    const threadPts = [];
    if (stitchRules.length > 0) {
      const bySeam = new Map();
      for (let i = 0; i < stitchRules.length; i++) {
        const sc = stitchRules[i];
        const a3 = sc.a * 3;
        const b3 = sc.b * 3;
        const dx = posBuf[b3] - posBuf[a3];
        const dy = posBuf[b3 + 1] - posBuf[a3 + 1];
        const dz = posBuf[b3 + 2] - posBuf[a3 + 2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (showThreads && !sc.isDart && distSq > 9) {
          threadPts.push(
            posBuf[a3], posBuf[a3 + 1], posBuf[a3 + 2],
            posBuf[b3], posBuf[b3 + 1], posBuf[b3 + 2]
          );
        }
        if (distSq <= 400) {
          let arr = bySeam.get(sc.seamId);
          if (!arr) {
            arr = [];
            bySeam.set(sc.seamId, arr);
          }
          const mx = (posBuf[a3] + posBuf[b3]) * 0.5 + normBuf[a3] * 0.9;
          const my = (posBuf[a3 + 1] + posBuf[b3 + 1]) * 0.5 + normBuf[a3 + 1] * 0.9;
          const mz = (posBuf[a3 + 2] + posBuf[b3 + 2]) * 0.5 + normBuf[a3 + 2] * 0.9;
          arr.push(mx, my, mz);
        }
      }
      for (const pts of bySeam.values()) {
        for (let k = 0; k + 5 < pts.length; k += 3) {
          stitchPts.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], pts[k + 5]);
        }
      }
    }

    if (stitchPts.length > 0) {
      this.topstitchGeom.dispose();
      this.topstitchGeom = new THREE.BufferGeometry();
      this.topstitchGeom.setAttribute('position', new THREE.Float32BufferAttribute(stitchPts, 3));
      this.topstitchLines.geometry = this.topstitchGeom;
      this.topstitchLines.visible = true;
    } else {
      this.topstitchLines.visible = false;
    }

    if (showThreads && threadPts.length > 0) {
      this.threadsGeom.dispose();
      this.threadsGeom = new THREE.BufferGeometry();
      this.threadsGeom.setAttribute('position', new THREE.Float32BufferAttribute(threadPts, 3));
      this.threadsLines.geometry = this.threadsGeom;
      this.threadsLines.visible = true;
    } else {
      this.threadsLines.visible = false;
    }

    // Pinned particle spheres (skip internal studio hanger anchors)
    while (this.pinsGroup.children.length > 0) {
      this.pinsGroup.remove(this.pinsGroup.children[0]);
    }
    for (let i = 0; i < nVerts; i++) {
      if (sim.particles[i].invMass <= 0 && !sim.particles[i].studioAnchor) {
        const sp = new THREE.Mesh(this._pinSphereGeom, this._pinSphereMat);
        sp.position.set(posBuf[i * 3], posBuf[i * 3 + 1], posBuf[i * 3 + 2]);
        this.pinsGroup.add(sp);
      }
    }

    return nTris;
  }

  setScene(partialScene = {}) {
    Object.assign(this.scene, partialScene);
    if (partialScene.materialConfig) {
      this.updateMaterialMaps(partialScene.materialConfig);
    }
    this.callbacks.onDirty?.();
  }

  resize(widthCss, heightCss, dpr = 1) {
    const safeW = Number.isFinite(widthCss) && widthCss > 0 ? widthCss : 640;
    const safeH = Number.isFinite(heightCss) && heightCss > 0 ? heightCss : 480;
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(2, dpr) : 1;
    this.cssWidth = Math.max(100, safeW);
    this.cssHeight = Math.max(100, safeH);
    this.dpr = safeDpr;
    this.renderer.setPixelRatio(safeDpr);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.camera.aspect = this.cssWidth / Math.max(1, this.cssHeight);
    this.camera.updateProjectionMatrix();
    this.callbacks.onDirty?.();
  }

  fitToScene() {
    const stl = this.scene.stlMesh;
    const avatar = this.scene.avatar;
    const sim = this.scene.sim;
    const aspect = Math.max(0.45, this.cssWidth / Math.max(1, this.cssHeight));
    const aspectBoost = aspect < 0.95 ? clampNum(0.98 / aspect, 1.0, 1.55) : 1.0;

    if (stl?.bounds?.center && stl?.bounds?.size) {
      const c = stl.bounds.center;
      const s = stl.bounds.size;
      const radius = Math.max(40, Math.hypot(s.x, s.y, s.z) * 0.5);
      this.controls.target.set(c.x, c.y, c.z);
      const dist = clampNum(radius * 3.45 * aspectBoost, 210, 3800);
      this.camera.position.set(c.x + dist * 0.44, c.y + dist * 0.36, c.z + dist * 0.83);
      this.floorGroup.position.y = (stl.bounds.min?.y ?? c.y - s.y * 0.5) - 6;
    } else if (sim && Array.isArray(sim.particles) && sim.particles.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < sim.particles.length; i++) {
        const p = sim.particles[i].pos;
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
      if (avatar) {
        const hScale = avatar.armPose?.hScale ?? 1;
        maxY = Math.max(maxY, (avatar.armPose?.isWomens ? 590 : 540) * hScale);
        minY = Math.min(minY, (avatar.armPose?.isWomens ? -360 : -240) * hScale);
      }
      const cy = (minY + maxY) * 0.5;
      const spanY = Math.max(260, maxY - minY);
      const spanX = Math.max(260, maxX - minX);
      const dist = clampNum(Math.max(spanY * 1.78, spanX * 1.65 * aspectBoost), 760, 3100);
      this.controls.target.set(0, cy, 0);
      this.camera.position.set(dist * 0.26, cy + dist * 0.10, dist * 0.96);
      this.floorGroup.position.y = avatar ? (avatar.floorY || -980) : minY - 24;
    } else if (avatar) {
      const hScale = (avatar.measurements?.heightMm || 1750) / 1750;
      this.controls.target.set(0, 95 * hScale, 0);
      this.camera.position.set(360 * hScale, 195 * hScale, 1340 * hScale);
      this.floorGroup.position.y = avatar.floorY || -980;
    }
    this.controls.update();
    this.callbacks.onDirty?.();
  }

  setCameraPreset(preset) {
    const t = this.controls.target;
    const dist = Math.max(180, this.camera.position.distanceTo(t));
    if (preset === 'front') {
      this.camera.position.set(t.x, t.y + dist * 0.06, t.z + dist);
    } else if (preset === 'back') {
      this.camera.position.set(t.x, t.y + dist * 0.06, t.z - dist);
    } else if (preset === 'side') {
      this.camera.position.set(t.x + dist, t.y + dist * 0.06, t.z);
    } else if (preset === 'top') {
      this.camera.position.set(t.x, t.y + dist * 0.96, t.z + dist * 0.25);
    } else {
      this.camera.position.set(t.x + dist * 0.36, t.y + dist * 0.16, t.z + dist * 0.92);
    }
    this.controls.update();
    this.callbacks.onDirty?.();
  }

  pickParticle(clientX, clientY) {
    const sim = this.scene.sim;
    if (!sim || !Array.isArray(sim.particles) || !this.canvas?.getBoundingClientRect) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const v = new THREE.Vector3();
    let bestIdx = -1;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i].pos;
      v.set(p.x, p.y, p.z).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(mx - sx, my - sy);
      if (d <= 20) {
        const score = d + v.z * 6;
        if (score < bestScore) {
          bestScore = score;
          bestDist = d;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) return null;
    return {
      particleIndex: bestIdx,
      distancePx: bestDist,
      worldPos: { ...sim.particles[bestIdx].pos },
    };
  }

  togglePinParticle(idx) {
    const p = this.scene.sim?.particles?.[idx];
    if (!p) return false;
    if (p.invMass <= 0) {
      p.invMass = p._origInvMass > 0 ? p._origInvMass : 1.0;
    } else {
      p._origInvMass = p.invMass;
      p.invMass = 0;
    }
    this.callbacks.onDirty?.();
    return p.invMass <= 0;
  }

  movePinnedParticle(idx, dxScreen, dyScreen) {
    const p = this.scene.sim?.particles?.[idx];
    if (!p) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const scale = (dist * 0.72) / Math.max(200, this.cssHeight);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const nx = p.pos.x + (right.x * dxScreen - up.x * dyScreen) * scale;
    const ny = p.pos.y + (right.y * dxScreen - up.y * dyScreen) * scale;
    const nz = p.pos.z + (right.z * dxScreen - up.z * dyScreen) * scale;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return;
    if (p.invMass > 0) {
      p._origInvMass = p.invMass;
      p.invMass = 0;
    }
    p.pos.x = nx; p.pos.y = ny; p.pos.z = nz;
    p.prevPos.x = nx; p.prevPos.y = ny; p.prevPos.z = nz;
    p.lastFinitePos.x = nx; p.lastFinitePos.y = ny; p.lastFinitePos.z = nz;
    this.callbacks.onDirty?.();
  }

  clearPins() {
    const sim = this.scene.sim;
    if (!sim || !Array.isArray(sim.particles)) return;
    for (const p of sim.particles) {
      if (p.invMass <= 0) {
        p.invMass = p._origInvMass > 0 ? p._origInvMass : 1.0;
      }
    }
    this.callbacks.onDirty?.();
  }

  render() {
    if (this._disposed) return this.lastRenderStats;

    if (this.scene.showForm && this.scene.stlMesh) {
      this._rebuildSTL(this.scene.stlMesh);
      this.stlGroup.visible = true;
      this.avatarGroup.visible = false;
    } else if (this.scene.showForm && this.scene.avatar) {
      this._rebuildMannequin(this.scene.avatar);
      this.avatarGroup.visible = true;
      this.stlGroup.visible = false;
    } else {
      this.avatarGroup.visible = false;
      this.stlGroup.visible = false;
    }

    const clothTris = this._syncClothAndOverlays();
    this.renderer.render(this.threeScene, this.camera);

    if (typeof window !== 'undefined') {
      window.__psv2WebGLDraws = (window.__psv2WebGLDraws || 0) + 1;
    }

    this.lastRenderStats = {
      mode: 'webgl2',
      renderedStlTriangles: this.stlGroup.visible ? this._stlTriCount : 0,
      renderedClothTriangles: clothTris,
      renderedAvatarTriangles: this.avatarGroup.visible ? this._avatarTriCount : 0,
      drawCalls: this.renderer.info.render.calls || 1,
    };
    return this.lastRenderStats;
  }

  dispose() {
    this._disposed = true;
    for (const [target, type, fn, opts] of this._boundEvents) {
      target?.removeEventListener?.(type, fn, opts);
    }
    this._boundEvents = [];
    this.controls?.dispose?.();
    this._clearGroup(this.avatarGroup);
    this._clearGroup(this.stlGroup);
    this._clearGroup(this.pinsGroup);
    this.clothGeom?.dispose?.();
    this.clothMaterial?.dispose?.();
    this.clothWireMat?.dispose?.();
    this.topstitchGeom?.dispose?.();
    this.topstitchMat?.dispose?.();
    this.threadsGeom?.dispose?.();
    this.threadsMat?.dispose?.();
    this._pinSphereGeom?.dispose?.();
    this._pinSphereMat?.dispose?.();
    this._backdropTex?.dispose?.();
    this._envRT?.dispose?.();
    for (const k of ['albedo', 'normal', 'roughness', 'ao']) {
      this._pbrTextures[k]?.dispose?.();
    }
    this.renderer?.dispose?.();
  }
}

export function createViewport3D(canvas, callbacks = {}) {
  const isLiveDomCanvas =
    typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
  if (isLiveDomCanvas) {
    try {
      return new ThreeStudioViewport3D(canvas, callbacks);
    } catch {
      return new WebGL3DViewport(canvas, callbacks);
    }
  }
  return new WebGL3DViewport(canvas, callbacks);
}
