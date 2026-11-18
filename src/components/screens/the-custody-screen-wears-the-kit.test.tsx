// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * «عهدة المندوبين» ON THE KIT (R13a, plan 17/11) — ONE LOOK, AND NOT ONE FIGURE MOVED.
 *
 * A money screen: it may look different, and nothing it prints or asks may change. So this file holds
 *   the frame — `PageShell`, the menu's own name as the one h1 of the list, the agent's name on his page, the way back in the header;
 *   the surfaces — a section is the kit's card, the list of agents and the four tiles are its plain card (no theme ornament on rows);
 *   the captions — the caption size, except the one line that carries an amount (left as it was: the money-line rule of R13);
 *   the presses — the row press still asks the same two addresses and nothing else, and stays shut while a page is loading;
 *   the figures — every text that carries a digit, frozen from the screen as it was on main before this request (18/11),
 *     on a desk and on a phone, the list and one agent's page;
 *   the phone — no fixed width wider than the phone, and the header's actions wrap.
 */

const { apiJson, phone } = vi.hoisted(() => ({ apiJson: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/agents' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { AgentCustodyScreen } from './AgentCustodyScreen';

const AGENT = { id: 'ag1', name: 'مندوب تجريبي', code: 'AGENT-T1' };
const TOTALS = {
  inHandCount: 2,
  inHandValue: 40,
  collected: 50,
  fees: 5,
  balance: 45,
  awaitingCount: 1,
  awaitingValue: 20,
  awaitingFees: 3,
  hasUnconfirmed: true,
};
const ORDER = {
  id: 'o1',
  orderNumber: 'SY-2026-0001',
  customerName: 'زبون',
  regionName: 'دمشق',
  shippingStatus: 'DELIVERED',
  shippedAt: '2026-09-01T00:00:00.000Z',
  deliveredAt: '2026-09-05T00:00:00.000Z',
  orderValue: 20,
  collected: null as number | null,
  fee: 3,
};
const IN_HAND = { ...ORDER, id: 'o2', orderNumber: 'SY-2026-0002', shippingStatus: 'FAILED_DELIVERY', deliveredAt: null, orderValue: 40, fee: 2 };
const PAID = { ...ORDER, id: 'o3', orderNumber: 'SY-2026-0003', collected: 50, orderValue: 50, fee: 5 };

let owing = [ORDER, PAID];
let detailGate: Promise<void> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  owing = [ORDER, PAID];
  detailGate = null;
  apiJson.mockImplementation(async (url: string) => {
    if (url === '/api/finance/agents') return { currencyCode: 'JOD', minorUnit: 3, agents: [{ agent: AGENT, totals: TOTALS }] };
    if (detailGate) await detailGate;
    return { custody: { agent: AGENT, currencyCode: 'JOD', inHand: [IN_HAND], owing, totals: TOTALS } };
  });
});
afterEach(() => cleanup());

const source = () => readFileSync(join(process.cwd(), 'src/components/screens/AgentCustodyScreen.tsx'), 'utf8');
/** Built from parts, so this file writes no class-like token the stylesheet would pick up. */
const XS = ['text', 'xs'].join('-');

const drawList = async () => {
  render(<AgentCustodyScreen />);
  await screen.findByText(AGENT.name);
};
const openAgent = async () => {
  fireEvent.click(screen.getByText(AGENT.name).closest('button')!);
  await screen.findByText('ما زال بيده');
};

/** Every text node that carries a digit, in the order the page draws them. */
const figures = () => {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (/[\d٠-٩]/.test(t)) out.push(t);
  }
  return out;
};

describe('the frame', () => {
  it('— the list: one h1, the menu’s own name, read from the registry', async () => {
    await drawList();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(routeLabel('/finance/agents'));
    expect(h1[0].textContent).toBe('عهدة المندوبين');
  });

  it('— is the kit’s `PageShell`; the screen draws no header and no outer box of its own', () => {
    const src = source();
    expect(src).toContain("<PageShell title={routeLabel('/finance/agents')}");
    expect(src).not.toContain('<PageHeader');
    expect(src).not.toContain('max-w-4xl');
  });

  it('— one agent’s page: his name is the h1, and the way back sits in the header and goes back', async () => {
    await drawList();
    await openAgent();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe(`عهدة ${AGENT.name}`);
    const back = screen.getByRole('button', { name: /كل المندوبين/ });
    expect(back.closest('header'), 'زر الرجوع مش بالرأس').toBe(h1[0].closest('header'));
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('عهدة المندوبين'));
  });
});

describe('the surfaces', () => {
  it('— a section is the kit’s card; the list of agents and the tiles are its plain card', async () => {
    await drawList();
    const list = screen.getByText(AGENT.name).closest('ul')!;
    expect(list.parentElement!.className).toContain('bg-[var(--sys-card)]');
    expect(list.parentElement!.classList.contains(CARD_CLASS), 'زخرفة الثيم على صفوف القائمة').toBe(false);

    await openAgent();
    const section = screen.getByText('ما زال بيده').closest('h4')!.parentElement!.parentElement!;
    expect(section.classList.contains(CARD_CLASS), 'القسم مش بطاقة العدّة').toBe(true);
    const tile = screen.getByText('طلبات بيده').parentElement!;
    expect(tile.className).toContain('p-3');
    expect(tile.classList.contains(CARD_CLASS), 'زخرفة الثيم على مربع').toBe(false);
    const box = screen.getByText('استلام ما بذمّته').parentElement!;
    expect(box.classList.contains(CARD_CLASS)).toBe(true);
    expect(box.className).toContain('p-4');
  });
});

describe('the captions', () => {
  it('— nothing on either page is the extra-small size, except the one line that carries an amount', async () => {
    await drawList();
    expect(document.body.querySelectorAll(`.${XS}`)).toHaveLength(0);
    await openAgent();
    // The kit's own small button writes its size itself (Button.tsx); only what this screen writes is counted.
    const back = screen.getByRole('button', { name: /كل المندوبين/ });
    const left = [...document.body.querySelectorAll(`.${XS}`)].filter((e) => e !== back);
    // The tile's hint is a figure (the value of what he holds); its line was not touched.
    expect(left.map((e) => e.textContent)).toEqual(['40.000 JOD']);
  });
});

describe('the presses and what they ask', () => {
  it('— the screen asks two addresses, GET only, with no body', async () => {
    await drawList();
    await openAgent();
    expect(apiJson.mock.calls).toEqual([['/api/finance/agents'], [`/api/finance/agents?id=${AGENT.id}`]]);
  });

  it('— a row stays shut while an agent’s page is loading (a second press opens nothing twice)', async () => {
    let release!: () => void;
    detailGate = new Promise<void>((r) => (release = r));
    await drawList();
    const row = screen.getByText(AGENT.name).closest('button')!;
    fireEvent.click(row);
    await waitFor(() => expect(row.hasAttribute('disabled')).toBe(true));
    fireEvent.click(row);
    expect(apiJson.mock.calls.filter((c) => String(c[0]).includes('?id='))).toHaveLength(1);
    await act(async () => release());
    await screen.findByText('ما زال بيده');
  });

  it('— the way to the manual collection is there while he owes something, and goes where it went', async () => {
    await drawList();
    await openAgent();
    expect(screen.getByRole('link', { name: /سجّل تحصيلاً يدويّاً/ }).getAttribute('href')).toBe('/ops/tracking');
  });

  it('— and is not there when he owes nothing', async () => {
    owing = [];
    await drawList();
    await openAgent();
    expect(screen.queryByRole('link', { name: /سجّل تحصيلاً يدويّاً/ })).toBeNull();
    expect(screen.queryByText('استلام ما بذمّته')).toBeNull();
  });
});

/*
 * THE FIGURES, FROZEN FROM main (85487c22, 18/11) BEFORE THIS REQUEST. The same fixture rendered by the screen as it was printed
 * exactly these texts, in this order; the way back moved into the header, which carries no digit, so the order is the same too.
 */
describe('the figures did not move', () => {
  const LIST = ['2', '40.000 JOD', '50.000 JOD', '5.000 JOD', 'عليه 45.000 JOD', '1', '20.000 JOD'];
  // On a phone the balance stands beside the name, before the three figures.
  const LIST_PHONE = ['عليه 45.000 JOD', '2', '40.000 JOD', '50.000 JOD', '5.000 JOD', '1', '20.000 JOD'];
  // The same on a desk and on a phone (the dates are left out: they print the hour of the machine’s clock).
  const PAGE = [
    'AGENT-T1', '2', '40.000 JOD', '50.000 JOD', '5.000 JOD', '45.000 JOD', '1', '20.000 JOD', '3.000 JOD',
    '1', 'SY-2026-0002', '40.000 JOD',
    '1', 'SY-2026-0003', '5.000 JOD', '50.000 JOD',
    '1', 'SY-2026-0001', '3.000 JOD', '20.000 JOD',
  ];

  it('— the list, on a desk', async () => {
    await drawList();
    expect(figures()).toEqual(LIST);
  });

  it('— the list, on a phone', async () => {
    phone.value = true;
    await drawList();
    expect(figures()).toEqual(LIST_PHONE);
  });

  it.each([false, true])('— one agent’s page (phone: %s)', async (isPhone) => {
    phone.value = isPhone;
    await drawList();
    await openAgent();
    expect(figures().filter((t) => !t.includes('·'))).toEqual(PAGE);
  });
});

describe('a phone (jsdom: classes, not pixels)', () => {
  it('— no fixed width wider than the phone, and the header’s actions wrap', async () => {
    phone.value = true;
    await drawList();
    await openAgent();
    const wide = [...document.body.querySelectorAll('[class]')]
      .flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/))
      .filter((c) => /^(min-)?w-\[(\d+)px\]$/.test(c) && Number(c.match(/\d+/)![0]) > 375);
    expect(wide).toEqual([]);
    const back = screen.getByRole('button', { name: /كل المندوبين/ });
    expect(back.parentElement!.className).toContain('flex-wrap');
  });
});
