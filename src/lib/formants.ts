/**
 * Formant (vocal-tract resonance) estimation via LPC — the classic
 * pre-emphasis → window → autocorrelation → Levinson-Durbin → spectral
 * envelope peak-picking pipeline, tuned for F1/F2 on sung vowels.
 *
 * Accuracy is inherently rough with consumer mics and untrained voices;
 * everything downstream treats the vowel guess as experimental.
 */

const TARGET_RATE = 12000; // Hz — F1/F2 live well below 4 kHz
const LPC_ORDER = 12;

export type Formants = { f1: number | null; f2: number | null };

export function estimateFormants(
  buf: Float32Array,
  sampleRate: number,
): Formants {
  // crude decimation by averaging (acts as a mild low-pass)
  const k = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const n = Math.floor(buf.length / k);
  if (n < 128) return { f1: null, f2: null };
  const fs = sampleRate / k;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < k; j++) acc += buf[i * k + j];
    x[i] = acc / k;
  }

  // pre-emphasis (boost formant structure over glottal rolloff)
  for (let i = n - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];

  // Hamming window
  for (let i = 0; i < n; i++) {
    x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }

  // autocorrelation, lags 0..ORDER
  const r = new Float64Array(LPC_ORDER + 1);
  for (let lag = 0; lag <= LPC_ORDER; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += x[i] * x[i - lag];
    r[lag] = acc;
  }
  if (r[0] <= 0) return { f1: null, f2: null };

  // Levinson-Durbin -> LPC coefficients a[1..ORDER] (a[0] = 1)
  const a = new Float64Array(LPC_ORDER + 1);
  a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= LPC_ORDER; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const kref = -acc / err;
    const prev = a.slice(0, i);
    for (let j = 1; j < i; j++) a[j] = prev[j] + kref * prev[i - j];
    a[i] = kref;
    err *= 1 - kref * kref;
    if (err <= 0) return { f1: null, f2: null };
  }

  // evaluate envelope 1/|A(f)|^2 on a grid and pick peaks
  const F_LO = 150;
  const F_HI = 3800;
  const STEPS = 160;
  const env = new Float64Array(STEPS);
  const freqs = new Float64Array(STEPS);
  for (let s = 0; s < STEPS; s++) {
    const f = F_LO + ((F_HI - F_LO) * s) / (STEPS - 1);
    freqs[s] = f;
    const w = (2 * Math.PI * f) / fs;
    let re = 1;
    let im = 0;
    for (let j = 1; j <= LPC_ORDER; j++) {
      re += a[j] * Math.cos(w * j);
      im -= a[j] * Math.sin(w * j);
    }
    env[s] = 1 / Math.max(re * re + im * im, 1e-12);
  }

  const peaks: number[] = [];
  for (let s = 1; s < STEPS - 1; s++) {
    if (env[s] > env[s - 1] && env[s] >= env[s + 1]) peaks.push(s);
  }
  const peakFreqs = peaks.map((s) => freqs[s]);

  const f1 = peakFreqs.find((f) => f >= 250 && f <= 1100) ?? null;
  const f2 =
    f1 === null
      ? null
      : (peakFreqs.find((f) => f > f1 + 250 && f >= 700 && f <= 3200) ?? null);
  return { f1, f2 };
}

/**
 * Nearest-vowel lookup against classic Peterson–Barney style averages
 * (values sit between adult male/female). Distance in log-frequency space.
 */
const VOWELS: { vowel: string; f1: number; f2: number }[] = [
  { vowel: "ah", f1: 780, f2: 1150 },
  { vowel: "eh", f1: 560, f2: 1950 },
  { vowel: "ee", f1: 300, f2: 2350 },
  { vowel: "oh", f1: 570, f2: 900 },
  { vowel: "oo", f1: 330, f2: 900 },
];

export function classifyVowel(f1: number, f2: number): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const v of VOWELS) {
    const d =
      Math.log(f1 / v.f1) ** 2 + Math.log(f2 / v.f2) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = v.vowel;
    }
  }
  // reject matches that aren't reasonably close to any reference vowel
  return bestDist < 0.18 ? best : null;
}
