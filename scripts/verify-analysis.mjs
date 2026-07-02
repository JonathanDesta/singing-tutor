// Feeds synthetic pitch contours and synthesized vowels through the phase-4
// analyzers. Run with: npm run verify:analysis (bundles TS via esbuild first).
import { analyzeSegments } from "./.bundle/analysis.js";
import { estimateFormants, classifyVowel } from "./.bundle/formants.js";
import {
  scoreSegments,
  applyVibratoAllowance,
  overallScore,
} from "./.bundle/scoring.js";

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
    frames.push({ t, midi: midiAt(t), clarity, f1: null, f2: null });
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

// pure sine must NOT produce a vowel (no formant structure)
{
  const buf = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) buf[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  const { f1 } = estimateFormants(buf, 48000);
  check("pure sine yields no F1", f1 === null || f1 < 260, `f1=${f1}`);
}

console.log(failures === 0 ? "\nAll analysis checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
