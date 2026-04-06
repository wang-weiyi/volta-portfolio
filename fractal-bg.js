// fractal-bg.js
// WebGL 全屏分形背景 — 从 Houdini OpenCL 移植的 RotJulia Raymarching SDF
// 用法：在 index.html 引入后调用 FractalBG.init()

const FractalBG = (() => {

  // ── 顶点着色器（全屏三角形）────────────────────────────────
  const VERT_SRC = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){
  // 覆盖全屏的两个大三角形，不需要 VBO
  vec2 pos[3] = vec2[](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
  vUv = (pos[gl_VertexID] + 1.0) * 0.5;
}`;

  // ── 片段着色器（核心分形逻辑）──────────────────────────────
  const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

// ── Uniforms ──
uniform float u_time;
uniform vec2  u_resolution;

// 分形参数
uniform vec3  u_juliaC;        // (0.345, 0.557, 0)
uniform vec2  u_juliaCOffset;  // 鼠标位移
uniform vec3  u_rotAxis;       // (1, 0, 0)
uniform float u_rotAngle;      // 45 * PI/180
uniform float u_scale;         // 0.957
uniform float u_bailout;       // 3000.0
uniform int   u_iter;          // 24
uniform int   u_inversion;     // 0
uniform int   u_rotateC;       // 0
uniform float u_uvScale;       // 2.5
uniform float u_zPower;        // 1.0
uniform float u_zOffset;       // 0.0
uniform float u_zOffset2;      // 0.0
uniform float u_proj;          // 1.0

// 光照参数
uniform vec3  u_lightDir;      // 归一化方向
uniform vec3  u_lightColor;    // (1,1,1)
uniform vec3  u_ambientColor;  // (0.3,0.3,0.3)
uniform vec3  u_materialColor; // (0.9,0.9,0.9)
uniform float u_shininess;     // 10.0
uniform float u_ambientStrength;   // 0.3
uniform float u_specularStrength;  // 1.0

uniform vec3  u_camPos;        // 相机位置
uniform float u_fov;           // 视角（弧度）

// ── mat3 工具 ──────────────────────────────────────────────────
// GLSL 内置 mat3 是列主序: mat3(col0, col1, col2)
// 我们用行主序思维写，最后转置存储

mat3 rotAxisAngle(float angle, vec3 axis) {
  axis = normalize(axis);
  float c = cos(angle), s = sin(angle), t = 1.0 - c;
  float x = axis.x, y = axis.y, z = axis.z;
  // 罗德里格斯旋转矩阵（行主序写法，列主序存储）
  return mat3(
    t*x*x+c,    t*x*y-s*z,  t*x*z+s*y,
    t*y*x+s*z,  t*y*y+c,    t*y*z-s*x,
    t*z*x-s*y,  t*z*y+s*x,  t*z*z+c
  );
}

// Frobenius 范数
float frobeniusNorm(mat3 M) {
  vec3 r0 = M[0], r1 = M[1], r2 = M[2];
  return sqrt(dot(r0,r0) + dot(r1,r1) + dot(r2,r2));
}

// ── 等距柱状投影逆变换 ─────────────────────────────────────────
vec3 equirectangularInverse(vec3 planarPos, float scale, float radius) {
  float useR = (radius != 0.0) ? radius : planarPos.z;
  float lon = planarPos.x / scale;
  float lat = planarPos.y / scale;
  float xzLen = useR * cos(lat);
  return vec3(xzLen * sin(lon), useR * sin(lat), xzLen * cos(lon));
}

// ── 位置变换 ───────────────────────────────────────────────────
vec3 applyTransform(vec3 pos) {
  float r = sign(pos.z) * pow(abs(pos.z), u_zPower);
  r += sign(pos.z) * u_zOffset;
  r += u_zOffset2;
  vec3 npos = equirectangularInverse(pos, u_uvScale, r);
  return pos + u_proj * (npos - pos);
}

// ── 变换的解析雅可比矩阵 ────────────────────────────────────────
// T(pos) = pos + proj*(F(pos)-pos)，J_T = I + proj*(J_F - I)
// F = equirectangularInverse，对 pos 解析求偏导
mat3 computeTransformJacobian(vec3 pos) {
  float absZ = abs(pos.z);
  float signZ = sign(pos.z);

  // 计算 r 及 dr/dz（sign(z)*zOffset 为常数项，导数为 0）
  float r = (absZ > 1e-6 ? signZ * pow(absZ, u_zPower) : 0.0)
            + signZ * u_zOffset + u_zOffset2;
  float useR;
  float dr_dz;
  if (r != 0.0) {
    useR  = r;
    dr_dz = (absZ > 1e-6) ? u_zPower * pow(absZ, u_zPower - 1.0) : 0.0;
  } else {
    // equirectangularInverse 退化为使用 planarPos.z
    useR  = pos.z;
    dr_dz = 1.0;
  }

  float lon    = pos.x / u_uvScale;
  float lat    = pos.y / u_uvScale;
  float cosLat = cos(lat), sinLat = sin(lat);
  float cosLon = cos(lon), sinLon = sin(lon);
  float invS   = 1.0 / u_uvScale;

  // J_F（GLSL mat3 列主序，每个 vec3 是一列）
  // col j = ∂F/∂pos_j
  mat3 JF = mat3(
    // col0: ∂F/∂pos.x
    vec3( useR * cosLat * cosLon * invS,
          0.0,
         -useR * cosLat * sinLon * invS),
    // col1: ∂F/∂pos.y
    vec3(-useR * sinLat * sinLon * invS,
          useR * cosLat * invS,
         -useR * sinLat * cosLon * invS),
    // col2: ∂F/∂pos.z
    vec3( cosLat * sinLon * dr_dz,
          sinLat * dr_dz,
          cosLat * cosLon * dr_dz)
  );

  return mat3(1.0) + u_proj * (JF - mat3(1.0));
}

// ── SDF ────────────────────────────────────────────────────────
float sdf(vec3 pos) {
  // 变换
  vec3 tp = applyTransform(pos);

  // 变换的解析雅可比矩阵
  mat3 Jt = computeTransformJacobian(pos);

  vec3 z;
  mat3 D;

  // 球反演
  if (u_inversion == 1) {
    float r2 = dot(tp, tp);
    z = tp / r2;
    // 球反演雅可比: (I - 2*x*x^T/r^2)/r^2
    mat3 I = mat3(1.0);
    mat3 outer = outerProduct(tp, tp);
    mat3 Jinv = (I - 2.0/r2 * outer) / r2;
    D = Jinv * Jt;
  } else {
    z = tp;
    D = Jt;
  }

  mat3 rot = rotAxisAngle(u_rotAngle, u_rotAxis);
  vec3 j = u_juliaC + vec3(u_juliaCOffset, 0.0);

  for (int i = 0; i < 24; i++) {  // iter 上限硬编码，uniform 控制实际迭代次数
    if (i >= u_iter) break;

    float a = z.x, b = z.y;

    // Julia 迭代: z_new = (a²-b², 2ab, z.z)
    vec3 zn = vec3(a*a - b*b, 2.0*a*b, z.z);

    // Julia 雅可比矩阵
    mat3 Jj = mat3(
       2.0*a, 2.0*b, 0.0,   // col0
      -2.0*b, 2.0*a, 0.0,   // col1
       0.0,   0.0,   1.0    // col2
    );
    // GLSL mat3 是列主序，上面已经按列写好

    // 更新导数矩阵：D = rot * Jj * D （右乘）
    D = rot * Jj * D;

    // 更新位置
    z = rot * zn;
    if (u_rotateC == 1) j = rot * j;
    z = z * u_scale + j;

    float r = length(z);
    if (r > u_bailout) {
      float normD = frobeniusNorm(D);
      float distScale = clamp(float(i+1) / 50.0, 0.0, 1.0);
      float de = (0.5 + 0.25*distScale) * r * log(r) / normD;
      float sphereDist = length(pos) - 30.0;
      return max(de, sphereDist);
    }
  }
  return 0.0;
}

// ── 法向量 ─────────────────────────────────────────────────────
vec3 calcNormal(vec3 p) {
  float eps = 0.0005;
  float d = sdf(p);
  return normalize(vec3(
    sdf(p + vec3(eps,0,0)) - d,
    sdf(p + vec3(0,eps,0)) - d,
    sdf(p + vec3(0,0,eps)) - d
  ));
}

// ── AO ─────────────────────────────────────────────────────────
float calcAO(vec3 p, vec3 n) {
  float dist = 0.002, occ = 1.0;
  for (int i = 0; i < 8; i++) {
    occ = min(occ, sdf(p + dist*n) / dist);
    dist *= 2.0;
  }
  return max(occ, 0.0);
}

// ── 软阴影 ─────────────────────────────────────────────────────
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float w) {
  float res = 1.0, ph = 1e20, t = mint;
  for (int i = 0; i < 64 && t < maxt; i++) {
    float h = sdf(ro + rd*t);
    if (h < 0.001) return 0.0;
    float y = h*h / (2.0*ph);
    float d = sqrt(h*h - y*y);
    res = min(res, clamp(d / (w * max(0.01, t-y)), 0.0, 10.0));
    ph = h;
    t += h;
  }
  return res;
}

// ── Phong 光照 ─────────────────────────────────────────────────
vec3 phongLighting(vec3 p, vec3 normal, vec3 viewDir) {
  vec3 lightDir = normalize(-u_lightDir);
  vec3 ambient  = u_ambientStrength * u_ambientColor;
  float diff    = max(dot(normal, lightDir), 0.0);
  vec3 diffuse  = diff * u_lightColor;
  vec3 reflDir  = reflect(lightDir, normal);
  float spec    = pow(max(dot(viewDir, reflDir), 0.0), u_shininess);
  vec3 specular = u_specularStrength * spec * u_lightColor;
  return (ambient + diffuse + specular) * u_materialColor;
}

// ── 色调映射 ───────────────────────────────────────────────────
vec3 aces(vec3 x) {
  float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}

// ── 主函数 ─────────────────────────────────────────────────────
void main() {
  vec2 uv = vUv;

  // 相机设置
  vec3 ro = u_camPos;
  // 构建相机坐标系
  vec3 target = vec3(7.9, 0.0, 1.55);
  vec3 fwd = normalize(target - ro);
  vec3 worldUp = abs(fwd.y) < 0.99 ? vec3(0,1,0) : vec3(0,0,1);
  vec3 right = normalize(cross(worldUp, fwd));
  vec3 up = cross(fwd, right);

  // 屏幕空间 → 光线方向（透视投影）
  float aspect = u_resolution.x / u_resolution.y;
  vec2 ndc = (uv - 0.5) * 2.0;
  ndc.x *= aspect;
  float fovFactor = tan(u_fov * 0.5);
  vec3 rd = normalize(fwd + ndc.x * fovFactor * right + ndc.y * fovFactor * up);

  // Raymarching
  vec3 raypos = ro;
  bool hit = false;
  int rmIter = 300; // raymarching 步数（降低以提升性能）

  for (int i = 0; i < 300; i++) {
    float dist = sdf(raypos);
    if (dist < 0.0001) { hit = true; break; }
    if (length(raypos - ro) > 60.0) break;
    raypos += dist * rd;
  }

  vec3 col;
  if (hit) {
    vec3 normal  = calcNormal(raypos);
    float ao     = calcAO(raypos, normal);
    vec3 viewDir = normalize(ro - raypos);
    vec3 ldir    = normalize(u_lightDir);
    float shadow = softShadow(raypos + 0.0001*normal, -ldir, 0.06, 5.0, 0.08);
    col = phongLighting(raypos, normal, viewDir);
    col *= ao * (0.4 + 0.6*shadow);
  } else {
    // 背景：深色渐变
    float t = smoothstep(0.0, 1.0, uv.y);
    col = mix(vec3(0.02, 0.02, 0.04), vec3(0.04, 0.04, 0.08), t);
  }

  // 色调映射 + gamma
  col = aces(col * 1.2);
  col = pow(col, vec3(1.0/2.2));

  // 暗角
  float vignette = 1.0 - 0.4*pow(length(uv*2.0-1.0), 2.0);
  col *= vignette;

  fragColor = vec4(col, 1.0);
}`;

  // ── 过渡动画显示着色器 ─────────────────────────────────────
  // 基于 tile hash 的随机散开溶解，tile 边缘带蓝色闪光
  const DISPLAY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_texA;      // 当前帧（旧）
uniform sampler2D u_texB;      // 目标帧（新）
uniform float     u_transition; // 0=全A, 1=全B
uniform vec2      u_resolution;

float hash(vec2 p) {
  p = fract(p * vec2(127.34, 311.72));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;

  // 快捷路径：过渡未开始或已结束
  if (u_transition <= 0.0) { fragColor = texture(u_texA, uv); return; }
  if (u_transition >= 1.0) { fragColor = texture(u_texB, uv); return; }

  // 每个 tile(20px) 有独立的随机延迟
  vec2 tileCoord = floor(gl_FragCoord.xy / 20.0);
  float delay  = hash(tileCoord);          // [0, 1]
  float tStart = delay * 0.55;
  float tEnd   = tStart + 0.45;
  float localT = clamp((u_transition - tStart) / (tEnd - tStart), 0.0, 1.0);
  localT = smoothstep(0.0, 1.0, localT);

  vec4 colA = texture(u_texA, uv);
  vec4 colB = texture(u_texB, uv);

  // tile 切换瞬间的蓝色闪光
  float flash = exp(-pow((localT - 0.5) * 7.0, 2.0)) * 0.14;
  vec4 col = mix(colA, colB, localT);
  col.rgb += flash * vec3(0.35, 0.6, 1.0);
  col.rgb  = clamp(col.rgb, 0.0, 1.0);
  fragColor = col;
}`;

  // ── 内部状态 ───────────────────────────────────────────────
  let gl, fractalProg, displayProg, canvas, raf;
  let fractalUniforms = {}, displayUniforms = {};
  let fboA = null, fboB = null;   // { fbo, tex }
  let fboAValid = false;          // fboA 是否已有有效内容
  let pendingOffset = [0, 0];     // 下次渲染用的 juliaC 偏移
  let transitionStart = 0;
  let isTransitioning = false;
  let debounceTimer = null;
  const MOUSE_STRENGTH  = 0.285;
  const DEBOUNCE_MS     = 350;
  const TRANSITION_MS   = 900;

  // ── GL 工具 ────────────────────────────────────────────────
  function compileShader(g, type, src) {
    const s = g.createShader(type);
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
      console.error('Shader error:', g.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function buildProgram(g, fSrc) {
    const vs = compileShader(g, g.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(g, g.FRAGMENT_SHADER, fSrc);
    if (!vs || !fs) return null;
    const p = g.createProgram();
    g.attachShader(p, vs); g.attachShader(p, fs);
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) {
      console.error('Link error:', g.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  // 创建 RGBA FBO + 纹理
  function makeFBO(g, w, h) {
    const tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    const fbo = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.bindTexture(g.TEXTURE_2D, null);
    return { fbo, tex, w, h };
  }

  // ── 分形 uniforms ──────────────────────────────────────────
  function cacheFractalUniforms(g, p) {
    const names = [
      'u_time','u_resolution',
      'u_juliaC','u_juliaCOffset','u_rotAxis','u_rotAngle','u_scale','u_bailout',
      'u_iter','u_inversion','u_rotateC',
      'u_uvScale','u_zPower','u_zOffset','u_zOffset2','u_proj',
      'u_lightDir','u_lightColor','u_ambientColor','u_materialColor',
      'u_shininess','u_ambientStrength','u_specularStrength',
      'u_camPos','u_fov',
    ];
    const out = {};
    for (const n of names) out[n] = g.getUniformLocation(p, n);
    return out;
  }

  function setFractalUniforms(g, u, offset) {
    g.uniform1f(u.u_time, 0.0);
    g.uniform2f(u.u_resolution, g.drawingBufferWidth, g.drawingBufferHeight);
    g.uniform3f(u.u_juliaC,        0.345, 0.557, 0.0);
    g.uniform2f(u.u_juliaCOffset,  offset[0], offset[1]);
    g.uniform3f(u.u_rotAxis,       1.0, 0.0, 0.0);
    g.uniform1f(u.u_rotAngle,      45.0 * Math.PI / 180.0);
    g.uniform1f(u.u_scale,         0.957);
    g.uniform1f(u.u_bailout,       3000.0);
    g.uniform1i(u.u_iter,          24);
    g.uniform1i(u.u_inversion,     0);
    g.uniform1i(u.u_rotateC,       0);
    g.uniform1f(u.u_uvScale,       2.5);
    g.uniform1f(u.u_zPower,        1.0);
    g.uniform1f(u.u_zOffset,       0.0);
    g.uniform1f(u.u_zOffset2,      0.0);
    g.uniform1f(u.u_proj,          1.0);
    g.uniform3f(u.u_lightDir,      -0.69, -0.23, -0.2);
    g.uniform3f(u.u_lightColor,     1.0,   1.0,   1.0);
    g.uniform3f(u.u_ambientColor,   0.3,   0.3,   0.3);
    g.uniform3f(u.u_materialColor,  0.9,   0.9,   0.9);
    g.uniform1f(u.u_shininess,      93.0);
    g.uniform1f(u.u_ambientStrength, 0.39);
    g.uniform1f(u.u_specularStrength, 2.76);
    g.uniform3f(u.u_camPos,         6.1788, 1.4962, 5.7053);
    g.uniform1f(u.u_fov,            60.0 * Math.PI / 180.0);
  }

  // ── 尺寸 ───────────────────────────────────────────────────
  function getDrawSize() {
    const dpr = Math.min(window.devicePixelRatio, 2.0) * 0.525;
    return [
      Math.floor(window.innerWidth  * dpr),
      Math.floor(window.innerHeight * dpr),
    ];
  }

  function resize() {
    if (!canvas) return;
    const [w, h] = getDrawSize();
    canvas.width  = w;
    canvas.height = h;
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (gl) gl.viewport(0, 0, w, h);
  }

  // ── 过渡动画循环（轻量，仅混合两张纹理）─────────────────────
  function startTransitionLoop() {
    if (raf) return;
    function loop(ts) {
      if (!isTransitioning) { raf = null; return; }
      const t = Math.min((ts - transitionStart) / TRANSITION_MS, 1.0);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(displayProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
      gl.uniform1i(displayUniforms.u_texA, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fboB.tex);
      gl.uniform1i(displayUniforms.u_texB, 1);
      gl.uniform1f(displayUniforms.u_transition, t);
      gl.uniform2f(displayUniforms.u_resolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (t >= 1.0) {
        isTransitioning = false;
        // A ← B：交换引用，下次渲染时 B 会被覆盖
        const tmp = fboA; fboA = fboB; fboB = tmp;
        raf = null;
      } else {
        raf = requestAnimationFrame(loop);
      }
    }
    raf = requestAnimationFrame(loop);
  }

  // ── 异步渲染分形到 fboB，完成后触发过渡 ───────────────────
  function renderFractalToFBO(offset) {
    const [w, h] = [canvas.width, canvas.height];

    // 确保 FBO 尺寸匹配
    if (!fboA || fboA.w !== w || fboA.h !== h) {
      fboA = makeFBO(gl, w, h);
      fboB = makeFBO(gl, w, h);
      fboAValid = false;
    }

    // 渲染新帧到 fboB
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(fractalProg);
    setFractalUniforms(gl, fractalUniforms, offset);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!fboAValid) {
      // 首帧：A 也填一样的内容，无过渡直接显示
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fboAValid = true;

      // 直接把 B 显示到屏幕
      const tmp = fboA; fboA = fboB; fboB = tmp;
      gl.viewport(0, 0, w, h);
      gl.useProgram(displayProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
      gl.uniform1i(displayUniforms.u_texA, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
      gl.uniform1i(displayUniforms.u_texB, 1);
      gl.uniform1f(displayUniforms.u_transition, 0.0);
      gl.uniform2f(displayUniforms.u_resolution, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }

    // 启动过渡动画
    isTransitioning = true;
    transitionStart = performance.now();
    startTransitionLoop();
  }

  // ── 公开 API ───────────────────────────────────────────────
  return {
    init(targetId = 'fractalCanvas') {
      canvas = document.getElementById(targetId);
      if (!canvas) { console.warn('FractalBG: canvas not found, id =', targetId); return false; }

      gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
      if (!gl) {
        console.warn('FractalBG: WebGL2 not supported');
        canvas.style.display = 'none';
        return false;
      }

      fractalProg  = buildProgram(gl, FRAG_SRC);
      displayProg  = buildProgram(gl, DISPLAY_FRAG_SRC);
      if (!fractalProg || !displayProg) return false;

      fractalUniforms = cacheFractalUniforms(gl, fractalProg);
      displayUniforms = {
        u_texA:       gl.getUniformLocation(displayProg, 'u_texA'),
        u_texB:       gl.getUniformLocation(displayProg, 'u_texB'),
        u_transition: gl.getUniformLocation(displayProg, 'u_transition'),
        u_resolution: gl.getUniformLocation(displayProg, 'u_resolution'),
      };

      resize();
      window.addEventListener('resize', () => {
        resize();
        fboAValid = false; // 尺寸变了，重新渲染首帧
      });

      canvas.addEventListener('mouseenter', () => {
        // 立即用 offset=0 渲染首帧（如果还没有）
        if (!fboAValid) renderFractalToFBO([0, 0]);
      });

      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        pendingOffset[0] = ((e.clientX - rect.left)  / rect.width  - 0.5) * MOUSE_STRENGTH;
        pendingOffset[1] = ((e.clientY - rect.top)   / rect.height - 0.5) * MOUSE_STRENGTH;

        // 防抖：鼠标停止移动 DEBOUNCE_MS 后才触发分形重计算
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          renderFractalToFBO([pendingOffset[0], pendingOffset[1]]);
        }, DEBOUNCE_MS);
      });

      canvas.addEventListener('mouseleave', () => {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      });

      return true;
    },

    stop() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    },
  };
})();
