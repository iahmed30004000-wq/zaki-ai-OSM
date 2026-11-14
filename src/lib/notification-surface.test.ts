import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * WHERE A NOTIFICATION IS SEEN.
 *
 * Three surfaces, one set of rows: the bell's list, a number beside the
 * menu entry each one is about, and a card in the corner for what arrives
 * while somebody is looking at something else.
 *
 * Measured before any of it was built: 133 rows, 131 of them unread, and
 * EVERY row already carrying the route it concerns — `/orders`,
 * `/control/change-requests`. So the menu's numbers are a group-by on a
 * column that exists, not a second counter to invent and keep in step.
 *
 * And one poller. Three components asking separately is three timers and
 * three answers a second apart — a badge that disagrees with the list it
 * opens.
 */

const provider = () => stripComments(repoFile('src/components/shell/NotificationsProvider.tsx'));
const cards = () => stripComments(repoFile('src/components/shell/NotificationCards.tsx'));
const bell = () => stripComments(repoFile('src/components/shell/NotificationBell.tsx'));
const sidebar = () => stripComments(repoFile('src/components/shell/Sidebar.tsx'));
const route = () => stripComments(repoFile('src/app/api/notifications/route.ts'));

describe('one poller', () => {
  it('lives in the provider, and stops while the tab is hidden', () => {
    const src = provider();
    // Anchored INSIDE the interval: the same line appears again in the
    // visibility handler, and asserting it loosely passed while the timer
    // itself had been left polling a hidden tab.
    // 13/11: the tick and the return share one `poll` whose FIRST act is the hidden-tab check, and the interval goes through it.
    expect(src).toMatch(/setInterval\(\(\) => poll\('tick'\), POLL_MS\)/);
    expect(src).toMatch(/const poll = \(why: 'tick' \| 'return'\) => \{\s*if \(document\.hidden\) return;/);
    expect(src).toMatch(/visibilitychange/);
  });

  it('and the other three keep no timer of their own', () => {
    for (const [name, src] of [['البل', bell()], ['البطاقات', cards()], ['القائمة', sidebar()]] as const) {
      expect(src, `${name} يحمل مؤقّتاً خاصاً به`).not.toMatch(/setInterval\(/);
      expect(src, `${name} يسأل الخادم بنفسه`).not.toMatch(/fetch\('\/api\/notifications/);
    }
  });

  it('and all three read the same value', () => {
    for (const src of [bell(), cards(), sidebar()]) {
      expect(src).toMatch(/useNotifications\(\)/);
    }
  });
});

describe('the number beside a menu entry', () => {
  it('is the unread rows grouped by the screen they point at', () => {
    const src = route();
    expect(src).toMatch(/groupBy\(\{[\s\S]{0,120}by: \['link'\]/);
    expect(src).toMatch(/isRead: false, link: \{ not: null \}/);
    // Sent with the poll as well as the panel: the menu wants it whether
    // or not the bell is open.
    expect(src).toMatch(/countOnly[\s\S]{0,200}byRoute/);
  });

  it('and the menu only reads it', () => {
    const src = sidebar();
    expect(src).toMatch(/const \{ byRoute \} = useNotifications\(\)/);
    expect(src).toMatch(/byRoute\[route\.path\]/);
    // A count of zero is not a badge reading «0».
    expect(src).toMatch(/byRoute\[route\.path\] \? \(/);
  });
});

describe('the corner cards', () => {
  it('show what arrived, once, and at most five', () => {
    const src = provider();
    expect(src, 'البطاقةُ تُعاد كلَّ دقيقة حتى تُقرأ').toMatch(/shown\.current\.has\(n\.id\)/);
    expect(src).toMatch(/slice\(0, 5\)/);
    // The CONDITION, not merely the name: `primed.current = true` still
    // sits below, so a loose match passed while the first load had gone
    // back to throwing sixty cards onto the screen.
    expect(src, 'أوّلُ تحميلٍ يرمي كلَّ غير المقروء بطاقاتٍ').toMatch(
      /if \(primed\.current && fresh\.length > 0\)/
    );
  });

  it('and can all be hidden at once', () => {
    const src = cards();
    expect(src).toMatch(/إخفاء الكل/);
    expect(src).toMatch(/onClick=\{dismissAll\}/);
    // Each one alone, too.
    expect(src).toMatch(/onClick=\{\(\) => dismiss\(n\.id\)\}/);
  });

  it('and opening one is reading it', () => {
    expect(cards()).toMatch(/onClick=\{\(\) => void markRead\(n\.id\)\}/);
  });

  /**
   * The assistant anchors to the END corner; two floaters in one corner
   * cover each other, which is the bug the mobile pass was about.
   */
  it('and sit on the other corner from the assistant, clear of the bar', () => {
    const src = cards();
    expect(src).toMatch(/fixed start-4/);
    expect(src).toMatch(/var\(--sys-mobile-nav-h\)/);
    expect(stripComments(repoFile('src/components/ai/AiDock.tsx'))).toMatch(/fixed end-4/);
  });
});
