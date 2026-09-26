const crypto = require('node:crypto');
const config = require('./config');

const COOKIE = 'tv_session';
const MAX_AGE_S = 14 * 24 * 60 * 60;

const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Returns 'admin' | 'tech' | null for the current request. */
function sessionRole(req) {
  const value = parseCookies(req.headers.cookie)[COOKIE];
  if (!value) return null;
  const [role, exp, sig] = value.split('.');
  if (!role || !exp || !sig || !safeEqual(sig, sign(`${role}.${exp}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return role === 'admin' || role === 'tech' ? role : null;
}

function login(req, res) {
  const { role, password } = req.body || {};
  const expected = role === 'admin' ? config.adminPassword : role === 'tech' ? config.techPassword : null;
  // Admins may also use their password on the technician login.
  const ok = expected && (safeEqual(password || '', expected) || (role === 'tech' && safeEqual(password || '', config.adminPassword)));
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  const grantedRole = role === 'tech' && safeEqual(password || '', config.adminPassword) ? 'admin' : role;
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const value = `${grantedRole}.${exp}.${sign(`${grantedRole}.${exp}`)}`;
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure}`);
  res.json({ role: grantedRole });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

/** Middleware: allowed roles, e.g. requireRole('admin') or requireRole('admin', 'tech'). */
function requireRole(...roles) {
  return (req, res, next) => {
    const role = sessionRole(req);
    if (!role || !roles.includes(role)) return res.status(401).json({ error: 'Please log in' });
    req.role = role;
    next();
  };
}

module.exports = { login, logout, requireRole, sessionRole };
