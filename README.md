# teslamate-mileage-log

Automatic business mileage logging for Tesla owners. No subscription, no phone app, no manual trip classification.

It works by joining two data sources you already have:

- **[TeslaMate](https://github.com/teslamate-org/teslamate)** records every drive your car makes (start/end time, start/end GPS position, distance).
- **Your Outlook calendar** knows where your business meetings were (event location) and why you went (event subject).

This tool locates each meeting (using the coordinates and street address Outlook already attached to the event when you picked the venue from its location search, geocoding the location text otherwise), finds the drive that ended there shortly before the meeting started, optionally pairs it with the return drive, and emits an IRS-style mileage log as CSV: date, business purpose, destination, miles, and deduction at your configured rate.

## Why TeslaMate?

Tesla's Fleet API has no trip-history endpoint; every trip logger works by recording vehicle state over time. TeslaMate is the standard open source, self-hosted way to do that, it is free, and its trip detection is battle-tested. This project is a read-only companion: it never writes to the TeslaMate database and never talks to your car.

## Requirements

- Node.js 20+
- A running TeslaMate instance and read access to its Postgres database
- Microsoft Graph access to your calendar, either of:
  - **Client credentials** (non-interactive, good for tenant admins): an app registration with the `Calendars.Read` application permission; set `GRAPH_CLIENT_SECRET` and `GRAPH_USER_UPN` (or `GRAPH_ENV_FILE`) in `.env`.
  - **Device code** (default for individuals): an Azure app registration for Microsoft Graph (free):
  1. [Azure Portal](https://portal.azure.com) > App registrations > New registration
  2. Supported account types: pick what matches your mailbox (work/school tenant or personal Microsoft accounts)
  3. Authentication > Advanced settings > **Allow public client flows: Yes**
  4. API permissions > Microsoft Graph > Delegated > **Calendars.Read**
  5. Copy the Application (client) ID into `.env`

## Setup

```
npm install
cp .env.example .env   # then fill in TESLAMATE_DB_URL, GRAPH_CLIENT_ID, etc.
node src/index.js auth # one-time device-code sign-in; token cached under data/
```

## Usage

```
node src/index.js match --from 2026-01-01 --to 2026-06-30 --out mileage-h1.csv
```

`--from` and `--to` are local calendar days and `--to` is inclusive, so the example above covers Jan 1 through Jun 30. TeslaMate stores drive times as UTC, and both the window and the logged date are converted to local time, so an evening drive is logged on the day it was actually driven.

Output columns: `date, purpose, destination, outbound_miles, return_miles, total_miles, deduction, confidence, drive_ids`.

- `confidence` is `high` when the drive ended within 300 m of the geocoded meeting address, `medium` within the configured radius (default 500 m), and `via-hub` for a trip that continued by rail or air (see below). Review anything that is not `high` before filing.
- `drive_ids` are TeslaMate drive ids, so every logged trip is auditable back to raw GPS data.
- Meetings with a physical location that matched no drive are listed on stderr so nothing disappears silently.
- **Drives that matched no meeting are listed too**, with the `add --drive` command to log each one. A mileage log fails quietly when a business drive is simply never mentioned, so both sides of the match are reported. Drives already logged by hand are not offered again.

## Matching rules

A meeting matches a drive when the drive **ended within `MATCH_RADIUS_M` meters** of the meeting's location, in the window from `ARRIVE_EARLY_MIN` minutes before the meeting start to `ARRIVE_LATE_MIN` minutes after. If `INCLUDE_RETURN=true`, the first **substantive** later drive departing from that location (within 6 hours of the meeting end) is logged as the return leg. Each drive is used at most once. Virtual meetings (Zoom/Teams/Meet/Webex links as the location) are excluded automatically.

A meeting's coordinates come from the first of these that answers: a `venues.json` alias (below), the coordinates or structured street address Outlook attached to the event itself, or Nominatim geocoding of the location text.

Departing drives of `REPOSITION_MAX_MILES` miles or less (default 1) are treated as repositioning hops, not the drive home: moving the car down the block or in and out of a parking structure would otherwise claim the return slot and leave the real drive home unmatched. The hop's end point still counts as where the car is parked, so the return is found even if the shuffle moved the car outside the match radius. Skipped hops show up in the unclaimed-drives list, so a genuine sub-mile return can still be logged with `add --drive`.

## Venues the geocoder cannot find

Outlook meeting locations are often a bare venue name ("Joe's Grill"), especially when the venue was typed rather than picked from Outlook's location search. If the event carries no address or coordinates of its own and Nominatim cannot resolve the name, the meeting cannot match any drive. Pin such venues by hand:

```
cp venues.example.json venues.json   # then edit; venues.json is gitignored
```

```json
[
  { "name": "Griffith Observatory", "lat": 34.1184, "lon": -118.3004 }
]
```

Names match the event location case-insensitively (the venue-name part of a "Name (address)" location also counts), and an alias always wins over the event's own data. Unresolvable locations are listed on stderr with a reminder that one line here fixes the venue forever.

## Trips that continue by rail or air

If you drive to a station or airport and fly or take the train the rest of the way, no drive ever ends near the meeting, so the rule above cannot see the trip at all. List the places where that happens:

```
cp hubs.example.json hubs.json   # then edit; hubs.json is gitignored
```

```json
[
  { "name": "Santa Ana Regional Transportation Center", "lat": 33.7514, "lon": -117.8569 },
  { "name": "John Wayne Airport", "lat": 33.6757, "lon": -117.8683, "radiusM": 1200 }
]
```

A meeting that no drive explains directly is then matched to the **last drive ending at a hub** within `HUB_DEPART_EARLY_MIN` minutes before it (default 480, since rail and air legs start hours ahead). The drive home from the same hub, starting within `HUB_RETURN_MAX_HOURS` after the meeting ends (default 12), becomes the return leg. `HUB_RADIUS_M` (default 750 m) covers terminal parking, and any hub can override it with `radiusM`.

These rows are logged with the hub as the destination and `via-hub` confidence, and are called out separately on stderr. The leg beyond the hub is not GPS-verified, so a direct match always wins over a hub match, and hub matches are for you to confirm rather than to trust. Without a `hubs.json` the feature is simply off.

## Privacy

Everything runs locally. The only external call is address geocoding via OpenStreetMap's Nominatim (one request per unique address, cached forever in `data/geocode-cache.json`). No trip data, calendar data, or tokens ever leave your machine. `data/` and `.env` are gitignored.

## Disclaimer

This produces a records-based mileage log; it is not tax advice. Check the current IRS standard mileage rate and set `MILEAGE_RATE` accordingly, and review the output before filing.

## Roadmap

- `.ics` file input as an alternative to Microsoft Graph (Google Calendar / iCloud users)
- Pluggable trip sources (direct Tesla Fleet API poller, Tessie)
- Interactive review command for medium-confidence and via-hub matches
- Home/office geofences to auto-classify commute vs business legs

## License

MIT
