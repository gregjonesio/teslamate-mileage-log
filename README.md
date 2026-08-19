# teslamate-mileage-log

Automatic business mileage logging for Tesla owners. No subscription, no phone app, no manual trip classification.

It works by joining two data sources you already have:

- **[TeslaMate](https://github.com/teslamate-org/teslamate)** records every drive your car makes (start/end time, start/end GPS position, distance).
- **Your Outlook calendar** knows where your business meetings were (event location) and why you went (event subject).

This tool geocodes each meeting's address, finds the drive that ended at that address shortly before the meeting started, optionally pairs it with the return drive, and emits an IRS-style mileage log as CSV: date, business purpose, destination, miles, and deduction at your configured rate.

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

- `confidence` is `high` when the drive ended within 300 m of the geocoded meeting address, `medium` within the configured radius (default 500 m). Review medium rows before filing.
- `drive_ids` are TeslaMate drive ids, so every logged trip is auditable back to raw GPS data.
- Meetings with a physical location that matched no drive are listed on stderr so nothing disappears silently.

## Matching rules

A meeting matches a drive when the drive **ended within `MATCH_RADIUS_M` meters** of the meeting's geocoded address, in the window from `ARRIVE_EARLY_MIN` minutes before the meeting start to `ARRIVE_LATE_MIN` minutes after. If `INCLUDE_RETURN=true`, the first later drive **departing** from that location (within 6 hours of the meeting end) is logged as the return leg. Each drive is used at most once. Virtual meetings (Zoom/Teams/Meet/Webex links as the location) are excluded automatically.

## Privacy

Everything runs locally. The only external call is address geocoding via OpenStreetMap's Nominatim (one request per unique address, cached forever in `data/geocode-cache.json`). No trip data, calendar data, or tokens ever leave your machine. `data/` and `.env` are gitignored.

## Disclaimer

This produces a records-based mileage log; it is not tax advice. Check the current IRS standard mileage rate and set `MILEAGE_RATE` accordingly, and review the output before filing.

## Roadmap

- `.ics` file input as an alternative to Microsoft Graph (Google Calendar / iCloud users)
- Pluggable trip sources (direct Tesla Fleet API poller, Tessie)
- Interactive review command for medium-confidence matches
- Home/office geofences to auto-classify commute vs business legs

## License

MIT
