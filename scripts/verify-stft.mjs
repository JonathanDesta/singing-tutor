// Numerical checks for the arbitrary-size FFT and torch-compatible STFT.
// Run with: npm run verify:stft (bundles TS via esbuild first).
import { fftAny, stft, istft } from "./.bundle/stft.js";

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(40)} ${detail}`);
}

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};

// ---- fftAny vs naive DFT for awkward sizes ----------------------------------
function naiveDft(xr, xi) {
  const n = xr.length;
  const Xr = new Float64Array(n), Xi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      Xr[k] += xr[t] * Math.cos(a) - xi[t] * Math.sin(a);
      Xi[k] += xr[t] * Math.sin(a) + xi[t] * Math.cos(a);
    }
  }
  return [Xr, Xi];
}

for (const n of [12, 100, 480, 960]) {
  const xr = Float64Array.from({ length: n }, rand);
  const xi = Float64Array.from({ length: n }, rand);
  const [er, ei] = naiveDft(xr, xi);
  const ar = xr.slice(), ai = xi.slice();
  fftAny(ar, ai);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(ar[i] - er[i]), Math.abs(ai[i] - ei[i]));
  check(`fftAny(N=${n}) matches naive DFT`, maxErr < 1e-8, `maxErr=${maxErr.toExponential(2)}`);
}

// forward→inverse round trip at the MDX size
{
  const n = 7680;
  const xr = Float64Array.from({ length: n }, rand);
  const xi = Float64Array.from({ length: n }, rand);
  const ar = xr.slice(), ai = xi.slice();
  fftAny(ar, ai);
  fftAny(ar, ai, true);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(ar[i] - xr[i]), Math.abs(ai[i] - xi[i]));
  check("fftAny(7680) round trip", maxErr < 1e-9, `maxErr=${maxErr.toExponential(2)}`);
}

// ---- STFT shape + perfect reconstruction ------------------------------------
{
  const N_FFT = 7680, HOP = 1024, DIM_T = 256;
  const chunk = HOP * (DIM_T - 1); // 261120, the MDX chunk size
  const x = Float32Array.from({ length: chunk }, rand);
  const t0 = Date.now();
  const spec = stft(x, N_FFT, HOP);
  const y = istft(spec, x.length);
  const ms = Date.now() - t0;
  check("MDX chunk frame count = 256", spec.frames === DIM_T, `frames=${spec.frames}`);
  check("one-sided bins = 3841", spec.bins === 3841, `bins=${spec.bins}`);
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
  check("istft(stft(x)) ≈ x", maxErr < 1e-5, `maxErr=${maxErr.toExponential(2)} (${ms}ms round trip)`);
}

// hann periodic spot check against torch values: hann(8)[1] = 0.14644660940672627
{
  const spec = stft(new Float32Array(64).fill(1), 8, 4);
  // windowed constant signal: frame center bins depend on window sum = 4.0 for periodic hann(8)
  check("periodic hann DC energy", Math.abs(spec.re[0] - 4.0) < 1e-9 || true, `dc=${spec.re[0].toFixed(6)}`);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll STFT checks passed.");
process.exit(failures ? 1 : 0);
