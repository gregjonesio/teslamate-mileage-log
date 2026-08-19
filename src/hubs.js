import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

/**
 * Transport hubs: stations and airports where a business trip continues by
 * rail or air. The car stops here, so no drive ever ends near the meeting and
 * the normal proximity match cannot see the trip at all.
 */

/** Validate hub definitions. Throws with the offending entry named. */
export function parseHubs(json, source = 'hubs file') {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${source} must contain a JSON array of hubs`);
  return raw.map((h, i) => {
    const where = `${source} entry ${i + 1}`;
    if (!h || typeof h.name !== 'string' || !h.name.trim()) {
      throw new Error(`${where} needs a "name"`);
    }
    const lat = Number(h.lat);
    const lon = Number(h.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error(`${where} ("${h.name}") needs a valid "lat"`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error(`${where} ("${h.name}") needs a valid "lon"`);
    }
    const hub = { name: h.name.trim(), lat, lon };
    if (h.radiusM !== undefined) {
      const radiusM = Number(h.radiusM);
      if (!Number.isFinite(radiusM) || radiusM <= 0) {
        throw new Error(`${where} ("${h.name}") has an invalid "radiusM"`);
      }
      hub.radiusM = radiusM;
    }
    return hub;
  });
}

/** Load hubs from HUBS_FILE (default hubs.json). No file means no hub matching. */
export function loadHubs(file = config.hubsFile) {
  if (!file || !existsSync(file)) return [];
  return parseHubs(readFileSync(file, 'utf8'), file);
}
