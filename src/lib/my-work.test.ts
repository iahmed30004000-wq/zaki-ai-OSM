import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { WORK_KINDS, kindsFor, visibleWork, workKind, type WorkItem, type WorkKey } from './my-work';
import { ICONS } from '@/components/shell/icons';

/**
 * WHAT IS WAITING FOR ME, AT THE TOP OF EVERY SCREEN.
 *
 * The header carried one number and it was the right idea applied to one
 * role — «how many orders are waiting to be pulled» for whoever pulls.
 * Everybody else got a bar identical whatever their job: a shipping clerk
 * with forty parcels ready to go, a warehouse with a pallet of returns
 * nobody has counted in, an owner with change requests past their deadline.
 *
 * The rules the old counter was written with are not new rules, and they
 * are carried here whole — the route it lived on is gone, and losing them
 * with it would have been the real cost of this change.
 */

const may = (...perms: string[]) => (p: string) => perms.includes(p);
const keys = (ks: { key: WorkKey }[]) => ks.map((k) => k.key);

describe('who sees which number', () => {
  it('the confirmation agent sees the pool she pulls from', () => {
    expect(keys(kindsFor(may('confirmation.pull')))).toContain('CONFIRM_POOL');
  });

  /**
   * THE POOL IS WORKED AT THE TOP OF «طلباتي», LISTED ON THE SUPERVISOR'S PAGE.
   * The card opens where THIS person acts on it — an agent sent to the
   * supervisor's page would be redirected, and a supervisor sent to a desk she
   * does not work would be refused.
   */
  it('«بانتظار التأكيد» opens the desk for whoever pulls, and the queue for whoever supervises', () => {
    const href = (...p: string[]) => kindsFor(may(...p)).find((k) => k.key === 'CONFIRM_POOL')?.href;
    expect(href('confirmation.pull')).toBe('/confirmation/mine');
    expect(href('confirmation.pull', 'confirmation.work')).toBe('/confirmation/mine');
    expect(href('confirmation.supervise')).toBe('/confirmation/queue');
    expect(href('confirmation.pull', 'confirmation.supervise')).toBe('/confirmation/queue');
  });

  it('the moderator sees his own orders not yet confirmed', () => {
    expect(keys(kindsFor(may('orders.create')))).toEqual(['MY_UNCONFIRMED']);
  });

  /** Carried from the old counter: the two would be the same orders twice. */
  it('and somebody who both pulls and creates sees the pool, not both', () => {
    const k = keys(kindsFor(may('confirmation.pull', 'orders.create')));
    expect(k).toContain('CONFIRM_POOL');
    expect(k, 'عُدّت الطلبات نفسها مرّتين').not.toContain('MY_UNCONFIRMED');
  });

  it('and somebody for whom neither means anything sees nothing', () => {
    expect(kindsFor(may('finance.view'))).toEqual([]);
  });

  /** The half the old counter never had. */
  it('the shipping clerk sees what is ready to go', () => {
    expect(keys(kindsFor(may('ops.ship')))).toEqual(['READY_TO_SHIP']);
  });

  it('the warehouse sees the returns nobody has counted in', () => {
    expect(keys(kindsFor(may('ops.returns')))).toEqual(['RETURNS_WAITING']);
  });

  it('and whoever decides change requests sees the ones waiting', () => {
    expect(keys(kindsFor(may('control.change_requests')))).toEqual(['CHANGE_REQUESTS']);
  });

  it('while an owner who holds everything sees them all, worst first', () => {
    const all = kindsFor(() => true);
    expect(all.length).toBeGreaterThan(3);
    expect(all[0].key, 'المتأخّر ليس أوّلاً').toBe('LATE_SHIPMENTS');
  });
});

describe('what the bar actually shows', () => {
  const item = (key: WorkKey, count: number): WorkItem => {
    const k = workKind(key)!;
    return { key, ar: k.ar, count, href: k.href, icon: k.icon, tone: k.tone };
  };

  /** Showing «0 مرتجع» teaches people to stop reading the row. */
  it('nothing at all when there is no work', () => {
    expect(visibleWork([item('READY_TO_SHIP', 0), item('RETURNS_WAITING', 0)], 3)).toEqual([]);
  });

  it('the late work before the waiting work', () => {
    const out = visibleWork([item('READY_TO_SHIP', 5), item('LATE_SHIPMENTS', 1)], 3);
    expect(out.map((i) => i.key)).toEqual(['LATE_SHIPMENTS', 'READY_TO_SHIP']);
  });

  /** «Seven controls in a 375px bar is how a bell gets missed.» */
  it('and never more than it was asked for', () => {
    const many = [
      item('LATE_SHIPMENTS', 1),
      item('CHANGE_REQUESTS', 2),
      item('RETURNS_WAITING', 3),
      item('READY_TO_SHIP', 4),
    ];
    expect(visibleWork(many, 3)).toHaveLength(3);
    expect(visibleWork(many, 1).map((i) => i.key)).toEqual(['LATE_SHIPMENTS']);
    expect(visibleWork(many, 0)).toEqual([]);
  });
});

describe('every kind is whole', () => {
  /** A missing icon renders as nothing at all — an invisible chip. */
  it('and names an icon the shell actually has', () => {
    for (const k of WORK_KINDS) {
      expect(ICONS[k.icon], `${k.key}: لا أيقونة باسم ${k.icon}`).toBeTruthy();
    }
  });

  it('with Arabic words, a permission and a place in the order', () => {
    const ranks = new Set<number>();
    for (const k of WORK_KINDS) {
      expect(k.ar, `${k.key} بلا اسم عربيّ`).toBeTruthy();
      expect(k.permissions.length, `${k.key} بلا صلاحية — يراه الجميع`).toBeGreaterThan(0);
      expect(ranks.has(k.rank), `${k.key} يشارك ترتيبَ غيره`).toBe(false);
      ranks.add(k.rank);
    }
  });

  /**
   * The pool is not a moderator's to open, and a counter that led to a
   * list would be the list by another door — the old counter's own rule.
   */
  it('and the moderator’s own count leads nowhere', () => {
    expect(workKind('MY_UNCONFIRMED')!.href).toBeNull();
  });
});

describe('the door answers with counts and nothing else', () => {
  const route = () => stripComments(repoFile('src/app/api/me/work/route.ts'));

  it('no order, no id, no name ever leaves it', () => {
    const src = route();
    expect(src, 'يعيد طلبات بدل أعداد').not.toMatch(/orders:\s*\w+\.map/);
    expect(src).toMatch(/const items: WorkItem\[\]/);
    expect(src).toMatch(/count: Math\.min\(CAP/);
  });

  /** A moderator is always counted for himself: no parameter to point elsewhere. */
  it('and takes no parameter that could point at somebody else', () => {
    const src = route();
    expect(src).toContain('export async function GET()');
    expect(src).toContain('awaitingConfirmationCount(db, scope, user.id)');
    expect(src, 'يقرأ هويّةً من الطلب').not.toMatch(/searchParams|params\)/);
  });

  /** Answering 400 to a poll once sent the whole tab to the store picker. */
  it('a missing store is no work, not an error', () => {
    expect(route()).toMatch(/if \(e instanceof ContextError\) return NextResponse\.json\(\{ items: \[\] \}\)/);
  });

  /** A query run for a number nobody is shown runs for nothing, every poll. */
  it('and counts only what this person may see', () => {
    const src = route();
    for (const k of ['CONFIRM_POOL', 'READY_TO_SHIP', 'RETURNS_WAITING', 'CHANGE_REQUESTS', 'LATE_SHIPMENTS']) {
      expect(src, `${k} يُحسب بلا فحص`).toContain(`wanted.has('${k}')`);
    }
  });

  /**
   * A parcel to a neighbouring town and one across the country are not late
   * at the same age, and `delivery_fees` carries the days for each.
   */
  it('and lateness is the courier’s own threshold, per region', () => {
    const src = route();
    expect(src).toContain('lateThresholdDays: true');
    // The rule lives in `transitOf` (the tracking screen's own), and no threshold on file is «0»: never late.
    expect(src).toMatch(/transitOf\(o, daysFor\.get\(`\$\{o\.deliveryProviderId\}:\$\{o\.regionId\}`\) \?\? 0, now\)\.late/);
  });

  /** A held parcel is not waiting for anybody until its day comes. */
  it('and a held parcel is not counted as ready to ship', () => {
    expect(route()).toMatch(/shipHoldUntil: \{ lte: new Date\(\) \}/);
  });
});

describe('and the header shows it instead of the old single number', () => {
  const header = () => stripComments(repoFile('src/components/shell/Header.tsx'));
  const strip = () => stripComments(repoFile('src/components/shell/MyWork.tsx'));

  it('the counter it replaced is gone, not left beside it', () => {
    expect(header()).toContain('<MyWork />');
    expect(header(), 'العدّاد القديم ما زال في الشريط').not.toContain('ConfirmationCounter');
  });

  it('one chip on a phone, three on a desk', () => {
    const src = strip();
    expect(src).toMatch(/visibleWork\(items, 3\)/);
    expect(src).toMatch(/many\.slice\(0, 1\)/);
    expect(src).toMatch(/hidden md:flex/);
    expect(src).toMatch(/flex md:hidden/);
  });

  /**
   * Nothing is polled while nobody is looking.
   *
   * The check sits in two places — the interval, and the handler that fires
   * when the tab comes back — so looking for the words anywhere in the file
   * passed with the interval's copy deleted, which is the one that matters.
   */
  it('and the interval itself stops while the tab is hidden', () => {
    expect(strip(), 'المؤقّت يستطلع والتبويب مخفيّ').toMatch(
      /setInterval\(\(\) => \{[\s\S]{0,160}document\.visibilityState === 'visible'[\s\S]{0,40}\}, POLL_MS\)/
    );
  });
});
