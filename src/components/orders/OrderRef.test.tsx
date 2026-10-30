// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER NUMBER AND ITS COPY BUTTONS.
 *
 * The number stays what `OrderLink` made it (a link, or text for whoever may
 * not open it); beside it, one button per thing that is BOTH wanted and
 * already on the row: the order number, the phone, the courier's barcode.
 *
 *   · each button puts exactly its own text on the clipboard;
 *   · a value that is not there is not a greyed button, it is no button;
 *   · pressing never reaches the row it sits in, and never calls the server;
 *   · a failed copy says so and offers the text to copy by hand;
 *   · it is a 44-point target on a phone, with an Arabic name.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { may, warn } = vi.hoisted(() => ({
  may: { orders: true },
  warn: vi.fn<(text: string, detail?: string) => void>(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string) => (String(target).startsWith('/orders') ? may.orders : true),
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ done: vi.fn(), warn, failed: vi.fn() }),
}));

import { OrderRef } from './OrderRef';

const LRM = '‎';
const RLM = '‏';

/** Press a button the way a person does: the click, then let the copy settle. */
async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

let written: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

function clipboardAvailable(ok = true) {
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => {
        if (!ok) throw new Error('denied');
        written.push(t);
      }),
    },
  });
}

beforeEach(() => {
  may.orders = true;
  warn.mockClear();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  clipboardAvailable(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  Reflect.deleteProperty(document, 'execCommand');
});

const all = () => screen.getAllByRole('button');

describe('the number stays what it was', () => {
  it('is the link that opens the order, for whoever may open it', () => {
    render(<OrderRef id="o-1" number="SY-2026-0148" />);
    const link = screen.getByRole('link', { name: 'SY-2026-0148' });
    expect(link.getAttribute('href')).toBe('/orders/o-1');
    expect(link.getAttribute('dir')).toBe('ltr');
  });

  it('is plain text for whoever may not — a promise is only made to who can keep it', () => {
    may.orders = false;
    render(<OrderRef id="o-1" number="SY-2026-0148" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('SY-2026-0148').getAttribute('dir')).toBe('ltr');
  });

  it('opens the order she holds on her own desk when the screen vouches for it', () => {
    may.orders = false;
    render(<OrderRef id="o 1" number="SY-1" opensOnHerDesk />);
    expect(screen.getByRole('link', { name: 'SY-1' }).getAttribute('href')).toBe('/confirmation/mine?open=o%201');
  });

  it('is a button that calls the screen when the screen opens the panel itself', () => {
    const onOpen = vi.fn();
    render(<OrderRef id="o-1" number="SY-1" onOpen={onOpen} />);
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SY-1' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('copying the number does not open the order', async () => {
    const onOpen = vi.fn();
    render(<OrderRef id="o-1" number="SY-1" onOpen={onOpen} />);
    await press(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('each button copies its own text and nothing else', () => {
  it('the order number — as printed', async () => {
    render(<OrderRef id="o-1" number={` ${LRM}SY-2026-0148${RLM} `} phone="0791234567" barcode="BX-1" />);
    await press(screen.getByRole('button', { name: /^نسخ رقم الطلب/ }));
    expect(written).toEqual(['SY-2026-0148']);
  });

  it('the phone — Latin digits, no marks, no country code added', async () => {
    render(<OrderRef id="o-1" number="SY-1" phone={`${LRM}٠٧٩ ١٢٣ ٤٥٦٧${RLM}`} barcode="BX-1" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    expect(written).toEqual(['0791234567']);
  });

  it('the phone keeps a leading plus', async () => {
    render(<OrderRef id="o-1" number="SY-1" phone="+962 79 123-4567" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    expect(written).toEqual(['+962791234567']);
  });

  it('the barcode — as the courier wrote it, only trimmed', async () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="  aB-9421-xY " />);
    await press(screen.getByRole('button', { name: 'نسخ باركود الشحنة' }));
    expect(written).toEqual(['aB-9421-xY']);
  });

  it('a press copies one value; the other two stay untouched', async () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    await press(screen.getByRole('button', { name: 'نسخ باركود الشحنة' }));
    expect(written).toHaveLength(1);
  });
});

describe('a value that is not on the row is no button', () => {
  it('the number alone: one button', () => {
    render(<OrderRef id="o-1" number="SY-1" />);
    expect(all()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' })).toBeTruthy();
  });

  it('a warehouse row (no phone, no barcode) draws no phone or barcode button', () => {
    render(<OrderRef id="o-1" number="SY-1" phone={undefined} barcode={undefined} />);
    expect(screen.queryByRole('button', { name: /هاتف/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /باركود/ })).toBeNull();
  });

  it.each([null, '', '   ', `${LRM} ${RLM}`])('a phone of %j draws nothing', (phone) => {
    render(<OrderRef id="o-1" number="SY-1" phone={phone} barcode="BX-1" />);
    expect(screen.queryByRole('button', { name: /هاتف/ })).toBeNull();
    expect(screen.getByRole('button', { name: /باركود/ })).toBeTruthy();
  });

  it.each([null, '', '  '])('a barcode of %j draws nothing', (barcode) => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode={barcode} />);
    expect(screen.queryByRole('button', { name: /باركود/ })).toBeNull();
    expect(screen.getByRole('button', { name: /هاتف/ })).toBeTruthy();
  });

  it('all three present: three buttons', () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    expect(all()).toHaveLength(3);
  });

  it('no number, no number button (a link with nothing in it is not drawn twice)', () => {
    render(<OrderRef id="o-1" number="" phone="0791234567" />);
    expect(screen.queryByRole('button', { name: /رقم الطلب/ })).toBeNull();
  });
});

describe('the press is acknowledged on the button, and it wears off', () => {
  it('the name turns to «تم نسخ» and a status line says it, then it goes back', async () => {
    vi.useFakeTimers();
    render(<OrderRef id="o-1" number="SY-1" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }));
    expect(screen.getByRole('button', { name: 'تم نسخ رقم الطلب SY-1' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('تم نسخ رقم الطلب');
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a fast second press restarts the wait instead of stacking a second timer', async () => {
    vi.useFakeTimers();
    render(<OrderRef id="o-1" number="SY-1" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await press(screen.getByRole('button', { name: 'تم نسخ رقم الطلب SY-1' }));
    // 1000 ms after the second press the first timer would have fired at 1500 total.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button', { name: 'تم نسخ رقم الطلب SY-1' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' })).toBeTruthy();
  });

  it('leaving the screen mid-wait is quiet', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<OrderRef id="o-1" number="SY-1" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }));
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a successful copy does not raise a toast (a list of rows would drown in them)', async () => {
    render(<OrderRef id="o-1" number="SY-1" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('when the browser refuses the clipboard', () => {
  it('falls back to the selection trick and still succeeds', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    let selected = '';
    exec.mockImplementation(() => {
      selected = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    render(<OrderRef id="o-1" number="SY-1" phone="٠٧٩١٢٣٤٥٦٧" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(selected).toBe('0791234567');
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByRole('button', { name: 'تم نسخ رقم هاتف الزبون' })).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back when the clipboard API rejects', async () => {
    clipboardAvailable(false);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    render(<OrderRef id="o-1" number="SY-1" barcode="BX-9" />);
    await press(screen.getByRole('button', { name: 'نسخ باركود الشحنة' }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: 'تم نسخ باركود الشحنة' })).toBeTruthy();
  });

  it('when both fail it says so and hands over the text to copy by hand', async () => {
    clipboardAvailable(false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" />);
    await press(screen.getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    expect(warn).toHaveBeenCalledWith('تعذّر النسخ — انسخه يدوياً', '0791234567');
    // …and it does not pretend.
    expect(screen.queryByRole('button', { name: /^تم نسخ/ })).toBeNull();
  });
});

describe('a copy is not an event', () => {
  it('makes no request of any kind', async () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    for (const b of all()) await press(b);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the press does not reach the row it sits in', async () => {
    const row = vi.fn();
    render(
      <div onClick={row}>
        <OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />
      </div>
    );
    for (const b of all()) await press(b);
    expect(row).not.toHaveBeenCalled();
  });
});

describe('a button a thumb can hit, with an Arabic name', () => {
  it('every button is 44 points on a phone and shrinks only from md up', () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    for (const b of all()) {
      const cls = b.className.split(/\s+/);
      expect(cls, b.getAttribute('aria-label') ?? '').toContain('h-11');
      expect(cls.some((c) => c.startsWith('md:h-'))).toBe(true);
    }
    // the icon-only one keeps a 44-wide target too
    expect(screen.getByRole('button', { name: 'نسخ رقم الطلب SY-1' }).className).toContain('min-w-11');
  });

  it('the names are Arabic and say which value', () => {
    render(<OrderRef id="o-1" number="SY-2026-0148" phone="0791234567" barcode="BX-1" />);
    expect(all().map((b) => b.getAttribute('aria-label'))).toEqual([
      'نسخ رقم الطلب SY-2026-0148',
      'نسخ رقم هاتف الزبون',
      'نسخ باركود الشحنة',
    ]);
    for (const b of all()) expect(b.getAttribute('aria-label')).not.toMatch(/[A-Za-z]{4,}\s+[a-z]{4,}/);
  });

  it('the phone is never put in a name read aloud, and the visible words are inside the name', () => {
    render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    const phone = screen.getByRole('button', { name: 'نسخ رقم هاتف الزبون' });
    expect(phone.getAttribute('aria-label')).not.toContain('0791234567');
    expect(phone.textContent).toBe('هاتف');
    expect(screen.getByRole('button', { name: 'نسخ باركود الشحنة' }).textContent).toBe('باركود');
  });

  it('every icon is hidden from the reader and every button is a plain button', () => {
    const { container } = render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
    for (const b of all()) expect(b.getAttribute('type')).toBe('button');
  });

  it('the cluster wraps instead of overflowing a narrow row', () => {
    const { container } = render(<OrderRef id="o-1" number="SY-1" phone="0791234567" barcode="BX-1" />);
    expect((container.firstElementChild as HTMLElement).className).toContain('flex-wrap');
  });
});
