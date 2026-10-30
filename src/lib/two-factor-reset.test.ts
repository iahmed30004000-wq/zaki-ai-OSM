import { describe, expect, it } from 'vitest';
import { mayResetTwoFactor } from './two-factor-reset';
import { TWO_FACTOR_ROLES } from './two-factor';
import type { SessionUser } from '@/types/auth';
import { repoFile, stripComments } from './guard-source';

/**
 * WHO MAY STRIP SOMEBODY ELSE'S SECOND FACTOR.
 *
 * «زر لـ reset الـ 2FA للموظفين، بس للمالك حصراً» — a phone is lost, the
 * person still works here, and without this the only cure was a developer
 * with a database client.
 *
 * This is the one administrative act that WEAKENS another account, so the
 * set of people who may do it is the smallest one and is fixed by ROLE, not
 * by a permission another manager could hand out.
 */

// PR-13 (قديم ← جديد): the reset is the KEY `users.security` now, not two role names. The owner holds every key centrally.
const who = (id: string, role: string, permissions: string[] = []) => ({ id, role, permissions }) as unknown as SessionUser;
const SOMEBODY = 'user-target';

describe('the owner, and nobody else', () => {
  it('lets the owner reset an employee — centrally, with no key listed — and the company admin who holds the key', () => {
    expect(mayResetTwoFactor(who('owner', 'SUPER_ADMIN'), SOMEBODY)).toEqual({ ok: true });
    expect(mayResetTwoFactor(who('owner', 'COMPANY_ADMIN', ['users.security']), SOMEBODY)).toEqual({ ok: true });
  });

  /**
   * THE LIST IS SHORT ON PURPOSE. A manager who may edit users is not a
   * person who may remove another person's second factor, and the two
   * being the same permission is how that set widens without anybody
   * deciding it should.
   */
  it('and refuses everybody else, including the roles that carry 2FA themselves and a company admin the key was taken from', () => {
    for (const role of ['MANAGER', 'ACCOUNTANT', 'SETTLEMENT_OFFICER', 'CONFIRMATION_SUPERVISOR', 'WAREHOUSE', 'COMPANY_ADMIN']) {
      const v = mayResetTwoFactor(who('u', role, ['users.view', 'users.edit', 'roles.edit_system']), SOMEBODY);
      expect(v.ok, role).toBe(false);
      if (!v.ok) expect(v.code).toBe('NO_SECURITY_KEY');
    }
    // Some of those roles are required to hold a second factor themselves;
    // holding one is not the same as being able to remove another's.
    expect(TWO_FACTOR_ROLES).toContain('MANAGER');
  });

  /**
   * AND NEVER YOUR OWN. An owner resetting themselves proves nothing — the
   * session is already past the factor — but it is exactly the move a
   * stolen session makes to shed the one thing it could not pass.
   */
  it('and never on yourself, owner or not', () => {
    const v = mayResetTwoFactor(who('same-person', 'SUPER_ADMIN'), 'same-person');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('NOT_YOURSELF');
  });
});

describe('what the route does with it', () => {
  const route = () => stripComments(repoFile('src/app/api/users/[id]/two-factor/route.ts'));

  it('clears the enrolment and its recovery codes together', () => {
    const src = route();
    // Clearing the secret while leaving the codes alive would leave the
    // old phone's escape hatch working for an account just reset.
    expect(src).toMatch(/\$transaction/);
    expect(src).toMatch(/totpSecretEnc: null,[\s\S]{0,80}totpEnabledAt: null,[\s\S]{0,80}totpLastStep: null/);
    expect(src).toMatch(/twoFactorRecoveryCode\.deleteMany/);
  });

  /**
   * AND HIS OPEN SESSIONS END WITH IT.
   *
   * A reset happens because the phone was lost or replaced, or because
   * somebody is suspected of having the account. Clearing the secret alone
   * left every browser he was already signed in on working exactly as
   * before — so whoever the reset was meant to lock out stayed inside
   * until the session expired on its own.
   */
  it('and ends his open sessions in the same transaction', () => {
    const src = route();
    expect(src, 'جلساتُه القائمةُ تَبقى مفتوحةً بعدَ إعادةِ الضبط').toMatch(
      /tokenVersion: \{ increment: 1 \}/
    );
    // Inside the transaction, not after it: a reset that half-happened
    // would leave an account with no second factor and a live session.
    const tx = src.slice(src.indexOf('$transaction'), src.indexOf('twoFactorRecoveryCode'));
    expect(tx, 'الزيادةُ خارجَ المعاملة').toMatch(/tokenVersion/);
  });

  it('and says so, so the owner knows what the press did', () => {
    expect(route()).toMatch(/أُغلقت جلساته/);
  });

  it('refuses an account that has nothing enrolled', () => {
    expect(route()).toMatch(/code: 'NOT_ENROLLED'/);
  });

  it('is scoped to the company, and audited by name', () => {
    // THE SHARED SCOPE, not a hand-written one. That reasoning was
    // written by hand four times in this codebase and one of the four was
    // wrong; a repo guard now refuses a fresh copy, and it caught this
    // route when it was first written.
    expect(route()).toMatch(/where: manageableUserWhere\(user, id\)/);
    expect(route()).toMatch(/action: 'TWO_FACTOR_RESET'/);
  });

  /** The secret is gone; it must not travel to a log on its way out. */
  it('and never writes the secret anywhere', () => {
    const src = route();
    expect(src).not.toMatch(/newData:[^}]*totpSecretEnc/);
    expect(src).not.toMatch(/console\.log/);
  });

  it('and the screen only draws the button where the rule allows it', () => {
    const screen = stripComments(repoFile('src/components/screens/UserDetailScreen.tsx'));
    // Same function as the server's, so a button that appears is a button
    // that works — and one that would always refuse is never drawn.
    expect(screen).toMatch(/mayResetTwoFactor\(currentUser as never, user\.id\)\.ok && user\.totpEnabledAt/);
    expect(screen).toMatch(/const ok = await confirm\(\{/);
  });
});
