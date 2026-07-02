// Feeds synthetic pitch contours and synthesized vowels through the phase-4
// analyzers. Run with: npm run verify:analysis (bundles TS via esbuild first).
import { analyzeSegments } from "./.bundle/analysis.js";
import { estimateFormants, classifyVowel } from "./.bundle/formants.js";
import {
  scoreSegments,
  applyVibratoAllowance,
  overallScore,
} from "./.bundle/scoring.js";
import { timbreFeatures, classifyTimbre } from "./.bundle/timbre.js";
import { parseMidiFile, songFromMidi } from "./.bundle/midi.js";

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
}

// ---- pitch-contour analyzers -----------------------------------------------

const DT = 21.3; // ms per frame, matching the worklet notify cadence

function genFrames(durMs, midiAt, clarity = 0.99) {
  const frames = [];
  for (let t = 0; t <= durMs; t += DT) {
    frames.push({ t, midi: midiAt(t), clarity, f1: null, f2: null, timbre: null });
  }
  return frames;
}

const note = (t1) => [{ t0: 0, t1, midi0: 57, midi1: 57, label: "A3" }];

// healthy vibrato: 5.5 Hz, ±50 cents
{
  const frames = genFrames(3000, (t) => 57 + 0.5 * Math.sin(2 * Math.PI * 5.5 * (t / 1000)));
  const [a] = analyzeSegments(note(3000), frames);
  check(
    "vibrato 5.5Hz/50c detected",
    a.vibrato?.label === "healthy vibrato" &&
      Math.abs(a.vibrato.rateHz - 5.5) <= 0.8 &&
      Math.abs(a.vibrato.extentCents - 50) <= 15,
    `label=${a.vibrato?.label} rate=${a.vibrato?.rateHz}Hz extent=${a.vibrato?.extentCents}c`,
  );
}

// straight tone: steady, clear, clean onset
{
  const frames = genFrames(3000, () => 57);
  const [a] = analyzeSegments(note(3000), frames);
  check(
    "straight tone = steady",
    a.vibrato?.label === "steady",
    `label=${a.vibrato?.label} extent=${a.vibrato?.extentCents}c`,
  );
  check(
    "clarity 0.99 = clear tone ~20dB",
    a.tone?.label === "clear" && Math.abs(a.tone.hnrDb - 20) < 1,
    `label=${a.tone?.label} hnr=${a.tone?.hnrDb}dB`,
  );
  check("straight tone onset clean", a.onset?.label === "clean", `label=${a.onset?.label}`);
}

// slow wobble: 3 Hz, wide
{
  const frames = genFrames(3000, (t) => 57 + 0.9 * Math.sin(2 * Math.PI * 3 * (t / 1000)));
  const [a] = analyzeSegments(note(3000), frames);
  check(
    "3Hz wobble flagged",
    a.vibrato?.label === "slow wobble",
    `label=${a.vibrato?.label} rate=${a.vibrato?.rateHz}Hz`,
  );
}

// scooped onset: start 1.5 semitones under, slide up over 400ms
{
  const frames = genFrames(3000, (t) =>
    t < 400 ? 55.5 + (1.5 * t) / 400 : 57,
  );
  const [a] = analyzeSegments(note(3000), frames);
  check(
    "scooped onset flagged",
    a.onset?.label === "scooped" && a.onset.ms > 140,
    `label=${a.onset?.label} ms=${a.onset?.ms}`,
  );
}

// breathy tone: low clarity
{
  const frames = genFrames(3000, () => 57, 0.85);
  const [a] = analyzeSegments(note(3000), frames);
  check(
    "clarity 0.85 = breathy ~7.5dB",
    a.tone?.label === "breathy" && Math.abs(a.tone.hnrDb - 7.5) < 1,
    `label=${a.tone?.label} hnr=${a.tone?.hnrDb}dB`,
  );
}

// glide segments skip vibrato/onset
{
  const glide = [{ t0: 0, t1: 2500, midi0: 57, midi1: 64, label: "glide" }];
  const frames = genFrames(2500, (t) => 57 + (7 * t) / 2500);
  const [a] = analyzeSegments(glide, frames);
  check(
    "glide: no vibrato/onset analysis",
    a.vibrato === null && a.onset === null,
    `vibrato=${a.vibrato} onset=${a.onset}`,
  );
}

// centered healthy vibrato should not be penalized by scoring
{
  const targets = note(3000);
  const frames = genFrames(3000, (t) => 57 + 0.5 * Math.sin(2 * Math.PI * 5.5 * (t / 1000)));
  const raw = scoreSegments(targets, frames);
  const adjusted = applyVibratoAllowance(
    raw,
    analyzeSegments(targets, frames),
    targets,
    frames,
  );
  check(
    "vibrato allowance rescores to 100",
    overallScore(raw) < 95 && overallScore(adjusted) === 100,
    `raw=${overallScore(raw)} adjusted=${overallScore(adjusted)}`,
  );
}

// off-center vibrato must still lose points
{
  const targets = note(3000);
  const frames = genFrames(3000, (t) => 57.6 + 0.5 * Math.sin(2 * Math.PI * 5.5 * (t / 1000)));
  const adjusted = applyVibratoAllowance(
    scoreSegments(targets, frames),
    analyzeSegments(targets, frames),
    targets,
    frames,
  );
  check(
    "off-center vibrato still penalized",
    overallScore(adjusted) < 70,
    `adjusted=${overallScore(adjusted)} (centered 60c sharp)`,
  );
}

// ---- formants ---------------------------------------------------------------

function synthVowel(F1, bw1, F2, bw2, f0 = 140, sampleRate = 48000, n = 2048) {
  const buf = new Float32Array(n);
  const res = (f, F, bw) => 1 / (1 + ((f - F) / bw) ** 2);
  for (let h = 1; h * f0 < 4000; h++) {
    const f = h * f0;
    const amp =
      (res(f, F1, bw1) + 0.7 * res(f, F2, bw2) + 0.03) * (300 / (300 + f));
    for (let i = 0; i < n; i++) {
      buf[i] += amp * Math.sin((2 * Math.PI * f * i) / sampleRate);
    }
  }
  return buf;
}

{
  const { f1, f2 } = estimateFormants(synthVowel(780, 90, 1150, 120), 48000);
  const okRange =
    f1 !== null && f2 !== null && Math.abs(f1 - 780) <= 150 && Math.abs(f2 - 1150) <= 220;
  check("formants of synthetic 'ah'", okRange, `f1=${f1?.toFixed(0)} f2=${f2?.toFixed(0)}`);
  check(
    "'ah' classified",
    okRange && classifyVowel(f1, f2) === "ah",
    `vowel=${okRange ? classifyVowel(f1, f2) : "n/a"}`,
  );
}

{
  const { f1, f2 } = estimateFormants(synthVowel(300, 80, 2350, 200), 48000);
  const okRange =
    f1 !== null && f2 !== null && Math.abs(f1 - 300) <= 120 && Math.abs(f2 - 2350) <= 350;
  check("formants of synthetic 'ee'", okRange, `f1=${f1?.toFixed(0)} f2=${f2?.toFixed(0)}`);
  check(
    "'ee' classified",
    okRange && classifyVowel(f1, f2) === "ee",
    `vowel=${okRange ? classifyVowel(f1, f2) : "n/a"}`,
  );
}

// ---- timbre ------------------------------------------------------------------

// harmonic stack with amplitude ∝ 1/h^rolloff up to capHz
function synthVoice(f0, rolloff, capHz, sampleRate = 48000, n = 2048) {
  const buf = new Float32Array(n);
  for (let h = 1; h * f0 <= capHz; h++) {
    const amp = 1 / Math.pow(h, rolloff);
    for (let i = 0; i < n; i++) {
      buf[i] += amp * Math.sin((2 * Math.PI * h * f0 * i) / sampleRate);
    }
  }
  return buf;
}

function timbreOf(f0, rolloff, capHz) {
  const frames = [];
  for (let k = 0; k < 10; k++) {
    frames.push(timbreFeatures(synthVoice(f0, rolloff, capHz), 48000, f0));
  }
  const midi = 69 + 12 * Math.log2(f0 / 440);
  return classifyTimbre(frames.filter((f) => f !== null), midi);
}

{
  const t = timbreOf(220, 0.8, 3000); // rich harmonics, capped highs
  check(
    "dark full voice (Grenade-like)",
    t?.weight === "full" && t?.color === "dark",
    `weight=${t?.weight} color=${t?.color} centroid=${t?.centroidHz} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}
{
  const t = timbreOf(220, 0.5, 5000); // rich harmonics all the way up
  check(
    "bright full voice (Uptown-Funk-like)",
    t?.weight === "full" && t?.color === "bright",
    `weight=${t?.weight} color=${t?.color} centroid=${t?.centroidHz} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}
{
  const t = timbreOf(220, 1.5, 4000); // moderate rolloff — lean production
  check(
    "light voice (Billie-Jean-like)",
    t?.weight === "light",
    `weight=${t?.weight} color=${t?.color} centroid=${t?.centroidHz} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}
{
  const t = timbreOf(330, 2.5, 2500); // fundamental-dominant, steep rolloff
  check(
    "falsetto detected",
    t?.weight === "falsetto",
    `weight=${t?.weight} color=${t?.color} centroid=${t?.centroidHz} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}
{
  // regression: user sang B2 modal and got labeled falsetto. A rich low
  // voice must read "full" — the f0-relative tilt bands fix this.
  const t = timbreOf(123.47, 0.8, 3000); // B2, rich harmonics
  check(
    "modal B2 is full, not falsetto",
    t?.weight === "full",
    `weight=${t?.weight} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}
{
  // even a genuinely flutey spectrum at B2 must not be called falsetto —
  // physiologically impossible down there (soft modal, not falsetto)
  const t = timbreOf(123.47, 2.5, 2500);
  check(
    "falsetto floor below E3",
    t !== null && t.weight !== "falsetto",
    `weight=${t?.weight} tilt=${t?.tiltDb} h1h2=${t?.h1h2Db}`,
  );
}

// pure sine must NOT produce a vowel (no formant structure)
{
  const buf = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) buf[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  const { f1 } = estimateFormants(buf, 48000);
  check("pure sine yields no F1", f1 === null || f1 < 260, `f1=${f1}`);
}

// ---- MIDI import -------------------------------------------------------------

{
  // hand-assembled SMF: 96 tpq, 120bpm, track "Test", ten quarter notes
  // C4..A4 with a 2-beat rest after the fifth note
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96, // MThd
  ];
  const track = [
    0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, // tempo 500000us = 120bpm
    0, 0xff, 0x03, 4, 0x54, 0x65, 0x73, 0x74, // name "Test"
  ];
  for (let i = 0; i < 10; i++) {
    const pitch = 60 + i;
    if (i === 5) track.push(0x81, 0x40); // 2-beat rest (192 ticks as VLQ)
    else track.push(0);
    track.push(0x90, pitch, 100); // note on
    track.push(0x60, 0x80, pitch, 0); // 96 ticks later, note off
  }
  track.push(0, 0xff, 0x2f, 0); // end of track
  const mtrk = [
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  const file = new Uint8Array([...bytes, ...mtrk]);

  const parsed = parseMidiFile(file);
  check(
    "MIDI parse: voices/notes/bpm/name",
    parsed.voices.length === 1 &&
      parsed.voices[0].notes.length === 10 &&
      parsed.bpm === 120 &&
      parsed.name === "Test",
    `voices=${parsed.voices.length} notes=${parsed.voices[0]?.notes.length} bpm=${parsed.bpm} name=${parsed.name}`,
  );
  const song = songFromMidi(parsed, "fallback");
  check(
    "MIDI song: split at rest into 2 phrases",
    song.phrases.length === 2 &&
      song.phrases[0].notes.length === 5 &&
      song.phrases[1].notes.length === 5 &&
      song.title === "Test",
    `phrases=${song.phrases.length} p1=${song.phrases[0]?.notes.length} p2=${song.phrases[1]?.notes.length}`,
  );
  check(
    "MIDI note timing preserved",
    song.phrases[0].notes.every((n) => Math.abs(n.beats - 1) < 0.01) &&
      song.phrases[1].notes[0].degree === 65,
    `beats=${song.phrases[0].notes[0].beats} firstP2=${song.phrases[1].notes[0].degree}`,
  );
}

// rhythm: rests between notes must be preserved as gapBeats (syncopation!)
{
  // quarter notes each followed by a half-beat rest (note 96 ticks, gap 48)
  const track = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20];
  for (let i = 0; i < 8; i++) {
    track.push(i === 0 ? 0 : 0x30); // 48-tick gap before each note after the first
    track.push(0x90, 60 + i, 100);
    track.push(0x60, 0x80, 60 + i, 0); // 96-tick duration
  }
  track.push(0, 0xff, 0x2f, 0);
  const file = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ]);
  const song = songFromMidi(parseMidiFile(file), "gaps");
  const notes = song.phrases[0].notes;
  check(
    "MIDI rests preserved as gapBeats",
    notes.length === 8 &&
      notes.slice(0, 7).every((n) => Math.abs((n.gapBeats ?? 0) - 0.5) < 0.02) &&
      notes[7].gapBeats === undefined,
    `gaps=${notes.map((n) => n.gapBeats ?? 0).join(",")}`,
  );
}

console.log(failures === 0 ? "\nAll analysis checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
