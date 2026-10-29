// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * AN ORDER, WHEREVER IT IS LISTED, OPENS WHEN YOU PRESS IT — AND ITS HISTORY IS A PRESS AWAY.
 *
 * The owner (29-30/10): «انقر ع الطلب يدخلني، زي مثلا بالمؤجل .... الملغي الخ» and
 * «زر السجل بكل مكان مش موجود فيه». The postponed and the win-back lists had
 * the number as a link; the change-requests, returns, tracking, parcel,
 * discount, new-parcel, customer-orders and queue lists printed it as text,
 * and nowhere drew the link so that a thumb could tell it from text.
 *
 * What is held here:
 *   1. a list that prints an order number draws it as `OrderLink` — measured by
 *      reading the screens' source, with the few screens that print a number
 *      INSIDE a sentence or a dialog title named, each with its reason;
 *   2. the postponed list (the owner's own example) opens the order it names for
 *      whoever may open `/orders`, and for nobody else — text, never a link
 *      that ends in «لا تملك صلاحية»;
 *   3. «السجل» sits beside the customer there, drawn only for the key the
 *      history door answers to (`customers.view`, or the work key from an
 *      order), and pressing it asks the door for THAT order's customer.
 */

const { api, may, me } = vi.hoisted(() => ({
  api: vi.fn(),
  may: { yes: true },
  me: { permissions: [] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => may.yes }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    currentUser: { id: 'u1', name: 'سارة', role: 'MODERATOR', status: 'ACTIVE', permissions: me.permissions },
  }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>الطلبات المؤجلة</h1> }));

import { ConfirmationPostponedScreen } from './ConfirmationPostponedScreen';

const row = {
  id: 'orderPost1',
  orderNumber: 'ORD-P1',
  totalAmount: 10,
  currency: 'USD',
  dueAt: '2026-10-22T10:00:00.000Z',
  daysRemaining: 1,
  postponePreferredTime: 'MORNING',
  postponeCount: 2,
  followUpReason: 'CUSTOMER_BUSY',
  actionable: false,
  customer: { id: 'custOne', fullName: 'عميل تجريبي', phone: '0790000000', city: 'عمّان' },
  claimer: { id: 'u1', name: 'سارة' },
};

beforeEach(() => {
  vi.clearAllMocks();
  may.yes = true;
  me.permissions = ['customers.view'];
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/customers/')) {
      return {
        customer: { fullName: 'عميل تجريبي', rawPhone: '0790000000', totalOrders: 3, deliveredOrders: 1, cancelledOrders: 1 },
        risk: { tier: 'SAFE', returnRate: 0, orders: 3, returns: 0, requiresPrepaymentOrApproval: false },
        orders: [],
      };
    }
    return {
      leadDays: 2,
      count: 1,
      orders: [row],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      facts: {
        total: 1,
        whens: { now: 0, overdue: 0, soon: 1, week: 0, later: 0 },
        kinds: { postponed: 1, followup: 0 },
        times: { once: 0, many: 1 },
        agents: null,
      },
      applied: {},
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ConfirmationPostponedScreen />);
  await screen.findAllByText('ORD-P1');
};
/** Every place the number is printed — the card and the table both exist in the page. */
const numbers = () => screen.getAllByText('ORD-P1');

describe('the postponed list opens the order it names', () => {
  it('draws the number as a link to that order, underlined so a thumb can tell it from text', async () => {
    await draw();
    const link = numbers().find((el) => el.tagName === 'A') as HTMLAnchorElement | undefined;
    expect(link, 'الرقم نصٌّ بلا رابط').toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/orders/orderPost1');
    expect(link!.className).toContain('underline');
  });

  it('NEGATIVE: for someone who may not open /orders it stays text — no link that ends in a refusal', async () => {
    may.yes = false;
    await draw();
    // The only anchor allowed is the agent's own desk (an agent's list, where the screen vouches for it) — never /orders.
    const orders = numbers().filter((el) => el.tagName === 'A' && (el.getAttribute('href') ?? '').startsWith('/orders'));
    expect(orders).toHaveLength(0);
  });
});

describe('«السجل» beside the customer', () => {
  it('is there for the address book key, and asks the history door for THIS order\'s customer', async () => {
    await draw();
    const button = screen.getAllByRole('button', { name: /السجل/ })[0];
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.mock.calls.some((c) => c[0] === '/api/customers/custOne/history?exclude=orderPost1')).toBe(true)
    );
  });

  it('is there for the agent who works the order (the work door reads it from the order)', async () => {
    me.permissions = ['confirmation.work'];
    await draw();
    expect(screen.queryAllByRole('button', { name: /السجل/ }).length).toBeGreaterThan(0);
  });

  it('NEGATIVE: not drawn for a key the history door would refuse — no button that answers «ليس من صلاحيّاتك»', async () => {
    me.permissions = ['orders.view'];
    await draw();
    expect(screen.queryAllByRole('button', { name: /السجل/ })).toHaveLength(0);
  });

  it('NEGATIVE: not drawn for a row that carries no customer id — nothing to ask the door about', async () => {
    (row.customer as { id?: string }).id = undefined;
    try {
      await draw();
      expect(screen.queryAllByRole('button', { name: /السجل/ })).toHaveLength(0);
    } finally {
      row.customer.id = 'custOne';
    }
  });
});

/* ── the source: no list prints an order number as bare text ────────────────────── */

const SCREENS = join(process.cwd(), 'src/components/screens');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []
  );

/**
 * A number printed as the only content of a span — `<span …>{x.orderNumber}</span>`
 * — is a list cell that cannot be pressed. Where a screen prints it that way ON
 * PURPOSE, the screen and the reason are named here.
 */
const ON_PURPOSE: Record<string, string> = {
  // Inside her own "work" card: the card's own «افتح وعدّل» opens the order, and it is LOCKED until the first contact
  // attempt (CONTACT_FIRST). A number that opened the panel would be the way round that lock.
  'ConfirmationMineScreen.tsx': 'the held card — opening is the locked button beside it',
  // The whole card is the control here: pressing it opens the order's panel (aria-label «افتح الطلب …»).
  'OrdersScreen.tsx': 'the row itself opens the order',
  // The text branch of the ternary whose other branch is the button: for someone without «عرض الطلبات».
  'PreparationScreen.tsx': 'the fallback for a viewer without the key',
  // Two dialogs that name the order they act on in a heading line; they open over the list the order was chosen from.
  'LinkLineDialog.tsx': 'a dialog naming the order it acts on',
  'SwapDialog.tsx': 'a dialog naming the orders it swaps',
  // The notice listing orders the batch refused: the exceptions carry the number and the reasons, no order id.
  'ShipmentsNewScreen.tsx': 'the refusals notice — the payload has no id to link',
};

describe('no screen prints an order number as a bare span', () => {
  const offenders: string[] = [];
  for (const file of walk(SCREENS)) {
    const name = file.split(/[\\/]/).pop()!;
    const code = stripComments(readFileSync(file, 'utf8'));
    const bare = /<span[^>]*>\s*\{[^{}]*\.orderNumber\}\s*<\/span>/g;
    const hits = code.match(bare) ?? [];
    if (hits.length && !ON_PURPOSE[name]) offenders.push(`${name} ×${hits.length}`);
  }
  it('— every list cell that names an order is a link or a button (or named above, with its reason)', () => {
    expect(offenders).toEqual([]);
  });
  it('— and the exemption list holds no screen that has since been fixed', () => {
    for (const name of Object.keys(ON_PURPOSE)) {
      const file = walk(SCREENS).find((f) => f.endsWith(name))!;
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(/<span[^>]*>\s*\{[^{}]*\.orderNumber\}\s*<\/span>/.test(code), `${name} لا يحتاج استثناءً بعد الآن`).toBe(true);
    }
  });
});
