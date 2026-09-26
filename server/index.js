const config = require('./config');
const app = require('./app');

const usingDefaultPasswords = config.adminPassword === 'admin' || config.techPassword === 'tech';
if (usingDefaultPasswords && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production')) {
  console.error('Refusing to start: set ADMIN_PASSWORD and TECH_PASSWORD (the defaults "admin"/"tech" are not allowed in production).');
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
