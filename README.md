# Pronunciation Scorer

A personal web app that scores English pronunciation (accuracy, fluency,
completeness, per-word/phoneme breakdown) using Azure AI Speech's
Pronunciation Assessment API, on the free (F0) tier.

## 1. Create the Azure Speech resource

1. Go to the [Azure Portal](https://portal.azure.com) and create a resource:
   search "Speech" → "Speech services" (or "Azure AI services" → Speech).
2. Pricing tier: **Free F0** (5 hours of speech-to-text/month, includes
   pronunciation assessment).
3. Once created, open the resource → "Keys and Endpoint" and copy:
   - `KEY 1`
   - `Location/Region` (e.g. `eastus`)

## 2. Configure the app

```bash
cd pronunciation-scorer
cp .env.example .env
# edit .env and paste in AZURE_SPEECH_KEY and AZURE_SPEECH_REGION
npm install
```

## 3. Run it

```bash
npm start
```

Open http://localhost:3000, allow microphone access, read the sentence
aloud, and press "Score my pronunciation".

Use the Easy / Medium / Hard dropdown to control sentence complexity —
Hard pulls longer, multi-clause sentences from Tatoeba; Easy sticks to
short, simple ones.

A random practice sentence loads automatically, sourced from
[Tatoeba](https://tatoeba.org) — a crowd-sourced sentence database where
many English sentences have real human-recorded audio. Press "🎲 Random
sentence" for another, or "🔊 Listen" to hear the actual human recording
before you record yourself. After scoring, click any word to jump to its
phoneme-level breakdown.

If you edit the sentence yourself (no matching human recording exists),
"🔊 Listen" falls back to Azure's text-to-speech (an AI voice) instead —
the status line tells you which one played. TTS draws from a separate
free-tier quota (0.5M characters/month on F0) — not tracked by
`usage.js`, which only guards the speech-to-text/pronunciation-assessment
quota.

## How the free-tier guardrail works

- `usage.js` keeps a running total of audio seconds sent to Azure in
  `usage.json` (git-ignored, resets automatically each calendar month).
- The server refuses new `/api/assess` requests once you're within 30
  minutes of the 5-hour/month F0 cap, so you get a clear in-app message
  instead of a raw Azure 403. There's no progress-bar UI for this anymore
  (see below) — it's a silent backend check.
- Even without this guardrail, Azure's F0 tier cannot bill you for
  overage — it just returns errors until the quota resets on the 1st.
- This only works reliably when `usage.json` lives on a persistent disk
  (i.e. running locally, or on a host like Render/Railway). On serverless
  hosts (see Vercel below) the counter resets unpredictably between
  requests, so the guardrail there is unreliable — Azure's own hard cap is
  still the real backstop.

## Deploying to Vercel

The app runs as a single Express app wrapped in one serverless function
(`api/index.js`), with `vercel.json` routing all traffic — both the static
frontend and `/api/*` — through it, the same way `server.js` does locally.

1. Push this repo to GitHub (see the note below about `.env`).
2. In the [Vercel dashboard](https://vercel.com), "Add New… → Project" and
   import the repo.
3. In the project's Settings → Environment Variables, add `AZURE_SPEECH_KEY`
   and `AZURE_SPEECH_REGION` (the same values from your local `.env` — never
   commit `.env` itself).
4. Deploy. No build command or output directory needed — it's zero-config.

**Known limitation**: the usage-quota guardrail is best-effort on Vercel
(see above) since its `/tmp` storage doesn't persist reliably across
invocations. In practice this means the app won't proactively warn you
before hitting Azure's free-tier cap the way it does locally — Azure will
just start returning errors once you're over, which the app already
surfaces as an in-app error message rather than crashing.

## Notes

- Requires Node.js 18+ (uses the built-in `fetch`).
- Recording uses the browser's `MediaRecorder` (Chrome/Edge/Firefox), then
  the browser converts it to 16kHz mono PCM WAV before upload — Azure's
  REST API is unreliable with WebM/Opus for pronunciation assessment.
- This is built for solo/local use. If you ever deploy it somewhere
  public, put auth in front of it — the usage guardrail assumes a single
  user.
