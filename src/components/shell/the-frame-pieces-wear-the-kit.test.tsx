// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { CARD_CLASS } from '@/lib/theme-shape';
import { IDLE_LIMIT_MS, IDLE_WARN_MS } from '@/lib/exposure';

/**
 * THE FRAME'S SMALL PIECES ON THE KIT (18/11, R17c).
 *
 * The bell, the corner cards, the idle warning, the install button, the first-run tour, «عاين كـ», the guide's ⓘ,
 * the «عم تعدّل» strip, the work chips and the offline line: every press is the kit's `Button` / `IconButton` /
 * `Checkbox`, every surface the kit's plain `Card`, the text 14px with 13px captions. What must not move with the
 * look: a press's name, what one press does, that a press while the answer is coming does not do it twice, and that
 * each piece fits a 375px phone. The older tests beside this one (the tour, the veil, the card column, the install,
 * the guide, the idle guard) hold the behaviour; this one holds the kit.
 */

const DIR = 'src/components/shell';
const src = (name: string) => stripComments(readFileSync(join(process.cwd(), DIR, `${name}.tsx`), 'utf8'));
const PIECES = [
  'NotificationBell',
  'NotificationCards',
  'IdleGuard',
  'InstallApp',
  'FirstRunTour',
  'PreviewAs',
  'ScreenGuide',
  'EditingStoreBar',
  'MyWork',
  'OfflineWatch',
];

// ───────────────────────── the doubles ─────────────────────────

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/orders' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Row = { id: string; title: string; message: string; type: string; isRead: boolean; link: string | null; createdAt: string };
const bell = {
  items: [] as Row[] | null,
  unreadCount: 0,
  arriving: [] as Row[],
  refresh: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(async () => undefined),
  dismiss: vi.fn(),
  dismissAll: vi.fn(),
};
vi.mock('./NotificationsProvider', () => ({ useNotifications: () => bell }));

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u-kit', name: 'تجربة', tourDoneAt: null }, refreshUser: async () => undefined }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => ({})) }));
const signOut = vi.fn(async () => undefined);
vi.mock('@/lib/sign-out', () => ({ signOut: () => signOut() }));

import { NotificationBell } from './NotificationBell';
import { NotificationCards } from './NotificationCards';
import { IdleGuard } from './IdleGuard';
import { FirstRunTour } from './FirstRunTour';
import { PreviewBanner } from './PreviewAs';

const row = (n: number, read = false): Row => ({
  id: `n${n}`,
  title: `طلب ${n}`,
  message: 'وصل طلب جديد',
  type: 'ORDER_NEW',
  isRead: read,
  link: `/orders?id=${n}`,
  createdAt: '2026-11-18T08:00:00.000Z',
});

/** A promise this test settles by hand: an answer that is still on its way. */
function pending() {
  let settle!: () => void;
  const p = new Promise<void>((r) => {
    settle = r;
  });
  return { p, settle };
}

beforeEach(() => {
  bell.items = [row(1), row(2, true)];
  bell.unreadCount = 1;
  bell.arriving = [];
  bell.refresh = vi.fn(async () => undefined);
  bell.markAllRead = vi.fn(async () => undefined);
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const isKitButton = (el: Element | null) =>
  !!el && el.tagName === 'BUTTON' && el.className.includes('rounded-lg') && el.className.includes('disabled:opacity-50');

// ───────────────────────── the bell ─────────────────────────

describe('the bell', () => {
  it('is the kit’s icon button, named and titled with the unread count', () => {
    render(<NotificationBell />);
    const b = screen.getByRole('button', { name: '1 إشعار غير مقروء' });
    expect(isKitButton(b)).toBe(true);
    expect(b.getAttribute('title')).toBe('1 إشعار غير مقروء');
    expect(b.textContent).toContain('1');
  });

  it('with nothing unread it is called «الإشعارات» and shows no number', () => {
    bell.unreadCount = 0;
    render(<NotificationBell />);
    const b = screen.getByRole('button', { name: 'الإشعارات' });
    expect(b.textContent).toBe('');
  });

  it('a second press closes it even while the opening read is still on its way', async () => {
    const read = pending();
    bell.refresh = vi.fn(() => read.p);
    render(<NotificationBell />);
    const b = screen.getByRole('button', { name: '1 إشعار غير مقروء' });
    await act(async () => {
      fireEvent.click(b);
    });
    expect(screen.getByText('تعليم الكل كمقروء')).toBeTruthy();
    expect(bell.refresh).toHaveBeenCalledTimes(1);
    expect((b as HTMLButtonElement).disabled, 'الجرس انقفل وهو عم يقرأ').toBe(false);
    await act(async () => {
      fireEvent.click(b);
    });
    expect(screen.queryByText('تعليم الكل كمقروء'), 'الضغطة التانية ما سكّرت الجرس').toBeNull();
    await act(async () => read.settle());
  });

  it('the open panel is the kit’s plain card in a frame no wider than a phone less its gutters', async () => {
    render(<NotificationBell />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 إشعار غير مقروء' }));
    });
    const surface = screen.getByText('الإشعارات').parentElement!.parentElement!;
    expect(surface.className).toContain('bg-[var(--sys-card)]');
    expect(surface.className).toContain('border-[var(--sys-border)]');
    expect(surface.className, 'لوحة فوق الصفحة لبست زخرفة الثيم').not.toContain(CARD_CLASS);
    const frame = surface.parentElement!;
    expect(frame.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(frame.className).toContain('end-0');
  });

  it('«تعليم الكل كمقروء» is a quiet kit button, and a second press while the first is waiting writes nothing', async () => {
    const write = pending();
    bell.markAllRead = vi.fn(() => write.p);
    render(<NotificationBell />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 إشعار غير مقروء' }));
    });
    const all = screen.getByText('تعليم الكل كمقروء').closest('button')!;
    expect(isKitButton(all)).toBe(true);
    expect(all.className).toContain('bg-transparent');
    await act(async () => {
      fireEvent.click(all);
    });
    await act(async () => {
      fireEvent.click(all);
    });
    expect(bell.markAllRead, 'تعليم الكل انبعت مرتين').toHaveBeenCalledTimes(1);
    expect(all.disabled).toBe(true);
    await act(async () => write.settle());
    expect(all.disabled).toBe(false);
  });

  it('a row is still a whole-row press: an unread one is marked read and opened, a hover does nothing', async () => {
    render(<NotificationBell />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 إشعار غير مقروء' }));
    });
    const first = screen.getByText('طلب 1').closest('button')!;
    fireEvent.mouseEnter(first);
    expect(push).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(first);
    });
    expect(bell.markRead).toHaveBeenCalledWith('n1');
    expect(push).toHaveBeenCalledWith('/orders?id=1');
    // a read row is not marked again
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1 إشعار غير مقروء' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('طلب 2').closest('button')!);
    });
    expect(bell.markRead).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── the corner cards ─────────────────────────

describe('the corner cards', () => {
  beforeEach(() => {
    bell.arriving = [row(1), { ...row(2), type: 'LOW_STOCK', link: null }];
  });

  it('each card is the kit’s plain card and keeps its coloured start edge', () => {
    render(<NotificationCards />);
    const card = screen.getByText('طلب 2').closest('.pointer-events-auto')!;
    expect(card.className).toContain('bg-[var(--sys-card)]');
    expect(card.className).not.toContain(CARD_CLASS);
    expect(card.className).toContain('border-s-4');
    expect(card.className).toContain('border-s-[var(--sys-warning)]');
  });

  it('✕ is the kit’s icon button, named for its card, held in the card’s corner, and hides that card only', () => {
    render(<NotificationCards />);
    const x = screen.getByRole('button', { name: 'أخفِ طلب 2' });
    expect(isKitButton(x)).toBe(true);
    expect(x.getAttribute('title')).toBe('أخفِ طلب 2');
    expect(x.parentElement!.className).toContain('absolute');
    fireEvent.click(x);
    expect(bell.dismiss).toHaveBeenCalledWith('n2');
    expect(bell.dismissAll).not.toHaveBeenCalled();
  });

  it('«إخفاء الكل» is a kit button that takes presses in a column that lets them through', () => {
    render(<NotificationCards />);
    const all = screen.getByText(/إخفاء الكل/).closest('button')!;
    expect(isKitButton(all)).toBe(true);
    expect(all.className).toContain('pointer-events-auto');
    fireEvent.click(all);
    expect(bell.dismissAll).toHaveBeenCalledTimes(1);
  });

  it('and with one card there is nothing to hide all of', () => {
    bell.arriving = [row(1)];
    render(<NotificationCards />);
    expect(screen.queryByText(/إخفاء الكل/)).toBeNull();
  });
});

// ───────────────────────── the idle warning ─────────────────────────

describe('the idle warning', () => {
  async function warned() {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    render(<IdleGuard idleSignOut />);
    await act(async () => {
      vi.advanceTimersByTime(IDLE_LIMIT_MS - IDLE_WARN_MS + 1000);
    });
    return screen.getByTestId('idle-warning');
  }

  it('is the kit’s plain card in the warning’s colour, inside the phone’s width', async () => {
    const w = await warned();
    const surface = w.firstElementChild!;
    expect(surface.className).toContain('bg-[var(--sys-card)]');
    expect(surface.className).toContain('border-[var(--sys-warning)]');
    expect(surface.className).not.toContain(CARD_CLASS);
    expect(surface.className).toContain('max-w-md');
    expect(w.className).toContain('inset-x-0');
  });

  it('«أنا هنا» is the kit’s button and puts the clock back', async () => {
    const w = await warned();
    const here = screen.getByText('أنا هنا').closest('button')!;
    expect(isKitButton(here)).toBe(true);
    expect(w.contains(here)).toBe(true);
    await act(async () => {
      here.click();
    });
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });
});

// ───────────────────────── the first-run tour ─────────────────────────

describe('the first-run tour', () => {
  function Frame() {
    return (
      <div>
        <aside data-tour="sidebar">القائمة</aside>
        <div data-tour="context">المتجر</div>
        <button data-tour="search">ابحث</button>
        <button data-tour="guide">ⓘ</button>
        <FirstRunTour />
      </div>
    );
  }

  it('the card is a frame that holds the dialog, with the kit’s plain card inside, 320 wide — less than a 375 phone', () => {
    render(<Frame />);
    const dialog = screen.getByRole('dialog', { name: 'الجولة الأولى' });
    expect(dialog.className).toContain('w-[320px]');
    expect(dialog.className).not.toContain('bg-[var(--sys-card)]');
    const surface = dialog.firstElementChild!;
    expect(surface.className).toContain('bg-[var(--sys-card)]');
    expect(surface.className).not.toContain(CARD_CLASS);
    expect(surface.className).toContain('p-4');
  });

  it('«تخطّي» and «التالي» are kit buttons', () => {
    render(<Frame />);
    expect(isKitButton(screen.getByText('تخطّي').closest('button'))).toBe(true);
    expect(isKitButton(screen.getByText('التالي').closest('button'))).toBe(true);
  });

  it('«ما بدي أشرح مرة ثانية» is the kit’s Checkbox, with its own id and a label that points at it', () => {
    render(<Frame />);
    const box = screen.getByLabelText('ما بدي أشرح مرة ثانية') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.id).toBe('first-run-tour-never-again');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    // ticked, «تخطّي» is the refusal: the tour closes and is written as done
    fireEvent.click(screen.getByText('تخطّي'));
    expect(screen.queryByRole('dialog', { name: 'الجولة الأولى' })).toBeNull();
  });
});

// ───────────────────────── «عاين كـ» ─────────────────────────

describe('the «عاين كـ» banner', () => {
  it('is the kit’s plain card in the warning’s colour, in a frame never wider than the screen', () => {
    render(<PreviewBanner name="سلمى" roleName="مؤكدة" />);
    const frame = screen.getByRole('status');
    expect(frame.className).toContain('max-w-full');
    expect(frame.getAttribute('style')).toContain('--sys-mobile-nav-h');
    const surface = frame.firstElementChild!;
    expect(surface.className).toContain('bg-[var(--sys-card)]');
    expect(surface.className).toContain('border-[var(--sys-warning)]');
    expect(surface.className).toContain('flex-wrap');
    expect(surface.className).not.toContain(CARD_CLASS);
    expect(screen.getByText('رجوع لحسابي')).toBeTruthy();
  });
});

// ───────────────────────── read off the source ─────────────────────────

describe('what the source must say', () => {
  it('the install button hides on a phone through a wrapper, because the kit button always shows itself', () => {
    const s = src('InstallApp');
    expect(s).toMatch(/<span className="hidden md:flex shrink-0">\s*<Button/);
  });

  it('the ⓘ is the kit’s icon button and still carries the tour’s anchor', () => {
    const s = src('ScreenGuide');
    expect(s).toMatch(/<IconButton[\s\S]{0,200}label="اشرح لي هذه الشاشة"[\s\S]{0,400}data-tour="guide"/);
    expect(s).not.toMatch(/<button(?=[\s>])/);
  });

  it('the store strip and the guide’s «انتبه» are the kit’s plain card', () => {
    expect(src('EditingStoreBar')).toMatch(/<Card plain className="mb-3 flex flex-wrap/);
    expect(src('ScreenGuide')).toMatch(/<Card plain padding="sm">/);
  });

  it('only two raw presses are left, each a whole row: the bell’s list row and the install line in «المزيد»', () => {
    const raw = PIECES.flatMap((p) => [...src(p).matchAll(/<button(?=[\s>])/g)].map(() => p));
    expect(raw.sort()).toEqual(['InstallApp', 'NotificationBell']);
  });

  it('has no 12px text left in any of the ten — body is 14px, a caption 13px', () => {
    for (const p of PIECES) expect(src(p).includes('text-' + 'xs'), `${p}: نص ١٢ بكسل رجع`).toBe(false);
  });

  it('and no width fixed in pixels wider than a 375 phone', () => {
    for (const p of PIECES) {
      for (const m of src(p).matchAll(/\bw-\[(\d+)px\]/g)) {
        expect(Number(m[1]), `${p}: عرض ثابت ${m[1]}px`).toBeLessThanOrEqual(343);
      }
    }
  });
});
