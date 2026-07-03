import { PitchDetector } from "pitchy";
import { separateVocals, SEPARATION_SAMPLE_RATE, type SeparationProgress } from "./separate";

/**
 * Melody extraction from the recording itself: separate the vocal stem
 * (MDX-Net in-browser), track its pitch with the same MPM detector the app
 * uses on the mic, and segment into note targets. Notes keep the record's
 * true tuning: pitches are quantized to a semitone grid offset by the
 * clip's estimated global tuning (old masters often run sharp/flat of A440,
 * and the singer follows the record, not a tuner).
 */

export type ExtractedNote = { t0: number; t1: number; midi: number };

export type ExtractProgress =
  | SeparationProgress
  | { stage: "decode" | "track"; fraction: number };

const TRACK_WIN = 4096;
const TRACK_HOP = 1024;
const MIN_CLARITY = 0.85;
const MIN_RMS = 0.004;
const MIN_NOTE_SEC = 0.12;
const GAP_MERGE_SEC = 0.08;

export async function extractMelody(
  previewBytes: ArrayBuffer,
  onProgress?: (p: ExtractProgress) => void,
): Promise<{
  notes: ExtractedNote[];
  tuningCents: number;
  voicedSec: number;
  clipSec: number;
}> {
  onProgress?.({ stage: "decode", fraction: 0 });
  const octx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 1,
    sampleRate: SEPARATION_SAMPLE_RATE,
  });
  const dec = await octx.decodeAudioData(previewBytes);
  const L = dec.getChannelData(0);
  const R = dec.numberOfChannels > 1 ? dec.getChannelData(1) : L;

  const { left, right } = await separateVocals(L, R, onProgress);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;

  onProgress?.({ stage: "track", fraction: 0 });
  const det = PitchDetector.forFloat32Array(TRACK_WIN);
  const buf = new Float32Array(TRACK_WIN);
  const path: (number | null)[] = [];
  for (let s = 0; s + TRACK_WIN <= mono.length; s += TRACK_HOP) {
    buf.set(mono.subarray(s, s + TRACK_WIN));
    let rms = 0;
    for (let i = 0; i < TRACK_WIN; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / TRACK_WIN);
    if (rms < MIN_RMS) {
      path.push(null);
      continue;
    }
    const [freq, clarity] = det.findPitch(buf, SEPARATION_SAMPLE_RATE);
    path.push(
      clarity >= MIN_CLARITY && freq >= 70 && freq <= 900
        ? 69 + 12 * Math.log2(freq / 440)
        : null,
    );
  }
  const fps = SEPARATION_SAMPLE_RATE / TRACK_HOP;

  // global tuning: median fractional offset from the semitone grid
  const fracs = path
    .filter((p): p is number => p !== null)
    .map((p) => p - Math.round(p))
    .sort((a, b) => a - b);
  const tuning = fracs.length >= 40 ? fracs[fracs.length >> 1] : 0;

  // segment stable stretches into notes on the record-tuned grid
  const notes: ExtractedNote[] = [];
  let cur: { t0: number; t1: number; p: number[] } | null = null;
  const flush = () => {
    if (cur && cur.t1 - cur.t0 >= MIN_NOTE_SEC) {
      const med = cur.p.sort((a, b) => a - b)[cur.p.length >> 1];
      notes.push({ t0: cur.t0, t1: cur.t1, midi: Math.round(med - tuning) + tuning });
    }
    cur = null;
  };
  for (let t = 0; t < path.length; t++) {
    const p = path[t];
    const sec = t / fps;
    if (p === null) {
      if (cur && sec - cur.t1 > GAP_MERGE_SEC) flush();
      continue;
    }
    if (cur) {
      const med = [...cur.p].sort((a, b) => a - b)[cur.p.length >> 1];
      if (Math.abs(p - med) > 0.8) {
        flush();
        cur = { t0: sec, t1: sec + 1 / fps, p: [p] };
      } else {
        cur.t1 = sec + 1 / fps;
        cur.p.push(p);
      }
    } else {
      cur = { t0: sec, t1: sec + 1 / fps, p: [p] };
    }
  }
  flush();

  const voicedSec = notes.reduce((a, n) => a + (n.t1 - n.t0), 0);
  return {
    notes,
    tuningCents: Math.round(tuning * 100),
    voicedSec,
    clipSec: dec.duration,
  };
}
