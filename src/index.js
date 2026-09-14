#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { fetchDrives } from './teslamate.js';
import { fetchMeetings, getToken } from './graph.js';
import { geocodeLocation } from './geocode.js';
import { matchTrips, haversineMeters } from './matcher.js';
import { toCsv, summarize } from './report.js';
import { importManualTrips, addManualTrip, loggedDriveIds } from './manual.js';
import { loadHubs } from './hubs.js';
import { loadVenues, resolveVenue } from './venues.js';
import { parseDateRange, localDateString, localDateTimeString } from './dates.js';

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
                                        Match drives to meetings and print/write the log
                                        Dates are local calendar days; --to is inclusive
  mileage import --csv trips.csv [--source label]
                                        Import historical trips (columns: date,leg,miles,reason)
                                        into mileage.manual_trips; idempotent per source
  mileage add --drive <id> --reason "..." [--leg "..."]
  mileage add --date YYYY-MM-DD --miles N --reason "..." [--leg "..."]
                                        Log one manual business trip; --drive copies the
                                        GPS-verified distance from a TeslaMate drive
  mileage drives --from YYYY-MM-DD --to YYYY-MM-DD
                                        List logged TeslaMate drives (to find drive ids)`);
}

async function cmdMatch(args) {
  if (!args.from || !args.to) {
    usage();
    process.exit(1);
  }
  const { from, to } = parseDateRange(args.from, args.to);

  console.error(`Fetching meetings ${args.from} .. ${args.to} ...`);
  const meetings = await fetchMeetings(from, to);
  console.error(`  ${meetings.length} meetings with a physical location`);

  console.error('Geocoding meeting locations ...');
  const venues = loadVenues();
  if (venues.length) console.error(`  ${venues.length} venue aliases configured`);
  for (const m of meetings) {
    // Precedence: a hand-pinned alias, then coordinates the event itself
    // carries (Outlook resolves picked venues), then geocoding.
    const alias = resolveVenue(m.location, venues);
    const own = m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon } : null;
    if (alias && own && haversineMeters(alias.lat, alias.lon, own.lat, own.lon) > 1000) {
      const km = (haversineMeters(alias.lat, alias.lon, own.lat, own.lon) / 1000).toFixed(1);
      console.error(
        `  note: venues.json places "${m.location}" ${km} km from the event's own coordinates; the alias wins`
      );
    }
    const coords = alias ?? own ?? (await geocodeLocation(m.location, m.address));
    m.lat = coords?.lat ?? null;
    m.lon = coords?.lon ?? null;
    if (!coords) {
      console.error(
        `  could not geocode: "${m.location}" (${m.subject}); add it to venues.json to match it by name`
      );
    }
  }

  console.error('Fetching drives from TeslaMate ...');
  const drives = await fetchDrives(from, to);
  console.error(`  ${drives.length} drives`);

  const hubs = loadHubs();
  if (hubs.length) console.error(`  ${hubs.length} transport hubs configured`);

  const entries = matchTrips(meetings, drives, {
    radiusM: config.matchRadiusM,
    arriveEarlyMin: config.arriveEarlyMin,
    arriveLateMin: config.arriveLateMin,
    includeReturn: config.includeReturn,
    repositionMaxMiles: config.repositionMaxMiles,
    errandMaxMiles: config.errandMaxMiles,
    errandMaxGapMin: config.errandMaxGapMin,
    hubs,
    hubRadiusM: config.hubRadiusM,
    hubDepartEarlyMin: config.hubDepartEarlyMin,
    hubReturnMaxHours: config.hubReturnMaxHours,
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
  const viaHub = entries.filter((e) => e.hub);
  if (viaHub.length) {
    console.error(`
${viaHub.length} trips matched via a transport hub. The rail or air leg is`);
    console.error('not GPS-verified, so confirm each one before filing:');
    for (const e of viaHub) {
      const legs = e.return ? `${e.outbound.id}+${e.return.id}` : String(e.outbound.id);
      console.error(
        `  ${localDateString(e.meeting.start)}  drove to ${e.hub.name} (#${legs})` +
          `${e.return ? '' : ', no return drive yet'}  for  ${e.meeting.subject}`
      );
    }
  }

  const unmatched = meetings.filter(
    (m) => m.lat != null && !entries.some((e) => e.meeting.id === m.id)
  );
  if (unmatched.length) {
    console.error(`\n${unmatched.length} meetings had no matching drive (virtual, carpooled, or skipped):`);
    for (const m of unmatched) {
      console.error(`  ${localDateString(m.start)}  ${m.subject}  @ ${m.location}`);
    }
  }

  await reportUnclaimedDrives(drives, entries);
}

/** First 4 address components: enough to recognise a place, short enough to scan. */
function shortAddress(address) {
  if (!address) return '?';
  return address.split(',').slice(0, 4).map((part) => part.trim()).join(', ');
}

/**
 * Drives no meeting explained. Without this the match output says nothing about them
 * and real business miles disappear, which is the failure this log exists to avoid.
 */
async function reportUnclaimedDrives(drives, entries) {
  const claimed = new Set();
  for (const e of entries) {
    claimed.add(e.outbound.id);
    if (e.return) claimed.add(e.return.id);
  }
  const already = await loggedDriveIds();
  const unclaimed = drives.filter((d) => !claimed.has(d.id) && !already.has(d.id));
  const logged = drives.filter((d) => !claimed.has(d.id) && already.has(d.id));

  if (logged.length) {
    console.error(
      `
${logged.length} unmatched drives were already logged by hand ` +
        `(#${logged.map((d) => d.id).join(', #')}).`
    );
  }
  if (!unclaimed.length) return;

  const miles = unclaimed.reduce((sum, d) => sum + d.miles, 0);
  console.error(
    `
${unclaimed.length} drives (${miles.toFixed(1)} mi) matched no meeting. ` +
      'Log any that were business:'
  );
  for (const d of unclaimed) {
    console.error(
      `  #${d.id}  ${localDateTimeString(d.start)}  ${d.miles.toFixed(1)} mi  ` +
        `${shortAddress(d.startAddress)} -> ${shortAddress(d.endAddress)}`
    );
    console.error(`      mileage add --drive ${d.id} --reason "..."`);
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
  } else if (cmd === 'import') {
    if (!args.csv) { usage(); process.exit(1); }
    const result = await importManualTrips(args.csv, args.source || 'manual');
    console.log(`Imported ${result.imported} trips.`);
    for (const y of result.byYear) console.log(`  ${y.year}: ${y.trips} trips, ${y.miles} miles`);
  } else if (cmd === 'add') {
    const r = await addManualTrip({
      date: args.date,
      miles: args.miles,
      driveId: args.drive != null ? Number(args.drive) : null,
      leg: args.leg,
      reason: args.reason,
    });
    console.log(`Logged ${r.miles} business miles on ${r.date}.`);
  } else if (cmd === 'drives') {
    if (!args.from || !args.to) { usage(); process.exit(1); }
    const { from, to } = parseDateRange(args.from, args.to);
    const drives = await fetchDrives(from, to);
    for (const d of drives) {
      console.log(
        `#${d.id}  ${localDateTimeString(d.start)}  ` +
          `${d.miles.toFixed(1)} mi  ${d.startAddress || '?'} -> ${d.endAddress || '?'}`
      );
    }
    if (!drives.length) console.log('No drives in that window.');
  } else {
    usage();
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
