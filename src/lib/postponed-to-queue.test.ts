import { describe, expect, it } from 'vitest';
import { POSTPONE_LEAD_DAYS } from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';

/**
 * A POSTPONED ORDER THAT COMES DUE HAS TO BE REACHABLE.
 *
 * It keeps its claim, and that is right while the date is far off — the agent
 * who spoke to the customer should be the one to ring back. It is wrong the
 * moment it comes due: the pool only takes UNCLAIMED orders, so if she is off
 * that day the order sits where nothing in the product can pick it up. The
 * postponed screen showed it and offered no action at all.
 *
 * Most of what was asked for already existed and was right: the two-day lead
 * window, the job that announces the due ones at eight in the morning, and a
 * `pullNext` that looks for due postponed orders FIRST. The missing piece was
 * one button and the endpoint under it.
 */

const route = () => stripComments(repoFile('src/app/api/confirmation/postponed/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/ConfirmationPostponedScreen.tsx'));

describe('handing a due postponed order back', () => {
  it('exists as its own door, on the screen that owns it', () => {
    expect(route(), 'لا مسار لإعادة المؤجَّل إلى الطابور').toContain('export async function POST');
    expect(screen()).toContain("'/api/confirmation/postponed'");
    expect(screen()).toContain("method: 'POST'");
  });

  /**
   * AND IT DOES NOT REUSE THE RELEASE THAT ALREADY EXISTS.
   *
   * `DELETE /api/orders/[id]/claim` is wrong here twice: only the current
   * holder may call it, and it sets the order back to `NEW` — which erases
   * that it was ever postponed. Whoever pulls it next must see «this customer
   * asked for Thursday, and has asked twice»; an order that arrives looking
   * new is one the next agent opens cold.
   */
  it('keeps the order postponed — only the hands change', () => {
    const post = route().slice(route().indexOf('export async function POST'));
    const update = post.slice(post.indexOf('db.order.updateMany'), post.indexOf('orderNote'));
    expect(update).toContain('claimedById: null');
    expect(update).toContain('currentOwnerId: null');
    expect(update, 'يمحو أنّ الطلب كان مؤجَّلاً').not.toContain('confirmationStatus');
    expect(update, 'يمحو موعد العميل').not.toContain('postponedUntil');
  });

  /**
   * ONLY WHEN IT IS DUE.
   *
   * A customer who asked to be called in three weeks has not been called for
   * a reason. Putting that order in front of the next free agent today breaks
   * the one promise the postpone existed to keep — and the agent who pulls it
   * can do nothing but postpone it again.
   */
  it('refuses one whose date has not come', () => {
    const post = route().slice(route().indexOf('export async function POST'));
    expect(post).toContain('POSTPONE_LEAD_DAYS');
    expect(post).toMatch(/due\.getTime\(\) > leadEnd\.getTime\(\)/);
    expect(post).toContain('NOT_DUE');
    expect(POSTPONE_LEAD_DAYS).toBe(2);
  });

  it('and one that is not yours, and one that is not postponed', () => {
    const post = route().slice(route().indexOf('export async function POST'));
    // OLD → NEW (PR-7): the colleague's order asks its own box, `confirmation.reassign`, not the supervisors' list.
    expect(post).toMatch(/!mayReassign && order\.claimedById !== user\.id/);
    expect(post).toContain("can(user, 'confirmation.reassign')");
    expect(post).toContain('ليس مؤجَّلاً');
    expect(post, 'بلا حماية من تعديل متزامن').toContain('version: order.version');
  });

  /**
   * THE BUTTON IS ON THE ROWS THAT ARE DUE, AND NOWHERE ELSE.
   *
   * The server already decides the window and says so per row — `actionable`.
   * A button that appears on every row and refuses on most of them teaches
   * people the screen is unreliable.
   */
  it('shows the button only on a row the server called actionable', () => {
    const src = screen();
    // OLD → NEW (PR-7): and only where the server says the reader may hand it back (`mayHandBack`).
    expect(src).toMatch(/o\.actionable && o\.mayHandBack !== false \?/);
    expect(src).toContain('إلى الطابور');
    // And the screen says what happened, rather than the row just vanishing.
    expect(src).toContain('ما زال مؤجَّلاً');
  });

  /** Written down, because it changes who is responsible for an order. */
  it('is recorded in the audit log and as a note on the order', () => {
    const post = route().slice(route().indexOf('export async function POST'));
    expect(post).toContain("action: 'POSTPONED_RETURNED_TO_QUEUE'");
    expect(post).toContain('orderNote.create');
  });

  /**
   * AND THE PULLER SEES IT.
   *
   * Which is the whole reason the state is left alone: «طلباتي» already
   * renders «مؤجل حتى …» and the postpone count from those two fields.
   */
  it('and the screen that pulls it says it is postponed', () => {
    const mine = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(mine).toContain('مؤجل حتى');
    expect(mine).toContain('order.postponeCount');
  });
});
