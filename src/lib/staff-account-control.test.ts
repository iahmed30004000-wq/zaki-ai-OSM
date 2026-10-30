import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { maySetPassword, mayResetTwoFactor, generatePassword } from './two-factor-reset';
import { passwordProblems } from './password-rules';
import { requiresTwoFactor, stepFor } from './two-factor';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OWNER CONTROLS STAFF ACCOUNTS — AND NOBODY WALKS PAST THE SECOND
 * FACTOR.
 *
 * The owner asked to SEE a staff password. The system cannot: it stores a
 * bcrypt hash and nothing else, and that is the property that makes a
 * database leak survivable. So the honest answer is the one the screen
 * gives — set a new one, see THAT once, and the employee's open sessions
 * end with it.
 *
 * And he asked why an account created inside the system has no second
 * factor. It had none because the rule read a list of five roles, and
 * MODERATOR — the DEFAULT for a new account, which reads customers' names,
 * phones and addresses all day — was not on it.
 * ═══════════════════════════════════════════════════════════════════════
 */

// PR-13 (قديم ← جديد): who may set a password is a KEY now (`users.security`), so a person carries the keys they hold; the owner
// holds every key centrally and needs none listed.
const who = (role: string, id = 'me', permissions: string[] = []): SessionUser => ({ id, role, status: 'ACTIVE', permissions }) as unknown as SessionUser;
const SOMEBODY = 'other-person';

describe('who may set a staff password', () => {
  it('the owner (centrally), and the company owner (who holds the key)', () => {
    expect(maySetPassword(who('SUPER_ADMIN'), SOMEBODY), 'SUPER_ADMIN').toEqual({ ok: true });
    expect(maySetPassword(who('COMPANY_ADMIN', 'me', ['users.security']), SOMEBODY), 'COMPANY_ADMIN').toEqual({ ok: true });
  });

  it('and not a manager, even holding users.edit — only the key opens it', () => {
    /*
     * `users.edit` is what opens the route, and MANAGER holds it. Without
     * this check a manager could set the password on the account above
     * them. It is a box of its own (`users.security`): the migration gave it to the company
     * admin and to nobody else, and nobody can hand over a key they do not hold.
     */
    for (const role of ['MANAGER', 'ACCOUNTANT', 'MODERATOR', 'CONFIRMATION_SUPERVISOR', 'دور من صنع الشركة', 'COMPANY_ADMIN']) {
      const verdict = maySetPassword(who(role, 'me', ['users.view', 'users.edit']), SOMEBODY);
      expect(verdict.ok, role).toBe(false);
      expect(verdict).toMatchObject({ status: 403, code: 'NO_SECURITY_KEY' });
    }
  });

  it('and the key alone makes ANY role able — a manager the owner ticked it for', () => {
    expect(maySetPassword(who('MANAGER', 'me', ['users.security']), SOMEBODY)).toEqual({ ok: true });
  });

  it('and never on himself', () => {
    // This door never asks for the CURRENT password — it is for the person
    // who has lost theirs. A stolen session must not use it to lock the
    // real owner out.
    const verdict = maySetPassword(who('SUPER_ADMIN', 'me'), 'me');
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ code: 'NOT_YOURSELF' });
  });

  it('and it is the same rule that governs the second factor', () => {
    // Both hand somebody a way into an account that is not theirs.
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'MODERATOR']) {
      for (const permissions of [[], ['users.security'], ['users.edit']]) {
        expect(maySetPassword(who(role, 'me', permissions), SOMEBODY).ok, `${role} ${permissions}`).toBe(
          mayResetTwoFactor(who(role, 'me', permissions), SOMEBODY).ok
        );
      }
    }
  });
});

describe('a generated password', () => {
  /** Deterministic, so a failure names a password rather than a coin toss. */
  const seeded = (seed: number) => {
    let x = seed;
    return (max: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % max;
    };
  };

  it('satisfies every rule the form asks of a typed one', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const pw = generatePassword(seeded(seed));
      expect(passwordProblems(pw), `seed ${seed}: ${pw}`).toEqual([]);
    }
  });

  it('and is long enough to be worth generating', () => {
    expect(generatePassword(seeded(7))).toHaveLength(14);
  });

  it('and does not put the required classes in fixed positions', () => {
    /*
     * Built as upper + lower + digit then padded, so without the shuffle
     * every generated password would start with a capital and have its
     * digit third — a shape anybody who read this file could narrow by.
     */
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) firsts.add(generatePassword(seeded(seed))[0]);
    expect(firsts.size, 'الحرف الأول ثابت — الخلط لا يخلط').toBeGreaterThan(5);
  });
});

describe('every account carries a second factor', () => {
  it('including the default role for a new account', () => {
    // MODERATOR is what a new account gets, and it was the one role the
    // old list left out.
    expect(requiresTwoFactor('MODERATOR')).toBe(true);
    expect(stepFor({ role: 'MODERATOR', totpEnabledAt: null })).toBe('enrol');
  });

  it('and a custom role nobody wrote into any list', () => {
    expect(stepFor({ role: 'موظّف تأكيد — من صنع الشركة', totpEnabledAt: null })).toBe('enrol');
  });

  it('and an already-enrolled account is asked to verify, not to enrol again', () => {
    // Nobody's phone is reset by this change.
    expect(stepFor({ role: 'MODERATOR', totpEnabledAt: new Date() })).toBe('verify');
    expect(stepFor({ role: 'ACCOUNTANT', totpEnabledAt: new Date() })).toBe('verify');
  });
});

describe('no door creates a session around the second factor', () => {
  const reset = () => stripComments(repoFile('src/app/api/auth/reset-password/route.ts'));
  const register = () => stripComments(repoFile('src/app/api/auth/register/route.ts'));

  it('the password-reset door sets no cookie', () => {
    /*
     * It used to sign a session itself — «Auto-login after successful
     * reset» — which is a login that never passes `stepFor`. Whoever holds
     * a reset link holds the password; the second factor is the half that
     * says they are also the person.
     */
    const src = reset();
    expect(src, 'باب الاستعادة ما زال يفتح جلسة').not.toMatch(/cookies\.set/);
    expect(src).not.toMatch(/createSessionToken/);
    expect(src).toMatch(/signIn: true/);
  });

  it('and registering sets none either', () => {
    // A brand-new account is precisely one with no enrolment yet — and the
    // very first SUPER_ADMIN must not be the one account that got in
    // without enrolling.
    const src = register();
    expect(src, 'باب التسجيل ما زال يفتح جلسة').not.toMatch(/cookies\.set/);
    expect(src).not.toMatch(/createSessionToken/);
    expect(src).toMatch(/signIn: true/);
  });

  it('and both screens send the person to the login page', () => {
    for (const f of ['src/app/(system)/reset-password/page.tsx', 'src/app/(system)/register/page.tsx']) {
      expect(stripComments(repoFile(f)), f).toMatch(/router\.push\([^)]*'\/login'\)/);
    }
  });

  it('and a passkey login says, in the code, why it asks for no code', () => {
    /*
     * Not a gap in the rule: a passkey IS a possession factor. Sending
     * somebody who signed with one on to type six digits asks them to
     * prove possession twice, and people answer that by abandoning the
     * stronger method.
     */
    const src = repoFile('src/app/api/auth/passkey/login/route.ts');
    expect(src).toMatch(/AND NO SECOND FACTOR IS ASKED FOR, BECAUSE THIS WAS ONE/);
    expect(stripComments(src)).toMatch(/factor: 'passkey'/);
  });
});

describe('the password door never hands anything back twice', () => {
  const route = () => stripComments(repoFile('src/app/api/users/[id]/route.ts'));

  it('returns the characters once, in the response that set them', () => {
    const src = route();
    expect(src).toMatch(/temporaryPassword: tempPassword/);
    // And there is no GET that could be asked for it again.
    expect(src, 'ظهر بابٌ يُعيد قراءة كلمة السرّ').not.toMatch(/temporaryPassword/g.source && /GET[\s\S]{0,400}temporaryPassword/);
  });

  it('and ends every session the employee had — in the resetPassword branch itself', () => {
    // RV16: asked of the WHOLE file this stayed green when the raise was removed from this branch,
    // because `changeStatus` and `forceLogout` carry the same line. Cut to this branch only.
    const src = route();
    const from = src.indexOf("action === 'resetPassword'");
    const to = src.indexOf("action === 'updateContact'", from);
    expect(from, 'فرع resetPassword اختفى').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(src.slice(from, to)).toMatch(/updateData\.tokenVersion = \{ increment: 1 \}/);
  });

  it('and a typed password is judged by the same rules as every other door', () => {
    expect(route()).toMatch(/passwordMessage\(typed\)/);
  });

  it('and the audit records that it happened, never what it was', () => {
    const src = route();
    expect(src).toMatch(/action: 'USER_PASSWORD_RESET_BY_ADMIN'/);
    expect(src, 'كلمة السرّ في سجلّ التدقيق').not.toMatch(/newData: \{[^}]*tempPassword/);
  });
});

describe('the screens say the state', () => {
  it('the list returns it, as a date and never a secret', () => {
    const api = stripComments(repoFile('src/app/api/users/route.ts'));
    expect(api).toMatch(/totpEnabledAt: true/);
    expect(api, 'السرّ يخرج من قاعدة البيانات').not.toMatch(/totpSecretEnc/);
  });

  it('and the list draws it in both states', () => {
    const screen = stripComments(repoFile('src/components/screens/UsersScreen.tsx'));
    expect(screen).toContain('مفعّل');
    expect(screen).toContain('بانتظار أوّل دخول');
  });

  it('and the employee page says it even when there is nothing to reset', () => {
    /*
     * The 2FA card used to be drawn only when an enrolment EXISTED, so the
     * accounts with none — the ones the owner most needs to know about —
     * were the ones it said nothing about.
     */
    const screen = stripComments(repoFile('src/components/screens/UserDetailScreen.tsx'));
    expect(screen).toMatch(/\{!user\.totpEnabledAt && \(/);
    expect(screen).toContain('بانتظار أوّل دخول');
    expect(screen, 'ما بيقول للمالك شو لازم الموظّف يعمل').toContain('Google Authenticator');
  });

  it('and the password card tells the truth about what is stored', () => {
    const screen = stripComments(repoFile('src/components/screens/UserDetailScreen.tsx'));
    expect(screen).toContain('كلمة السرّ الحاليّة ما بتنعرض — النظام ما بيخزّنها');
    expect(screen).toContain('انسخها هلأ — ما رح تنعرض مرّة تانية');
    expect(screen).toMatch(/maySetPassword\(currentUser as never, user\.id\)\.ok/);
  });
});
