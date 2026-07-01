// Feeds synthetic signals through the same pitchy detector the app uses and
// checks the detected frequency. Run with: npm run verify:pitch
import { PitchDetector } from "pitchy";

const SAMPLE_RATE = 48000;
const N = 2048;
const detector = PitchDetector.forFloat32Array(N);

function detect(fill) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = fill(i / SAMPLE_RATE);
  return detector.findPitch(buf, SAMPLE_RATE);
}

let failures = 0;

function check(label, freq, actual, clarity, toleranceCents = 5) {
  const cents = 1200 * Math.log2(actual / freq);
  const ok = Math.abs(cents) <= toleranceCents && clarity >= 0.9;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} expected ${freq.toFixed(2)} Hz, ` +
      `got ${actual.toFixed(2)} Hz (${cents >= 0 ? "+" : ""}${cents.toFixed(1)}¢, clarity ${clarity.toFixed(3)})`,
  );
}

// pure sine across the vocal range (E2 bass low .. C6 soprano high)
for (const f of [82.41, 110, 146.83, 220, 261.63, 440, 523.25, 1046.5]) {
  const [p, c] = detect((t) => Math.sin(2 * Math.PI * f * t));
  check(`sine ${f} Hz`, f, p, c);
}

// sawtooth-ish harmonic stack — closer to a real voice than a pure sine
for (const f of [130.81, 261.63, 392]) {
  const [p, c] = detect(
    (t) =>
      0.6 * Math.sin(2 * Math.PI * f * t) +
      0.25 * Math.sin(2 * Math.PI * 2 * f * t) +
      0.15 * Math.sin(2 * Math.PI * 3 * f * t),
  );
  check(`harmonics ${f} Hz`, f, p, c);
}

// sine with noise — should still lock on
{
  const f = 261.63;
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const [p, c] = detect((t) => Math.sin(2 * Math.PI * f * t) + 0.1 * rand());
  check(`noisy sine ${f} Hz`, f, p, c);
}

// silence must NOT report a confident pitch
{
  const [, c] = detect(() => 0);
  const ok = c < 0.9 || Number.isNaN(c);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  silence rejected (clarity ${c})`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
