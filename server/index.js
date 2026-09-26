const config = require('./config');
const app = require('./app');

app.listen(config.port, () => {
  console.log(`${config.neighborhoodName} winterization running at ${config.baseUrl}`);
  if (config.adminPassword === 'admin' || config.techPassword === 'tech') {
    console.warn('WARNING: using default passwords. Set ADMIN_PASSWORD and TECH_PASSWORD.');
  }
  if (config.sessionSecretIsRandom) console.warn('NOTE: SESSION_SECRET not set; staff logins reset when the server restarts.');
  if (!config.smsEnabled) console.warn('NOTE: Twilio not configured; text messages are logged, not sent.');
  if (!config.googleMapsBrowserKey) console.warn('NOTE: GOOGLE_MAPS_API_KEY not set; maps and geocoding are disabled.');
});
