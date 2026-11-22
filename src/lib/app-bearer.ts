/**
 * «ZAKI ORDERS» — THE ANDROID APP SPEAKS THE SAME SESSION, IN A HEADER (22/11).
 *
 * The app signs in through the same doors as the browser (`client: "android"`, sign-in.ts) and gets back the SAME
 * session token a cookie would carry, plus — from `/api/context` — the same signed country/store selection. It keeps both
 * encrypted on the phone and sends them as headers, because a native client has no cookie jar worth trusting:
 *
 *   X-Zaki-Client:  android
 *   Authorization:  Bearer <session token>
 *   X-Zaki-Context: <selection token>          (once a country/store is chosen)
 *
 * The proxy turns those back into the two cookies, here, before any handler runs — so every door (`requireAuth`, both
 * locks `tv`/`sid`, the per-request grants, `requireContext`, the sign-out) reads them exactly as it reads a browser's,
 * and not one route learns a second way in. Nothing is verified here: the doors verify, as they do for a cookie.
 *
 * WHAT IS REFUSED A SAY:
 *   · `/api/v1/**` — the system API's own `zk1_` Bearer keys. It reads no cookie and is left exactly as it is.
 *   · Anything that is not three base64url parts (a `zk1_` key, a call-helper token): not a session token, so no rewrite.
 *   · Without `X-Zaki-Client: android` nothing happens: a Bearer header alone means what it meant before.
 *   · Every cookie the request carried is dropped — the preview cookie above all (the owner's «عاين كـ» is a browser's
 *     and binds to a browser's session), the trusted-device cookie, any stray session cookie — and so is the
 *     Authorization header itself, so no route ever mistakes a session token for another credential.
 *   · A browser cannot send this cross-site: `Authorization` and `X-Zaki-*` are not simple headers, so the browser asks
 *     first (a CORS preflight) and this server answers no CORS — the request never leaves the page.
 *
 * Pure (Headers in, Headers out) so the edge can run it and a test can hold it.
 */

/** The browser's session cookie (auth.ts `COOKIE_NAME`) and the country/store cookie (geo-context.ts `CONTEXT_COOKIE`). */
export const APP_SESSION_COOKIE = 'salesflow_session';
export const APP_CONTEXT_COOKIE = 'salesflow_ctx';

export const APP_CLIENT_HEADER = 'x-zaki-client';
export const APP_CONTEXT_HEADER = 'x-zaki-context';
export const APP_CLIENT = 'android';

/** A compact JWS: three base64url parts. Long enough to be a token, short enough to be nothing else. */
const JWS = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const MAX_TOKEN = 4096;

function jws(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && v.length <= MAX_TOKEN && JWS.test(v) ? v : null;
}

/** Is this an app request at all — `/api/` (not `/api/v1/`) and `X-Zaki-Client: android`. */
export function isAppRequest(headers: Headers, pathname: string): boolean {
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/v1/')) return false;
  return headers.get(APP_CLIENT_HEADER)?.trim().toLowerCase() === APP_CLIENT;
}

/**
 * The headers the handlers should see for an app request, or null when this is not one (and then nothing changes).
 *
 * An app request with no usable token still has its cookies dropped: it is answered as nobody (401), never as whoever's
 * cookie happened to ride along.
 */
export function appRequestHeaders(incoming: Headers, pathname: string): Headers | null {
  if (!isAppRequest(incoming, pathname)) return null;
  const headers = new Headers(incoming);
  const auth = headers.get('authorization') ?? '';
  const session = jws(/^Bearer\s+(.+)$/i.exec(auth)?.[1]);
  const context = jws(headers.get(APP_CONTEXT_HEADER));

  headers.delete('cookie');
  headers.delete('authorization');
  headers.delete(APP_CONTEXT_HEADER);

  const jar: string[] = [];
  if (session) jar.push(`${APP_SESSION_COOKIE}=${session}`);
  if (session && context) jar.push(`${APP_CONTEXT_COOKIE}=${context}`);
  if (jar.length) headers.set('cookie', jar.join('; '));
  return headers;
}

/** Which door a sign-in came through: a browser (the cookie) or the Android app (the token, in the answer's body). */
export type SignInClient = 'web' | 'app';

/** `client: "android"` in the sign-in body, and nothing else, is the app. Anything else is a browser, as before. */
export function signInClientOf(body: unknown): SignInClient {
  return body && typeof body === 'object' && (body as { client?: unknown }).client === 'android' ? 'app' : 'web';
}
