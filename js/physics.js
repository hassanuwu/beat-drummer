/**
 * Finger physics.
 *
 * Each finger is a torsion spring driven by an impulse on the beat:
 *
 *     th'' = -k*th - c*th'        k = wn^2,  c = 2*zeta*wn
 *
 * the same second-order system as a series RLC circuit. wn sets how fast the
 * finger moves, zeta whether it rings (zeta < 1), returns dead (zeta = 1) or
 * crawls back (zeta > 1). The table is a hard stop at each finger's own contact
 * angle, with restitution, so the bounce is a real collision rather than an
 * animation curve.
 */
import { NB } from "./config.js";

const SUBSTEP = 1 / 240;        // fixed integration step
const RESTITUTION = 0.28;
const RETRIGGER = 0.028;        // shortest gap between two contact events, seconds

export const fingers = [];
for (let i = 0; i < NB; i++) fingers.push({ th: 0, w: 0, contact: 0.3, glow: 0, lastHit: -9 });

let wn = 27, zeta = 0.30;
let gain = 1 / 27;              // peak angle per unit of initial velocity
let lead = 0.05;                // seconds from impulse to peak deflection
let bobY = 0, bobV = 0;         // the wrist, a softer spring of its own

/** Fired when a fingertip reaches the table: (fingerIndex, impactStrength). */
let onContact = () => {};
export function setOnContact(fn) { onContact = fn; }

export const params = {
  get wn() { return wn; },
  get zeta() { return zeta; },
  /** Seconds to strike early so contact lands on the beat rather than after it. */
  get lead() { return lead; },
  get bob() { return bobY; }
};

/**
 * Measure how far a unit impulse actually swings a finger, and how long it
 * takes to get there, by running the same integrator the frames use.
 *
 * Solving this analytically would give the undamped answer and leave quiet
 * beats short of the table. Measuring against the real integrator also absorbs
 * the amplitude that semi-implicit Euler loses at this step size.
 */
export function calibrate() {
  const k = wn * wn, c = 2 * zeta * wn, h = SUBSTEP;
  let th = 0, w = 1, best = 0, bestT = 0;
  for (let i = 0; i < 600; i++) {
    w += (-k * th - c * w) * h;
    th += w * h;
    if (th > best) { best = th; bestT = i * h; }
    if (th < 0 && i > 8) break;
  }
  gain = Math.max(1e-4, best);
  lead = Math.max(0, bestT);
}

export function setParams(nextWn, nextZeta) {
  if (nextWn != null) wn = nextWn;
  if (nextZeta != null) zeta = nextZeta;
  calibrate();
}

/** Per-hand contact angles, in radians, from the mesh metadata. */
export function setContacts(contacts) {
  for (let i = 0; i < NB; i++) {
    fingers[i].contact = contacts[i];
    fingers[i].th = 0;
    fingers[i].w = 0;
    fingers[i].glow = 0;
    fingers[i].lastHit = -9;   // don't inherit the old hand's lockout
  }
}

/**
 * Drive one finger. `strength` (0..1) scales force, not reach: the impulse is
 * sized from the measured gain so even the quietest beat lands, and the contact
 * clamp absorbs the overshoot on a loud one.
 */
export function strike(b, strength = 0.6) {
  const p = fingers[b];
  p.w += (p.contact / gain) * (1.02 + 0.55 * strength);
  bobV -= 0.22 * strength;
}

export function step(dt) {
  const k = wn * wn, c = 2 * zeta * wn;
  const n = Math.min(8, Math.max(1, Math.ceil(dt / SUBSTEP)));
  const h = dt / n;

  for (let s = 0; s < n; s++) {
    for (let i = 0; i < NB; i++) {
      const p = fingers[i];
      p.w += (-k * p.th - c * p.w) * h;     // semi-implicit Euler: stable here
      p.th += p.w * h;

      if (p.th >= p.contact && p.w > 0) {
        p.th = p.contact;
        const impact = p.w;
        p.w = -p.w * RESTITUTION;
        const now = performance.now() / 1000;
        if (now - p.lastHit > RETRIGGER) {
          p.lastHit = now;
          p.glow = 1;
          onContact(i, Math.min(1, impact / 6 + 0.35));
        }
      }
      if (p.th < -0.6) { p.th = -0.6; p.w = 0; }
    }
    bobV += (-140 * bobY - 13 * bobV) * h;
    bobY += bobV * h;
  }

  for (let i = 0; i < NB; i++) fingers[i].glow = Math.max(0, fingers[i].glow - dt * 3.4);
}

calibrate();
