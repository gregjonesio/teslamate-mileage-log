import { PublicClientApplication } from '@azure/msal-node';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, requireConfig, dataDir } from './config.js';

const SCOPES = ['Calendars.Read'];
const cachePath = path.join(dataDir, 'msal-cache.json');

/**
 * Two auth modes:
 *
 * 1. App (client credentials): set GRAPH_CLIENT_SECRET + GRAPH_USER_UPN (plus
 *    GRAPH_CLIENT_ID / GRAPH_TENANT_ID), or point GRAPH_ENV_FILE at an env file
 *    containing MSGRAPH_TENANT_ID / MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET /
 *    MSGRAPH_SENDER_UPN. Non-interactive; reads /users/{upn}/calendarView.
 *    Requires the app to hold the Calendars.Read application permission.
 *
 * 2. Delegated (device code): default when no client secret is configured.
 *    One-time interactive sign-in via `mileage auth`; reads /me/calendarView.
 */
function parseEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.replace(/^﻿/, '').match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function appCreds() {
  if (process.env.GRAPH_ENV_FILE) {
    const e = parseEnvFile(process.env.GRAPH_ENV_FILE);
    if (e.MSGRAPH_CLIENT_SECRET) {
      return {
        tenantId: e.MSGRAPH_TENANT_ID,
        clientId: e.MSGRAPH_CLIENT_ID,
        clientSecret: e.MSGRAPH_CLIENT_SECRET,
        upn: process.env.GRAPH_USER_UPN || e.MSGRAPH_SENDER_UPN,
      };
    }
  }
  if (process.env.GRAPH_CLIENT_SECRET) {
    return {
      tenantId: config.graphTenantId,
      clientId: config.graphClientId,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
      upn: process.env.GRAPH_USER_UPN,
    };
  }
  return null;
}

const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    if (existsSync(cachePath)) ctx.tokenCache.deserialize(readFileSync(cachePath, 'utf8'));
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) writeFileSync(cachePath, ctx.tokenCache.serialize());
  },
};

function app() {
  requireConfig(['graphClientId']);
  return new PublicClientApplication({
    auth: {
      clientId: config.graphClientId,
      authority: `https://login.microsoftonline.com/${config.graphTenantId}`,
    },
    cache: { cachePlugin },
  });
}

async function appToken(creds) {
  const res = await fetch(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`Graph app token failed: ${body.error}: ${body.error_description}`);
  }
  return body.access_token;
}

export async function getToken({ interactive = false } = {}) {
  const creds = appCreds();
  if (creds) return appToken(creds);

  const pca = app();
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
      return result.accessToken;
    } catch {
      // fall through to device code
    }
  }
  if (!interactive) {
    throw new Error('Not signed in. Run: mileage auth');
  }
  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (info) => console.log(info.message),
  });
  return result.accessToken;
}

/**
 * Normalise a Graph event location. When a venue was picked from Outlook's
 * location search, the event itself carries a structured street address and
 * coordinates; the display name alone is often just a venue name ("Joe's
 * Grill") that no geocoder can resolve. Keep all three.
 */
export function parseEventLocation(location) {
  const name = location?.displayName?.trim() || '';
  const a = location?.address || {};
  const street = a.street?.trim();
  const parts = [
    street,
    a.city?.trim(),
    [a.state?.trim(), a.postalCode?.trim()].filter(Boolean).join(' '),
  ].filter(Boolean);
  const lat = location?.coordinates?.latitude;
  const lon = location?.coordinates?.longitude;
  const valid =
    Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
  return {
    name,
    address: street ? parts.join(', ') : null,
    lat: valid ? lat : null,
    lon: valid ? lon : null,
  };
}

/**
 * Fetch calendar events (UTC) in [fromDate, toDate) that have a physical location.
 * Events whose location looks like a meeting URL are skipped.
 */
export async function fetchMeetings(fromDate, toDate) {
  const token = await getToken();
  const creds = appCreds();
  const base = creds
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(creds.upn)}`
    : 'https://graph.microsoft.com/v1.0/me';
  const meetings = [];
  let url =
    `${base}/calendarView` +
    `?startDateTime=${fromDate.toISOString()}&endDateTime=${toDate.toISOString()}` +
    `&$select=id,subject,location,start,end&$top=100`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) throw new Error(`Graph error ${res.status}: ${await res.text()}`);
    const body = await res.json();
    for (const ev of body.value) {
      const loc = parseEventLocation(ev.location);
      if (!loc.name || isVirtual(loc.name)) continue;
      meetings.push({
        id: ev.id,
        subject: ev.subject || '(no subject)',
        location: loc.name,
        address: loc.address,
        lat: loc.lat,
        lon: loc.lon,
        start: new Date(ev.start.dateTime + 'Z'),
        end: new Date(ev.end.dateTime + 'Z'),
      });
    }
    url = body['@odata.nextLink'] || null;
  }
  return meetings;
}

const VIRTUAL_PATTERNS = [/^https?:\/\//i, /zoom\.us/i, /teams\.microsoft/i, /meet\.google/i, /webex/i, /^microsoft teams/i];

export function isVirtual(location) {
  return VIRTUAL_PATTERNS.some((p) => p.test(location));
}
