import { midiToName } from "./notes";
import type { Profile, SessionRec } from "./db";
import type { Exercise, Segment } from "./exercises";
import type { Song } from "./songs";
import type { TimbreClass } from "./timbre";

export type Feasibility = "realistic" | "stretch" | "unrealistic";

export type CoachDrillSegment = {
  kind: "note" | "glide";
  degree?: number;
  from?: number;
  to?: number;
  ms: number;
};

export type CoachDrill = {
  name: string;
  description: string;
  segments: CoachDrillSegment[];
};

export type SongSuggestion = { title: string; artist: string; why: string };

export type CoachProgram = {
  feasibility: Feasibility;
  feasibilityNotes: string;
  programSummary: string;
  weeks: { week: number; focus: string; drills: string[] }[];
  advice: string;
  customDrills?: CoachDrill[];
  songSuggestions?: SongSuggestion[];
  generatedAt: string;
  source: "claude" | "offline";
};

/** 1-based week of the program the singer is currently in. */
export function currentProgramWeek(p: CoachProgram): number {
  const total = Math.max(1, p.weeks.length);
  const elapsed =
    Math.floor((Date.now() - new Date(p.generatedAt).getTime()) / (7 * 86400e3)) + 1;
  return Math.min(total, Math.max(1, elapsed));
}

const clampInt = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(x)));

/** Validates coach-composed drills into runnable Exercises (LLM output → sanitize). */
export function drillsToExercises(p: CoachProgram | null): Exercise[] {
  if (!p?.customDrills || !Array.isArray(p.customDrills)) return [];
  const out: Exercise[] = [];
  for (const d of p.customDrills.slice(0, 6)) {
    if (!d || typeof d.name !== "string" || !Array.isArray(d.segments)) continue;
    const segs: Segment[] = [];
    for (const s of d.segments.slice(0, 24)) {
      if (!s || !Number.isFinite(s.ms)) continue;
      const ms = clampInt(s.ms, 300, 8000);
      if (s.kind === "note" && Number.isFinite(s.degree)) {
        segs.push({ kind: "note", degree: clampInt(s.degree!, 0, 24), ms });
      } else if (s.kind === "glide" && Number.isFinite(s.from) && Number.isFinite(s.to)) {
        segs.push({
          kind: "glide",
          from: clampInt(s.from!, 0, 24),
          to: clampInt(s.to!, 0, 24),
          ms,
        });
      }
    }
    if (segs.length === 0) continue;
    const span = Math.max(
      0,
      ...segs.map((s) =>
        s.kind === "note" ? s.degree : s.kind === "glide" ? Math.max(s.from, s.to) : 0,
      ),
    );
    out.push({
      id: `coach-${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      name: d.name.slice(0, 60),
      description: typeof d.description === "string" ? d.description.slice(0, 300) : "",
      span,
      segments: segs,
    });
  }
  return out;
}

export type CoachFeedback = {
  text: string;
  date: string;
  source: "claude" | "offline";
};

export type Goal = { text: string; createdAt: string };

/** Compact, numeric picture of the singer that both coaches (AI and offline) consume. */
export type SingerSummary = {
  range: string | null;
  totalSessions: number;
  perExercise: {
    name: string;
    attempts: number;
    best: number;
    recentAvg: number; // mean score of the 5 most recent attempts
    trend: number; // recentAvg minus the mean of the 5 earliest attempts
  }[];
  pitchBias: string; // e.g. "tends flat (avg -18¢ on missed notes)"
  tone: string; // aggregate clarity/breathiness from analyzed segments
  vibrato: string; // aggregate vibrato picture from sustained notes
};

export function buildSingerSummary(
  sessions: SessionRec[],
  profile: Profile | null,
): SingerSummary {
  const byExercise = new Map<string, SessionRec[]>();
  for (const s of sessions) {
    const list = byExercise.get(s.exerciseName) ?? [];
    list.push(s);
    byExercise.set(s.exerciseName, list);
  }

  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const perExercise = [...byExercise.entries()].map(([name, recs]) => {
    const scores = recs.map((r) => r.score); // insertion order = chronological
    return {
      name,
      attempts: recs.length,
      best: Math.max(...scores),
      recentAvg: Math.round(mean(scores.slice(-5))),
      trend: Math.round(mean(scores.slice(-5)) - mean(scores.slice(0, 5))),
    };
  });

  // signed cents across all voiced-but-imperfect segments reveals a flat/sharp habit
  const offCents = sessions
    .flatMap((s) => s.segments)
    .map((seg) => seg.avgCents)
    .filter((c): c is number => c !== null && Math.abs(c) > 15);
  const bias = mean(offCents);
  const pitchBias =
    offCents.length < 3
      ? "not enough data yet"
      : Math.abs(bias) < 8
        ? "no consistent flat/sharp habit"
        : bias < 0
          ? `tends flat (avg ${bias.toFixed(0)}¢ on missed notes)`
          : `tends sharp (avg +${bias.toFixed(0)}¢ on missed notes)`;

  const analyzed = sessions
    .flatMap((s) => s.segments)
    .map((seg) => seg.analysis)
    .filter((a): a is NonNullable<typeof a> => a !== null && a !== undefined);
  const tones = analyzed
    .map((a) => a.tone?.hnrDb)
    .filter((x): x is number => x !== undefined && x !== null);
  const tone =
    tones.length < 3
      ? "not enough data yet"
      : `avg tone clarity ${mean(tones).toFixed(1)} dB HNR across ${tones.length} analyzed segments`;
  const vibs = analyzed
    .map((a) => a.vibrato)
    .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined);
  const healthy = vibs.filter((v) => v.label === "healthy vibrato").length;
  const vibrato =
    vibs.length === 0
      ? "no sustained notes analyzed yet"
      : `${healthy}/${vibs.length} sustained notes show healthy vibrato; labels seen: ${[...new Set(vibs.map((v) => v.label))].join(", ")}`;

  return {
    range: profile
      ? `${midiToName(profile.rangeMin)}–${midiToName(profile.rangeMax)}`
      : null,
    totalSessions: sessions.length,
    perExercise,
    pitchBias,
    tone,
    vibrato,
  };
}

// ---------------------------------------------------------------------------
// Offline coach — rule-based fallback used until the AI backend is connected.
// Deliberately honest about its own limits: it cannot judge goal feasibility.
// ---------------------------------------------------------------------------

export function offlinePlan(goalText: string, summary: SingerSummary): CoachProgram {
  const focusHint =
    summary.pitchBias.includes("flat")
      ? "You tend to sing flat — week focus includes breath energy and support."
      : summary.pitchBias.includes("sharp")
        ? "You tend to sing sharp — week focus includes releasing tension before onset."
        : "Build accuracy fundamentals first.";
  return {
    feasibility: "stretch",
    feasibilityNotes:
      "Offline coach: I can't genuinely assess whether this goal is achievable — " +
      "that analysis needs the AI coach (not connected yet). Treating it as a stretch " +
      "goal and giving you a solid general foundation in the meantime.",
    programSummary: `Generic 4-week foundation aimed at: "${goalText}". ${focusHint}`,
    weeks: [
      {
        week: 1,
        focus: "Steadiness and breath",
        drills: [
          "Sustained note ×5 (aim: 90+, no wobble in the trace)",
          "Siren ×3, smooth and connected",
          "5 min free sing on one comfortable note, watching the cents readout",
        ],
      },
      {
        week: 2,
        focus: "Stepwise accuracy",
        drills: [
          "Five-note scale ×5 (aim: every note ≥80%)",
          "Sustained note ×3 at the top of your comfortable range",
          "Siren ×3",
        ],
      },
      {
        week: 3,
        focus: "Leaps",
        drills: [
          "Intervals do–mi–so ×5 (watch the landing of each leap)",
          "Five-note scale ×3",
          "Sustained note ×2, held 4s dead steady",
        ],
      },
      {
        week: 4,
        focus: "Range and consolidation",
        drills: [
          "Octave arpeggio ×5",
          "Intervals ×3",
          "Re-detect your range and compare to week 1",
        ],
      },
    ],
    advice:
      "Practice 10–15 minutes daily rather than long weekend sessions. Stop " +
      "immediately if anything hurts or you get hoarse — strain is never productive.",
    generatedAt: new Date().toISOString(),
    source: "offline",
  };
}

export function offlineFeedback(
  lastSession: SessionRec | null,
  summary: SingerSummary,
): CoachFeedback {
  const lines: string[] = [];
  if (!lastSession) {
    lines.push(
      "No sessions recorded yet — run an exercise from the Practice tab and come back.",
    );
  } else {
    lines.push(
      `Last session: ${lastSession.exerciseName} — score ${lastSession.score}.`,
    );
    const flat = lastSession.segments.filter(
      (s) => s.avgCents !== null && s.avgCents < -25,
    );
    const sharp = lastSession.segments.filter(
      (s) => s.avgCents !== null && s.avgCents > 25,
    );
    const unvoiced = lastSession.segments.filter((s) => s.avgCents === null);
    if (flat.length > 0) {
      lines.push(
        `Flat on ${flat.map((s) => s.label).join(", ")} — usually under-supported air. ` +
          "Try the same exercise after a strong exhale-reset, and think of the note as slightly higher than you expect.",
      );
    }
    if (sharp.length > 0) {
      lines.push(
        `Sharp on ${sharp.map((s) => s.label).join(", ")} — often tension or pushing. ` +
          "Drop your shoulders and jaw, sing it at half volume, then rebuild.",
      );
    }
    if (unvoiced.length > 0) {
      lines.push(
        `No steady tone detected on ${unvoiced.map((s) => s.label).join(", ")} — ` +
          "possibly out of comfortable range or breath ran out. If it felt strained, that note may need weeks of gradual approach, not force.",
      );
    }
    if (flat.length + sharp.length + unvoiced.length === 0) {
      lines.push(
        "All segments in tune — raise the difficulty: transpose up a semitone or two, or move to the next exercise in your program.",
      );
    }
    if (summary.pitchBias !== "not enough data yet") {
      lines.push(`Overall habit: ${summary.pitchBias}.`);
    }
  }
  lines.push("(Offline coach — connect the AI coach for deeper analysis.)");
  return {
    text: lines.join("\n\n"),
    date: new Date().toISOString(),
    source: "offline",
  };
}

// ---------------------------------------------------------------------------
// AI coach client — calls the serverless endpoint; caller falls back to the
// offline coach on any failure (endpoint absent, key missing, network down).
// ---------------------------------------------------------------------------

const COACH_ENDPOINT = "/api/coach";

export type PlanExtras = {
  previousProgram: CoachProgram | null;
  currentWeek: number | null;
  recentFeedback: string[];
};

export async function requestPlan(
  goalText: string,
  summary: SingerSummary,
  extras?: PlanExtras,
): Promise<CoachProgram> {
  const res = await fetch(COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "plan",
      goal: goalText,
      summary,
      previousProgram: extras?.previousProgram ?? null,
      currentWeek: extras?.currentWeek ?? null,
      recentFeedback: extras?.recentFeedback ?? [],
    }),
  });
  if (!res.ok) throw new Error(`coach endpoint: ${res.status}`);
  const data = await res.json();
  return {
    ...data,
    generatedAt: new Date().toISOString(),
    source: "claude",
  } as CoachProgram;
}

export async function requestFeedback(
  goalText: string | null,
  program: CoachProgram | null,
  lastSession: SessionRec | null,
  summary: SingerSummary,
  recentFeedback: string[] = [],
): Promise<CoachFeedback> {
  const res = await fetch(COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "feedback",
      goal: goalText,
      program: program?.source === "claude" ? program : null,
      currentWeek:
        program && program.source === "claude" ? currentProgramWeek(program) : null,
      recentFeedback,
      lastSession,
      summary,
    }),
  });
  if (!res.ok) throw new Error(`coach endpoint: ${res.status}`);
  const data = await res.json();
  return { text: data.text, date: new Date().toISOString(), source: "claude" };
}

// ---------------------------------------------------------------------------
// Song style targets — the coach annotates a song with per-phrase production
// targets from its knowledge of the song; results grade your measured timbre
// against them.
// ---------------------------------------------------------------------------

export type PhraseStyleTarget = {
  weight: "full" | "light" | "falsetto" | "mixed";
  color: "dark" | "neutral" | "bright" | "any";
  notes: string;
};

export type SongStyle = {
  overall: string;
  phrases: PhraseStyleTarget[];
  generatedAt: string;
};

export function timbreMatches(t: TimbreClass, target: PhraseStyleTarget): boolean {
  const weightOk = target.weight === "mixed" || t.weight === target.weight;
  const colorOk = target.color === "any" || t.color === target.color;
  return weightOk && colorOk;
}

export async function requestSongStyle(song: Song): Promise<SongStyle> {
  const phrases = song.phrases.map((p) => ({
    lyric: p.lyric,
    noteCount: p.notes.length,
    low: Math.min(...p.notes.map((n) => n.degree)),
    high: Math.max(...p.notes.map((n) => n.degree)),
  }));
  const res = await fetch(COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "style",
      songTitle: song.title,
      attribution: song.attribution,
      phrases,
    }),
  });
  if (!res.ok) throw new Error(`coach endpoint: ${res.status}`);
  const data = (await res.json()) as { overall: string; phrases: PhraseStyleTarget[] };
  // normalize to exactly one target per phrase
  const fallback: PhraseStyleTarget = { weight: "mixed", color: "any", notes: "" };
  const targets = song.phrases.map((_, i) => data.phrases?.[i] ?? fallback);
  return {
    overall: data.overall ?? "",
    phrases: targets,
    generatedAt: new Date().toISOString(),
  };
}

export type ClipStyle = {
  overall: string;
  target: PhraseStyleTarget;
  generatedAt: string;
};

/**
 * Style target for a ~30s preview clip of a real recording. Reuses the
 * existing "style" backend mode with one pseudo-phrase describing the clip,
 * so the deployed coach function works unchanged.
 */
export async function requestClipStyle(
  trackName: string,
  artistName: string,
): Promise<ClipStyle> {
  const res = await fetch(COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "style",
      songTitle: trackName,
      attribution: artistName,
      phrases: [
        {
          lyric:
            "the ~30-second official store preview excerpt (typically the hook/chorus) — give ONE overall production target for singing along with this artist's recorded vocal",
          noteCount: 0,
          low: 0,
          high: 0,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`coach endpoint: ${res.status}`);
  const data = (await res.json()) as {
    overall: string;
    phrases: PhraseStyleTarget[];
  };
  return {
    overall: data.overall ?? "",
    target: data.phrases?.[0] ?? { weight: "mixed", color: "any", notes: "" },
    generatedAt: new Date().toISOString(),
  };
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

export async function requestChat(
  ctx: {
    goal: string | null;
    program: CoachProgram | null;
    summary: SingerSummary;
    lastSession: SessionRec | null;
  },
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "chat",
      goal: ctx.goal,
      program: ctx.program?.source === "claude" ? ctx.program : null,
      currentWeek:
        ctx.program && ctx.program.source === "claude"
          ? currentProgramWeek(ctx.program)
          : null,
      summary: ctx.summary,
      lastSession: ctx.lastSession,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`coach endpoint: ${res.status}`);
  const data = await res.json();
  return data.text as string;
}
