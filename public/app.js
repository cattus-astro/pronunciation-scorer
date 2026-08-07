const randomBtn = document.getElementById('random-btn');
const difficultyEl = document.getElementById('difficulty');
const speakBtn = document.getElementById('speak-btn');
const recordBtn = document.getElementById('record-btn');
const assessBtn = document.getElementById('assess-btn');
const playback = document.getElementById('playback');
const statusEl = document.getElementById('status');
const referenceEl = document.getElementById('reference');
const resultsEl = document.getElementById('results');
const scoreGridEl = document.getElementById('score-grid');
const wordBreakdownEl = document.getElementById('word-breakdown');
const phonemeDetailEl = document.getElementById('phoneme-detail');

let mediaRecorder = null;
let chunks = [];
let recordedBlob = null;
let currentAudioUrl = null;
let currentAudioAuthor = null;

let audioGeneration = 0;
let cachedAudioBlobUrl = null;
let cachedAudioPromise = null;

let activeAudio = null;

function stopActiveAudio() {
  if (activeAudio && !activeAudio.paused) {
    activeAudio.pause();
  }
  activeAudio = null;
}

function playExclusive(audioEl) {
  stopActiveAudio();
  activeAudio = audioEl;
  audioEl.addEventListener(
    'ended',
    () => {
      if (activeAudio === audioEl) activeAudio = null;
    },
    { once: true }
  );
  return audioEl.play();
}

playback.addEventListener('play', () => {
  if (activeAudio && activeAudio !== playback) {
    activeAudio.pause();
  }
  activeAudio = playback;
});

function invalidateAudioCache() {
  audioGeneration++;
  if (cachedAudioBlobUrl) URL.revokeObjectURL(cachedAudioBlobUrl);
  cachedAudioBlobUrl = null;
  cachedAudioPromise = null;
}

function prefetchAudio(url) {
  invalidateAudioCache();
  const myGeneration = audioGeneration;
  cachedAudioPromise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      if (myGeneration !== audioGeneration) return null; // sentence changed again, discard
      cachedAudioBlobUrl = URL.createObjectURL(blob);
      return cachedAudioBlobUrl;
    })
    .catch((err) => {
      console.error('Audio prefetch failed', err);
      return null;
    });
}

referenceEl.addEventListener('input', () => {
  currentAudioUrl = null;
  currentAudioAuthor = null;
  invalidateAudioCache();
  stopActiveAudio();
});

async function loadRandomSentence() {
  stopActiveAudio();
  randomBtn.disabled = true;
  const originalLabel = randomBtn.textContent;
  randomBtn.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/random-sentence?difficulty=${difficultyEl.value}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    referenceEl.value = data.text;
    currentAudioUrl = data.audioUrl;
    currentAudioAuthor = data.author;
    prefetchAudio(data.audioUrl);
    resultsEl.style.display = 'none';
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Couldn't fetch a sentence: ${err.message}`;
  } finally {
    randomBtn.textContent = originalLabel;
    randomBtn.disabled = false;
  }
}

randomBtn.addEventListener('click', loadRandomSentence);
difficultyEl.addEventListener('change', loadRandomSentence);

speakBtn.addEventListener('click', async () => {
  const text = referenceEl.value.trim();
  if (!text) return;

  speakBtn.disabled = true;
  const originalLabel = speakBtn.textContent;
  speakBtn.textContent = 'Loading…';

  try {
    if (currentAudioUrl) {
      let blobUrl = cachedAudioBlobUrl;
      if (!blobUrl && cachedAudioPromise) {
        blobUrl = await cachedAudioPromise;
      }
      const audio = new Audio(blobUrl || currentAudioUrl);
      await playExclusive(audio);
      statusEl.textContent = currentAudioAuthor
        ? `Playing a human recording (Tatoeba, recorded by ${currentAudioAuthor}).`
        : 'Playing a human recording (Tatoeba).';
    } else {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `status ${res.status}`);
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await playExclusive(audio);
      statusEl.textContent = 'No human recording for this text — playing an AI voice instead.';
    }
  } catch (err) {
    statusEl.textContent = `Couldn't play pronunciation: ${err.message}`;
  } finally {
    speakBtn.textContent = originalLabel;
    speakBtn.disabled = false;
  }
});

recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  stopActiveAudio();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(chunks, { type: 'audio/webm' });
      playback.src = URL.createObjectURL(recordedBlob);
      playback.style.display = 'inline-block';
      assessBtn.disabled = false;
      recordBtn.textContent = '● Record';
      recordBtn.classList.remove('recording');
      stream.getTracks().forEach((t) => t.stop());
      statusEl.textContent = 'Recording captured. Ready to score.';
    };

    mediaRecorder.start();
    recordBtn.textContent = '■ Stop';
    recordBtn.classList.add('recording');
    assessBtn.disabled = true;
    resultsEl.style.display = 'none';
    statusEl.textContent = 'Recording… speak the sentence above.';
  } catch (err) {
    statusEl.textContent = `Microphone access failed: ${err.message}`;
  }
});

assessBtn.addEventListener('click', async () => {
  if (!recordedBlob) return;
  const referenceText = referenceEl.value.trim();
  if (!referenceText) {
    statusEl.textContent = 'Enter a sentence first.';
    return;
  }

  assessBtn.disabled = true;
  statusEl.textContent = 'Converting audio…';

  let wavBlob;
  try {
    wavBlob = await convertBlobToWav(recordedBlob);
  } catch (err) {
    statusEl.textContent = `Audio conversion failed: ${err.message}`;
    assessBtn.disabled = false;
    return;
  }

  statusEl.textContent = 'Scoring…';

  const form = new FormData();
  form.append('audio', wavBlob, 'recording.wav');
  form.append('referenceText', referenceText);

  try {
    const res = await fetch('/api/assess', { method: 'POST', body: form });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || 'Something went wrong.';
      return;
    }

    renderResults(data.result);
    statusEl.textContent = 'Done.';
  } catch (err) {
    statusEl.textContent = `Request failed: ${err.message}`;
  } finally {
    assessBtn.disabled = false;
  }
});

async function convertBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);

  const targetSampleRate = 16000;
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * targetSampleRate),
    targetSampleRate
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return encodeWavPCM16(rendered.getChannelData(0), targetSampleRate);
}

function encodeWavPCM16(samples, sampleRate) {
  const bytesPerSample = 2;
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function renderResults(result) {
  const nbest = result.NBest && result.NBest[0];
  if (!nbest) {
    statusEl.textContent = 'No speech recognized — try again, closer to the mic.';
    return;
  }

  const pa = nbest.PronunciationAssessment || nbest;
  scoreGridEl.innerHTML = '';
  [
    ['Overall', pa.PronScore],
    ['Accuracy', pa.AccuracyScore],
    ['Fluency', pa.FluencyScore],
    ['Completeness', pa.CompletenessScore],
    ['Prosody', pa.ProsodyScore],
  ]
    .filter(([, value]) => value != null)
    .forEach(([label, value]) => {
      const div = document.createElement('div');
      div.className = 'score-item';
      div.innerHTML = `<div class="value">${Math.round(value)}</div><div class="label">${label}</div>`;
      scoreGridEl.appendChild(div);
    });

  wordBreakdownEl.innerHTML = '';
  phonemeDetailEl.innerHTML = '';
  const words = nbest.Words || [];

  words.forEach((w, idx) => {
    const span = document.createElement('button');
    span.type = 'button';
    span.className = 'word';
    const wpa = w.PronunciationAssessment || w;
    const acc = wpa.AccuracyScore;
    const errorType = wpa.ErrorType;

    let cls = scoreClass(acc);
    if (errorType === 'Omission' || errorType === 'Insertion' || errorType === 'Mispronunciation') {
      cls = 'bad';
    }
    span.classList.add(cls);
    span.textContent = w.Word;
    span.title = `${errorType || 'None'} — accuracy ${acc != null ? Math.round(acc) : 'n/a'}`;
    span.addEventListener('click', () => {
      const block = document.getElementById(`phoneme-block-${idx}`);
      if (!block) return;
      block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      block.classList.add('flash');
      setTimeout(() => block.classList.remove('flash'), 800);
    });
    wordBreakdownEl.appendChild(span);
    wordBreakdownEl.appendChild(document.createTextNode(' '));

    phonemeDetailEl.appendChild(buildPhonemeBlock(w, idx));
  });

  phonemeDetailEl.style.display = words.length ? 'block' : 'none';
  resultsEl.style.display = 'block';
}

function scoreClass(acc) {
  if (acc == null) return 'good';
  if (acc < 75) return 'bad';
  if (acc < 90) return 'ok';
  return 'good';
}

function buildPhonemeBlock(word, idx) {
  const wpa = word.PronunciationAssessment || word;
  const phonemes = word.Phonemes || wpa.Phonemes || [];

  const block = document.createElement('div');
  block.className = 'phoneme-block';
  block.id = `phoneme-block-${idx}`;

  const label = document.createElement('span');
  label.className = 'phoneme-word-label';
  label.textContent = word.Word;
  block.appendChild(label);

  if (!phonemes.length) {
    const empty = document.createElement('span');
    empty.className = 'phoneme-empty';
    empty.textContent = 'no phoneme data';
    block.appendChild(empty);
  } else {
    phonemes.forEach((p) => {
      const ppa = p.PronunciationAssessment || p;
      const acc = ppa.AccuracyScore;
      const chip = document.createElement('span');
      chip.className = `phoneme-chip ${scoreClass(acc)}`;
      chip.textContent = `${p.Phoneme} ${acc != null ? Math.round(acc) : '–'}`;
      block.appendChild(chip);
    });
  }

  return block;
}

loadRandomSentence();
