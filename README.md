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
- **Phase 4 (this)** — advanced analysis on every exercise: vibrato
  (rate/extent/character, with scoring that credits healthy centered
  vibrato), tone clarity (HNR proxy from detection clarity), onset quality
  (clean vs scooped/slid), and experimental LPC formant/vowel estimation.
  Results show analysis chips; everything is stored with sessions and fed
  to the AI coach. `npm run verify:analysis` runs the synthetic test suite.
- **Phase 5 (this)** — song mode: public-domain melodies (Twinkle Twinkle,
  Happy Birthday, Amazing Grace, Ode to Joy) practiced phrase by phrase
  with per-syllable scoring and the full analysis pipeline, transposed to
  the singer's range. Installable PWA: manifest, icons, service worker
  (offline app shell via vite-plugin-pwa).

## Cloud sync (Firebase)

Data is offline-first in IndexedDB; signing in with Google mirrors it to
Firestore so it survives device switches and browser-storage eviction.
Sessions are unioned across devices; settings prefer the active device.

One-time setup:

1. console.firebase.google.com → Add project (disable Analytics, not needed)
2. Build → Authentication → Get started → Sign-in method → enable **Google**
3. Build → Firestore Database → Create (production mode) → Rules tab →
   paste the contents of `firestore.rules` → Publish
4. Project settings → Your apps → Add web app → copy the `firebaseConfig`
   values into `src/lib/firebase-config.ts` (they are public identifiers,
   safe to commit)
5. Authentication → Settings → Authorized domains → add the Vercel domain
   and `jonathandesta.github.io`

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
