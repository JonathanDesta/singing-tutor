/**
 * Song search against the iTunes Search API — the free, keyless catalog of
 * real commercial recordings with ~30s preview clips (256kbps AAC).
 *
 * The search endpoint sends no CORS headers, so browsers must use JSONP
 * (verified 2026-07: `callback=` wraps the JSON in a function call). The
 * preview audio CDN (audio-ssl.itunes.apple.com) DOES send
 * `Access-Control-Allow-Origin: *`, so clips can be fetched and decoded
 * directly — both playback and analysis work without any proxy.
 */

export type ITunesTrack = {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName: string;
  previewUrl: string;
  artworkUrl100: string;
  trackTimeMillis: number;
};

type RawResult = Partial<ITunesTrack> & { kind?: string };

let jsonpSeq = 0;

export function searchITunes(
  term: string,
  limit = 12,
): Promise<ITunesTrack[]> {
  return new Promise((resolve, reject) => {
    const cbName = `__itunesCb${jsonpSeq++}`;
    const script = document.createElement("script");
    const w = window as unknown as Record<string, unknown>;

    const cleanup = () => {
      clearTimeout(timer);
      delete w[cbName];
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Search timed out — check your connection."));
    }, 10000);

    w[cbName] = (data: { results?: RawResult[] }) => {
      cleanup();
      const tracks = (data?.results ?? [])
        .filter(
          (r): r is ITunesTrack & RawResult =>
            r.kind === "song" &&
            typeof r.previewUrl === "string" &&
            typeof r.trackId === "number" &&
            typeof r.trackName === "string" &&
            typeof r.artistName === "string",
        )
        .map((r) => ({
          trackId: r.trackId,
          trackName: r.trackName,
          artistName: r.artistName,
          collectionName: r.collectionName ?? "",
          previewUrl: r.previewUrl,
          artworkUrl100: r.artworkUrl100 ?? "",
          trackTimeMillis: r.trackTimeMillis ?? 0,
        }));
      resolve(tracks);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Song search failed — check your connection."));
    };
    const params = new URLSearchParams({
      term,
      media: "music",
      entity: "song",
      limit: String(limit),
      callback: cbName,
    });
    script.src = `https://itunes.apple.com/search?${params}`;
    document.head.appendChild(script);
  });
}

/** Fetches a preview clip's raw bytes (CORS-enabled CDN, no proxy needed). */
export async function fetchPreviewAudio(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`preview fetch: ${r.status}`);
  return r.arrayBuffer();
}
