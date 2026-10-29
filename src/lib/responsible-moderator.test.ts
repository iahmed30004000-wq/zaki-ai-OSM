import { describe, expect, it } from 'vitest';
import { MODERATOR_FORBIDDEN_AR, responsibleModerator } from './responsible-moderator';

/**
 * WHO IS RESPONSIBLE FOR AN ORDER WHEN IT IS TYPED (perm-plan PR-6, D10 / RV150) — the rule alone, every cell.
 * The door-level comparison against the old role-name rule, with money, is `an-order-is-priced-the-same-whoever-types-it`.
 */

const ME = 'me-0000000001';
const THEM = 'them-000000001';

describe('naming nobody', () => {
  it('whoever does not hand orders out owns what they type', () => {
    expect(responsibleModerator({ requestedId: null, creatorId: ME, mayAssign: false })).toEqual({ ok: true, moderatorId: ME });
    expect(responsibleModerator({ requestedId: undefined, creatorId: ME, mayAssign: false })).toEqual({ ok: true, moderatorId: ME });
    expect(responsibleModerator({ requestedId: '', creatorId: ME, mayAssign: false })).toEqual({ ok: true, moderatorId: ME });
    expect(responsibleModerator({ requestedId: '   ', creatorId: ME, mayAssign: false })).toEqual({ ok: true, moderatorId: ME });
  });

  it('whoever hands orders out leaves it unowned', () => {
    expect(responsibleModerator({ requestedId: null, creatorId: ME, mayAssign: true })).toEqual({ ok: true, moderatorId: null });
  });

  it('an order with no person behind it has no responsible moderator, key or no key', () => {
    expect(responsibleModerator({ requestedId: null, creatorId: null, mayAssign: false })).toEqual({ ok: true, moderatorId: null });
    expect(responsibleModerator({ requestedId: null, creatorId: null, mayAssign: true })).toEqual({ ok: true, moderatorId: null });
  });
});

describe('naming yourself', () => {
  it('is always allowed, with or without the key', () => {
    expect(responsibleModerator({ requestedId: ME, creatorId: ME, mayAssign: false })).toEqual({ ok: true, moderatorId: ME });
    expect(responsibleModerator({ requestedId: ME, creatorId: ME, mayAssign: true })).toEqual({ ok: true, moderatorId: ME });
  });
});

describe('naming somebody else', () => {
  it('needs orders.assign', () => {
    expect(responsibleModerator({ requestedId: THEM, creatorId: ME, mayAssign: true })).toEqual({ ok: true, moderatorId: THEM });
  });

  it('NEGATIVE: without it the answer is a refusal, not a quiet fallback to yourself — nobody is credited with an order they did not choose', () => {
    expect(responsibleModerator({ requestedId: THEM, creatorId: ME, mayAssign: false })).toEqual({ ok: false, code: 'MODERATOR_FORBIDDEN' });
  });

  it('NEGATIVE: an order with no creator cannot be given to a name by someone without the key either', () => {
    expect(responsibleModerator({ requestedId: THEM, creatorId: null, mayAssign: false })).toEqual({ ok: false, code: 'MODERATOR_FORBIDDEN' });
  });
});

describe('the refusal', () => {
  it('names the key in Arabic, and only in Arabic', () => {
    expect(MODERATOR_FORBIDDEN_AR).toMatch(/إسناد الطلبات/);
    expect(MODERATOR_FORBIDDEN_AR).not.toMatch(/[A-Za-z]/);
  });
});
