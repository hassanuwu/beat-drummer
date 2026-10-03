/**
 * Onset detection by spectral flux.
 *
 * Every 10 ms, take a 1024-sample window, Hann-window it and FFT it. Subtract
 * the previous frame's magnitude spectrum, keep only the positive differences,
 * and sum them inside each frequency band. That sum spikes when a new sound
 * starts in the band. Peaks in it are the taps.
 */
import { fft, hann } from "./fft.js";
import { NB, BAND_HZ, MIN_GAP, FLOOR, FFT_SIZE, FRAMES_PER_SEC } from "../config.js";

const nextTick = () => new Promise(r => setTimeout(r, 0));

/** Average all channels of an AudioBuffer down to one Float32Array. */
function toMono(buffer) {
  const len = buffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i];
  }
  if (buffer.numberOfChannels > 1) {
    const g = 1 / buffer.numberOfChannels;
    for (let i = 0; i < len; i++) mono[i] *= g;
  }
  return mono;
}

/**
 * Run the STFT and return the per-band flux curves.
 * Yields to the event loop periodically so the page stays responsive, and
 * reports progress in 0..1 through onProgress.
 */
export async function computeFlux(buffer, onProgress = () => {}) {
  const sr = buffer.sampleRate;
  const mono = toMono(buffer);

  const N = FFT_SIZE, half = N >> 1;
  const hop = Math.max(64, Math.round(sr / FRAMES_PER_SEC));
  const frames = Math.max(1, Math.floor((mono.length - N) / hop));
  const win = hann(N);

  // Band edges as FFT bin indices, forced strictly increasing.
  const edges = BAND_HZ.map(f => Math.min(half - 1, Math.max(1, Math.round(f * N / sr))));
  for (let b = 1; b < edges.length; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;

  const flux = [];
  for (let b = 0; b < NB; b++) flux.push(new Float32Array(frames));

  const re = new Float32Array(N), im = new Float32Array(N);
  const mag = new Float32Array(half), prev = new Float32Array(half);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    for (let b = 0; b < NB; b++) {
      let s = 0;
      const hi = Math.min(half, edges[b + 1]);
      for (let k = edges[b]; k < hi; k++) {
        const d = mag[k] - prev[k];
        if (d > 0) s += d;            // rises only: a note starting, not ending
      }
      flux[b][f] = s;
    }
    prev.set(mag);

    if ((f & 1023) === 0) { onProgress(f / frames); await nextTick(); }
  }
  onProgress(1);
  return { flux, fps: sr / hop, duration: buffer.duration };
}

/**
 * Pick peaks out of the flux curves.
 *
 * A frame counts as a tap when it is a local maximum, beats the local mean over
 * a +/- 0.35 s window scaled by `sens`, clears an absolute floor relative to the
 * band's loudest peak, and is far enough from the previous tap on that finger.
 *
 * Cheap compared with computeFlux, so the sensitivity slider re-runs only this.
 */
export function pickOnsets(analysis, sens) {
  const { flux, fps } = analysis;
  const out = [];
  const W = Math.max(3, Math.round(fps * 0.35));
  const k = sens / 1.6;

  for (let b = 0; b < NB; b++) {
    const x = flux[b], n = x.length;
    if (n < 3) continue;

    const ps = new Float64Array(n + 1);     // prefix sums -> O(1) local mean
    let peak = 0;
    for (let i = 0; i < n; i++) { ps[i + 1] = ps[i] + x[i]; if (x[i] > peak) peak = x[i]; }
    if (peak <= 0) continue;

    let last = -1e9;
    for (let i = 1; i < n - 1; i++) {
      const v = x[i];
      if (v < x[i - 1] || v <= x[i + 1]) continue;
      const a = Math.max(0, i - W), c = Math.min(n, i + W + 1);
      const mean = (ps[c] - ps[a]) / (c - a);
      if (v <= mean * sens + peak * FLOOR[b] * k) continue;
      const t = i / fps;
      if (t - last < MIN_GAP[b]) continue;
      last = t;
      out.push({ t, band: b, s: Math.min(1, v / peak * 2.5), judged: false });
    }
  }
  out.sort((p, q) => p.t - q.t);
  return out;
}

/**
 * Tempo by autocorrelation of the summed flux: the lag between 60 and 200 BPM
 * that best matches the signal against itself is the beat period.
 */
export function estimateBPM(analysis) {
  const { flux, fps } = analysis;
  const n = flux[0].length;
  if (n < fps * 4) return 0;

  const cap = Math.min(n, Math.round(fps * 60));   // at most a minute of audio
  const sum = new Float64Array(cap);
  let mean = 0;
  for (let i = 0; i < cap; i++) {
    let s = 0;
    for (let b = 0; b < NB; b++) s += flux[b][i];
    sum[i] = s; mean += s;
  }
  mean /= cap;
  for (let i = 0; i < cap; i++) sum[i] -= mean;   // remove DC or every lag correlates

  const minLag = Math.max(2, Math.round(fps * 60 / 200));
  const maxLag = Math.round(fps * 60 / 60);
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag && lag < cap; lag++) {
    let s = 0;
    for (let i = 0; i + lag < cap; i++) s += sum[i] * sum[i + lag];
    s /= (cap - lag);
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return 0;

  let bpm = 60 * fps / bestLag;
  while (bpm < 70) bpm *= 2;      // fold octave errors into a musical range
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}
