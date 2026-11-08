// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * A CLEARED COUNT BOX IS NOT A SHELF WITH NOTHING ON IT.
 *
 * This is the same defect `509306a` removed from the production screen,
 * standing in the one place where the number it invents is a WRITE-OFF.
 *
 *     const [countedQuantity, setCountedQuantity] = useState(0);
 *     onChange={(e) => setCountedQuantity(parseInt(e.target.value, 10) || 0)}
 *     const difference = countedQuantity - systemQty;
 *     <Button disabled={difference === 0 || reason.trim().length < 3}>
 *
 * WHAT THAT PRODUCED, measured below rather than reasoned about:
 *
 *   The screen chooses the first product the moment `/api/inventory`
 *   answers — `if (data.stockSummary?.length > 0 && !productId)`. So the
 *   dialog opens with a product already selected, a system balance of 480,
 *   and a counted quantity of **0 that nobody typed**. `difference` is
 *   -480, which is not zero, so the only thing between that and the wire
 *   is three characters of reason. Type a reason and press save: 480 units
 *   leave the shelf, FIFO-costed out of the oldest batch, with «counted 0
 *   and the system says 480» written into the movement log as though a
 *   person had stood in the warehouse and counted nothing.
 *
 * AND THE DOOR CANNOT HELP. `countedQuantity: count(1_000_000)` has a
 * minimum of 0 — correctly, because an empty shelf is a real count. So the
 * browser is the only place where «I counted zero» and «I typed nothing»
 * are still distinguishable, and `|| 0` is where that distinction was
 * destroyed. This is the rule the repository already carries: when a falsy
 * value is a real value, the fallback is DELETED, not replaced with `??`.
 *
 * The box therefore holds CHARACTERS, the difference panel refuses to do
 * arithmetic on a box that says nothing, and the save button cannot be
 * reached until a quantity exists. A typed `0` still works and still
 * writes off the shelf — that is the whole point of the screen.
 */

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'الغاء' }, locale: 'ar' }),
}));
// The screen reads `?product=` (the receive dialog's deep link); this test has none.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
// The picker is a second question. The screen selects the first product on
// load, which is precisely the condition the defect needs.
vi.mock('@/components/ui/ProductPicker', () => ({
  ProductPicker: ({ value }: { value: string }) => <div data-testid="picker">{value}</div>,
}));
vi.mock('@/components/inventory/OpeningStockCount', () => ({
  OpeningStockCountBanner: () => null,
}));

import { InventoryBalancesScreen } from './InventoryBalancesScreen';

const HEALTH = {
  state: 'HEALTHY',
  label: 'متوفر',
  tone: 'success' as const,
  why: '480 متاحة ولا معدَّل بعد.',
  available: 480,
  perDay: null,
  coverDays: null,
  windowDays: 13,
  score: null,
  bands: [],
  needsRestock: false,
};

const PRODUCT = {
  id: 'prod-1',
  name: 'كريم',
  sku: 'KR-1',
  sourceType: 'MANUFACTURED',
  produced: 500,
  sold: 20,
  remaining: 480,
  reserved: 0,
  health: HEALTH,
};

/** Every non-GET body the screen sent, in order. */
let sent: { url: string; method: string; body: any }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return { ok: true, json: async () => ({ success: true }) } as any;
      }
      return {
        ok: true,
        json: async () => ({ stockSummary: [PRODUCT], alerts: [], ledgerDays: 13 }),
      } as any;
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COUNTED = 'الكمية المتاحة المعدودة *';
const REASON = 'سبب الفرق *';
const box = () => screen.getByLabelText(COUNTED) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'سجّل الجرد' }) as HTMLButtonElement;
const posts = () => sent.filter((s) => s.method === 'POST');

const openCount = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<InventoryBalancesScreen />);
  // The card drawing is the fetch having landed — and with it the first
  // product having been chosen, inside a dialog that is not open yet.
  await waitFor(() => expect(screen.getByText('كريم')).toBeTruthy());
  await user.click(screen.getAllByRole('button', { name: /جرد مخزون/ })[0]);
  await waitFor(() => expect(screen.getByTestId('picker').textContent).toBe('prod-1'));
};

describe('what the old reading produced on this screen', () => {
  it('is the reading itself: a cleared box and a shelf counted as empty agree', () => {
    expect(parseInt('', 10)).toBeNaN();
    expect(parseInt('', 10) || 0).toBe(0);
    // And the door is obliged to accept that 0, because an empty shelf is a
    // real count: `count(1_000_000)` has a minimum of zero.
    expect(0 - 480).toBe(-480);
  });
});

describe('the count box opens saying nothing', () => {
  it('and shows no difference until a quantity exists', async () => {
    const user = userEvent.setup();
    await openCount(user);
    expect(box().value).toBe('');
    // The panel that used to read -480 before anyone touched the form.
    expect(screen.queryByText('-480')).toBeNull();
    expect(screen.getByText(/اكتب الكمية المعدودة/)).toBeTruthy();
  });

  it('so a reason alone cannot write off the shelf', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(screen.getByLabelText(REASON), 'جرد');
    await user.click(save());
    /*
     * THE WIRE FIRST, and spelled out: a failure must print the units that
     * would have left the shelf, not a boolean about a button. With the old
     * reading restored this reads
     *   [ 'counted 0 against a shelf of 480' ]
     * which is the defect in one line.
     */
    expect(posts().map((p) => `counted ${p.body.countedQuantity} against a shelf of ${PRODUCT.remaining}`)).toEqual([]);
    expect(save().disabled).toBe(true);
  });
});

describe('a quantity that was typed', () => {
  it('reaches the door as the characters typed, and the panel does the subtraction', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '475');
    expect(screen.getByText('-5')).toBeTruthy();
    await user.type(screen.getByLabelText(REASON), 'جرد الشهر');
    await user.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.countedQuantity).toBe('475');
    expect(posts()[0].body.reason).toBe('جرد الشهر');
  });

  it('and a typed zero still empties the shelf — that is what the screen is for', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '0');
    expect(screen.getByText('-480')).toBeTruthy();
    await user.type(screen.getByLabelText(REASON), 'تالف بالكامل');
    expect(save().disabled).toBe(false);
    await user.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.countedQuantity).toBe('0');
  });

  it('and clearing it again takes the difference away with it', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '475');
    expect(screen.getByText('-5')).toBeTruthy();
    await user.clear(box());
    expect(screen.queryByText('-5')).toBeNull();
    expect(screen.getByText(/اكتب الكمية المعدودة/)).toBeTruthy();
  });

  it('and a count that matches the shelf is refused as nothing to record', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '480');
    await user.type(screen.getByLabelText(REASON), 'جرد مطابق');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/لن يُسجَّل شيء/)).toBeTruthy();
  });
});

/**
 * «الجرد بدي اياه للمتاح وليس على الرف» (the owner, 8/11): the system figure the count is compared with is the AVAILABLE the server
 * sends (`health.available` = the shelf less what open orders hold), shown with the shelf and the held units beside it so the
 * counter can see how it is made — never a subtraction made on this screen.
 */
describe('the count is of the available, not of the shelf', () => {
  const HELD = { ...PRODUCT, remaining: 480, reserved: 100, health: { ...HEALTH, available: 380 } };

  const serveHeld = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
          sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
          return { ok: true, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, json: async () => ({ stockSummary: [HELD], alerts: [], ledgerDays: 13 }) } as any;
      })
    );

  it('«المتاح في النظام» is the available the server sent — not the shelf — and the shelf and the held units stand beside it', async () => {
    serveHeld();
    const user = userEvent.setup();
    await openCount(user);
    const system = screen.getByText('المتاح في النظام').nextElementSibling as HTMLElement;
    expect(system.textContent).toBe('380');
    expect(screen.getByText(/على الرف 480 · محجوز 100/)).toBeTruthy();
    // the old label is gone from the dialog
    expect(screen.queryByText('رصيد النظام')).toBeNull();
  });

  it('the difference is against the available: 400 counted is +20 (the shelf figure would have said −80)', async () => {
    serveHeld();
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '400');
    expect(screen.getByText('+20')).toBeTruthy();
    expect(screen.queryByText('-80')).toBeNull();
  });

  it('a count equal to the available agrees: nothing to record, nothing sent', async () => {
    serveHeld();
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '380');
    await user.type(screen.getByLabelText(REASON), 'جرد مطابق');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/لن يُسجَّل شيء/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('says to count what can be sold — without the units held for open orders, ones out with a courier included', async () => {
    serveHeld();
    const user = userEvent.setup();
    await openCount(user);
    expect(screen.getByText(/عُدَّ ما يمكن بيعه فقط/)).toBeTruthy();
    expect(screen.getByText(/لم تُسلَّم بعد/)).toBeTruthy();
  });
});

describe('a figure that is not written the way a number is written', () => {
  it('goes to the door as characters, for the door to refuse by name', async () => {
    /*
     * The same ruling as `0aea050`: the browser does not pre-reject and does
     * not quietly repair. `'1e3'` truncating to 1, `'0x10'` becoming 16 and
     * Arabic-Indic digits becoming NaN then 0 are all refusals the door
     * owns, and a second rule here is how the two drift apart.
     */
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '1e3');
    await user.type(screen.getByLabelText(REASON), 'جرد');
    if (!save().disabled) {
      await user.click(save());
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(typeof posts()[0].body.countedQuantity).toBe('string');
    }
  });

  it('and nothing is sent at all while the box is empty', async () => {
    const user = userEvent.setup();
    await openCount(user);
    await user.type(box(), '5');
    await user.clear(box());
    await user.type(screen.getByLabelText(REASON), 'جرد');
    expect(save().disabled).toBe(true);
    expect(posts()).toHaveLength(0);
    // And were the guard ever lifted, `JSON.stringify` drops the key rather
    // than carrying a zero: absent is the door's to interpret, not ours.
    expect(JSON.parse(JSON.stringify({ a: 1, countedQuantity: undefined }))).toEqual({ a: 1 });
  });
});
