import type { TimedTarget } from "./exercises";
import { classifyVowel } from "./formants";
import { classifyTimbre, type TimbreClass, type TimbreFrame } from "./timbre";

/** Analysis frame: what usePitchLoop emits, timestamped relative to sing start. */
export type AFrame = {
  t: number;
  midi: number | null;
  clarity: number;
  f1: number | null;
  f2: number | null;
  timbre: TimbreFrame | null;
};

export type SegmentAnalysis = {
  /** null when the segment is a glide or too short to judge */
  vibrato: {
    rateHz: number | null;
    extentCents: number;
    label:
      | "steady"
      | "healthy vibrato"
      | "slow wobble"
      | "fast tremolo"
      | "wide vibrato"
      | "unsteady pitch";
  } | null;
  /** harmonics-to-noise proxy from detection clarity */
  tone: {
    hnrDb: number;
    label: "clear" | "slightly breathy" | "breathy";
  } | null;
  /** how the note was attacked (notes only) */
  onset: {
    ms: number | null;
    label: "clean" | "scooped" | "slid down" | "never settled" | "no onset";
  } | null;
  /** experimental LPC-based vowel estimate */
  vowel: { guess: string; f1: number; f2: number } | null;
  /** spectral production style: weight (full/light/falsetto) × color (dark/neutral/bright) */
  timbre: TimbreClass | null;
};

const EDGE_MS = 100;
const VIBRATO_MIN_MS = 1500;

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function analyzeSegments(
  targets: TimedTarget[],
  frames: AFrame[],
): SegmentAnalysis[] {
  return targets.map((tg) => analyzeSegment(tg, frames));
}

function analyzeSegment(tg: TimedTarget, frames: AFrame[]): SegmentAnalysis {
  const inWindow = frames.filter(
    (f) => f.t >= tg.t0 + EDGE_MS && f.t <= tg.t1 - EDGE_MS,
  );
  const voiced = inWindow.filter((f) => f.midi !== null);
  const isNote = tg.midi0 === tg.midi1;

  return {
    vibrato:
      isNote && tg.t1 - tg.t0 >= VIBRATO_MIN_MS && voiced.length >= 40
        ? analyzeVibrato(voiced)
        : null,
    tone: analyzeTone(voiced),
    onset: isNote ? analyzeOnset(tg, frames) : null,
    vowel: analyzeVowel(voiced),
    timbre: classifyTimbre(
      voiced
        .map((f) => f.timbre)
        .filter((t): t is TimbreFrame => t != null),
      voiced.length > 0 ? median(voiced.map((f) => f.midi!)) : undefined,
    ),
  };
}

function analyzeTone(voiced: AFrame[]): SegmentAnalysis["tone"] {
  if (voiced.length < 10) return null;
  const c = Math.min(0.9999, Math.max(0.0001, mean(voiced.map((f) => f.clarity))));
  const hnrDb = 10 * Math.log10(c / (1 - c));
  return {
    hnrDb: Math.round(hnrDb * 10) / 10,
    label: hnrDb >= 18 ? "clear" : hnrDb >= 12 ? "slightly breathy" : "breathy",
  };
}

function analyzeVibrato(voiced: AFrame[]): SegmentAnalysis["vibrato"] {
  const midis = voiced.map((f) => f.midi!);

  // detrend with a centered moving average about one vibrato period wide,
  // leaving the oscillation while removing drift
  const HALF = 4;
  const cents: number[] = [];
  for (let i = 0; i < midis.length; i++) {
    const lo = Math.max(0, i - HALF);
    const hi = Math.min(midis.length - 1, i + HALF);
    cents.push((midis[i] - mean(midis.slice(lo, hi + 1))) * 100);
  }

  const rms = Math.sqrt(mean(cents.map((c) => c * c)));
  const extent = Math.round(rms * Math.SQRT2);
  if (extent < 12) {
    return { rateHz: null, extentCents: extent, label: "steady" };
  }

  // zero crossings with hysteresis -> oscillation rate + regularity
  const thr = Math.max(4, extent * 0.25);
  let sign = 0;
  const crossTimes: number[] = [];
  for (let i = 0; i < cents.length; i++) {
    const v = cents[i];
    if (sign <= 0 && v > thr) {
      if (sign < 0) crossTimes.push(voiced[i].t);
      sign = 1;
    } else if (sign >= 0 && v < -thr) {
      if (sign > 0) crossTimes.push(voiced[i].t);
      sign = -1;
    }
  }

  if (crossTimes.length < 4) {
    return { rateHz: null, extentCents: extent, label: "unsteady pitch" };
  }
  const intervals: number[] = [];
  for (let i = 1; i < crossTimes.length; i++) {
    intervals.push(crossTimes[i] - crossTimes[i - 1]);
  }
  const meanInt = mean(intervals);
  const cv =
    Math.sqrt(mean(intervals.map((x) => (x - meanInt) ** 2))) / meanInt;
  const rateHz = Math.round((1000 / (2 * meanInt)) * 10) / 10;

  let label: NonNullable<SegmentAnalysis["vibrato"]>["label"];
  if (cv > 0.65) label = "unsteady pitch";
  else if (extent > 120) label = "wide vibrato";
  else if (rateHz < 4.3) label = "slow wobble";
  else if (rateHz > 7.5) label = "fast tremolo";
  else label = "healthy vibrato";

  return { rateHz, extentCents: extent, label };
}

function analyzeOnset(
  tg: TimedTarget,
  frames: AFrame[],
): SegmentAnalysis["onset"] {
  const win = frames.filter((f) => f.t >= tg.t0 - 50 && f.t <= tg.t0 + 600);
  const first = win.find((f) => f.midi !== null);
  if (!first) return { ms: null, label: "no onset" };
  const lock = win.find(
    (f) => f.midi !== null && f.t >= first.t && Math.abs(f.midi - tg.midi0) < 0.6,
  );
  if (!lock) return { ms: null, label: "never settled" };
  const ms = Math.round(lock.t - first.t);
  if (ms <= 140) return { ms, label: "clean" };
  const approach = win.filter(
    (f) => f.midi !== null && f.t >= first.t && f.t < lock.t,
  );
  const dev = mean(approach.map((f) => f.midi! - tg.midi0));
  return { ms, label: dev < 0 ? "scooped" : "slid down" };
}

function analyzeVowel(voiced: AFrame[]): SegmentAnalysis["vowel"] {
  const f1s = voiced.map((f) => f.f1).filter((x): x is number => x !== null);
  const f2s = voiced.map((f) => f.f2).filter((x): x is number => x !== null);
  if (f1s.length < 8 || f2s.length < 8) return null;
  const f1 = median(f1s);
  const f2 = median(f2s);
  const guess = classifyVowel(f1, f2);
  return guess === null
    ? null
    : { guess, f1: Math.round(f1), f2: Math.round(f2) };
}

/** Short human-readable chips for the results table. */
export function describeAnalysis(a: SegmentAnalysis | null | undefined): string[] {
  if (!a) return [];
  const chips: string[] = [];
  if (a.onset && a.onset.label !== "clean" && a.onset.label !== "no onset") {
    chips.push(
      a.onset.ms !== null ? `${a.onset.label} (${a.onset.ms}ms)` : a.onset.label,
    );
  }
  if (a.vibrato) {
    if (a.vibrato.label === "healthy vibrato") {
      chips.push(`vibrato ${a.vibrato.rateHz}Hz/${a.vibrato.extentCents}¢`);
    } else if (a.vibrato.label !== "steady") {
      chips.push(a.vibrato.label);
    }
  }
  if (a.tone && a.tone.label !== "clear") chips.push(a.tone.label);
  if (a.timbre) chips.push(`${a.timbre.weight}·${a.timbre.color}`);
  if (a.vowel) chips.push(`"${a.vowel.guess}"?`);
  return chips;
}
