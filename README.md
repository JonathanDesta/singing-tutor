# Singing Tutor

A web app that aims to replace (most of) a human singing tutor: real-time pitch
feedback now, structured exercises and an AI coach next.

## Roadmap

- **Phase 1 (this)** — real-time pitch engine: mic capture, pitch detection
  (pitchy / McLeod pitch method), live trace against a target note.
- **Phase 2** — exercise library (sustained notes, sirens, scales, intervals),
  scoring, vocal range detection, on-device progress history.
- **Phase 3** — AI coach: post-session metrics sent to the Claude API via a
  serverless function; personalized feedback and lesson plans.
- **Phase 4** — advanced analysis: vibrato, breathiness (HNR), onset quality,
  vowel/formant tracking.
- **Phase 5** — song mode, PWA install, optional public launch.

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
