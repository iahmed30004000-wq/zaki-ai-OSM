import { describe, expect, it, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * A SECOND FACTOR FOR THE ROLES WHOSE PASSWORD MOVES MONEY.
 *
 * The brief names owner, manager and accountant. `SETTLEMENT_OFFICER` is
 * here too, because the rule underneath is «whose password moves money»: the
 * settlement officer records the receipt a closing is approved against, and
 * the two were deliberately split into two pairs of hands. Protecting one
 * half of a two-person rule protects neither.
 *
 * A warehouse keeper is deliberately NOT here: a second factor on a phone
 * that lives in a warehouse is a phone that gets shared, and the rule would
 * teach people to work around it.
 */

vi.mock('./secrets', () => ({
  encryptionAvailable: () => true,
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('bad blob');
    return s.slice(4);
  },
}));

import {
  TWO_FACTOR_ROLES,
  TwoFactorRefused,
  beginEnrolment,
  checkSecondFactor,
  completeEnrolment,
  normaliseRecovery,
  requiresTwoFactor,
  stepFor,
  wasOriginallyRequired,
} from './two-factor';
import { currentCode, generateSecret, stepAt } from './totp';
import { repoFile, stripComments } from './guard-source';

describe('who must carry one', () => {
  it('covers the owner, the manager, the accountant — and the settlement officer', () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT', 'SETTLEMENT_OFFICER']) {
      expect(requiresTwoFactor(role), role).toBe(true);
    }
  });

  /**
   * AND NOW EVERYBODY ELSE TOO — THE OWNER REVERSED THIS.
   *
   * This test used to assert the opposite, under «a shared warehouse phone
   * is not a second factor». The owner's reason for overruling it is the
   * other side of the same fact: MODERATOR is the DEFAULT role for a new
   * account, and a moderator reads customers' names, phones and addresses
   * all day. The account most likely to exist was the one with no second
   * factor at all.
   */
  it('and now every other role as well, including a custom one', () => {
    for (const role of ['MODERATOR', 'CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'WAREHOUSE', 'DELIVERY_MANAGER', 'CONFIRMATION_SUPERVISOR', 'PENDING_USER', 'دور من صنع الشركة']) {
      expect(requiresTwoFactor(role), role).toBe(true);
    }
  });

  it('and the roles it started with are still recorded', () => {
    // Kept, not deleted: the history of the decision stays readable.
    expect(TWO_FACTOR_ROLES).toHaveLength(5);
    expect(wasOriginallyRequired('ACCOUNTANT')).toBe(true);
    expect(wasOriginallyRequired('MODERATOR')).toBe(false);
  });

  /**
   * AN UNENROLLED OWNER IS SENT TO ENROL, NOT TURNED AWAY.
   *
   * On the morning this ships nobody is enrolled. Refusing them would lock
   * every protected role out of the business at once, and that pressure is
   * exactly how a second factor gets switched off for everyone.
   */
  it('sends a protected role to enrol when it has none yet', () => {
    expect(stepFor({ role: 'ACCOUNTANT', totpEnabledAt: null })).toBe('enrol');
    expect(stepFor({ role: 'ACCOUNTANT', totpEnabledAt: new Date() })).toBe('verify');
    // And a warehouse keeper is sent to enrol now too, where he used to
    // be waved through with 'none'.
    expect(stepFor({ role: 'WAREHOUSE', totpEnabledAt: null })).toBe('enrol');
    expect(stepFor({ role: 'MODERATOR', totpEnabledAt: null })).toBe('enrol');
  });
});

function fakeTx(user: Record<string, unknown> | null, codes: { id: string; codeHash: string }[] = []) {
  const updates: Record<string, unknown>[] = [];
  const created: unknown[] = [];
  const spent: string[] = [];
  return {
    tx: {
      user: {
        findUnique: vi.fn(async () => user),
        update: vi.fn(async (a: Record<string, unknown>) => {
          updates.push(a);
          return {};
        }),
      },
      twoFactorRecoveryCode: {
        createMany: vi.fn(async (a: { data: unknown[] }) => {
          created.push(...a.data);
          return { count: a.data.length };
        }),
        findMany: vi.fn(async () => codes),
        count: vi.fn(async () => codes.length),
        update: vi.fn(async (a: { where: { id: string } }) => {
          spent.push(a.where.id);
          return {};
        }),
      },
    } as never,
    updates,
    created,
    spent,
  };
}

describe('enrolling', () => {
  const NOW = new Date('2026-10-01T10:00:00Z');

  it('hands out a secret and a URI without saving anything', () => {
    const { secret, uri } = beginEnrolment('owner@example.com');
    expect(secret).toHaveLength(32);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);
  });

  it('saves the secret encrypted, never in the clear', async () => {
    const secret = generateSecret();
    const { tx, updates } = fakeTx({ totpEnabledAt: null });
    await completeEnrolment(tx, {
      userId: 'u1',
      secret,
      code: currentCode(secret, NOW.getTime()),
      now: NOW,
    });
    const data = (updates[0] as { data: Record<string, unknown> }).data;
    expect(data.totpSecretEnc).toBe(`enc:${secret}`);
    expect(String(data.totpSecretEnc), 'السرّ مكتوبٌ مكشوفاً').not.toBe(secret);
    expect(data.totpEnabledAt).toBeInstanceOf(Date);
  });

  /**
   * THE CODE THAT PROVED THE SCAN IS SPENT.
   *
   * Without this, the six digits typed to finish enrolment would still sign
   * the person in a second later — the first code ever generated would be
   * usable twice.
   */
  it('spends the proving code so it cannot also sign in', async () => {
    const secret = generateSecret();
    const { tx, updates } = fakeTx({ totpEnabledAt: null });
    await completeEnrolment(tx, { userId: 'u1', secret, code: currentCode(secret, NOW.getTime()), now: NOW });
    expect((updates[0] as { data: { totpLastStep: number } }).data.totpLastStep).toBe(stepAt(NOW.getTime()));
  });

  it('returns eight recovery codes, and stores only their hashes', async () => {
    const secret = generateSecret();
    const { tx, created } = fakeTx({ totpEnabledAt: null });
    const { recoveryCodes } = await completeEnrolment(tx, {
      userId: 'u1', secret, code: currentCode(secret, NOW.getTime()), now: NOW,
    });
    expect(recoveryCodes).toHaveLength(8);
    expect(created).toHaveLength(8);
    for (const row of created as { codeHash: string }[]) {
      expect(row.codeHash.startsWith('$2'), 'الرمز مخزَّن كما هو').toBe(true);
      expect(recoveryCodes, 'الرمز الخام في قاعدة البيانات').not.toContain(row.codeHash);
    }
  });

  /** Readable aloud: no 0/O and no 1/I to mishear. */
  it('and a recovery code has no character you could mishear', async () => {
    const secret = generateSecret();
    const { tx } = fakeTx({ totpEnabledAt: null });
    const { recoveryCodes } = await completeEnrolment(tx, {
      userId: 'u1', secret, code: currentCode(secret, NOW.getTime()), now: NOW,
    });
    for (const c of recoveryCodes) expect(c, c).not.toMatch(/[O01I]/);
  });

  it('refuses a wrong proving code, and saves nothing', async () => {
    const secret = generateSecret();
    const { tx, updates, created } = fakeTx({ totpEnabledAt: null });
    const e = await completeEnrolment(tx, { userId: 'u1', secret, code: '000000', now: NOW }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e).toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('BAD_CODE');
    expect(updates).toEqual([]);
    expect(created).toEqual([]);
  });

  it('refuses to enrol an account that already has one', async () => {
    const secret = generateSecret();
    const { tx } = fakeTx({ totpEnabledAt: new Date() });
    const e = await completeEnrolment(tx, {
      userId: 'u1', secret, code: currentCode(secret, NOW.getTime()), now: NOW,
    }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e, 'قُبل تسجيلٌ ثانٍ').toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('ALREADY_ENROLLED');
  });
});

describe('checking the second factor', () => {
  const NOW = new Date('2026-10-01T10:00:00Z');
  const secret = generateSecret();
  const enrolled = { totpSecretEnc: `enc:${secret}`, totpEnabledAt: new Date('2026-09-01'), totpLastStep: null };

  it('accepts the code of the moment and records the step it spent', async () => {
    const { tx, updates } = fakeTx({ ...enrolled });
    const out = await checkSecondFactor(tx, { userId: 'u1', code: currentCode(secret, NOW.getTime()), now: NOW });
    expect(out.usedRecovery).toBe(false);
    expect((updates[0] as { data: { totpLastStep: number } }).data.totpLastStep).toBe(stepAt(NOW.getTime()));
  });

  /** The same six digits must not open the door twice inside their window. */
  it('refuses a code already spent', async () => {
    const code = currentCode(secret, NOW.getTime());
    const { tx } = fakeTx({ ...enrolled, totpLastStep: stepAt(NOW.getTime()) });
    const e = await checkSecondFactor(tx, { userId: 'u1', code, now: NOW }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e, 'قُبل رمزٌ مصروف').toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('BAD_CODE');
  });

  it('accepts a recovery code, spends it, and says how many are left', async () => {
    const plain = 'ABCDE-FGHJK';
    const hash = await bcrypt.hash(normaliseRecovery(plain), 10);
    const { tx, spent } = fakeTx({ ...enrolled }, [
      { id: 'r1', codeHash: hash },
      { id: 'r2', codeHash: await bcrypt.hash('ZZZZZZZZZZ', 10) },
    ]);
    const out = await checkSecondFactor(tx, { userId: 'u1', code: plain, now: NOW });
    expect(out.usedRecovery).toBe(true);
    expect(out.recoveryLeft).toBe(1);
    expect(spent).toEqual(['r1']);
  });

  it('and accepts it however it was typed', async () => {
    const hash = await bcrypt.hash(normaliseRecovery('ABCDE-FGHJK'), 10);
    for (const typed of ['abcde-fghjk', 'ABCDEFGHJK', 'abcde fghjk']) {
      const { tx } = fakeTx({ ...enrolled }, [{ id: 'r1', codeHash: hash }]);
      const out = await checkSecondFactor(tx, { userId: 'u1', code: typed, now: NOW });
      expect(out.usedRecovery, typed).toBe(true);
    }
  });

  it('refuses a recovery code that was already spent', async () => {
    const hash = await bcrypt.hash(normaliseRecovery('ABCDE-FGHJK'), 10);
    // `findMany` is filtered to unused; a spent one is simply not there.
    const { tx } = fakeTx({ ...enrolled }, []);
    void hash;
    const e = await checkSecondFactor(tx, { userId: 'u1', code: 'ABCDE-FGHJK', now: NOW }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e).toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('BAD_CODE');
  });

  it('refuses when the account has none enrolled', async () => {
    const { tx } = fakeTx({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null });
    const e = await checkSecondFactor(tx, { userId: 'u1', code: '123456', now: NOW }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e).toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('NOT_ENROLLED');
  });

  /**
   * A CHANGED ENCRYPTION KEY IS NOT «WRONG CODE».
   *
   * Telling somebody their code is wrong when the server cannot read the
   * secret sends them to re-type a correct code for an hour.
   */
  it('says so when the secret cannot be decrypted', async () => {
    const { tx } = fakeTx({ totpSecretEnc: 'garbage', totpEnabledAt: new Date(), totpLastStep: null });
    const e = await checkSecondFactor(tx, { userId: 'u1', code: '123456', now: NOW }).then(
      () => null,
      (x: unknown) => x as TwoFactorRefused
    );
    expect(e).toBeInstanceOf(TwoFactorRefused);
    expect(e!.code).toBe('NO_ENCRYPTION_KEY');
  });

  it('and a wrong code spends nothing', async () => {
    const { tx, updates, spent } = fakeTx({ ...enrolled }, [{ id: 'r1', codeHash: await bcrypt.hash('ZZZZZZZZZZ', 10) }]);
    await checkSecondFactor(tx, { userId: 'u1', code: '000000', now: NOW }).catch(() => null);
    expect(updates).toEqual([]);
    expect(spent).toEqual([]);
  });
});

describe('the doors', () => {
  /**
   * THE PASSWORD ALONE NO LONGER ISSUES A SESSION FOR A PROTECTED ROLE.
   *
   * This is the whole feature, and it is one `return` in the login route. A
   * guard on it because a future edit that moves the session issuance back
   * above this check would pass every other test in this file.
   */
  it('login stops before the session when a second factor is due', () => {
    const route = stripComments(repoFile('src/app/api/auth/login/route.ts'));
    const gate = route.indexOf('stepFor({');
    const issue = route.indexOf('issueSession(');
    expect(gate, 'لا بوّابة عامل ثانٍ في الدخول').toBeGreaterThan(0);
    expect(issue, 'الدخول لا يُصدر جلسة').toBeGreaterThan(0);
    expect(gate, 'الجلسة تُصدر قبل فحص العامل الثاني').toBeLessThan(issue);
  });

  /**
   * AND NOTHING IS BUMPED BEFORE THE SECOND FACTOR PASSES.
   *
   * `tokenVersion` is what makes an account work on one device at a time.
   * Bumping it on a correct password alone would let a stolen password sign
   * an owner out of the device they are working on, again and again, without
   * ever getting in.
   */
  it('and changes nothing about the account until it does', () => {
    const route = stripComments(repoFile('src/app/api/auth/login/route.ts'));
    expect(route, 'الدخول يرفع tokenVersion قبل العامل الثاني').not.toContain('tokenVersion');
    const signIn = stripComments(repoFile('src/lib/sign-in.ts'));
    expect(signIn, 'الرفع ليس في مُصدِر الجلسة').toContain('tokenVersion: { increment: 1 }');
  });

  /** One place issues a session, so the bump cannot go missing from one door. */
  it('both doors issue a session through the same function', () => {
    for (const rel of ['src/app/api/auth/login/route.ts', 'src/app/api/auth/2fa/verify/route.ts']) {
      const src = stripComments(repoFile(rel));
      expect(src, `${rel}: لا يمرّ بمُصدِر الجلسة`).toContain('issueSession(');
      expect(src, `${rel}: يكتب الكوكي بنفسه`).not.toContain('response.cookies.set');
    }
  });

  /**
   * SIX DIGITS ARE A MILLION GUESSES, AND A MILLION IS NOT MANY.
   *
   * Per user AND per address: per address alone lets a botnet spread the
   * guessing, per user alone lets one address grind every account.
   */
  it('throttles the verify door by user and by address', () => {
    const route = stripComments(repoFile('src/app/api/auth/2fa/verify/route.ts'));
    expect(route).toMatch(/rateLimit\(`2fa:verify:user:/);
    expect(route).toMatch(/rateLimitByIp\('2fa:verify:ip', ip,/);
  });

  /** A ticket is ten minutes long; a suspension inside them must still bite. */
  it('re-checks the account status at the second door', () => {
    const route = stripComments(repoFile('src/app/api/auth/2fa/verify/route.ts'));
    expect(route).toContain("status === 'SUSPENDED'");
    expect(route).toContain("status === 'DISABLED'");
  });

  /** Neither the secret nor a recovery code is ever written to the audit log. */
  it('never writes a secret or a recovery code where it can be read', () => {
    const enrol = stripComments(repoFile('src/app/api/auth/2fa/enrol/route.ts'));
    // From the call, forward — not to the first `return NextResponse`, which
    // in this file is the 429 above it, giving an empty slice that asserts
    // nothing. The first version of this test did exactly that.
    const at = enrol.indexOf('await logAudit(');
    const audit = enrol.slice(at, at + 500);
    expect(audit, 'السرّ في سجل التدقيق').not.toContain('secret');
    expect(audit).toContain('recoveryCodes.length');
  });
});
