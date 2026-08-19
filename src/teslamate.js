import { newClient } from './db.js';

const KM_TO_MI = 0.621371;

/**
 * Read completed drives from the TeslaMate database.
 * Returns drives with UTC timestamps, miles, and start/end coordinates.
 */
export async function fetchDrives(fromDate, toDate) {
  const client = newClient();
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT d.id,
              d.start_date,
              d.end_date,
              d.distance,
              sp.latitude  AS start_lat,
              sp.longitude AS start_lon,
              ep.latitude  AS end_lat,
              ep.longitude AS end_lon,
              sa.display_name AS start_address,
              ea.display_name AS end_address
         FROM drives d
         JOIN positions sp ON sp.id = d.start_position_id
         JOIN positions ep ON ep.id = d.end_position_id
         LEFT JOIN addresses sa ON sa.id = d.start_address_id
         LEFT JOIN addresses ea ON ea.id = d.end_address_id
        WHERE d.end_date IS NOT NULL
          AND d.distance IS NOT NULL
          -- The column is a timestamp without time zone holding UTC, and a bound Date
          -- arrives with an offset that a plain cast would silently discard, turning a
          -- local-day window back into a UTC-day one. Convert the instant explicitly.
          AND d.start_date >= $1::timestamptz AT TIME ZONE 'UTC'
          AND d.start_date < $2::timestamptz AT TIME ZONE 'UTC'
        ORDER BY d.start_date`,
      [fromDate, toDate]
    );
    return rows.map((r) => ({
      id: r.id,
      start: new Date(r.start_date),
      end: new Date(r.end_date),
      miles: r.distance * KM_TO_MI,
      startLat: Number(r.start_lat),
      startLon: Number(r.start_lon),
      endLat: Number(r.end_lat),
      endLon: Number(r.end_lon),
      startAddress: r.start_address || '',
      endAddress: r.end_address || '',
    }));
  } finally {
    await client.end();
  }
}
