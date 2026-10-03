// Shared constants. Five frequency bands, one per finger.

export const NB = 5;

/** Band edges in Hz. Band i spans BAND_HZ[i] .. BAND_HZ[i+1]. */
export const BAND_HZ = [20, 120, 400, 1200, 3500, 14000];

export const NAMES = ["thumb", "index", "middle", "ring", "pinky"];
export const ROLES = ["kick", "low mid", "mid", "high mid", "hats"];
export const KEYS  = ["a", "s", "d", "f", "g"];

/** Shortest gap between two taps of the same finger, in seconds. */
export const MIN_GAP = [0.11, 0.10, 0.09, 0.075, 0.06];

/**
 * Minimum onset height per band, as a fraction of that band's loudest peak.
 * The low band needs a high floor or broadband snare noise fires the thumb.
 */
export const FLOOR = [0.22, 0.15, 0.13, 0.10, 0.07];

/** Timing windows for Play mode, in seconds. */
export const W_PERFECT = 0.055;
export const W_GOOD    = 0.12;
export const W_MISS    = 0.17;

/** Analysis frame rate: one FFT frame every 10 ms. */
export const FRAMES_PER_SEC = 100;
export const FFT_SIZE = 1024;

/** The hands, and how each one is lit and framed. */
export const HANDS = {
  mummy:  { label: "Mummy",  skin: "#c3a883", shade: "#3b2f26", spec: 0.18, targetY: 0.22, distK: 1.00 },
  cyborg: { label: "Cyborg", skin: "#9fb2c2", shade: "#222a33", spec: 0.55, targetY: 0.30, distK: 1.12 }
};
