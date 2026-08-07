require('dotenv').config();

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

app.use(express.static('public'));
app.use(express.json());

app.get('/api/usage', (req, res) => {
  res.json(usage.getStatus());
});

// Empirically, Tatoeba's has_audio+eng pool behaves as two different
// populations depending on sort mode: sort=random skews short (~10-50
// chars, good for easy/medium), while sort=words reversed reliably
// surfaces long, multi-clause sentences (~80-540 chars, good for hard).
const HARD_PAGE_RANGE = [2, 20]; // skip page 1 — its ~500-char outliers are too long to read aloud
const EASY_MAX_LENGTH = 35;

app.get('/api/random-sentence', async (req, res) => {
  const difficulty = ['easy', 'hard'].includes(req.query.difficulty) ? req.query.difficulty : 'medium';

  const params = new URLSearchParams({ from: 'eng', has_audio: 'yes' });
  if (difficulty === 'hard') {
    const [min, max] = HARD_PAGE_RANGE;
    params.set('sort', 'words');
    params.set('sort_reverse', 'yes');
    params.set('page', String(Math.floor(Math.random() * (max - min + 1)) + min));
  } else {
    params.set('sort', 'random');
  }

  try {
    const tatoebaRes = await fetch(`https://tatoeba.org/en/api_v0/search?${params}`);
    if (!tatoebaRes.ok) {
      throw new Error(`Tatoeba status ${tatoebaRes.status}`);
    }
    const data = await tatoebaRes.json();
    let candidates = (data.results || []).filter((r) => r.lang === 'eng' && r.audios && r.audios.length > 0);
    if (!candidates.length) {
      return res.status(502).json({ error: 'No sentences with audio found, try again' });
    }
    if (difficulty === 'easy') {
      const shortOnes = candidates.filter((c) => c.text.length <= EASY_MAX_LENGTH);
      if (shortOnes.length) candidates = shortOnes;
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
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
    const audioRes = await fetch(`https://tatoeba.org/en/audio/download/${req.params.id}`);
    if (!audioRes.ok) {
      return res.status(audioRes.status).end();
    }
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    res.set('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
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
