import type { SessionUser } from '@/types/auth';
import { userCan } from './can';

/**
 * WHO MAY STRIP SOMEBODY ELSE'S SECOND FACTOR, AND WHO MAY SET THEIR PASSWORD.
 *
 * «زر لـ reset الـ 2FA للموظفين، بس للمالك حصراً» — and the «حصراً» is still the
 * whole rule: nothing about it is decoration.
 *
 * Until PR-13 this was granted by two role NAMES, deliberately, so the set of people who may
 * weaken an account's login could not widen by a tick another manager handed out. It is a KEY now
 * (`users.security`, decided by the owner as D6: the owner AND the company admin keep it) because a
 * name cannot be unticked, and the owner could not take it from a company admin who no longer
 * should hold it. The key stays out of every other role: the migration gave it to those two names
 * and to nobody else, and granting it is held to the same rule as every key — nobody can hand over
 * a key they do not hold.
 *
 * SUPER_ADMIN holds it centrally and always (`userCan`, like the server's `can`): unticking the key
 * from everybody else can never leave an account that nobody can recover.
 *
 * Pure, so the rule can be read and tested without a request.
 */

export type ResetVerdict =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

export function mayResetTwoFactor(user: SessionUser, targetUserId: string): ResetVerdict {
  if (!userCan(user, 'users.security')) {
    return {
      ok: false,
      status: 403,
      code: 'NO_SECURITY_KEY',
      error: 'إعادة ضبط التحقّق بخطوتين تحتاج صلاحية «إعادة ضبط دخول موظف».',
    };
  }

  /**
   * AND NEVER YOUR OWN.
   *
   * An owner resetting themselves proves nothing — the session doing it is
   * already past the factor — but it is exactly the move a stolen session
   * makes to shed the one thing it could not pass. Re-enrolling your own
   * phone happens on your own security screen, with the current code.
   */
  if (user.id === targetUserId) {
    return {
      ok: false,
      status: 403,
      code: 'NOT_YOURSELF',
      error: 'لا تُعيد ضبط تحقّقك أنت من هنا — أعِد تسجيله من شاشة أمانك بالرمز الحالي.',
    };
  }

  return { ok: true };
}

/**
 * WHO MAY ISSUE THE CODE THAT LETS SOMEBODY SET UP THEIR SECOND FACTOR FOR THE FIRST TIME (A2).
 *
 * The same key and the same two limits as stripping a factor, for the same reason: the code decides whose phone becomes
 * the account's second factor, which is a way into an account that is not yours. Never your own: an owner who vouches
 * for themselves vouches for whoever is holding their session.
 */
export function mayIssueEnrolCode(user: SessionUser, targetUserId: string): ResetVerdict {
  if (!userCan(user, 'users.security')) {
    return {
      ok: false,
      status: 403,
      code: 'NO_SECURITY_KEY',
      error: 'إصدار رمز التفعيل يحتاج صلاحية «إعادة ضبط دخول موظف».',
    };
  }
  if (user.id === targetUserId) {
    return {
      ok: false,
      status: 403,
      code: 'NOT_YOURSELF',
      error: 'لا تُصدر رمز التفعيل لنفسك — يُصدره لك مدير آخر.',
    };
  }
  return { ok: true };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AND WHO MAY SET SOMEBODY ELSE'S PASSWORD.
 *
 * The same key, for the same reason, and that is why it lives here
 * rather than in a file of its own: both acts hand somebody a way into an
 * account that is not theirs. `users.edit` is not enough — it is held by
 * MANAGER, and a manager who may edit a profile must not be able to set
 * the password on the account above them. (The door asks `users.edit` too,
 * before it gets here: this is the second lock, not the first.)
 *
 * NEVER YOUR OWN, either. An owner changing their own password does it on
 * their own security screen, where the CURRENT one is asked for first;
 * this door never asks for it, because it is for the person who has lost
 * theirs. A stolen session must not be able to lock the real owner out.
 */
export function maySetPassword(user: SessionUser, targetUserId: string): ResetVerdict {
  if (!userCan(user, 'users.security')) {
    return {
      ok: false,
      status: 403,
      code: 'NO_SECURITY_KEY',
      error: 'تغيير كلمة سرّ موظّف يحتاج صلاحية «إعادة ضبط دخول موظف».',
    };
  }
  if (user.id === targetUserId) {
    return {
      ok: false,
      status: 403,
      code: 'NOT_YOURSELF',
      error: 'غيّر كلمة سرّك أنت من شاشة أمانك — هناك تُسألُ عن الحاليّة أوّلاً.',
    };
  }
  return { ok: true };
}

/**
 * A PASSWORD NOBODY CHOSE, FOR WHEN THE OWNER WANTS ONE GENERATED.
 *
 * Satisfies `PASSWORD_RULES` by construction rather than by luck: one
 * character from each required class, then randomness, then shuffled so
 * the shape is not predictable. The caller shows it once and never stores
 * it anywhere but the hash.
 */
export function generatePassword(randomInt: (max: number) => number): string {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';
  const DIGIT = '23456789';
  const ALL = UPPER + LOWER + DIGIT;
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)];
  while (chars.length < 14) chars.push(pick(ALL));
  // Fisher-Yates, so the first three positions are not always the classes.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
