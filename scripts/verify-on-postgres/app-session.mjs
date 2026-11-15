/**
 * Signing in to the kit's running app the way a browser does — through the REAL login API — for the scripts that talk to it
 * (`check-app.mjs`, `screenshots.mjs`).
 *
 * DEFINITION OF DONE: the session cookie is the one the app itself returned from `POST /api/auth/login` (never forged, never read from the
 * database); the country/store cookie is the one `POST /api/context` returned; the password comes from `KIT_PASSWORD` (the one the seed printed
 * once) or `--password`, and is never printed. Refuses a base URL that is not on this machine.
 */
import { die } from './lib.mjs';

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The app's address: `--base-url`, or `KIT_APP_URL`, or the first port `run-app.mjs` tries. Local only. */
export function baseUrlFrom(arg) {
  const raw = arg || process.env.KIT_APP_URL || 'http://127.0.0.1:3100';
  const url = new URL(raw);
  if (!LOCAL.has(url.hostname)) die(`REFUSED: the app address must be on this machine (got "${url.hostname}").`);
  return url.origin;
}

export function passwordFrom(arg) {
  const pw = arg || process.env.KIT_PASSWORD;
  if (!pw) die('ناقص كلمة السر: KIT_PASSWORD (اللي طبعها seed.mjs مرة وحدة) أو --password.');
  return pw;
}

/** `name=value` pairs from the `Set-Cookie` headers of a response. */
function cookiesOf(res) {
  const out = {};
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

export const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** One request with the jar's cookies; returns { status, json, jar } where `jar` includes any cookie the answer set. */
export async function call(baseUrl, path, jar, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}), ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, jar: { ...jar, ...cookiesOf(res) } };
}

/** Sign in; returns the jar holding the session cookie, and who signed in. */
export async function login(baseUrl, email, password) {
  const r = await call(baseUrl, '/api/auth/login', {}, { method: 'POST', body: JSON.stringify({ email, password }) });
  if (r.status !== 200 || !r.jar.salesflow_session) {
    die(`تسجيل الدخول فشل لـ${email}: HTTP ${r.status} ${r.json?.error ?? r.text.slice(0, 120)}`);
  }
  return { jar: r.jar, user: r.json?.user ?? null };
}

/**
 * Choose the country (by code) and its store, the way the entry screen does: `GET /api/context` lists what the user may enter, `POST /api/context`
 * sets the signed cookie. Returns the jar with that cookie and what was chosen.
 */
export async function chooseContext(baseUrl, jar, countryCode) {
  const list = await call(baseUrl, '/api/context', jar);
  if (list.status !== 200) die(`GET /api/context رجّع ${list.status}: ${list.text.slice(0, 200)}`);
  const country = (list.json?.countries ?? []).find((c) => c.code === countryCode);
  if (!country) die(`المستخدم ما بيدخل بلد ${countryCode}. المتاح: ${(list.json?.countries ?? []).map((c) => c.code).join(', ') || '(ولا واحد)'}`);
  // Step 1: the country alone (the stores listed by the next GET are the ones of the selected country); step 2: its store.
  const step1 = await call(baseUrl, '/api/context', list.jar, { method: 'POST', body: JSON.stringify({ countryId: country.id }) });
  if (step1.status !== 200) die(`POST /api/context (البلد) رجّع ${step1.status}: ${step1.text.slice(0, 200)}`);
  const step2 = await call(baseUrl, '/api/context', step1.jar);
  const storeId = step2.json?.stores?.[0]?.id;
  if (!storeId) die(`ما لقيت متجر لبلد ${countryCode}.`);
  const chosen = await call(baseUrl, '/api/context', step2.jar, { method: 'POST', body: JSON.stringify({ countryId: country.id, storeId }) });
  if (chosen.status !== 200) die(`POST /api/context رجّع ${chosen.status}: ${chosen.text.slice(0, 200)}`);
  return { jar: chosen.jar, country: country.code, storeId };
}
