/**
 * DEV-ONLY probe: run vocal separation on an iTunes preview and POST the
 * mono vocal stem to the local dataset receiver for node-side validation.
 * Progress is mirrored on window.__sepState for polling from preview-eval.
 */
import { searchITunes, fetchPreviewAudio } from "../lib/itunes";
import { separateVocals, SEPARATION_SAMPLE_RATE } from "../lib/separate";

async function sepProbe(term: string, saveName: string): Promise<unknown> {
  const state: Record<string, unknown> = { status: "running", t0: Date.now() };
  (window as unknown as Record<string, unknown>).__sepState = state;
  const tracks = await searchITunes(term, 1);
  if (!tracks.length) throw new Error("no track");
  state.track = `${tracks[0].trackName} — ${tracks[0].artistName}`;
  const bytes = await fetchPreviewAudio(tracks[0].previewUrl);
  const octx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 1,
    sampleRate: SEPARATION_SAMPLE_RATE,
  });
  const dec = await octx.decodeAudioData(bytes);
  const L = dec.getChannelData(0);
  const R = dec.numberOfChannels > 1 ? dec.getChannelData(1) : L;
  const t1 = Date.now();
  const { left, right } = await separateVocals(L, R, (p) => {
    state.stage = p.stage;
    state.fraction = Math.round(p.fraction * 100) / 100;
  });
  state.sepMs = Date.now() - t1;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
  await fetch(`http://localhost:8977/save?name=${saveName}`, {
    method: "POST",
    body: mono.buffer,
  });
  state.status = "done";
  state.totalMs = Date.now() - (state.t0 as number);
  return state;
}

declare global {
  interface Window {
    __sepProbe: typeof sepProbe;
  }
}
window.__sepProbe = sepProbe;
