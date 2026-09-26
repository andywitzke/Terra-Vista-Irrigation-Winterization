const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

const config = {
  port: Number(env.PORT) || 3000,
  // On Railway, fall back to the service's public domain and attached volume.
  baseUrl: (
    env.BASE_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${Number(env.PORT) || 3000}`)
  ).replace(/\/$/, ''),
  dbPath:
    env.DB_PATH ||
    (env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'winterization.db')
      : path.join(__dirname, '..', 'data', 'winterization.db')),
  onRailwayWithoutVolume: Boolean(env.RAILWAY_ENVIRONMENT && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.DB_PATH),
  timeZone: env.TZ_NAME || 'America/Chicago',
  neighborhoodName: env.NEIGHBORHOOD_NAME || 'Terra Vista',
  // Appended to addresses before geocoding so "123 Main St" resolves inside the neighborhood.
  addressSuffix: env.ADDRESS_SUFFIX || '',
  defaultCapacity: Number(env.DEFAULT_DAY_CAPACITY) || 25,

  adminPassword: (env.ADMIN_PASSWORD || '').trim() || 'admin',
  techPassword: (env.TECH_PASSWORD || '').trim() || 'tech',
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionSecretIsRandom: !env.SESSION_SECRET,

  googleMapsBrowserKey: env.GOOGLE_MAPS_API_KEY || '',
  googleMapsServerKey: env.GOOGLE_MAPS_SERVER_KEY || env.GOOGLE_MAPS_API_KEY || '',
  googleMapsMapId: env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID',

  twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: env.TWILIO_FROM_NUMBER || '',
  twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || '',
};

config.smsEnabled = Boolean(
  config.twilioAccountSid && config.twilioAuthToken && (config.twilioFrom || config.twilioMessagingServiceSid)
);

module.exports = config;
