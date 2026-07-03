// Exercises the chroma alignment engine end-to-end on synthetic material:
// a fake song (melody + bass) becomes both a MIDI chroma timeline and a
// rendered-audio excerpt; alignment must recover where the excerpt sits.
// Run with: npm run verify:align (bundles TS via esbuild first).
import {
  audioChroma,
  midiChroma,
  alignChroma,
  MIN_SYNC_SCORE,
  CHROMA_SAMPLE_RATE,
} from "./.bundle/chroma.js";

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${detail}`);
}

// ---- fake song: 150s, wandering melody + bass roots ------------------------
// deterministic pseudo-random so failures reproduce
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const SONG_SEC = 150;
const notes = [];
{
  let t = 0;
  let melody = 67; // G4
  while (t < SONG_SEC) {
    const dur = 0.3 + rand() * 0.7;
    melody += Math.round((rand() - 0.5) * 6);
    melody = Math.max(60, Math.min(76, melody));
    notes.push({ midi: melody, start: t, dur: dur * 0.9 });
    t += dur;
  }
  // bass: root every second, cycling a I-vi-IV-V-ish pattern
  const roots = [43, 40, 36, 38];
  for (let s = 0; s < SONG_SEC; s++) {
    notes.push({ midi: roots[Math.floor(s / 2) % 4], start: s, dur: 0.9 });
  }
}

// ---- render an excerpt to audio samples ------------------------------------
// tempoScale stretches song time: audio second t plays song time offset + t*scale
function renderExcerpt(offsetSec, clipSec, scale) {
  const sr = CHROMA_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(clipSec * sr));
  for (const n of notes) {
    // song-time window → audio-time window
    const a0 = (n.start - offsetSec) / scale;
    const a1 = (n.start + n.dur - offsetSec) / scale;
    if (a1 < 0 || a0 > clipSec) continue;
    const f0 = 440 * Math.pow(2, (n.midi - 69) / 12);
    const s0 = Math.max(0, Math.floor(a0 * sr));
    const s1 = Math.min(out.length, Math.floor(a1 * sr));
    for (let s = s0; s < s1; s++) {
      const t = s / sr;
      // fundamental + 3 overtones, mild decay — crude but chromatic
      out[s] +=
        0.5 * Math.sin(2 * Math.PI * f0 * t) +
        0.25 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.15 * Math.sin(2 * Math.PI * 3 * f0 * t) +
        0.08 * Math.sin(2 * Math.PI * 4 * f0 * t);
    }
  }
  // touch of noise so it's not analytically clean
  for (let s = 0; s < out.length; s++) out[s] += (rand() - 0.5) * 0.05;
  return out;
}

const midiSeq = midiChroma(notes, SONG_SEC, 2048 / CHROMA_SAMPLE_RATE);

for (const [offset, scale] of [
  [37.4, 1.0],
  [82.0, 1.05],
  [12.7, 0.96],
]) {
  const clip = renderExcerpt(offset, 30, scale);
  const audioSeq = audioChroma(clip, CHROMA_SAMPLE_RATE);
  const t0 = Date.now();
  const a = alignChroma(audioSeq, midiSeq);
  const ms = Date.now() - t0;
  const offErr = Math.abs(a.offsetSec - offset);
  const scaleErr = Math.abs(a.scale - scale);
  check(
    `recovers offset ${offset}s @ scale ${scale}`,
    offErr <= 0.35 && scaleErr <= 0.021 && a.score >= MIN_SYNC_SCORE,
    `got ${a.offsetSec}s @ ${a.scale} (score ${a.score}, ${ms}ms)`,
  );
}

// wrong song ⇒ low score (different seed → unrelated notes)
{
  seed = 999;
  const other = [];
  let t = 0;
  while (t < 40) {
    const dur = 0.3 + rand() * 0.7;
    other.push({
      midi: 48 + Math.floor(rand() * 24),
      start: t,
      dur: dur * 0.9,
    });
    t += dur;
  }
  const otherSamples = (() => {
    const saved = notes.slice();
    notes.length = 0;
    notes.push(...other);
    const s = renderExcerpt(5, 30, 1.0);
    notes.length = 0;
    notes.push(...saved);
    return s;
  })();
  const a = alignChroma(audioChroma(otherSamples, CHROMA_SAMPLE_RATE), midiSeq);
  check(
    "unrelated song scores below threshold",
    a.score < MIN_SYNC_SCORE,
    `score ${a.score}`,
  );
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll alignment checks passed.");
process.exit(failures ? 1 : 0);
