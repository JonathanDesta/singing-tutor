import { magnitudeSpectrum } from "./fft";

/**
 * Spectral timbre features per voiced frame. Together these separate vocal
 * production styles on two axes:
 *   weight — full (chesty/belted) vs light (lean, heady mix) vs falsetto
 *   color  — dark vs neutral vs bright
 * e.g. a dark rich belt = full·dark; a funky bright belt = full·bright;
 * a light lean pop voice = light·*; flute-like falsetto = falsetto.
 */
export type TimbreFrame = {
  centroidHz: number; // spectral centroid 80-5000 Hz — brightness
  tiltDb: number; // energy 2-5 kHz vs 80-1000 Hz — high-frequency richness
  ringDb: number; // 2.4-3.4 kHz ("singer's formant") share of total
  h1h2Db: number; // fundamental vs 2nd harmonic — fold closure / register cue
};

export function timbreFeatures(
  buf: Float32Array,
  sampleRate: number,
  f0: number,
): TimbreFrame | null {
  const mags = magnitudeSpectrum(buf);
  const binHz = sampleRate / buf.length;
  const bin = (hz: number) => Math.min(mags.length - 1, Math.round(hz / binHz));
  const power = (a: number, b: number) => {
    let s = 0;
    for (let i = bin(a); i <= bin(b); i++) s += mags[i] * mags[i];
    return s;
  };

  const lo = power(80, 1000);
  const hi = power(2000, 5000);
  const ring = power(2400, 3400);
  const total = power(80, 5000);
  if (total <= 1e-9 || lo <= 1e-9) return null;

  let cs = 0;
  let cw = 0;
  for (let i = bin(80); i <= bin(5000); i++) {
    const p = mags[i] * mags[i];
    cs += i * binHz * p;
    cw += p;
  }

  const peakNear = (hz: number) => {
    const c = bin(hz);
    let m = 0;
    for (let i = Math.max(0, c - 2); i <= Math.min(mags.length - 1, c + 2); i++) {
      m = Math.max(m, mags[i]);
    }
    return m;
  };
  const h1 = peakNear(f0);
  const h2 = peakNear(2 * f0);

  return {
    centroidHz: cs / cw,
    tiltDb: 10 * Math.log10(hi / lo + 1e-12),
    ringDb: 10 * Math.log10(ring / total + 1e-12),
    h1h2Db: 20 * Math.log10((h1 + 1e-9) / (h2 + 1e-9)),
  };
}

export type TimbreClass = {
  weight: "full" | "light" | "falsetto";
  color: "dark" | "neutral" | "bright";
  centroidHz: number;
  tiltDb: number;
  ringDb: number;
  h1h2Db: number;
};

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Classifies a segment from its per-frame features (medians for robustness). */
export function classifyTimbre(frames: TimbreFrame[]): TimbreClass | null {
  if (frames.length < 8) return null;
  const med = (get: (t: TimbreFrame) => number) => {
    const s = frames.map(get).sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const centroidHz = med((t) => t.centroidHz);
  const tiltDb = med((t) => t.tiltDb);
  const ringDb = med((t) => t.ringDb);
  const h1h2Db = med((t) => t.h1h2Db);

  // falsetto: dominant fundamental AND steep rolloff; light: one of the two
  // leaning that way; full: rich harmonics with real high-frequency energy
  const weight: TimbreClass["weight"] =
    h1h2Db >= 10 && tiltDb <= -18
      ? "falsetto"
      : h1h2Db >= 5 || tiltDb <= -14
        ? "light"
        : "full";
  // boundaries calibrated against synthetic harmonic stacks (power-weighted
  // centroid of a capped rich voice ≈ 580 Hz, of a full-spectrum rich voice
  // ≈ 1300 Hz) — see scripts/verify-analysis.mjs
  const color: TimbreClass["color"] =
    centroidHz < 700 ? "dark" : centroidHz <= 1100 ? "neutral" : "bright";

  return {
    weight,
    color,
    centroidHz: Math.round(centroidHz),
    tiltDb: r1(tiltDb),
    ringDb: r1(ringDb),
    h1h2Db: r1(h1h2Db),
  };
}
