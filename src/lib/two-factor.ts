import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secrets';
import { generateSecret, otpauthUri, verifyCode } from './totp';
import { twoFactorRequired } from './auth-switches';

type Tx = Prisma.TransactionClient | typeof prismaDb;

export class TwoFactorRefused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * WHO MUST CARRY A SECOND FACTOR.
 *
 * The brief names three: owner, manager, accountant. In this system the
 * owner is `SUPER_ADMIN` or `COMPANY_ADMIN`, and `SETTLEMENT_OFFICER` is
 * added because the rule underneath the brief is «the roles whose password
 * moves money»: a settlement officer records the receipt that a closing is
 * approved against, and the two roles were deliberately split into two pairs
 * of hands. Protecting one half of a two-person rule is protecting neither.
 *
 * A moderator or a warehouse keeper is NOT here, and that is a decision, not
 * an oversight: a second factor on a phone that lives in a warehouse is a
 * phone that gets shared, and the rule would teach people to work around it.
 */
export const TWO_FACTOR_ROLES = [
  'SUPER_ADMIN',
  'COMPANY_ADMIN',
  'MANAGER',
  'ACCOUNTANT',
  'SETTLEMENT_OFFICER',
] as const;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EVERY ACCOUNT NOW CARRIES ONE — THE OWNER'S DECISION, AND IT REVERSES
 * THE PARAGRAPH ABOVE.
 *
 * That paragraph argued a moderator or a warehouse keeper should be left
 * out, because «a second factor on a phone that lives in a warehouse is a
 * phone that gets shared». The owner has overruled it, and the reason is
 * on the other side of the same fact: MODERATOR is the DEFAULT role for a
 * new account, and a moderator reads customers' names, phones and
 * addresses all day. The account most likely to exist is the account that
 * had no second factor at all.
 *
 * `TWO_FACTOR_ROLES` is kept rather than deleted: `requiresTwoFactor` is
 * now true for everybody, and the list still records which roles the rule
 * started with — for anyone reading the history of this decision.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function requiresTwoFactor(_role: string): boolean {
  return true;
}

/** The roles the rule began with, before it was widened to every account. */
export function wasOriginallyRequired(role: string): boolean {
  return (TWO_FACTOR_ROLES as readonly string[]).includes(role);
}

/** What the login has to do next, once the password is right. */
export type TwoFactorStep = 'none' | 'enrol' | 'verify';

export function stepFor(user: { role: string; totpEnabledAt: Date | null }): TwoFactorStep {
  /*
   * ═══ THE OWNER'S SWITCH, 11/11 — «بدي الغي ال 2fa» ═══
   *
   * Off (the default, `AUTH_TWO_FACTOR_REQUIRED` unset or not «on»): NOBODY is asked for the second code, and nobody is
   * sent to set one up — not an enrolled account (its secret, its recovery codes, its trusted-device token and its
   * fingerprints are all still there, untouched), and not one that never enrolled. The password alone opens the account.
   * This is the ONE place that decides it: the login door asks `stepFor`, and the second-factor doors (`/2fa/start`,
   * `/2fa/enrol`, `/2fa/verify`, `/passkey/assert`) only open on a challenge ticket that the login issues when this says
   * 'enrol' or 'verify' — so with the switch off none of them is reachable, and nobody is held at a step.
   *
   * On: exactly the rule that was here before, below. Putting it back is a changed variable and a restart.
   */
  if (!twoFactorRequired()) return 'none';
  /*
   * `requiresTwoFactor` is true for every role now, so this is «have you
   * enrolled yet». It is left reading the function rather than being
   * simplified away: the day somebody wants a role exempted again, there
   * is exactly one place to say so.
   */
  if (!requiresTwoFactor(user.role)) return 'none';
  return user.totpEnabledAt ? 'verify' : 'enrol';
}

const RECOVERY_COUNT = 8;

/** Readable aloud over a phone: no 0/O, no 1/I. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function recoveryCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function normaliseRecovery(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * BEGIN ENROLMENT — a secret that is not saved yet.
 *
 * The secret is handed to the browser and NOT stored: it becomes real only
 * when the person proves they scanned it by typing a code from it. Storing
 * it first would mean a half-enrolled account whose owner never got the QR
 * to load — locked out by a page that failed to render.
 */
export function beginEnrolment(account: string): { secret: string; uri: string } {
  if (!encryptionAvailable()) {
    throw new TwoFactorRefused(
      'NO_ENCRYPTION_KEY',
      'مفتاح التشفير غير مضبوط على الخادم — لا يُحفظ سرُّ التحقّق مكشوفاً'
    );
  }
  const secret = generateSecret();
  return { secret, uri: otpauthUri({ secret, account, issuer: 'Zaki AI OMS' }) };
}

/**
 * FINISH ENROLMENT: prove the authenticator works, then save it.
 *
 * Returns the recovery codes ONCE. They are hashed on the way in and cannot
 * be shown again — which is the point, and the screen has to say so.
 */
export async function completeEnrolment(
  tx: Tx,
  input: { userId: string; secret: string; code: string; now?: Date }
): Promise<{ recoveryCodes: string[] }> {
  const at = (input.now ?? new Date()).getTime();
  const check = verifyCode(input.secret, input.code, at);
  if (!check.ok) {
    throw new TwoFactorRefused('BAD_CODE', 'الرمز غير صحيح — تأكّد أنّ ساعة الهاتف مضبوطة وأعد المحاولة');
  }

  const user = await tx.user.findUnique({ where: { id: input.userId }, select: { totpEnabledAt: true } });
  if (!user) throw new TwoFactorRefused('NOT_FOUND', 'المستخدم غير موجود');
  if (user.totpEnabledAt) {
    throw new TwoFactorRefused('ALREADY_ENROLLED', 'التحقّق الثنائيّ مفعَّل على هذا الحساب أصلاً');
  }

  const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normaliseRecovery(c), 10)));

  await tx.user.update({
    where: { id: input.userId },
    data: {
      totpSecretEnc: encryptSecret(input.secret),
      totpEnabledAt: new Date(at),
      // The proving code is spent: enrolling with it must not also let it
      // sign in a second later.
      totpLastStep: check.step,
    },
  });
  await tx.twoFactorRecoveryCode.createMany({
    data: hashes.map((codeHash) => ({ userId: input.userId, codeHash })),
  });

  return { recoveryCodes: codes };
}

/**
 * CHECK A CODE AT SIGN-IN — six digits, or one recovery code.
 *
 * Refusals do not distinguish a wrong digit from a wrong recovery code: the
 * two answers together tell somebody which of the two they are closer to.
 */
export async function checkSecondFactor(
  tx: Tx,
  input: { userId: string; code: string; now?: Date }
): Promise<{ usedRecovery: boolean; recoveryLeft: number }> {
  const at = (input.now ?? new Date()).getTime();
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!user?.totpSecretEnc || !user.totpEnabledAt) {
    throw new TwoFactorRefused('NOT_ENROLLED', 'لم يُفعَّل التحقّق الثنائيّ على هذا الحساب');
  }

  let secret: string;
  try {
    secret = decryptSecret(user.totpSecretEnc);
  } catch {
    throw new TwoFactorRefused('NO_ENCRYPTION_KEY', 'تعذّر فكُّ سرِّ التحقّق — مفتاح التشفير على الخادم تغيّر');
  }

  const digits = input.code.replace(/\D/g, '');
  if (digits.length === 6) {
    const check = verifyCode(secret, digits, at, { notBeforeStep: user.totpLastStep });
    if (check.ok) {
      await tx.user.update({ where: { id: input.userId }, data: { totpLastStep: check.step } });
      const left = await tx.twoFactorRecoveryCode.count({ where: { userId: input.userId, usedAt: null } });
      return { usedRecovery: false, recoveryLeft: left };
    }
  }

  // A recovery code. Compared against every unused one because they are
  // hashed — there is nothing to look up by.
  const candidate = normaliseRecovery(input.code);
  if (candidate.length >= 8) {
    const unused = await tx.twoFactorRecoveryCode.findMany({
      where: { userId: input.userId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    for (const row of unused) {
      if (await bcrypt.compare(candidate, row.codeHash)) {
        await tx.twoFactorRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date(at) } });
        return { usedRecovery: true, recoveryLeft: unused.length - 1 };
      }
    }
  }

  throw new TwoFactorRefused('BAD_CODE', 'الرمز غير صحيح');
}
