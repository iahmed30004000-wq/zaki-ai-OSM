import { describe, expect, it } from 'vitest';
import { createHash, createSign, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { repoFile, stripComments } from './guard-source';
import {
  ALLOWED_ALGORITHMS,
  COSE_ES256,
  COSE_RS256,
  b64url,
  newChallenge,
  readAuthData,
  publicOrigin,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
} from './passkey';

/**
 * THE FINGERPRINT ON THE DEVICE ALREADY IN THE HAND.
 *
 * It stands where the six digits stand and nowhere else: a phone that is
 * picked up is a second factor that is already lost, and the password is
 * what keeps a stolen phone from being an open account.
 *
 * NO CBOR PARSER AND NO LIBRARY. A full WebAuthn server decodes the
 * attestation object — CBOR, then COSE, then a conversion — and every step
 * is a parser standing in front of authentication. None of it is needed:
 * the browser hands the public key over already decoded, so registration
 * stores what it is given and a sign-in is one signature check with Node's
 * own crypto over bytes assembled here.
 *
 * WHICH MEANS THIS FILE IS THE PROOF. These tests sign real assertions with
 * real keys and check that each tampered field is refused by name — because
 * a browser-driven test of a fingerprint reader is not something I can run,
 * and «I could not test it» is not a thing to say about an auth path.
 */

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

/** authenticatorData: 32 bytes of rpIdHash, one of flags, four of counter. */
function authData(opts: { rpId?: string; up?: boolean; uv?: boolean; counter?: number } = {}): Buffer {
  const rpIdHash = createHash('sha256').update(opts.rpId ?? RP_ID).digest();
  // UV defaults ON, like UP: every ceremony in `passkey-browser.ts` asks for
  // `userVerification: 'required'`, so a fixture without it was modelling a
  // device this system does not accept. Pass `uv: false` to test the refusal.
  const flags = Buffer.from([(opts.up === false ? 0 : 0x01) | (opts.uv === false ? 0 : 0x04)]);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.counter ?? 1);
  return Buffer.concat([rpIdHash, flags, counter]);
}

const clientData = (o: { type?: string; challenge: string; origin?: string }) =>
  b64url.encode(
    Buffer.from(
      JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: o.challenge, origin: o.origin ?? ORIGIN })
    )
  );

/** A real ES256 key pair, and a real signature over the real bytes. */
function es256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (msg: Buffer) => nodeSign('sha256', msg, privateKey),
  };
}

function rs256() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (msg: Buffer) => createSign('RSA-SHA256').update(msg).sign(privateKey),
  };
}

function assertion(
  key: { spki: string; sign: (m: Buffer) => Buffer },
  algorithm: number,
  over: { auth?: Buffer; client?: string; challenge: string; storedCounter?: number }
) {
  const auth = over.auth ?? authData();
  const client = over.client ?? clientData({ challenge: over.challenge });
  const signed = Buffer.concat([auth, createHash('sha256').update(b64url.decode(client)).digest()]);
  return {
    authenticatorData: b64url.encode(auth),
    clientDataJSON: client,
    signature: b64url.encode(key.sign(signed)),
    credential: { publicKey: key.spki, algorithm, counter: over.storedCounter ?? 0 },
    expected: { challenge: over.challenge, origin: ORIGIN, rpId: RP_ID },
  };
}

describe('a real signature is accepted', () => {
  it('for ES256, which is what a phone produces', () => {
    const c = newChallenge();
    const v = verifyAssertion(assertion(es256(), COSE_ES256, { challenge: c }));
    expect(v.ok, v.ok ? '' : v.code).toBe(true);
    if (v.ok) expect(v.counter).toBe(1);
  });

  it('and for RS256, which some security keys produce', () => {
    const c = newChallenge();
    expect(verifyAssertion(assertion(rs256(), COSE_RS256, { challenge: c })).ok).toBe(true);
  });

  it('and nothing else is accepted at all', () => {
    const c = newChallenge();
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    const v = verifyAssertion({ ...a, credential: { ...a.credential, algorithm: -8 } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('UNSUPPORTED_ALGORITHM');
    expect(ALLOWED_ALGORITHMS).toEqual([COSE_ES256, COSE_RS256]);
  });
});

describe('and every way of faking one is refused, by name', () => {
  const c = newChallenge();
  const bad = (a: ReturnType<typeof assertion>) => {
    const v = verifyAssertion(a);
    expect(v.ok, 'قُبل توقيعٌ كان يجب رفضه').toBe(false);
    return v.ok ? '' : v.code;
  };

  /** The whole point of the challenge. */
  it('a signature over a challenge we did not issue', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    expect(bad({ ...a, expected: { ...a.expected, challenge: newChallenge() } })).toBe('WRONG_CHALLENGE');
  });

  /** A registration replayed as a sign-in. */
  it('a signature made for the wrong ceremony', () => {
    const key = es256();
    const a = assertion(key, COSE_ES256, {
      challenge: c,
      client: clientData({ type: 'webauthn.create', challenge: c }),
    });
    expect(bad(a)).toBe('WRONG_CEREMONY');
  });

  /** This is what stops a look-alike site collecting a signature. */
  it('a signature collected on another origin', () => {
    const key = es256();
    const a = assertion(key, COSE_ES256, {
      challenge: c,
      client: clientData({ challenge: c, origin: 'https://evil.example' }),
    });
    expect(bad(a)).toBe('WRONG_ORIGIN');
  });

  it('a signature made for another site’s rpId', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ rpId: 'evil.example' }) });
    expect(bad(a)).toBe('WRONG_RP');
  });

  /** The flag that means a human touched the device. */
  it('one where nobody touched the sensor', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ up: false }) });
    expect(bad(a)).toBe('NO_USER_PRESENT');
  });

  /**
   * A TOUCH IS NOT A PERSON.
   *
   * `userPresent` says a finger landed on the key; `userVerified` says the
   * device checked whose finger it was. This flag was parsed and never
   * looked at — and the login route skips the password AND the six digits
   * on the strength of it, so a USB key with no PIN set signed a full
   * session for a role that may not sign in without a second factor.
   *
   * `userVerification: 'required'` is a request the browser carries, not a
   * promise; the spec puts this check on the relying party.
   */
  it('and one where the device never checked WHO touched it', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ uv: false }) });
    expect(bad(a)).toBe('NO_USER_VERIFIED');
  });

  it('while a device that did check is let through', () => {
    // The other half of the rule: this line must not refuse an honest key,
    // and every ceremony in `passkey-browser.ts` asks for exactly this.
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ uv: true }) });
    expect(verifyAssertion(a).ok, 'رُفض توقيعٌ سليم').toBe(true);
  });

  /** A counter that repeats is what a cloned key produces. */
  it('one whose counter did not advance', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ counter: 5 }), storedCounter: 5 });
    expect(bad(a)).toBe('COUNTER_REUSED');
  });

  /**
   * Most phones keep no counter and report zero for ever. Refusing them
   * would refuse the commonest authenticator there is.
   */
  it('but a key that never counts is not a clone', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c, auth: authData({ counter: 0 }), storedCounter: 0 });
    expect(verifyAssertion(a).ok).toBe(true);
  });

  it('one signed by a different key', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    expect(bad({ ...a, credential: { ...a.credential, publicKey: es256().spki } })).toBe('BAD_SIGNATURE');
  });

  it('and one whose authenticator data was edited after signing', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    const tampered = b64url.decode(a.authenticatorData);
    tampered.writeUInt32BE(99, 33);
    expect(bad({ ...a, authenticatorData: b64url.encode(tampered) })).toBe('BAD_SIGNATURE');
  });

  it('and garbage instead of client data', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    expect(bad({ ...a, clientDataJSON: b64url.encode(Buffer.from('not json')) })).toBe('BAD_CLIENT_DATA');
  });

  it('and authenticator data too short to be any', () => {
    const a = assertion(es256(), COSE_ES256, { challenge: c });
    expect(bad({ ...a, authenticatorData: b64url.encode(Buffer.alloc(10)) })).toBe('BAD_AUTH_DATA');
  });
});

describe('registration', () => {
  it('accepts its own ceremony and refuses the other one', () => {
    const c = newChallenge();
    expect(
      verifyRegistration({
        clientDataJSON: clientData({ type: 'webauthn.create', challenge: c }),
        expected: { challenge: c, origin: ORIGIN },
        algorithm: COSE_ES256,
      }).ok
    ).toBe(true);

    const asGet = verifyRegistration({
      clientDataJSON: clientData({ challenge: c }),
      expected: { challenge: c, origin: ORIGIN },
      algorithm: COSE_ES256,
    });
    expect(asGet.ok).toBe(false);
    if (!asGet.ok) expect(asGet.code).toBe('WRONG_CEREMONY');
  });
});

describe('who we are, as the browser sees us', () => {
  it('the hostname is the rpId and the whole thing is the origin', () => {
    expect(relyingParty('https://crm.zakiai.io')).toEqual({ rpId: 'crm.zakiai.io', origin: 'https://crm.zakiai.io' });
  });

  /** WebAuthn requires a secure context; localhost is the specified exception. */
  it('and plain http is refused everywhere but localhost', () => {
    expect(relyingParty('http://example.com')).toBeNull();
    expect(relyingParty('http://localhost:3000')?.rpId).toBe('localhost');
  });
});

/**
 * THE ORIGIN THE BROWSER IS AT, not the socket this process answers on.
 *
 * Measured on the production build on 2026-10-02: a request carrying
 * `Host: app.example.com` and `X-Forwarded-Proto: https` came out of
 * `new URL(req.url).origin` as `http://localhost:3100`. localhost is the
 * secure-context exception, so nothing refused it — the API issued a
 * challenge for `rpId: "localhost"` to a browser on the real domain, and the
 * browser refused it where no log could see.
 */
describe('finding the public origin behind a proxy', () => {
  const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const before = { ...process.env };
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    try {
      fn();
    } finally {
      process.env = before;
    }
  };

  it('takes APP_URL first, because it cannot be spoofed by a header', () => {
    withEnv({ APP_URL: 'https://crm.zakiai.io', TRUST_PROXY: 'true' }, () => {
      expect(publicOrigin(req('http://localhost:3000/api/x', { host: 'evil.example' })))
        .toBe('https://crm.zakiai.io');
    });
  });

  it('and a malformed APP_URL does not take the feature down', () => {
    withEnv({ APP_URL: 'not a url', TRUST_PROXY: undefined }, () => {
      expect(publicOrigin(req('http://localhost:3000/api/x'))).toBe('http://localhost:3000');
    });
  });

  it('then the proxy headers, but ONLY when the deployment says to trust them', () => {
    const r = req('http://localhost:3100/api/x', {
      host: 'internal:3100',
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-proto': 'https',
    });
    withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined, TRUST_PROXY: 'true' }, () => {
      expect(publicOrigin(r)).toBe('https://app.example.com');
    });
    // Without TRUST_PROXY the headers are a stranger's word and are ignored.
    withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined, TRUST_PROXY: undefined }, () => {
      expect(publicOrigin(r)).toBe('http://localhost:3100');
    });
  });

  it('and a chain of proxies is read from its first hop', () => {
    const r = req('http://localhost:3100/api/x', {
      'x-forwarded-host': 'app.example.com, inner.local',
      'x-forwarded-proto': 'https, http',
    });
    withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined, TRUST_PROXY: 'true' }, () => {
      expect(publicOrigin(r)).toBe('https://app.example.com');
    });
  });

  it('and the request itself is the answer in development', () => {
    withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined, TRUST_PROXY: undefined }, () => {
      expect(publicOrigin(req('http://localhost:3000/api/x'))).toBe('http://localhost:3000');
    });
  });
});

describe('the shape of the thing', () => {
  const assertRoute = () => stripComments(repoFile('src/app/api/auth/passkey/assert/route.ts'));
  const regRoute = () => stripComments(repoFile('src/app/api/auth/passkey/register/route.ts'));

  /**
   * IT REPLACES THE CODE, NOT THE PASSWORD. The login ticket is what says
   * the password was already accepted, and this path cannot be reached
   * without one.
   */
  it('a sign-in needs the ticket the password issued', () => {
    const src = assertRoute();
    expect(src).toMatch(/readChallenge\(body\?\.challenge, 'verify'\)/);
    expect(src, 'يفتح جلسةً بلا التذكرة').toMatch(/if \(!ticket\) \{/);
  });

  /**
   * Without this, anybody's fingerprint would finish anybody's half-done
   * login: the password proved for one account, the second factor for
   * another.
   */
  it('and the key must belong to the account the ticket is for', () => {
    expect(assertRoute()).toMatch(/credential\.userId !== ticket\.userId/);
  });

  /** A third copy of the session line is where the version bump goes missing. */
  it('and the session comes from the one issuer', () => {
    const src = assertRoute();
    expect(src).toContain('issueSession({');
    expect(src).toContain("factor: 'password+passkey'");
    expect(src, 'يكتب الجلسة بنفسه').not.toContain('createSessionToken');
  });

  /** Two people answering one challenge is exactly the race a replay is. */
  it('and a challenge is spent once, in the statement that finds it', () => {
    for (const [name, src] of [['assert', assertRoute()], ['register', regRoute()]] as const) {
      expect(src, `${name}: التحدّي يُقرأ ولا يُستهلك`).toMatch(
        /updateMany\(\{\s*where: \{ id: \w+\.id, usedAt: null \},\s*data: \{ usedAt: now \}/
      );
      expect(src, `${name}: لا يتحقّق أنّه هو من استهلكه`).toMatch(/spent\.count !== 1/);
    }
  });

  /** A ticket is ten minutes long; an account suspended inside them must not open. */
  it('and a suspended account is refused even mid-login', () => {
    expect(assertRoute()).toMatch(/status === 'SUSPENDED' \|\| status === 'DISABLED'/);
  });

  /** Per user AND per address: the same reasoning the code path carries. */
  it('and guessing is limited on both axes', () => {
    const src = assertRoute();
    expect(src).toMatch(/rateLimit\(`passkey:user:/);
    expect(src).toMatch(/rateLimitByIp\('passkey:ip', ip,/);
  });

  /** Adding a way in must not be something a stolen session can do alone. */
  it('registering one requires being signed in already', () => {
    expect(regRoute()).toMatch(/const me = await getCurrentUser\(\);/);
    expect(regRoute()).toMatch(/if \(!me\) return NextResponse\.json/);
  });

  /** There is no secret here — but the trail still says a way in was added. */
  it('and both adding and removing a key are written down', () => {
    expect(regRoute()).toContain("action: 'PASSKEY_REGISTERED'");
    expect(stripComments(repoFile('src/app/api/auth/passkey/route.ts'))).toContain("action: 'PASSKEY_REMOVED'");
  });

  it('and a failed attempt is written down too', () => {
    expect(assertRoute()).toContain("action: 'PASSKEY_FAILED'");
  });

  /** The key list has no use for the public key, and an unsent field cannot leak. */
  it('and the list never returns the key material', () => {
    const list = stripComments(repoFile('src/app/api/auth/passkey/route.ts'));
    const sel = list.slice(list.indexOf('db.passkey.findMany'), list.indexOf('orderBy'));
    expect(sel, 'ترسل المفتاح العامّ بلا حاجة').not.toContain('publicKey');
  });

  /** A rollback beside every migration is this project's rule. */
  it('and the migration can be undone', () => {
    const back = repoFile('prisma/migrations/20260927020000_passkeys/rollback.sql');
    expect(back).toContain('DROP TABLE IF EXISTS "passkeys"');
    expect(back).toContain('DROP TABLE IF EXISTS "passkey_challenges"');
  });
});

describe('the reader that is not a parser', () => {
  it('reads the three fields at their fixed offsets', () => {
    const d = readAuthData(authData({ counter: 7, uv: true }));
    expect(d?.counter).toBe(7);
    expect(d?.userPresent).toBe(true);
    expect(d?.userVerified).toBe(true);
    expect(d?.rpIdHash).toHaveLength(32);
  });

  it('and refuses anything too short to hold them', () => {
    expect(readAuthData(Buffer.alloc(36))).toBeNull();
  });

  it('and base64url survives a round trip, padding and all', () => {
    for (const n of [1, 2, 3, 31, 32, 64]) {
      const buf = Buffer.alloc(n, 0xfb);
      expect(b64url.decode(b64url.encode(buf)).equals(buf), `${n} بايت`).toBe(true);
    }
  });
});
