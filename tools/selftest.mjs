/**
 * Runs the analysis chain outside the browser: synthesise the demo loop, find
 * its onsets, and check the tempo and the kick pattern come back right.
 *
 *   node tools/selftest.mjs
 */
import { makeDemo } from "../js/dsp/demo-loop.js";
import { computeFlux, pickOnsets, estimateBPM } from "../js/dsp/onsets.js";
import { loadMesh } from "../js/mesh.js";
import { fingers, setContacts, setParams, strike, step, setOnContact, params } from "../js/physics.js";
import { readFile } from "node:fs/promises";
import { NAMES } from "../js/config.js";

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!ok) failures++;
};

// --- a stand-in for AudioContext.createBuffer -------------------------------
const sr = 44100;
const ctx = {
  sampleRate: sr,
  createBuffer(channels, length, rate) {
    const data = [new Float32Array(length)];
    return {
      numberOfChannels: channels, length, sampleRate: rate,
      duration: length / rate,
      getChannelData: i => data[i]
    };
  }
};

console.log("\nDSP");
const buf = makeDemo(ctx);
const analysis = await computeFlux(buf);
const notes = pickOnsets(analysis, 1.6);
const bpm = estimateBPM(analysis);

check(Math.abs(bpm - 120) < 1, "tempo of the 120 BPM demo loop", `got ${bpm}`);
check(notes.length > 100, "onsets found", `${notes.length}`);

const perFinger = [0, 0, 0, 0, 0];
for (const n of notes) perFinger[n.band]++;
check(perFinger.every(c => c > 0), "every finger gets taps", JSON.stringify(perFinger));

// the loop puts kicks on beats 1 and 3, plus a push on the "and-a" of every
// other bar; beat = 0.5 s
const kicks = [];
for (let bar = 0; bar < 8; bar++) {
  const b0 = bar * 4;
  kicks.push(b0 * 0.5, (b0 + 2) * 0.5);
  if (bar % 2 === 1) kicks.push((b0 + 2.75) * 0.5);
}
const thumb = notes.filter(n => n.band === 0).map(n => n.t);
const missed = kicks.filter(k => Math.min(...thumb.map(t => Math.abs(t - k))) > 0.06);
check(missed.length <= 1, "kicks land on the thumb", `${kicks.length - missed.length}/${kicks.length}`);

console.log("\nphysics");
// every finger must reach the table across the whole slider range
let unreached = 0, combos = 0;
let landed = false;
setOnContact(() => { landed = true; });
const CONTACTS = [0.333, 0.228, 0.242, 0.563, 0.49];
for (const wn of [12, 20, 27, 34, 48]) {
  for (const z of [0.06, 0.3, 0.6, 1.0, 1.1]) {
    setParams(wn, z);
    for (let i = 0; i < 5; i++) {
      for (const s of [0.02, 1.0]) {
        setContacts(CONTACTS);
        landed = false;
        strike(i, s);
        for (let f = 0; f < 120 && !landed; f++) step(1 / 60);
        combos++;
        if (!landed) unreached++;
      }
    }
  }
}
check(unreached === 0, "every finger reaches the table at any wn / zeta / strength",
      unreached ? `${unreached} of ${combos} missed` : `${combos} combinations`);

setParams(27, 0.30);
check(Math.abs(Math.round(1000 * params.lead) - 46) < 6,
      "strike lead at the default settings", `${Math.round(1000 * params.lead)} ms`);

console.log("\nassets");
for (const name of ["mummy", "cyborg"]) {
  const meta = JSON.parse(await readFile(new URL(`../assets/${name}.json`, import.meta.url)));
  const bin = await readFile(new URL(`../assets/${name}.bin`, import.meta.url));
  const expected = meta.n * 6 + meta.t * 6 + meta.n * 3 + meta.n * 2;
  check(bin.length === expected, `${name}.bin size`, `${bin.length} bytes`);
  const idx = new Uint16Array(bin.buffer.slice(bin.byteOffset + meta.n * 6, bin.byteOffset + meta.n * 6 + meta.t * 6));
  let max = 0;
  for (const v of idx) if (v > max) max = v;
  check(max < meta.n, `${name} triangle indices in range`, `max ${max} of ${meta.n}`);
  check(meta.contact.length === 5 && meta.contact.every(c => c > 0.01 && c < 1.2),
        `${name} contact angles sane`,
        meta.contact.map(c => (c * 180 / Math.PI).toFixed(0) + "°").join(" "));
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
