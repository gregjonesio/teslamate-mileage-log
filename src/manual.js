import { readFileSync } from 'node:fs';
import { newClient } from './db.js';
import { localDateString } from './dates.js';

/**
 * Manual/historical trips live in their own schema in the TeslaMate database
 * (mileage.manual_trips). TeslaMate's own tables are never touched.
 */

/** Minimal quote-aware CSV parser (handles commas and "" escapes inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Import a CSV of historical trips: header row `date,leg,miles,reason`,
 * dates as YYYY-MM-DD. Re-importing the same source replaces its rows,
 * so the operation is idempotent per source label.
 */
/**
 * Add a single manual business trip. Miles can be given explicitly, or copied
 * from a logged TeslaMate drive (--drive <id>), which keeps the distance
 * GPS-verified while the human supplies the business purpose.
 */
export async function addManualTrip({ date, miles, driveId, leg, reason }) {
  const client = newClient();
  await client.connect();
  try {
    if (driveId != null) {
      const d = await client.query(
        'SELECT start_date, distance FROM drives WHERE id = $1',
        [driveId]
      );
      if (!d.rows.length) throw new Error(`No TeslaMate drive with id ${driveId}`);
      miles = d.rows[0].distance * 0.621371;
      date = date || localDateString(d.rows[0].start_date);
    }
    if (!date || !Number.isFinite(Number(miles))) {
      throw new Error('Need --date and --miles, or --drive <id>');
    }
    await client.query(
      'INSERT INTO mileage.manual_trips (trip_date, leg, miles, reason, source) VALUES ($1, $2, $3, $4, $5)',
      [date, leg || null, Number(Number(miles).toFixed(1)), reason || null, driveId != null ? `drive-${driveId}` : 'adhoc']
    );
    return { date, miles: Number(Number(miles).toFixed(1)) };
  } finally {
    await client.end();
  }
}

export async function importManualTrips(file, source) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(['date', 'leg', 'miles', 'reason'].map((c) => [c, header.indexOf(c)]));
  if (idx.date < 0 || idx.miles < 0) {
    throw new Error(`CSV must have at least "date" and "miles" columns; got: ${header.join(', ')}`);
  }

  const client = newClient();
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS mileage');
    await client.query(
      `CREATE TABLE IF NOT EXISTS mileage.manual_trips (
         id serial PRIMARY KEY,
         trip_date date NOT NULL,
         leg text,
         miles numeric NOT NULL,
         reason text,
         source text NOT NULL
       )`
    );
    await client.query('BEGIN');
    await client.query('DELETE FROM mileage.manual_trips WHERE source = $1', [source]);
    let count = 0;
    for (const r of rows) {
      const date = r[idx.date]?.trim();
      const miles = Number(r[idx.miles]);
      if (!date || !Number.isFinite(miles)) continue;
      await client.query(
        'INSERT INTO mileage.manual_trips (trip_date, leg, miles, reason, source) VALUES ($1, $2, $3, $4, $5)',
        [date, idx.leg >= 0 ? r[idx.leg] : null, miles, idx.reason >= 0 ? r[idx.reason] : null, source]
      );
      count++;
    }
    await client.query('COMMIT');
    const totals = await client.query(
      `SELECT extract(year FROM trip_date)::int AS year, count(*) AS trips, round(sum(miles), 1) AS miles
         FROM mileage.manual_trips WHERE source = $1 GROUP BY 1 ORDER BY 1`,
      [source]
    );
    return { imported: count, byYear: totals.rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
