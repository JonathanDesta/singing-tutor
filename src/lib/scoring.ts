import type { TimedTarget } from "./exercises";

/** One detection frame, t in ms relative to the start of the sing phase. */
export type Frame = { t: number; midi: number | null };

export type SegmentScore = {
  label: string;
  /** 0..1 */
  score: number;
  /** signed mean cents deviation of voiced frames, null if nothing voiced */
  avgCents: number | null;
  /** fraction of the window where a pitch was detected */
  voicedRatio: number;
};

const EDGE_TRIM_MS = 100; // ignore note transitions at segment edges
const PERFECT_CENTS = 25; // full credit inside this
const ZERO_CENTS = 100; // no credit beyond this
const FULL_VOICING = 0.7; // voiced this much of the window = no penalty

export function scoreSegments(
  targets: TimedTarget[],
  frames: Frame[],
): SegmentScore[] {
  return targets.map((tg) => {
    const inWindow = frames.filter(
      (f) => f.t >= tg.t0 + EDGE_TRIM_MS && f.t <= tg.t1 - EDGE_TRIM_MS,
    );
    const voiced = inWindow.filter((f) => f.midi !== null);
    const voicedRatio = inWindow.length ? voiced.length / inWindow.length : 0;
    if (voiced.length === 0) {
      return { label: tg.label, score: 0, avgCents: null, voicedRatio };
    }
    let sumScore = 0;
    let sumCents = 0;
    for (const f of voiced) {
      const progress = (f.t - tg.t0) / (tg.t1 - tg.t0);
      const target = tg.midi0 + (tg.midi1 - tg.midi0) * progress;
      const cents = (f.midi! - target) * 100;
      sumCents += cents;
      const abs = Math.abs(cents);
      sumScore +=
        abs <= PERFECT_CENTS
          ? 1
          : Math.max(0, 1 - (abs - PERFECT_CENTS) / (ZERO_CENTS - PERFECT_CENTS));
    }
    const pitchScore = sumScore / voiced.length;
    const score = pitchScore * Math.min(1, voicedRatio / FULL_VOICING);
    return {
      label: tg.label,
      score,
      avgCents: sumCents / voiced.length,
      voicedRatio,
    };
  });
}

export function overallScore(segments: SegmentScore[]): number {
  if (segments.length === 0) return 0;
  return Math.round(
    (100 * segments.reduce((acc, s) => acc + s.score, 0)) / segments.length,
  );
}
