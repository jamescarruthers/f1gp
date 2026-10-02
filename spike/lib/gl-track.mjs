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
import { buildSectorMesh, frameObjects, buildSpriteAtlas, spriteIdsUsed, spriteQuads } from './objects.mjs';
import { carSpriteQuads, carSpriteIds } from './cars.mjs';

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColour;
layout(location = 2) in vec2 aUv;  // road: feet along and across the track (0, 0 elsewhere)
layout(location = 3) in float aSide; // poles: -1 or 1, the side of the strip this vertex is on (0 elsewhere)
uniform vec3 uCam;      // camera position relative to the origin
uniform vec2 uSinCos;   // sin(yaw), cos(yaw)
uniform vec4 uProj;     // sx, sy, cy, unused
uniform vec2 uDepth;    // near, far
uniform vec2 uPole;     // a pole's half-width: fine units, and at least this much of the screen (NDC)
out vec3 vColour;
out float vDepth;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vec3 p = aPos;
  if (aSide != 0.0) {
    // a pole is a strip facing the camera, widened sideways on the screen
    vec3 d0 = aPos - uCam;
    float depth0 = max(d0.x * uSinCos.x + d0.y * uSinCos.y, uDepth.x);
    float hw = max(uPole.x, uPole.y * depth0 / abs(uProj.x));
    p.xy += aSide * hw * vec2(uSinCos.y, -uSinCos.x);
  }
  vec3 d = p - uCam;
  float lat = d.x * uSinCos.y - d.y * uSinCos.x;
  float depth = d.x * uSinCos.x + d.y * uSinCos.y;
  float n = uDepth.x, f = uDepth.y;
  gl_Position = vec4(uProj.x * lat, uProj.y * d.z + uProj.z * depth, (depth * (f + n) - 2.0 * f * n) / (f - n), depth);
  vColour = aColour;
  vDepth = depth;
  vUv = aUv;
  vWorld = p;
}`;

// The ground texture (the game's T option, 0F47:7F64): the road and the grass
// take the neighbouring shades of their colour, road 18h-1Bh around 1Ah and
// grass 11h-13h around 12h (each circuit's ramps run dark to light). The game
// does it in screen space, as streaks that follow the camera's motion; here a
// noise texture lies on the ground: along the track on the road (streaks four
// times longer than wide), in world space on the grass, with a grain about a
// quarter of its size on top; on the road about two pixels in three take a
// neighbouring shade. Mode 1 keeps the game's whole shades; mode 2 blends
// between them. Mipmaps fade it with distance, as the shades average out.
const GROUND_TEXTURE = `
uniform sampler2D uNoise;   // R8, tileable noise, mipmapped
uniform int uTexMode;       // 0 off, 1 the game's shades, 2 smooth
// the noise at p (texture repeats): the broad patches, and a finer grain on top
float groundNoise(vec2 p) {
  return (texture(uNoise, p).r - 0.5) * 2.0 + (texture(uNoise, p * 4.31 + 0.37).r - 0.5) * 1.4;
}
vec3 groundShade(sampler2D pal, int idx, float n, int lo, int hi) {
  if (uTexMode == 1) return texelFetch(pal, ivec2(idx + clamp(int(floor(n * 2.6 + 0.5)), lo, hi), 0), 0).rgb;
  float f = clamp(n * 2.6, float(lo), float(hi));
  int k = int(floor(f));
  vec3 a = texelFetch(pal, ivec2(idx + k, 0), 0).rgb;
  vec3 b = texelFetch(pal, ivec2(idx + min(k + 1, hi), 0), 0).rgb;
  return mix(a, b, f - float(k));
}`;

// Distance haze as the game does it: a haze level 0-4 from the distance, and
// level k > 0 maps palette index c to table[k - 1][c] (four 256-byte tables the
// game builds at 7BCE:7BC0). Track parts (0F47:188A): level = clamp((d - 10) >> 3,
// 0, 4), d = segments ahead (16 ft = 1024 fine units). Objects (0F47:8801) and
// bitmaps (0F47:1931): d = max(depth of the object's centre, size) in 1/8 ft,
// level = clamp(((clamp(d + 80h, 0, 3C00h) >> 8) - 5) >> 3, 0, 4). Mode 1 keeps
// the game's steps; mode 2 blends between them, centred on the game's steps.
const HAZE = `
uniform int uHazeMode;      // 0 off, 1 the game's steps, 2 smooth
uniform sampler2D uHaze;    // R8, 256 x 4: the game's haze tables
float trackHaze(float depth) {
  float d = depth / 1024.0;
  if (uHazeMode == 1) return clamp(floor((floor(d) - 10.0) / 8.0), 0.0, 4.0);
  return clamp((d - 14.0) / 8.0, 0.0, 4.0);
}
float objectHaze(float d8) {
  float v = clamp(d8 + 128.0, 0.0, 15360.0) / 256.0 - 5.0;
  if (uHazeMode == 1) return clamp(floor(max(floor(v), 0.0) / 8.0), 0.0, 4.0);
  return clamp((v - 4.0) / 8.0, 0.0, 4.0);
}
int hazed(int idx, int k) {
  return k == 0 ? idx : int(texelFetch(uHaze, ivec2(idx, k - 1), 0).r * 255.0 + 0.5);
}
vec3 hazeColour(sampler2D pal, int idx, float level) {
  int k = int(floor(level));
  vec3 a = texelFetch(pal, ivec2(hazed(idx, k), 0), 0).rgb;
  if (level <= float(k)) return a;
  return mix(a, texelFetch(pal, ivec2(hazed(idx, min(k + 1, 4)), 0), 0).rgb, level - float(k));
}`;

// Colours are RGB, or (palette index, -1, haze) looked up in the live palette,
// where haze is 0 (none: road, grass), 1 (track parts) or 2 + n (object n).
// In races the game fills colour 1Bh (the stands) with a crowd: pixels copied
// from a strip, each screen row starting at its own offset (0F47:142A). The
// game does it in screen space, so the crowd stays put on the screen while the
// stands move under it. Mode 2 (default) lays the same strip and row offsets on
// the stand itself: columns along the face, rows up it, a crowd texel 1.75 ft
// wide by 2.2 ft, about one spectator. Where texels get smaller than a pixel,
// they double in size step by step, along the face and up it separately (a stand seen at a slant
// shrinks along the face only), blending between steps, so a far crowd is
// still a speckle of people rather than a shimmer; uCrowdSharp keeps every texel.
// Mode 1 keeps the game's screen-space crowd.
const FS = `#version 300 es
precision highp float;
in vec3 vColour;
in float vDepth;
in vec2 vUv;
in vec3 vWorld;
uniform sampler2D uPalette;
uniform int uRoadIdx;
uniform int uCrowdSharp;       // 1: every texel at any distance (classic)
uniform sampler2D uCrowd;      // R8, 512 x 1: the crowd strip (palette indices)
uniform sampler2D uCrowdRows;  // R8, 64 x 1: each row's start offset
uniform vec2 uCell;            // canvas pixels per game pixel
uniform int uCrowdOn;           // 0 off, 1 screen space (the game's), 2 on the stands
uniform sampler2D uObjects;    // RGBA32F, 256 wide: each object's centre x, y and size (fine units)
uniform vec3 uCam;
uniform vec2 uSinCos;
out vec4 outColour;
${HAZE}
${GROUND_TEXTURE}
// the crowd strip at texel (uv / 2^lod), each row from its own start offset; each
// step takes rows further on in the table, so a coarser step is not a copy of the finer one
int crowdAt(vec2 uv, vec2 lod) {
  ivec2 c = ivec2(floor(uv / exp2(lod)));
  int r = int(texelFetch(uCrowdRows, ivec2((c.y + int(lod.x + lod.y) * 17) & 63, 0), 0).r * 255.0 + 0.5);
  return int(texelFetch(uCrowd, ivec2((c.x + r) & 511, 0), 0).r * 255.0 + 0.5);
}
void main() {
  if (vColour.y < 0.0) {
    int idx = int(vColour.x + 0.5);
    // the road only (it alone has u, v; a car part in the road's colour has none)
    if (uTexMode > 0 && idx == uRoadIdx && int(vColour.z + 0.5) == 0 && any(notEqual(vUv, vec2(0.0)))) {
      outColour = vec4(groundShade(uPalette, idx, groundNoise(vUv / vec2(32.0, 8.0)), -2, 1), 1.0);
      return;
    }
    int idx2 = -1; float blend = 0.0;  // a second crowd texel to blend in (mode 2, far away)
    if (uCrowdOn == 1 && idx == 27) {
      ivec2 c = ivec2(floor(gl_FragCoord.xy / uCell));
      int r = int(texelFetch(uCrowdRows, ivec2(c.y & 63, 0), 0).r * 255.0 + 0.5);
      idx = int(texelFetch(uCrowd, ivec2((c.x + r) & 511, 0), 0).r * 255.0 + 0.5);
    } else if (uCrowdOn == 2 && idx == 27) {
      // the stand's face from the position's derivatives: an axis along it (level) and one up it
      vec3 n = cross(dFdx(vWorld), dFdy(vWorld));
      vec2 th = vec2(-n.y, n.x);
      vec3 t = dot(th, th) > 1e-6 ? vec3(normalize(th), 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 b = normalize(cross(n, t));
      if (b.z < 0.0) b = -b;
      vec2 uv = vec2(dot(vWorld, t), dot(vWorld, b)) / vec2(112.0, 140.0); // 1.75 ft by 2.2 ft: about one spectator
      vec2 lod = uCrowdSharp == 1 ? vec2(0.0) : max(log2(fwidth(uv)) + 0.5, vec2(0.0));
      vec2 l0 = floor(lod), f = lod - l0;
      idx = crowdAt(uv, l0);
      // blend towards the next step on the axis nearer to it
      blend = max(f.x, f.y);
      if (blend > 0.0) idx2 = crowdAt(uv, l0 + (f.x >= f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)));
    }
    int cls = int(vColour.z + 0.5);
    float level = 0.0;
    if (uHazeMode > 0 && cls == 1) level = trackHaze(vDepth);
    else if (uHazeMode > 0 && cls >= 2) {
      vec4 o = texelFetch(uObjects, ivec2((cls - 2) & 255, (cls - 2) >> 8), 0);
      vec2 d = o.xy - uCam.xy;
      level = objectHaze(max(d.x * uSinCos.x + d.y * uSinCos.y, o.z) / 8.0);
    }
    vec3 colour = hazeColour(uPalette, idx, level);
    if (idx2 >= 0) colour = mix(colour, hazeColour(uPalette, idx2, level), blend);
    outColour = vec4(colour, 1.0);
  } else outColour = vec4(vColour, 1.0);
}`;

// Bitmaps (trees, boards, marshals): camera-facing quads; each atlas texel is
// a colour code 0-15 into the sprite's 16-colour object palette (255 = clear).
const SPRITE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in float aPal;
layout(location = 3) in float aBias;
uniform vec3 uCam;
uniform vec2 uSinCos;
uniform vec4 uProj;
uniform vec2 uDepth;
out vec2 vUv;
out float vDepth;
flat out int vPal;
void main() {
  vec3 d = aPos - uCam;
  float lat = d.x * uSinCos.y - d.y * uSinCos.x;
  float depth = d.x * uSinCos.x + d.y * uSinCos.y;
  float n = uDepth.x, f = uDepth.y;
  float dz = max(depth - aBias, n);   // drawn as if nearer by aBias
  gl_Position = vec4(uProj.x * lat, uProj.y * d.z + uProj.z * depth, ((dz * (f + n) - 2.0 * f * n) / ((f - n) * dz)) * depth, depth);
  vUv = aUv;
  vDepth = depth;
  vPal = int(aPal + 0.5);
}`;
const SPRITE_FS = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 vUv;
in float vDepth;
flat in int vPal;
uniform sampler2D uAtlas;   // R8: colour codes
uniform sampler2D uPalMap;  // R8, 256 x 9: object palettes (palette indices)
uniform sampler2D uPalette; // RGBA, 256 x 1: the live palette
out vec4 outColour;
${HAZE}
void main() {
  int code = int(texelFetch(uAtlas, ivec2(floor(vUv)), 0).r * 255.0 + 0.5);
  if (code >= 255) discard;
  int n = vPal + code;
  int idx = int(texelFetch(uPalMap, ivec2(n % 256, n / 256), 0).r * 255.0 + 0.5);
  // a bitmap faces the camera, so every pixel has its anchor's depth
  outColour = vec4(hazeColour(uPalette, idx, uHazeMode > 0 ? objectHaze(vDepth / 8.0) : 0.0), 1.0);
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
uniform vec2 uOrigin;    // the viewport's lower left corner in the canvas (pixels)
uniform vec3 uGround;
uniform int uUseScene;   // 1: sky and horizon from the game's tables
uniform int uImage;      // 1: draw the horizon image
uniform sampler2D uSky;  // sky colours, one texel per 4 game rows above the sky base
uniform sampler2D uHorizon; // 512 x 8 horizon image
uniform float uSkyLen;
uniform vec3 uSkyTop, uSkyHorizon;
uniform sampler2D uPalette;
uniform int uGroundIdx, uRoadIdx;
uniform vec3 uCam;       // camera relative to the origin (fine units, Z units)
uniform vec2 uSinCos;
uniform vec4 uProj;      // as the track's: sx, sy, cy
uniform float uCamH;     // camera height over the ground (Z units)
out vec4 outColour;
${GROUND_TEXTURE}
void main() {
  float row = (1.0 - vY) * 0.5 * uView.y;          // game viewport row from the top
  float above = uView.x - row;                       // rows above the horizon row
  if (above <= 0.0) {
    if (uTexMode == 0 || uUseScene == 0) { outColour = vec4(uGround, 1.0); return; }
    // the ground plane under the camera: where this pixel's ray meets it (the track's projection inverted)
    float xn = ((gl_FragCoord.x - uOrigin.x) / uCanvas.x) * 2.0 - 1.0;
    float depth = uProj.y * uCamH / max(uProj.z - vY, 1e-4);
    float lat = xn * depth / uProj.x;
    vec2 w = uCam.xy + vec2(lat * uSinCos.y + depth * uSinCos.x, -lat * uSinCos.x + depth * uSinCos.y);
    outColour = vec4(groundShade(uPalette, uGroundIdx, groundNoise(w / (64.0 * 16.0)), uGroundIdx == uRoadIdx ? -2 : -1, 1), 1.0);
    return;
  }
  if (uUseScene == 0) {
    float t = clamp(above / uView.x, 0.0, 1.0);
    outColour = vec4(mix(uSkyHorizon, uSkyTop, t), 1.0);
    return;
  }
  float xn = ((gl_FragCoord.x - uOrigin.x) / uCanvas.x) * 2.0 - 1.0;
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

// the cars' shadows (modern style): soft, dark, on the ground, fading with distance
const SHADOW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
uniform vec3 uCam;
uniform vec2 uSinCos;
uniform vec4 uProj;
uniform vec2 uDepth;
out vec2 vUv;
out float vDepth;
void main() {
  vec3 d = aPos - uCam;
  float lat = d.x * uSinCos.y - d.y * uSinCos.x;
  float depth = d.x * uSinCos.x + d.y * uSinCos.y;
  float n = uDepth.x, f = uDepth.y;
  gl_Position = vec4(uProj.x * lat, uProj.y * d.z + uProj.z * depth, (depth * (f + n) - 2.0 * f * n) / (f - n), depth);
  vUv = aUv;
  vDepth = depth;
}`;
const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vDepth;
out vec4 outColour;
void main() {
  // a rounded box, dark to near its edge, soft there; gone by 1,500 ft
  vec2 a = abs(vUv);
  float r = pow(pow(a.x, 4.0) + pow(a.y, 4.0), 0.25);
  float k = 0.55 * (1.0 - smoothstep(0.7, 1.0, r)) * (1.0 - smoothstep(800.0 * 64.0, 1500.0 * 64.0, vDepth));
  outColour = vec4(0.0, 0.0, 0.0, k);
}`;

// flat shapes in clip space: the mirrors' glass into the stencil
const FLAT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FLAT_FS = `#version 300 es
precision mediump float;
out vec4 outColour;
void main() { outColour = vec4(0.0); }`;

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
    // the stencil holds the mirrors' glass (drawMirrors)
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, stencil: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.prog = program(gl, VS, FS);
    this.bgProg = program(gl, BG_VS, BG_FS);
    this.u = Object.fromEntries(['uCam', 'uSinCos', 'uProj', 'uDepth', 'uPalette', 'uCrowd', 'uCrowdRows', 'uCell', 'uCrowdOn',
      'uHazeMode', 'uHaze', 'uObjects', 'uNoise', 'uTexMode', 'uRoadIdx', 'uCrowdSharp', 'uPole']
      .map((n) => [n, gl.getUniformLocation(this.prog, n)]));
    this.paletteTex = gl.createTexture();
    this.spriteProg = program(gl, SPRITE_VS, SPRITE_FS);
    this.spU = Object.fromEntries(['uCam', 'uSinCos', 'uProj', 'uDepth', 'uAtlas', 'uPalMap', 'uPalette', 'uHazeMode', 'uHaze'].map((n) => [n, gl.getUniformLocation(this.spriteProg, n)]));
    this.objects = null;
    this.bgU = Object.fromEntries(['uView', 'uCanvas', 'uOrigin', 'uGround', 'uUseScene', 'uImage', 'uSky', 'uHorizon', 'uSkyLen', 'uSkyTop', 'uSkyHorizon',
      'uPalette', 'uGroundIdx', 'uRoadIdx', 'uCam', 'uSinCos', 'uProj', 'uCamH', 'uNoise', 'uTexMode']
      .map((n) => [n, gl.getUniformLocation(this.bgProg, n)]));
    this.sceneTex = null;
    this.bg = gl.createVertexArray();
    gl.bindVertexArray(this.bg);
    const bgBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // the cars' shadows: x, y, z, u, v
    this.shadowProg = program(gl, SHADOW_VS, SHADOW_FS);
    this.shU = Object.fromEntries(['uCam', 'uSinCos', 'uProj', 'uDepth'].map((n) => [n, gl.getUniformLocation(this.shadowProg, n)]));
    this.shadowVao = gl.createVertexArray();
    gl.bindVertexArray(this.shadowVao);
    this.shadowVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    // flat shapes in the canvas's clip space, for the stencil (the mirrors' glass)
    this.flatProg = program(gl, FLAT_VS, FLAT_FS);
    this.flatVao = gl.createVertexArray();
    gl.bindVertexArray(this.flatVao);
    this.flatVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.flip = false;   // the projection mirrored left to right (drawMirrors): faces wind the other way
    this.cull = null;    // { half, margin, far }: draw only the objects near a narrow view (drawMirrors)
    this.track = null;
    this.cars = { vao: gl.createVertexArray(), buf: gl.createBuffer(), count: 0 };
    this.ground = COLOURS.ground;
    // bitmaps (objects and cars): x, y, z, u, v, palette offset, depth bias
    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);
    this.spriteVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);
    this.carFrame = null;
    // placeholders for samplers with nothing to read yet
    this.hazeTex = this.texture(gl.R8, 256, 4, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1024));
    // the ground texture: tileable noise, mipmapped and repeating
    this.noiseTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 256, 0, gl.RED, gl.UNSIGNED_BYTE, groundNoise(256));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.REPEAT);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    this.noObjectsTex = this.texture(gl.RGBA32F, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
  }

  /** A NEAREST, clamped 2D texture. */
  texture(internal, w, h, format, type, data) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return t;
  }

  /** The game's four haze tables (1024 bytes, objects.mjs readObjects().haze). */
  setHaze(tables) {
    if (!tables || tables.length < 1024) return;
    if (this.lastHaze && this.lastHaze.every((v, i) => v === tables[i])) return;
    this.lastHaze = Uint8Array.from(tables.subarray(0, 1024));
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.hazeTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 4, 0, gl.RED, gl.UNSIGNED_BYTE, this.lastHaze);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
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
    const mesh = buildSceneMesh(scene, { indexed: true, uv: true });
    // a rebuild (the game rewrote its markings) replaces the track's buffers
    if (this.track && this.track.buf) { gl.deleteBuffer(this.track.buf); gl.deleteVertexArray(this.track.vao); }
    this.scene = scene;
    this.origin = [mesh.origin[0], mesh.origin[1], 0];
    this.groundIndex = opt.surroundRoad ? scene.road : scene.grass;
    this.groundSegs = [...scene.lap.filter(Boolean), ...scene.pit];
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const bytes = mesh.stride * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, bytes, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, bytes, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, bytes, 24);
    this.track = { vao, buf, count: mesh.data.length / mesh.stride, parts: mesh.counts, ranges: mesh.ranges };
    this.lastPalette = null; // the sky and horizon textures belong to the scene
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
   * Trackside objects read from the game's memory (objects.mjs readObjects):
   * stands, buildings, bridges, boards, trees. Built once per circuit as the
   * game's per-sector display lists; each frame picks what the game would
   * draw from the camera's angle to each object.
   * @param {object} objs   readObjects(mem)
   * @param {object} crowd  readCrowd(mem) (crowd.active: race crowds in the stands)
   * @param {object} [opt]  { cars: readCars(mem), to add the cars' bitmaps (wheels, helmets,
   *                          far cars) to the atlas: the game's bitmap store is shared }
   */
  setObjects(objs, crowd = { active: true }, opt = {}) {
    const gl = this.gl, origin = [this.origin[0], this.origin[1]];
    const meshFor = (set) => {
      const mesh = buildSectorMesh(objs, { indexed: true, origin, crowd: crowd.active, set });
      // the haze channel: 2 + the object the vertex belongs to (the game hazes whole objects)
      for (let k = 0; k < mesh.vertexObject.length; k++) mesh.data[k * 6 + 5] = 2 + mesh.vertexObject[k];
      for (let k = 0; k < mesh.lineObject.length; k++) mesh.lines[k * 6 + 5] = 2 + mesh.lineObject[k];
      const nObj = Math.max(mesh.objects.length, 1), rowsObj = Math.ceil(nObj / 256);
      const centres = new Float32Array(256 * rowsObj * 4);
      mesh.objects.forEach((ob, k) => centres.set([ob.x, ob.y, ob.size, 0], k * 4));
      const objTex = this.texture(gl.RGBA32F, 256, rowsObj, gl.RGBA, gl.FLOAT, centres);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const ebo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      // the poles: strips the vertex shader widens (aSide)
      const lineVao = gl.createVertexArray();
      gl.bindVertexArray(lineVao);
      const lvbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, lvbo);
      const strips = poleStrips(mesh.lines);
      gl.bufferData(gl.ARRAY_BUFFER, strips.length ? strips : new Float32Array(7), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 28, 24);
      const lebo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lebo);
      gl.bindVertexArray(null);
      return { mesh, vao, ebo, lineVao, lebo, objTex };
    };
    const track = meshFor('track'), pit = meshFor('pit');
    const ids = new Set(spriteIdsUsed(objs));
    if (opt.cars) for (const id of carSpriteIds(opt.cars)) ids.add(id);
    const atlas = buildSpriteAtlas(objs, [...ids]);
    const r8 = (w, h, data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      return t;
    };
    const atlasTex = r8(atlas.width, Math.max(atlas.height, 1), atlas.data);
    const palMap = new Uint8Array(256 * 9);
    palMap.set(objs.palettes.subarray(0, palMap.length));
    const palMapTex = r8(256, 9, palMap);
    let crowdTex = null, crowdRowsTex = null;
    if (crowd.active && crowd.strips && crowd.rows) {
      crowdTex = r8(512, 1, crowd.strips[0].subarray(0, 512));
      crowdRowsTex = r8(64, 1, crowd.rows.subarray(0, 64));
    }
    this.objects = { objs, track, pit, atlas, atlasTex, palMapTex, crowdTex, crowdRowsTex };
    this.sprites = { atlas, atlasTex, palMapTex };
    this.setHaze(objs.haze);
    return { track: track.mesh.counts, pit: pit.mesh.counts, atlas: [atlas.width, atlas.height] };
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
   * The cars' bitmaps alone, when no objects are loaded (setObjects builds one
   * atlas for both).
   * @param {object} cars  readCars(mem)
   */
  setCarSprites(cars) {
    const atlas = buildSpriteAtlas(cars, carSpriteIds(cars));
    const palMap = new Uint8Array(256 * 9);
    palMap.set(cars.palettes.subarray(0, palMap.length));
    const gl = this.gl;
    this.sprites = {
      atlas,
      atlasTex: this.texture(gl.R8, atlas.width, Math.max(atlas.height, 1), gl.RED, gl.UNSIGNED_BYTE, atlas.data),
      palMapTex: this.texture(gl.R8, 256, 9, gl.RED, gl.UNSIGNED_BYTE, palMap),
    };
    this.setHaze(cars.haze);
  }

  /**
   * The cars as the game draws them this frame (cars.mjs frameCars, indexed
   * colours, origin = this.origin): triangles by decal layer, lines, and
   * bitmaps (wheels, helmets, far cars), with the game's per-object haze.
   * Replaces the boxes of setCars().
   * @param {object} fc    frameCars() result
   * @param {object} cars  readCars(mem)
   * @param {string} [set] the buffers to use: 'main', or one per mirror (drawMirrors)
   */
  setCarFrame(fc, cars, set = 'main') {
    const gl = this.gl;
    this.carGls ??= {};
    if (!this.carGls[set]) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const ebo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      const lineVao = gl.createVertexArray();
      gl.bindVertexArray(lineVao);
      const lvbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, lvbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const lebo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lebo);
      // modern style's wheels and helmets: shaded RGB triangles
      const solidVao = gl.createVertexArray();
      gl.bindVertexArray(solidVao);
      const svbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, svbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      this.carGls[set] = { vao, vbo, ebo, lineVao, lvbo, lebo, solidVao, svbo, objTex: gl.createTexture() };
    }
    const G = this.carGls[set], m = fc.mesh;
    // the haze channel: 2 + the car part the vertex belongs to (hazed as a whole, like objects)
    for (let k = 0; k < m.vertexObject.length; k++) m.data[k * 6 + 5] = 2 + m.vertexObject[k];
    for (let k = 0; k < m.lineObject.length; k++) m.lines[k * 6 + 5] = 2 + m.lineObject[k];
    gl.bindBuffer(gl.ARRAY_BUFFER, G.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.data.length ? m.data : new Float32Array(6), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.lvbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.lines.length ? m.lines : new Float32Array(6), gl.DYNAMIC_DRAW);
    if (fc.solid && fc.solid.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, G.svbo);
      gl.bufferData(gl.ARRAY_BUFFER, fc.solid, gl.DYNAMIC_DRAW);
    }
    const rows = Math.max(1, Math.ceil(m.objects.length / 256));
    const centres = new Float32Array(256 * rows * 4);
    m.objects.forEach((ob, k) => centres.set([ob.x, ob.y, ob.size, 0], k * 4));
    gl.bindTexture(gl.TEXTURE_2D, G.objTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, rows, 0, gl.RGBA, gl.FLOAT, centres);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    this.carFrame = { fc, cars, G };
  }

  /**
   * The ground's height near (x, y) (fine units): the height of the nearest
   * segment of the lap or pit lane, for the ground plane of the texture.
   */
  groundZ(x, y) {
    const segs = this.groundSegs;
    if (!segs || !segs.length) return 0;
    const d2 = (s) => (s.x - x) ** 2 + (s.y - y) ** 2;
    // look near the last answer first: the camera moves a few segments per frame
    let best = this.groundAt ?? 0, bestD = d2(segs[best]);
    for (let k = -24; k <= 24; k++) {
      const i = (best + k + segs.length) % segs.length, d = d2(segs[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > (1024 * 4) ** 2) for (let i = 0; i < segs.length; i++) { const d = d2(segs[i]); if (d < bestD) { bestD = d; best = i; } }
    this.groundAt = best;
    return segs[best].z;
  }

  /**
   * Draw one frame.
   * @param {object} cam  { x, y (fine), z, heading, horizon (row), rows (viewport rows), top (first screen row) }
   * @param {object} [opt] { framing: 'original'|'wide'|'screen'|'stage', haze: 'off' (default) | 'classic' (the
   *   game's steps) | 'smooth', texture: 'off' (default) | 'classic' (the game's shades) | 'smooth' (the
   *   ground texture, with setScene), crowd: 'stands' (default: on the stands, coarser texels far
   *   away) | 'sharp' (on the stands, every texel) | 'screen' (the game's, fixed to the screen),
   *   poles: 'solid' (default: six inches wide, at least one game pixel) | 'pixel' (one game pixel
   *   wide, as the game draws them), pitLane: true when the camera is in the pit lane }
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
    // The game's viewport is 320 columns by cam.rows rows, shown at 4:3 (each
    // row 1.2 columns tall). In 'wide' framing the canvas keeps the vertical
    // scale and shows more to the sides. In 'stage' framing the canvas height
    // is the game's whole 200-row screen, with the 3D view's rows at
    // cam.top..cam.top+cam.rows as on the game's screen, and the 3D fills
    // the rest too (under the game's cockpit and bars, laid over it); the
    // game's 320 columns are the middle 4:3 of the canvas.
    const stage = opt.framing === 'stage';
    const rows = stage ? 200 : cam.rows;
    const horizon = stage ? cam.top + cam.horizon : cam.horizon;
    const nativeAspect = 320 / (rows * 1.2);
    const aspect = w / h;
    const xScale = opt.framing === 'wide' || stage ? nativeAspect / aspect : 1;
    this.pass(cam, opt, { x: 0, y: y0, w, h, rows, horizon, xScale });
  }

  /**
   * Draw the scene into a viewport of the canvas.
   * @param {object} v  { x, y, w, h: the viewport (canvas pixels, from the lower left), rows, horizon:
   *   the game rows it shows and the horizon's row in them, xScale: the game's columns across it
   *   (1: 320 columns; negative: mirrored left to right) }
   */
  pass(cam, opt, v) {
    const gl = this.gl;
    const { w, h, rows, horizon, xScale } = v;
    gl.viewport(v.x, v.y, w, h);
    const sx = (256 / 160) * xScale;
    const sy = (2 * VSCALE) / rows;
    const cy = 1 - (2 * horizon) / rows;
    const o = this.origin || [0, 0, 0];
    const a = (cam.heading / 65536) * 2 * Math.PI;

    // the ground texture: the noise on unit 7, the palette for the ground's shades on unit 2
    const texMode = this.scene ? ({ classic: 1, smooth: 2 }[opt.texture] ?? 0) : 0;
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.bgProg);
    gl.uniform1i(this.bgU.uTexMode, texMode);
    gl.uniform1i(this.bgU.uNoise, 7);
    gl.uniform1i(this.bgU.uPalette, 2);
    if (texMode) {
      gl.uniform1i(this.bgU.uGroundIdx, this.groundIndex);
      gl.uniform1i(this.bgU.uRoadIdx, this.scene.road);
      gl.uniform3f(this.bgU.uCam, cam.x - o[0], cam.y - o[1], cam.z);
      gl.uniform2f(this.bgU.uSinCos, Math.sin(a), Math.cos(a));
      gl.uniform4f(this.bgU.uProj, sx, sy, cy, 0);
      gl.uniform1f(this.bgU.uCamH, Math.max(8, cam.z - this.groundZ(cam.x, cam.y)));
    }
    gl.uniform4f(this.bgU.uView, horizon, rows, xScale, (cam.heading >> 5) & 511);
    gl.uniform2f(this.bgU.uCanvas, w, h);
    gl.uniform2f(this.bgU.uOrigin, v.x, v.y);
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
    const O = this.objects;
    if (O && O.crowdTex) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, O.crowdTex); gl.uniform1i(this.u.uCrowd, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, O.crowdRowsTex); gl.uniform1i(this.u.uCrowdRows, 4);
      gl.uniform1i(this.u.uCrowdOn, opt.crowd === 'screen' ? 1 : 2);
      gl.uniform1i(this.u.uCrowdSharp, opt.crowd === 'sharp' ? 1 : 0);
    } else {
      // the samplers still need valid units
      gl.uniform1i(this.u.uCrowd, 0); gl.uniform1i(this.u.uCrowdRows, 0);
      gl.uniform1i(this.u.uCrowdOn, 0);
    }
    gl.uniform2f(this.u.uCell, Math.abs(w * xScale) / 320, h / rows);
    // a pole's half-width: one game pixel wide (xScale / 160 of the screen across), or 6 inches
    // wide and at least one game pixel (and two canvas pixels)
    const xs = Math.abs(xScale);
    this.poleWidth = opt.poles === 'pixel' ? [0, xs / 320] : [16, Math.max(xs / 320, 2 / w)];
    const hazeMode = { classic: 1, smooth: 2 }[opt.haze] ?? 0;
    this.hazeMode = hazeMode;
    gl.uniform1i(this.u.uHazeMode, hazeMode);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.hazeTex); gl.uniform1i(this.u.uHaze, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.noObjectsTex); gl.uniform1i(this.u.uObjects, 6);
    gl.uniform1i(this.u.uNoise, 7);
    gl.uniform1i(this.u.uTexMode, texMode);
    gl.uniform1i(this.u.uRoadIdx, this.scene ? this.scene.road : -1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(this.u.uCam, cam.x - o[0], cam.y - o[1], cam.z);
    gl.uniform2f(this.u.uSinCos, Math.sin(a), Math.cos(a));
    gl.uniform4f(this.u.uProj, sx, sy, cy, 0);
    gl.uniform2f(this.u.uDepth, 64, 64 * 16 * 1200); // 1 ft to about 6 km
    this.lastUniforms = { cam: [cam.x - o[0], cam.y - o[1], cam.z], sinCos: [Math.sin(a), Math.cos(a)], proj: [sx, sy, cy, 0], depth: [64, 64 * 16 * 1200] };
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
    if (this.objects) this.drawObjects(cam, opt);
    if (this.carFrame) this.drawCars(cam);
    else if (this.cars.count) {
      gl.bindVertexArray(this.cars.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.cars.count);
    }
  }
}

/** The front-face winding for this pass: mirrored passes wind the other way. */
TrackRenderer.prototype.front = function front(winding) {
  const gl = this.gl;
  return this.flip ? (winding === gl.CCW ? gl.CW : gl.CCW) : winding;
};

/**
 * The cockpit mirrors as real rear views, after draw() in the 'stage' framing
 * (the game's 320 x 200 screen is the middle 4:3 of the canvas). Each mirror is
 * the scene seen from the camera turned by the game's mirror angle (0F47:8A09:
 * R:005A 9000h left, R:005C 7000h right), mirrored left to right, at a quarter
 * of the main view's scale, with the horizon on row 123 and the mirror's centre
 * on column 160 -/+ 140 (cars.mjs mirrorImage), drawn only on its glass (the
 * game's outline rows 116-137, cars.mjs mirrorClip) through the stencil.
 * @param {object} cam   the main view's camera
 * @param {object} opt   draw()'s options
 * @param {{ glass: object[], sides: { side: 'left'|'right', angle: number, frame?: object }[], cars?: object }} m
 *   glass: mirrorClip(); per side its angle and the cars seen from it (frameCars with the turned camera)
 */
TrackRenderer.prototype.drawMirrors = function drawMirrors(cam, opt, m) {
  const gl = this.gl, cv = this.canvas, W = cv.width, H = cv.height;
  const w43 = Math.min(W, (H * 4) / 3), x0 = (W - w43) / 2, colPx = w43 / 320, rowPx = H / 200;
  const X = (col) => x0 + col * colPx, Y = (row) => H - row * rowPx;   // canvas pixels from the lower left
  const ndc = (x, y) => [(2 * x) / W - 1, (2 * y) / H - 1];
  gl.enable(gl.SCISSOR_TEST);
  gl.enable(gl.STENCIL_TEST);
  for (const sd of m.sides) {
    const left = sd.side === 'left';
    const c0 = left ? 0 : 280;
    const box = { x: Math.round(X(c0)), y: Math.round(Y(138)) };
    box.w = Math.round(X(c0 + 40)) - box.x; box.h = Math.round(Y(116)) - box.y;
    if (box.w < 1 || box.h < 1) continue;
    gl.scissor(box.x, box.y, box.w, box.h);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // the glass, row by row, into the stencil
    const tris = [];
    for (const r of m.glass) {
      if (!r.active) continue;
      const a = left ? r.left : r.gapRight, b = left ? r.gapLeft : r.right;
      if (b <= a) continue;
      const [ax, ay] = ndc(X(a), Y(r.row + 1)), [bx, by] = ndc(X(b), Y(r.row));
      tris.push(ax, ay, bx, ay, ax, by, bx, ay, bx, by, ax, by);
    }
    if (!tris.length) continue;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.useProgram(this.flatProg);
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    // the rear view: 22 rows at a quarter scale are 88 of the main view's, the horizon (row 123) 28 down;
    // 40 columns at a quarter scale are 160, mirrored
    const saved = this.carFrame;
    if (sd.frame && m.cars) this.setCarFrame(sd.frame, m.cars, sd.side); else this.carFrame = null;
    this.flip = true;
    // the objects near the mirror's view: 17 degrees either side, a margin for big stands, 4,000 ft
    this.cull = { half: 20 / 64, margin: 400 * 64, far: 4000 * 64 };
    try {
      this.pass({ ...cam, heading: (cam.heading + sd.angle) & 0xffff }, opt, { ...box, rows: 88, horizon: 28, xScale: -2 });
    } finally {
      this.flip = false;
      this.cull = null;
      this.carFrame = saved;
    }
  }
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, W, H);
};

/** The cars' shadows (frameCars().shadows, modern style): on the road, under the cars, blended. */
TrackRenderer.prototype.drawShadows = function drawShadows(quads) {
  const gl = this.gl, u = this.shU, k = this.lastUniforms;
  gl.useProgram(this.shadowProg);
  gl.uniform3f(u.uCam, ...k.cam);
  gl.uniform2f(u.uSinCos, ...k.sinCos);
  gl.uniform4f(u.uProj, ...k.proj);
  gl.uniform2f(u.uDepth, ...k.depth);
  gl.bindVertexArray(this.shadowVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowVbo);
  gl.bufferData(gl.ARRAY_BUFFER, quads, gl.DYNAMIC_DRAW);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-4, -16);
  gl.drawArrays(gl.TRIANGLES, 0, quads.length / 5);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.useProgram(this.prog);
};

/** Bitmap quads (7 floats per vertex) with the sprite program and the shared atlas. */
TrackRenderer.prototype.drawSprites = function drawSprites(quads) {
  const gl = this.gl, S = this.sprites;
  if (!quads.length || !S) return;
  gl.useProgram(this.spriteProg);
  const u = this.spU, k = this.lastUniforms;
  gl.uniform3f(u.uCam, ...k.cam);
  gl.uniform2f(u.uSinCos, ...k.sinCos);
  gl.uniform4f(u.uProj, ...k.proj);
  gl.uniform2f(u.uDepth, ...k.depth);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.atlasTex); gl.uniform1i(u.uAtlas, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, S.palMapTex); gl.uniform1i(u.uPalMap, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.paletteTex); gl.uniform1i(u.uPalette, 2);
  gl.uniform1i(u.uHazeMode, this.hazeMode); gl.uniform1i(u.uHaze, 5);
  gl.bindVertexArray(this.spriteVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVbo);
  gl.bufferData(gl.ARRAY_BUFFER, quads, gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, quads.length / 7);
  gl.useProgram(this.prog);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
};

/** The cars of setCarFrame(): one-sided polygons by layer, lines, then bitmaps. */
TrackRenderer.prototype.drawCars = function drawCars(cam) {
  const gl = this.gl, { fc, cars, G } = this.carFrame;
  if (fc.shadows && fc.shadows.length) this.drawShadows(fc.shadows);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, G.objTex);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(this.front(this.objectFrontFace ?? gl.CCW));
  gl.bindVertexArray(G.vao);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.ebo);
  fc.frame.layers.forEach((idx, k) => {
    if (!idx.length) return;
    if (k > 0) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4 * k); gl.depthFunc(gl.LEQUAL); }
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
  });
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.depthFunc(gl.LESS);
  if (fc.solid && fc.solid.length) {
    // modern style: wheels and helmets, counter-clockwise seen from outside
    gl.frontFace(this.front(gl.CCW));
    gl.bindVertexArray(G.solidVao);
    gl.drawArrays(gl.TRIANGLES, 0, fc.solid.length / 6);
  }
  gl.disable(gl.CULL_FACE);
  if (fc.frame.lines.length) {
    gl.bindVertexArray(G.lineVao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.lebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, fc.frame.lines, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.LINES, fc.frame.lines.length, gl.UNSIGNED_INT, 0);
  }
  if (this.sprites) this.drawSprites(carSpriteQuads(fc, this.sprites.atlas, { x: cam.x, y: cam.y, heading: cam.heading }, cars));
  this.lastCars = { cars: fc.mesh.counts.cars, triangles: fc.mesh.counts.triangles, sprites: fc.frame.sprites.length };
};

TrackRenderer.prototype.drawObjects = function drawObjects(cam, opt) {
  const gl = this.gl, O = this.objects;
  const set = opt.pitLane ? O.pit : O.track;
  // a narrow view (the mirrors) takes only the objects near its view cone
  const C = this.cull, mesh = set.mesh;
  let filter;
  if (C) {
    const h = (cam.heading / 65536) * 2 * Math.PI, si = Math.sin(h), co = Math.cos(h);
    filter = (i) => {
      const c = mesh.placements[i].centre, dx = c[0] + mesh.origin[0] - cam.x, dy = c[1] + mesh.origin[1] - cam.y;
      const dep = dx * si + dy * co, lat = dx * co - dy * si;
      return dep > -C.margin && dep < C.far && Math.abs(lat) < Math.max(dep, 0) * C.half + C.margin;
    };
  }
  const fr = frameObjects(mesh, { x: cam.x, y: cam.y, heading: cam.heading }, { lod: true, filter });
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, set.objTex);
  gl.activeTexture(gl.TEXTURE0);
  // one-sided polygons, layer by layer (later layers are coplanar details on top)
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(this.front(this.objectFrontFace ?? gl.CCW));
  gl.bindVertexArray(set.vao);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, set.ebo);
  fr.layers.forEach((idx, k) => {
    if (!idx.length) return;
    if (k > 0) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4 * k); gl.depthFunc(gl.LEQUAL); }
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
  });
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.depthFunc(gl.LESS);
  gl.disable(gl.CULL_FACE);
  // poles (flag poles, posts): one-pixel vertical lines in the game; strips here, one game
  // pixel wide in the classic style, six inches (at least two pixels) in the modern one
  if (fr.lines.length) {
    gl.uniform2f(this.u.uPole, ...this.poleWidth);
    gl.bindVertexArray(set.lineVao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, set.lebo);
    const tris = poleTriangles(fr.lines);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tris, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, tris.length, gl.UNSIGNED_INT, 0);
  }
  // bitmaps
  this.drawSprites(spriteQuads(set.mesh.sprites, O.atlas, { x: cam.x, y: cam.y, heading: cam.heading }, O.objs, set.mesh.origin, fr.sprites, set.mesh.placements));
  this.lastObjects = { layers: fr.layers.map((l) => l.length / 3), lines: fr.lines.length / 2, sprites: fr.sprites.length };
};

/**
 * Tileable noise for the ground texture: value noise in six octaves, from 4 to
 * 128 cells across, bytes around 128 (standard deviation about 50). Fixed seed.
 * @returns {Uint8Array} size x size
 */
/**
 * The poles of a line list (x, y, z, r, g, b per vertex, a pair per pole) as
 * strips for the vertex shader to widen: per pole its two ends, each on both
 * sides (side -1 and 1 as a seventh float), vertices 4l..4l+3.
 */
export function poleStrips(lines) {
  const n = lines.length / 12, out = new Float32Array(n * 28);
  for (let l = 0; l < n; l++) {
    for (let e = 0; e < 2; e++) {
      for (let s = 0; s < 2; s++) {
        const o = (l * 4 + e * 2 + s) * 7;
        out.set(lines.subarray((l * 2 + e) * 6, (l * 2 + e) * 6 + 6), o);
        out[o + 6] = s ? 1 : -1;
      }
    }
  }
  return out;
}

/** The strips' triangles for a frame's poles (vertex index pairs 2l, 2l + 1 into the line list). */
export function poleTriangles(pairs) {
  const out = new Uint32Array((pairs.length / 2) * 6);
  for (let i = 0; i < pairs.length / 2; i++) {
    const b = (pairs[2 * i] >> 1) * 4;
    out.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  }
  return out;
}

export function groundNoise(size = 256) {
  const out = new Float32Array(size * size);
  let seed = 0x9e3779b9;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const smooth = (t) => t * t * (3 - 2 * t);
  let amp = 1;
  for (const cells of [4, 8, 16, 32, 64, 128]) {
    const lattice = Float32Array.from({ length: cells * cells }, rand);
    const at = (i, j) => lattice[((j + cells) % cells) * cells + ((i + cells) % cells)];
    for (let y = 0; y < size; y++) {
      const fy = (y * cells) / size, j = Math.floor(fy), ty = smooth(fy - j);
      for (let x = 0; x < size; x++) {
        const fx = (x * cells) / size, i = Math.floor(fx), tx = smooth(fx - i);
        const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tx, bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
        out[y * size + x] += amp * (top + (bottom - top) * ty - 0.5);
      }
    }
    amp *= 0.75;
  }
  let sum = 0, sq = 0;
  for (const v of out) { sum += v; sq += v * v; }
  const mean = sum / out.length, sd = Math.sqrt(sq / out.length - mean * mean) || 1;
  return Uint8Array.from(out, (v) => Math.max(0, Math.min(255, Math.round(128 + ((v - mean) / sd) * 50))));
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
