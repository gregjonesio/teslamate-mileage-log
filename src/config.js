import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

export const config = {
  teslamateDbUrl: process.env.TESLAMATE_DB_URL,
  graphClientId: process.env.GRAPH_CLIENT_ID,
  graphTenantId: process.env.GRAPH_TENANT_ID || 'common',
  matchRadiusM: num('MATCH_RADIUS_M', 500),
  arriveEarlyMin: num('ARRIVE_EARLY_MIN', 120),
  arriveLateMin: num('ARRIVE_LATE_MIN', 20),
  includeReturn: (process.env.INCLUDE_RETURN ?? 'true') !== 'false',
  repositionMaxMiles: num('REPOSITION_MAX_MILES', 1),
  errandMaxMiles: num('ERRAND_MAX_MILES', 3),
  errandMaxGapMin: num('ERRAND_MAX_GAP_MIN', 60),
  hubsFile: process.env.HUBS_FILE || path.join(root, 'hubs.json'),
  venuesFile: process.env.VENUES_FILE || path.join(root, 'venues.json'),
  hubRadiusM: num('HUB_RADIUS_M', 750),
  hubDepartEarlyMin: num('HUB_DEPART_EARLY_MIN', 480),
  hubReturnMaxHours: num('HUB_RETURN_MAX_HOURS', 12),
  mileageRate: num('MILEAGE_RATE', 0.7),
  nominatimEmail: process.env.NOMINATIM_EMAIL || '',
};

export function requireConfig(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`
    );
  }
}
