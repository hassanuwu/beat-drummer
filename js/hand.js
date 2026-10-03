/**
 * The hand: a three.js scene with the bend done on the GPU.
 *
 * Every vertex carries the digit it belongs to and how much of that digit's
 * rotation it follows, so the whole hand is one draw call and the five bend
 * angles are just uniforms. Normals get the same rotation, or the lighting
 * would slide off as a finger moves.
 *
 * three.js is expected as a global (the UMD build, loaded from a script tag).
 */
import { NB, HANDS } from "./config.js";
import { loadMesh } from "./mesh.js";
import { fingers, params, setContacts, setOnContact } from "./physics.js";

let TARGET;   // built in init(), once three.js is on the page

const PRESETS = {
  three: { az: -56, el: 24, dist: 1.81 },
  side:  { az: -90, el: 11, dist: 2.05 },
  top:   { az: -62, el: 70, dist: 1.74 },
  front: { az: -12, el: 19, dist: 1.72 }
};
const EL_MIN = 4, EL_MAX = 86, D_MIN = 0.75, D_MAX = 4.2;

let scene, cam, renderer, handMesh, canvas;
let uBend = new Array(NB).fill(0), uGlow = new Array(NB).fill(0);
let ripples = [], ripplePtr = 0;
let contactTip = [];
let meshes = {};             // name -> { geometry, meta }
let handKey = "mummy";
let orbit = Object.assign({}, PRESETS.three);
let widen = 0;
let ready = false;
let colors = [];
let onPresetChange = () => {};

const VERT = `
attribute float aFinger;
attribute float aWeight;
uniform float uBend[5];
uniform vec3  uPiv[5];
uniform vec3  uAxis[5];
uniform float uBob;
varying vec3 vN; varying vec3 vW; varying float vF; varying float vWt;
vec3 rod(vec3 v, vec3 k, float a){
  float c = cos(a), s = sin(a);
  return v*c + cross(k,v)*s + k*dot(k,v)*(1.0-c);
}
void main(){
  vec3 p = position, nn = normal;
  if (aWeight > 0.001){
    for (int i=0; i<5; i++){
      if (abs(aFinger - float(i)) < 0.5){
        float th = uBend[i]*aWeight;
        p  = uPiv[i] + rod(position - uPiv[i], uAxis[i], th);
        nn = rod(normal, uAxis[i], th);
      }
    }
  }
  p.y += uBob;
  vF = aFinger; vWt = aWeight;
  vN = normalize(normalMatrix * nn);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vW = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
precision highp float;
uniform vec3 uCol[5];
uniform float uGlow[5];
uniform vec3 uSkin; uniform vec3 uShade; uniform float uSpec;
varying vec3 vN; varying vec3 vW; varying float vF; varying float vWt;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(-vW);
  vec3 key  = normalize(vec3(-0.45, 0.85, 0.65));
  vec3 fill = normalize(vec3( 0.80, 0.15, 0.35));
  float kd = max(dot(N, key), 0.0);
  float fd = max(dot(N, fill), 0.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 base = mix(uShade, uSkin, 0.25 + 0.75*kd);
  base += uShade*fd*0.55;
  float spec = pow(max(dot(normalize(key+V), N), 0.0), 26.0)*uSpec;

  vec3 tint = vec3(0.0); float g = 0.0;
  for (int i=0; i<5; i++){
    if (abs(vF - float(i)) < 0.5){ tint = uCol[i]; g = uGlow[i]; }
  }
  float heat = g*smoothstep(0.0, 0.85, vWt);
  vec3 col = mix(base, tint, heat*0.82) + tint*heat*0.35 + rim*mix(uSkin, tint, heat)*0.42 + spec;
  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.85)), 1.0);
}`;

function gradTexture(stops){
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const x = c.getContext("2d");
  const grd = x.createRadialGradient(128,128,0,128,128,128);
  for (const [p, col] of stops) grd.addColorStop(p, col);
  x.fillStyle = grd; x.fillRect(0,0,256,256);
  return new THREE.CanvasTexture(c);
}


/* ---------------------------------------------------------------- scene --- */

/**
 * Build the scene and load the first hand.
 * `bandColors` are the five lane colours, read from the page's CSS so the
 * fingers, pads and highway all agree.
 */
export async function init(glCanvas, bandColors, firstHand = "mummy") {
  canvas = glCanvas;
  colors = bandColors.slice();
  TARGET = new THREE.Vector3(-0.02, 0.22, 0.02);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true,
                                       powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(36, 2, 0.05, 50);

  const cfg = HANDS[firstHand];
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBend:  { value: uBend },
      uGlow:  { value: uGlow },
      uPiv:   { value: [] },
      uAxis:  { value: [] },
      uBob:   { value: 0 },
      uCol:   { value: colors.map(c => new THREE.Color(c)) },
      uSkin:  { value: new THREE.Color(cfg.skin) },
      uShade: { value: new THREE.Color(cfg.shade) },
      uSpec:  { value: cfg.spec }
    }
  });
  handMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  scene.add(handMesh);

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 5),
    new THREE.MeshBasicMaterial({
      map: gradTexture([[0, "#6b513b"], [0.45, "#4a382a"], [1, "#20180f"]]),
      transparent: true, opacity: 0.95, depthWrite: false
    })
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.002;
  table.name = "table";
  scene.add(table);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 2.4),
    new THREE.MeshBasicMaterial({
      map: gradTexture([[0, "rgba(0,0,0,0.78)"], [0.55, "rgba(0,0,0,0.3)"], [1, "rgba(0,0,0,0)"]]),
      transparent: true, depthWrite: false
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.004, 0.08);
  scene.add(shadow);

  const ringGeo = new THREE.RingGeometry(0.055, 0.075, 40);
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide
    }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.006;
    m.userData.age = 9;
    scene.add(m);
    ripples.push(m);
  }

  setOnContact(spawnRipple);
  bindOrbit();
  ready = true;
  await setHand(firstHand);
  resize();
}

/* ------------------------------------------------------------- the hands --- */

/** Load a hand if needed, then swap it in. Geometry is cached per name. */
export async function setHand(key) {
  if (!HANDS[key]) return;
  if (!meshes[key]) {
    const d = await loadMesh(key);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(d.position, 3));
    geo.setAttribute("normal",   new THREE.BufferAttribute(d.normal, 3));
    geo.setAttribute("aFinger",  new THREE.BufferAttribute(d.finger, 1));
    geo.setAttribute("aWeight",  new THREE.BufferAttribute(d.weight, 1));
    geo.setIndex(new THREE.BufferAttribute(d.index, 1));
    geo.computeBoundingSphere();
    meshes[key] = { geo, meta: d.meta };
  }
  const { geo, meta } = meshes[key];
  const cfg = HANDS[key];
  handKey = key;

  handMesh.geometry = geo;
  const u = handMesh.material.uniforms;
  u.uPiv.value  = meta.piv.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  u.uAxis.value = meta.axis.map(a => new THREE.Vector3(a[0], a[1], a[2]).normalize());
  u.uSkin.value.set(cfg.skin);
  u.uShade.value.set(cfg.shade);
  u.uSpec.value = cfg.spec;

  setContacts(meta.contact);
  contactTip = contactTips(meta);
  TARGET.y = cfg.targetY;
  applyCamera();
}

export function currentHand() { return handKey; }

/** Where each fingertip ends up once it has swung down to the table. */
function contactTips(meta) {
  return meta.tip.map((t, i) => {
    const piv = new THREE.Vector3(...meta.piv[i]);
    const p = new THREE.Vector3(t[0], t[1], t[2]).sub(piv);
    const k = new THREE.Vector3(...meta.axis[i]).normalize();
    const a = meta.contact[i], c = Math.cos(a), s = Math.sin(a);
    return p.clone().multiplyScalar(c)
      .add(new THREE.Vector3().crossVectors(k, p).multiplyScalar(s))
      .add(k.clone().multiplyScalar(k.dot(p) * (1 - c)))
      .add(piv);
  });
}

function spawnRipple(i, strength) {
  if (!ready || !contactTip[i]) return;
  const m = ripples[ripplePtr++ % ripples.length];
  const t = contactTip[i];
  m.position.set(t.x, 0.006, t.z);
  m.material.color.set(colors[i]);
  m.userData.age = 0;
  m.userData.power = strength;
}

export function setTableOpacity(o) {
  if (!ready) return;
  const t = scene.getObjectByName("table");
  if (t) t.material.opacity = o;
}

/* ------------------------------------------------------- orbit camera --- */

export function setPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  orbit = Object.assign({}, p);
  TARGET.y = HANDS[handKey].targetY;
  applyCamera();
  onPresetChange(name);
}

export function onPreset(fn) { onPresetChange = fn; }

function applyCamera() {
  if (!ready) return;
  const az = orbit.az * Math.PI / 180, el = orbit.el * Math.PI / 180;
  const d = orbit.dist * (1 + widen * 0.22) * (HANDS[handKey].distK || 1);
  cam.position.set(
    TARGET.x + d * Math.cos(el) * Math.sin(az),
    TARGET.y + d * Math.sin(el),
    TARGET.z + d * Math.cos(el) * Math.cos(az)
  );
  cam.lookAt(TARGET);
  cam.updateProjectionMatrix();
}

function nudge(daz, del, dd) {
  orbit.az = (orbit.az + daz) % 360;
  orbit.el = Math.max(EL_MIN, Math.min(EL_MAX, orbit.el + del));
  orbit.dist = Math.max(D_MIN, Math.min(D_MAX, orbit.dist * (dd || 1)));
  applyCamera();
  onPresetChange(null);
}

function bindOrbit() {
  const pts = new Map();
  let lastPinch = 0;
  const gap = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add("dragging");
    if (pts.size === 2) lastPinch = gap();
  });
  canvas.addEventListener("pointermove", e => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) nudge(-dx * 0.32, dy * 0.26, 1);
    else if (pts.size === 2) {
      const g = gap();
      if (lastPinch > 0) nudge(0, 0, lastPinch / g);
      lastPinch = g;
    }
  });
  const end = e => {
    pts.delete(e.pointerId);
    if (!pts.size) canvas.classList.remove("dragging");
    lastPinch = 0;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    nudge(0, 0, Math.exp(e.deltaY * 0.0012));
  }, { passive: false });

  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", e => {
    const k = e.key;
    if (k === "ArrowLeft")       { e.preventDefault(); nudge(-6, 0, 1); }
    else if (k === "ArrowRight") { e.preventDefault(); nudge(6, 0, 1); }
    else if (k === "ArrowUp")    { e.preventDefault(); nudge(0, 4, 1); }
    else if (k === "ArrowDown")  { e.preventDefault(); nudge(0, -4, 1); }
    else if (k === "+" || k === "=") { e.preventDefault(); nudge(0, 0, 0.9); }
    else if (k === "-")              { e.preventDefault(); nudge(0, 0, 1.11); }
  });
}

/* ------------------------------------------------------------- frame --- */

export function resize() {
  if (!ready) return;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 340;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  cam.aspect = w / h;
  widen = Math.max(0, Math.min(1, (760 - w) / 420));
  cam.fov = 36 + widen * 5;
  applyCamera();
}

export function render(dt) {
  if (!ready) return;
  for (let i = 0; i < NB; i++) { uBend[i] = fingers[i].th; uGlow[i] = fingers[i].glow; }
  handMesh.material.uniforms.uBob.value = params.bob * 0.05;

  for (const m of ripples) {
    if (m.userData.age > 1.05) { m.material.opacity = 0; continue; }
    m.userData.age += dt * 1.9;
    const a = m.userData.age;
    const s = 1 + a * 5.5 * (0.6 + m.userData.power);
    m.scale.set(s, s, s);
    m.material.opacity = Math.max(0, (1 - a) * 0.55 * (0.5 + m.userData.power));
  }
  renderer.render(scene, cam);
}
