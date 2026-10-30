import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * A DECISION NOBODY HEARD IS NOT A DECISION.
 *
 * Almost all of this existed and was right: the request, the routing rule
 * that picks the decider by how far the order has travelled, the SLA that
 * escalates and never approves, the «بانتظار التطبيق» half, and an apply
 * step that runs the approved values through the order's own money path.
 *
 * Three things were missing, and they are the same thing seen three times —
 * the person who asked was outside the loop:
 *
 *   1. The DECISION notified nobody. Raising told the decider; an overdue
 *      request told the supervisors; approving or rejecting sent not one
 *      message, in a file with no notification import at all.
 *   2. Her own request was INVISIBLE to her. The queue's non-supervisor
 *      filter was «orders still in my hands», which is the set she has to
 *      ANSWER, not the set she ASKED.
 *   3. It could not be TAKEN BACK. `CANCELLED` was in the status list from
 *      the start with nothing writing it — while a blocking pending request
 *      refuses every forward shipping transition, and any pending one
 *      refuses a second request on that order. One wrong press froze the
 *      order, and the corrected request could not be raised either.
 */

const decideFile = () => stripComments(repoFile('src/app/api/control/change-requests/[id]/route.ts'));
/**
 * THE DECISION HANDLER ALONE.
 *
 * The withdrawal lives in the same file and carries a guard spelled exactly
 * like the decision's «not your own» one. A first version of this test read
 * the whole file, so deleting the notification's guard left the withdrawal's
 * to satisfy it — it passed against the bug.
 */
const decide = () => {
  const src = decideFile();
  return src.slice(0, src.indexOf('export async function DELETE'));
};
const queue = () => stripComments(repoFile('src/app/api/control/change-requests/route.ts'));
const apply = () => stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));

describe('the answer reaches whoever asked', () => {
  it('notifies the requester on the decision', () => {
    const src = decide();
    // The CALL, not the name: `createNotification` appears on the import
    // line whatever the body does, and the first version of this assertion
    // passed with the call itself replaced by a no-op.
    expect(src, 'القرار لا يُخبر أحداً').toMatch(
      /await createNotification\(\{[\s\S]*?audience: \{ userIds: \[request\.requestedById\] \}/
    );
  });

  /** Being told your own decision is noise — the raise already skips it. */
  it('and not the person who just decided it', () => {
    // `decide()` is the PATCH handler only — see its definition.
    expect(decide(), 'يُخبر المشرفَ بقراره هو').toMatch(
      /if \(request\.requestedById !== user\.id\) \{\s*const approved =/
    );
  });

  /**
   * «APPROVED» AND «WRITTEN ON THE ORDER» ARE TWO DIFFERENT DAYS.
   *
   * An approval waits in «بانتظار التطبيق» until somebody carries it out,
   * and until then the order still says what it said. One message for both
   * would tell her the customer's address changed at a moment it had not.
   */
  it('says which of the two happened, approved or applied', () => {
    expect(decide()).toContain('ويُطبَّق على الطلب في خطوة التطبيق');
    expect(apply(), 'التطبيق لا يُخبر صاحبَ الطلب').toContain('طُبِّق تعديلك على');
    // Inside the once-only stamp: a second concurrent apply changes nothing
    // on the order and must not send a second message either.
    expect(apply(), 'إشعار التطبيق خارج حرس المرّة الواحدة').toMatch(
      /if \(stamped\.count === 1 && viaRequest\.requestedById !== user\.id\) \{/
    );
  });

  /** A «لا» with no reason sends her straight back to ask why. */
  it('carries the reason of a rejection', () => {
    const src = decide();
    expect(src).toMatch(/if \(parsed\.data\.decision === 'REJECTED' && !parsed\.data\.note\) \{/);
    expect(src).toContain('${user.name ?? \'المشرف\'}: ${parsed.data.note}');
  });
});

describe('a request you raised is one you can find', () => {
  it('the queue shows her own requests, not only the ones she must answer', () => {
    const src = queue();
    expect(src, 'طلبُها الذي رفعته لا يظهر لها').toContain('{ requestedById: user.id }');
    // A row-level OR, so it cannot be nested under `order` where it would
    // silently match nothing.
    expect(src).toMatch(/OR: \[/);
    expect(src).toContain('...mine,');
  });

  it('and marks which rows are hers', () => {
    expect(queue()).toContain('isMine: r.requestedById === user.id');
  });

  /** A button that always 403s teaches people the screen is lying. */
  it('so her own row offers the withdrawal, never the decision', () => {
    const src = screen();
    expect(src, 'الشاشة لا تفرّق بين طلبها وطلب غيرها').toMatch(/r\.isMine \?/);
    expect(src).toContain('اسحب طلبي');
    const footer = src.slice(src.indexOf('<footer'), src.indexOf('</footer>'));
    const decideAt = footer.indexOf('مراجعة واتخاذ القرار');
    const mineAt = footer.indexOf('r.isMine ?');
    expect(mineAt, 'زرّ القرار معروضٌ قبل التفريق').toBeGreaterThan(-1);
    expect(decideAt, 'زرّ القرار خارج فرع «ليس طلبي»').toBeGreaterThan(mineAt);
  });
});

describe('and it can be taken back', () => {
  it('has a withdraw door', () => {
    expect(decideFile(), 'لا باب لسحب طلبٍ رُفع بالخطأ').toContain('export async function DELETE');
    expect(decideFile()).toContain("status: 'CANCELLED'");
    expect(screen()).toContain("method: 'DELETE'");
  });

  /**
   * ONLY THE REQUESTER, AND ONLY WHILE PENDING.
   *
   * A supervisor who wants it gone REJECTS it with a reason: that is a
   * decision, it already exists, and it is what she needs to hear. A
   * supervisor withdrawal would be the same act under a name that records
   * nothing.
   */
  it('for the requester alone', () => {
    expect(decideFile(), 'حارس «صاحب الطلب وحده» معطَّل').toMatch(
      /if \(request\.requestedById !== user\.id\) \{\s*return NextResponse\.json\(\s*\{ error: 'يسحب/
    );
    expect(decideFile()).toContain('NOT_THE_REQUESTER');
  });

  it('and only while nobody has decided it', () => {
    const del = decideFile().slice(decideFile().indexOf('export async function DELETE'));
    expect(del, 'يسحب طلباً بُتَّ فيه').toMatch(/if \(request\.status !== 'PENDING'\) \{/);
    // And against a decision landing this same second: the filter re-checks
    // PENDING and the count decides who won.
    expect(del).toMatch(/where: \{ id, status: 'PENDING' \}/);
    expect(del).toMatch(/if \(res\.count !== 1\) throw new Error\('ALREADY_DECIDED'\)/);
  });

  it('written down as a withdrawal, not as a decision', () => {
    const del = decideFile().slice(decideFile().indexOf('export async function DELETE'));
    expect(del).toContain("action: 'CHANGE_REQUEST_WITHDRAWN'");
    expect(del).toContain('orderNote.create');
  });

  /** Silence is never consent — the rule this whole file sits next to. */
  it('and nothing here approves anything by itself', () => {
    expect(decideFile()).not.toMatch(/status: 'APPROVED',\s*decidedById: null/);
    expect(stripComments(repoFile('src/lib/jobs/definitions/escalate-change-requests.ts'))).not.toMatch(
      /escalateChangeRequests[\s\S]{0,2000}status: 'APPROVED'/
    );
  });
});
