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
 *             hubs, hubRadiusM, hubDepartEarlyMin, hubReturnMaxHours }
 *
 * Returns entries: one per meeting that matched an outbound drive, with an optional
 * return drive (the first later drive departing from the meeting location).
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
    hubs = [],
    hubRadiusM = 750,
    hubDepartEarlyMin = 480,
    hubReturnMaxHours = 12,
  } = opts;

  const usedDrives = new Set();
  const entries = [];

  // Process meetings chronologically so earlier meetings claim drives first.
  const sorted = [...meetings]
    .filter((m) => m.lat != null && m.lon != null)
    .sort((a, b) => a.start - b.start);

  for (const meeting of sorted) {
    const windowStart = new Date(meeting.start.getTime() - arriveEarlyMin * 60000);
    const windowEnd = new Date(meeting.start.getTime() + arriveLateMin * 60000);

    let best = null;
    for (const drive of drives) {
      if (usedDrives.has(drive.id)) continue;
      if (drive.end < windowStart || drive.end > windowEnd) continue;
      const dist = haversineMeters(drive.endLat, drive.endLon, meeting.lat, meeting.lon);
      if (dist > radiusM) continue;
      if (!best || dist < best.dist) best = { drive, dist };
    }
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
      const later = drives
        .filter(
          (d) =>
            !usedDrives.has(d.id) &&
            d.start > meeting.start &&
            d.start.getTime() - meeting.end.getTime() < 6 * 3600 * 1000
        )
        .sort((a, b) => a.start - b.start);
      const ret = pickReturn(later, { lat: meeting.lat, lon: meeting.lon }, radiusM, repositionMaxMiles);
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
      const ret = pickReturn(later, best.hub, hubRadius(best.hub, hubRadiusM), repositionMaxMiles);
      if (ret) {
        entry.return = ret;
        usedDrives.add(ret.id);
      }
    }

    entries.push(entry);
  }

  return entries.sort((a, b) => a.meeting.start - b.meeting.start);
}

/**
 * Pick the return leg: the first substantive drive leaving the place the car
 * was parked. Short repositioning hops (moving the car down the block, in and
 * out of a parking structure) also depart from the venue, and claiming one as
 * the return leaves the real drive home unclaimed. Skip any drive of
 * repositionMaxMiles or less, but remember where it moved the car: the true
 * return departs from there, possibly outside the venue's own radius.
 * `candidates` must already be time-filtered and sorted by start.
 */
function pickReturn(candidates, origin, radiusM, repositionMaxMiles) {
  const anchors = [{ lat: origin.lat, lon: origin.lon }];
  for (const drive of candidates) {
    const nearCar = anchors.some(
      (a) => haversineMeters(drive.startLat, drive.startLon, a.lat, a.lon) <= radiusM
    );
    if (!nearCar) continue;
    // Non-finite mileage must not silently pass the `<=` (null <= 1 is true);
    // such a drive stays a visible return candidate instead of vanishing.
    if (Number.isFinite(drive.miles) && drive.miles <= repositionMaxMiles) {
      anchors.push({ lat: drive.endLat, lon: drive.endLon });
      continue;
    }
    return drive;
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
