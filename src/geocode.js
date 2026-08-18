import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, dataDir } from './config.js';

const cachePath = path.join(dataDir, 'geocode-cache.json');

/**
 * Outlook locations are often "Venue Name (street address)" or "Venue - address".
 * Produce lookup candidates from most to least specific; the parenthesized
 * street address geocodes far more reliably than the combined string.
 */
export function candidates(location) {
  const out = [location.trim()];
  const paren = location.match(/\(([^)]+)\)\s*$/);
  if (paren) {
    out.push(paren[1].trim());
    out.push(location.replace(/\([^)]*\)\s*$/, '').trim());
  }
  return [...new Set(out)].filter(Boolean);
}

/** Try each candidate form of the location until one geocodes. */
export async function geocodeLocation(location) {
  for (const candidate of candidates(location)) {
    const result = await geocode(candidate);
    if (result) return result;
  }
  return null;
}
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

let lastRequest = 0;

/**
 * Geocode a free-text address via Nominatim (OpenStreetMap).
 * Results are cached on disk; requests are throttled to 1/sec per their usage policy.
 * Returns { lat, lon } or null if the address cannot be resolved.
 */
export async function geocode(address) {
  const key = address.trim().toLowerCase();
  if (key in cache) return cache[key];

  const wait = 1100 - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': `teslamate-mileage-log/0.1 (${config.nominatimEmail || 'no-email-configured'})`,
    },
  });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  const results = await res.json();
  const value = results.length
    ? { lat: Number(results[0].lat), lon: Number(results[0].lon) }
    : null;
  cache[key] = value;
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return value;
}
