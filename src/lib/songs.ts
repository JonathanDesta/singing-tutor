import type { Exercise } from "./exercises";

/**
 * Small library of public-domain melodies, encoded per syllable as scale
 * degrees (semitones relative to the tonic; negatives dip below it) and
 * durations in beats. Phrases are practiced one at a time through the same
 * runner as exercises, transposed to the singer's range.
 */

export type SongNote = { degree: number; beats: number; syllable: string };
export type SongPhrase = { lyric: string; notes: SongNote[] };
export type Song = {
  id: string;
  title: string;
  bpm: number;
  attribution: string;
  phrases: SongPhrase[];
};

const N = (degree: number, beats: number, syllable: string): SongNote => ({
  degree,
  beats,
  syllable,
});

export const SONGS: Song[] = [
  {
    id: "twinkle",
    title: "Twinkle, Twinkle, Little Star",
    bpm: 100,
    attribution: "Traditional (public domain)",
    phrases: [
      {
        lyric: "Twinkle, twinkle, little star",
        notes: [
          N(0, 1, "Twin"), N(0, 1, "kle"), N(7, 1, "twin"), N(7, 1, "kle"),
          N(9, 1, "lit"), N(9, 1, "tle"), N(7, 2, "star"),
        ],
      },
      {
        lyric: "How I wonder what you are",
        notes: [
          N(5, 1, "How"), N(5, 1, "I"), N(4, 1, "won"), N(4, 1, "der"),
          N(2, 1, "what"), N(2, 1, "you"), N(0, 2, "are"),
        ],
      },
      {
        lyric: "Up above the world so high",
        notes: [
          N(7, 1, "Up"), N(7, 1, "a"), N(5, 1, "bove"), N(5, 1, "the"),
          N(4, 1, "world"), N(4, 1, "so"), N(2, 2, "high"),
        ],
      },
      {
        lyric: "Like a diamond in the sky",
        notes: [
          N(7, 1, "Like"), N(7, 1, "a"), N(5, 1, "dia"), N(5, 1, "mond"),
          N(4, 1, "in"), N(4, 1, "the"), N(2, 2, "sky"),
        ],
      },
    ],
  },
  {
    id: "birthday",
    title: "Happy Birthday",
    bpm: 120,
    attribution: "Traditional (public domain)",
    phrases: [
      {
        lyric: "Happy birthday to you",
        notes: [
          N(-5, 0.75, "Hap"), N(-5, 0.25, "py"), N(-3, 1, "birth"),
          N(-5, 1, "day"), N(0, 1, "to"), N(-2, 2, "you"),
        ],
      },
      {
        lyric: "Happy birthday to you",
        notes: [
          N(-5, 0.75, "Hap"), N(-5, 0.25, "py"), N(-3, 1, "birth"),
          N(-5, 1, "day"), N(2, 1, "to"), N(0, 2, "you"),
        ],
      },
      {
        lyric: "Happy birthday, dear singer",
        notes: [
          N(-5, 0.75, "Hap"), N(-5, 0.25, "py"), N(7, 1, "birth"),
          N(4, 1, "day"), N(0, 1, "dear"), N(-2, 1, "sing"), N(-3, 2, "er"),
        ],
      },
      {
        lyric: "Happy birthday to you",
        notes: [
          N(5, 0.75, "Hap"), N(5, 0.25, "py"), N(4, 1, "birth"),
          N(0, 1, "day"), N(2, 1, "to"), N(0, 2, "you"),
        ],
      },
    ],
  },
  {
    id: "grace",
    title: "Amazing Grace",
    bpm: 90,
    attribution: "Traditional (public domain), simplified arrangement",
    phrases: [
      {
        lyric: "Amazing grace, how sweet the sound",
        notes: [
          N(-5, 1, "A"), N(0, 2, "ma"), N(4, 1, "zing"), N(4, 2, "grace"),
          N(2, 1, "how"), N(0, 2, "sweet"), N(-3, 1, "the"), N(-5, 3, "sound"),
        ],
      },
      {
        lyric: "That saved a wretch like me",
        notes: [
          N(-5, 1, "that"), N(0, 2, "saved"), N(4, 1, "a"), N(4, 2, "wretch"),
          N(2, 1, "like"), N(7, 4, "me"),
        ],
      },
      {
        lyric: "I once was lost, but now am found",
        notes: [
          N(7, 1, "I"), N(4, 2, "once"), N(7, 1, "was"), N(4, 1, "lost"),
          N(2, 1, "but"), N(0, 2, "now"), N(-3, 1, "am"), N(-5, 3, "found"),
        ],
      },
      {
        lyric: "Was blind, but now I see",
        notes: [
          N(-5, 1, "was"), N(0, 2, "blind"), N(4, 1, "but"), N(4, 2, "now"),
          N(2, 1, "I"), N(0, 4, "see"),
        ],
      },
    ],
  },
  {
    id: "ode",
    title: "Ode to Joy",
    bpm: 110,
    attribution: "Beethoven (public domain), hymn lyrics",
    phrases: [
      {
        lyric: "Joyful, joyful, we adore thee, God of glory, Lord of love",
        notes: [
          N(4, 1, "Joy"), N(4, 1, "ful"), N(5, 1, "joy"), N(7, 1, "ful"),
          N(7, 1, "we"), N(5, 1, "a"), N(4, 1, "dore"), N(2, 1, "thee"),
          N(0, 1, "God"), N(0, 1, "of"), N(2, 1, "glo"), N(4, 1, "ry"),
          N(4, 1.5, "Lord"), N(2, 0.5, "of"), N(2, 2, "love"),
        ],
      },
      {
        lyric: "Hearts unfold like flowers before thee, hail thee as the sun above",
        notes: [
          N(4, 1, "Hearts"), N(4, 1, "un"), N(5, 1, "fold"), N(7, 1, "like"),
          N(7, 1, "flowers"), N(5, 1, "be"), N(4, 1, "fore"), N(2, 1, "thee"),
          N(0, 1, "hail"), N(0, 1, "thee"), N(2, 1, "as"), N(4, 1, "the"),
          N(2, 1.5, "sun"), N(0, 0.5, "a"), N(0, 2, "bove"),
        ],
      },
    ],
  },
];

/**
 * Converts one song phrase into an Exercise for the runner. Degrees are
 * shifted so the phrase's lowest note is degree 0, which is what pickRoot
 * expects when centering the phrase in the singer's range.
 */
export function songPhraseExercise(song: Song, phraseIdx: number): Exercise {
  const phrase = song.phrases[phraseIdx];
  const degrees = phrase.notes.map((n) => n.degree);
  const minDeg = Math.min(...degrees);
  const span = Math.max(...degrees) - minDeg;
  return {
    id: `song-${song.id}-p${phraseIdx + 1}`,
    name: `${song.title} · phrase ${phraseIdx + 1}`,
    description: phrase.lyric,
    span,
    segments: phrase.notes.map((n) => ({
      kind: "note" as const,
      degree: n.degree - minDeg,
      ms: Math.round((n.beats * 60000) / song.bpm),
      label: n.syllable,
    })),
  };
}
