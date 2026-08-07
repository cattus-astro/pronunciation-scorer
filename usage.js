const fs = require('fs');
const os = require('os');
const path = require('path');

// os.tmpdir() instead of __dirname: on serverless hosts (e.g. Vercel) the
// deployed code directory is read-only, only /tmp is writable. /tmp is
// ephemeral there too, so this is best-effort, not a durable counter.
const USAGE_FILE = path.join(os.tmpdir(), 'pronunciation-scorer-usage.json');

// Azure F0 free tier: 5 hours/month of speech-to-text (shared with pronunciation
// assessment). Stop a little early so a single long recording can't push us over.
const MONTHLY_LIMIT_SECONDS = 5 * 60 * 60;
const SAFETY_MARGIN_SECONDS = 30 * 60;
const USABLE_SECONDS = MONTHLY_LIMIT_SECONDS - SAFETY_MARGIN_SECONDS;

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (raw.month === currentMonthKey()) return raw;
  } catch {
    // no file yet, or unreadable — fall through to a fresh record
  }
  return { month: currentMonthKey(), secondsUsed: 0 };
}

function save(state) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // best-effort — a write failure here shouldn't break the request it's tracking
  }
}

function getStatus() {
  const state = load();
  return {
    month: state.month,
    secondsUsed: state.secondsUsed,
    secondsLimit: USABLE_SECONDS,
    secondsRemaining: Math.max(0, USABLE_SECONDS - state.secondsUsed),
  };
}

function hasQuota(estimatedSeconds = 0) {
  const state = load();
  return state.secondsUsed + estimatedSeconds <= USABLE_SECONDS;
}

function recordUsage(seconds) {
  const state = load();
  state.secondsUsed += seconds;
  save(state);
  return getStatus();
}

module.exports = { getStatus, hasQuota, recordUsage };
