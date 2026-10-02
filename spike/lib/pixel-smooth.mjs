// The game's 320 x 200 picture drawn larger with a filter made for pixel art,
// for the cockpit, dash and messages laid over our view (render.html,
// cockpit=smooth). The filter is xBR level 2 (Hyllian's edge rules, 2011),
// written here as one WebGL2 pass at the canvas's own resolution.
//
// For each source pixel E and each of its four corners, xBR weighs how much
// the picture changes along the two diagonals around that corner; when it
// changes less along the diagonal that crosses the corner, an edge runs
// there, and the corner of E takes the colour of the nearer of the two
// neighbours beyond the edge. Level 2 also follows shallow (2:1) and steep
// (1:2) edges. Each output pixel is covered by the corner cut it falls in,
// with a soft edge one output pixel wide.
//
// Neighbourhood of E (rows down):
//            A1 B1 C1
//         A0  A  B  C  C4
//         D0  D  E  F  F4
//         G0  G  H  I  I4
//            G5 H5 I5
// The four corners run side by side in vec4s, bottom right (x), top right
// (y), top left (z), bottom left (w): each is the bottom right one turned a
// quarter more, so for corner k, f is the neighbour on one side of the corner
// and h the one on the other, i the pixel across the corner, and so on.
//
// The see-through pixels (our view under the overlay) count as one colour of
// their own, far from every other, so the overlay's outline is smoothed
// against the view; colours are blended premultiplied, without fringes.
//
// Plain ES module, browser only.

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;   // RGBA, 320 x 200, row 0 the top
uniform vec2 uSrcSize;    // 320, 200
uniform vec2 uOut;        // the canvas in pixels
out vec4 outColour;

const vec3 Y = vec3(0.2126, 0.7152, 0.0722) * 48.0;
const float EQ = 15.0;          // luma steps (of 48) that count as equal
const float LV2 = 2.0;          // how much more alike for a shallow or steep edge

vec4 px(ivec2 p) {
  vec4 c = texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uSrcSize) - 1), 0);
  return vec4(c.rgb * c.a, c.a);  // premultiplied
}
float luma(vec4 c) { return c.a > 0.5 ? dot(c.rgb / c.a, Y) : -64.0; }
vec4 df(vec4 a, vec4 b) { return abs(a - b); }
vec4 diff(vec4 a, vec4 b) { return vec4(notEqual(a, b)); }
vec4 eq(vec4 a, vec4 b) { return step(df(a, b), vec4(EQ)); }
vec4 neq(vec4 a, vec4 b) { return 1.0 - eq(a, b); }
vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) {
  return df(a, b) + df(a, c) + df(d, e) + df(d, f) + 4.0 * df(g, h);
}
float cdf(vec4 a, vec4 b) { vec4 d = abs(a - b); return d.r + d.g + d.b + d.a; }

void main() {
  // the source position of this output pixel, rows down
  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y) * uSrcSize / uOut;
  ivec2 ip = ivec2(floor(p));
  vec2 fp = fract(p);
  #define T(dx, dy) px(ip + ivec2(dx, dy))
  vec4 A1 = T(-1, -2), B1 = T(0, -2), C1 = T(1, -2);
  vec4 A0 = T(-2, -1), A = T(-1, -1), B = T(0, -1), C = T(1, -1), C4 = T(2, -1);
  vec4 D0 = T(-2, 0), D = T(-1, 0), E = T(0, 0), F = T(1, 0), F4 = T(2, 0);
  vec4 G0 = T(-2, 1), G = T(-1, 1), H = T(0, 1), I = T(1, 1), I4 = T(2, 1);
  vec4 G5 = T(-1, 2), H5 = T(0, 2), I5 = T(1, 2);

  // lumas, corner by corner (bottom right, top right, top left, bottom left)
  vec4 b = vec4(luma(B), luma(D), luma(H), luma(F));
  vec4 c = vec4(luma(C), luma(A), luma(G), luma(I));
  vec4 e = vec4(luma(E));
  vec4 d = b.yzwx, f = b.wxyz, h = b.zwxy;
  vec4 g = c.zwxy, i = c.wxyz;
  vec4 i4 = vec4(luma(I4), luma(C1), luma(A0), luma(G5));
  vec4 i5 = vec4(luma(I5), luma(C4), luma(A1), luma(G0));
  vec4 h5 = vec4(luma(H5), luma(F4), luma(B1), luma(D0));
  vec4 f4 = h5.yzwx;

  // E differs from both neighbours at the corner; not the corner of a straight-sided block
  vec4 irlv0 = diff(e, f) * diff(e, h);
  vec4 irlv1 = irlv0 * (neq(f, b) * neq(h, d) + eq(e, i) * neq(f, i4) * neq(h, i5) + eq(e, g) + eq(e, c));
  vec4 irlv2l = diff(e, g) * diff(d, g);
  vec4 irlv2u = diff(e, c) * diff(b, c);

  // the change along the diagonal that crosses the corner, and along the one through it
  vec4 wd1 = wd(e, c, g, i, h5, f4, h, f);
  vec4 wd2 = wd(h, d, i5, f, i4, b, e, i);
  vec4 edri = step(wd1, wd2) * irlv0;
  vec4 edr = step(wd1 + 0.1, wd2) * step(0.5, irlv1);
  vec4 edrL = step(LV2 * df(f, g), df(h, c)) * irlv2l * edr;   // shallow: f in line with g
  vec4 edrU = step(LV2 * df(h, c), df(f, g)) * irlv2u * edr;   // steep: h in line with c

  // the cut lines, in E's square (u toward f, v toward h for each corner): u + v > 1.5,
  // u + v > 1.75 (the weaker rule), v + u/2 > 1 (shallow), u + v/2 > 1 (steep)
  vec4 l45 = vec4(1.0, -1.0, -1.0, 1.0) * fp.y + vec4(1.0, 1.0, -1.0, -1.0) * fp.x;
  vec4 c45 = vec4(1.5, 0.5, -0.5, 0.5);
  vec4 lL = vec4(1.0, -0.5, -1.0, 0.5) * fp.y + vec4(0.5, 1.0, -0.5, -1.0) * fp.x;
  vec4 cL = vec4(1.0, 0.5, -0.5, 0.0);
  vec4 lU = vec4(0.5, -1.0, -0.5, 1.0) * fp.y + vec4(1.0, 0.5, -1.0, -0.5) * fp.x;
  vec4 cU = vec4(1.0, 0.0, -0.5, 0.5);
  // soft over one output pixel across each line
  float s = uSrcSize.x / uOut.x;
  float d45 = 0.5 * s * 1.41421, dL = 0.5 * s * 1.11803;
  vec4 fx45i = clamp((l45 - c45 - 0.25 + d45) / (2.0 * d45), 0.0, 1.0) * edri;
  vec4 fx45 = clamp((l45 - c45 + d45) / (2.0 * d45), 0.0, 1.0) * edr;
  vec4 fx30 = clamp((lL - cL + dL) / (2.0 * dL), 0.0, 1.0) * edrL;
  vec4 fx60 = clamp((lU - cU + dL) / (2.0 * dL), 0.0, 1.0) * edrU;
  vec4 cover = max(max(fx30, fx60), max(fx45, fx45i));

  // the nearer of the two neighbours beyond the edge
  vec4 near = step(df(e, f), df(e, h));   // 1: f
  vec4 r1 = mix(E, mix(H, F, near.x), cover.x);
  r1 = mix(r1, mix(B, D, near.z), cover.z);
  vec4 r2 = mix(E, mix(F, B, near.y), cover.y);
  r2 = mix(r2, mix(D, H, near.w), cover.w);
  outColour = cdf(E, r1) >= cdf(E, r2) ? r1 : r2;
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

/**
 * A canvas that shows a 320 x 200 RGBA picture through xBR, at the canvas's
 * size on the page (times the device pixel ratio).
 * @param {HTMLCanvasElement} canvas
 * @returns {{ draw(rgba: Uint8ClampedArray|Uint8Array, w?: number, h?: number): void }}
 */
export function makeSmoother(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error('WebGL2 is not available');
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = Object.fromEntries(['uSrc', 'uSrcSize', 'uOut'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  let size = null;
  return {
    draw(rgba, w = 320, h = 200) {
      const r = canvas.getBoundingClientRect(), dpr = globalThis.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(r.width * dpr)), ch = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const data = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      if (!size || size[0] !== w || size[1] !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); size = [w, h]; }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.viewport(0, 0, cw, ch);
      gl.useProgram(prog);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform2f(u.uSrcSize, w, h);
      gl.uniform2f(u.uOut, cw, ch);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
