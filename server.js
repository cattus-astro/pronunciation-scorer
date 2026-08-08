require('dotenv').config();

const https = require('https');
const path = require('path');
const express = require('express');
const multer = require('multer');
const usage = require('./usage');

const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, PORT = 3000 } = process.env;

if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
  console.error('Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Empirically, Tatoeba's has_audio+eng pool behaves as two different
// populations depending on sort mode: sort=random skews short (~10-50
// chars), while sort=words reversed reliably surfaces long, multi-clause
// sentences (~80-540 chars). Length targets below are calibrated to the
// frontend textarea's rendered width (~540px at 16px font, ~60 chars/line):
// easy = 1 line, medium = 1-2 lines, hard = over 2 lines.
const HARD_PAGE_RANGE = [2, 20]; // skip page 1 — its ~500-char outliers are too long to read aloud
const LENGTH_RANGES = {
  easy: [0, 60],
  medium: [60, 120],
};
const HARD_MIN_LENGTH = 120;

const TATOEBA_FETCH_TIMEOUT_MS = 6000;

// Node's global fetch() (undici) takes ~9s to reach tatoeba.org in
// practice — a reproducible slow path specific to that client, since curl
// and Node's classic https module both connect in well under a second.
// Using https directly avoids paying that undici tax on every request.
function tatoebaGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: TATOEBA_FETCH_TIMEOUT_MS,
      // Tatoeba's server rejects requests with no User-Agent (500) — Node's
      // https module, unlike curl, sends none by default.
      headers: { 'User-Agent': 'pronunciation-scorer/1.0', Accept: '*/*' },
    };
    const req = https.get(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tatoeba request timed out')));
    req.on('error', reject);
  });
}

async function fetchTatoebaCandidatesRaw(params) {
  const res = await tatoebaGet(`https://tatoeba.org/en/api_v0/search?${params}`);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Tatoeba status ${res.statusCode}`);
  }
  const data = JSON.parse(res.body.toString('utf8'));
  return (data.results || []).filter((r) => r.lang === 'eng' && r.audios && r.audios.length > 0);
}

// Tatoeba appears to throttle by request frequency, not just concurrency —
// hitting it back-to-back (e.g. several pool refills in quick succession)
// made individual requests balloon to 10-30s. Serializing every call through
// one queue with a minimum gap, regardless of which difficulty triggered it,
// keeps each request at its normal ~0.5-2s instead of compounding.
const TATOEBA_MIN_INTERVAL_MS = 700;
let tatoebaQueue = Promise.resolve();
let lastTatoebaCallAt = 0;

function fetchTatoebaCandidates(params) {
  const run = async () => {
    const wait = Math.max(0, TATOEBA_MIN_INTERVAL_MS - (Date.now() - lastTatoebaCallAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastTatoebaCallAt = Date.now();
    return fetchTatoebaCandidatesRaw(params);
  };
  const result = tatoebaQueue.then(run, run);
  tatoebaQueue = result.catch(() => {}); // keep the chain alive even if this call fails
  return result;
}

function paramsForDifficulty(difficulty) {
  if (difficulty === 'hard') {
    const [min, max] = HARD_PAGE_RANGE;
    const params = new URLSearchParams({ from: 'eng', has_audio: 'yes', sort: 'words', sort_reverse: 'yes' });
    params.set('page', String(Math.floor(Math.random() * (max - min + 1)) + min));
    return params;
  }
  return new URLSearchParams({ from: 'eng', has_audio: 'yes', sort: 'random' });
}

function matchesDifficulty(difficulty, text) {
  if (difficulty === 'hard') return text.length > HARD_MIN_LENGTH;
  const [minLen, maxLen] = LENGTH_RANGES[difficulty];
  return text.length >= minLen && text.length <= maxLen;
}

// Tatoeba takes ~0.5-2s per request, and hitting it concurrently makes it
// *slower* (their server appears to throttle concurrent connections per
// client). So instead of retrying per-request, each difficulty keeps a
// small background-replenished pool — most requests are served instantly
// from it, and only a cache-miss (e.g. right after server start) pays the
// Tatoeba round trip.
const POOL_LOW_WATERMARK = 8; // a bigger buffer means real usage rarely needs a live refill
const TAKE_SENTENCE_DEADLINE_MS = 8000; // hard ceiling — always respond, even with an error, rather than hang
const FALLBACK_POOL_MAX = 20;
const pools = { easy: [], medium: [], hard: [] };
// Any real, audio-backed sentence that just didn't match the length target —
// kept as a last resort so a few unlucky pages in a row (which does happen;
// a page of 10 sometimes has zero medium-range matches) return a slightly
// off-length sentence instead of an outright error.
const fallbackPools = { easy: [], medium: [], hard: [] };
const refillPromises = { easy: null, medium: null, hard: null };

function addMatchesToPool(difficulty, batch) {
  const seen = new Set(pools[difficulty].map((c) => c.id));
  const fallbackSeen = new Set(fallbackPools[difficulty].map((c) => c.id));
  for (const c of batch) {
    if (matchesDifficulty(difficulty, c.text)) {
      if (!seen.has(c.id)) {
        pools[difficulty].push(c);
        seen.add(c.id);
      }
    } else if (!fallbackSeen.has(c.id) && fallbackPools[difficulty].length < FALLBACK_POOL_MAX) {
      fallbackPools[difficulty].push(c);
      fallbackSeen.add(c.id);
    }
  }
}

// Concurrent callers must join the SAME in-flight fetch rather than each
// firing their own (or, worse, silently no-op'ing because one is already
// running) — tracking the promise itself, not a boolean, is what makes
// `await ensureRefill(...)` actually wait for real completion.
function ensureRefill(difficulty) {
  if (!refillPromises[difficulty]) {
    refillPromises[difficulty] = fetchTatoebaCandidates(paramsForDifficulty(difficulty))
      .then((batch) => addMatchesToPool(difficulty, batch))
      .catch((err) => console.error(`Pool refill failed for ${difficulty}:`, err))
      .finally(() => {
        refillPromises[difficulty] = null;
      });
  }
  return refillPromises[difficulty];
}

async function takeSentence(difficulty) {
  if (pools[difficulty].length < POOL_LOW_WATERMARK) {
    ensureRefill(difficulty); // fire-and-forget top-up
  }
  const deadline = Date.now() + TAKE_SENTENCE_DEADLINE_MS;
  while (!pools[difficulty].length && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Promise.race([
      ensureRefill(difficulty).catch(() => {}), // already logs; keep looping until deadline
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
  if (pools[difficulty].length) {
    const idx = Math.floor(Math.random() * pools[difficulty].length);
    return pools[difficulty].splice(idx, 1)[0];
  }
  if (fallbackPools[difficulty].length) {
    const idx = Math.floor(Math.random() * fallbackPools[difficulty].length);
    return fallbackPools[difficulty].splice(idx, 1)[0];
  }
  return null;
}

['easy', 'medium', 'hard'].forEach((d) => ensureRefill(d)); // pre-warm at startup

app.get('/api/random-sentence', async (req, res) => {
  const difficulty = ['easy', 'hard'].includes(req.query.difficulty) ? req.query.difficulty : 'medium';

  try {
    const pick = await takeSentence(difficulty);
    if (!pick) {
      return res.status(502).json({ error: 'No sentences with audio found, try again' });
    }
    const audio = pick.audios[0];
    res.json({
      text: pick.text,
      audioUrl: `/api/audio/${audio.id}`,
      author: audio.author || null,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to fetch a sentence', detail: String(err) });
  }
});

// Tatoeba's audio endpoint sends no CORS headers, so the browser can't
// fetch()+cache it directly — proxy it same-origin so the frontend can.
app.get('/api/audio/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid audio id' });
  }

  try {
    const audioRes = await tatoebaGet(`https://tatoeba.org/en/audio/download/${req.params.id}`);
    if (audioRes.statusCode < 200 || audioRes.statusCode >= 300) {
      return res.status(audioRes.statusCode).end();
    }
    res.set('Content-Type', audioRes.headers['content-type'] || 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audioRes.body);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to fetch audio' });
  }
});

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

app.post('/api/speak', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='en-US-JennyNeural'>${escapeXml(text)}</voice></speak>`;
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  try {
    const azureRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    });

    if (!azureRes.ok) {
      const detail = await azureRes.text();
      return res.status(azureRes.status).json({ error: `Azure TTS error (${azureRes.status})`, detail });
    }

    const audioBuffer = Buffer.from(await azureRes.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to reach Azure Speech service', detail: String(err) });
  }
});

app.post('/api/assess', upload.single('audio'), async (req, res) => {
  const referenceText = (req.body.referenceText || '').trim();
  if (!referenceText) {
    return res.status(400).json({ error: 'referenceText is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'audio file is required' });
  }
  if (!usage.hasQuota()) {
    const status = usage.getStatus();
    return res.status(429).json({ error: 'Monthly free-tier quota reached. Resets on the 1st.', usage: status });
  }

  const pronunciationConfig = Buffer.from(
    JSON.stringify({
      ReferenceText: referenceText,
      GradingSystem: 'HundredMark',
      Granularity: 'Phoneme',
      Dimension: 'Comprehensive',
      EnableMiscue: true,
      EnableProsodyAssessment: true,
    })
  ).toString('base64');

  const url = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

  try {
    const azureRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
        'Pronunciation-Assessment': pronunciationConfig,
      },
      body: req.file.buffer,
    });

    if (!azureRes.ok) {
      const text = await azureRes.text();
      return res.status(azureRes.status).json({ error: `Azure Speech error (${azureRes.status})`, detail: text });
    }

    const result = await azureRes.json();

    const durationSeconds = typeof result.Duration === 'number' ? result.Duration / 1e7 : 0;
    const usageStatus = usage.recordUsage(durationSeconds);

    res.json({ result, usage: usageStatus });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to reach Azure Speech service', detail: String(err) });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pronunciation scorer running at http://localhost:${PORT}`);
  });
}

module.exports = app;
