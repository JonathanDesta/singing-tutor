# Singing Tutor

A web app that aims to replace (most of) a human singing tutor: real-time pitch
feedback now, structured exercises and an AI coach next.

## Roadmap

- **Phase 1 (done)** — real-time pitch engine: mic capture, pitch detection
  (pitchy / McLeod pitch method), live trace against a target note.
- **Phase 2 (this)** — call-and-response exercises (sustained note, five-note
  scale, intervals, arpeggio, siren) with per-note scoring, vocal range
  detection that transposes exercises to fit the singer, and on-device
  progress history (IndexedDB).
- **Phase 3 (this)** — goal-driven AI coach: state a goal, get an honest
  feasibility verdict (realistic / stretch / unrealistic) and a tailored
  week-by-week program; post-session coaching referencing measured cents
  data. Claude Opus 4.8 via `api/coach.ts` (Vercel function); rule-based
  offline coach as fallback. Requires `ANTHROPIC_API_KEY` env var on Vercel.
- **Phase 4** — advanced analysis: vibrato, breathiness (HNR), onset quality,
  vowel/formant tracking.
- **Phase 5** — song mode, PWA install, optional public launch.

## Deployment

Two targets from the same repo:

- **GitHub Pages** (static only, no AI coach): auto-deploys on push via
  Actions to https://jonathandesta.github.io/singing-tutor/
- **Vercel** (full app + AI coach): import the repo at vercel.com/new, set
  `ANTHROPIC_API_KEY` in project environment variables. Vite base path
  switches automatically (`VERCEL` env var).

## Development

```bash
npm install
npm run dev          # dev server
npm run build        # typecheck + production build
npm run verify:pitch # feed synthetic tones through the detector, check accuracy
```

## Testing without singing

The **Test tone** input mode routes a sine oscillator through the exact same
analysis pipeline as the microphone (it is silent — analysis only). Use the
slider to sweep the tone against the target note and watch the trace/colors
respond. Microphone mode is the real product; test tone mode exists for
development and debugging.
