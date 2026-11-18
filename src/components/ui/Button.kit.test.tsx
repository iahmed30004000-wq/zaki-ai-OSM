// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * R2a (18/11) — THE BUTTON'S FOUR LOOKS, AND THE THREE OLD NAMES THAT STAY.
 *
 * Twenty-one files outside the people who wrote this change call `Button`
 * with the old names, and the screens move onto the four ONE SCREEN PER
 * PULL REQUEST. So this file holds two things at once:
 *
 *   1. nothing an existing call draws has moved — every old name, at every
 *      size, against a FROZEN COPY of what the component drew on 18/11
 *      (`osm/main` at 79aea549). The one exception is named below, and a
 *      test says exactly what it became.
 *   2. the new names, and the stated heights, do what the plan says.
 *
 * The frozen strings are cut into pieces and joined at run time on purpose:
 * Tailwind scans test files, and a whole class written here that no
 * component uses would grow the first-load stylesheet, which has 48 bytes of
 * room.
 */

const j = (...p: string[]) => p.join('');
const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));
const sorted = (s: Set<string>) => [...s].sort();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** What the component drew on 18/11, before this change. */
const OLD_BASE = j(
  'relative inline-flex items-center justify-center gap-1.5 font-medium rounded-lg ',
  'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer'
);
const OLD_SIZE = {
  sm: j('h-11 md:h-8 ', 'px-3 text-xs'),
  md: j('h-11 md:h-10 ', 'px-4 text-sm'),
  // lg was 48 on a desk until R2a. It is asserted separately below.
  lg: j('h-12 ', 'px-5 text-base'),
};
const OLD_VARIANT: Record<string, string> = {
  primary: j(
    'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] ',
    'hover:bg-[var(--sys-primary-hover)] border border-transparent'
  ),
  // The old `secondary`: a page-tinted fill. This is the ONE look that moved.
  secondary: j(
    'bg-[var(--sys-surface)] text-[var(--sys-heading)] ',
    'hover:bg-[var(--sys-border)] border border-[var(--sys-border)]'
  ),
  outline: j(
    'bg-[var(--sys-card)] text-[var(--sys-heading)] ',
    'hover:bg-[var(--sys-surface)] border border-[var(--sys-border)]'
  ),
  danger: j(
    'bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] ',
    'hover:bg-[var(--sys-destructive)]/85 border border-transparent'
  ),
  ghost: j(
    'bg-transparent text-[var(--sys-foreground)] ',
    'hover:bg-[var(--sys-surface)] border border-transparent'
  ),
  success: j(
    'bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] ',
    'hover:bg-[var(--sys-success)]/85 border border-transparent'
  ),
};

type Name = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'success' | 'quiet';

function classesOf(variant: Name, size: 'sm' | 'md' | 'lg', extra: Record<string, unknown> = {}) {
  render(
    <Button variant={variant} size={size} {...extra}>
      نصّ
    </Button>
  );
  const el = screen.getByRole('button');
  const set = tokens(el);
  cleanup();
  return set;
}

const expected = (variant: string, size: 'sm' | 'md' | 'lg') =>
  new Set(`${OLD_BASE} ${OLD_SIZE[size]} ${OLD_VARIANT[variant]}`.split(/\s+/).filter(Boolean));

describe('the old names draw exactly what they drew', () => {
  for (const name of ['primary', 'outline', 'danger', 'ghost', 'success'] as const) {
    for (const size of ['sm', 'md'] as const) {
      it(`${name} · ${size}: the class list is the frozen one`, () => {
        expect(sorted(classesOf(name, size))).toEqual(sorted(expected(name, size)));
      });
    }
  }

  it('and a call that names nothing is still the primary, md', () => {
    render(<Button>نصّ</Button>);
    expect(sorted(tokens(screen.getByRole('button')))).toEqual(sorted(expected('primary', 'md')));
  });
});

describe('THE ONE VISIBLE CHANGE: what `secondary` draws', () => {
  it('is now the card fill with an edge — the look `outline` always had', () => {
    expect(sorted(classesOf('secondary', 'md'))).toEqual(sorted(classesOf('outline', 'md')));
    expect(sorted(classesOf('secondary', 'md'))).toEqual(sorted(expected('outline', 'md')));
  });

  it('and is no longer the page-tinted fill (the negative: the old list is gone)', () => {
    const now = classesOf('secondary', 'md');
    for (const t of OLD_VARIANT.secondary.split(/\s+/)) {
      // `text-[heading]` and the edge are shared by both looks; the FILL
      // and the HOVER are what changed.
      if (t.startsWith('bg-') || t.startsWith('hover:')) {
        expect(now.has(t), `${t} ما زال على secondary`).toBe(false);
      }
    }
  });
});

describe('the new name `quiet`', () => {
  it('has no fill and no edge, and is what `ghost` is an alias of', () => {
    const q = classesOf('quiet', 'md');
    expect(sorted(q)).toEqual(sorted(classesOf('ghost', 'md')));
    expect(q.has('bg-transparent')).toBe(true);
    expect(q.has('border-transparent')).toBe(true);
  });
});

describe('sizes: 32 · 40 · 44 on a desk, and 44 on a phone for all of them', () => {
  it('every size states the phone height first', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(classesOf('primary', size).has('h-11'), `${size}: لا ٤٤ على الهاتف`).toBe(true);
    }
  });

  it('the desk steps are 32 and 40, and the large one STAYS 44 (it was 48)', () => {
    const sm = classesOf('primary', 'sm');
    const md = classesOf('primary', 'md');
    const lg = classesOf('primary', 'lg');
    expect(sm.has('md:h-8')).toBe(true);
    expect(md.has('md:h-10')).toBe(true);
    expect([...lg].some((t) => t.startsWith('md:h-')), 'lg صار له ارتفاع مكتب ثانٍ').toBe(false);
    expect(lg.has(j('h-1', '2')), 'lg ما زال ٤٨').toBe(false);
  });

  it('a label that is long and Arabic changes nothing about the stated height', () => {
    render(
      <div dir="rtl">
        <Button>احفظ التعديلات على كل الطلبات المحدّدة ثم أغلق النافذة</Button>
      </div>
    );
    const set = tokens(screen.getByRole('button'));
    expect(set.has('h-11')).toBe(true);
    // A height that is STATED, not arithmetic: no `h-auto` and no `min-h-*`
    // that a longer label could grow past.
    expect([...set].filter((t) => /^(?:md:)?(?:h-auto|min-h-)/.test(t))).toEqual([]);
  });
});

describe('the control behaves like a control', () => {
  it('has the name of its text', () => {
    render(<Button>احفظ</Button>);
    expect(screen.getByRole('button', { name: 'احفظ' })).toBeTruthy();
  });

  it('is pressed by Enter and by Space', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(<Button onClick={run}>احفظ</Button>);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button'));
    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('disabled is reached by neither the pointer nor the keyboard', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <Button disabled onClick={run}>
        احفظ
      </Button>
    );
    await user.click(screen.getByRole('button'));
    await user.tab();
    await user.keyboard('{Enter}');
    expect(run).not.toHaveBeenCalled();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBeNull();
  });

  it('loading disables it and says so, and `disabled` alone is not busy', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <Button loading onClick={run}>
        احفظ
      </Button>
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await user.click(btn);
    expect(run).not.toHaveBeenCalled();
  });

  it('loading together with disabled stays disabled (precedence unchanged)', () => {
    render(
      <Button loading disabled>
        احفظ
      </Button>
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('a promise still locks it until the work ends (the kit did not touch the lock)', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    render(<Button onClick={run}>ادفع</Button>);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it('a button without text takes the tooltip as its name (as before)', () => {
    render(
      <Button title="حذف المنتج">
        <svg />
      </Button>
    );
    expect(screen.getByRole('button', { name: 'حذف المنتج' })).toBeTruthy();
  });
});

describe('inside a dialog footer', () => {
  it('is drawn, named and pressed like anywhere else', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <Modal
        isOpen
        onClose={() => undefined}
        title="عنوان"
        footer={
          <Button variant="secondary" onClick={run}>
            إلغاء
          </Button>
        }
      >
        <p>نصّ</p>
      </Modal>
    );
    await user.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
