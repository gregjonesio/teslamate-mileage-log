#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { fetchDrives } from './teslamate.js';
import { fetchMeetings, getToken } from './graph.js';
import { geocodeLocation } from './geocode.js';
import { matchTrips } from './matcher.js';
import { toCsv, summarize } from './report.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  mileage auth                          Sign in to Microsoft Graph (device code)
  mileage match --from YYYY-MM-DD --to YYYY-MM-DD [--out log.csv]
                                        Match drives to meetings and print/write the log`);
}

async function cmdMatch(args) {
  if (!args.from || !args.to) {
    usage();
    process.exit(1);
  }
  const from = new Date(`${args.from}T00:00:00Z`);
  const to = new Date(`${args.to}T00:00:00Z`);

  console.error(`Fetching meetings ${args.from} .. ${args.to} ...`);
  const meetings = await fetchMeetings(from, to);
  console.error(`  ${meetings.length} meetings with a physical location`);

  console.error('Geocoding meeting locations ...');
  for (const m of meetings) {
    const coords = await geocodeLocation(m.location);
    m.lat = coords?.lat ?? null;
    m.lon = coords?.lon ?? null;
    if (!coords) console.error(`  could not geocode: "${m.location}" (${m.subject})`);
  }

  console.error('Fetching drives from TeslaMate ...');
  const drives = await fetchDrives(from, to);
  console.error(`  ${drives.length} drives`);

  const entries = matchTrips(meetings, drives, {
    radiusM: config.matchRadiusM,
    arriveEarlyMin: config.arriveEarlyMin,
    arriveLateMin: config.arriveLateMin,
    includeReturn: config.includeReturn,
  });

  const csv = toCsv(entries, { mileageRate: config.mileageRate });
  if (args.out) {
    writeFileSync(args.out, csv);
    console.error(`Wrote ${args.out}`);
  } else {
    process.stdout.write(csv);
  }

  const s = summarize(entries, { mileageRate: config.mileageRate });
  console.error(
    `\n${s.trips} matched trips, ${s.totalMiles.toFixed(1)} business miles, ` +
      `$${s.deduction.toFixed(2)} at $${config.mileageRate}/mi`
  );
  const unmatched = meetings.filter(
    (m) => m.lat != null && !entries.some((e) => e.meeting.id === m.id)
  );
  if (unmatched.length) {
    console.error(`\n${unmatched.length} meetings had no matching drive (virtual, carpooled, or skipped):`);
    for (const m of unmatched) {
      console.error(`  ${m.start.toISOString().slice(0, 10)}  ${m.subject}  @ ${m.location}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  if (cmd === 'auth') {
    await getToken({ interactive: true });
    console.log('Signed in. Token cached in data/msal-cache.json.');
  } else if (cmd === 'match') {
    await cmdMatch(args);
  } else {
    usage();
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
