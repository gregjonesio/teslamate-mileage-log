/**
 * Pure matching logic: pair drives with meetings.
 * No I/O here so it stays unit-testable.
 */

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Match drives to meetings.
 *
 * meetings: [{ id, subject, location, start, end, lat, lon }] (already geocoded; lat/lon may be null)
 * drives:   [{ id, start, end, miles, startLat, startLon, endLat, endLon, startAddress, endAddress }]
 * hubs:     [{ name, lat, lon, radiusM? }] transport hubs (stations, airports)
 * opts:     { radiusM, arriveEarlyMin, arriveLateMin, includeReturn, repositionMaxMiles,
 *             errandMaxMiles, errandMaxGapMin,
 *             hubs, hubRadiusM, hubDepartEarlyMin, hubReturnMaxHours }
 *
 * Returns entries: one per meeting that matched an outbound drive, with an optional
 * return drive (the first substantive later drive departing from where the car was
 * parked, which after a skipped hop or errand stop may not be the venue itself).
 * A drive is used at most once across all meetings.
 *
 * Two passes. The first matches drives that ended at the meeting itself. The second
 * only sees meetings the first could not explain, and looks for a drive that ended at
 * a transport hub instead: the rail or air leg that follows is invisible to the car,
 * so these are marked `via-hub` for a human to confirm rather than trusted outright.
 */
export function matchTrips(meetings, drives, opts = {}) {
  const {
    radiusM = 500,
    arriveEarlyMin = 120,
    arriveLateMin = 20,
    includeReturn = true,
    repositionMaxMiles = 1,
    errandMaxMiles = 3,
    errandMaxGapMin = 60,
    hubs = [],
    hubRadiusM = 750,
    hubDepartEarlyMin = 480,
    hubReturnMaxHours = 12,
  } = opts;

  const usedDrives = new Set();
  const entries = [];
  const errand = { maxMiles: errandMaxMiles, maxGapMs: errandMaxGapMin * 60000 };

  // Process meetings chronologically so earlier meetings claim drives first.
  const sorted = [...meetings]
    .filter((m) => m.lat != null && m.lon != null)
    .sort((a, b) => a.start - b.start);

  for (const meeting of sorted) {
    const windowStart = new Date(meeting.start.getTime() - arriveEarlyMin * 60000);
    // Arriving partway through a long block (a site visit, a half-day on site) is
    // still arriving, so the window stays open until the meeting ends.
    const lateEnd = meeting.start.getTime() + arriveLateMin * 60000;
    const meetingEnd = meeting.end instanceof Date ? meeting.end.getTime() : NaN;
    const windowEnd = new Date(Number.isFinite(meetingEnd) && meetingEnd > lateEnd ? meetingEnd : lateEnd);

    const best = pickOutbound(drives, usedDrives, meeting, windowStart, windowEnd, radiusM, repositionMaxMiles);
    if (!best) continue;

    usedDrives.add(best.drive.id);
    const entry = {
      meeting,
      destination: meeting.location,
      outbound: best.drive,
      outboundDistanceM: Math.round(best.dist),
      hub: null,
      return: null,
      confidence: best.dist <= 300 ? 'high' : 'medium',
    };

    if (includeReturn) {
      // Leaving early is allowed (start > meeting.start, not meeting.end), but
      // the return must at least follow the arrival it is paired with.
      const later = drives
        .filter(
          (d) =>
            !usedDrives.has(d.id) &&
            d.start > meeting.start &&
            d.start > best.drive.end &&
            d.start.getTime() - meeting.end.getTime() < 6 * 3600 * 1000
        )
        .sort((a, b) => a.start - b.start);
      const ret = pickReturn(later, { lat: meeting.lat, lon: meeting.lon }, radiusM, repositionMaxMiles, errand);
      if (ret) {
        entry.return = ret;
        usedDrives.add(ret.id);
      }
    }

    entries.push(entry);
  }

  // Second pass: meetings reached by rail or air from a transport hub.
  const matched = new Set(entries.map((e) => e.meeting.id));
  for (const meeting of sorted) {
    if (matched.has(meeting.id) || !hubs.length) continue;

    const earliest = new Date(meeting.start.getTime() - hubDepartEarlyMin * 60000);
    let best = null;
    for (const drive of drives) {
      if (usedDrives.has(drive.id)) continue;
      if (drive.end < earliest || drive.end > meeting.start) continue;
      const hub = nearestHub(drive.endLat, drive.endLon, hubs, hubRadiusM);
      if (!hub) continue;
      // The last departure before the meeting is the likeliest one.
      if (!best || drive.end > best.drive.end) best = { drive, hub: hub.hub, dist: hub.dist };
    }
    if (!best) continue;

    usedDrives.add(best.drive.id);
    const entry = {
      meeting,
      destination: best.hub.name,
      outbound: best.drive,
      outboundDistanceM: Math.round(best.dist),
      hub: best.hub,
      return: null,
      confidence: 'via-hub',
    };

    if (includeReturn) {
      // The drive home leaves from the same hub, after the meeting ended. Rail and
      // air schedules make this much later than a drive back from the venue itself.
      const later = drives
        .filter(
          (d) =>
            !usedDrives.has(d.id) &&
            d.start > meeting.end &&
            d.start.getTime() - meeting.end.getTime() < hubReturnMaxHours * 3600 * 1000
        )
        .sort((a, b) => a.start - b.start);
      const ret = pickReturn(later, best.hub, hubRadius(best.hub, hubRadiusM), repositionMaxMiles, errand);
      if (ret) {
        entry.return = ret;
        usedDrives.add(ret.id);
      }
    }

    entries.push(entry);
  }

  return entries.sort((a, b) => a.meeting.start - b.meeting.start);
}

/** Non-finite mileage must not silently pass the `<=` (null <= 1 is true). */
function isHop(drive, repositionMaxMiles) {
  return Number.isFinite(drive.miles) && drive.miles <= repositionMaxMiles;
}

/**
 * Pick the outbound leg: the first unused drive ending inside the arrival
 * window and within the radius. Earliest wins, not closest, because on a long
 * block the car may leave and come back (lunch, an errand), and the drive that
 * got there first is the one that made the trip. An arrival the car then
 * drove away from before the meeting began (a drop-off on the way) is passed
 * over in favour of a later arrival that stayed, when there is one.
 *
 * Hops are followed only along the car's own consecutive drives, never by
 * proximity across an intervening trip. When the chosen arrival is itself a
 * repositioning hop (the car was parked out of radius and then moved closer),
 * walk back through consecutive hops to the drive that made the trip; if no
 * earlier drive explains the hop, the hop is the outbound leg. Hops after the
 * arrival, still inside the window, refine the reported distance to the closest
 * the car was parked, so confidence is judged by the visit rather than by a
 * stop just short of it. Hops are not claimed: the return picker can still use
 * them as anchors and they stay visible as unclaimed drives.
 */
function pickOutbound(drives, usedDrives, meeting, windowStart, windowEnd, radiusM, repositionMaxMiles) {
  const target = { lat: meeting.lat, lon: meeting.lon };
  const timeline = [...drives].sort((a, b) => a.start - b.start);
  const eligible = (d) => !usedDrives.has(d.id) && d.end >= windowStart && d.end <= windowEnd;
  const consecutive = (a, b) =>
    b.start >= a.end && haversineMeters(a.endLat, a.endLon, b.startLat, b.startLon) <= radiusM;

  // Did the car stay put (bar hops) from this arrival until the meeting began?
  const stayed = (i) => {
    for (let j = i + 1; j < timeline.length && timeline[j].start < meeting.start; j++) {
      if (!isHop(timeline[j], repositionMaxMiles)) return false;
    }
    return true;
  };

  let first = null;
  let index = -1;
  for (let i = 0; i < timeline.length; i++) {
    const drive = timeline[i];
    if (!eligible(drive)) continue;
    const dist = haversineMeters(drive.endLat, drive.endLon, target.lat, target.lon);
    if (dist > radiusM) continue;
    if (stayed(i)) { first = { drive, dist }; index = i; break; }
    if (!first) { first = { drive, dist }; index = i; }
  }
  if (!first) return null;

  // Walk back through consecutive hops to the drive that made the trip.
  let drive = first.drive;
  let i = index;
  while (isHop(drive, repositionMaxMiles) && i > 0) {
    const prev = timeline[i - 1];
    if (usedDrives.has(prev.id) || !consecutive(prev, drive)) break;
    drive = prev;
    i -= 1;
  }

  // Walk forward through consecutive hops inside the window.
  let dist = first.dist;
  for (let j = index + 1; j < timeline.length; j++) {
    const next = timeline[j];
    if (usedDrives.has(next.id) || next.end > windowEnd) break;
    if (!isHop(next, repositionMaxMiles) || !consecutive(timeline[j - 1], next)) break;
    dist = Math.min(dist, haversineMeters(next.endLat, next.endLon, target.lat, target.lon));
  }
  return { drive, dist };
}

/**
 * Pick the return leg: the first substantive drive leaving the place the car
 * was parked. Short repositioning hops (moving the car down the block, in and
 * out of a parking structure) also depart from the venue, and claiming one as
 * the return leaves the real drive home unclaimed. Skip any drive of
 * repositionMaxMiles or less, but remember where it moved the car: the true
 * return departs from there, possibly outside the venue's own radius.
 *
 * A short errand on the way out (a pharmacy, a store a couple of miles off) is
 * skipped the same way, but only when a longer drive follows it promptly: a
 * drive of errand.maxMiles or less whose chain of stops leads, within
 * errand.maxGapMs of each stop, to a substantive drive. A stop that brings the
 * car back to the venue resets the clock, since the dwell there is the meeting
 * itself. The errand's own miles are not claimed: the detour is personal, and
 * the drive home from the store is the return.
 * `candidates` must already be time-filtered and sorted by start.
 */
function pickReturn(candidates, origin, radiusM, repositionMaxMiles, errand = { maxMiles: 0, maxGapMs: 0 }) {
  const anchors = [{ lat: origin.lat, lon: origin.lon }];
  for (let i = 0; i < candidates.length; i++) {
    const drive = candidates[i];
    const nearCar = anchors.some(
      (a) => haversineMeters(drive.startLat, drive.startLon, a.lat, a.lon) <= radiusM
    );
    if (!nearCar) continue;
    // A drive with unknown mileage stays a visible return candidate instead of
    // vanishing as a hop or an errand.
    if (isHop(drive, repositionMaxMiles)) {
      anchors.push({ lat: drive.endLat, lon: drive.endLon });
      continue;
    }
    if (Number.isFinite(drive.miles) && drive.miles <= errand.maxMiles) {
      const onward = errandLeadsOn(candidates, i, origin, radiusM, errand);
      if (onward) return onward;
    }
    return drive;
  }
  return null;
}

/**
 * Follow a chain of short stops from candidates[i] and return the substantive
 * drive it leads to, or null when the chain breaks: the next drive does not
 * start where and after the previous one ended, starts too long after it
 * ended, or nothing longer ever follows.
 */
function errandLeadsOn(candidates, i, origin, radiusM, errand) {
  let prev = candidates[i];
  for (let j = i + 1; j < candidates.length; j++) {
    const next = candidates[j];
    if (next.start < prev.end) return null;
    if (haversineMeters(next.startLat, next.startLon, prev.endLat, prev.endLon) > radiusM) return null;
    const backAtVenue = haversineMeters(prev.endLat, prev.endLon, origin.lat, origin.lon) <= radiusM;
    if (!backAtVenue && next.start.getTime() - prev.end.getTime() > errand.maxGapMs) return null;
    if (!Number.isFinite(next.miles) || next.miles > errand.maxMiles) return next;
    prev = next;
  }
  return null;
}

function hubRadius(hub, fallbackM) {
  return hub.radiusM ?? fallbackM;
}

/** Closest hub containing the point, or null. */
function nearestHub(lat, lon, hubs, fallbackM) {
  let best = null;
  for (const hub of hubs) {
    const dist = haversineMeters(lat, lon, hub.lat, hub.lon);
    if (dist > hubRadius(hub, fallbackM)) continue;
    if (!best || dist < best.dist) best = { hub, dist };
  }
  return best;
}
