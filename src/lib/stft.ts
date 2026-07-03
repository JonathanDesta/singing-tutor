/**
 * Complex FFT for arbitrary sizes (radix-2 + Bluestein chirp-z) and a
 * torch.stft-compatible STFT/ISTFT pair. MDX-Net separation models are
 * trained against torch.stft with n_fft=7680 (not a power of two), hop 1024,
 * periodic Hann, center reflect-padding, one-sided output — every detail
 * here mirrors those semantics; scripts/verify-stft.mjs checks round-trips
 * and DFT agreement numerically.
 */

/** In-place radix-2 complex FFT (n must be a power of two). */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + half] * cr - im[i + j + half] * ci;
        const vi = re[i + j + half] * ci + im[i + j + half] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

type BluesteinPlan = {
  m: number;
  chirpRe: Float64Array; // exp(-iπ n²/N)
  chirpIm: Float64Array;
  bFftRe: Float64Array; // FFT of the chirp kernel
  bFftIm: Float64Array;
};

const plans = new Map<number, BluesteinPlan>();

function planFor(n: number): BluesteinPlan {
  let p = plans.get(n);
  if (p) return p;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    // n² mod 2N keeps the angle argument small (n² overflows precision fast)
    const k = (i * i) % (2 * n);
    const ang = (Math.PI * k) / n;
    chirpRe[i] = Math.cos(ang);
    chirpIm[i] = -Math.sin(ang);
    // kernel b[n] = conj(chirp): exp(+iπ n²/N), mirrored into m-cyclic buffer
    bRe[i] = chirpRe[i];
    bIm[i] = -chirpIm[i];
    if (i > 0) {
      bRe[m - i] = bRe[i];
      bIm[m - i] = bIm[i];
    }
  }
  fftRadix2(bRe, bIm);
  p = { m, chirpRe, chirpIm, bFftRe: bRe, bFftIm: bIm };
  plans.set(n, p);
  return p;
}

/** Complex FFT of arbitrary size via Bluestein (falls back to radix-2). */
export function fftAny(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if ((n & (n - 1)) === 0) {
    fftRadix2(re, im, inverse);
    return;
  }
  if (inverse) {
    // ifft(x) = conj(fft(conj(x)))/n
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fftAny(re, im, false);
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
    return;
  }
  const { m, chirpRe, chirpIm, bFftRe, bFftIm } = planFor(n);
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    aRe[i] = re[i] * chirpRe[i] - im[i] * chirpIm[i];
    aIm[i] = re[i] * chirpIm[i] + im[i] * chirpRe[i];
  }
  fftRadix2(aRe, aIm);
  for (let i = 0; i < m; i++) {
    const r = aRe[i] * bFftRe[i] - aIm[i] * bFftIm[i];
    aIm[i] = aRe[i] * bFftIm[i] + aIm[i] * bFftRe[i];
    aRe[i] = r;
  }
  fftRadix2(aRe, aIm, true);
  for (let i = 0; i < n; i++) {
    re[i] = aRe[i] * chirpRe[i] - aIm[i] * chirpIm[i];
    im[i] = aRe[i] * chirpIm[i] + aIm[i] * chirpRe[i];
  }
}

/** Periodic Hann window, matching torch.hann_window(n) (periodic=True). */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export type Spectrogram = {
  nFft: number;
  hop: number;
  bins: number; // nFft/2 + 1 (one-sided)
  frames: number;
  re: Float64Array; // [frames][bins] row-major
  im: Float64Array;
};

/** torch.stft(x, nFft, hop, window=hann_periodic, center=True, onesided=True). */
export function stft(x: Float32Array, nFft: number, hop: number): Spectrogram {
  const pad = nFft >> 1;
  const padded = new Float64Array(x.length + 2 * pad);
  for (let i = 0; i < x.length; i++) padded[pad + i] = x[i];
  // reflect padding (torch center default)
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = x[Math.min(i + 1, x.length - 1)];
    padded[pad + x.length + i] = x[Math.max(0, x.length - 2 - i)];
  }
  const frames = 1 + Math.floor((padded.length - nFft) / hop);
  const bins = (nFft >> 1) + 1;
  const win = hannPeriodic(nFft);
  const outRe = new Float64Array(frames * bins);
  const outIm = new Float64Array(frames * bins);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < nFft; i++) {
      re[i] = padded[off + i] * win[i];
      im[i] = 0;
    }
    fftAny(re, im);
    outRe.set(re.subarray(0, bins), f * bins);
    outIm.set(im.subarray(0, bins), f * bins);
  }
  return { nFft, hop, bins, frames, re: outRe, im: outIm };
}

/** Inverse of stft() (center=True semantics), returning `length` samples. */
export function istft(spec: Spectrogram, length: number): Float32Array {
  const { nFft, hop, bins, frames } = spec;
  const pad = nFft >> 1;
  const win = hannPeriodic(nFft);
  const acc = new Float64Array(length + 2 * pad);
  const norm = new Float64Array(length + 2 * pad);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      re[b] = spec.re[base + b];
      im[b] = spec.im[base + b];
    }
    // conjugate symmetry for the full spectrum
    for (let b = bins; b < nFft; b++) {
      re[b] = spec.re[base + (nFft - b)];
      im[b] = -spec.im[base + (nFft - b)];
    }
    fftAny(re, im, true);
    const off = f * hop;
    for (let i = 0; i < nFft; i++) {
      acc[off + i] += re[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const n = norm[pad + i];
    out[i] = n > 1e-11 ? acc[pad + i] / n : 0;
  }
  return out;
}
