/**
 * Table Drummer: audio transport, the scrolling note highway, and the UI.
 *
 * Analysis lives in js/dsp/, the spring model in js/physics.js, and the 3D hand
 * in js/hand.js. This file wires them to the page.
 */
import { NB, NAMES, ROLES, KEYS, W_PERFECT, W_GOOD, W_MISS, HANDS } from "./config.js";
import { computeFlux, pickOnsets, estimateBPM } from "./dsp/onsets.js";
import { makeDemo } from "./dsp/demo-loop.js";
import * as physics from "./physics.js";
import * as hand from "./hand.js";

const $ = id => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------- state --- */

let ctx = null, buffer = null, an = null, notes = [], nextIdx = 0;
let src = null, playing = false, startedAt = 0, startOffset = 0, duration = 0;
let kind = "buffer";              // "buffer" = generated demo, "media" = a loaded file
let mediaURL = null;
let mode = "watch";
let score = { combo: 0, best: 0, perfect: 0, good: 0, miss: 0 };
const flashes = [];
const vid = $("vid"), stage = $("stage");

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function now() {
  if (kind === "media") return vid.currentTime || 0;
  if (!playing) return startOffset;
  const lat = ctx.outputLatency || ctx.baseLatency || 0;
  return Math.max(0, ctx.currentTime - startedAt + startOffset - lat);
}

const fmt = t => {
  t = Math.max(0, t | 0);
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
};

const setStatus = s => { $("status").textContent = s; };


/* ------------------------------------------------- pads and scoring --- */

function strike(b, strength) {
  physics.strike(b, strength == null ? 0.6 : strength);
  const pad = pads[b];
  pad.classList.add("lit");
  setTimeout(() => pad.classList.remove("lit"), 90);
  if (b === 0 && !reduced && stage.classList.contains("hasvideo")) {
    stage.classList.add("thump");
    setTimeout(() => stage.classList.remove("thump"), 70);
  }
}

const padWrap = $("pads");
const pads = NAMES.map((name, i) => {
  const b = document.createElement("button");
  b.className = "pad";
  b.style.setProperty("--pc", "var(--c-"+i+")");
  b.innerHTML = '<kbd>'+KEYS[i].toUpperCase()+'</kbd><small>'+name+'</small><em>'+ROLES[i]+'</em>';
  b.addEventListener("pointerdown", e => { e.preventDefault(); input(i); });
  padWrap.appendChild(b);
  return b;
});

addEventListener("keydown", e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const i = KEYS.indexOf(k);
  if (i >= 0){ e.preventDefault(); input(i); return; }
  if (k === " "){ e.preventDefault(); togglePlay(); }
});

function input(b){
  if (mode === "watch"){ strike(b, 0.7); return; }
  strike(b, 0.7);
  if (!playing) return;
  const t = now();
  let best = null, bestD = W_MISS;
  for (let i=Math.max(0,nextIdx-24); i<notes.length; i++){
    const n = notes[i];
    if (n.t > t + W_MISS) break;
    if (n.judged || n.band !== b) continue;
    const d = Math.abs(n.t - t);
    if (d < bestD){ bestD = d; best = n; }
  }
  if (!best){ bump("early", b); score.combo = 0; updateScore(); return; }
  best.judged = true;
  if (bestD <= W_PERFECT){ best.grade = "perfect"; score.perfect++; score.combo++; bump("perfect", b); }
  else if (bestD <= W_GOOD){ best.grade = "good"; score.good++; score.combo++; bump("good", b); }
  else { best.grade = "late"; score.miss++; score.combo = 0; bump("late", b); }
  if (score.combo > score.best) score.best = score.combo;
  updateScore();
}

function bump(kind, band){ flashes.push({ kind, band, at: performance.now() }); }

function updateScore(){
  const total = score.perfect + score.good + score.miss;
  $("sCombo").textContent = score.combo;
  $("sPerf").textContent = score.perfect;
  $("sMiss").textContent = score.miss;
  $("sAcc").textContent = total ? Math.round((score.perfect + score.good*0.6)/total*100) + "%" : "—";
}

/* ---------------- highway ---------------- */

const cv = $("highway"), g2 = cv.getContext("2d");
let cw = 0, chh = 0;
function resize(){
  const dpr = Math.min(2, devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  cw = r.width; chh = r.height;
  cv.width = Math.round(cw*dpr); cv.height = Math.round(chh*dpr);
  g2.setTransform(dpr,0,0,dpr,0,0);
}
new ResizeObserver(resize).observe(cv);
resize();

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const COLORS = [];
for (let i = 0; i < NB; i++) COLORS[i] = css("--c-" + i) || "#e8a13a";

const AHEAD = 2.1, BEHIND = 0.45;

function drawHighway(t){
  g2.clearRect(0,0,cw,chh);
  const padT = 10, rowH = (chh - padT*2)/NB;
  const nowX = cw*0.18;
  const pxPerSec = (cw - nowX)/AHEAD;

  // lanes
  g2.lineWidth = 1;
  for (let b=0; b<NB; b++){
    const y = padT + rowH*b + rowH/2;
    g2.strokeStyle = css("--line") || "#352e25";
    g2.beginPath(); g2.moveTo(0, y); g2.lineTo(cw, y); g2.stroke();
    g2.fillStyle = COLORS[b];
    g2.globalAlpha = .55;
    g2.fillRect(0, y-rowH*0.34, 3, rowH*0.68);
    g2.globalAlpha = 1;
  }

  // notes
  for (let i=0; i<notes.length; i++){
    const n = notes[i];
    const dt = n.t - t;
    if (dt < -BEHIND) continue;
    if (dt > AHEAD) break;
    const x = nowX + dt*pxPerSec;
    const y = padT + rowH*n.band + rowH/2;
    const h = rowH*(0.3 + 0.42*n.s);
    let a = dt < 0 ? Math.max(0, 1 + dt/BEHIND)*0.45 : Math.min(1, 0.35 + n.s*0.75);
    g2.globalAlpha = a;
    g2.fillStyle = n.judged && n.grade === "perfect" ? "#ffffff" : COLORS[n.band];
    const w = 7;
    g2.beginPath();
    if (g2.roundRect) g2.roundRect(x-w/2, y-h/2, w, h, 3);
    else g2.rect(x-w/2, y-h/2, w, h);
    g2.fill();
  }
  g2.globalAlpha = 1;

  // now line
  g2.strokeStyle = css("--fg") || "#f0e7d9";
  g2.globalAlpha = .85;
  g2.lineWidth = 2;
  g2.beginPath(); g2.moveTo(nowX, 2); g2.lineTo(nowX, chh-2); g2.stroke();
  g2.globalAlpha = 1;

  // judgement flashes
  const tn = performance.now();
  for (let i=flashes.length-1; i>=0; i--){
    const f = flashes[i], age = (tn - f.at)/420;
    if (age >= 1){ flashes.splice(i,1); continue; }
    const y = padT + rowH*f.band + rowH/2;
    g2.globalAlpha = (1-age)*0.9;
    g2.font = "600 11px "+(css("--mono")||"monospace");
    g2.fillStyle = f.kind === "perfect" ? "#ffffff" : f.kind === "good" ? css("--ok") : css("--bad");
    g2.fillText(f.kind.toUpperCase(), nowX + 10, y - 6 - age*10);
    g2.globalAlpha = 1;
  }
}

/* ---------------- loop ---------------- */

let lastFrame = performance.now();
function frame(){
  requestAnimationFrame(frame);
  const tn = performance.now();
  const dt = Math.min(0.05, (tn - lastFrame)/1000);
  lastFrame = tn;
  const t = now();

  if (playing){
    // swing early by the time it takes the finger to fall, so the tap
    // itself lands on the beat instead of trailing it
    const fire = t + (mode === "watch" ? physics.params.lead : 0);
    while (nextIdx < notes.length && notes[nextIdx].t <= fire){
      const n = notes[nextIdx];
      if (mode === "watch") strike(n.band, n.s);
      nextIdx++;
    }
    if (mode === "play"){
      for (let i=Math.max(0,nextIdx-64); i<nextIdx; i++){
        const n = notes[i];
        if (!n.judged && n.t < t - W_MISS){ n.judged = true; n.grade = "miss"; score.miss++; score.combo = 0; bump("miss", n.band); updateScore(); }
      }
    }
    if (duration && t >= duration){ stop(false); }
    const p = duration ? Math.min(1, t/duration) : 0;
    $("fill").style.width = (p*100).toFixed(2)+"%";
    $("scrub").setAttribute("aria-valuenow", Math.round(p*100));
    $("clock").textContent = fmt(t)+" / "+fmt(duration);
  }
  physics.step(dt);
  hand.render(dt);
  drawHighway(t);
}
requestAnimationFrame(frame);

/* ---------------- transport ---------------- */

function syncIndex(t){
  nextIdx = 0;
  const fire = t + (mode === "watch" ? physics.params.lead : 0);
  while (nextIdx < notes.length && notes[nextIdx].t <= fire) nextIdx++;
}
function resetJudgements(){
  for (const n of notes){ n.judged = false; n.grade = null; }
  score = { combo:0, best:0, perfect:0, good:0, miss:0 };
  updateScore();
}

async function start(from){
  const t = Math.max(0, Math.min(from, Math.max(0, duration-0.05)));
  if (kind === "media"){
    try { vid.currentTime = t; } catch(e){}
    syncIndex(t);
    const p = vid.play();
    if (p && p.catch) p.catch(() => setStatus("Press Play again — the browser wants a direct tap first."));
  } else {
    if (!buffer) return;
    const c = getCtx();
    if (c.state === "suspended") await c.resume();
    stopSource();
    startOffset = t;
    src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    startedAt = c.currentTime;
    src.start(0, startOffset);
    syncIndex(startOffset);
  }
  playing = true;
  $("btnPlay").textContent = "Pause";
  $("led").classList.remove("idle");
}
function stopSource(){
  if (src){ try { src.onended = null; src.stop(); } catch(e){} src.disconnect(); src = null; }
}
function stop(keepPos){
  const t = now();
  if (kind === "media"){
    vid.pause();
    if (!keepPos){ try { vid.currentTime = 0; } catch(e){} }
    startOffset = keepPos ? t : 0;
  } else {
    stopSource();
    startOffset = keepPos ? t : 0;
  }
  playing = false;
  $("btnPlay").textContent = "Play";
  $("led").classList.add("idle");
  if (!keepPos){
    $("fill").style.width = "0%";
    $("clock").textContent = "0:00 / "+fmt(duration);
    syncIndex(0);
    if (mode === "play") resetJudgements();
  }
}
function togglePlay(){
  if (!an) return;
  if (playing) stop(true);
  else { if (mode === "play" && startOffset === 0) resetJudgements(); start(startOffset); }
}

$("btnPlay").addEventListener("click", togglePlay);
$("btnStop").addEventListener("click", () => { stop(false); });

function seekFromEvent(e){
  const r = $("scrub").getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (e.clientX - r.left)/r.width));
  const t = p*duration;
  if (mode === "play") resetJudgements();
  if (playing) start(t);
  else {
    startOffset = t;
    if (kind === "media"){ try { vid.currentTime = t; } catch(e){} }
    syncIndex(t);
    $("fill").style.width = (p*100).toFixed(2)+"%";
    $("clock").textContent = fmt(t)+" / "+fmt(duration);
  }
}
$("scrub").addEventListener("pointerdown", seekFromEvent);
$("scrub").addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const t = Math.max(0, Math.min(duration, now() + (e.key === "ArrowRight" ? 5 : -5)));
  if (playing) start(t);
  else { startOffset = t; if (kind === "media"){ try { vid.currentTime = t; } catch(err){} } syncIndex(t); }
});

// the element owns its own clock, so follow it rather than fight it
vid.addEventListener("seeked", () => syncIndex(now()));
vid.addEventListener("pause", () => { if (playing && !vid.ended) stop(true); });
vid.addEventListener("ended", () => stop(false));

/* ---------------- mode ---------------- */

function setMode(m){
  mode = m;
  $("mWatch").setAttribute("aria-pressed", String(m === "watch"));
  $("mPlay").setAttribute("aria-pressed", String(m === "play"));
  $("score").hidden = m !== "play";
  $("modeHint").textContent = m === "watch"
    ? "The hand taps the beat for you. Switch to Play and tap it yourself with A S D F G."
    : "Hit each note as it crosses the line — A S D F G, or tap the pads. Thumb is the kick.";
  resetJudgements();
  syncIndex(now());
}
$("mWatch").addEventListener("click", () => setMode("watch"));
$("mPlay").addEventListener("click", () => setMode("play"));

/* ---------------- loading ---------------- */

async function load(buf, label){
  stop(false);
  if (kind === "buffer") buffer = buf;
  duration = buf.duration;
  setStatus("Analysing spectral flux…");
  an = await computeFlux(buf, p => setStatus("Analysing spectral flux… " + Math.round(p*100) + "%"));
  repick();
  const bpm = estimateBPM(an);
  $("roBpm").textContent = bpm || "—";
  $("roSrc").textContent = label;
  $("clock").textContent = "0:00 / "+fmt(duration);
  setStatus(label + " — " + notes.length + " taps mapped across 5 fingers. Press Play.");
}

function repick(){
  if (!an) return;
  const sens = parseFloat($("sens").value);
  notes = pickOnsets(an, sens);
  $("roHits").textContent = notes.length;
  syncIndex(now());
  if (mode === "play") resetJudgements();
}

$("sens").addEventListener("input", () => {
  $("sensVal").textContent = parseFloat($("sens").value).toFixed(2);
  repick();
});

$("file").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const isVideo = /^video\//.test(f.type) || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name);
  const label = f.name.replace(/\.[^.]+$/, "").slice(0, 28);
  try {
    stop(false);
    setStatus("Reading " + f.name + "…");

    // the element plays the file (picture and sound); the decoded copy is only for analysis
    if (mediaURL) URL.revokeObjectURL(mediaURL);
    mediaURL = URL.createObjectURL(f);
    vid.src = mediaURL;
    vid.load();
    kind = "media";
    stage.classList.toggle("hasvideo", isVideo);
    hand.setTableOpacity(isVideo ? 0.42 : 0.95);

    setStatus("Decoding the audio track…");
    const ab = await f.arrayBuffer();
    const buf = await getCtx().decodeAudioData(ab);
    await load(buf, label);
    if (isVideo) setStatus(label + " — " + notes.length + " taps mapped. The video plays behind the hand.");
  } catch (err){
    stage.classList.remove("hasvideo");
    hand.setTableOpacity(0.95);
    kind = "buffer";
    setStatus(isVideo
      ? "That video's audio track wouldn't decode here. MP4 with AAC audio works best."
      : "Couldn't decode that file. Try an MP3, WAV or M4A.");
  }
});

function physLabels(){
  $("wnVal").textContent = (physics.params.wn/(2*Math.PI)).toFixed(1) + " Hz";
  $("zVal").textContent = physics.params.zeta.toFixed(2);
  const z = physics.params.zeta;
  $("zHint").textContent = z < 0.98
    ? "Underdamped (ζ < 1): the finger overshoots and rings before settling."
    : z < 1.02
      ? "Critically damped (ζ = 1): fastest return with no overshoot."
      : "Overdamped (ζ > 1): the finger crawls back, no bounce.";
}
$("wn").addEventListener("input", e => { physics.setParams(parseFloat(e.target.value), null); physLabels(); });
$("zeta").addEventListener("input", e => { physics.setParams(null, parseFloat(e.target.value)); physLabels(); });
physLabels();

$("btnDemo").addEventListener("click", async () => {
  stop(false);
  vid.removeAttribute("src");
  vid.load();
  if (mediaURL){ URL.revokeObjectURL(mediaURL); mediaURL = null; }
  stage.classList.remove("hasvideo");
  hand.setTableOpacity(0.95);
  kind = "buffer";
  $("file").value = "";
  await load(makeDemo(getCtx()), "Demo loop");
});

/* ------------------------------------------------------ view controls --- */

function markPreset(name) {
  for (const b of $("camPresets").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.cam === name));
}

$("camPresets").addEventListener("click", e => {
  const b = e.target.closest("button[data-cam]");
  if (b) hand.setPreset(b.dataset.cam);
});

$("handPick").addEventListener("click", async e => {
  const b = e.target.closest("button[data-hand]");
  if (!b) return;
  const key = b.dataset.hand;
  const was = $("status").textContent;
  setStatus("Loading the " + HANDS[key].label + " hand\u2026");
  try {
    await hand.setHand(key);
    for (const x of $("handPick").querySelectorAll("button"))
      x.setAttribute("aria-pressed", String(x.dataset.hand === key));
    setStatus(was);
  } catch (err) {
    setStatus("Couldn't load the " + HANDS[key].label + " hand: " + err.message);
  }
});

/* -------------------------------------------------------------- boot --- */

(async function boot() {
  try {
    await hand.init($("gl"), COLORS, "mummy");
    hand.onPreset(markPreset);
    new ResizeObserver(hand.resize).observe($("gl"));
    $("booting").hidden = true;
  } catch (err) {
    $("booting").textContent = "Couldn't start the 3D hand: " + err.message;
  }
  try {
    await load(makeDemo(getCtx()), "Demo loop");
  } catch (err) {
    setStatus("Audio is unavailable in this browser.");
  }
})();
