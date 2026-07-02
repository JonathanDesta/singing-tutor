import type { Song, SongPhrase } from "./songs";

/**
 * Minimal Standard MIDI File parser sufficient for melody import:
 * note on/off, tempo, track names; ignores everything else. Picks the most
 * melody-like track, reduces it to a monophonic line, and splits it into
 * singable phrases at rests.
 */

type RawNote = { midi: number; start: number; dur: number }; // beats

export function parseMidiFile(data: Uint8Array): {
  name: string | null;
  bpm: number;
  notes: RawNote[];
} {
  let pos = 0;
  const u32 = () =>
    ((data[pos++] << 24) | (data[pos++] << 16) | (data[pos++] << 8) | data[pos++]) >>> 0;
  const u16 = () => (data[pos++] << 8) | data[pos++];
  const str4 = () =>
    String.fromCharCode(data[pos++], data[pos++], data[pos++], data[pos++]);

  if (str4() !== "MThd") throw new Error("Not a MIDI file");
  const headerLen = u32();
  u16(); // format
  const trackCount = u16();
  const division = u16();
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI not supported");
  pos += headerLen - 6;

  let bpm = 120;
  let fileName: string | null = null;
  const tracks: { notes: (RawNote & { ch: number })[]; name: string | null }[] = [];

  for (let t = 0; t < trackCount; t++) {
    if (pos + 8 > data.length) break;
    if (str4() !== "MTrk") throw new Error("Malformed MIDI track");
    const len = u32();
    const end = pos + len;
    let tick = 0;
    let running = 0;
    const open = new Map<string, { midi: number; start: number; ch: number }>();
    const notes: (RawNote & { ch: number })[] = [];
    let trackName: string | null = null;

    const vlq = () => {
      let v = 0;
      let b;
      do {
        b = data[pos++];
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80);
      return v;
    };

    while (pos < end) {
      tick += vlq();
      let status = data[pos];
      if (status & 0x80) {
        pos++;
        if (status < 0xf0) running = status;
      } else {
        status = running;
      }

      if (status === 0xff) {
        const type = data[pos++];
        const l = vlq();
        if (type === 0x51 && l === 3) {
          const usPerBeat = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
          if (usPerBeat > 0) bpm = Math.round(60000000 / usPerBeat);
        } else if (type === 0x03 && trackName === null) {
          trackName = new TextDecoder().decode(data.slice(pos, pos + l)).trim();
        }
        pos += l;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += vlq();
      } else {
        const kind = status & 0xf0;
        const ch = status & 0x0f;
        if (kind === 0x90 || kind === 0x80) {
          const note = data[pos++];
          const vel = data[pos++];
          const key = `${ch}:${note}`;
          if (kind === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, { midi: note, start: tick, ch });
          } else {
            const o = open.get(key);
            if (o) {
              open.delete(key);
              const dur = (tick - o.start) / division;
              if (dur > 0.05) {
                notes.push({ midi: o.midi, start: o.start / division, dur, ch });
              }
            }
          }
        } else if (kind === 0xc0 || kind === 0xd0) {
          pos += 1;
        } else {
          pos += 2; // 0xA0, 0xB0, 0xE0
        }
      }
    }
    pos = end;
    tracks.push({ notes: notes.filter((n) => n.ch !== 9), name: trackName }); // drop drums
    if (fileName === null && trackName) fileName = trackName;
  }

  // pick the melody: among substantial tracks, prefer the highest average pitch
  const counts = tracks.map((t) => t.notes.length);
  const maxCount = Math.max(0, ...counts);
  if (maxCount < 8) throw new Error("No melody track found in this MIDI file");
  let best: (RawNote & { ch: number })[] = [];
  let bestAvg = -1;
  for (const tr of tracks) {
    if (tr.notes.length < Math.max(8, maxCount * 0.4)) continue;
    const avg = tr.notes.reduce((a, n) => a + n.midi, 0) / tr.notes.length;
    if (avg > bestAvg) {
      bestAvg = avg;
      best = tr.notes;
    }
  }

  // monophonic reduction: on overlap keep the higher note
  const sorted = [...best].sort((a, b) => a.start - b.start || b.midi - a.midi);
  const mono: RawNote[] = [];
  for (const n of sorted) {
    const prev = mono[mono.length - 1];
    if (prev && n.start < prev.start + prev.dur - 0.05) {
      if (n.midi > prev.midi) {
        prev.dur = Math.max(0.1, n.start - prev.start);
        mono.push({ midi: n.midi, start: n.start, dur: n.dur });
      }
      // lower overlapping note: skip
    } else {
      mono.push({ midi: n.midi, start: n.start, dur: n.dur });
    }
  }

  return { name: fileName, bpm: Math.min(220, Math.max(40, bpm)), notes: mono };
}

/** Splits the melody into phrases at rests / length limits and builds a Song. */
export function songFromMidi(
  parsed: { name: string | null; bpm: number; notes: RawNote[] },
  fallbackTitle: string,
): Song {
  const phrases: SongPhrase[] = [];
  let current: RawNote[] = [];
  let prevEnd = 0;

  const flush = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    phrases.push({
      lyric: `Phrase ${phrases.length + 1}`,
      notes: current.map((n) => ({
        degree: n.midi, // absolute; the runner re-centers per phrase
        beats: Math.min(6, Math.max(0.25, n.dur)),
      })),
    });
    current = [];
  };

  for (const n of parsed.notes) {
    const gap = n.start - prevEnd;
    const beatsSoFar = current.reduce((a, x) => a + x.dur, 0);
    if (current.length > 0 && (gap >= 1 || current.length >= 16 || beatsSoFar >= 12)) {
      flush();
    }
    current.push(n);
    prevEnd = n.start + n.dur;
  }
  flush();

  if (phrases.length === 0) throw new Error("Could not extract phrases");

  return {
    id: `import-${Date.now().toString(36)}`,
    title: parsed.name || fallbackTitle,
    bpm: parsed.bpm,
    attribution: "Imported MIDI",
    phrases: phrases.slice(0, 40),
  };
}
