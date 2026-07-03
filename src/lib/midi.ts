import type { Song, SongPhrase } from "./songs";

/**
 * MIDI melody import. Real song files are full arrangements — bass, drums,
 * pads, arpeggios AND the vocal line, sometimes all inside one track on
 * different channels. So: split into (track, channel) voices, score each on
 * how melody-like it is (lyrics, name, register, monophony, density), rank,
 * and let the UI offer the runners-up if the top pick sounds wrong.
 * Lyric meta events (karaoke files) become real syllables and phrase breaks.
 */

export type RawNote = { midi: number; start: number; dur: number }; // beats

export type MidiVoice = {
  label: string;
  notes: RawNote[]; // monophonic, chronological
  ownLyrics: boolean; // lyric events lived in this voice's track
  score: number;
};

export type ParsedMidi = {
  name: string | null;
  bpm: number;
  voices: MidiVoice[]; // ranked, best first
  lyrics: { beat: number; text: string; newline: boolean }[];
};

const MIN_NOTES = 8;

export function parseMidiFile(data: Uint8Array): ParsedMidi {
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
  const decoder = new TextDecoder("utf-8", { fatal: false });

  type Track = {
    name: string | null;
    lyricEvents: { tick: number; text: string }[]; // meta 0x05
    textEvents: { tick: number; text: string }[]; // meta 0x01 (soft karaoke)
    byChannel: Map<number, RawNote[]>;
  };
  const tracks: Track[] = [];
  let maxTick = 0;

  for (let t = 0; t < trackCount; t++) {
    if (pos + 8 > data.length) break;
    if (str4() !== "MTrk") throw new Error("Malformed MIDI track");
    const len = u32();
    const end = pos + len;
    let tick = 0;
    let running = 0;
    const open = new Map<string, { midi: number; start: number }>();
    const track: Track = {
      name: null,
      lyricEvents: [],
      textEvents: [],
      byChannel: new Map(),
    };

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
        } else if (type === 0x03 && track.name === null) {
          track.name = decoder.decode(data.slice(pos, pos + l)).trim();
        } else if (type === 0x05) {
          track.lyricEvents.push({
            tick,
            text: decoder.decode(data.slice(pos, pos + l)),
          });
        } else if (type === 0x01) {
          track.textEvents.push({
            tick,
            text: decoder.decode(data.slice(pos, pos + l)),
          });
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
            if (!open.has(key)) open.set(key, { midi: note, start: tick });
          } else {
            const o = open.get(key);
            if (o) {
              open.delete(key);
              const dur = (tick - o.start) / division;
              if (dur > 0.05 && ch !== 9) {
                let arr = track.byChannel.get(ch);
                if (!arr) {
                  arr = [];
                  track.byChannel.set(ch, arr);
                }
                arr.push({ midi: o.midi, start: o.start / division, dur });
              }
            }
          }
        } else if (kind === 0xc0 || kind === 0xd0) {
          pos += 1;
        } else {
          pos += 2;
        }
      }
      maxTick = Math.max(maxTick, tick);
    }
    pos = end;
    tracks.push(track);
    if (fileName === null && track.name) fileName = track.name;
  }

  const songBeats = maxTick / division;

  // --- lyric pool: prefer real lyric events; fall back to "soft karaoke"
  // text events (skipping @-prefixed metadata lines)
  let lyricSourceTrack = -1;
  let rawLyrics: { tick: number; text: string }[] = [];
  {
    let best = 0;
    tracks.forEach((tr, i) => {
      if (tr.lyricEvents.length > best) {
        best = tr.lyricEvents.length;
        rawLyrics = tr.lyricEvents;
        lyricSourceTrack = i;
      }
    });
    if (rawLyrics.length < 10) {
      tracks.forEach((tr, i) => {
        const usable = tr.textEvents.filter(
          (e) => !e.text.startsWith("@") && e.text.trim().length > 0,
        );
        if (usable.length > Math.max(10, rawLyrics.length)) {
          rawLyrics = usable;
          lyricSourceTrack = i;
        }
      });
    }
  }
  const lyrics = rawLyrics.map((e) => {
    const newline = /^[/\\]/.test(e.text);
    return {
      beat: e.tick / division,
      text: e.text.replace(/^[/\\]+/, "").replace(/[\r\n]+/g, " "),
      newline,
    };
  });

  // --- voices
  const voices: MidiVoice[] = [];
  tracks.forEach((tr, ti) => {
    const multiChannel = tr.byChannel.size > 1;
    for (const [ch, arr] of tr.byChannel) {
      if (arr.length < MIN_NOTES) continue;
      arr.sort((a, b) => a.start - b.start || b.midi - a.midi);
      // polyphony before reduction
      let overlaps = 0;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].start < arr[i - 1].start + arr[i - 1].dur - 0.05) overlaps++;
      }
      const overlapFrac = overlaps / arr.length;
      const mono = monoReduce(arr);
      if (mono.length < MIN_NOTES) continue;
      const label =
        (tr.name && tr.name.length > 0 ? tr.name : `Track ${ti + 1}`) +
        (multiChannel ? ` · ch ${ch + 1}` : "");
      voices.push({
        label,
        notes: mono,
        ownLyrics:
          lyricSourceTrack === ti && lyrics.length >= mono.length * 0.3,
        score: scoreVoice(mono, overlapFrac, tr.name, songBeats, {
          hasOwnLyrics: lyricSourceTrack === ti && lyrics.length >= mono.length * 0.3,
        }),
      });
    }
  });

  if (voices.length === 0) throw new Error("No melody-like track found in this MIDI file");
  voices.sort((a, b) => b.score - a.score);

  return { name: fileName, bpm: Math.min(220, Math.max(40, bpm)), voices, lyrics };
}

function monoReduce(sorted: RawNote[]): RawNote[] {
  const mono: RawNote[] = [];
  for (const n of sorted) {
    const prev = mono[mono.length - 1];
    if (prev && n.start < prev.start + prev.dur - 0.05) {
      if (n.midi > prev.midi) {
        prev.dur = Math.max(0.1, n.start - prev.start);
        mono.push({ ...n });
      }
    } else {
      mono.push({ ...n });
    }
  }
  return mono;
}

function scoreVoice(
  mono: RawNote[],
  overlapFrac: number,
  trackName: string | null,
  songBeats: number,
  flags: { hasOwnLyrics: boolean },
): number {
  const n = mono.length;
  const pitches = mono.map((x) => x.midi);
  const avgPitch = pitches.reduce((a, b) => a + b, 0) / n;
  const span = Math.max(...pitches) - Math.min(...pitches);
  const durs = mono.map((x) => x.dur);
  const avgDur = durs.reduce((a, b) => a + b, 0) / n;
  const first = mono[0].start;
  const last = mono[n - 1].start + mono[n - 1].dur;
  const extent = Math.max(1, last - first);
  const density = n / extent;

  let s = 0;

  if (flags.hasOwnLyrics) s += 50;

  const name = (trackName ?? "").toLowerCase();
  if (/vocal|melod|voice|vox|sing|lead vox|cantus/.test(name)) s += 35;
  if (/\blead\b/.test(name)) s += 10;
  if (/bass/.test(name)) s -= 30;
  if (/drum|perc|kick|snare|hat/.test(name)) s -= 40;
  if (/pad|string|choir|organ|arp/.test(name)) s -= 12;

  // singable register: roughly G2..C6, sweet spot around C3..C5
  if (avgPitch >= 55 && avgPitch <= 79) s += 20;
  else if (avgPitch >= 48 && avgPitch <= 84) s += 8;
  if (avgPitch < 46) s -= 30; // bassline register
  if (avgPitch > 90) s -= 15; // piccolo/bell territory

  // vocal melodies rarely exceed two octaves
  if (span <= 19) s += 12;
  else if (span > 34) s -= 20;

  // mostly monophonic beats chordal comping
  if (overlapFrac < 0.08) s += 15;
  else if (overlapFrac > 0.35) s -= 25;

  // note lengths: not machine-gun arps, not held pads
  if (avgDur >= 0.2 && avgDur <= 2.5) s += 10;
  if (avgDur > 4) s -= 15;
  if (density > 5) s -= 20;
  else if (density >= 0.4 && density <= 3.5) s += 10;

  // melody usually spans much of the song and has real length
  if (extent > songBeats * 0.5) s += 10;
  s += Math.min(n, 250) / 250 * 8;

  // melodies breathe: some silence between phrases; wall-to-wall notes are
  // usually accompaniment
  const sounding = durs.reduce((a, b) => a + b, 0);
  const fill = sounding / extent;
  if (fill < 0.85) s += 8;

  return Math.round(s * 10) / 10;
}

/** Attach lyric syllables + phrase-break flags to a voice's notes. */
function withLyrics(
  notes: RawNote[],
  lyrics: ParsedMidi["lyrics"],
): (RawNote & { syl?: string; nl?: boolean })[] {
  const out = notes.map((n) => ({ ...n }) as RawNote & { syl?: string; nl?: boolean });
  if (lyrics.length === 0) return out;
  let li = 0;
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const nextStart = i + 1 < out.length ? out[i + 1].start : Infinity;
    // events strictly before this note's window belong to dropped notes —
    // skip them, but keep their line-break intent
    while (li < lyrics.length && lyrics[li].beat < n.start - 0.6) {
      if (lyrics[li].newline) n.nl = true;
      li++;
    }
    // consume events in this note's window (up to the midpoint to the next
    // note, so a melisma's extra syllables don't steal the next note's)
    const limit = Math.min(n.start + 0.6, (n.start + nextStart) / 2 + 1e-3);
    while (li < lyrics.length && lyrics[li].beat <= limit) {
      const ev = lyrics[li++];
      const text = ev.text.trim();
      if (n.syl === undefined && text.length > 0) n.syl = text.slice(0, 12);
      if (ev.newline) n.nl = true;
    }
  }
  return out;
}

/**
 * One voice's raw notes with lyric syllables attached, on the absolute beat
 * timeline (sing-along alignment needs real song time, not phrase chunks).
 */
export function melodyWithLyrics(
  parsed: ParsedMidi,
  voiceIdx = 0,
): (RawNote & { syl?: string })[] {
  const voice = parsed.voices[voiceIdx];
  if (!voice) throw new Error("No such track");
  return withLyrics(voice.notes, parsed.lyrics);
}

/** Builds a practicable Song from one extracted voice. */
export function songFromMidi(
  parsed: ParsedMidi,
  fallbackTitle: string,
  voiceIdx = 0,
): Song {
  const voice = parsed.voices[voiceIdx];
  if (!voice) throw new Error("No such track");
  const notes = withLyrics(voice.notes, parsed.lyrics);

  const phrases: SongPhrase[] = [];
  let current: typeof notes = [];
  let prevEnd = 0;

  const flush = () => {
    if (current.length === 0) return;
    const sylls = current.map((n) => n.syl).filter((s): s is string => !!s);
    const phrase: SongPhrase = {
      lyric:
        sylls.length >= current.length * 0.4
          ? sylls.join(" ").replace(/\s+([,.!?;:'])/g, "$1").replace(/\s+/g, " ")
          : `Phrase ${phrases.length + 1}`,
      notes: current.map((n, i) => {
        // rests between notes carry the rhythm — preserve them
        const next = current[i + 1];
        const gap = next ? Math.max(0, next.start - (n.start + n.dur)) : 0;
        const note: SongPhrase["notes"][number] = {
          degree: n.midi,
          beats: Math.min(6, Math.max(0.25, n.dur)),
        };
        if (n.syl) note.syllable = n.syl; // no undefined keys (Firestore rejects them)
        if (gap >= 0.05) note.gapBeats = Math.min(4, Math.round(gap * 100) / 100);
        return note;
      }),
    };
    // merge fragments into the previous phrase instead of emitting confetti
    if (current.length < 3 && phrases.length > 0) {
      const prev = phrases[phrases.length - 1];
      if (prev.notes.length + current.length <= 20) {
        prev.notes.push(...phrase.notes);
        current = [];
        return;
      }
    }
    phrases.push(phrase);
    current = [];
  };

  for (const n of notes) {
    const gap = n.start - prevEnd;
    const beatsSoFar = current.reduce((a, x) => a + x.dur, 0);
    if (
      current.length > 0 &&
      (n.nl || gap >= 1.5 || current.length >= 16 || beatsSoFar >= 14)
    ) {
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
    phrases: phrases.slice(0, 48),
  };
}
