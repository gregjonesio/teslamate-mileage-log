import test from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { parseDateRange } from '../src/dates.js';

/**
 * The window boundaries are instants, but they are compared against a
 * `timestamp without time zone` column holding UTC. A bound Date arrives with a
 * local offset that a plain cast discards, which silently turns a local-day
 * window back into a UTC-day one and drops evening drives from their own day.
 * Only the database can prove which value the comparison actually sees.
 */
const dbUrl = process.env.TESLAMATE_DB_URL;

test('window boundaries reach the database as UTC instants', { skip: !dbUrl && 'TESLAMATE_DB_URL not set' }, async () => {
  const { newClient } = await import('../src/db.js');
  const client = newClient();
  await client.connect();
  try {
    const { from, to } = parseDateRange('2026-08-19', '2026-08-19');
    const { rows } = await client.query(
      "SELECT $1::timestamptz AT TIME ZONE 'UTC' AS lo, $2::timestamptz AT TIME ZONE 'UTC' AS hi",
      [from, to]
    );
    // Whatever the local zone is, the boundary must be the same instant JS meant.
    assert.equal(rows[0].lo.toISOString(), from.toISOString());
    assert.equal(rows[0].hi.toISOString(), to.toISOString());
    assert.equal(rows[0].hi - rows[0].lo, 24 * 60 * 60 * 1000);
  } finally {
    await client.end();
  }
});
