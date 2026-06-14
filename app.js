/**
 * app.js — Main application logic for the Google Calendar PWA.
 */

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
// 1. Go to https://console.cloud.google.com/apis/credentials
// 2. Create an OAuth 2.0 Client ID (Web application type)
// 3. Add your GitHub Pages URL to "Authorised JavaScript origins"
//    e.g. https://YOUR_USERNAME.github.io
// 4. Paste the Client ID below

/** Validate a Google OAuth Client ID to prevent injection attacks. */
function isValidClientId(clientId) {
  return /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId);
}

const CONFIG = {
  // Client ID can be overridden at runtime via the welcome screen input
  // (stored in localStorage so you only type it once).
  CLIENT_ID: (() => {
    const storedId = localStorage.getItem('clientId');
    return isValidClientId(storedId) ? storedId : 'YOUR_CLIENT_ID.apps.googleusercontent.com';
  })(),
  SCOPES: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
  SYNC_DAYS_PAST: 120,   // ~4 months back
  SYNC_DAYS_FUTURE: 365, // 12 months forward
};
// ──────────────────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let syncInProgress = false;
let deferredInstallPrompt = null;

// Column assignment — which calendar maps to each column ('' = Auto by status).
let confirmedCalId = localStorage.getItem('confirmedCalId') || '';
let possibleCalId  = localStorage.getItem('possibleCalId')  || '';
let onCallCalId    = localStorage.getItem('onCallCalId')    || '';

function selectedCalIds() {
  return [confirmedCalId, possibleCalId, onCallCalId].filter(Boolean);
}

// Event editor state.
let modalEditingEvent = null;

// Infinite-scroll rendering state
const viewState = {
  startYear: 0,
  startMonth: 0,
  endYear: 0,
  endMonth: 0,
  observer: null,
  // Cached data, refreshed on each full render
  allEvents: [],
  calMap: {},
};

// ── DOM References ────────────────────────────────────────────────────────────

const elBtnMenu    = document.getElementById('btn-menu');
const elAppMenu    = document.getElementById('app-menu');
const elMenuSelectConfirmed  = document.getElementById('menu-select-confirmed');
const elMenuSelectPossible   = document.getElementById('menu-select-possible');
const elMenuSelectOnCall     = document.getElementById('menu-select-oncall');
const elSetupSelectConfirmed = document.getElementById('setup-select-confirmed');
const elSetupSelectPossible  = document.getElementById('setup-select-possible');
const elSetupSelectOnCall    = document.getElementById('setup-select-oncall');
const elEventModal     = document.getElementById('event-modal');
const elModalBackdrop  = document.getElementById('modal-backdrop');
const elModalTitle     = document.getElementById('modal-title-heading');
const elModalBtnDelete = document.getElementById('modal-btn-delete');
const elModalInputTitle = document.getElementById('modal-input-title');
const elModalInputStart = document.getElementById('modal-input-start');
const elModalInputEnd   = document.getElementById('modal-input-end');
const elModalBtnConfirmed   = document.getElementById('modal-btn-confirmed');
const elModalBtnPossible    = document.getElementById('modal-btn-possible');
const elModalColorSwatches = document.getElementById('modal-color-swatches');
const elModalBtnCancel  = document.getElementById('modal-btn-cancel');
const elModalBtnSave    = document.getElementById('modal-btn-save');
const elLegendAside  = document.getElementById('legend-aside');
const elLegendBody   = document.getElementById('legend-body');
const elLegendToggle = document.getElementById('legend-toggle');
const elBtnSignin = document.getElementById('btn-signin');
const elBtnSigninWelcome = document.getElementById('btn-signin-welcome');
const elInputClientId    = document.getElementById('input-client-id');
const elBtnSignout = document.getElementById('btn-signout');
const elBtnRefresh = document.getElementById('btn-refresh');
const elBtnInstall = document.getElementById('btn-install');
const elBtnInstallDismiss = document.getElementById('btn-install-dismiss');
const elWelcomeScreen = document.getElementById('welcome-screen');
const elLoadingScreen = document.getElementById('loading-screen');
const elLoadingMessage = document.getElementById('loading-message');
const elCalendarSetup = document.getElementById('calendar-setup');
const elBtnSetupDone = document.getElementById('btn-setup-done');
const elBtnTheme  = document.getElementById('btn-theme');
const elThemeIcon = document.getElementById('theme-icon');
const elAgendaView = document.getElementById('agenda-view');
const elOfflineBanner = document.getElementById('offline-banner');
const elInstallBanner = document.getElementById('install-banner');
const elRecentAside  = document.getElementById('recent-aside');
const elRecentBody   = document.getElementById('recent-body');
const elRecentToggle = document.getElementById('recent-toggle');

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Initialise the GIS token client. Called from DOMContentLoaded.
 * Retries automatically until the GIS script has loaded.
 */
function initAuth() {
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initAuth, 200);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    // Remember the last-used account so silent refresh doesn't prompt for
    // account selection on every page load.
    hint: localStorage.getItem('userHint') || undefined,
    callback: handleToken,
  });

  // If the user was previously signed in, restore the shell and either render
  // from cache (if setup is done) or show a spinner until sync runs setup.
  if (localStorage.getItem('isSignedIn') === 'true') {
    showSignedInShell();
    if (localStorage.getItem('calSetupDone')) {
      renderCalendarView();
    } else {
      showLoading('Syncing your calendar…');
    }
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

/**
 * GIS token callback — fires on every successful (or failed) token grant.
 * @param {Object} resp — TokenResponse from the GIS library
 */
function handleToken(resp) {
  if (resp.error) {
    console.error('GIS token error:', resp.error, resp.error_description);
    // If a silent refresh failed, the session is invalid — sign the user out.
    if (localStorage.getItem('isSignedIn') === 'true') {
      signOut();
    }
    return;
  }

  accessToken = resp.access_token;
  // Subtract 60 s from the server-side expiry as a safety buffer.
  tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
  localStorage.setItem('isSignedIn', 'true');
  onSignedIn();
}

/**
 * Trigger the Google account picker / consent flow.
 * With prompt:'' the GIS library silently returns a token when the user has
 * already granted access; otherwise the picker/consent screen is shown.
 */
function signIn() {
  if (!tokenClient) {
    initAuth();
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

/**
 * Revoke the current token, clear local auth state, and return to the
 * welcome screen.
 */
function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem('isSignedIn');
  localStorage.removeItem('userHint');
  onSignedOut();
}

/**
 * Return the stored access token if it is still valid, otherwise request a
 * new one silently (the result will arrive via handleToken).
 * @returns {string|null}
 */
function getValidToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }
  if (tokenClient) {
    tokenClient.requestAccessToken({ prompt: '' });
  }
  return null;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Compute the RFC3339 boundaries for the sync window.
 * @returns {{ timeMin: string, timeMax: string }}
 */
function buildSyncWindow() {
  const now = new Date();
  const past = new Date(now);
  past.setDate(past.getDate() - CONFIG.SYNC_DAYS_PAST);
  const future = new Date(now);
  future.setDate(future.getDate() + CONFIG.SYNC_DAYS_FUTURE);
  return { timeMin: past.toISOString(), timeMax: future.toISOString() };
}

/**
 * Full sync for a single calendar: fetch all events in the configured window,
 * remove stale cached events for that calendar, and upsert fresh ones.
 *
 * @param {string} calendarId
 * @param {{ timeMin: string, timeMax: string }} window
 */
async function fullSyncCalendar(calendarId, window) {
  const { events, nextSyncToken } = await fetchCalendarEvents(
    calendarId,
    accessToken,
    { timeMin: window.timeMin, timeMax: window.timeMax }
  );

  // Remove any existing events for this calendar so stale data is purged.
  const existing = await DB.getAllEvents();
  for (const ev of existing) {
    if (ev.calendarId === calendarId) {
      await DB.deleteEvent(ev.id);
    }
  }

  for (const event of events) {
    if (event.status !== 'cancelled') {
      await DB.putEvent(event);
    }
  }

  if (nextSyncToken) {
    await DB.setMeta(`syncToken_${calendarId}`, nextSyncToken);
  }
}

/**
 * Incremental sync for a single calendar using a stored sync token.
 * Falls back to a full sync when the server returns 410 Gone.
 *
 * @param {string} calendarId
 * @param {string} syncToken
 * @param {{ timeMin: string, timeMax: string }} window — used for the full-sync fallback
 */
async function incrementalSyncCalendar(calendarId, syncToken, window) {
  try {
    const { events, nextSyncToken } = await fetchCalendarEvents(
      calendarId,
      accessToken,
      { syncToken }
    );

    for (const event of events) {
      if (event.status === 'cancelled') {
        await DB.deleteEvent(event.id);
      } else {
        await DB.putEvent(event);
      }
    }

    if (nextSyncToken) {
      await DB.setMeta(`syncToken_${calendarId}`, nextSyncToken);
    }
  } catch (err) {
    if (err.status === 410) {
      // Sync token expired — clear the stored token and do a full sync.
      console.info(`Sync token expired for ${calendarId}; falling back to full sync.`);
      await DB.setMeta(`syncToken_${calendarId}`, undefined);
      // Clear stale events for this calendar before re-fetching.
      const allEvents = await DB.getAllEvents();
      for (const ev of allEvents) {
        if (ev.calendarId === calendarId) {
          await DB.deleteEvent(ev.id);
        }
      }
      await fullSyncCalendar(calendarId, window);
    } else {
      throw err;
    }
  }
}

/**
 * Main sync entry point. Fetches the calendar list (with DB fallback when
 * offline), decides between full and incremental sync per calendar, then
 * re-renders the calendar view.
 */
async function sync() {
  if (syncInProgress) return;
  if (!accessToken) return;

  syncInProgress = true;
  setRefreshSpinning(true);

  // Only show the full-page loading screen on a fresh load (view not yet populated).
  if (elAgendaView.hidden) {
    showLoading('Syncing your calendar…');
  }

  try {
    // ── Calendar list ───────────────────────────────────────────────────────
    let calendars;
    try {
      calendars = await fetchCalendarList(accessToken);
      for (const cal of calendars) {
        await DB.putCalendar(cal);
      }
      // The primary calendar's id is the user's email — save it as a hint
      // so subsequent silent token refreshes skip the account picker.
      const primary = calendars.find((c) => c.primary) || calendars.find((c) => c.id?.includes('@'));
      if (primary?.id) localStorage.setItem('userHint', primary.id);
    } catch (err) {
      if (!navigator.onLine) {
        calendars = await DB.getAllCalendars();
      } else {
        throw err;
      }
    }

    if (!calendars.length) {
      hideLoading();
      await renderCalendarView();
      return;
    }

    // ── Events sync ─────────────────────────────────────────────────────────
    if (navigator.onLine) {
      const window = buildSyncWindow();

      await Promise.allSettled(
        calendars.map(async (cal) => {
          const storedToken = await DB.getMeta(`syncToken_${cal.id}`);
          if (storedToken) {
            await incrementalSyncCalendar(cal.id, storedToken, window);
          } else {
            await fullSyncCalendar(cal.id, window);
          }
        })
      );
    }
  } catch (err) {
    if (err.status === 401) {
      signOut();
      return;
    }
    console.error('Sync error:', err);
  } finally {
    syncInProgress = false;
    setRefreshSpinning(false);
    hideLoading();
  }

  // First-time login: show the calendar setup screen instead of the view.
  if (!localStorage.getItem('calSetupDone')) {
    const allCalendars = await DB.getAllCalendars();
    showCalendarSetup(allCalendars);
    return;
  }

  await renderCalendarView();
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_ABBR = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// Keyword-based colour categories (checked before calendar colour).
const COLOR_CATEGORIES = [
  {
    color: '#d93025',
    keywords: ['flight', 'fly ', 'airport', 'hotel', 'airbnb', 'hostel',
               'check-in', 'checkout', 'train', 'travel', 'trip', 'vacation',
               'holiday', 'journey', 'cruise', 'arrive', 'depart'],
  },
  {
    color: '#f29900',
    keywords: ['dinner', 'lunch', 'brunch', 'breakfast', 'drinks', 'birthday',
               'party', 'wedding', 'anniversary', 'coffee', 'visit', 'see ',
               'meet ', 'gathering', 'celebration', 'bbq'],
  },
  {
    color: '#188038',
    keywords: ['doctor', 'dentist', 'hospital', 'clinic', 'yoga', 'gym',
               'therapy', 'massage', 'spa', 'physio', 'appointment', 'checkup',
               'vipassana', 'meditation', 'run ', 'hike'],
  },
  {
    color: '#1a73e8',
    keywords: ['meeting', 'standup', 'stand-up', 'review', 'retrospective',
               'planning', 'interview', 'conference', 'workshop', 'on call',
               'oncall', 'summit', 'sprint', 'kickoff'],
  },
];

const GCAL_COLOR_PALETTE = {
  '1':  '#a4bdfc', '2':  '#7ae7bf', '3':  '#dbadff', '4':  '#ff887c',
  '5':  '#fbd75b', '6':  '#ffb878', '7':  '#46d6db', '8':  '#e1e1e1',
  '9':  '#5484ed', '10': '#51b749', '11': '#dc2127',
};

// Fixed grey used for everything in the "possible" column / calendar.
const POSSIBLE_GREY = '#9aa0a6';

function isPossibleEvent(event) {
  return possibleCalId
    ? event.calendarId === possibleCalId
    : event.status === 'tentative';
}

function getEventColor(event, calMap) {
  // Possible events are always grey, everywhere.
  if (isPossibleEvent(event)) return POSSIBLE_GREY;
  // All tentative events share a single neutral colour.
  if (event.status === 'tentative') return '#757575';
  if (event.colorId && GCAL_COLOR_PALETTE[event.colorId]) {
    return GCAL_COLOR_PALETTE[event.colorId];
  }
  const title = (event.summary || '').toLowerCase();
  for (const cat of COLOR_CATEGORIES) {
    if (cat.keywords.some((kw) => title.includes(kw))) {
      return cat.color;
    }
  }
  return calMap[event.calendarId]?.color || '#1a73e8';
}

/** Return local YYYY-MM-DD for a Date object. */
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Return YYYY-MM-DD for an event's start (works for both dateTime and date). */
function eventDateKey(event) {
  return event.start.date || event.start.dateTime.slice(0, 10);
}

/** Return the inclusive last YYYY-MM-DD an event covers. */
function eventEndKey(event) {
  const startKey = eventDateKey(event);
  if (event.start.date && event.end?.date) {
    // All-day end.date is exclusive — step back one day for the inclusive end.
    const end = new Date(event.end.date + 'T00:00:00');
    end.setDate(end.getDate() - 1);
    const incl = localDateKey(end);
    return incl < startKey ? startKey : incl;
  }
  if (event.start.dateTime && event.end?.dateTime) {
    return event.end.dateTime.slice(0, 10);
  }
  return startKey;
}

/** Add delta months to (year, month) and return normalised {y, m}. */
function addMonths(year, month, delta) {
  let m = month + delta;
  let y = year;
  while (m >= 12) { m -= 12; y++; }
  while (m < 0)   { m += 12; y--; }
  return { y, m };
}

/** Escape a string for safe innerHTML insertion. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Calendar view rendering ───────────────────────────────────────────────────

/**
 * Top-level render: loads all events and calendars from DB, then builds the
 * initial set of month blocks and wires up infinite scroll.
 */
async function renderCalendarView() {
  const [allEvents, allCalendars] = await Promise.all([
    DB.getAllEvents(),
    DB.getAllCalendars(),
  ]);

  const calMap = {};
  for (const cal of allCalendars) {
    calMap[cal.id] = { color: cal.backgroundColor || '#1a73e8', name: cal.summary || cal.id };
  }

  viewState.allEvents = allEvents;
  viewState.calMap = calMap;

  buildAppMenu(allCalendars);

  // Disconnect any previous observer before rebuilding.
  if (viewState.observer) {
    viewState.observer.disconnect();
    viewState.observer = null;
  }

  elAgendaView.innerHTML = '';

  const today = new Date();

  // Render: 3 months back → current → 11 months forward (15 months).
  const { y: sy, m: sm } = addMonths(today.getFullYear(), today.getMonth(), -3);
  const { y: ey, m: em } = addMonths(today.getFullYear(), today.getMonth(), 11);
  viewState.startYear = sy; viewState.startMonth = sm;
  viewState.endYear   = ey; viewState.endMonth   = em;

  // Top sentinel (for backwards infinite scroll).
  const topSentinel = document.createElement('div');
  topSentinel.className = 'scroll-sentinel scroll-sentinel-top';
  elAgendaView.appendChild(topSentinel);

  for (let i = 0; i < 15; i++) {
    const { y, m } = addMonths(sy, sm, i);
    elAgendaView.appendChild(buildMonthBlock(y, m));
  }

  // Bottom sentinel (for forwards infinite scroll).
  const bottomSentinel = document.createElement('div');
  bottomSentinel.className = 'scroll-sentinel scroll-sentinel-bottom';
  elAgendaView.appendChild(bottomSentinel);

  setupInfiniteScroll();

  elAgendaView.hidden = false;
  elLegendAside.hidden = false;
  buildLegend();
  buildRecentPanel();

  // Scroll to current month without animation.
  const currentBlock = elAgendaView.querySelector(
    `[data-year="${today.getFullYear()}"][data-month="${today.getMonth()}"]`
  );
  if (currentBlock) {
    currentBlock.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

function setupInfiniteScroll() {
  const bottomSentinel = elAgendaView.querySelector('.scroll-sentinel-bottom');
  const topSentinel    = elAgendaView.querySelector('.scroll-sentinel-top');

  viewState.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === bottomSentinel) appendMonths(3);
      if (entry.target === topSentinel)    prependMonths(3);
    }
  }, { rootMargin: '400px' });

  viewState.observer.observe(topSentinel);
  viewState.observer.observe(bottomSentinel);
}

function appendMonths(count) {
  const sentinel = elAgendaView.querySelector('.scroll-sentinel-bottom');
  for (let i = 1; i <= count; i++) {
    const { y, m } = addMonths(viewState.endYear, viewState.endMonth, i);
    elAgendaView.insertBefore(buildMonthBlock(y, m), sentinel);
  }
  const { y, m } = addMonths(viewState.endYear, viewState.endMonth, count);
  viewState.endYear = y; viewState.endMonth = m;
}

function prependMonths(count) {
  const sentinel   = elAgendaView.querySelector('.scroll-sentinel-top');
  const prevHeight = document.documentElement.scrollHeight;
  const prevScrollY = window.scrollY;

  // Insert in reverse so order is correct.
  for (let i = count; i >= 1; i--) {
    const { y, m } = addMonths(viewState.startYear, viewState.startMonth, -i);
    elAgendaView.insertBefore(buildMonthBlock(y, m), sentinel.nextSibling);
  }
  const { y, m } = addMonths(viewState.startYear, viewState.startMonth, -count);
  viewState.startYear = y; viewState.startMonth = m;

  // Restore scroll position so the user doesn't jump.
  const heightDelta = document.documentElement.scrollHeight - prevHeight;
  window.scrollTo(0, prevScrollY + heightDelta);
}

// ── App menu (⋮) ──────────────────────────────────────────────────────────────

function populateColAssignSelects(elConfirmed, elPossible, elOnCall, calendars) {
  const noneOpt = '<option value="">— None —</option>';
  const calOpts = calendars
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.summary || c.id)}</option>`)
    .join('');
  elConfirmed.innerHTML = noneOpt + calOpts;
  elPossible.innerHTML  = noneOpt + calOpts;
  elOnCall.innerHTML    = noneOpt + calOpts;
  elConfirmed.value = confirmedCalId;
  elPossible.value  = possibleCalId;
  elOnCall.value    = onCallCalId;
}

function buildAppMenu(calendars) {
  populateColAssignSelects(elMenuSelectConfirmed, elMenuSelectPossible, elMenuSelectOnCall, calendars);
}

function openMenu() {
  elAppMenu.hidden = false;
  elBtnMenu.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  elAppMenu.hidden = true;
  elBtnMenu.setAttribute('aria-expanded', 'false');
}

// ── Calendar setup screen (first login) ───────────────────────────────────────

function showCalendarSetup(calendars) {
  populateColAssignSelects(elSetupSelectConfirmed, elSetupSelectPossible, elSetupSelectOnCall, calendars);

  elWelcomeScreen.hidden = true;
  elLoadingScreen.hidden = true;
  elAgendaView.hidden    = true;
  elLegendAside.hidden   = true;
  elCalendarSetup.hidden = false;
}

// ── Month block ───────────────────────────────────────────────────────────────

function buildMonthBlock(year, month) {
  const { allEvents, calMap } = viewState;

  // Only events from the chosen confirmed / possible / on-call calendars.
  // An event is included when its date range overlaps this month (so events
  // spanning a month boundary appear in both months).
  const mm = String(month + 1).padStart(2, '0');
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, '0')}`;
  const sel = selectedCalIds();
  const monthEvents = allEvents.filter(
    (ev) => ev.status !== 'cancelled'
         && (sel.length === 0 || sel.includes(ev.calendarId))
         && eventDateKey(ev) <= monthEnd
         && eventEndKey(ev) >= monthStart
  );

  const sortKey = (ev) => ev.start.dateTime || (ev.start.date + 'T00:00:00');
  const sortFn = (a, b) => sortKey(a) < sortKey(b) ? -1 : 1;

  // Split events into columns: by calendarId if assigned, otherwise by tentative status.
  // On-call events appear in the mini-cal only (excluded from both columns).
  const confirmed = [], possible = [];
  for (const ev of monthEvents) {
    if (onCallCalId && ev.calendarId === onCallCalId) continue;
    if (possibleCalId && ev.calendarId === possibleCalId) {
      possible.push(ev);
    } else if (confirmedCalId && ev.calendarId === confirmedCalId) {
      confirmed.push(ev);
    } else if (!possibleCalId && !confirmedCalId) {
      (ev.status === 'tentative' ? possible : confirmed).push(ev);
    } else {
      confirmed.push(ev);
    }
  }
  confirmed.sort(sortFn);
  possible.sort(sortFn);

  const section = document.createElement('section');
  section.className = 'month-row';
  section.dataset.year  = year;
  section.dataset.month = month;

  // Left: mini calendar.
  const calCol = document.createElement('div');
  calCol.className = 'month-cal-col';

  // Month name row with "+" button.
  const nameRow = document.createElement('div');
  nameRow.className = 'month-name-row';
  const nameEl = document.createElement('div');
  nameEl.className = 'month-name';
  nameEl.textContent = MONTH_NAMES[month].toUpperCase();
  const addBtn = document.createElement('button');
  addBtn.className = 'month-add-btn icon-btn';
  addBtn.setAttribute('aria-label', `Add event in ${MONTH_NAMES[month]} ${year}`);
  addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/></svg>';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const today = new Date();
    const defaultDate = (today.getFullYear() === year && today.getMonth() === month)
      ? localDateKey(today)
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    openEventModal(null, defaultDate);
  });
  nameRow.appendChild(nameEl);
  nameRow.appendChild(addBtn);
  calCol.appendChild(nameRow);
  calCol.appendChild(buildMiniCal(year, month, monthEvents));
  section.appendChild(calCol);

  // Middle + Right: event columns.
  section.appendChild(buildEventsCol('confirmed-col', 'Confirmed', confirmed, year, month));
  section.appendChild(buildEventsCol('possible-col', 'Possible', possible, year, month));

  return section;
}

// ── Mini calendar ─────────────────────────────────────────────────────────────

/**
 * Build a CSS background that splits a square into N equal parts, one per
 * colour: 1 = solid, 2 = vertical halves, 3 = vertical thirds, 4 = quarters.
 */
function buildDayBg(cols) {
  if (cols.length === 1) return cols[0];
  if (cols.length === 2) {
    return `linear-gradient(90deg, ${cols[0]} 0 50%, ${cols[1]} 50% 100%)`;
  }
  if (cols.length === 3) {
    return `linear-gradient(90deg, ${cols[0]} 0 33.333%, ` +
           `${cols[1]} 33.333% 66.666%, ${cols[2]} 66.666% 100%)`;
  }
  return [
    `linear-gradient(${cols[0]},${cols[0]}) top left`,
    `linear-gradient(${cols[1]},${cols[1]}) top right`,
    `linear-gradient(${cols[2]},${cols[2]}) bottom left`,
    `linear-gradient(${cols[3]},${cols[3]}) bottom right`,
  ].map((b) => `${b}/50% 50% no-repeat`).join(', ');
}

function buildMiniCal(year, month, events) {
  const { calMap } = viewState;

  // Map of day-number → array of { color, type } where type: 'confirmed'|'possible'|'oncall'
  const dayColors = {};

  function markDay(dayNum, color, type) {
    if (!dayColors[dayNum]) dayColors[dayNum] = [];
    dayColors[dayNum].push({ color, type });
  }

  for (const ev of events) {
    let type, color;
    if (onCallCalId && ev.calendarId === onCallCalId) {
      type = 'oncall';
      color = '#f9ab00';
    } else if (isPossibleEvent(ev)) {
      type = 'possible';
      color = POSSIBLE_GREY;
    } else {
      type = 'confirmed';
      color = getEventColor(ev, calMap);
    }
    // Shade every day the event covers that falls within this month
    // (inclusive range; works across month boundaries).
    const cur = new Date(eventDateKey(ev) + 'T00:00:00');
    const end = new Date(eventEndKey(ev) + 'T00:00:00');
    while (cur <= end) {
      if (cur.getFullYear() === year && cur.getMonth() === month) {
        markDay(cur.getDate(), color, type);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  const today    = new Date();
  const tY = today.getFullYear(), tM = today.getMonth(), tD = today.getDate();
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  // getDay() returns 0=Sun; convert to Mon-first: 0=Mon … 6=Sun
  const firstDayMon  = (new Date(year, month, 1).getDay() + 6) % 7;

  const table = document.createElement('table');
  table.className = 'mini-cal';
  table.setAttribute('aria-label', `${MONTH_NAMES[month]} ${year}`);

  // Header row.
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const abbr of DAY_ABBR) {
    const th = document.createElement('th');
    th.textContent = abbr;
    if (abbr === 'Sa' || abbr === 'Su') th.className = 'weekend-col';
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody  = document.createElement('tbody');
  let   row    = document.createElement('tr');
  let   dayNum = 1;

  // Leading empty cells.
  for (let i = 0; i < firstDayMon; i++) {
    row.appendChild(document.createElement('td'));
  }

  for (let col = firstDayMon; dayNum <= daysInMonth; col++) {
    if (col > 0 && col % 7 === 0) {
      tbody.appendChild(row);
      row = document.createElement('tr');
    }

    const td  = document.createElement('td');
    const colors = dayColors[dayNum] || [];
    const isToday = year === tY && month === tM && dayNum === tD;
    const isPast  = new Date(year, month, dayNum) < new Date(tY, tM, tD);
    const colIdx  = (firstDayMon + dayNum - 1) % 7;
    const isWeekend = colIdx >= 5;

    if (isToday)   td.classList.add('day-today');
    if (isPast)    td.classList.add('day-past');
    if (isWeekend) td.classList.add('day-weekend');

    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    td.tabIndex = 0;
    td.setAttribute('role', 'button');
    td.setAttribute('aria-label', `Create event on ${MONTH_NAMES[month]} ${dayNum}, ${year}`);
    td.addEventListener('click', () => openEventModal(null, dateStr));
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEventModal(null, dateStr);
      }
    });

    const numSpan = document.createElement('span');
    numSpan.className = 'day-num';
    numSpan.textContent = dayNum;
    td.appendChild(numSpan);

    const confirmedColors = colors.filter((c) => c.type === 'confirmed').map((c) => c.color);
    const hasPossible = colors.some((c) => c.type === 'possible');
    const hasOnCall   = colors.some((c) => c.type === 'oncall');

    // Confirmed events colour the day's background square (split if multiple).
    if (confirmedColors.length > 0) {
      numSpan.classList.add('day-bg');
      numSpan.style.background = buildDayBg(confirmedColors.slice(0, 4));
    }

    // Possible → single grey dot; on-call → single yellow dot.
    const dotColors = [];
    if (hasPossible) dotColors.push('#9aa0a6');
    if (hasOnCall)   dotColors.push('#f9ab00');
    if (dotColors.length > 0) {
      const dotRow = document.createElement('div');
      dotRow.className = 'day-dots';
      for (const dotColor of dotColors) {
        const dot = document.createElement('span');
        dot.className = 'day-dot';
        dot.style.backgroundColor = dotColor;
        dotRow.appendChild(dot);
      }
      td.appendChild(dotRow);
    }

    row.appendChild(td);
    dayNum++;
  }

  // Trailing empty cells to complete the last row.
  const lastCol = (firstDayMon + daysInMonth - 1) % 7;
  if (lastCol < 6) {
    for (let i = lastCol + 1; i <= 6; i++) row.appendChild(document.createElement('td'));
  }
  tbody.appendChild(row);
  table.appendChild(tbody);
  return table;
}

// ── Event columns ─────────────────────────────────────────────────────────────

function buildEventsCol(className, headerText, events, year, month) {
  const col = document.createElement('div');
  col.className = `events-col ${className}`;

  const header = document.createElement('div');
  header.className = 'col-header';
  header.textContent = headerText;
  col.appendChild(header);

  for (const ev of events) {
    col.appendChild(buildEventEntry(ev, year, month));
  }

  return col;
}

function buildEventEntry(event, year, month) {
  const { calMap } = viewState;
  const color = getEventColor(event, calMap);

  const div = document.createElement('div');
  div.className = 'event-entry';
  div.style.setProperty('--event-color', color);

  // Date chip: "14" for single-day, "21–27" for multi-day, "14 · 9am" for timed.
  const chip = document.createElement('span');
  chip.className = 'entry-chip';
  chip.textContent = formatEntryDate(event, year, month);
  chip.style.cssText = `background:${color}22; color:${color};`;

  const title = document.createElement('span');
  title.className = 'entry-title';
  title.textContent = event.summary || '(No title)';

  div.appendChild(chip);
  div.appendChild(title);

  div.addEventListener('click', () => openEventModal(event, null));
  return div;
}

function formatEntryDate(event, year, month) {
  const evStart = new Date(eventDateKey(event) + 'T00:00:00');
  const evEnd   = new Date(eventEndKey(event) + 'T00:00:00');

  // Clamp the event's range to the month being rendered so cross-month
  // events show the correct portion in each month.
  const monthFirst = new Date(year, month, 1);
  const monthLast  = new Date(year, month + 1, 0);
  const visStart = evStart < monthFirst ? monthFirst : evStart;
  const visEnd   = evEnd   > monthLast  ? monthLast  : evEnd;

  if (visEnd > visStart) {
    return `${visStart.getDate()}–${visEnd.getDate()}`;
  }
  return String(visStart.getDate());
}

// ── Event editor modal ────────────────────────────────────────────────────────

const GCAL_EVENT_COLORS = [
  { id: '11', hex: '#dc2127', label: 'Bank holiday' },
  { id: '3',  hex: '#dbadff', label: 'Alice away' },
  { id: '7',  hex: '#46d6db', label: 'Philippe away' },
  { id: '10', hex: '#51b749', label: 'Time off both' },
  { id: '9',  hex: '#5484ed', label: 'Event in London' },
  { id: '6',  hex: '#ffb878', label: 'Travelling together like otters' },
  { id: '4',  hex: '#ff887c', label: 'Both travelling apart and very sad' },
];

function buildColorSwatches(selectedId) {
  elModalColorSwatches.innerHTML = '';
  for (const { id, hex, label } of GCAL_EVENT_COLORS) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'color-swatch-row';

    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = hex;
    swatch.dataset.colorId = id ?? '';
    if (String(id) === String(selectedId)) swatch.classList.add('swatch-selected');

    const lbl = document.createElement('span');
    lbl.className = 'color-swatch-label';
    lbl.textContent = label;

    row.appendChild(swatch);
    row.appendChild(lbl);

    row.addEventListener('click', () => {
      elModalColorSwatches.querySelectorAll('.color-swatch')
        .forEach((s) => s.classList.remove('swatch-selected'));
      swatch.classList.add('swatch-selected');
    });

    elModalColorSwatches.appendChild(row);
  }
}

function getSelectedColorId() {
  const sel = elModalColorSwatches.querySelector('.color-swatch.swatch-selected');
  return sel ? (sel.dataset.colorId || null) : null;
}

function setModalPlacement(placement) {
  elModalBtnConfirmed.classList.toggle('placement-active', placement === 'confirmed');
  elModalBtnPossible.classList.toggle('placement-active', placement === 'possible');
}

function getModalCalId() {
  const isConfirmed = elModalBtnConfirmed.classList.contains('placement-active');
  const calIds = Object.keys(viewState.calMap);
  const primaryId = calIds.find((id) => id.includes('primary')) || calIds[0] || '';
  return isConfirmed ? (confirmedCalId || primaryId) : (possibleCalId || primaryId);
}

function openEventModal(event, defaultDate) {
  modalEditingEvent = event || null;

  elModalTitle.textContent = event ? 'Edit event' : 'New event';
  elModalInputTitle.value  = event ? (event.summary || '') : '';

  // Start date
  const startDate = event
    ? (event.start.date || event.start.dateTime?.slice(0, 10))
    : defaultDate;
  elModalInputStart.value = startDate || '';
  elModalInputEnd.min = startDate || '';

  // End date (Google's end.date is exclusive; show inclusive). Empty = single day.
  if (event?.end?.date) {
    const endExcl = new Date(event.end.date + 'T00:00:00');
    endExcl.setDate(endExcl.getDate() - 1);
    const endIncl = localDateKey(endExcl);
    elModalInputEnd.value = endIncl !== startDate ? endIncl : '';
  } else {
    elModalInputEnd.value = '';
  }

  // Determine placement (confirmed vs possible) from the event's current calendar.
  const isPossibleEvent = event?.calendarId && possibleCalId && event.calendarId === possibleCalId;
  setModalPlacement(isPossibleEvent ? 'possible' : 'confirmed');

  buildColorSwatches(event?.colorId ?? null);

  elModalBtnDelete.hidden = !event;
  elEventModal.hidden = false;
  // Auto-focus the title input on devices with a real keyboard, but not on
  // touch devices where it would pop up the on-screen keyboard.
  const hasKeyboard = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (hasKeyboard) {
    setTimeout(() => elModalInputTitle.focus(), 50);
  }
}

function closeEventModal() {
  elEventModal.hidden = true;
  modalEditingEvent = null;
}

function buildLegend() {
  elLegendBody.innerHTML = '';

  // On mobile the legend is a top banner — start it collapsed to save space.
  const isMobile = window.innerWidth <= 640;
  elLegendAside.classList.toggle('legend-collapsed', isMobile);
  elLegendToggle.setAttribute('aria-expanded', isMobile ? 'false' : 'true');

  for (const { hex, label } of GCAL_EVENT_COLORS) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = hex;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(swatch);
    item.appendChild(text);
    elLegendBody.appendChild(item);
  }

  const possItem = document.createElement('div');
  possItem.className = 'legend-item';
  const possDot = document.createElement('span');
  possDot.className = 'legend-dot';
  possDot.style.background = '#9aa0a6';
  const possText = document.createElement('span');
  possText.textContent = 'Possible';
  possItem.appendChild(possDot);
  possItem.appendChild(possText);
  elLegendBody.appendChild(possItem);

  const ocItem = document.createElement('div');
  ocItem.className = 'legend-item';
  const ocDot = document.createElement('span');
  ocDot.className = 'legend-dot';
  ocDot.style.background = '#f9ab00';
  const ocText = document.createElement('span');
  ocText.textContent = 'Philippe on-call';
  ocItem.appendChild(ocDot);
  ocItem.appendChild(ocText);
  elLegendBody.appendChild(ocItem);
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const days = Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days}d ago`;
  if (days < 14) return '1 week ago';
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 60) return '1 month ago';
  return `${Math.floor(days / 30)}mo ago`;
}

function buildRecentPanel() {
  const { allEvents, calMap } = viewState;
  const sel = selectedCalIds();

  const events = allEvents
    .filter((ev) => ev.status !== 'cancelled'
      && ev.updated
      && (sel.length === 0 || sel.includes(ev.calendarId)))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .slice(0, 15);

  elRecentBody.innerHTML = '';

  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = 'No recent changes';
    elRecentBody.appendChild(empty);
  } else {
    for (const ev of events) {
      const color = getEventColor(ev, calMap);
      const start = new Date(eventDateKey(ev) + 'T00:00:00');
      const dateStr = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

      const item = document.createElement('button');
      item.className = 'recent-item';
      item.addEventListener('click', () => openEventModal(ev, null));

      const dot = document.createElement('span');
      dot.className = 'recent-dot';
      dot.style.background = color;

      const text = document.createElement('div');
      text.className = 'recent-item-text';

      const title = document.createElement('div');
      title.className = 'recent-item-title';
      title.textContent = ev.summary || '(No title)';

      const meta = document.createElement('div');
      meta.className = 'recent-item-meta';
      meta.textContent = `${dateStr} · ${relativeTime(ev.updated)}`;

      text.appendChild(title);
      text.appendChild(meta);
      item.appendChild(dot);
      item.appendChild(text);
      elRecentBody.appendChild(item);
    }
  }

  const isMobile = window.innerWidth <= 640;
  elRecentAside.classList.toggle('recent-collapsed', isMobile);
  elRecentToggle.setAttribute('aria-expanded', isMobile ? 'false' : 'true');
  elRecentAside.hidden = false;
  refreshStickyTops();
}

function refreshStickyTops() {
  if (window.innerWidth > 640) return;
  const h = elLegendAside.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--legend-panel-h', `${h}px`);
}

async function rerenderInPlace() {
  const prevY = window.scrollY;
  await renderCalendarView();
  window.scrollTo(0, prevY);
}

async function saveModalEvent() {
  const token = getValidToken();
  if (!token) { alert('Not signed in.'); return; }

  const title     = elModalInputTitle.value.trim();
  const startDate = elModalInputStart.value;
  if (!startDate) { elModalInputStart.focus(); return; }

  const endDateIncl  = elModalInputEnd.value || startDate;
  const isPossible   = elModalBtnPossible.classList.contains('placement-active');
  // Possible events are always grey (Graphite) — even on Google Calendar.
  const colorId      = isPossible ? '8' : getSelectedColorId();
  const calendarId   = getModalCalId();

  // Google Calendar uses exclusive end dates for all-day events.
  // setDate (not + 86400000ms) keeps this correct across DST boundaries.
  const endExclD = new Date(endDateIncl + 'T00:00:00');
  endExclD.setDate(endExclD.getDate() + 1);
  const endExclDate = localDateKey(endExclD);

  const body = { summary: title || '(No title)', start: { date: startDate }, end: { date: endExclDate } };
  if (colorId) body.colorId = colorId;

  elModalBtnSave.disabled = true;
  elModalBtnSave.textContent = 'Saving…';
  try {
    let saved;
    if (modalEditingEvent) {
      const origCalId = modalEditingEvent.calendarId;
      if (calendarId !== origCalId) {
        saved = await calApiMove(origCalId, modalEditingEvent.id, calendarId, token);
      }
      saved = await calApiPatch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(modalEditingEvent.id)}`,
        body, token
      );
      saved.calendarId = calendarId;
    } else {
      saved = await calApiPost(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        body, token
      );
      saved.calendarId = calendarId;
    }
    await DB.putEvent(saved);
    const idx = viewState.allEvents.findIndex((e) => e.id === saved.id);
    if (idx >= 0) viewState.allEvents[idx] = saved; else viewState.allEvents.push(saved);
    closeEventModal();
    rerenderInPlace();
  } catch (err) {
    console.error('Save error:', err);
    alert('Failed to save event. Please try again.');
  } finally {
    elModalBtnSave.disabled = false;
    elModalBtnSave.textContent = 'Save';
  }
}

async function deleteModalEvent() {
  if (!modalEditingEvent) return;
  const token = getValidToken();
  if (!token) return;
  if (!confirm(`Delete "${modalEditingEvent.summary || '(No title)'}"?`)) return;

  elModalBtnDelete.disabled = true;
  try {
    await calApiDelete(
      `/calendars/${encodeURIComponent(modalEditingEvent.calendarId)}/events/${encodeURIComponent(modalEditingEvent.id)}`,
      token
    );
    await DB.deleteEvent(modalEditingEvent.id);
    viewState.allEvents = viewState.allEvents.filter((e) => e.id !== modalEditingEvent.id);
    closeEventModal();
    rerenderInPlace();
  } catch (err) {
    console.error('Delete error:', err);
    alert('Failed to delete event.');
  } finally {
    elModalBtnDelete.disabled = false;
  }
}

// ── UI State ──────────────────────────────────────────────────────────────────

/** Show the post-sign-in header chrome without triggering a sync. */
function showSignedInShell() {
  elWelcomeScreen.hidden = true;
  elBtnSignin.hidden     = true;
  elBtnRefresh.hidden    = false;
  elBtnMenu.hidden       = false;
}

/** Called once a token is successfully obtained (initial or refresh). */
function onSignedIn() {
  showSignedInShell();
  sync();
}

/** Called when the user signs out, or a silent token refresh fails. */
function onSignedOut() {
  elWelcomeScreen.hidden    = false;
  elBtnSignin.hidden        = false;
  elBtnRefresh.hidden       = true;
  elBtnMenu.hidden          = true;
  elAgendaView.hidden       = true;
  elLegendAside.hidden      = true;
  elRecentAside.hidden      = true;
  elCalendarSetup.hidden    = true;
  elLoadingScreen.hidden    = true;
  elAgendaView.innerHTML    = '';
  closeMenu();
}

function showLoading(message) {
  if (elLoadingMessage) elLoadingMessage.textContent = message || 'Loading…';
  elLoadingScreen.hidden = false;
}

function hideLoading() {
  elLoadingScreen.hidden = true;
}

function setRefreshSpinning(spinning) {
  if (spinning) {
    elBtnRefresh.classList.add('spinning');
    elBtnRefresh.disabled = true;
  } else {
    elBtnRefresh.classList.remove('spinning');
    elBtnRefresh.disabled = false;
  }
}

function updateOfflineBanner() {
  elOfflineBanner.hidden = navigator.onLine;
}

// ── Theme (auto by time of day / light / dark) ────────────────────────────────

const THEME_ORDER = ['auto', 'light', 'dark'];

const THEME_ICONS = {
  auto: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>',
  light: '<circle cx="12" cy="12" r="5"></circle>' +
         '<line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>' +
         '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>' +
         '<line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>' +
         '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>',
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
};

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  const h = new Date().getHours();
  return (h >= 19 || h < 7) ? 'dark' : 'light';
}

function applyTheme() {
  const pref = localStorage.getItem('themePref') || 'auto';
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  if (elThemeIcon) elThemeIcon.innerHTML = THEME_ICONS[pref];
  if (elBtnTheme) elBtnTheme.setAttribute('aria-label', `Theme: ${pref} (tap to change)`);
}

function cycleTheme() {
  const cur = localStorage.getItem('themePref') || 'auto';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  localStorage.setItem('themePref', next);
  applyTheme();
}

// Re-resolve "auto" as the day progresses.
setInterval(applyTheme, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyTheme();
});

// ── PWA Install Prompt ────────────────────────────────────────────────────────

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  elInstallBanner.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  elInstallBanner.hidden = true;
});

// ── Service Worker Registration ───────────────────────────────────────────────

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();

  applyTheme();
  elBtnTheme.addEventListener('click', cycleTheme);

  elBtnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    elAppMenu.hidden ? openMenu() : closeMenu();
  });

  document.addEventListener('click', (e) => {
    if (!elAppMenu.hidden && !elAppMenu.contains(e.target)) {
      closeMenu();
    }
  });

  // Pre-fill the client-id input from localStorage and save on change.
  elInputClientId.value = localStorage.getItem('clientId') || '';
  elInputClientId.addEventListener('change', () => {
    const id = elInputClientId.value.trim();
    if (id && isValidClientId(id)) {
      localStorage.setItem('clientId', id);
      CONFIG.CLIENT_ID = id;
      // Reinitialise auth so the new ID takes effect immediately.
      tokenClient = null;
      initAuth();
    } else {
      // Clear invalid input and show error
      elInputClientId.value = '';
      alert('Invalid Client ID. Must be in the format: YOUR_CLIENT_ID.apps.googleusercontent.com');
    }
  });

  elBtnSignin.addEventListener('click', signIn);
  elBtnSigninWelcome.addEventListener('click', signIn);
  elBtnSignout.addEventListener('click', signOut);

  elBtnSetupDone.addEventListener('click', async () => {
    confirmedCalId = elSetupSelectConfirmed.value;
    possibleCalId  = elSetupSelectPossible.value;
    onCallCalId    = elSetupSelectOnCall.value;
    localStorage.setItem('confirmedCalId', confirmedCalId);
    localStorage.setItem('possibleCalId',  possibleCalId);
    localStorage.setItem('onCallCalId',    onCallCalId);
    localStorage.setItem('calSetupDone', 'true');
    elCalendarSetup.hidden = true;
    await renderCalendarView();
  });

  // Column-assignment changes in the ⋮ menu
  function saveColAssign() {
    localStorage.setItem('confirmedCalId', confirmedCalId);
    localStorage.setItem('possibleCalId',  possibleCalId);
    localStorage.setItem('onCallCalId',    onCallCalId);
    rerenderInPlace();
  }
  elMenuSelectConfirmed.addEventListener('change', () => {
    confirmedCalId = elMenuSelectConfirmed.value;
    if (confirmedCalId && confirmedCalId === possibleCalId) {
      possibleCalId = '';
      elMenuSelectPossible.value = '';
    }
    saveColAssign();
  });
  elMenuSelectPossible.addEventListener('change', () => {
    possibleCalId = elMenuSelectPossible.value;
    if (possibleCalId && possibleCalId === confirmedCalId) {
      confirmedCalId = '';
      elMenuSelectConfirmed.value = '';
    }
    saveColAssign();
  });
  elMenuSelectOnCall.addEventListener('change', () => {
    onCallCalId = elMenuSelectOnCall.value;
    saveColAssign();
  });

  // Modal
  elModalBtnCancel.addEventListener('click', closeEventModal);
  elModalBackdrop.addEventListener('click', closeEventModal);
  elModalBtnSave.addEventListener('click', saveModalEvent);
  elModalBtnDelete.addEventListener('click', deleteModalEvent);
  elModalBtnConfirmed.addEventListener('click', () => setModalPlacement('confirmed'));
  elModalBtnPossible.addEventListener('click', () => setModalPlacement('possible'));

  // Legend toggle
  elLegendToggle.addEventListener('click', () => {
    const collapsed = elLegendAside.classList.toggle('legend-collapsed');
    elLegendToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    refreshStickyTops();
  });

  elRecentToggle.addEventListener('click', () => {
    const collapsed = elRecentAside.classList.toggle('recent-collapsed');
    elRecentToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  elModalInputTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveModalEvent();
    }
  });

  elModalInputStart.addEventListener('change', () => {
    if (elModalInputEnd.value && elModalInputEnd.value < elModalInputStart.value) {
      elModalInputEnd.value = elModalInputStart.value;
    }
    elModalInputEnd.min = elModalInputStart.value;
  });

  elBtnRefresh.addEventListener('click', () => {
    const token = getValidToken();
    if (token) {
      sync();
    } else {
      if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });
    }
  });

  elBtnInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') elInstallBanner.hidden = true;
    deferredInstallPrompt = null;
  });

  elBtnInstallDismiss.addEventListener('click', () => {
    elInstallBanner.hidden = true;
    deferredInstallPrompt = null;
  });

  updateOfflineBanner();
  window.addEventListener('online', () => {
    updateOfflineBanner();
    if (accessToken && Date.now() < tokenExpiry) sync();
  });
  window.addEventListener('offline', updateOfflineBanner);

  initAuth();
});
