import * as ort from "onnxruntime-web";
import { stft, istft, type Spectrogram } from "./stft";

/**
 * In-browser vocal separation with an MDX-Net model (Kim_Vocal_2), matching
 * the UVR/audio-separator processing exactly: chunks of 261120 samples at
 * 44.1kHz, torch-compatible STFT (n_fft 7680, hop 1024), model input/output
 * [1, 4, 3072, 256] laid out as [L.re, L.im, R.re, R.im] × [bin] × [frame],
 * ISTFT, and 3840-sample margins trimmed from each chunk.
 *
 * The model (67MB) downloads once and persists in the Cache API. WebGPU when
 * available, single-threaded WASM otherwise (GitHub Pages can't set the
 * cross-origin-isolation headers threading would need).
 */

const N_FFT = 7680;
const HOP = 1024;
const DIM_F = 3072;
const DIM_T = 256;
const CHUNK = HOP * (DIM_T - 1); // 261120
const TRIM = N_FFT >> 1; // 3840
const GEN = CHUNK - 2 * TRIM; // usable samples per chunk

export const SEPARATION_SAMPLE_RATE = 44100;
export const VOCAL_MODEL_URL =
  "https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx";
const MODEL_CACHE = "vocal-model-v1";

export type SeparationProgress = {
  stage: "download" | "separate";
  /** 0..1 within the stage */
  fraction: number;
};

async function fetchModelCached(
  onProgress?: (p: SeparationProgress) => void,
): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(VOCAL_MODEL_URL);
    if (hit) return hit.arrayBuffer();
  } catch {
    // Cache API unavailable (private mode) — plain fetch below
  }
  const res = await fetch(VOCAL_MODEL_URL);
  if (!res.ok) throw new Error(`model download: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress?.({ stage: "download", fraction: got / total });
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.put(
      VOCAL_MODEL_URL,
      new Response(buf.slice().buffer, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  } catch {
    // caching is best-effort
  }
  return buf.buffer;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function loadSeparator(
  onProgress?: (p: SeparationProgress) => void,
): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // runtime wasm from jsDelivr (version-pinned to the installed package):
      // self-hosting 40MB of wasm broke GitHub Pages deployments outright,
      // vite dev refuses dynamic imports from public/, and the 67MB model
      // is a CDN fetch (Hugging Face) anyway — nothing heavy in the bundle.
      ort.env.wasm.wasmPaths =
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
      const bytes = await fetchModelCached(onProgress);
      const providers: ("webgpu" | "wasm")[] =
        "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
      try {
        return await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: providers,
        });
      } catch {
        return await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ["wasm"],
        });
      }
    })();
    sessionPromise.catch(() => {
      sessionPromise = null; // allow retry after a failed download
    });
  }
  return sessionPromise;
}

function specToModelInput(
  data: Float32Array,
  spec: Spectrogram,
  channel: 0 | 1,
): void {
  // model layout [1, 4, DIM_F, DIM_T]; spec storage is [frame][bin]
  const reBase = channel * 2 * DIM_F * DIM_T;
  const imBase = reBase + DIM_F * DIM_T;
  for (let t = 0; t < DIM_T; t++) {
    const row = t * spec.bins;
    for (let f = 0; f < DIM_F; f++) {
      data[reBase + f * DIM_T + t] = spec.re[row + f];
      data[imBase + f * DIM_T + t] = spec.im[row + f];
    }
  }
}

function modelOutputToSpec(out: Float32Array, channel: 0 | 1): Spectrogram {
  const bins = (N_FFT >> 1) + 1;
  const re = new Float64Array(DIM_T * bins);
  const im = new Float64Array(DIM_T * bins);
  const reBase = channel * 2 * DIM_F * DIM_T;
  const imBase = reBase + DIM_F * DIM_T;
  for (let t = 0; t < DIM_T; t++) {
    const row = t * bins;
    for (let f = 0; f < DIM_F; f++) {
      re[row + f] = out[reBase + f * DIM_T + t];
      im[row + f] = out[imBase + f * DIM_T + t];
    }
    // bins above DIM_F stay zero — the model doesn't predict them
  }
  return { nFft: N_FFT, hop: HOP, bins, frames: DIM_T, re, im };
}

/** Separates the vocal stem from a 44.1kHz stereo signal. */
export async function separateVocals(
  left: Float32Array,
  right: Float32Array,
  onProgress?: (p: SeparationProgress) => void,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const session = await loadSeparator(onProgress);
  const len = left.length;
  const nChunks = Math.max(1, Math.ceil(len / GEN));
  const padLen = TRIM + nChunks * GEN + TRIM;
  const inL = new Float32Array(padLen);
  const inR = new Float32Array(padLen);
  inL.set(left, TRIM);
  inR.set(right, TRIM);
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);

  for (let c = 0; c < nChunks; c++) {
    const start = c * GEN;
    const segL = inL.slice(start, start + CHUNK);
    const segR = inR.slice(start, start + CHUNK);
    const specL = stft(segL, N_FFT, HOP);
    const specR = stft(segR, N_FFT, HOP);
    const data = new Float32Array(4 * DIM_F * DIM_T);
    specToModelInput(data, specL, 0);
    specToModelInput(data, specR, 1);
    const feeds: Record<string, ort.Tensor> = {
      [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 4, DIM_F, DIM_T]),
    };
    const results = await session.run(feeds);
    const out = results[session.outputNames[0]].data as Float32Array;
    const vocL = istft(modelOutputToSpec(out, 0), CHUNK);
    const vocR = istft(modelOutputToSpec(out, 1), CHUNK);
    const copyLen = Math.min(GEN, len - start);
    for (let i = 0; i < copyLen; i++) {
      outL[start + i] = vocL[TRIM + i];
      outR[start + i] = vocR[TRIM + i];
    }
    onProgress?.({ stage: "separate", fraction: (c + 1) / nChunks });
    // let the UI paint between chunks
    await new Promise((r) => setTimeout(r, 0));
  }
  return { left: outL, right: outR };
}
