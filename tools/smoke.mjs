/**
 * Boots app.js against a stubbed DOM, three.js and Web Audio, so the module
 * graph, the element ids and the start-up path are exercised without a browser.
 *
 *   node tools/smoke.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const ids = new Set();
const logs = [];

const said = {};
function el(id = "?") {
  const node = {
    id, textContent: "", value: "0.3", hidden: false, files: [], tabIndex: 0,
    style: { setProperty(){}, getPropertyValue: () => "", removeProperty(){} },
    dataset: {}, clientWidth: 700, clientHeight: 340, currentTime: 0, paused: true,
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, setAttribute(){}, removeAttribute(){},
    appendChild(){}, setPointerCapture(){}, load(){}, pause(){},
    play: () => Promise.resolve(),
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 340 }),
    getContext: () => {
      const g = () => new Proxy({}, { get: () => g, set: () => true, apply: () => g });
      return new Proxy({}, { get: () => g, set: () => true });
    },
    animate: () => ({}), innerHTML: ""
  };
  return new Proxy(node, {
    set(t, k, v) { if (k === "textContent") said[id] = v; t[k] = v; return true; }
  });
}

globalThis.document = {
  getElementById(id) { ids.add(id); return el(id); },
  createElement: () => el("created"),
  documentElement: el("root"),
  addEventListener(){}
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 2;
globalThis.matchMedia = () => ({ matches: false, addEventListener(){} });
globalThis.ResizeObserver = class { observe(){} disconnect(){} };
globalThis.getComputedStyle = () => ({ getPropertyValue: n => "#e8a13a" });
globalThis.requestAnimationFrame = () => 0;
globalThis.addEventListener = () => {};
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};
globalThis.AudioContext = class {
  constructor() { this.sampleRate = 44100; this.currentTime = 0; this.state = "running"; }
  createBuffer(c, n, sr) {
    const d = [new Float32Array(n)];
    return { numberOfChannels: c, length: n, sampleRate: sr, duration: n / sr,
             getChannelData: i => d[i] };
  }
  createBufferSource() { return { connect(){}, start(){}, stop(){}, disconnect(){} }; }
  resume() { return Promise.resolve(); }
};

// fetch reads straight off disk so the real asset files are parsed
globalThis.fetch = async (url) => {
  const p = path.join(root, String(url));
  const buf = await readFile(p);
  return {
    ok: true, status: 200,
    json: async () => JSON.parse(buf.toString("utf8")),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  };
};

// a three.js stand-in: records which classes the renderer actually asks for
const used = new Set();
const Vec3 = class {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  sub() { return this; } add() { return this; } clone() { return new Vec3(); }
  normalize() { return this; } multiplyScalar() { return this; }
  crossVectors() { return this; } dot() { return 0; } set() { return this; }
};
globalThis.THREE = new Proxy({
  Vector3: Vec3,
  Color: class { constructor(){} set(){} },
  Mesh: class { constructor(g, m) { this.geometry = g; this.material = m;
                 this.rotation = {x:0}; this.position = new Vec3();
                 this.scale = { set(){} }; this.userData = {}; } },
  Scene: class { add(){} getObjectByName() { return { material: { opacity: 1 } }; } },
  PerspectiveCamera: class { constructor(){ this.position = new Vec3(); }
                             lookAt(){} updateProjectionMatrix(){} },
  WebGLRenderer: class { constructor(o){ this.o = o; } setClearColor(){} setPixelRatio(){}
                         setSize(){} render(){} },
  BufferGeometry: class { setAttribute(){} setIndex(){} computeBoundingSphere(){} },
  BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
  ShaderMaterial: class { constructor(o) { Object.assign(this, o); } },
  MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); this.color = { set(){} }; } },
  PlaneGeometry: class {}, RingGeometry: class {}, CanvasTexture: class {},
  DoubleSide: 2
}, { get(t, k) { used.add(String(k)); return t[k]; } });

let failed = false;
process.on("unhandledRejection", e => { console.log("  FAIL  unhandled:", e.message); failed = true; });

console.log("\nbooting app.js against stubs…");
try {
  await import("../js/app.js");
  await new Promise(r => setTimeout(r, 400));   // let the async boot finish
  console.log("  ok    module graph loaded and boot ran");
} catch (e) {
  console.log("  FAIL ", e.message);
  console.log(e.stack.split("\n").slice(1, 4).join("\n"));
  failed = true;
}

for (const [id, text] of Object.entries(said)) {
  if (/couldn't|can't|unavailable|error/i.test(String(text))) {
    console.log(`  FAIL  #${id} reported: ${text}`);
    failed = true;
  }
}
console.log(`  ok    ${ids.size} element ids requested`);
console.log(`  ok    three.js classes used: ${[...used].filter(k => /^[A-Z]/.test(k)).join(", ")}`);
console.log(failed ? "\nsmoke test FAILED\n" : "\nsmoke test passed\n");
process.exit(failed ? 1 : 0);
