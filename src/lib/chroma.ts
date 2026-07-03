import { magnitudeSpectrum } from "./fft";

/**
 * Chroma-based alignment of a MIDI transcription to a real recording.
 *
 * A preview clip is an unknown ~30s excerpt of the song, and the MIDI file's
 * tempo only roughly matches the record. Both sides are reduced to beat-free
 * 12-dimensional pitch-class energy ("chroma") sequences; a grid search over
 * (offset into the song, tempo scale) maximizes their mean cosine similarity.
 * Chroma survives arrangement/timbre differences — the MIDI needs the right
 * notes, not the right sounds.
 *
 * Pure Float32Array math (no Web Audio types) so the synthetic verify
 * scripts can exercise the whole path in node.
 */

export type ChromaSeq = {
  hopSec: number;
  /** per-frame 12-dim unit-normalized pitch-class energy (frame centers at (i+0.5)*hopSec) */
  frames: Float32Array[];
};

/** Recommended decode rate for clip analysis — chroma needs nothing above ~2.5 kHz. */
export const CHROMA_SAMPLE_RATE = 22050;

const FFT_SIZE = 4096;
const HOP = 2048;
const F_MIN = 70;
const F_MAX = 2500;

/**
 * Per-frame mean subtraction (clipped at 0), then unit norm. Percussion and
 * broadband noise raise all 12 pitch classes roughly equally; removing the
 * frame mean keeps only the harmonic *shape*. Calibrated on real data
 * (Billie Jean/Beat It previews vs their BitMidi files): raw cosine gave
 * true-match 0.52/0.59 vs wrong-song 0.42; mean-subtracted gives 0.44/0.47
 * vs ≤0.28 — a clean two-sided margin around MIN_SYNC_SCORE.
 */
function condition(v: Float32Array): void {
  let mean = 0;
  for (let k = 0; k < 12; k++) mean += v[k];
  mean /= 12;
  let s = 0;
  for (let k = 0; k < 12; k++) {
    v[k] = Math.max(0, v[k] - mean);
    s += v[k] * v[k];
  }
  if (s <= 1e-12) return;
  const inv = 1 / Math.sqrt(s);
  for (let k = 0; k < 12; k++) v[k] *= inv;
}

/** Chroma sequence of mono audio samples. */
export function audioChroma(
  samples: Float32Array,
  sampleRate: number,
): ChromaSeq {
  const hopSec = HOP / sampleRate;
  const frames: Float32Array[] = [];
  const win = new Float32Array(FFT_SIZE);
  const binHz = sampleRate / FFT_SIZE;
  // precompute bin → pitch class (or -1 outside the band)
  const pcOfBin = new Int8Array(FFT_SIZE / 2);
  for (let b = 0; b < FFT_SIZE / 2; b++) {
    const f = b * binHz;
    pcOfBin[b] =
      f < F_MIN || f > F_MAX
        ? -1
        : ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }

  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
    win.set(samples.subarray(start, start + FFT_SIZE));
    const mags = magnitudeSpectrum(win);
    const v = new Float32Array(12);
    for (let b = 0; b < mags.length; b++) {
      const pc = pcOfBin[b];
      if (pc >= 0) v[pc] += mags[b] * mags[b];
    }
    condition(v);
    frames.push(v);
  }
  return { hopSec, frames };
}

export type NoteSec = { midi: number; start: number; dur: number };

/**
 * Chroma sequence synthesized from note events (all voices of the file —
 * the recording is the full mix). Harmonic spread: fundamental + fifth +
 * major third approximate where real overtones land in pitch-class space.
 */
export function midiChroma(
  notes: NoteSec[],
  durSec: number,
  hopSec: number,
): ChromaSeq {
  const n = Math.max(1, Math.ceil(durSec / hopSec));
  const frames: Float32Array[] = [];
  for (let j = 0; j < n; j++) frames.push(new Float32Array(12));
  for (const note of notes) {
    const pc = ((note.midi % 12) + 12) % 12;
    const j0 = Math.max(0, Math.floor(note.start / hopSec));
    const j1 = Math.min(n - 1, Math.floor((note.start + note.dur) / hopSec));
    for (let j = j0; j <= j1; j++) {
      const v = frames[j];
      v[pc] += 1;
      v[(pc + 7) % 12] += 0.4;
      v[(pc + 4) % 12] += 0.2;
    }
  }
  for (const v of frames) condition(v);
  return { hopSec, frames };
}

export type Alignment = {
  /** seconds into the MIDI timeline where the clip begins */
  offsetSec: number;
  /** MIDI seconds per audio second (recording faster than MIDI ⇒ > 1) */
  scale: number;
  /** mean conditioned-chroma cosine at the best fit (≤0.28 wrong song, ≥0.43 real) */
  score: number;
};

function scoreAt(
  audio: ChromaSeq,
  midi: ChromaSeq,
  offset: number,
  scale: number,
  frameStep: number,
): number {
  let sum = 0;
  let count = 0;
  const nA = audio.frames.length;
  const nM = midi.frames.length;
  for (let i = 0; i < nA; i += frameStep) {
    const tA = (i + 0.5) * audio.hopSec;
    const j = Math.round((offset + tA * scale) / midi.hopSec - 0.5);
    if (j < 0 || j >= nM) continue;
    const a = audio.frames[i];
    const m = midi.frames[j];
    let dot = 0;
    for (let k = 0; k < 12; k++) dot += a[k] * m[k];
    sum += dot;
    count++;
  }
  // require the clip to mostly overlap the MIDI timeline
  if (count < (nA / frameStep) * 0.6) return -1;
  return sum / count;
}

const COARSE_SCALES = [0.94, 0.97, 1.0, 1.03, 1.06];

/** Grid-search alignment: coarse (offset × tempo scale), then local refine. */
export function alignChroma(audio: ChromaSeq, midi: ChromaSeq): Alignment {
  const clipSec = audio.frames.length * audio.hopSec;
  const midiSec = midi.frames.length * midi.hopSec;
  const coarseStep = audio.hopSec * 4;
  const maxOffset = Math.max(0, midiSec - clipSec * 0.8);

  let best: Alignment = { offsetSec: 0, scale: 1, score: -1 };
  for (const scale of COARSE_SCALES) {
    for (let o = 0; o <= maxOffset; o += coarseStep) {
      const s = scoreAt(audio, midi, o, scale, 2);
      if (s > best.score) best = { offsetSec: o, scale, score: s };
    }
  }

  // refine: fine offsets around the winner, scales around its scale
  let refined = best;
  for (let ds = -0.02; ds <= 0.021; ds += 0.01) {
    const scale = best.scale + ds;
    for (
      let o = Math.max(0, best.offsetSec - coarseStep * 2);
      o <= Math.min(maxOffset, best.offsetSec + coarseStep * 2);
      o += audio.hopSec
    ) {
      const s = scoreAt(audio, midi, o, scale, 1);
      if (s > refined.score) refined = { offsetSec: o, scale, score: s };
    }
  }
  return {
    offsetSec: Math.round(refined.offsetSec * 1000) / 1000,
    scale: Math.round(refined.scale * 1000) / 1000,
    score: Math.round(refined.score * 1000) / 1000,
  };
}

/** Alignment scores below this are treated as "didn't find the clip". */
export const MIN_SYNC_SCORE = 0.36;
