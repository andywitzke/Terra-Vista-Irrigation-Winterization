const crypto = require('node:crypto');
const config = require('./config');

/** Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null if invalid. */
function normalizePhone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15 && !digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function formatPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}

/** Today's date (YYYY-MM-DD) in the neighborhood's time zone. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

/** "Tue, Oct 14" */
function prettyDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const PREF_LABEL = { AM: 'morning', PM: 'afternoon', ANY: 'any time' };
const normalizePref = (p) => (['AM', 'PM', 'ANY'].includes(String(p).toUpperCase()) ? String(p).toUpperCase() : 'ANY');

const newToken = () => crypto.randomBytes(18).toString('base64url');
const nowIso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  normalizePhone,
  formatPhone,
  today,
  isValidDate,
  prettyDate,
  PREF_LABEL,
  normalizePref,
  newToken,
  nowIso,
  HttpError,
};
