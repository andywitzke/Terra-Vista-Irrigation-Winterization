const config = require('./config');

/**
 * Geocode an address with the Google Geocoding API.
 * Returns {lat, lng, formattedAddress} or null when no key is configured or nothing matched.
 */
async function geocode(address) {
  if (!config.googleMapsServerKey || !address) return null;
  const query = config.addressSuffix && !address.toLowerCase().includes(config.addressSuffix.toLowerCase())
    ? `${address}, ${config.addressSuffix}`
    : address;
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', config.googleMapsServerKey);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) {
      console.warn(`[geocode] ${data.status} for "${query}"${data.error_message ? `: ${data.error_message}` : ''}`);
      return null;
    }
    const r = data.results[0];
    return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formattedAddress: r.formatted_address };
  } catch (err) {
    console.warn(`[geocode] request failed for "${query}": ${err.message}`);
    return null;
  }
}

module.exports = { geocode };
