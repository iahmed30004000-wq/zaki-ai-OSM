// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE SEARCH PALETTE ON THE KIT (18/11, R17b).
 *
 * The phone's ✕ is the kit's `IconButton`; captions are 13px, the empty answer 14px. The result rows and the
 * summary lines stay raw presses on purpose (a whole row is the control — R19's allowed list). What must not
 * move: the pointer only lights a row, a click or Enter runs it; the arrows walk; the ✕ closes; the box fits a
 * 375px phone edge to edge.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: { id: 'u1', role: 'SUPER_ADMIN', permissions: [] } }) }));

import { CommandPalette } from './CommandPalette';

const SRC = stripComments(readFileSync(join(process.cwd(), 'src/components/shell/CommandPalette.tsx'), 'utf8'));

const GROUPS = [
  {
    key: 'ops',
    label: 'التشغيل',
    routes: [
      { path: '/ops/shipments', label: 'شحنات اليوم', icon: 'Truck', permissions: [] },
      { path: '/ops/returns', label: 'شحنات راجعة', icon: 'Package', permissions: [] },
    ],
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ facts: [], may: { pull: false, people: false, wide: false } }) }))
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function open(onClose: () => void = () => undefined) {
  return render(<CommandPalette groups={GROUPS} canSearchRecords={false} canSwitchStore={false} open onClose={onClose} />);
}

async function type(text: string) {
  const box = screen.getByLabelText('ابحث أو انتقل أو نفّذ');
  await act(async () => {
    fireEvent.change(box, { target: { value: text } });
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  return box;
}

const rowOf = (label: string) => screen.getByText(label).closest('button')!;

describe('the phone’s way out', () => {
  it('is a named kit button, hidden on a desk, and it closes the box', async () => {
    const onClose = vi.fn();
    open(onClose);
    const x = screen.getByRole('button', { name: 'إغلاق' });
    expect(x.getAttribute('title')).toBe('إغلاق');
    expect(x.className).toContain('md:hidden');
    // the kit's square: 44px on a phone
    expect(x.className).toContain('h-11');
    expect(x.className).toContain('w-11');
    await act(async () => {
      x.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a result row', () => {
  it('is lit by the pointer and never run by it', async () => {
    open();
    await type('شحنات');
    const second = rowOf('شحنات راجعة');
    await act(async () => {
      fireEvent.mouseEnter(second);
    });
    expect(second.getAttribute('aria-current')).toBe('true');
    expect(push, 'المرور فوق صفّ فتحه').not.toHaveBeenCalled();
  });

  it('runs on a click', async () => {
    open();
    await type('شحنات');
    await act(async () => {
      rowOf('شحنات راجعة').click();
    });
    expect(push).toHaveBeenCalledWith('/ops/returns');
  });

  it('is walked by the arrows, and Enter runs the lit one', async () => {
    open();
    const box = await type('شحنات');
    expect(rowOf('شحنات اليوم').getAttribute('aria-current')).toBe('true');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'ArrowDown' });
    });
    expect(rowOf('شحنات راجعة').getAttribute('aria-current')).toBe('true');
    expect(rowOf('شحنات اليوم').getAttribute('aria-current')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/ops/returns');
  });
});

describe('with no results', () => {
  it('says so in a sentence, at body size', async () => {
    open();
    await type('لا يوجد شيء كهذا');
    const said = screen.getByText('لا شيء بهذا الاسم ولا بهذا الرقم، ضمن ما تملك صلاحية رؤيته.');
    expect(said.className).toContain('text-sm');
  });
});

describe('on a 375px phone', () => {
  it('the sheet is the whole screen, and only a desk gets a width cap', () => {
    open();
    const sheet = screen.getByLabelText('ابحث أو انتقل أو نفّذ').closest('[role="dialog"]')!.firstElementChild!;
    const cls = sheet.className.split(/\s+/);
    expect(cls).toContain('w-full');
    expect(cls).toContain('h-full');
    // every max-width is behind the desk's prefix
    expect(cls.filter((c) => c.startsWith('max-w-'))).toEqual([]);
    expect(SRC, 'عرض ثابت بالبكسل').not.toMatch(/\bw-\[\d+px\]/);
  });
});

describe('the type scale', () => {
  it('has no 12px text left in the palette', () => {
    expect(SRC.includes('text-' + 'xs'), 'نص ١٢ بكسل رجع للوحة').toBe(false);
  });
});
