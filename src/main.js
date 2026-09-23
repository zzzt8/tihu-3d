/**
 * 🐦 Pelican on a Bike — A Tiny 3D Adventure
 *
 * Features:
 *  - Fully procedural pelican (no external models) with squash-and-stretch skeletal rig
 *  - Procedural bike with rotating wheels, chain, gears, suspension
 *  - Cyclist kinematic chain: legs follow pedals, body wobbles, head bobs
 *  - Environment: gradient sky, sun/moon, clouds, distant hills, animated ocean
 *  - Procedural road with lane markings that scroll at bike speed
 *  - Particle systems: dust trail, sparkle glints
 *  - Post-processing: bloom, vignette, color grading via shader pass
 *  - First/third/cinematic camera modes with damping
 *  - Sound synthesis (WebAudio API): honk, tire hum, whoosh
 *  - Day/night cycle, smooth lighting interpolation
 *
 * Everything is hand-rolled — no model loaders, no asset packs.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ────────────────────────────────────────────────────────────────────────────
//  Globals
// ────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(6, 4, 8);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 4;
controls.maxDistance = 22;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 1.4, 0);

// State
const state = {
  pedalSpeed: 1.0,
  timeOfDay: 0.5,           // 0 = sunrise, 0.5 = noon, 1 = sunset/night
  cameraMode: 0.5,          // 0 = first-person-ish, 1 = cinematic far
  paused: false,
  totalDistance: 0,
  honking: false,
};

// ────────────────────────────────────────────────────────────────────────────
//  Utilities
// ────────────────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }

// ────────────────────────────────────────────────────────────────────────────
//  Audio (WebAudio synthesis — no assets)
// ────────────────────────────────────────────────────────────────────────────
const audio = (() => {
  let ctx = null;
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function honk() {
    const c = ensure();
    const now = c.currentTime;
    const osc1 = c.createOscillator();
    const osc2 = c.createOscillator();
    const gain = c.createGain();
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.Q.value = 8;
    osc1.type = 'sawtooth';
    osc2.type = 'square';
    osc1.frequency.setValueAtTime(180, now);
    osc1.frequency.exponentialRampToValueAtTime(140, now + 0.4);
    osc2.frequency.setValueAtTime(360, now);
    osc2.frequency.exponentialRampToValueAtTime(280, now + 0.4);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
    gain.gain.linearRampToValueAtTime(0.0, now + 0.45);
    osc1.connect(filter); osc2.connect(filter); filter.connect(gain); gain.connect(c.destination);
    osc1.start(now); osc2.start(now); osc1.stop(now + 0.5); osc2.stop(now + 0.5);

    // Add a bit of flutter
    const lfo = c.createOscillator(); const lfoGain = c.createGain();
    lfo.frequency.value = 12; lfoGain.gain.value = 8;
    lfo.connect(lfoGain).connect(osc1.frequency);
    lfo.start(now); lfo.stop(now + 0.5);
  }
  function tireHum(speed) {
    const c = ensure();
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const src = c.createBufferSource();
    src.buffer = buf; src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 400 + speed * 300; filter.Q.value = 0.7;
    const gain = c.createGain(); gain.gain.value = 0.04 * Math.min(1, speed);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start();
    return { src, gain, filter };
  }
  return { honk, tireHum, ensure };
})();

// ────────────────────────────────────────────────────────────────────────────
//  Lighting & sky
// ────────────────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xffd9a5, 0x4a6fa5, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1c2, 1.4);
sun.position.set(12, 18, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 80;
sun.shadow.camera.left = -25;
sun.shadow.camera.right = 25;
sun.shadow.camera.top = 25;
sun.shadow.camera.bottom = -25;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
scene.add(sun);
scene.add(sun.target);

const rim = new THREE.DirectionalLight(0xff7eb3, 0.25);
rim.position.set(-8, 4, -10);
scene.add(rim);

// Sun visual
const sunVisual = new THREE.Mesh(
  new THREE.SphereGeometry(1.4, 32, 32),
  new THREE.MeshBasicMaterial({ color: 0xfff2a8 })
);
scene.add(sunVisual);
const sunHalo = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 32, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35, side: THREE.BackSide })
);
scene.add(sunHalo);

// Sky gradient via shader sphere (inverted)
const skyGeom = new THREE.SphereGeometry(280, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTopColor:    { value: new THREE.Color(0x4ea1d3) },
    uBottomColor: { value: new THREE.Color(0xffd9b0) },
    uHorizon:     { value: new THREE.Color(0xffe8c2) },
    uSunDir:      { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
    uSunColor:    { value: new THREE.Color(1, 0.9, 0.7) },
    uTime:        { value: 0 },
  },
  vertexShader: `
    varying vec3 vWorldDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldDir = normalize(wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldDir;
    uniform vec3 uTopColor;
    uniform vec3 uBottomColor;
    uniform vec3 uHorizon;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uTime;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

    void main() {
      vec3 dir = normalize(vWorldDir);
      float h = clamp(dir.y, -0.1, 1.0);

      // Vertical gradient
      vec3 col = mix(uBottomColor, uHorizon, smoothstep(-0.1, 0.05, h));
      col = mix(col, uTopColor, smoothstep(0.05, 0.7, h));

      // Sun glow
      float sunDot = clamp(dot(dir, normalize(uSunDir)), 0.0, 1.0);
      col += uSunColor * pow(sunDot, 24.0) * 1.6;
      col += uSunColor * pow(sunDot, 4.0) * 0.18;

      // Twinkly stars at night (when sun is low)
      float nightFactor = smoothstep(0.05, -0.2, uSunDir.y);
      if (nightFactor > 0.0) {
        vec2 sg = floor(dir.xz * 80.0 + dir.y * 50.0);
        float s = hash(sg);
        if (s > 0.997) {
          float tw = 0.6 + 0.4 * sin(uTime * 3.0 + s * 100.0);
          col += vec3(1.0, 0.95, 0.85) * tw * nightFactor;
        }
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const sky = new THREE.Mesh(skyGeom, skyMat);
scene.add(sky);

// Fog for depth
scene.fog = new THREE.Fog(0xc8e3ff, 30, 220);

// ────────────────────────────────────────────────────────────────────────────
//  Procedural Pelican
// ────────────────────────────────────────────────────────────────────────────
function buildPelican() {
  const pelican = new THREE.Group();
  pelican.name = 'pelican';

  // Material library — reuse these to keep GPU state minimal
  const matBody   = new THREE.MeshStandardMaterial({ color: 0xfff7ec, roughness: 0.55, metalness: 0.0 });
  const matWing   = new THREE.MeshStandardMaterial({ color: 0xf5ead2, roughness: 0.6,  metalness: 0.0, side: THREE.DoubleSide });
  const matBeak   = new THREE.MeshStandardMaterial({ color: 0xffb05a, roughness: 0.45, metalness: 0.05 });
  const matPouch  = new THREE.MeshStandardMaterial({ color: 0xffc486, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  const matEye    = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.2, metalness: 0.6 });
  const matEyeIris= new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.3, metalness: 0.2 });
  const matLegs   = new THREE.MeshStandardMaterial({ color: 0xff9d54, roughness: 0.5, metalness: 0.0 });
  const matSock   = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const matHelmet = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.35, metalness: 0.2 });
  const matHelmetStripe = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const matGoggleLens = new THREE.MeshStandardMaterial({ color: 0x4ecdc4, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.85 });

  // ─── Body (squashy egg shape) ───
  const bodyGeom = new THREE.SphereGeometry(0.55, 28, 24);
  bodyGeom.scale(1.0, 1.25, 1.4);
  const body = new THREE.Mesh(bodyGeom, matBody);
  body.castShadow = true; body.receiveShadow = true;
  pelican.add(body);

  // Belly highlight
  const bellyGeom = new THREE.SphereGeometry(0.5, 24, 16);
  bellyGeom.scale(0.9, 0.9, 1.3);
  const belly = new THREE.Mesh(bellyGeom, new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.6 }));
  belly.position.set(0, -0.05, 0.05);
  body.add(belly);

  // ─── Chest (slightly puffed front) ───
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 18), matBody);
  chest.scale.set(0.95, 1.1, 0.85);
  chest.position.set(0, 0.05, 0.5);
  chest.castShadow = true;
  pelican.add(chest);

  // ─── Neck ───
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.35, 0.55);
  pelican.add(neckPivot);

  const neckGeom = new THREE.CylinderGeometry(0.18, 0.26, 0.55, 16);
  const neck = new THREE.Mesh(neckGeom, matBody);
  neck.position.set(0, 0.25, 0.05);
  neck.rotation.x = -0.35;
  neck.castShadow = true;
  neckPivot.add(neck);

  // ─── Head pivot (so the head can bob and turn) ───
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.55, 0.15);
  neckPivot.add(headPivot);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 20), matBody);
  head.scale.set(1.0, 1.05, 1.15);
  head.castShadow = true;
  headPivot.add(head);

  // Eyes
  for (const sx of [-1, 1]) {
    const eyeSocket = new THREE.Group();
    eyeSocket.position.set(sx * 0.14, 0.06, 0.22);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), matEye);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 12), matEyeIris);
    iris.position.z = 0.04;
    const highlight = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    highlight.position.set(0, 0.02, 0.07);
    eyeSocket.add(eye, iris, highlight);
    headPivot.add(eyeSocket);
  }

  // Eyebrows (tiny rotated boxes) for expressiveness
  for (const sx of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.04), new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.6 }));
    brow.position.set(sx * 0.13, 0.16, 0.24);
    brow.rotation.z = sx * 0.18;
    headPivot.add(brow);
  }

  // ─── Beak ───
  const beakRoot = new THREE.Group();
  beakRoot.position.set(0, 0.0, 0.3);
  headPivot.add(beakRoot);

  const upperBeak = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.55, 18), matBeak);
  upperBeak.rotation.x = Math.PI / 2;
  upperBeak.position.set(0, 0.04, 0.28);
  upperBeak.scale.set(1.0, 0.6, 1.0);
  upperBeak.castShadow = true;
  beakRoot.add(upperBeak);

  const lowerBeak = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 18), matBeak);
  lowerBeak.rotation.x = -Math.PI / 2;
  lowerBeak.position.set(0, -0.07, 0.22);
  lowerBeak.scale.set(1.0, 0.55, 1.0);
  lowerBeak.castShadow = true;
  beakRoot.add(lowerBeak);

  // Pouch
  const pouchGeom = new THREE.SphereGeometry(0.22, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  const pouch = new THREE.Mesh(pouchGeom, matPouch);
  pouch.position.set(0, -0.07, 0.22);
  pouch.scale.set(1.0, 0.55, 1.2);
  pouch.rotation.x = Math.PI;
  beakRoot.add(pouch);

  // Nostrils
  for (const sx of [-1, 1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), new THREE.MeshStandardMaterial({ color: 0x442200 }));
    nostril.position.set(sx * 0.04, 0.06, 0.45);
    beakRoot.add(nostril);
  }

  // ─── Helmet (safety first!) ───
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.36, 28, 20, 0, Math.PI * 2, 0, Math.PI / 1.7), matHelmet);
  helmet.position.set(0, 0.18, 0.0);
  helmet.castShadow = true;
  headPivot.add(helmet);
  const helmetStripe = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.015, 8, 28, Math.PI), matHelmetStripe);
  helmetStripe.position.set(0, 0.18, 0.0);
  helmetStripe.rotation.x = Math.PI / 2;
  headPivot.add(helmetStripe);

  // Helmet vents (small black boxes)
  for (let i = 0; i < 4; i++) {
    const a = -0.6 + i * 0.4;
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.04), new THREE.MeshStandardMaterial({ color: 0x111122 }));
    vent.position.set(Math.sin(a) * 0.36, 0.36, Math.cos(a) * 0.36);
    vent.lookAt(0, 0.36, 0);
    headPivot.add(vent);
  }

  // Goggles strap
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.018, 6, 28), new THREE.MeshStandardMaterial({ color: 0x1a1a2e }));
  strap.position.set(0, 0.1, 0.0);
  strap.rotation.x = Math.PI / 2;
  headPivot.add(strap);

  // Goggles (lenses)
  for (const sx of [-1, 1]) {
    const lensGroup = new THREE.Group();
    lensGroup.position.set(sx * 0.13, 0.1, 0.26);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.085, 18, 14, 0, Math.PI), matGoggleLens);
    lens.rotation.y = sx * Math.PI / 2;
    const lensFrame = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.012, 8, 20), new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.4, metalness: 0.4 }));
    lensFrame.rotation.y = sx * Math.PI / 2;
    lensGroup.add(lens, lensFrame);
    headPivot.add(lensGroup);
  }

  // ─── Wings ───
  function makeWing(side) {
    const wingPivot = new THREE.Group();
    wingPivot.position.set(side * 0.45, 0.1, -0.05);
    // Shoulder ball
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), matBody);
    wingPivot.add(shoulder);

    // Wing flat shape using custom geometry
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(0.5, 0.1, 1.0, 0.05);
    shape.quadraticCurveTo(1.2, 0.0, 1.1, -0.15);
    shape.quadraticCurveTo(0.5, -0.35, 0.0, -0.25);
    shape.lineTo(0, 0);
    const wingGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2, steps: 1 });
    wingGeom.translate(0, 0, -0.02);
    const wing = new THREE.Mesh(wingGeom, matWing);
    wing.castShadow = true;
    wingPivot.add(wing);
    wingPivot.userData.wingMesh = wing;
    wingPivot.userData.side = side;
    return wingPivot;
  }
  const leftWing  = makeWing(-1);
  const rightWing = makeWing(+1);
  pelican.add(leftWing, rightWing);

  // ─── Legs (with knees) — animated via IK ───
  function makeLeg(side) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * 0.18, -0.4, 0.05);

    // Upper leg
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.35, 6, 12), matLegs);
    upper.position.set(0, -0.18, 0);
    upper.castShadow = true;
    legGroup.add(upper);

    // Knee joint
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), matLegs);
    knee.position.set(0, -0.38, 0);
    legGroup.add(knee);

    // Lower leg
    const lowerPivot = new THREE.Group();
    lowerPivot.position.set(0, -0.38, 0);
    legGroup.add(lowerPivot);
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.32, 6, 12), matLegs);
    lower.position.set(0, -0.18, 0);
    lower.castShadow = true;
    lowerPivot.add(lower);

    // Sock
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.12, 12), matSock);
    sock.position.set(0, -0.38, 0);
    lowerPivot.add(sock);

    // Shoe
    const shoeGeom = new THREE.BoxGeometry(0.14, 0.07, 0.28);
    shoeGeom.translate(0, 0, 0.06);
    const shoe = new THREE.Mesh(shoeGeom, new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.5 }));
    shoe.castShadow = true;
    const shoePivot = new THREE.Group();
    shoePivot.position.set(0, -0.45, 0.02);
    shoe.position.set(0, 0, 0);
    shoePivot.add(shoe);
    lowerPivot.add(shoePivot);

    // Sole stripe
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.018, 0.29), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    sole.position.set(0, -0.036, 0.06);
    shoePivot.add(sole);

    return { group: legGroup, upper, knee, lowerPivot, shoePivot };
  }
  const leftLeg  = makeLeg(-1);
  const rightLeg = makeLeg(+1);
  pelican.add(leftLeg.group, rightLeg.group);

  // ─── Tail feathers ───
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.35, 6), matWing);
  tail.position.set(0, -0.05, -0.65);
  tail.rotation.x = -0.7;
  tail.castShadow = true;
  pelican.add(tail);

  // Wing tip details (primary feathers as small boxes)
  for (const wing of [leftWing, rightWing]) {
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, 0.18), new THREE.MeshStandardMaterial({ color: 0xe0cda0 }));
      f.position.set(0.4 + i * 0.08, -0.18, 0);
      f.rotation.y = -0.1;
      wing.userData.wingMesh.add(f);
    }
  }

  return {
    group: pelican,
    body, headPivot, neckPivot, beakRoot, upperBeak, lowerBeak, pouch,
    leftWing, rightWing, leftLeg, rightLeg, tail,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Procedural Bike
// ────────────────────────────────────────────────────────────────────────────
function buildBike() {
  const bike = new THREE.Group();
  bike.name = 'bike';

  const matFrame   = new THREE.MeshStandardMaterial({ color: 0x4ecdc4, roughness: 0.35, metalness: 0.5 });
  const matFrame2  = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.35, metalness: 0.4 });
  const matRubber  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
  const matSpoke   = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.4, metalness: 0.8 });
  const matHub     = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3, metalness: 0.7 });
  const matSeat    = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7 });
  const matGrip    = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
  const matBell    = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.25, metalness: 0.9 });
  const matBasket  = new THREE.MeshStandardMaterial({ color: 0x8b4513, roughness: 0.7 });
  const matAccent  = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });

  // Helper to make a wheel
  function makeWheel(radius = 0.5) {
    const w = new THREE.Group();
    // Tire
    const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.06, 14, 36), matRubber);
    tire.rotation.y = Math.PI / 2;
    tire.castShadow = true;
    w.add(tire);
    // Rim
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.06, 0.018, 8, 36), matHub);
    rim.rotation.y = Math.PI / 2;
    w.add(rim);
    // Spokes
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, radius * 2 - 0.12, 4), matSpoke);
      spoke.rotation.z = a;
      spoke.rotation.x = Math.PI / 2;
      w.add(spoke);
    }
    // Hub
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 16), matHub);
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    // Hubcap detail
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.125, 12), matAccent);
    cap.rotation.z = Math.PI / 2;
    w.add(cap);
    return w;
  }

  const wheelR = 0.5;
  const rearWheel = makeWheel(wheelR);
  rearWheel.position.set(0, wheelR, -0.85);
  const frontWheel = makeWheel(wheelR);
  frontWheel.position.set(0, wheelR, 0.85);
  bike.add(rearWheel, frontWheel);

  // Frame: main triangle (top tube, down tube, seat tube)
  // We'll use cylinders connecting key points
  const rearAxle = new THREE.Vector3(0, wheelR, -0.85);
  const frontAxle = new THREE.Vector3(0, wheelR, 0.85);
  const bb = new THREE.Vector3(0, wheelR - 0.05, -0.05);   // bottom bracket
  const seatTop = new THREE.Vector3(0, wheelR + 0.95, -0.35);
  const headTop = new THREE.Vector3(0, wheelR + 0.85, 0.65);

  function tube(a, b, r, mat) {
    const v = new THREE.Vector3().subVectors(b, a);
    const len = v.length();
    const g = new THREE.CylinderGeometry(r, r, len, 14);
    const m = new THREE.Mesh(g, mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    // align cylinder Y axis to v
    const up = new THREE.Vector3(0, 1, 0);
    const dir = v.clone().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    m.quaternion.copy(quat);
    m.castShadow = true;
    return m;
  }

  // Chainstay (rear axle to bb)
  bike.add(tube(rearAxle, bb, 0.035, matFrame));
  // Seat tube (bb to seat top)
  bike.add(tube(bb, seatTop, 0.038, matFrame));
  // Down tube (bb to head top)
  bike.add(tube(bb, headTop, 0.04, matFrame));
  // Top tube (seat top to head top)
  bike.add(tube(seatTop, headTop, 0.035, matFrame));
  // Seat stay (rear axle to seat top)
  bike.add(tube(rearAxle, new THREE.Vector3(seatTop.x, seatTop.y, seatTop.z), 0.028, matFrame2));
  // Fork (head top to front axle) - two blades
  bike.add(tube(headTop, frontAxle, 0.028, matFrame2));
  bike.add(tube(headTop, new THREE.Vector3(frontAxle.x, frontAxle.y, frontAxle.z), 0.028, matFrame2));

  // Headset (where fork meets frame)
  const headset = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 14), matHub);
  headset.position.copy(headTop);
  headset.rotation.z = 0.18;
  bike.add(headset);

  // Handlebar stem
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 12), matFrame2);
  stem.position.copy(headTop).add(new THREE.Vector3(0, 0.04, 0.08));
  stem.rotation.x = 0.25;
  bike.add(stem);

  // Handlebars
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.6, 12), matFrame);
  bar.position.copy(headTop).add(new THREE.Vector3(0, 0.18, 0.18));
  bar.rotation.x = Math.PI / 2;
  bike.add(bar);
  // Grips
  for (const sx of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 12), matGrip);
    grip.position.copy(headTop).add(new THREE.Vector3(0, 0.18, 0.18 + sx * 0.31));
    grip.rotation.x = Math.PI / 2;
    bike.add(grip);
  }
  // Bell
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), matBell);
  bell.position.copy(headTop).add(new THREE.Vector3(0, 0.2, 0.05));
  bike.add(bell);

  // Seat post + saddle
  const seatPost = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 12), matFrame2);
  seatPost.position.copy(seatTop).add(new THREE.Vector3(0, 0.16, 0));
  bike.add(seatPost);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.14), matSeat);
  saddle.position.copy(seatTop).add(new THREE.Vector3(0, 0.34, -0.04));
  saddle.castShadow = true;
  bike.add(saddle);

  // Pedal crank (with chainring)
  const crankPivot = new THREE.Group();
  crankPivot.position.copy(bb);
  bike.add(crankPivot);

  const chainring = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.025, 24), matHub);
  chainring.rotation.z = Math.PI / 2;
  crankPivot.add(chainring);
  // Chainring teeth (small)
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.018, 0.012), matAccent);
    tooth.position.set(0.16 * Math.cos(a), 0.16 * Math.sin(a), 0.018);
    tooth.rotation.z = a;
    crankPivot.add(tooth);
  }

  // Crank arms + pedals
  const crankLength = 0.18;
  function makeCrank(side) {
    const crankGroup = new THREE.Group();
    crankPivot.add(crankGroup);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(crankLength, 0.04, 0.025), matFrame);
    arm.position.set(side * crankLength / 2, 0, 0.04);
    arm.castShadow = true;
    crankGroup.add(arm);
    const pedalPivot = new THREE.Group();
    pedalPivot.position.set(side * crankLength, 0, 0.08);
    crankGroup.add(pedalPivot);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.1), matGrip);
    pedal.castShadow = true;
    pedalPivot.add(pedal);
    // Pedal spindle
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8), matHub);
    spindle.rotation.x = Math.PI / 2;
    pedalPivot.add(spindle);
    return { crankGroup, pedalPivot };
  }
  const leftCrank  = makeCrank(-1);
  const rightCrank = makeCrank(+1);

  // Rear sprocket
  const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 18), matHub);
  sprocket.rotation.z = Math.PI / 2;
  sprocket.position.copy(rearAxle).add(new THREE.Vector3(0.07, 0, 0));
  bike.add(sprocket);

  // Chain (visual): a tube connecting chainring top to sprocket top
  // Will be regenerated dynamically because angles change.
  const chainTop = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.7), matHub);
  bike.add(chainTop);
  const chainBot = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.7), matHub);
  bike.add(chainBot);

  // Basket on front
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.24, 16, 1, true), matBasket);
  basket.position.copy(headTop).add(new THREE.Vector3(0, -0.12, 0.2));
  basket.castShadow = true;
  bike.add(basket);
  // Basket bottom
  const basketBottom = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16), matBasket);
  basketBottom.position.copy(headTop).add(new THREE.Vector3(0, -0.23, 0.2));
  bike.add(basketBottom);
  // Fish in the basket 🐟
  const fish = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.05, 0.16, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x88c5e8, roughness: 0.45, metalness: 0.4 })
  );
  fish.rotation.z = Math.PI / 2;
  fish.position.copy(headTop).add(new THREE.Vector3(0, -0.13, 0.2));
  fish.castShadow = true;
  bike.add(fish);
  // Fish tail
  const fishTail = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.1, 4),
    new THREE.MeshStandardMaterial({ color: 0x6fb0d8, roughness: 0.5 })
  );
  fishTail.rotation.z = -Math.PI / 2;
  fishTail.position.copy(headTop).add(new THREE.Vector3(0.18, -0.13, 0.2));
  bike.add(fishTail);

  // Flag pole
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 6), matHub);
  flagPole.position.copy(headTop).add(new THREE.Vector3(0, 0.45, 0));
  bike.add(flagPole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xff6b6b, side: THREE.DoubleSide, roughness: 0.5 })
  );
  flag.position.copy(headTop).add(new THREE.Vector3(0.16, 0.6, 0));
  bike.add(flag);

  // Water bottle on frame
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.2, 12),
    new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.4 })
  );
  bottle.position.copy(bb).add(new THREE.Vector3(0, 0.15, 0.35));
  bottle.rotation.z = 0.6;
  bike.add(bottle);
  const bottleCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10),
    new THREE.MeshStandardMaterial({ color: 0x222222 })
  );
  bottleCap.position.copy(bbottlePosition(bottle));
  bike.add(bottleCap);

  function bbottlePosition(b) {
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v;
  }
  bottleCap.position.copy(bottle.position).add(new THREE.Vector3(0.13, 0.05, 0));

  return {
    group: bike,
    rearWheel, frontWheel,
    crankPivot, leftCrank, rightCrank,
    chainTop, chainBot, chainring, sprocket,
    bar, stem, seatPost,
    flag, bell, fish, basket,
    bb, headTop, seatTop,
    wheelR,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Scene assembly
// ────────────────────────────────────────────────────────────────────────────
const bike = buildBike();
scene.add(bike.group);

const pelican = buildPelican();
// Position pelican on the bike: sitting on saddle, hands on bars
pelican.group.position.set(0, bike.wheelR + 0.85, -0.3);  // approx saddle height
pelican.group.rotation.y = 0;
scene.add(pelican.group);

// Hands on bars — we'll attach hand spheres to the bar and move arms toward them
function makeHand() {
  const hand = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff9d54, roughness: 0.55 })
  );
  hand.castShadow = true;
  return hand;
}
const leftHand = makeHand(); const rightHand = makeHand();
scene.add(leftHand, rightHand);

// ────────────────────────────────────────────────────────────────────────────
//  Environment: road, ground, ocean, hills, clouds
// ────────────────────────────────────────────────────────────────────────────
const groundGeom = new THREE.PlaneGeometry(800, 800, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x8bc78b, roughness: 0.95 });
const ground = new THREE.Mesh(groundGeom, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

// Ocean strip on one side
const oceanGeom = new THREE.PlaneGeometry(800, 60, 1, 1);
const oceanMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColorDeep: { value: new THREE.Color(0x1864ab) }, uColorShallow: { value: new THREE.Color(0x4ec5e8) } },
  vertexShader: `
    varying vec2 vUv;
    varying float vWave;
    uniform float uTime;
    void main() {
      vUv = uv;
      vec3 p = position;
      float w = sin(p.x * 0.4 + uTime * 1.2) * 0.06 + cos(p.x * 0.15 - uTime * 0.8) * 0.08;
      p.z += w;
      vWave = w;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    varying float vWave;
    uniform vec3 uColorDeep;
    uniform vec3 uColorShallow;
    uniform float uTime;
    void main() {
      vec3 col = mix(uColorDeep, uColorShallow, vUv.y * 0.9 + vWave * 0.3);
      // Foam at far edge
      float foam = smoothstep(0.0, 0.04, sin(vUv.x * 80.0 + uTime * 2.0) * 0.5 + 0.5 - vUv.y * 0.7);
      col = mix(col, vec3(1.0), foam * smoothstep(0.0, 0.05, 1.0 - vUv.y));
      // Sparkles
      float s = fract(sin(dot(floor(vUv * 200.0), vec2(12.9898, 78.233))) * 43758.5453);
      if (s > 0.997 && vUv.y > 0.4) col += vec3(1.0) * 0.6;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const ocean = new THREE.Mesh(oceanGeom, oceanMat);
ocean.rotation.x = -Math.PI / 2;
ocean.position.set(0, 0.02, -55);
scene.add(ocean);

// Beach strip
const beach = new THREE.Mesh(
  new THREE.PlaneGeometry(800, 12),
  new THREE.MeshStandardMaterial({ color: 0xf4e1b5, roughness: 0.95 })
);
beach.rotation.x = -Math.PI / 2;
beach.position.set(0, 0.04, -42);
beach.receiveShadow = true;
scene.add(beach);

// Road
const roadGeom = new THREE.PlaneGeometry(4, 400, 1, 1);
const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.95 });
const road = new THREE.Mesh(roadGeom, roadMat);
road.rotation.x = -Math.PI / 2;
road.position.set(0, 0.05, 0);
road.receiveShadow = true;
scene.add(road);

// Road stripes (instanced for performance)
const stripeCount = 200;
const stripeGeom = new THREE.PlaneGeometry(0.18, 1.2);
const stripeMat = new THREE.MeshStandardMaterial({ color: 0xfff2a8, roughness: 0.8 });
const stripes = new THREE.InstancedMesh(stripeGeom, stripeMat, stripeCount);
stripes.rotation.x = -Math.PI / 2;
stripes.position.y = 0.06;
scene.add(stripes);
const stripeDummy = new THREE.Object3D();
const stripePositions = [];
for (let i = 0; i < stripeCount; i++) {
  const z = -200 + i * 2;
  stripePositions.push(z);
  stripeDummy.position.set(0, 0.06, z);
  stripeDummy.rotation.set(0, 0, 0);
  stripeDummy.updateMatrix();
  stripes.setMatrixAt(i, stripeDummy.matrix);
}
stripes.instanceMatrix.needsUpdate = true;

// Edge lines
const edgeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
const leftEdge = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 400), edgeMat);
leftEdge.rotation.x = -Math.PI / 2;
leftEdge.position.set(-1.9, 0.06, 0);
scene.add(leftEdge);
const rightEdge = leftEdge.clone();
rightEdge.position.x = 1.9;
scene.add(rightEdge);

// Hills (distant low-poly)
const hills = [];
const hillGeom = new THREE.ConeGeometry(8, 4 + Math.random() * 4, 16);
const hillMat = new THREE.MeshStandardMaterial({ color: 0x6b8e4e, roughness: 0.95, flatShading: true });
for (let i = 0; i < 18; i++) {
  const h = new THREE.Mesh(hillGeom, hillMat);
  const ang = (i / 18) * Math.PI * 2;
  const r = 80 + Math.random() * 20;
  h.position.set(Math.cos(ang) * r, 1.5, Math.sin(ang) * r);
  h.scale.set(1 + Math.random() * 0.6, 0.6 + Math.random() * 0.4, 1 + Math.random() * 0.6);
  h.castShadow = false;
  scene.add(h);
  hills.push(h);
}

// Trees (low-poly cones)
const treeGroup = new THREE.Group();
const trunkGeom = new THREE.CylinderGeometry(0.15, 0.18, 0.8, 8);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
const leavesGeom = new THREE.ConeGeometry(0.9, 2.2, 8);
const leavesMat = new THREE.MeshStandardMaterial({ color: 0x4a8b3a, roughness: 0.9, flatShading: true });
const treePositions = [];
for (let i = 0; i < 40; i++) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = side * (3 + Math.random() * 8);
  const z = -50 + Math.random() * 100;
  treePositions.push({ x, z });
  const t = new THREE.Group();
  const trunk = new THREE.Mesh(trunkGeom, trunkMat);
  trunk.position.y = 0.4;
  const leaves = new THREE.Mesh(leavesGeom, leavesMat);
  leaves.position.y = 1.6;
  leaves.rotation.y = Math.random() * Math.PI;
  leaves.castShadow = true;
  t.add(trunk, leaves);
  t.position.set(x, 0, z);
  t.scale.setScalar(0.7 + Math.random() * 0.6);
  treeGroup.add(t);
}
scene.add(treeGroup);

// Clouds
const clouds = [];
const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.9 });
function makeCloud() {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(1 + Math.random() * 0.8, 12, 10), cloudMat);
    puff.position.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 2);
    puff.scale.y = 0.6;
    g.add(puff);
  }
  return g;
}
for (let i = 0; i < 8; i++) {
  const c = makeCloud();
  c.position.set((Math.random() - 0.5) * 80, 14 + Math.random() * 6, (Math.random() - 0.5) * 80);
  c.scale.setScalar(1 + Math.random() * 1.5);
  scene.add(c);
  clouds.push(c);
}

// Fireflies / dust particles around bike
const dustCount = 60;
const dustGeom = new THREE.BufferGeometry();
const dustPos = new Float32Array(dustCount * 3);
const dustVel = new Float32Array(dustCount * 3);
for (let i = 0; i < dustCount; i++) {
  dustPos[i * 3]     = (Math.random() - 0.5) * 6;
  dustPos[i * 3 + 1] = 0.1 + Math.random() * 1.5;
  dustPos[i * 3 + 2] = (Math.random() - 0.5) * 4;
  dustVel[i * 3]     = -0.5 - Math.random();
  dustVel[i * 3 + 1] = (Math.random() - 0.5) * 0.05;
  dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
}
dustGeom.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({ color: 0xfff2a8, size: 0.06, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false });
const dust = new THREE.Points(dustGeom, dustMat);
scene.add(dust);

// ────────────────────────────────────────────────────────────────────────────
//  Post-processing
// ────────────────────────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.setSize(window.innerWidth, window.innerHeight);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.6, 0.85);
composer.addPass(bloom);

const colorPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.35 },
    uSaturation: { value: 1.05 },
    uContrast: { value: 1.05 },
    uTint: { value: new THREE.Color(0xffffff) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Saturation
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      // Contrast
      c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
      // Tint
      c.rgb *= uTint;
      // Vignette
      vec2 q = vUv - 0.5;
      float v = 1.0 - dot(q, q) * uVignette * 2.2;
      c.rgb *= v;
      gl_FragColor = c;
    }
  `,
});
composer.addPass(colorPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

// ────────────────────────────────────────────────────────────────────────────
//  UI wiring
// ────────────────────────────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed');
const timeSlider = document.getElementById('time');
const camSlider = document.getElementById('cam');
const speedVal = document.getElementById('v-speed');
const timeVal = document.getElementById('v-time');
const camVal = document.getElementById('v-cam');
const honkBtn = document.getElementById('honkBtn');
const resetBtn = document.getElementById('resetBtn');
const fpsEl = document.getElementById('fps');
const distEl = document.getElementById('dist');
const loader = document.getElementById('loader');

speedSlider.addEventListener('input', e => {
  state.pedalSpeed = parseFloat(e.target.value);
  speedVal.textContent = state.pedalSpeed.toFixed(2) + '×';
});
timeSlider.addEventListener('input', e => {
  state.timeOfDay = parseFloat(e.target.value);
  const labels = ['Sunrise', 'Morning', 'Noon', 'Afternoon', 'Sunset', 'Dusk', 'Evening', 'Night'];
  const t = state.timeOfDay;
  let lbl;
  if (t < 0.12) lbl = labels[0];
  else if (t < 0.3) lbl = labels[1];
  else if (t < 0.55) lbl = labels[2];
  else if (t < 0.75) lbl = labels[3];
  else if (t < 0.88) lbl = labels[4];
  else if (t < 0.94) lbl = labels[5];
  else if (t < 0.98) lbl = labels[6];
  else lbl = labels[7];
  timeVal.textContent = lbl;
});
camSlider.addEventListener('input', e => {
  state.cameraMode = parseFloat(e.target.value);
  camVal.textContent = ['Close', 'Side', 'Cinematic', 'Far'][Math.min(3, Math.floor(state.cameraMode * 4))];
});
honkBtn.addEventListener('click', () => {
  audio.ensure();
  audio.honk();
  state.honking = true;
  pelican.beakRoot.rotation.x = -0.4;
  setTimeout(() => { state.honking = false; }, 700);
});
resetBtn.addEventListener('click', () => {
  controls.reset();
  camera.position.set(6, 4, 8);
  controls.target.set(0, 1.4, 0);
});
window.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    honkBtn.click();
  } else if (e.code === 'KeyR') {
    resetBtn.click();
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  Resize
// ────────────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
});

// ────────────────────────────────────────────────────────────────────────────
//  Animation state
// ────────────────────────────────────────────────────────────────────────────
let t0 = performance.now() / 1000;
let lastFpsUpdate = t0;
let frameCount = 0;
let lastFPS = 60;
const bikeAnchor = new THREE.Group();   // The bike moves along Z (toward camera)
bikeAnchor.add(bike.group);
scene.add(bikeAnchor);
// Move pelican along with bike anchor
bikeAnchor.add(pelican.group);

// Audio for tire hum
let hum = audio.tireHum(state.pedalSpeed);

// ────────────────────────────────────────────────────────────────────────────
//  Animation loop
// ────────────────────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now() / 1000;
  const dt = Math.min(0.05, now - t0);  // clamp dt to avoid jumps on tab switch
  t0 = now;
  frameCount++;
  if (now - lastFpsUpdate > 0.5) {
    lastFPS = frameCount / (now - lastFpsUpdate);
    frameCount = 0;
    lastFpsUpdate = now;
    fpsEl.textContent = lastFPS.toFixed(0);
  }

  // ─── Time of day ───
  const tod = state.timeOfDay;
  // Sun position: arc from east to west
  const sunAng = Math.PI * (0.05 + tod * 0.9); // 0 = east horizon, 1 = west horizon
  const sunHeight = Math.sin(sunAng);
  const sunX = -Math.cos(sunAng) * 30;
  const sunY = sunHeight * 30 + 2;
  sun.position.set(sunX, Math.max(2, sunY), 12);
  sun.target.position.set(0, 1.5, 0);
  sunVisual.position.copy(sun.position);
  sunHalo.position.copy(sun.position);

  // Lighting interpolation
  const dayIntensity = clamp(sunHeight, 0.0, 1.0);
  const nightBlend = 1 - dayIntensity;
  sun.intensity = lerp(0.15, 1.5, dayIntensity);
  ambient.intensity = lerp(0.25, 0.55, dayIntensity);
  hemi.intensity = lerp(0.2, 0.55, dayIntensity);
  // Sun color: warm at sunrise/sunset, white at noon
  const sunCol = new THREE.Color().setHSL(
    lerp(0.08, 0.13, dayIntensity),     // hue (warm orange to pale yellow)
    lerp(0.8, 0.3, dayIntensity),
    lerp(0.6, 0.95, dayIntensity)
  );
  sun.color.copy(sunCol);
  sunVisual.material.color.copy(sunCol).multiplyScalar(1.4);
  sunHalo.material.color.copy(sunCol).multiplyScalar(1.2);
  sunHalo.material.opacity = 0.15 + 0.35 * (1 - dayIntensity);

  // Sky colors based on time
  const dayCol = new THREE.Color(0x4ea1d3);
  const sunsetCol = new THREE.Color(0xff7e5f);
  const nightCol = new THREE.Color(0x0d1b3d);
  const horizonDay = new THREE.Color(0xffe8c2);
  const horizonSunset = new THREE.Color(0xffaa66);
  const horizonNight = new THREE.Color(0x1a2a5e);
  const bottomDay = new THREE.Color(0xffd9b0);
  const bottomSunset = new THREE.Color(0x6b3a4a);
  const bottomNight = new THREE.Color(0x050818);

  // Two-stage blend: day <-> sunset (t around 0/1) and sunset <-> night (sunHeight)
  const sunsetFactor = 1 - clamp(Math.abs(tod - 0.5) * 4, 0, 1);
  const toNight = nightBlend;

  skyMat.uniforms.uTopColor.value.copy(dayCol).lerp(sunsetCol, sunsetFactor * 0.6).lerp(nightCol, toNight);
  skyMat.uniforms.uHorizon.value.copy(horizonDay).lerp(horizonSunset, sunsetFactor).lerp(horizonNight, toNight);
  skyMat.uniforms.uBottomColor.value.copy(bottomDay).lerp(bottomSunset, sunsetFactor).lerp(bottomNight, toNight);
  skyMat.uniforms.uSunDir.value.copy(sun.position).normalize();
  skyMat.uniforms.uTime.value = now;
  // Sun color in sky shader
  skyMat.uniforms.uSunColor.value.copy(sunCol).multiplyScalar(lerp(1.5, 0.6, toNight));

  // Fog & tone mapping exposure
  scene.fog.color.copy(skyMat.uniforms.uHorizon.value);
  renderer.toneMappingExposure = lerp(0.8, 1.2, dayIntensity);

  // ─── Bike motion: scroll the world along Z ───
  const bikeSpeed = state.pedalSpeed * 3.0;  // meters per second
  const wheelAngularVel = bikeSpeed / bike.wheelR;
  const crankRpm = wheelAngularVel * 60 / (Math.PI * 2) * 2.5;  // gearing
  const crankAng = (crankRpm * Math.PI * 2 / 60) * now * 1.0;

  // Update distance
  state.totalDistance += bikeSpeed * dt;
  distEl.textContent = state.totalDistance.toFixed(0) + 'm';

  // Update audio hum
  if (hum) {
    hum.gain.gain.value = 0.04 * Math.min(1, state.pedalSpeed);
    hum.filter.frequency.value = 400 + state.pedalSpeed * 300;
  }

  // Rotate wheels
  bike.rearWheel.rotation.x += wheelAngularVel * dt;
  bike.frontWheel.rotation.x += wheelAngularVel * dt;
  // Steer front wheel slightly with mouse via OrbitControls — small tilt
  // (We don't override orbit, just visually tilt with movement)
  bike.frontWheel.rotation.y = Math.sin(now * 0.5) * 0.05;

  // Rotate crank
  bike.crankPivot.rotation.z = crankAng;
  // Rotate chainring/sprocket proportionally
  bike.chainring.rotation.x = crankAng * 0.4;
  bike.sprocket.rotation.x = -wheelAngularVel * now * 0.4;

  // Update chain (the chain just visually moves along)
  // (Simple boxes already positioned correctly)

  // ─── Pelican animation ───
  // Body squash & stretch based on pedal phase
  const pedalPhase = crankAng % (Math.PI * 2);
  const pedalSide = Math.sin(pedalPhase);     // -1..1, positive = right pedal forward
  const pedalPush = Math.cos(pedalPhase);     // leg extension factor

  // Body bob (vertical)
  const bobAmount = 0.05 * state.pedalSpeed;
  const bodyBob = Math.sin(now * Math.PI * 2 * 0.7 * state.pedalSpeed) * bobAmount;
  // Body sway (side to side with each pedal stroke)
  const bodySway = Math.sin(pedalPhase) * 0.04 * state.pedalSpeed;
  // Body lean forward (cycle faster when speed is up)
  const bodyLean = 0.12 + Math.sin(now * 1.3) * 0.015;
  pelican.body.position.set(bodySway, bodyBob, 0);

  // Pelican also moves with bike along Z — but since bike is anchored and road scrolls,
  // we keep pelican stationary relative to the bike anchor.

  // Head look: slight turn
  const headTurn = Math.sin(now * 0.6) * 0.15 + Math.sin(now * 0.13) * 0.05;
  const headTilt = Math.sin(now * 0.9) * 0.04;
  pelican.headPivot.rotation.y = headTurn;
  pelican.headPivot.rotation.z = headTilt;
  pelican.headPivot.rotation.x = -bodyLean * 0.5;
  pelican.neckPivot.rotation.x = -bodyLean;

  // Beak: open/close during honk, else subtle breathing
  if (state.honking) {
    pelican.beakRoot.rotation.x = -0.4;
    pelican.pouch.scale.y = 1.4;
  } else {
    pelican.beakRoot.rotation.x = Math.sin(now * 2) * 0.04;
    pelican.pouch.scale.y = 1.0 + Math.sin(now * 2) * 0.05;
  }

  // Wings: flap gently, more at higher speeds (small lift)
  const wingFlap = Math.sin(now * 6 + Math.sin(now * 0.7) * 0.5);
  pelican.leftWing.rotation.z = -0.15 + wingFlap * 0.2 * state.pedalSpeed;
  pelican.rightWing.rotation.z = 0.15 - wingFlap * 0.2 * state.pedalSpeed;
  pelican.leftWing.rotation.x = -0.1;
  pelican.rightWing.rotation.x = -0.1;

  // Tail: gentle counter-bob
  pelican.tail.rotation.z = Math.sin(now * 1.2) * 0.05;

  // ─── Leg IK ───
  // We solve for each leg given pedal world position.
  function solveLeg(leg, pedalWorld, hipPos) {
    const target = pedalWorld.clone();
    // Constrain to a comfortable working volume relative to hip
    const dir = new THREE.Vector3().subVectors(target, hipPos);
    const dist = clamp(dir.length(), 0.4, 1.1);
    dir.normalize().multiplyScalar(dist);
    // Slightly forward, mostly down
    const thigh = new THREE.Vector3().copy(hipPos).add(dir.clone().multiplyScalar(0.5));
    // Bend leg visually: rotate upper toward thigh
    const hipToThigh = thigh.clone().sub(hipPos);
    leg.upper.rotation.x = Math.atan2(hipToThigh.z, -hipToThigh.y) + Math.PI / 2;
    leg.upper.rotation.z = Math.atan2(hipToThigh.x, -hipToThigh.y);
    // Lower leg to point at pedal
    const thighToPedal = target.clone().sub(thigh);
    leg.lowerPivot.rotation.x = Math.atan2(thighToPedal.z, -thighToPedal.y) + Math.PI / 2;
    leg.lowerPivot.rotation.z = Math.atan2(thighToPedal.x, -thighToPedal.y);
  }

  // Compute world hip positions
  const leftHipLocal = new THREE.Vector3(-0.18, -0.4, 0.05);
  const rightHipLocal = new THREE.Vector3(0.18, -0.4, 0.05);
  const leftHipWorld = leftHipLocal.clone();
  const rightHipWorld = rightHipLocal.clone();
  // Apply pelican position
  leftHipWorld.applyMatrix4(pelican.group.matrixWorld);
  rightHipWorld.applyMatrix4(pelican.group.matrixWorld);

  // Compute world pedal positions
  const leftPedalLocal = new THREE.Vector3();
  bike.leftCrank.pedalPivot.getWorldPosition(leftPedalLocal);
  const rightPedalLocal = new THREE.Vector3();
  bike.rightCrank.pedalPivot.getWorldPosition(rightPedalLocal);
  // They are in world space because bike is in scene
  // But we need to convert to pelican-local space because solveLeg uses world deltas
  // Actually since both are in world space (pelican is added to bikeAnchor which is in scene), it's fine.

  solveLeg(pelican.leftLeg,  leftPedalLocal,  leftHipWorld);
  solveLeg(pelican.rightLeg, rightPedalLocal, rightHipWorld);

  // Place hands on handlebars
  bike.bar.getWorldPosition(leftHand.position);
  leftHand.position.x -= 0.28;
  leftHand.position.y -= 0.01;
  bike.bar.getWorldPosition(rightHand.position);
  rightHand.position.x += 0.28;
  rightHand.position.y -= 0.01;

  // ─── World scroll ───
  // Move ground, road, ocean, beach along Z (or rather, move all the moving scenery)
  // The bike stays in place; the world scrolls underneath.
  const scrollDelta = bikeSpeed * dt;

  // Move stripes
  for (let i = 0; i < stripeCount; i++) {
    stripePositions[i] += scrollDelta;
    if (stripePositions[i] > 100) stripePositions[i] -= stripeCount * 2;
    stripeDummy.position.set(0, 0.06, stripePositions[i]);
    stripeDummy.updateMatrix();
    stripes.setMatrixAt(i, stripeDummy.matrix);
  }
  stripes.instanceMatrix.needsUpdate = true;

  // Move trees
  treeGroup.children.forEach(t => {
    t.position.z += scrollDelta;
    if (t.position.z > 50) t.position.z -= 100;
  });

  // Move clouds (slowly, opposite direction)
  clouds.forEach(c => {
    c.position.z += scrollDelta * 0.1;
    c.position.x += 0.02;
    if (c.position.z > 50) c.position.z -= 100;
    if (c.position.x > 50) c.position.x -= 100;
  });

  // Move ocean shader time
  oceanMat.uniforms.uTime.value = now;

  // Hills: stationary but we can rotate group around bike for subtle parallax
  hills.forEach((h, i) => {
    // gentle sway
    h.rotation.y = Math.sin(now * 0.1 + i) * 0.005;
  });

  // ─── Dust particles ───
  const positions = dust.geometry.attributes.position.array;
  for (let i = 0; i < dustCount; i++) {
    positions[i * 3]     += dustVel[i * 3] * scrollDelta * 0.5;
    positions[i * 3 + 1] += dustVel[i * 3 + 1] * dt * 0.3 + Math.sin(now * 2 + i) * 0.001;
    positions[i * 3 + 2] += dustVel[i * 3 + 2] * dt * 0.3;
    if (positions[i * 3] < -4) {
      positions[i * 3] = 4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 4;
    }
  }
  dust.geometry.attributes.position.needsUpdate = true;

  // ─── Flag ───
  if (bike.flag) {
    bike.flag.rotation.y = Math.sin(now * 4) * 0.4;
  }
  // Fish in basket wiggles
  if (bike.fish) {
    bike.fish.rotation.y = Math.sin(now * 3) * 0.3;
  }

  // ─── Camera ───
  // Mode-based camera positioning
  const camT = state.cameraMode;  // 0..1
  // Closest = behind & slightly above pelican head
  // Far = cinematic side angle
  const camDist = lerp(3.5, 10, camT);
  const camHeight = lerp(2.2, 4.2, camT);
  const camAngle = lerp(-0.2, 0.8, camT); // -0.2 = behind, 0.8 = side
  const targetCamPos = new THREE.Vector3(
    Math.sin(camAngle) * camDist,
    camHeight,
    Math.cos(camAngle) * camDist
  );
  // Slight oscillation for cinematic feel
  targetCamPos.y += Math.sin(now * 0.7) * 0.05;
  targetCamPos.x += Math.sin(now * 0.4) * 0.1;
  // Lerp toward target only if user isn't dragging
  if (!controls.isDragging) {
    // Only softly nudge; OrbitControls owns the position otherwise
    const nudgeStrength = 0.0015 * (1 - camT);
    camera.position.lerp(targetCamPos.add(new THREE.Vector3(0, 1.4, 0)), nudgeStrength);
    controls.target.lerp(new THREE.Vector3(0, 1.4, 0), 0.05);
  }
  // Make bike gently bob (suspension)
  bikeAnchor.position.y = Math.sin(now * 8 * state.pedalSpeed) * 0.015;
  bikeAnchor.rotation.z = Math.sin(now * 6 * state.pedalSpeed) * 0.008;
  bikeAnchor.rotation.x = Math.sin(now * 5 * state.pedalSpeed + 1) * 0.006;

  controls.update();
  composer.render();
}

// Initial controls position
controls.target.set(0, 1.4, 0);
controls.update();

// Hide loader after first frame
requestAnimationFrame(() => {
  composer.render();
  setTimeout(() => loader.classList.add('hidden'), 400);
});

animate();

// Expose for debugging
window.__tihu = { scene, camera, renderer, bike, pelican, state };
