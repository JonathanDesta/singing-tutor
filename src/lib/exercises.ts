import { midiToName } from "./notes";

export type Segment =
  | { kind: "note"; degree: number; ms: number }
  | { kind: "glide"; from: number; to: number; ms: number }
  | { kind: "rest"; ms: number };

export type Exercise = {
  id: string;
  name: string;
  description: string;
  /** highest scale degree used, in semitones above the root */
  span: number;
  segments: Segment[];
};

/** A segment resolved to absolute pitch and an absolute timeline (ms from exercise start). */
export type TimedTarget = {
  t0: number;
  t1: number;
  midi0: number;
  midi1: number;
  label: string;
};

const N = (degree: number, ms = 700): Segment => ({ kind: "note", degree, ms });

export const EXERCISES: Exercise[] = [
  {
    id: "sustain",
    name: "Sustained note",
    description: "Hold one note dead steady for four seconds.",
    span: 0,
    segments: [N(0, 4000)],
  },
  {
    id: "five-note",
    name: "Five-note scale",
    description: "Do–re–mi–fa–so and back down. The bread and butter of warmups.",
    span: 7,
    segments: [0, 2, 4, 5, 7, 5, 4, 2, 0].map((d) => N(d)),
  },
  {
    id: "intervals",
    name: "Intervals: do–mi–so",
    description: "Leap to the third and the fifth and land in tune.",
    span: 7,
    segments: [0, 4, 0, 7, 0].map((d) => N(d, 900)),
  },
  {
    id: "arpeggio",
    name: "Octave arpeggio",
    description: "Climb the chord to the octave and come back down.",
    span: 12,
    segments: [0, 4, 7, 12, 7, 4, 0].map((d) => N(d)),
  },
  {
    id: "siren",
    name: "Siren",
    description: "Glide smoothly up a fifth and back — no steps, one connected sweep.",
    span: 7,
    segments: [
      { kind: "glide", from: 0, to: 7, ms: 2500 },
      { kind: "glide", from: 7, to: 0, ms: 2500 },
    ],
  },
];

export function resolve(
  ex: Exercise,
  rootMidi: number,
): { targets: TimedTarget[]; totalMs: number } {
  const targets: TimedTarget[] = [];
  let t = 0;
  for (const s of ex.segments) {
    if (s.kind === "note") {
      const m = rootMidi + s.degree;
      targets.push({ t0: t, t1: t + s.ms, midi0: m, midi1: m, label: midiToName(m) });
      t += s.ms;
    } else if (s.kind === "glide") {
      targets.push({
        t0: t,
        t1: t + s.ms,
        midi0: rootMidi + s.from,
        midi1: rootMidi + s.to,
        label: `${midiToName(rootMidi + s.from)}→${midiToName(rootMidi + s.to)}`,
      });
      t += s.ms;
    } else {
      t += s.ms;
    }
  }
  return { targets, totalMs: t };
}

export type Range = { min: number; max: number };

/** Pick a root note so the exercise sits comfortably inside the singer's range. */
export function pickRoot(ex: Exercise, range: Range | null): number {
  if (!range) {
    // no profile yet: center loosely around A3, a reachable default for most voices
    return Math.min(60, Math.max(48, 57 - Math.round(ex.span / 2)));
  }
  const usable = range.max - range.min;
  if (usable <= ex.span) return range.min;
  return Math.round(range.min + (usable - ex.span) / 2);
}
