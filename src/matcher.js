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
 * opts:     { radiusM, arriveEarlyMin, arriveLateMin, includeReturn }
 *
 * Returns entries: one per meeting that matched an outbound drive, with an optional
 * return drive (the first later drive departing from the meeting location).
 * A drive is used at most once across all meetings.
 */
export function matchTrips(meetings, drives, opts = {}) {
  const {
    radiusM = 500,
    arriveEarlyMin = 120,
    arriveLateMin = 20,
    includeReturn = true,
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
      outbound: best.drive,
      outboundDistanceM: Math.round(best.dist),
      return: null,
      confidence: best.dist <= 300 ? 'high' : 'medium',
    };

    if (includeReturn) {
      const candidates = drives
        .filter(
          (d) =>
            !usedDrives.has(d.id) &&
            d.start > meeting.start &&
            d.start.getTime() - meeting.end.getTime() < 6 * 3600 * 1000 &&
            haversineMeters(d.startLat, d.startLon, meeting.lat, meeting.lon) <= radiusM
        )
        .sort((a, b) => a.start - b.start);
      if (candidates.length) {
        entry.return = candidates[0];
        usedDrives.add(candidates[0].id);
      }
    }

    entries.push(entry);
  }

  return entries;
}
