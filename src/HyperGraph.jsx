import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import TypedDoc from './TypedDoc.jsx';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const NODE_COUNT = 286; // ~30% fewer points in clusters (the unclustered share is unchanged)
const BOX = new THREE.Vector3(48, 28, 32);
const CLUSTER_COUNT = 11;
const CLUSTER_SHARE = 0.82; // share of nodes that belong to a cluster
const CLUSTER_SPREAD = 4.2;
const ROTATION_SPEED = 0.06; // rad/s around the vertical axis (~105 s per full turn)
const CONDUCT_STEER = 0.9; // rad/s of spin per unit of cursor offset from the centre
const CONDUCT_STROKE = 0.35; // extra spin kick from fast mouse strokes
const CONDUCT_MAX = 2.2;
const WAVE_AMP = 7; // how far the depth waves push nodes toward/away from the viewer
const LINK_RADIUS = 5.4;
const MAX_EDGES = 3600;
const MAX_FACES = 1000;
const FACE_RATIO = 0.34; // share of triangles drawn as filled hyperedges
const FOCUS_Z = 34; // camera distance that is in perfect focus
const MAX_PULSES = 3;
const SHRINK_DELAY = 3; // seconds of full-screen animation before the view shrinks
const SHRINK_TIME = 1.4; // seconds the shrink transition takes
const FRAME_W = 200;
const FRAME_H = 250;
const MOVE_DELAY = 1; // seconds the settled layout rests before everything moves up
const MOVE_TIME = 1.2;
const TOP_PADDING = 30; // final gap between the screen top and the frame
const DOC_GAP = 36; // gap between the frame and the text that gets written below it
const CLUSTER_PULL = 0.7; // overall strength of the gathering at the frame (1 = full)
const CLUSTER_RADIUS_JITTER = 8; // how far gathered clusters spread around the frame centre (world units)
const FRAME_RADIUS = 18;
const TAGLINE_SHARE = 0.54; // tagline width relative to the title width
const FRAME_OFFSET_Y = 150; // frame sits this many px above the screen centre
const TITLE_GAP = 40; // gap between the frame and the title on its right

const CYAN = new THREE.Color('#38d9ff');
const BLUE = new THREE.Color('#2f6bff');
const TEAL = new THREE.Color('#5ff5d0');
const AMBER = new THREE.Color('#ffa63a');

// Shared "depth of field" chunk: things away from the focal plane get dimmer and blurrier.
const dofGLSL = /* glsl */ `
  uniform float uFocus;
  float blurAmount(float viewDepth) {
    return clamp(abs(viewDepth - uFocus) / 20.0, 0.0, 1.0);
  }
`;

const lineVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  ${dofGLSL}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float b = blurAmount(-mv.z);
    vColor = aColor;
    vAlpha = aAlpha * mix(1.0, 0.35, b);
    gl_Position = projectionMatrix * mv;
  }
`;

const lineFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

const pointVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPhase;
  attribute float aBoost;
  uniform float uTime;
  uniform float uScale;
  varying vec3 vColor;
  varying float vBlur;
  varying float vBoost;
  ${dofGLSL}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vBlur = blurAmount(-mv.z);
    vBoost = aBoost;
    float twinkle = 0.85 + 0.15 * sin(uTime * 1.6 + aPhase);
    vColor = aColor;
    float size = aSize * twinkle * (1.0 + aBoost * 0.9);
    gl_PointSize = min(size * uScale / -mv.z * (1.0 + vBlur * 2.4), 90.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const pointFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vBlur;
  varying float vBoost;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float coreR = mix(0.28, 0.0, vBlur);
    float core = 1.0 - smoothstep(coreR * 0.6, coreR + 0.12, d);
    float halo = pow(1.0 - d, 2.2);
    float focus = 1.0 - vBlur;
    vec3 col = vColor * halo * mix(1.4, 0.9, vBlur) + vec3(1.0) * core * focus * (1.0 + vBoost);
    float a = clamp(halo * mix(0.9, 0.5, vBlur) + core * focus, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
  }
`;

const bgVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

const bgFragment = /* glsl */ `
  varying vec2 vUv;
  uniform vec2 uMouse;
  void main() {
    vec2 p = vUv - vec2(0.5 + uMouse.x * 0.04, 0.5 + uMouse.y * 0.04);
    float r = length(p * vec2(1.1, 0.9));
    vec3 deep = vec3(0.0, 0.0006, 0.005);
    vec3 mid = vec3(0.0006, 0.004, 0.032);
    vec3 col = mix(mid, deep, smoothstep(0.0, 0.85, r));
    // faint warm bloom in the upper right like the out-of-focus amber haze
    float warm = exp(-length(vUv - vec2(0.78, 0.86)) * 4.5);
    col += vec3(0.012, 0.005, 0.0) * warm;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Deterministic hash of a triangle -> [0,1) so face visibility is stable while the triangle exists.
function hash3(i, j, k) {
  let h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function makeLayer(maxVerts, material, mode) {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const alpha = new THREE.BufferAttribute(new Float32Array(maxVerts), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aAlpha', alpha);
  geometry.setDrawRange(0, 0);
  const object = mode === 'lines' ? new THREE.LineSegments(geometry, material) : new THREE.Mesh(geometry, material);
  object.frustumCulled = false;
  return { geometry, position, color, alpha, object };
}

export default function HyperGraph() {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const dimRef = useRef(null);
  const labelRef = useRef(null);
  const taglineRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frameEl = frameRef.current;
    const dimEl = dimRef.current;
    const labelEl = labelRef.current;
    const taglineEl = taglineRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(0, 0, FOCUS_Z);

    const world = new THREE.Group();
    scene.add(world);

    const uniforms = {
      uTime: { value: 0 },
      uFocus: { value: FOCUS_Z },
      uScale: { value: 1 },
    };

    // ---- background ----
    const bgUniforms = { uMouse: { value: new THREE.Vector2() } };
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: bgVertex,
        fragmentShader: bgFragment,
        uniforms: bgUniforms,
        depthTest: false,
        depthWrite: false,
      }),
    );
    bg.frustumCulled = false;
    bg.renderOrder = -10;
    scene.add(bg);

    // ---- nodes ----
    const N = NODE_COUNT;
    const home = new Float32Array(N * 3);
    const pos = new Float32Array(N * 3);
    const freq = new Float32Array(N * 6);
    const phase = new Float32Array(N * 3);
    const amp = new Float32Array(N);
    const nodeColor = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const nodePhase = new Float32Array(N);
    const boost = new Float32Array(N);
    const tmp = new THREE.Color();

    // cluster centres wander slowly so clusters drift together, merge and split apart
    const cHome = new Float32Array(CLUSTER_COUNT * 3);
    const cFreq = new Float32Array(CLUSTER_COUNT * 3);
    const cPhase = new Float32Array(CLUSTER_COUNT * 3);
    const cOff = new Float32Array(CLUSTER_COUNT * 3);
    const cluster = new Int16Array(N);
    const cPull = new Float32Array(CLUSTER_COUNT);
    const cJit = new Float32Array(CLUSTER_COUNT * 3);
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      cPull[c] = 0.4 + Math.random() * 0.45;
      for (let a = 0; a < 3; a++) cJit[c * 3 + a] = (Math.random() - 0.5) * 2 * CLUSTER_RADIUS_JITTER;
    }
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      cHome[c * 3] = (Math.random() - 0.5) * BOX.x * 0.9;
      cHome[c * 3 + 1] = (Math.random() - 0.5) * BOX.y * 0.9;
      cHome[c * 3 + 2] = (Math.random() - 0.5) * BOX.z * 0.7;
      for (let a = 0; a < 3; a++) {
        cFreq[c * 3 + a] = 0.03 + Math.random() * 0.05;
        cPhase[c * 3 + a] = Math.random() * Math.PI * 2;
      }
    }

    for (let i = 0; i < N; i++) {
      const c = Math.random() < CLUSTER_SHARE ? Math.floor(Math.random() * CLUSTER_COUNT) : -1;
      cluster[i] = c;
      if (c >= 0) {
        // gaussian blob around the cluster centre
        const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;
        home[i * 3] = cHome[c * 3] + g() * CLUSTER_SPREAD;
        home[i * 3 + 1] = cHome[c * 3 + 1] + g() * CLUSTER_SPREAD;
        home[i * 3 + 2] = cHome[c * 3 + 2] + g() * CLUSTER_SPREAD;
      } else {
        home[i * 3] = (Math.random() - 0.5) * BOX.x;
        home[i * 3 + 1] = (Math.random() - 0.5) * BOX.y;
        home[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
      }
      for (let a = 0; a < 6; a++) freq[i * 6 + a] = 0.05 + Math.random() * 0.12;
      for (let a = 0; a < 3; a++) phase[i * 3 + a] = Math.random() * Math.PI * 2;
      amp[i] = 1.0 + Math.random() * 1.8;

      const r = Math.random();
      if (r < 0.11) tmp.copy(AMBER);
      else if (r < 0.3) tmp.copy(TEAL);
      else tmp.copy(CYAN).lerp(BLUE, Math.random() * 0.8);
      nodeColor.set([tmp.r, tmp.g, tmp.b], i * 3);

      size[i] = 7 + Math.pow(Math.random(), 3) * 14;
      nodePhase[i] = Math.random() * 20;
    }

    const pointGeometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const boostAttr = new THREE.BufferAttribute(boost, 1).setUsage(THREE.DynamicDrawUsage);
    pointGeometry.setAttribute('position', posAttr);
    pointGeometry.setAttribute('aColor', new THREE.BufferAttribute(nodeColor, 3));
    pointGeometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    pointGeometry.setAttribute('aPhase', new THREE.BufferAttribute(nodePhase, 1));
    pointGeometry.setAttribute('aBoost', boostAttr);
    const points = new THREE.Points(
      pointGeometry,
      new THREE.ShaderMaterial({
        vertexShader: pointVertex,
        fragmentShader: pointFragment,
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    points.frustumCulled = false;

    // ---- edges & faces (rebuilt every frame from proximity) ----
    const lineMaterial = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const faceMaterial = lineMaterial.clone();
    faceMaterial.uniforms = uniforms;
    faceMaterial.side = THREE.DoubleSide;

    const edges = makeLayer(MAX_EDGES * 2, lineMaterial, 'lines');
    const faces = makeLayer(MAX_FACES * 3, faceMaterial, 'mesh');
    faces.object.renderOrder = 0;
    edges.object.renderOrder = 1;
    points.renderOrder = 2;
    world.add(faces.object, edges.object, points);

    const edgeAlpha = new Float32Array(N * N);
    const adj = Array.from({ length: N }, () => []);
    const pulses = [];
    let nextPulse = 1;

    // ---- post ----
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.6, 0.25);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const clock = new THREE.Clock();

    // the renderer always keeps the full window size; the shrink only dims everything outside the crop window
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      // keep the graph filling the viewport on tall/narrow screens
      camera.fov = w / h < 1 ? 50 / Math.max(w / h, 0.55) : 50;
      camera.updateProjectionMatrix();
      uniforms.uScale.value = (h * renderer.getPixelRatio()) / 2 / Math.tan((camera.fov * Math.PI) / 360) / 30;
    };
    resize();
    let focusM = 0; // 0..1 progress of the move up; drives how strongly clusters gather at the frame
    const focusNdc = new THREE.Vector2();
    const attractor = new THREE.Vector3(); // frame centre expressed in the world's local (rotating) space
    const rayDir = new THREE.Vector3();
    const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const applyView = (t) => {
      const k = easeInOut(Math.min(Math.max((t - SHRINK_DELAY) / SHRINK_TIME, 0), 1));
      const W = window.innerWidth;
      const H = window.innerHeight;
      // frame + title form one group that ends up horizontally centred on the screen
      const fx = (W - (FRAME_W + TITLE_GAP + labelEl.offsetWidth)) / 2;
      const left = fx * k;
      // after the rest period the whole group glides up until the frame is TOP_PADDING from the top
      const m = easeInOut(Math.min(Math.max((t - SHRINK_DELAY - SHRINK_TIME - MOVE_DELAY) / MOVE_TIME, 0), 1));
      const restY = (H - FRAME_H) / 2 - FRAME_OFFSET_Y;
      const fy = restY + (TOP_PADDING - restY) * m;
      const top = fy * k;
      const right = (W - FRAME_W - fx) * k;
      const bottom = (H - FRAME_H - fy) * k;

      const frameCX = (W - (FRAME_W + TITLE_GAP + labelEl.offsetWidth)) / 2 + FRAME_W / 2;
      // once the group moves up, clusters are drawn toward the frame (see the node loop)
      focusM = m;
      focusNdc.set((frameCX / W) * 2 - 1, -(((fy + FRAME_H / 2) / H) * 2 - 1));

      // the crop window stays fully lit; its huge shadow dims everything outside it so the rest of the graph is barely visible
      dimEl.style.left = `${left}px`;
      dimEl.style.top = `${top}px`;
      dimEl.style.width = `${W - left - right}px`;
      dimEl.style.height = `${H - top - bottom}px`;
      dimEl.style.borderRadius = `${FRAME_RADIUS * k}px`;

      // border and title sit on the final crop rectangle and fade in once the crop has finished
      frameEl.style.left = `${fx}px`;
      frameEl.style.top = `${fy}px`;
      labelEl.style.left = `${fx + FRAME_W + TITLE_GAP}px`;
      labelEl.style.top = `${fy}px`;
      const shown = k >= 1 ? '1' : '0';
      frameEl.style.opacity = shown;
      labelEl.style.opacity = shown;
      labelEl.classList.toggle('is-up', m >= 1);
    };
    // stretch the tagline's letter-spacing so it spans a fixed share of the title width (it starts right of the "p")
    const fitTagline = () => {
      taglineEl.style.letterSpacing = '0px';
      const natural = taglineEl.offsetWidth;
      const target = labelEl.offsetWidth * TAGLINE_SHARE;
      taglineEl.style.letterSpacing = `${(target - natural) / taglineEl.textContent.length}px`;
    };
    document.fonts?.ready.then(fitTagline);
    const onWindowResize = () => {
      resize();
      fitTagline();
      applyView(clock.elapsedTime);
    };
    window.addEventListener('resize', onWindowResize);

    const mouse = new THREE.Vector2();
    const mouseSmooth = new THREE.Vector2();
    const spin = { x: 0, y: 0, vx: 0, vy: ROTATION_SPEED, impX: 0, impY: 0 };
    let lastX = null, lastY = null;
    const onMove = (e) => {
      if (lastX !== null) {
        spin.impY += ((e.clientX - lastX) / window.innerWidth) * CONDUCT_STROKE * 6;
        spin.impX += ((e.clientY - lastY) / window.innerHeight) * CONDUCT_STROKE * 6;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      mouse.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    };
    window.addEventListener('pointermove', onMove);

    let raf = 0;
    const R2 = LINK_RADIUS * LINK_RADIUS;
    const fadeStart = LINK_RADIUS * 0.55;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      uniforms.uTime.value = t;
      applyView(t);

      for (let c = 0; c < CLUSTER_COUNT * 3; c++) cOff[c] = Math.sin(t * cFreq[c] + cPhase[c]) * (c % 3 === 2 ? 6 : 9);

      // where the frame centre sits on the z=0 plane, converted into the rotating world's local space
      const pull = focusM * CLUSTER_PULL;
      if (pull > 0) {
        world.updateMatrixWorld();
        rayDir.set(focusNdc.x, focusNdc.y, 0.5).unproject(camera).sub(camera.position).normalize();
        attractor.copy(camera.position).addScaledVector(rayDir, -camera.position.z / rayDir.z);
        world.worldToLocal(attractor);
      }

      // nodes wander around their home (which follows its cluster centre) -> links form and dissolve
      for (let i = 0; i < N; i++) {
        const a = amp[i];
        const f = i * 6;
        const p = i * 3;
        const co = cluster[i] * 3;
        const hx0 = home[p] + (co >= 0 ? cOff[co] : 0);
        const hy0 = home[p + 1] + (co >= 0 ? cOff[co + 1] : 0);
        const hz0 = home[p + 2] + (co >= 0 ? cOff[co + 2] : 0);
        let hx = hx0, hy = hy0, hz = hz0;
        if (co >= 0 && pull > 0) {
          const s = pull * cPull[cluster[i]];
          hx += (attractor.x + cJit[co] - (cHome[co] + cOff[co])) * s;
          hy += (attractor.y + cJit[co + 1] - (cHome[co + 1] + cOff[co + 1])) * s;
          hz += (attractor.z + cJit[co + 2] - (cHome[co + 2] + cOff[co + 2])) * s;
        }
        // depth waves: rings radiating from the centre plus a slower diagonal swell, pushing nodes toward/away from the viewer
        const ring = Math.sin(Math.hypot(hx, hy * 1.4) * 0.22 - t * 1.1);
        const swell = Math.sin(hx * 0.09 + hy * 0.07 - t * 0.6);
        const wave = WAVE_AMP * (0.65 * ring + 0.45 * swell);
        pos[p] = hx + a * Math.sin(t * freq[f] + phase[p]) + a * 0.5 * Math.sin(t * freq[f + 3] * 2.3 + phase[p + 1]);
        pos[p + 1] = hy + a * Math.sin(t * freq[f + 1] + phase[p + 1]) + a * 0.5 * Math.cos(t * freq[f + 4] * 2.1 + phase[p + 2]);
        pos[p + 2] = hz + wave + a * Math.sin(t * freq[f + 2] + phase[p + 2]) + a * 0.5 * Math.sin(t * freq[f + 5] * 1.9 + phase[p]);
      }

      // information pulses spreading through the graph
      if (t > nextPulse && pulses.length < MAX_PULSES) {
        const o = Math.floor(Math.random() * N) * 3;
        pulses.push({ x: pos[o], y: pos[o + 1], z: pos[o + 2], born: t });
        nextPulse = t + 1.5 + Math.random() * 2.5;
      }
      for (let k = pulses.length - 1; k >= 0; k--) if (t - pulses[k].born > 4.5) pulses.splice(k, 1);

      const pulseAt = (x, y, z) => {
        let v = 0;
        for (const pl of pulses) {
          const age = t - pl.born;
          const dx = x - pl.x, dy = y - pl.y, dz = z - pl.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const e = (d - age * 9) / 2.2;
          v += Math.exp(-e * e) * (1 - age / 4.5);
        }
        return v;
      };
      for (let i = 0; i < N; i++) {
        const p = i * 3;
        boost[i] = Math.min(pulseAt(pos[p], pos[p + 1], pos[p + 2]), 1.5);
      }

      // edges
      edgeAlpha.fill(0);
      for (let i = 0; i < N; i++) adj[i].length = 0;
      let ec = 0;
      const ep = edges.position.array, ecol = edges.color.array, ea = edges.alpha.array;
      for (let i = 0; i < N && ec < MAX_EDGES; i++) {
        const ix = pos[i * 3], iy = pos[i * 3 + 1], iz = pos[i * 3 + 2];
        for (let j = i + 1; j < N && ec < MAX_EDGES; j++) {
          const dx = pos[j * 3] - ix;
          if (dx > LINK_RADIUS || dx < -LINK_RADIUS) continue;
          const dy = pos[j * 3 + 1] - iy;
          const dz = pos[j * 3 + 2] - iz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R2) continue;
          const d = Math.sqrt(d2);
          const s = Math.min(Math.max((d - fadeStart) / (LINK_RADIUS - fadeStart), 0), 1);
          const base = 1 - s * s * (3 - 2 * s);
          edgeAlpha[i * N + j] = base;
          adj[i].push(j);
          adj[j].push(i);

          const pulse = pulseAt((ix + pos[j * 3]) / 2, (iy + pos[j * 3 + 1]) / 2, (iz + pos[j * 3 + 2]) / 2);
          const a = Math.min(base * (0.55 + pulse * 1.2), 1.6);
          const v = ec * 2;
          ep.set([ix, iy, iz, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]], v * 3);
          ecol.set(nodeColor.subarray(i * 3, i * 3 + 3), v * 3);
          ecol.set(nodeColor.subarray(j * 3, j * 3 + 3), (v + 1) * 3);
          ea[v] = a;
          ea[v + 1] = a;
          ec++;
        }
      }
      edges.geometry.setDrawRange(0, ec * 2);
      edges.position.needsUpdate = edges.color.needsUpdate = edges.alpha.needsUpdate = true;

      // faces: triangles whose three edges are all alive (hyperedges of order 3)
      let fc = 0;
      const fp = faces.position.array, fcol = faces.color.array, fa = faces.alpha.array;
      for (let i = 0; i < N && fc < MAX_FACES; i++) {
        const ni = adj[i];
        for (let x = 0; x < ni.length && fc < MAX_FACES; x++) {
          const j = ni[x];
          if (j < i) continue;
          for (let y = x + 1; y < ni.length && fc < MAX_FACES; y++) {
            const k = ni[y];
            if (k < i) continue;
            const a1 = Math.min(j, k), b1 = Math.max(j, k);
            const ajk = edgeAlpha[a1 * N + b1];
            if (ajk === 0) continue;
            const h = hash3(i, a1, b1);
            if (h > FACE_RATIO) continue;
            const strength = Math.min(edgeAlpha[i * N + j], edgeAlpha[i * N + k], ajk);
            const a = strength * (0.04 + 0.07 * (h / FACE_RATIO));
            const tri = [i, j, k];
            // slow shimmer so faces breathe
            const shimmer = 0.75 + 0.25 * Math.sin(t * 0.8 + h * 40);
            for (let c = 0; c < 3; c++) {
              const n = tri[c];
              const v = fc * 3 + c;
              fp[v * 3] = pos[n * 3];
              fp[v * 3 + 1] = pos[n * 3 + 1];
              fp[v * 3 + 2] = pos[n * 3 + 2];
              fcol[v * 3] = nodeColor[n * 3];
              fcol[v * 3 + 1] = nodeColor[n * 3 + 1];
              fcol[v * 3 + 2] = nodeColor[n * 3 + 2];
              fa[v] = a * shimmer;
            }
            fc++;
          }
        }
      }
      faces.geometry.setDrawRange(0, fc * 3);
      faces.position.needsUpdate = faces.color.needsUpdate = faces.alpha.needsUpdate = true;
      posAttr.needsUpdate = true;
      boostAttr.needsUpdate = true;

      // camera: slow drift + mouse parallax
      mouseSmooth.lerp(mouse, 1 - Math.exp(-dt * 2.5));
      bgUniforms.uMouse.value.copy(mouseSmooth);
      // conducting: cursor offset steers the spin, and quick strokes add an impulse that decays with inertia
      const targetVY = ROTATION_SPEED + mouse.x * CONDUCT_STEER;
      const targetVX = -mouse.y * CONDUCT_STEER * 0.6;
      const k = 1 - Math.exp(-dt * 1.8);
      spin.vy += (targetVY - spin.vy) * k + spin.impY;
      spin.vx += (targetVX - spin.vx) * k + spin.impX;
      spin.impX = spin.impY = 0;
      spin.vy = Math.max(-CONDUCT_MAX, Math.min(CONDUCT_MAX, spin.vy));
      spin.vx = Math.max(-CONDUCT_MAX, Math.min(CONDUCT_MAX, spin.vx));
      spin.y += spin.vy * dt;
      spin.x += spin.vx * dt;
      world.rotation.y = spin.y;
      world.rotation.x = spin.x * 0.5 + Math.sin(t * 0.037) * 0.12;
      world.rotation.z = Math.sin(t * 0.021) * 0.08;
      camera.position.set(mouseSmooth.x * 1.5, mouseSmooth.y * 1.0, FOCUS_Z + Math.sin(t * 0.08) * 3);
      camera.lookAt(0, 0, 0);

      composer.render();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('pointermove', onMove);
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      composer.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="hypergraph" />
      <div ref={dimRef} className="hypergraph-dim" />
      <div ref={frameRef} className="hypergraph-frame" />
      <div ref={labelRef} className="hypergraph-title">
        <div className="hypergraph-name"><b>Hyper</b>Sonic</div>
        <div ref={taglineRef} className="hypergraph-tagline">First AI Memory Database</div>
        <a className="hypergraph-cta" href="https://www.linkedin.com/newsletters/ai-for-business-leaders-7430140442660200448/" target="_blank" rel="noopener noreferrer">
          Join Airembr to learn more
        </a>
      </div>
      <TypedDoc
        delayMs={(SHRINK_DELAY + SHRINK_TIME + MOVE_DELAY + MOVE_TIME) * 1000}
        top={TOP_PADDING + FRAME_H + DOC_GAP}
      />
    </>
  );
}
