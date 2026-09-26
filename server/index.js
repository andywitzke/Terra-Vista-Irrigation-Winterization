const config = require('./config');
const app = require('./app');

const usingDefaultPasswords = config.adminPassword === 'admin' || config.techPassword === 'tech';
if (usingDefaultPasswords && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production')) {
  const why = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined) return `${name} is not set`;
    if (!raw.trim()) return `${name} is empty`;
    return raw.trim() === fallback ? `${name} is still the default "${fallback}"` : null;
  };
  const problems = [why('ADMIN_PASSWORD', 'admin'), why('TECH_PASSWORD', 'tech')].filter(Boolean);
  // Names only, never values, to help spot typos like "ADMIN_PASSWORD " or "ADMIN_PASSWORDS".
  const lookalikes = Object.keys(process.env).filter((k) => /pass|admin|tech/i.test(k));
  console.error(`Refusing to start: ${problems.join('; ')}.`);
  console.error('Set ADMIN_PASSWORD and TECH_PASSWORD on this service (Railway: service > Variables), then deploy.');
  console.error(`Related variable names this service can see: ${lookalikes.length ? lookalikes.map((k) => JSON.stringify(k)).join(', ') : '(none)'}`);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`${config.neighborhoodName} winterization running at ${config.baseUrl}`);
  if (usingDefaultPasswords) {
    console.warn('WARNING: using default passwords. Set ADMIN_PASSWORD and TECH_PASSWORD.');
  }
  if (config.onRailwayWithoutVolume) {
    console.warn('WARNING: no Railway volume attached; sign-ups will be lost on every redeploy. Attach a volume to this service.');
  }
  if (config.sessionSecretIsRandom) console.warn('NOTE: SESSION_SECRET not set; staff logins reset when the server restarts.');
  if (!config.smsEnabled) console.warn('NOTE: Twilio not configured; text messages are logged, not sent.');
  if (!config.googleMapsBrowserKey) console.warn('NOTE: GOOGLE_MAPS_API_KEY not set; maps and geocoding are disabled.');
});
