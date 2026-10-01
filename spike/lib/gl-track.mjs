// WebGL2 renderer for the track, drawn from the game's camera.
//
// The vertex shader uses the game's projection (gp.exe 0F47:20D9), so at the
// original framing it lines up with the game's frame, but at any resolution:
//   lateral = dx*cos(yaw) - dy*sin(yaw), depth = dx*sin(yaw) + dy*cos(yaw)
//   column = 160 + 256*lateral/depth
//   row    = horizon - (2*SS:017C/65536*32*8)*dz/depth   (dx, dy, depth in fine units)
// Wider canvases widen the horizontal view and keep the vertical scale.
//
// Units: X/Y in fine units (1/64 ft), Z in the game's Z units, angles in
// 1/65536 turn. Vertex positions are stored relative to an origin near the
// track so float32 keeps sub-unit precision.

import { buildMesh } from './track-mesh.mjs';
import { buildSceneMesh } from './scene.mjs';

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColour;
uniform vec3 uCam;      // camera position relative to the origin
uniform vec2 uSinCos;   // sin(yaw), cos(yaw)
uniform vec4 uProj;     // sx, sy, cy, unused
uniform vec2 uDepth;    // near, far
out vec3 vColour;
void main() {
  vec3 d = aPos - uCam;
  float lat = d.x * uSinCos.y - d.y * uSinCos.x;
  float depth = d.x * uSinCos.x + d.y * uSinCos.y;
  float n = uDepth.x, f = uDepth.y;
  gl_Position = vec4(uProj.x * lat, uProj.y * d.z + uProj.z * depth, (depth * (f + n) - 2.0 * f * n) / (f - n), depth);
  vColour = aColour;
}`;

// Colours are RGB, or (palette index, -1, 0) looked up in the live palette.
const FS = `#version 300 es
precision mediump float;
in vec3 vColour;
uniform sampler2D uPalette;
out vec4 outColour;
void main() {
  if (vColour.y < 0.0) outColour = vec4(texture(uPalette, vec2((vColour.x + 0.5) / 256.0, 0.5)).rgb, 1.0);
  else outColour = vec4(vColour, 1.0);
}`;

// Background: sky above the horizon row, ground below.
const BG_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out float vY;
void main() { vY = aPos.y; gl_Position = vec4(aPos, 0.999, 1.0); }`;
const BG_FS = `#version 300 es
precision highp float;
in float vY;
uniform vec4 uView;      // horizon row, viewport rows, x scale (wide framing), yaw/32 (image columns)
uniform vec2 uCanvas;    // canvas width, height in pixels (of the viewport)
uniform vec3 uGround;
uniform int uUseScene;   // 1: sky and horizon from the game's tables
uniform int uImage;      // 1: draw the horizon image
uniform sampler2D uSky;  // sky colours, one texel per 4 game rows above the sky base
uniform sampler2D uHorizon; // 512 x 8 horizon image
uniform float uSkyLen;
uniform vec3 uSkyTop, uSkyHorizon;
out vec4 outColour;
void main() {
  float row = (1.0 - vY) * 0.5 * uView.y;          // game viewport row from the top
  float above = uView.x - row;                       // rows above the horizon row
  if (above <= 0.0) { outColour = vec4(uGround, 1.0); return; }
  if (uUseScene == 0) {
    float t = clamp(above / uView.x, 0.0, 1.0);
    outColour = vec4(mix(uSkyHorizon, uSkyTop, t), 1.0);
    return;
  }
  float xn = (gl_FragCoord.x / uCanvas.x) * 2.0 - 1.0;
  float col = 160.0 + xn * 160.0 / uView.z;          // game screen column
  if (uImage == 1 && above <= 8.0) {
    vec2 uv = vec2((uView.w + col) / 512.0, (8.0 - above) / 8.0);
    outColour = vec4(texture(uHorizon, uv).rgb, 1.0);
    return;
  }
  float sky = above - (uImage == 1 ? 8.0 : 0.0);
  outColour = vec4(texture(uSky, vec2(min(sky / 4.0, uSkyLen - 0.5) / uSkyLen, 0.5)).rgb, 1.0);
}`;

/** Colours (0-255 RGB) seen in the game's frames at Monza. */
export const COLOURS = {
  road: [89, 101, 105],
  roadAlt: [85, 97, 101],
  verge: [93, 142, 40],
  ground: [97, 146, 44],
  groundGrey: [174, 174, 174],
  kerbRed: [239, 0, 36],
  kerbWhite: [255, 255, 255],
  skyTop: [73, 150, 255],
  skyHorizon: [113, 190, 255],
};

const VSCALE = (0x6e80 * 2) / 65536 * 32 * 8; // rows per (Z unit / fine depth unit)

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class TrackRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.prog = program(gl, VS, FS);
    this.bgProg = program(gl, BG_VS, BG_FS);
    this.u = Object.fromEntries(['uCam', 'uSinCos', 'uProj', 'uDepth', 'uPalette'].map((n) => [n, gl.getUniformLocation(this.prog, n)]));
    this.paletteTex = gl.createTexture();
    this.bgU = Object.fromEntries(['uView', 'uCanvas', 'uGround', 'uUseScene', 'uImage', 'uSky', 'uHorizon', 'uSkyLen', 'uSkyTop', 'uSkyHorizon']
      .map((n) => [n, gl.getUniformLocation(this.bgProg, n)]));
    this.sceneTex = null;
    this.bg = gl.createVertexArray();
    gl.bindVertexArray(this.bg);
    const bgBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.track = null;
    this.cars = { vao: gl.createVertexArray(), buf: gl.createBuffer(), count: 0 };
    this.ground = COLOURS.ground;
  }

  /**
   * @param {object[]} segs  from track-mesh fromCompiled()/fromMemory()
   * @param {object} [opt]   { track: parseTrack() result, surround: 'green'|'grey',
   *                           pitSegs: pit-lane segments in the same form }
   */
  setTrack(segs, opt = {}) {
    const gl = this.gl;
    const polys = buildMesh(segs, { track: opt.track });
    if (opt.pitSegs && opt.pitSegs.length > 1) polys.push(...buildMesh(opt.pitSegs, { closed: false }));
    this.origin = [segs[0].x, segs[0].y, 0];
    this.ground = opt.surround === 'grey' ? COLOURS.groundGrey : COLOURS.ground;
    const verts = [];
    const push = (p, c, dz = 0) => verts.push(p[0] - this.origin[0], p[1] - this.origin[1], p[2] + dz, c[0] / 255, c[1] / 255, c[2] / 255);
    for (const poly of polys) {
      let c, dz = 0;
      switch (poly.kind) {
        case 'road': c = poly.seg & 1 ? COLOURS.roadAlt : COLOURS.road; break;
        case 'vergeLeft': case 'vergeRight': c = COLOURS.verge; dz = -1; break;
        default: c = poly.stripe ? COLOURS.kerbWhite : COLOURS.kerbRed; dz = 1;
      }
      const [a, b, d, e] = poly.pts;
      for (const p of [a, b, d, a, d, e]) push(p, c, dz);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.track = { vao, count: verts.length / 6, polys: polys.length };
    return this.track;
  }

  /**
   * The scene read from the game's memory (scene.mjs readScene): every part,
   * the game's colours, sky and horizon image.
   * @param {object} scene
   * @param {object} [opt] { surroundRoad: true for grey surroundings (the track header's bit 7) }
   */
  setScene(scene, opt = {}) {
    const gl = this.gl;
    const mesh = buildSceneMesh(scene, { indexed: true });
    this.scene = scene;
    this.origin = [mesh.origin[0], mesh.origin[1], 0];
    this.groundIndex = opt.surroundRoad ? scene.road : scene.grass;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.track = { vao, count: mesh.data.length / 6, parts: mesh.counts, ranges: mesh.ranges };
    this.setPalette(scene.palette);
    return this.track;
  }

  /**
   * Use a new palette (RGB, 0-255, 768 bytes), e.g. read from the game every
   * second: the game changes it for fades and for wet weather.
   */
  setPalette(pal) {
    const gl = this.gl, scene = this.scene;
    if (!scene) return;
    if (this.lastPalette && this.lastPalette.every((v, i) => v === pal[i])) return;
    this.lastPalette = Uint8Array.from(pal);
    const rgb = (i) => [pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]];
    this.ground = rgb(this.groundIndex);
    const palPx = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) palPx.set([pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2], 255], i * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palPx);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    // sky: one texel per sky-table step (3 solid rows + 1 dithered row = 4 rows)
    const steps = scene.tables.sky.map((e) => rgb(e.colour));
    const skyPx = new Uint8Array(steps.length * 4);
    steps.forEach((c, i) => skyPx.set([c[0], c[1], c[2], 255], i * 4));
    const horizonPx = new Uint8Array(512 * 8 * 4);
    for (let i = 0; i < 4096; i++) { const c = rgb(scene.horizon[i]); horizonPx.set([c[0], c[1], c[2], 255], i * 4); }
    const tex = (w, h, px, wrapS, filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      return t;
    };
    this.sceneTex = {
      sky: tex(steps.length, 1, skyPx, gl.CLAMP_TO_EDGE, gl.LINEAR), skyLen: steps.length,
      horizon: tex(512, 8, horizonPx, gl.REPEAT, gl.NEAREST),
    };
  }

  /**
   * Cars as simple boxes for now (Phase 3 brings the real shapes).
   * @param {{x:number, y:number, z:number, heading:number, colour:number[]}[]} cars  x/y fine units
   */
  setCars(cars) {
    const gl = this.gl, o = this.origin || [0, 0, 0];
    const v = [];
    const L = 4.5 * 3.2808 * 64 / 2, W = 2 * 3.2808 * 64 / 2, H = 64 * 3; // half length, half width (fine), height (Z units)
    for (const car of cars) {
      const a = (car.heading / 65536) * 2 * Math.PI, s = Math.sin(a), c = Math.cos(a);
      const pt = (f, r, z) => [car.x - o[0] + f * s + r * c, car.y - o[1] + f * c - r * s, car.z + z];
      const col = car.colour.map((k) => k / 255);
      const shade = (k) => col.map((x) => x * k);
      const quad = (p, q, r, t, k) => { for (const P of [p, q, r, p, r, t]) v.push(...P, ...shade(k)); };
      const b = [pt(L, -W, 0), pt(L, W, 0), pt(-L, W, 0), pt(-L, -W, 0)];
      const tp = [pt(L, -W, H), pt(L, W, H), pt(-L, W, H), pt(-L, -W, H)];
      quad(tp[0], tp[1], tp[2], tp[3], 1);
      quad(b[0], b[1], tp[1], tp[0], 0.8);
      quad(b[1], b[2], tp[2], tp[1], 0.6);
      quad(b[2], b[3], tp[3], tp[2], 0.7);
      quad(b[3], b[0], tp[0], tp[3], 0.6);
    }
    gl.bindVertexArray(this.cars.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cars.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.cars.count = v.length / 6;
  }

  /**
   * Draw one frame.
   * @param {object} cam  { x, y (fine), z, heading, horizon (row), rows (viewport rows), top (first screen row) }
   * @param {object} [opt] { framing: 'original'|'wide'|'screen' }
   *   'screen' draws into the part of the canvas where the game's 320x200 screen
   *   shows its 3D view (rows top..top+rows), for laying over the original.
   */
  draw(cam, opt = {}) {
    const gl = this.gl, cv = this.canvas;
    let w = cv.width, h = cv.height, y0 = 0;
    if (opt.framing === 'screen') {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const rowPx = cv.height / 200;
      y0 = Math.round((200 - cam.top - cam.rows) * rowPx);
      h = Math.round(cam.rows * rowPx);
    }
    gl.viewport(0, y0, w, h);
    // The game's viewport is 320 columns by cam.rows rows, shown at 4:3 (each
    // row 1.2 columns tall). In 'wide' framing the canvas keeps the vertical
    // scale and shows more to the sides.
    const rows = cam.rows;
    const nativeAspect = 320 / (rows * 1.2);
    const aspect = w / h;
    const xScale = opt.framing === 'wide' ? nativeAspect / aspect : 1;
    const sx = (256 / 160) * xScale;
    const sy = (2 * VSCALE) / rows;
    const cy = 1 - (2 * cam.horizon) / rows;
    const o = this.origin || [0, 0, 0];
    const a = (cam.heading / 65536) * 2 * Math.PI;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.bgProg);
    gl.uniform4f(this.bgU.uView, cam.horizon, rows, xScale, (cam.heading >> 5) & 511);
    gl.uniform2f(this.bgU.uCanvas, w, h);
    gl.uniform3fv(this.bgU.uGround, this.ground.map((k) => k / 255));
    gl.uniform3fv(this.bgU.uSkyTop, COLOURS.skyTop.map((k) => k / 255));
    gl.uniform3fv(this.bgU.uSkyHorizon, COLOURS.skyHorizon.map((k) => k / 255));
    const st = this.sceneTex;
    gl.uniform1i(this.bgU.uUseScene, st ? 1 : 0);
    gl.uniform1i(this.bgU.uImage, st && !cam.noHorizonImage ? 1 : 0);
    if (st) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.sky); gl.uniform1i(this.bgU.uSky, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.horizon); gl.uniform1i(this.bgU.uHorizon, 1);
      gl.uniform1f(this.bgU.uSkyLen, st.skyLen);
    }
    gl.bindVertexArray(this.bg);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!this.track) return;
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.paletteTex); gl.uniform1i(this.u.uPalette, 0);
    gl.uniform3f(this.u.uCam, cam.x - o[0], cam.y - o[1], cam.z);
    gl.uniform2f(this.u.uSinCos, Math.sin(a), Math.cos(a));
    gl.uniform4f(this.u.uProj, sx, sy, cy, 0);
    gl.uniform2f(this.u.uDepth, 64, 64 * 16 * 1200); // 1 ft to about 6 km
    gl.bindVertexArray(this.track.vao);
    const R = this.track.ranges;
    if (R) {
      // road, then the flat lines and markings on top of it (no depth writes,
      // pulled forward), then the raised parts
      gl.drawArrays(gl.TRIANGLES, R.ground.first, R.ground.count);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -4);
      gl.depthFunc(gl.LEQUAL);
      gl.drawArrays(gl.TRIANGLES, R.decals.first, R.decals.count);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      gl.drawArrays(gl.TRIANGLES, R.raised.first, R.raised.count);
    } else gl.drawArrays(gl.TRIANGLES, 0, this.track.count);
    if (this.cars.count) {
      gl.bindVertexArray(this.cars.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.cars.count);
    }
  }
}

/** The camera for draw() from a readState() result (fine units). */
export function cameraFromState(st) {
  const cockpit = st.view.mode === 'cockpit';
  return {
    x: st.camera.x / 256, y: st.camera.y / 256, z: st.camera.z,
    heading: st.camera.heading, horizon: st.camera.horizonRow,
    rows: cockpit ? 103 : 164, top: cockpit ? 0 : 16,
  };
}

/** Ease between two cameras (t in 0..1), turning the short way round. */
export function lerpCamera(a, b, t) {
  const dh = ((b.heading - a.heading + 0x18000) % 0x10000) - 0x8000;
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    heading: (a.heading + dh * t + 0x10000) % 0x10000,
    horizon: a.horizon + (b.horizon - a.horizon) * t, rows: b.rows, top: b.top,
  };
}
