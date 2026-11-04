import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHY A SESSION ENDED.
 *
 * A person signing out and a phone left on a counter are the same action
 * and a very different fact. The second one, seen four times in a week for
 * the same account, is the thing a manager wants to notice.
 *
 * The reason arrives from a browser, so it is not believed. It is a word
 * chosen from two, and anything else is recorded as unknown rather than
 * written into the audit trail as whatever the caller said — an audit log
 * that repeats attacker-chosen strings is a place to hide a sentence.
 */

const { db, getCurrentUser, currentSessionClaims, logAudit } = vi.hoisted(() => ({
  db: { user: { update: vi.fn() }, userSession: { updateMany: vi.fn() } },
  getCurrentUser: vi.fn(),
  currentSessionClaims: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  COOKIE_NAME: 'salesflow_session',
  getCurrentUser: (...a: unknown[]) => getCurrentUser(...a),
  currentSessionClaims: (...a: unknown[]) => currentSessionClaims(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './logout/route';

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: 'u1', email: 'a@b.c', companyId: 'c1' });
  // Ruling 4/11: two devices. A cookie of this release names its session row.
  currentSessionClaims.mockResolvedValue({ sid: 's-laptop', userId: 'u1' });
  db.user.update.mockResolvedValue({});
  db.userSession.updateMany.mockResolvedValue({ count: 1 });
});

const post = (body?: unknown) =>
  POST(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );

const reasonOf = () => logAudit.mock.calls[0][0].newData.reason;

describe('the session ends the same way whatever the reason', () => {
  /*
   * RULING 4/11: TWO DEVICES. This asserted the token-version bump, which signed the account out of EVERY device — the
   * laptop's sign-out took the phone she was calling from with it. Now the sign-out ends THIS session's row; the cookie
   * somebody copied dies all the same, because a revoked `sid` is refused (two-devices-at-once.test.ts).
   */
  it('ends THIS session only — the other device stays signed in', async () => {
    await post({ reason: 'manual' });
    expect(db.userSession.updateMany).toHaveBeenCalledTimes(1);
    const [arg] = db.userSession.updateMany.mock.calls[0];
    expect(arg.where).toEqual({ id: 's-laptop', userId: 'u1', revokedAt: null });
    expect(arg.data.revokeReason).toBe('LOGOUT');
    expect(arg.data.revokedAt).toBeInstanceOf(Date);
    expect(db.user.update, 'الخروج من جهاز طلّع الجهاز التاني').not.toHaveBeenCalled();
  });

  it('and an idle sign-out says so on the row', async () => {
    await post({ reason: 'idle' });
    expect(db.userSession.updateMany.mock.calls[0][0].data.revokeReason).toBe('IDLE');
  });

  it('a cookie from before 4/11 (no sid) still bumps the token version — there is no row to end', async () => {
    currentSessionClaims.mockResolvedValue(null);
    await post({ reason: 'idle' });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(db.userSession.updateMany).not.toHaveBeenCalled();
  });

  it("a sid that is not this person's is not ended in her name, nor is her account signed out", async () => {
    currentSessionClaims.mockResolvedValue({ sid: 's-other', userId: 'u2' });
    await post({ reason: 'manual' });
    // The filter carries HER id, so somebody else's row is matched by nothing.
    expect(db.userSession.updateMany.mock.calls[0][0].where).toMatchObject({ id: 's-other', userId: 'u1' });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('and clears the cookie', async () => {
    const res = await post({ reason: 'manual' });
    expect(res.headers.get('set-cookie')).toContain('salesflow_session=');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('what the trail is allowed to say', () => {
  it('records a person leaving', async () => {
    await post({ reason: 'manual' });
    expect(reasonOf()).toBe('manual');
  });

  it('records a phone left alone', async () => {
    await post({ reason: 'idle' });
    expect(reasonOf()).toBe('idle');
  });

  it('records the older callers, who send no body, as manual', async () => {
    await post();
    expect(reasonOf()).toBe('manual');
  });

  // The negatives. A field from a browser is an untrusted string.
  it('does not repeat back a word it was not expecting', async () => {
    await post({ reason: 'ADMIN APPROVED THIS' });
    expect(reasonOf()).toBe('unknown');
  });

  it('nor a whole essay, nor an object, nor a number', async () => {
    await post({ reason: 'x'.repeat(5000) });
    expect(reasonOf()).toBe('unknown');
    logAudit.mockClear();

    await post({ reason: { toString: 'idle' } });
    expect(reasonOf()).toBe('unknown');
    logAudit.mockClear();

    await post({ reason: 42 });
    expect(reasonOf()).toBe('unknown');
  });

  it('and signs the person out anyway — a strange reason is not a reason to stay in', async () => {
    const res = await post({ reason: 'nonsense' });
    expect(res.status).toBe(200);
    expect(db.userSession.updateMany).toHaveBeenCalled();
  });
});
