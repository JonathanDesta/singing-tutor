import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_ORIGINS = [
  "https://jonathandesta.github.io",
  "http://localhost:5173",
];

const SYSTEM = `You are an expert vocal coach embedded in a singing practice app. The app measures the singer objectively: real-time pitch detection gives per-note accuracy in cents, voicing consistency, detected vocal range, and score history per exercise. You receive that data as JSON and never hear the singer directly.

Principles, in priority order:

1. RADICAL HONESTY ABOUT FEASIBILITY. When given a goal, classify it: "realistic" (achievable with consistent practice on a normal timeline), "stretch" (possible but demands more time or dedication than the singer may expect — say how much), or "unrealistic" (physiologically impossible or wildly out of proportion to any feasible timeline). Physiology is real: vocal fold anatomy fixes voice type; usable range extends gradually (a few semitones over months, not octaves over weeks); adult voices don't become different voice types. If a goal is unrealistic, say so plainly in feasibilityNotes, explain why, and propose the nearest genuinely achievable alternative. Never soften an honest "no" into a vague "maybe". Flattery that wastes months of a student's practice is a betrayal of the coaching role.

2. EVIDENCE-BASED PEDAGOGY. Ground programs in accepted vocal pedagogy: breath management before agility, semi-occluded warmups (lip trills, humming) before open vowels, short frequent practice over long rare sessions, gradual semitone-by-semitone range work, rest as part of training. No gimmicks, no "hack your voice" shortcuts.

3. SAFETY. Pain, hoarseness, or a scratchy feeling means stop for the day — always include this. The app cannot see posture, jaw, or larynx; for technique-heavy or ambitious goals, recommend an occasional check-in with a human teacher, and say what the app cannot verify.

4. TAILOR TO THE DATA. Reference the singer's actual numbers (range, per-exercise scores and trends, flat/sharp bias). A program for someone scoring 95 on scales looks different from one for someone scoring 60. If the data is thin, say what to measure first.

The app's built-in scored exercises are: sustained note, five-note scale, intervals (do-mi-so), octave arpeggio, siren glides — all auto-transposed to the singer's range. There is also a song mode (public-domain melodies sung phrase by phrase, scored identically; those sessions are named like "Amazing Grace · phrase 2") — use it in programs for applying technique musically. Programs may also use standard unaccompanied drills (lip trills, humming, sirens on "ng", messa di voce). Assume 10-20 minutes of practice per day unless the goal demands otherwise.

Session segments may carry an "analysis" object with deeper measurements:
- vibrato: {rateHz, extentCents, label} on sustained notes. "steady" = clean straight tone (fine); "healthy vibrato" = 4.3-7.5Hz; "slow wobble"/"fast tremolo"/"wide vibrato"/"unsteady pitch" indicate technique issues worth addressing.
- tone: {hnrDb, label} — a harmonics-to-noise proxy. "clear" (≥18dB), "slightly breathy" (12-18dB), "breathy" (<12dB). Persistent breathiness suggests incomplete fold closure or excess airflow; note that mic quality and room noise push this down, so weight trends over absolutes.
- onset: {ms, label} — attack quality per note. "clean" (locks within 140ms), "scooped" (approached from below), "slid down" (from above), "never settled". Habitual scooping is a common correctable fault.
- vowel: {guess, f1, f2} — EXPERIMENTAL LPC formant estimate. Treat as a weak hint, never a firm diagnosis.
- timbre: {weight, color, centroidHz, tiltDb, ringDb, h1h2Db} — spectral production style. weight: "full" (rich chesty/belted production), "light" (lean, heady mix), "falsetto" (flute-like, fundamental-dominant). color: "dark"/"neutral"/"bright" from spectral centroid. Reference points: a dark rich belt (Bruno Mars in Grenade) ≈ full·dark; a punchy funky belt (Uptown Funk) ≈ full·bright; a light lean pop voice (Michael Jackson in Billie Jean) ≈ light·neutral or light·bright; pure falsetto ≈ falsetto·dark. ringDb near or above -10 suggests the "singer's formant" carry of a trained voice. Use these to coach stylistic goals ("sing it darker/fuller", "flip to falsetto here") and to check whether the singer's production matches what their goal song demands. Mic/EQ shifts absolutes, so trust changes and comparisons more than single readings.
Use these in feedback when present (older sessions lack them). Vocal-fold physiology caveats apply: you hear measurements, not the body producing them.`;

const PROGRAM_SCHEMA = {
  type: "object",
  properties: {
    feasibility: {
      type: "string",
      enum: ["realistic", "stretch", "unrealistic"],
    },
    feasibilityNotes: {
      type: "string",
      description:
        "Honest assessment of the goal's achievability, with reasoning and timeline. If unrealistic, the nearest achievable alternative.",
    },
    programSummary: {
      type: "string",
      description: "One-paragraph overview of the program strategy.",
    },
    weeks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          week: { type: "integer" },
          focus: { type: "string" },
          drills: {
            type: "array",
            items: { type: "string" },
            description: "Concrete daily drills, with targets where possible.",
          },
        },
        required: ["week", "focus", "drills"],
        additionalProperties: false,
      },
    },
    advice: {
      type: "string",
      description: "Standing advice: practice habits, safety, when to re-assess.",
    },
    customDrills: {
      type: "array",
      description:
        "2-4 NEW scoreable drills you compose for this singer's specific weaknesses. The app plays them and scores the sing-back exactly like built-in exercises. Segment degrees are semitones above the drill's lowest note (0-24); ms is duration (300-8000). Use 'note' segments for pitches and 'glide' segments for sirens/slides. Name them memorably and say in the description what fault each targets.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          segments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["note", "glide"] },
                degree: { type: "integer" },
                from: { type: "integer" },
                to: { type: "integer" },
                ms: { type: "integer" },
              },
              required: ["kind", "ms"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "description", "segments"],
        additionalProperties: false,
      },
    },
    songSuggestions: {
      type: "array",
      description:
        "3-5 real, findable songs the singer should import as MIDI files to work toward their goal — matched to their current level and range, ordered easiest first. 'why' explains what each song trains.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          artist: { type: "string" },
          why: { type: "string" },
        },
        required: ["title", "artist", "why"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "feasibility",
    "feasibilityNotes",
    "programSummary",
    "weeks",
    "advice",
    "customDrills",
    "songSuggestions",
  ],
  additionalProperties: false,
} as const;

function corsOrigin(req: VercelRequest): string | null {
  const origin = req.headers.origin;
  if (!origin) return null; // same-origin / non-browser
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // allow the Vercel deployment's own origin (production + previews)
  if (origin === `https://${req.headers.host}`) return origin;
  return "deny";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = corsOrigin(req);
  if (origin === "deny") {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
    return;
  }

  const client = new Anthropic();
  const {
    mode,
    goal,
    summary,
    lastSession,
    program,
    previousProgram,
    currentWeek,
    recentFeedback,
    messages,
  } = req.body ?? {};

  const continuity =
    (currentWeek ? `The singer is in week ${currentWeek} of their current program.\n\n` : "") +
    (recentFeedback?.length
      ? `Your recent coaching notes to this singer (oldest first):\n${JSON.stringify(recentFeedback)}\n\n`
      : "");

  try {
    if (mode === "plan") {
      const response = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        output_config: {
          format: { type: "json_schema", schema: PROGRAM_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content:
              `The singer's goal, in their own words:\n"${goal}"\n\n` +
              `Measured data from the app:\n${JSON.stringify(summary, null, 2)}\n\n` +
              continuity +
              (previousProgram
                ? `Their current program (being revised):\n${JSON.stringify(previousProgram)}\n\n` +
                  `Treat this as a REVISION: keep what the data says is working, change what isn't, and note what changed and why in programSummary.\n\n`
                : "") +
              `Assess feasibility honestly per your principles, then design the program. ` +
              `Choose the program length (number of weeks) that genuinely fits the goal. ` +
              `Compose customDrills that target this singer's specific measured weaknesses, ` +
              `and suggest real songs to import that build toward the goal.`,
          },
        ],
      });
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("empty response");
      res.status(200).json(JSON.parse(text.text));
      return;
    }

    if (mode === "chat") {
      const history = (Array.isArray(messages) ? messages : [])
        .slice(-20)
        .filter(
          (m: { role?: string; content?: unknown }) =>
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.length > 0 &&
            m.content.length < 4000,
        );
      if (history.length === 0 || history[history.length - 1].role !== "user") {
        res.status(400).json({ error: "chat requires messages ending with a user turn" });
        return;
      }
      const context =
        `CONTEXT FROM THE APP (not written by the singer):\n` +
        `Goal: ${goal ?? "(none set)"}\n` +
        `Current program: ${program ? JSON.stringify(program) : "(none)"}\n` +
        (currentWeek ? `Program week: ${currentWeek}\n` : "") +
        `History summary: ${JSON.stringify(summary)}\n` +
        `Most recent session: ${lastSession ? JSON.stringify(lastSession) : "(none)"}`;
      const response = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system:
          SYSTEM +
          `\n\nYou are now in a live chat with your student. Answer their actual question — concise, concrete, honest, referencing their real data when relevant. If they ask for program changes and you agree, describe the change and tell them to press "Rebuild my program" so it takes effect; you'll then revise rather than start over. Never bluff about things the app can't measure.`,
        messages: [
          { role: "user", content: context },
          {
            role: "assistant",
            content:
              "Got it — I have your goal, program, and practice data in front of me. What's on your mind?",
          },
          ...history,
        ],
      });
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("empty response");
      res.status(200).json({ text: text.text });
      return;
    }

    if (mode === "feedback") {
      const response = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system:
          SYSTEM +
          `\n\nYou are now giving POST-SESSION feedback, not designing a program. Be concise and specific: reference the singer's actual cents numbers and segment results, name the single most important thing to fix, prescribe the exact next drill, and relate progress to their goal and current program week if provided. A few short paragraphs at most.`,
        messages: [
          {
            role: "user",
            content:
              `Goal: ${goal ?? "(none set)"}\n\n` +
              `Current program: ${program ? JSON.stringify(program) : "(none)"}\n\n` +
              continuity +
              `Most recent session (per-segment results, avgCents is signed error):\n` +
              `${JSON.stringify(lastSession, null, 2)}\n\n` +
              `Overall history summary:\n${JSON.stringify(summary, null, 2)}`,
          },
        ],
      });
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("empty response");
      res.status(200).json({ text: text.text });
      return;
    }

    res.status(400).json({ error: "unknown mode" });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "coach request failed" });
  }
}
