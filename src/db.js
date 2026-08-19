import pg from 'pg';
import { config, requireConfig } from './config.js';

/**
 * TeslaMate stores UTC instants in `timestamp without time zone` columns
 * (Ecto's :utc_datetime). node-pg parses that type as *machine-local* time,
 * so every drive came back shifted by the local UTC offset (7-8 hours in
 * California). Nothing errors: the drives simply land outside their meeting's
 * arrival window and the log silently reports zero matched trips.
 *
 * Parse the type as the UTC it actually is. This is process-wide, so every
 * module that talks to the database must go through newClient().
 */
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (str) =>
  str === null ? null : new Date(`${str.replace(' ', 'T')}Z`)
);

/** A Postgres client for the TeslaMate database, with the parsers above applied. */
export function newClient() {
  requireConfig(['teslamateDbUrl']);
  return new pg.Client({ connectionString: config.teslamateDbUrl });
}
