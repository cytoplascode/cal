/**
 * calendar-api.js — Google Calendar API v3 helpers.
 *
 * All functions are exposed as globals (no ES modules) so they can be used
 * directly by app.js without a build step.
 */

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

// ── HTTP Helper ───────────────────────────────────────────────────────────────

/**
 * Perform a GET request against the Google Calendar API.
 *
 * @param {string} path   — e.g. '/calendars/primary/events'
 * @param {Object} params — query parameters (values are URL-encoded)
 * @param {string} token  — OAuth2 access token
 * @returns {Promise<Object>} Parsed JSON body
 * @throws {Object} Error with `.status` (number) and `.body` (parsed JSON or null)
 */
async function calApiGet(path, params, token) {
  const url = new URL(GCAL_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  let body = null;
  try {
    body = await resp.json();
  } catch (_) {
    // Non-JSON response; leave body as null.
  }

  if (!resp.ok) {
    const err = new Error(`Calendar API error ${resp.status}: ${path}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }

  return body;
}

// ── Write Helpers ─────────────────────────────────────────────────────────────

async function calApiWrite(method, path, body, token) {
  const resp = await fetch(GCAL_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  let parsed = null;
  try { parsed = await resp.json(); } catch (_) {}

  if (!resp.ok) {
    const err = new Error(`Calendar API ${method} error ${resp.status}: ${path}`);
    err.status = resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function calApiPost(path, body, token) {
  return calApiWrite('POST', path, body, token);
}

async function calApiPatch(path, body, token) {
  return calApiWrite('PATCH', path, body, token);
}

async function calApiMove(calendarId, eventId, destinationCalendarId, token) {
  const url = new URL(`${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/move`);
  url.searchParams.set('destination', destinationCalendarId);
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  let parsed = null;
  try { parsed = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    const err = new Error(`Calendar API move error ${resp.status}`);
    err.status = resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function calApiDelete(path, token) {
  const resp = await fetch(GCAL_BASE + path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 204 = success, 404 = already gone — both are acceptable
  if (!resp.ok && resp.status !== 404) {
    const err = new Error(`Calendar API DELETE error ${resp.status}: ${path}`);
    err.status = resp.status;
    throw err;
  }
}


/**
 * Fetch all calendars from the user's calendar list.
 *
 * @param {string} token — OAuth2 access token
 * @returns {Promise<Object[]>} Array of CalendarListEntry objects
 */
async function fetchCalendarList(token) {
  const calendars = [];
  let pageToken = undefined;

  do {
    const data = await calApiGet('/users/me/calendarList', {
      maxResults: 250,
      pageToken,
    }, token);

    if (data.items) {
      calendars.push(...data.items);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return calendars;
}

// ── Calendar Events ───────────────────────────────────────────────────────────

/**
 * Fetch events for a single calendar, with support for full and incremental sync.
 *
 * Full sync (no syncToken):
 *   Uses timeMin and timeMax to constrain the window. Paginates automatically.
 *
 * Incremental sync (syncToken provided):
 *   Fetches only changes since the last sync token. Paginates automatically.
 *   May return events with status 'cancelled' (deletions).
 *
 * @param {string} calendarId
 * @param {string} token           — OAuth2 access token
 * @param {Object} [options]
 * @param {string} [options.syncToken]  — Incremental sync token from a prior call
 * @param {string} [options.timeMin]    — RFC3339 lower bound (full sync only)
 * @param {string} [options.timeMax]    — RFC3339 upper bound (full sync only)
 * @returns {Promise<{ events: Object[], nextSyncToken: string }>}
 */
async function fetchCalendarEvents(calendarId, token, { syncToken, timeMin, timeMax } = {}) {
  const events = [];
  let pageToken = undefined;
  let nextSyncToken = undefined;

  // Base parameters shared by every page request.
  const baseParams = {
    maxResults: 2500,
    singleEvents: 'true',
  };

  if (syncToken) {
    // Incremental sync: the sync token encodes the window, so we must not add
    // timeMin / timeMax or orderBy.
    baseParams.syncToken = syncToken;
  } else {
    // Full sync: constrain by time window and sort ascending for rendering.
    baseParams.orderBy = 'startTime';
    if (timeMin) baseParams.timeMin = timeMin;
    if (timeMax) baseParams.timeMax = timeMax;
    // Include deleted events so we can handle them in incremental syncs later.
    baseParams.showDeleted = 'true';
  }

  do {
    const params = { ...baseParams };
    if (pageToken) params.pageToken = pageToken;

    const data = await calApiGet(
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      params,
      token
    );

    if (data.items) {
      // Attach the originating calendarId so the UI can look up calendar colours.
      for (const event of data.items) {
        event.calendarId = calendarId;
        events.push(event);
      }
    }

    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken; // Only present on the last page.
  } while (pageToken);

  return { events, nextSyncToken };
}
