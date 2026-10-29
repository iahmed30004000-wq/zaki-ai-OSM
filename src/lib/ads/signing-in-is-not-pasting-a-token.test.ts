import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../guard-source';
import {
  STATE_TTL_MS,
  authorizeUrl,
  makeState,
  oauthConfig,
  oauthMissing,
  readState,
  redirectUri,
} from './oauth';

/**
 * «ما بقدر اربط الحساب الاعلاني عن طريق تسجيل الدخول بالحساب»
 *
 * ── WHAT THIS FEATURE CANNOT DO ON ITS OWN, AND IT IS NOT A DETAIL ──
 *
 * OAuth needs an APP registered with each platform: a client id, a client
 * secret, and a redirect URI the platform has been told about. Those belong
 * to the PRODUCT — one Zaki app that every shop signs into — and MEASURED
 * when this was written, nothing in this repository has them: not one env
 * var, not an example, nothing.
 *
 * So the whole machine is config-driven and an unconfigured platform is a
 * STATED absence: `oauthConfig` returns null, the screen names the two env
 * vars and where to register, and the paste-a-token form keeps working
 * untouched. A seller is never shown a «sign in» button that leads to a
 * platform error page.
 *
 * AND META'S SCOPE NEEDS APP REVIEW — `ads_read` is granted after a review
 * with a screencast and a privacy policy, which takes days. That is a step
 * with a calendar attached, written down rather than discovered by somebody
 * wondering why approval never came.
 *
 * ── WHERE THE DANGER ACTUALLY IS ──
 *
 * Not in the redirect. In the `state`. The callback is a GET the platform
 * sends a browser to, carrying a `code` — and anybody holding a code for
 * THEIR ad account can hand it to our callback while a victim is signed in.
 * The token for a stranger's account then sits against the victim's
 * company, and every spend figure in their reports comes from somebody
 * else's spending. So the state is signed AND checked against the session,
 * and both halves are tested: the signature stops forgery, the session
 * check stops replay.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, JWT_SECRET: 'x'.repeat(40), NEXT_PUBLIC_APP_URL: 'https://shop.example.com/' };
});
afterEach(() => {
  process.env = ENV;
  vi.restoreAllMocks();
});

describe('Ⅰ · a platform with no app is a stated absence, not a broken button', () => {
  it('returns null when neither env var is set', () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    expect(oauthConfig('META')).toBeNull();
  });

  it('and null when only ONE of the two is set', () => {
    /*
     * An id with no secret cannot complete the token exchange, so a button
     * built from it gets the seller halfway and then fails — which is worse
     * than no button, because they have already granted consent.
     */
    process.env.META_APP_ID = 'app-1';
    delete process.env.META_APP_SECRET;
    expect(oauthConfig('META')).toBeNull();

    delete process.env.META_APP_ID;
    process.env.META_APP_SECRET = 'secret-1';
    expect(oauthConfig('META')).toBeNull();
  });

  it('and names what is missing, without naming a value', () => {
    const missing = oauthMissing('META')!;
    expect(missing.envKeys).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    expect(missing.register.url).toContain('developers.facebook.com');
    // The names are not secrets. The values never leave the server, and
    // nothing here reads one.
    expect(JSON.stringify(missing)).not.toContain('secret-1');
  });

  it('and says so for all three platforms', () => {
    for (const p of ['META', 'TIKTOK', 'SNAPCHAT']) {
      expect(oauthMissing(p), p).not.toBeNull();
      expect(oauthMissing(p)!.envKeys, p).toHaveLength(2);
    }
  });

  it('and a platform that is not one of the three is null either way', () => {
    expect(oauthConfig('LINKEDIN')).toBeNull();
    expect(oauthMissing('LINKEDIN')).toBeNull();
  });

  it('and reads the env at CALL time, so a deploy needs no restart to be believed', () => {
    delete process.env.META_APP_ID;
    expect(oauthConfig('META')).toBeNull();
    process.env.META_APP_ID = 'app-1';
    process.env.META_APP_SECRET = 'secret-1';
    expect(oauthConfig('META')).not.toBeNull();
  });
});

describe('Ⅱ · the state is what makes the callback safe', () => {
  const MINE = { companyId: 'co-1', storeId: 'store-1', platform: 'META' };

  it('round-trips what started the flow', () => {
    const v = readState(makeState(MINE), 'META');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.state.companyId).toBe('co-1');
      expect(v.state.storeId).toBe('store-1');
    }
  });

  it('refuses a payload whose signature was not ours', () => {
    const raw = makeState(MINE);
    const [payload] = raw.split('.');
    expect(readState(`${payload}.forged`, 'META')).toEqual({ ok: false, why: 'bad-signature' });
  });

  it('and refuses a payload EDITED after signing — the whole point', () => {
    /*
     * The attack the signature exists for: take a valid state, change the
     * company to the victim's, and the callback would store your ad account
     * against them.
     */
    const raw = makeState(MINE);
    const mac = raw.split('.')[1];
    const evil = Buffer.from(
      JSON.stringify({ companyId: 'victim-co', storeId: null, platform: 'META', at: Date.now(), nonce: 'x' })
    ).toString('base64url');
    expect(readState(`${evil}.${mac}`, 'META')).toEqual({ ok: false, why: 'bad-signature' });
  });

  it('and a length mismatch is a refusal, never a thrown exception', () => {
    /*
     * `timingSafeEqual` THROWS on a length mismatch rather than returning
     * false. An exception here would be a 500 where a 400 belongs — and a
     * 500 on a crafted state is a way to tell signatures apart by their
     * effect, which is the thing timing-safety is for.
     */
    const payload = makeState(MINE).split('.')[0];
    for (const mac of ['', 'a', 'a'.repeat(200)]) {
      expect(() => readState(`${payload}.${mac}`, 'META')).not.toThrow();
      expect(readState(`${payload}.${mac}`, 'META').ok).toBe(false);
    }
  });

  it('and expires, because a consent screen is not a day long', () => {
    const t = 1_760_000_000_000;
    const raw = makeState(MINE, t);
    expect(readState(raw, 'META', t + STATE_TTL_MS - 1).ok).toBe(true);
    expect(readState(raw, 'META', t + STATE_TTL_MS)).toEqual({ ok: false, why: 'expired' });
  });

  it('and a clock that moved backwards does not expire a fresh state', () => {
    /*
     * `now - at`, never `Math.abs`: a device correcting its time must not
     * turn «issued a minute ago» into «away for an hour».
     *
     * AND THE JUMP HAS TO BE BIGGER THAN THE WINDOW. My first version used
     * sixty seconds, and a mutation swapping the comparison for
     * `Math.abs` passed it — because `|−60s|` is still inside ten minutes.
     * A test of a sign has to move further than the threshold it is
     * testing, or it is testing nothing.
     */
    const t = 1_760_000_000_000;
    expect(readState(makeState(MINE, t), 'META', t - 60_000).ok).toBe(true);
    // An hour backwards: `now - at` is −3600s and still fresh; `Math.abs`
    // would read it as an hour away and expire it.
    expect(readState(makeState(MINE, t), 'META', t - 60 * 60_000).ok, 'ساعةٌ للخلفِ أسقطتْ حالةً طازجة').toBe(true);
  });

  it('and a state from another platform’s flow is refused, though we signed it', () => {
    /*
     * The callback is per platform. A Meta state arriving at TikTok's
     * callback would mean a Meta code exchanged against TikTok's token
     * endpoint — signed by us, and still wrong.
     */
    expect(readState(makeState(MINE), 'TIKTOK')).toEqual({ ok: false, why: 'wrong-platform' });
  });

  it('and anything that is not a signed state is malformed, not a crash', () => {
    for (const bad of [undefined, null, '', 'abc', 'a.b.c.d', 42, {}, 'eyJ9.x']) {
      const v = readState(bad, 'META');
      expect(v.ok, String(bad)).toBe(false);
    }
  });

  it('and two states made in the same millisecond differ', () => {
    // The nonce. It matters only for the log, and a log in which two flows
    // are indistinguishable is a log that cannot answer «which one».
    const t = 1_760_000_000_000;
    expect(makeState(MINE, t)).not.toBe(makeState(MINE, t));
  });

  it('and a state signed under a different secret is refused', () => {
    const raw = makeState(MINE);
    process.env.JWT_SECRET = 'y'.repeat(40);
    expect(readState(raw, 'META')).toEqual({ ok: false, why: 'bad-signature' });
  });
});

describe('Ⅲ · the redirect URI comes from the app, never from a request', () => {
  it('is built from NEXT_PUBLIC_APP_URL', () => {
    expect(redirectUri('META')).toBe(
      'https://shop.example.com/api/settings/ad-accounts/oauth/META/callback'
    );
  });

  it('and a trailing slash does not become a double one', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://shop.example.com///';
    expect(redirectUri('META')).not.toContain('.com//api');
  });

  it('and nothing in the module reads a Host header', () => {
    /*
     * The redirect URI is the one value the platform compares against what
     * was registered. Taking it from a `Host` header would let a request
     * claiming any host point the token exchange at that host.
     */
    /*
     * MY FIRST VERSION OF THIS TEST BANNED THE WORD «headers» AND WAS WRONG.
     *
     * The token exchange SENDS headers — `Content-Type` and `Accept` — which
     * is the opposite of the danger. The rule is that nothing here READS an
     * incoming one, so the assertions are on the reading shapes: a request
     * object, a header lookup, a proxy header by name.
     *
     * A test that bans a word rather than a use is a test that either fails
     * on correct code or passes on wrong code, and this one did the first.
     */
    const src = stripComments(read('src/lib/ads/oauth.ts')).toLowerCase();
    for (const forbidden of ['req.headers', 'request.headers', "get('host", 'x-forwarded', 'headers.get(']) {
      expect(src, `oauth.ts يقرأ ${forbidden}`).not.toContain(forbidden);
    }
    // And the only `headers` in the file is one being SENT.
    expect(src).toContain("headers: { 'content-type'");
  });
});

describe('Ⅳ · the authorize URL', () => {
  beforeEach(() => {
    process.env.META_APP_ID = 'app-1';
    process.env.META_APP_SECRET = 'secret-1';
  });

  it('is null when the platform has no app, so the caller must handle it', () => {
    delete process.env.META_APP_ID;
    expect(authorizeUrl('META', 'st')).toBeNull();
  });

  it('carries the state, the redirect and the scopes', () => {
    const url = new URL(authorizeUrl('META', 'STATE-VALUE')!);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v21.0/dialog/oauth');
    expect(url.searchParams.get('state')).toBe('STATE-VALUE');
    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri('META'));
  });

  it('and NEVER the client secret', () => {
    // It is a redirect a browser follows: the URL lands in history, in
    // logs, in the Referer header, and in any proxy between.
    expect(authorizeUrl('META', 'st')!).not.toContain('secret-1');
    expect(authorizeUrl('META', 'st')!).not.toContain('client_secret');
  });

  it('and asks for READ scopes only — never the power to spend money', () => {
    /*
     * `ads_management` would let us CREATE and PAUSE ads, which this
     * product never does. Asking for it would mean a seller granting the
     * power to spend their money to a system that only reads — and Meta's
     * own review is stricter about it, so asking for more is slower as
     * well as wronger.
     */
    const scope = new URL(authorizeUrl('META', 'st')!).searchParams.get('scope')!;
    expect(scope).toContain('ads_read');
    expect(scope, 'طُلبتْ صلاحيةُ إدارةِ الإعلانات ونحن نقرأُ فقط').not.toContain('ads_management');
    expect(oauthConfig('META')!.scopes).not.toContain('ads_management');
  });

  it('and is built with URLSearchParams, so a reserved character cannot add a parameter', () => {
    process.env.META_APP_ID = 'app&scope=ads_management';
    const url = new URL(authorizeUrl('META', 'st')!);
    expect(url.searchParams.get('client_id')).toBe('app&scope=ads_management');
    expect(url.searchParams.get('scope')).not.toContain('ads_management');
  });
});

describe('Ⅴ · the code exchange puts the secret in the BODY', () => {
  const src = stripComments(read('src/lib/ads/oauth.ts'));

  it('posts rather than gets', () => {
    // Meta also accepts a GET with the secret in the query string, and that
    // is the one shape to refuse: a URL ends up in logs, proxies and error
    // reports, and a client secret in any of those is a secret to rotate
    // for every shop at once.
    expect(src).toMatch(/method: 'POST'/);
    expect(src).toMatch(/body,/);
  });

  it('and nothing concatenates the secret into a URL', () => {
    expect(src, 'السرُّ يُلصَقُ في عنوان').not.toMatch(/client_secret=\$\{/);
    expect(src).toMatch(/new URLSearchParams\(\{[\s\S]{0,200}client_secret: config\.clientSecret/);
  });

  it('and refuses a response with no token rather than storing an empty one', () => {
    expect(src).toMatch(/if \(!access\) throw/);
  });

  it('and Snapchat keeps its refresh token, because its access tokens die in half an hour', () => {
    expect(src).toMatch(/if \(platform === 'SNAPCHAT'\)/);
    expect(src).toMatch(/refreshToken: refresh/);
    expect(src).toMatch(/if \(!refresh\) throw/);
  });
});

describe('Ⅵ · the callback refuses before it spends the code', () => {
  const cb = stripComments(
    read('src/app/api/settings/ad-accounts/oauth/[platform]/callback/route.ts')
  );

  it('reads the state BEFORE the code', () => {
    const state = cb.indexOf('readState(');
    const code = cb.indexOf("url.searchParams.get('code')");
    expect(state, 'لا فحصَ للحالة').toBeGreaterThan(-1);
    expect(code, 'لا قراءةَ للرمز').toBeGreaterThan(-1);
    expect(state, 'الرمزُ يُقرأُ قبلَ فحصِ الحالة').toBeLessThan(code);
  });

  it('and checks the state is THIS session’s, not merely signed by us', () => {
    /*
     * The signature proves WE issued it; it does not prove it was issued to
     * whoever is holding it. A state signed for company A, replayed by
     * somebody signed in as B, would store A's flow against B. Both halves
     * are needed.
     */
    expect(cb).toMatch(/verdict\.state\.companyId !== companyId/);
    expect(cb).toMatch(/verdict\.state\.storeId \?\? null\) !== \(storeId \?\? null\)/);
  });

  it('and handles the platform’s own refusal first', () => {
    /*
     * A seller who presses «cancel» arrives with `error=access_denied` and
     * no code. Reading the code first answers «no code» — true and useless.
     *
     * AND THE BRANCH HAS TO BE LIVE, NOT MERELY PRESENT. My first version
     * looked for the TEXT `url.searchParams.get('error')` and compared
     * positions; a mutation replacing the whole condition with `if (false)`
     * left that text inside the dead body, so the position check still
     * passed over a branch that could never run. Ninth time in this
     * repository that a check on a NAME was satisfied by something that did
     * not do the job — so the assertion is on the CONDITION.
     */
    expect(cb, 'فرعُ رفضِ المنصّةِ ليس شرطاً حيّاً').toMatch(
      /if \(url\.searchParams\.get\('error'\)\) \{/
    );
    const err = cb.search(/if \(url\.searchParams\.get\('error'\)\) \{/);
    expect(err).toBeGreaterThan(-1);
    expect(err, 'الحالةُ تُفحَصُ قبلَ رفضِ المنصّة').toBeLessThan(cb.indexOf('readState('));
    expect(cb).toMatch(/access_denied/);
  });

  it('and never passes the platform’s error text on', () => {
    /*
     * It is attacker-controlled text arriving in a query string. Putting it
     * on a page is how a redirect becomes a message board.
     */
    expect(cb, 'نصُّ المنصّةِ يُعادُ إلى الشاشة').not.toMatch(/error: url\.searchParams\.get\('error'\)/);
    // The outcome is one of two words we chose, picked by whether the
    // platform said `access_denied` — never the platform's own text.
    expect(cb).toMatch(/back\(denied \? 'declined' : 'platform-refused'/);
  });

  it('and audits a refused state, because an attack and a slow seller look the same from here', () => {
    expect(cb).toMatch(/AD_ACCOUNT_OAUTH_REFUSED/);
    expect(cb).toMatch(/reason: verdict\.why/);
    expect(cb).toMatch(/reason: 'other-tenant'/);
  });

  it('and ends in a redirect with a CODE, never a token or an error string', () => {
    expect(cb).toMatch(/NextResponse\.redirect/);
    const q = [...cb.matchAll(/back\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(q.length).toBeGreaterThanOrEqual(6);
    // Nothing secret reaches the query.
    expect(cb, 'الرمزُ يُعادُ في العنوان').not.toMatch(/back\([^)]*credentials/);
    expect(cb, 'الحالةُ تُعادُ في العنوان').not.toMatch(/back\([^)]*state:/);
  });

  it('and never writes a token in the clear — at EVERY site', () => {
    /*
     * THE UPSERT HAS TWO BRANCHES, `create` and `update`, and each writes
     * the token. My first version matched the shape ONCE, so a mutation
     * that put `JSON.stringify(credentials)` in the `create` branch left
     * the `update` branch matching and the test green — a token in the
     * clear on every new connection.
     *
     * So: every `tokenEncrypted:` in the file is counted, and every one of
     * them must be `writeCredentials`.
     */
    const sites = [...cb.matchAll(/tokenEncrypted:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(sites.length, 'لا موضعَ يَكتبُ الرمز').toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(site, `الرمزُ يُكتَبُ مكشوفاً: ${site}`).toBe('writeCredentials(credentials),'.replace(',', ''));
    }
  });

  it('and the audit row carries the accounts, not the token nor its hint', () => {
    // An audit log is read by more people than a settings screen.
    expect(cb).toMatch(/accounts: stored/);
    expect(cb, 'تلميحُ الرمزِ في سجلِّ التدقيق').not.toMatch(/newData: \{[^}]*tokenHint/);
  });

  it('and is idempotent, so re-connecting refreshes rather than failing', () => {
    expect(cb).toMatch(/db\.adAccount\.upsert/);
    expect(cb).toMatch(/companyId_storeId_platform_accountId/);
  });
});

describe('Ⅶ · the start route', () => {
  const start = stripComments(read('src/app/api/settings/ad-accounts/oauth/[platform]/start/route.ts'));

  it('tells «not configured» apart from «not found»', () => {
    /*
     * The fix for one is an administrator's and the fix for the other is
     * nobody's. 503 with the env var names is the only answer that leads
     * anybody anywhere.
     */
    expect(start).toMatch(/status: 404/);
    expect(start).toMatch(/OAUTH_NOT_CONFIGURED/);
    expect(start).toMatch(/status: 503/);
    expect(start).toMatch(/envKeys/);
  });

  it('and audits a flow that was STARTED, not only one that finished', () => {
    // A seller who presses this three times and never connects is a seller
    // whose consent screen is refusing them, and nothing else would say so.
    expect(start).toMatch(/AD_ACCOUNT_OAUTH_STARTED/);
  });

  it('and never logs the state, which is a credential for ten minutes', () => {
    expect(start, 'الحالةُ تُكتَبُ في سجلِّ التدقيق').not.toMatch(/newData: \{[^}]*state/);
  });

  it('and is gated on settings.manage — the same key as pasting the same token (RV169), not settings.edit', () => {
    expect(start).toMatch(/requirePermission\('settings\.manage'\)/);
    expect(start).not.toMatch(/requirePermission\('settings\.edit'\)/);
  });
});

describe('Ⅷ · all three adapters can say what a token reaches', () => {
  /**
   * Signing in does not name an account: a consent covers whatever the
   * person administers, which may be one account or fourteen. The
   * paste-a-token form knows the id because the seller typed it.
   */
  const ADAPTERS = {
    'src/lib/ads/meta.ts': /me\/adaccounts/,
    'src/lib/ads/tiktok.ts': /oauth2\/advertiser\/get/,
    'src/lib/ads/snapchat.ts': /me\/organizations/,
  };

  for (const [file, endpoint] of Object.entries(ADAPTERS)) {
    it(`${file.split('/').pop()} asks the platform for its accounts`, () => {
      const src = stripComments(read(file));
      expect(src, `${file}: لا يَسألُ عن الحسابات`).toMatch(endpoint);
      expect(src, `${file}: لا يُصدِّرُ listAccounts`).toMatch(/listAccounts/);
    });
  }

  it('and the contract REQUIRES it, so a fourth platform cannot forget', () => {
    const types = stripComments(read('src/lib/ads/types.ts'));
    expect(types).toMatch(/listAccounts\(creds: AdCredentials\): Promise<AdAccountInfo\[\]>;/);
    expect(types, 'الدالةُ اختياريّةٌ فتُنسى').not.toMatch(/listAccounts\?/);
  });
});

describe('Ⅸ · and the screen tells the truth either way', () => {
  const screen = read('src/components/settings/AdAccountsCard.tsx');

  it('offers the button only when the platform has an app', () => {
    expect(screen).toMatch(/active\.oauth\.available \?/);
    expect(screen).toMatch(/oauth\/\$\{active\.platform\}\/start/);
  });

  it('and names the env vars when it does not', () => {
    expect(screen).toContain('الربط بتسجيل الدخول غير مهيّأ بعد');
    expect(screen).toMatch(/active\.oauth\.envKeys\.join/);
  });

  it('and says the paste-a-token form still works', () => {
    // A shop whose platform has no app registered must not be left with no
    // way to connect at all.
    expect(screen).toContain('الصق الرمز بالأسفل');
  });

  it('and the server decides availability, not the browser', () => {
    // A browser cannot know whether an env var is set, and a screen that
    // guessed would draw a button that leads to a platform error page.
    const index = stripComments(read('src/lib/ads/index.ts'));
    expect(index).toMatch(/oauthConfig\(a\.platform\) !== null/);
    expect(screen, 'الشاشةُ تَقرأُ متغيّرَ بيئة').not.toMatch(/process\.env\.(META|TIKTOK|SNAPCHAT)/);
  });
});
