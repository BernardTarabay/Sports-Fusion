// HTTP client.
//
// Two rules this file exists to enforce:
//
//   1. NO TOKENS IN localStorage. The backend issues httpOnly cookies; the browser
//      sends them because of `credentials: 'include'` and JavaScript never sees them.
//      There is deliberately no setToken() to reach for.
//
//   2. NO RAW API ERRORS IN THE UI. The backend returns a stable machine code
//      (GAME_FULL, ALREADY_REGISTERED, TOKEN_REUSE_DETECTED...). This maps those to
//      something a person can act on. "Error 409: UNIQUE constraint violation" is not
//      a message, it is a leak.

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Human wording per machine code. Keyed on the code so a copy change never depends on
 * parsing English out of a server response.
 */
const MESSAGES = {
  GAME_FULL: 'This game just filled up. You can join the waiting list instead.',
  ALREADY_REGISTERED: "You're already on the list for this game.",
  REGISTRATION_CLOSED: 'Registration for this game has closed.',
  REGISTRATION_NOT_OPEN: 'Registration for this game has not opened yet.',
  GAME_CANCELLED: 'This game has been cancelled.',
  GAME_STARTED: 'This game has already kicked off.',
  WAITLIST_FULL: 'The waiting list for this game is full.',
  NOT_REGISTERED: "You're not registered for this game.",
  INSUFFICIENT_POINTS: "You don't have enough points for that yet.",
  OUT_OF_STOCK: 'That reward has run out.',
  LIMIT_REACHED: "You've already claimed this one.",
  NOT_ENOUGH_GAMES: 'Play a few more games to unlock this.',
  REWARD_INACTIVE: 'That reward is no longer available.',
  INVALID_CREDENTIALS: 'Those login details are not right.',
  ACCOUNT_EXISTS: 'An account with those details already exists.',
  ACCOUNT_INACTIVE: 'This account is not active. Get in touch with an admin.',
  TOKEN_EXPIRED: 'Your session expired. Please sign in again.',
  TOKEN_REUSE_DETECTED: 'For your security we signed you out everywhere. Please sign in again.',
  UNAUTHORIZED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "We couldn't find that.",
  VALIDATION_ERROR: 'Some of those details are not valid.',
  NAME_REQUIRED: 'Almost there — we just need your name.',
  RATE_LIMITED: 'Too many attempts. Give it a minute.',
  NETWORK: "We couldn't reach Sports Fusion. Check your connection.",
  INTERNAL_ERROR: 'Something went wrong on our end. Try again in a moment.',
};

export const humanMessage = (code, fallback) =>
  MESSAGES[code] ?? fallback ?? MESSAGES.INTERNAL_ERROR;

let onUnauthorized = null;
/** Let the session layer react to a 401 without every caller handling it. */
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/**
 * Silent session renewal.
 *
 * The access cookie lives fifteen minutes; the refresh cookie lives thirty days. Nothing
 * was spending the second to renew the first, so the app logged people out a quarter of
 * an hour after signing in -- an admin running a ninety minute match was bounced to the
 * login screen twice, mid-game, holding a session that was still perfectly valid.
 *
 * SINGLE FLIGHT IS NOT AN OPTIMISATION HERE
 *
 * Refresh tokens rotate, and the backend treats a second use of a spent token as theft:
 * it revokes the whole family. A matchday screen fires several requests at once, so if
 * each 401 triggered its own refresh, the first would rotate the token and the rest would
 * present the old one -- and the reuse detector would correctly log the user out of every
 * device. So every caller waits on ONE refresh promise.
 */
let refreshing = null;

function renewSession() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Renewing these would be circular, or would paper over a genuine bad password.
const NO_RENEW = ['/auth/refresh', '/auth/login', '/auth/logout', '/auth/signup', '/auth/phone/verify'];

async function request(method, path, { body, signal, headers, _retried } = {}) {
  let response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      // The whole auth model depends on this line.
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(MESSAGES.NETWORK, { status: 0, code: 'NETWORK' });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (!response.ok) {
    const code = payload?.error?.code ?? 'INTERNAL_ERROR';

    // An expired access token is not a signed-out user. Renew once and replay the call;
    // only give up -- and tell the session layer -- if the refresh cookie is gone too.
    if (response.status === 401 && !_retried && !NO_RENEW.some((p) => path.startsWith(p))) {
      if (await renewSession()) {
        return request(method, path, { body, signal, headers, _retried: true });
      }
    }

    if (response.status === 401 && code !== 'INVALID_CREDENTIALS') onUnauthorized?.(code);
    throw new ApiError(humanMessage(code, payload?.error?.message), {
      status: response.status,
      code,
      details: payload?.error?.details,
    });
  }

  return payload;
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body: body ?? {} }),
  put: (path, body, options) => request('PUT', path, { ...options, body: body ?? {} }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body: body ?? {} }),
  del: (path, body, options) => request('DELETE', path, { ...options, body }),
};

export default api;
