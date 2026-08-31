import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { candidates } from './geocode.js';

/**
 * Venue aliases: meeting locations the geocoder cannot resolve, pinned to
 * coordinates by hand. Outlook locations are frequently a bare venue name;
 * when neither the calendar event nor Nominatim knows where that is, every
 * drive to that meeting goes unmatched. One line here fixes the venue forever.
 */

/** Validate venue definitions. Throws with the offending entry named. */
export function parseVenues(json, source = 'venues file') {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${source} must contain a JSON array of venues`);
  const seen = new Set();
  return raw.map((v, i) => {
    const where = `${source} entry ${i + 1}`;
    if (!v || typeof v.name !== 'string' || !v.name.trim()) {
      throw new Error(`${where} needs a "name"`);
    }
    const lat = Number(v.lat);
    const lon = Number(v.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error(`${where} ("${v.name}") needs a valid "lat"`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error(`${where} ("${v.name}") needs a valid "lon"`);
    }
    const key = v.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`${where} lists "${v.name.trim()}" more than once`);
    seen.add(key);
    return { name: v.name.trim(), lat, lon };
  });
}

/** Load venue aliases from VENUES_FILE (default venues.json). No file means no aliases. */
export function loadVenues(file = config.venuesFile) {
  if (!file || !existsSync(file)) return [];
  return parseVenues(readFileSync(file, 'utf8'), file);
}

/**
 * Coordinates for a location whose name matches an alias, case-insensitively.
 * The "Venue Name (street address)" form matches on the venue-name part too.
 */
export function resolveVenue(location, venues) {
  for (const candidate of candidates(location)) {
    const hit = venues.find((v) => v.name.toLowerCase() === candidate.toLowerCase());
    if (hit) return { lat: hit.lat, lon: hit.lon };
  }
  return null;
}
