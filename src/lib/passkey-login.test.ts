import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * THE FINGERPRINT AS THE DOOR, NOT A SECOND LOCK ON IT.
 *
 * `/api/auth/passkey/assert` puts the fingerprint where the six digits go,
 * after a password. That is not what was asked for twice: «اعمل عند تسجيل
 * الدخول bypass key بصمة أو بصمة وجه» — at the login itself.
 *
 * A passkey is a fair door. The signature covers the origin, so a copy of
 * the login page on another domain gets nothing; what is stored is a
 * PUBLIC key, so a breach of this database signs nothing; and the device
 * only signs after verifying the person, so it is the thing you have and
 * the thing you are together. These guards hold the parts that make that
 * true — every one of which is easy to drop by accident.
 */

const login = () => stripComments(repoFile('src/app/api/auth/passkey/login/route.ts'));

describe('signing in with a fingerprint alone', () => {
  it('asks for no account first — the signature names it', () => {
    const src = login();
    // A challenge belonging to nobody yet…
    expect(src).toMatch(/userId: null/);
    expect(src).toMatch(/kind: 'LOGIN'/);
    // …and no allowCredentials, which is what makes it passwordless.
    expect(src, 'يُملي على المتصفّح أيَّ مفتاحٍ يبحث عنه').not.toMatch(/allowCredentials/);
    // The account comes from the credential that signed.
    expect(src).toMatch(/db\.passkey\.findUnique\(\{[\s\S]{0,80}where: \{ credentialId \}/);
  });

  it('refuses a challenge it did not issue, and spends it once', () => {
    const src = login();
    expect(src).toMatch(/kind: 'LOGIN', usedAt: null, expiresAt: \{ gt: now \}/);
    // Conditional spend: two requests with one signature cannot both pass.
    expect(src).toMatch(/updateMany\(\{[\s\S]{0,120}usedAt: null[\s\S]{0,80}data: \{ usedAt: now \}/);
    expect(src).toMatch(/spent\.count !== 1/);
  });

  it('verifies the signature against the PUBLIC origin, and refuses plain HTTP', () => {
    /*
     * It used to read `new URL(req.url).origin`, and this guard pinned that.
     * Measured on the production build on 2026-10-02: a request carrying
     * `Host: app.example.com` and `X-Forwarded-Proto: https` — what Coolify's
     * proxy sends — came out as `http://localhost:3100`. Because localhost is
     * the secure-context exception, nothing complained: the API issued a
     * challenge for `rpId: "localhost"` to a browser on the real domain, the
     * browser refused it client-side, and no server log said why.
     */
    const src = login();
    expect(src).toMatch(/relyingParty\(publicOrigin\(req\)\)/);
    expect(src).not.toMatch(/relyingParty\(new URL\(req\.url\)\.origin\)/);
    expect(src).toMatch(/INSECURE_CONTEXT/);
    expect(src).toMatch(/expected: \{ challenge: issued\.challenge, origin: rp\.origin, rpId: rp\.rpId \}/);
  });

  it('and every passkey door resolves that origin the same way', () => {
    // Four doors issue or check a challenge. One of them reading a different
    // origin means a key enrolled at one and refused at the next.
    for (const door of [
      'src/app/api/auth/passkey/route.ts',
      'src/app/api/auth/passkey/register/route.ts',
      'src/app/api/auth/passkey/assert/route.ts',
      'src/app/api/auth/passkey/login/route.ts',
    ]) {
      expect(repoFile(door), door).toMatch(/relyingParty\(publicOrigin\(req\)\)/);
    }
  });

  /**
   * An unauthenticated caller must not learn which accounts hold a key, so
   * an unknown credential and a bad signature are told the same thing.
   */
  it('and never says whether a key exists', () => {
    const src = login();
    const unknown = src.match(/if \(!credential\) \{[\s\S]{0,300}?\}/)?.[0] ?? '';
    expect(unknown).toContain('تعذّر التحقّق من البصمة');
    expect(unknown, 'يكشف أنّ المفتاح غير معروف').not.toMatch(/غير موجود|unknown|not found/i);
  });

  it('refuses a suspended, disabled or pending account', () => {
    const src = login();
    expect(src).toMatch(/status === 'SUSPENDED' \|\| status === 'DISABLED'/);
    expect(src).toMatch(/status === 'PENDING'/);
  });

  it('advances the counter, which is how a cloned key is caught', () => {
    const src = login();
    expect(src).toMatch(/data: \{ counter: verdict\.counter, lastUsedAt: now \}/);
  });

  it('issues the session through the one function every door uses', () => {
    const src = login();
    expect(src).toMatch(/return await issueSession\(\{/);
    // Written as its own factor so the audit can tell the two doors apart.
    expect(src).toMatch(/factor: 'passkey'/);
    expect(src, 'يكتب الجلسة بنفسه بدل المرور بالدالّة الواحدة').not.toMatch(/cookies\(\)\.set|setSessionCookie/);
  });

  it('is rate limited by address before anyone is named, and by account after', () => {
    const src = login();
    expect(src).toMatch(/rateLimitByIp\('passkey-login', ip,/);
    expect(src).toMatch(/rateLimit\(`passkey:user:\$\{credential\.userId\}`/);
  });
});

describe('the key can be found without an account', () => {
  it('registration asks for a discoverable one', () => {
    const src = stripComments(repoFile('src/lib/passkey-browser.ts'));
    expect(src, 'مفتاحٌ لا يجده المتصفّح وحدَه لا يصلح للدخول بلا كتابة').toMatch(
      /residentKey: 'required'/
    );
    expect(src).toMatch(/requireResidentKey: true/);
    // And the person is still verified by the device, both ways.
    expect((src.match(/userVerification: 'required'/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('and the login page offers it only where the device can answer', () => {
    const src = stripComments(repoFile('src/app/(system)/login/page.tsx'));
    expect(src).toMatch(/passkeySupported\(\)\.then\(setCanFinger\)/);
    expect(src).toMatch(/\{canFinger && \(/);
    expect(src).toMatch(/loginWithPasskey\(offer\)/);
  });
});
