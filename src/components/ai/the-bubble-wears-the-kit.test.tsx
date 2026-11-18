// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * THE ASSISTANT'S BUBBLE ON THE KIT (18/11, R17b).
 *
 * The open panel's presses are the kit's `Button` / `IconButton`, its surface is `Card plain`, its text is 14px
 * with 13px captions. What must not move with the look: the names of the presses, what one press sends and to
 * where, that a second press while the answer is coming sends nothing, that the bubble opens only when pressed,
 * and that the panel fits a 375px phone. The three older tests beside this one hold the room under the page,
 * the wide page's link and the per-person memory — unedited.
 */

let path = '/orders';
vi.mock('next/navigation', () => ({ usePathname: () => path }));
vi.mock('@/context/AppContext', () => ({ useAppOptional: () => ({ currentUser: { id: 'u-kit' } }) }));

import { AiDock } from './AiDock';
import { BulkProvider } from '@/components/shell/BulkBar';

const SRC = stripComments(readFileSync(join(process.cwd(), 'src/components/ai/AiDock.tsx'), 'utf8'));

let fetchMock: ReturnType<typeof vi.fn>;
let answer: (v: unknown) => void;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  sessionStorage.clear();
  fetchMock = vi.fn(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dock() {
  return render(
    <BulkProvider>
      <AiDock />
    </BulkProvider>
  );
}

async function opened() {
  const view = dock();
  await act(async () => {
    screen.getByRole('button', { name: 'افتح المساعد الذكي' }).click();
  });
  return view;
}

const reply = async (text: string) => {
  await act(async () => {
    answer({ ok: true, json: async () => ({ answer: text }) });
  });
};

describe('the open panel', () => {
  it('is drawn on the kit’s plain card — the card’s fill and edge, no theme ornament', async () => {
    await opened();
    const header = screen.getByText('المساعد الذكي').closest('header')!;
    const surface = header.parentElement!;
    expect(surface.className).toContain('bg-[var(--sys-card)]');
    expect(surface.className).toContain('border-[var(--sys-border)]');
    expect(surface.className, 'لوحة فوق الصفحة لبست زخرفة الثيم').not.toContain(CARD_CLASS);
    // the header is the card's own, not a dark bar of its own
    expect(header.className).not.toContain('bg-[var(--sys-heading)]');
  });

  it('names every press, and the tooltips say the same thing', async () => {
    await opened();
    for (const name of ['تصغير', 'إغلاق ومسح', 'إرسال']) {
      const b = screen.getByRole('button', { name });
      expect(b.getAttribute('title')).toBe(name);
    }
  });

  it('«تصغير» folds it to the bubble and keeps the conversation', async () => {
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'كم طلب ينتظر التأكيد؟' }));
    await reply('عشرة');
    await act(async () => {
      screen.getByRole('button', { name: 'تصغير' }).click();
    });
    expect(screen.getByRole('button', { name: 'افتح المساعد الذكي' })).toBeTruthy();
    await act(async () => {
      screen.getByRole('button', { name: 'افتح المساعد الذكي' }).click();
    });
    expect(screen.getByText('عشرة')).toBeTruthy();
  });

  it('«إغلاق ومسح» folds it AND forgets', async () => {
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'كم طلب ينتظر التأكيد؟' }));
    await reply('عشرة');
    await act(async () => {
      screen.getByRole('button', { name: 'إغلاق ومسح' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'افتح المساعد الذكي' }).click();
    });
    expect(screen.queryByText('عشرة')).toBeNull();
    expect(screen.getByText('اسأل عن أرقامك')).toBeTruthy();
  });

  it('«ابدأ محادثة جديدة» appears only once there is something to clear', async () => {
    await opened();
    expect(screen.queryByRole('button', { name: 'ابدأ محادثة جديدة' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'كم طلب ينتظر التأكيد؟' }));
    await reply('عشرة');
    await act(async () => {
      screen.getByRole('button', { name: 'ابدأ محادثة جديدة' }).click();
    });
    expect(screen.queryByText('عشرة')).toBeNull();
  });
});

describe('what a press sends', () => {
  it('an opener sends its question once, to the same door, in the same shape', async () => {
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'أي منتج يرتجع أكثر من غيره؟' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ question: 'أي منتج يرتجع أكثر من غيره؟', period: 'all' });
  });

  it('a second send while the answer is coming sends nothing', async () => {
    await opened();
    const box = screen.getByPlaceholderText('اكتب سؤالك…');
    fireEvent.change(box, { target: { value: 'سؤال أول' } });
    fireEvent.submit(box.closest('form')!);
    fireEvent.change(box, { target: { value: 'سؤال ثانٍ' } });
    fireEvent.submit(box.closest('form')!);
    expect(fetchMock, 'سؤالان طارا والأول لم يرجع').toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('«إرسال» is the form’s submit, and is shut while the box is empty', async () => {
    await opened();
    const send = screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement;
    expect(send.getAttribute('type')).toBe('submit');
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('اكتب سؤالك…'), { target: { value: 'كم؟' } });
    expect(send.disabled).toBe(false);
  });
});

describe('it opens only when pressed', () => {
  it('moving to another screen leaves a folded bubble folded', async () => {
    const view = dock();
    path = '/customers';
    view.rerender(
      <BulkProvider>
        <AiDock />
      </BulkProvider>
    );
    expect(screen.getByRole('button', { name: 'افتح المساعد الذكي' })).toBeTruthy();
    expect(screen.queryByText('اسأل عن أرقامك')).toBeNull();
  });
});

describe('on a 375px phone', () => {
  it('the panel is never wider than the screen less its gutters, nor taller than it', async () => {
    await opened();
    const frame = screen.getByText('المساعد الذكي').closest('header')!.parentElement!.parentElement!;
    expect(frame.className).toContain('w-[min(22rem,calc(100vw-2rem))]');
    expect(frame.className).toContain('h-[min(32rem,calc(100vh-8rem))]');
    // and it sits above the phone's bar, not on it
    expect(frame.getAttribute('style')).toContain('--sys-mobile-nav-h');
    // no width fixed in pixels anywhere in the file
    expect(SRC, 'عرض ثابت بالبكسل').not.toMatch(/\bw-\[\d+px\]/);
  });
});

describe('the type scale', () => {
  it('has no 12px text left in the bubble — body is 14px, a caption 13px', () => {
    expect(SRC.includes('text-' + 'xs'), 'نص ١٢ بكسل رجع للفقاعة').toBe(false);
  });
});
