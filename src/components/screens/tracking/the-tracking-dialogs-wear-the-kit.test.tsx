// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE EIGHT TRACKING DIALOGS ON THE KIT (R11d2, 19/11) — AND NOT ONE FIGURE, SENTENCE, CONTROL OR REQUEST MOVED.
 *
 * `Deliver`, `Collect`, `Difference`, `WriteOff`, `Transfer`, `UndoDelivery`, `CloseLegacy`, `ClosePicked` carry the
 * amounts and the collection/difference rules, so they were left out of R11d and moved here on their own: the look only
 * (`Button`, `Card plain`, `Checkbox`, `text-note`), nothing a person does or a server reads.
 *
 * THE DIFFERENTIAL RENDER. Every dialog is drawn with the same fixtures, walked through the same presses, and four things
 * are taken at every step:
 *
 *   text      every word and figure the dialog draws, whitespace folded — as a short print (`textPrint`);
 *   figures   the text of every `<Money>` it draws, in order, written out;
 *   controls  every button, field, list and box: tag, the `type` it carries, its name, whether it is disabled;
 *   requests  every call to the server: the address, the method, the body.
 *
 * `BEFORE` below was RECORDED on `osm/main` (8a683213, before this change) by running this very file with
 * `RECORD_TRACKING_DIALOGS=<path>`, and pasted here — CI has no `osm/main` to render, so the record is kept in the repo.
 * The dialogs after the change must reproduce it exactly. A figure, a sentence, a body, a missing `type` on a button
 * inside a form (the kit sets none: a `Button` without one submits the form) — any of them is a red test here.
 *
 * TO CHANGE ONE ON PURPOSE: change the dialog, record again, paste with a dated comment saying what moved and why.
 */

const { api, fetchApi } = vi.hoisted(() => ({ api: vi.fn(), fetchApi: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => api(...a),
  apiFetch: (...a: unknown[]) => fetchApi(...a),
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true }));

import { DeliverDialog } from './DeliverDialog';
import { CollectDialog } from './CollectDialog';
import { DifferenceDialog } from './DifferenceDialog';
import { WriteOffDialog } from './WriteOffDialog';
import { TransferDialog } from './TransferDialog';
import { UndoDeliveryDialog } from './UndoDeliveryDialog';
import { CloseLegacyDialog } from './CloseLegacyDialog';
import { ClosePickedDialog } from './ClosePickedDialog';

/* ───────────────────────── what is taken at every step ───────────────────────── */

const fold = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

interface Step {
  textPrint: string;
  figures: string[];
  controls: string[];
}

const take = (): Step => {
  const body = document.body;
  const text = fold(body.textContent);
  const figures = [...body.querySelectorAll('span[dir="ltr"]')]
    .filter((s) => s.className.split(/\s+/).includes('whitespace-nowrap'))
    .map((s) => fold(s.textContent));
  const controls = [...body.querySelectorAll('button, input, select, textarea')].map((el) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') ?? '-';
    const named =
      el.getAttribute('aria-label') ??
      (tag === 'button' ? fold(el.textContent) : fold((el as HTMLInputElement).labels?.[0]?.textContent));
    const off = (el as HTMLButtonElement).disabled ? 'off' : 'on';
    return `${tag}|${type}|${named}|${off}`;
  });
  return { textPrint: createHash('sha256').update(text).digest('hex').slice(0, 16), figures, controls };
};

const requests = () => [
  ...api.mock.calls.map((c) => {
    const init = (c[1] ?? {}) as { method?: string; body?: string };
    return `${init.method ?? 'GET'} ${c[0]} ${init.body ?? ''}`;
  }),
  ...fetchApi.mock.calls.map((c) => {
    const init = (c[1] ?? {}) as { method?: string; body?: string };
    return `fetch ${init.method ?? 'GET'} ${c[0]} ${init.body ?? ''}`;
  }),
];

/** What one walk through a dialog produced: a step per moment, then every request it sent. */
interface Walk {
  steps: Record<string, Step>;
  requests: string[];
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const textIs = (s: string) => waitFor(() => expect(document.body.textContent).toContain(s));
const buttonNamed = (re: RegExp) =>
  [...document.body.querySelectorAll('button')].find((b) => re.test(fold(b.textContent))) as HTMLButtonElement;
const change = (el: Element | null | undefined, value: string) => fireEvent.change(el!, { target: { value } });

/* ───────────────────────── the fixtures (invented: no real person, shop or phone) ───────────────────────── */

const ITEMS = [
  { id: 'i1', productName: 'منتج تجريبي أ', quantity: 2, freeQuantity: 1, unitPrice: 10, discountShare: 0 },
  { id: 'i2', productName: 'منتج تجريبي ب', quantity: 1, freeQuantity: 0, unitPrice: 7.5, discountShare: 0 },
];

const MEASURE_UNDO = {
  orderNumber: 'ORD-T-1',
  courier: 'شركة تجريبية',
  allowed: true,
  refusal: null,
  fingerprint: 'f'.repeat(24),
  from: 'DELIVERED',
  to: 'SHIPPED',
  lines: [
    { key: 'STATUS', text: 'حالة الشحن بترجع لـ«مشحون».' },
    { key: 'CUSTOMER', text: 'قيمة مشتريات الزبون بتنقص:', amount: { value: 55.25, currency: 'USD' } },
  ],
  stays: [{ key: 'MONEY', text: 'ما بينكتب ولا قرش.' }],
};

const MEASURE_LEGACY = (age: number) => ({
  age,
  cutoff: '2026-10-29T00:00:00.000Z',
  tooMany: false,
  closeable: {
    count: 12,
    fingerprint: 'a'.repeat(24),
    oldestAt: '2026-10-01T10:00:00.000Z',
    newestAt: '2026-10-25T10:00:00.000Z',
    byCourier: [
      { name: 'شركة أ', count: 7 },
      { name: 'شركة ب', count: 5 },
    ],
    value: [
      { currency: 'USD', amount: 1250.5 },
      { currency: 'SYP', amount: 300000 },
    ],
  },
  options: [
    { age: 1, count: 20 },
    { age: 3, count: 18 },
    { age: 7, count: 15 },
    { age: 14, count: 12 },
    { age: 30, count: 6 },
  ],
  left: { tooRecent: 8, moneyRecorded: 3, onAStatement: 2 },
});

const MEASURE_PICKED = {
  asked: 4,
  closeable: {
    count: 3,
    fingerprint: 'b'.repeat(24),
    oldestAt: '2026-01-05T10:00:00.000Z',
    newestAt: '2026-10-20T10:00:00.000Z',
    byCourier: [{ name: 'شركة أ', count: 3 }],
    value: [{ currency: 'USD', amount: 90.75 }],
    withBarcode: 2,
    recent: 1,
  },
  recentDays: 14,
  left: [{ orderNumber: 'ORD-T-4', why: 'ON_A_STATEMENT', text: 'الطلب ORD-T-4 بكشف ما انعتمد بعد' }],
  leftTotal: 1,
};

const DIFF = {
  matchId: 'm1',
  statementId: 'st1',
  statement: 'ST-T-7',
  ours: 20,
  theirs: 17.5,
  gap: 2.5,
  answered: false,
  resolution: null,
  resolutionKind: null,
  resolutionNote: null,
  claim: null,
  closed: false,
  note: 'أجرة التوصيل 3 بدل 2',
  decisions: null,
  courierWord: { phrase: 'تم التوصيل', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' },
  statementLine: null,
};

/* ───────────────────────── the walks ───────────────────────── */

const WALKS: Record<string, () => Promise<Walk>> = {
  async deliver() {
    api.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (!init) return { order: { items: ITEMS } };
      const b = JSON.parse(init.body!);
      if (b.preview) {
        const goods = b.lines.reduce((s: number, l: { deliveredQty: number }) => s + l.deliveredQty * 10, 0);
        return { preview: { goods, fee: goods ? 3 : 0, collected: goods ? goods + 3 : 0 } };
      }
      return { message: 'تمام' };
    });
    const onDone = vi.fn();
    render(
      <DeliverDialog
        order={{ id: 'o1', orderNumber: 'ORD-T-1', merchantRef: 'MR-1', currency: 'USD', deliveryFee: 3, priceIncludesDelivery: true }}
        onClose={() => {}}
        onDone={onDone}
      />
    );
    const steps: Record<string, Step> = {};
    await textIs('المبلغ الفعليّ');
    await waitFor(() => expect(take().figures).toHaveLength(3));
    await settle();
    steps.opened = take();
    fireEvent.click(buttonNamed(/^رفضه$/));
    await textIs('يُتَمَّم مرتين');
    await textIs('المبلغ الفعليّ');
    await settle();
    steps.partial = take();
    for (const b of [...document.body.querySelectorAll('button')].filter((x) => fold(x.textContent) === 'رفضه')) fireEvent.click(b);
    await textIs('لم يُستلم شيء');
    await settle();
    steps.nothing = take();
    change(document.body.querySelectorAll('input[type="number"]')[0], '2');
    change(document.body.querySelector('input:not([type])'), '  رفض قطعة  ');
    await settle();
    steps.typed = take();
    fireEvent.click(buttonNamed(/تسليم جزئي|تسليم كامل|تسجيل كمرتجع/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async collect() {
    api.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (!init)
        return {
          wallets: [
            { id: 'w1', name: 'صندوق تجريبي', currencyCode: 'USD' },
            { id: 'w2', name: 'صندوق آخر', currencyCode: 'SYP' },
          ],
        };
      return { message: 'تمام' };
    });
    const onDone = vi.fn();
    const row = (id: string, expected: number) => ({
      id,
      orderNumber: `ORD-${id}`,
      totalAmount: 40,
      currency: 'USD',
      deliveryFee: 3,
      expectedCollection: expected,
      customer: { fullName: 'زبون تجريبي' },
      // 23/11 (F9): was courier «مندوب تجريبي». A courier's orders now open «تسليم مندوب» (its own test:
      // the-handover-panel); this walk is the old hand form, which is now the door for orders with NO courier.
      deliveryProvider: null,
    });
    render(<CollectDialog orders={[row('a', 37.5), row('b', 20.25)]} onClose={() => {}} onDone={onDone} />);
    const steps: Record<string, Step> = {};
    await textIs('صندوق تجريبي');
    await settle();
    steps.opened = take();
    change(document.body.querySelector('input[type="number"]'), '50');
    change(document.body.querySelector('input[required]:not([type])'), 'استلمت نقداً');
    await textIs('فارق');
    steps.typed = take();
    fireEvent.click(buttonNamed(/استلمت منه/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async difference() {
    api.mockResolvedValue({ notes: [] });
    const steps: Record<string, Step> = {};
    const order = { id: 'o1', orderNumber: 'ORD-T-1', merchantRef: null, currency: 'USD' };
    const one = async (name: string, d: object, mayDecide: boolean) => {
      render(<DifferenceDialog order={{ ...order, difference: { ...DIFF, ...d } as never }} mayDecide={mayDecide} onClose={() => {}} onDone={() => {}} />);
      await textIs('ST-T-7');
      await settle();
      steps[name] = take();
      cleanup();
    };
    await one('decider', {}, true);
    await one('looker', {}, false);
    await one('closed', { closed: true, answered: true, resolution: 'ACCEPTED_COURIER', resolutionNote: 'سبب مكتوب' }, true);
    await one('noFigure', { theirs: null, gap: null }, true);
    return { steps, requests: [] };
  },

  async writeOff() {
    api.mockResolvedValue({ message: 'تمام' });
    const onDone = vi.fn();
    render(
      <WriteOffDialog
        order={{
          id: 'o1',
          orderNumber: 'ORD-T-1',
          merchantRef: null,
          trackingNumber: 'TRK-T-1',
          totalAmount: 63.5,
          currency: 'USD',
          daysInTransit: 21,
          deliveryProvider: { name: 'شركة تجريبية' },
        }}
        onClose={() => {}}
        onDone={onDone}
      />
    );
    const steps: Record<string, Step> = {};
    await settle();
    steps.opened = take();
    change(document.body.querySelector('textarea'), '  الشركة أقرّت بفقدانها  ');
    await settle();
    steps.typed = take();
    fireEvent.click(buttonNamed(/أغلقه كخسارة/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async transfer() {
    api.mockResolvedValue({
      providers: [
        { id: 'p1', name: 'شركة حالية', kind: 'COMPANY' },
        { id: 'p2', name: 'شركة تانية', kind: 'COMPANY' },
        { id: 'p3', name: 'مندوب تجريبي', kind: 'AGENT' },
      ],
    });
    fetchApi.mockResolvedValue({ ok: true, json: async () => ({ message: 'تمام' }) });
    const steps: Record<string, Step> = {};
    render(
      <TransferDialog
        order={{ id: 'o9', orderNumber: 'ORD-T-9', merchantRef: null, deliveryProvider: { id: 'p3', name: 'مندوب تجريبي', kind: 'AGENT' } }}
        onClose={() => {}}
        onDone={() => {}}
      />
    );
    await textIs('شركة تانية');
    steps.fromAgent = take();
    cleanup();
    const onDone = vi.fn();
    render(
      <TransferDialog
        order={{ id: 'o1', orderNumber: 'ORD-T-1', merchantRef: 'MR-1', deliveryProvider: { id: 'p1', name: 'شركة حالية', kind: 'COMPANY' } }}
        onClose={() => {}}
        onDone={onDone}
      />
    );
    await textIs('شركة تانية');
    steps.opened = take();
    change(document.body.querySelector('select'), 'p3');
    change(document.body.querySelector('input'), '  سبب تجريبي  ');
    await textIs('ستذهب إلى');
    steps.typed = take();
    fireEvent.click(buttonNamed(/^تحويل الشحنة$/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async undo() {
    api.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const b = JSON.parse(init?.body ?? '{}');
      if (b.action === 'undo') return { message: 'تمام' };
      return b.orderId === 'refused'
        ? { ...MEASURE_UNDO, allowed: false, refusal: { code: 'MONEY_RECORDED', text: 'انسوّى حسابو' }, fingerprint: null, to: null, lines: [], stays: [] }
        : MEASURE_UNDO;
    });
    const steps: Record<string, Step> = {};
    render(<UndoDeliveryDialog order={{ id: 'refused', orderNumber: 'ORD-T-2', merchantRef: null }} onClose={() => {}} onDone={() => {}} />);
    await textIs('انسوّى حسابو');
    steps.refused = take();
    cleanup();
    const onDone = vi.fn();
    render(<UndoDeliveryDialog order={{ id: 'o1', orderNumber: 'ORD-T-1', merchantRef: 'MR-1' }} onClose={() => {}} onDone={onDone} />);
    await textIs('اللي رح يرجع:');
    steps.opened = take();
    change(document.body.querySelector('textarea'), '  انسجّل بالغلط  ');
    fireEvent.click(document.body.querySelector('input[type="checkbox"]')!);
    await settle();
    steps.ready = take();
    fireEvent.click(buttonNamed(/^تراجع عن التسليم$/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async closeLegacy() {
    api.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { message: 'تمام' };
      return MEASURE_LEGACY(Number(new URL(url, 'http://x').searchParams.get('age')));
    });
    const onDone = vi.fn();
    render(<CloseLegacyDialog onClose={() => {}} onDone={onDone} />);
    const steps: Record<string, Step> = {};
    await textIs('طلب رح ينقفل كمحصَّل');
    await settle();
    steps.opened = take();
    fireEvent.click(document.body.querySelector('input[type="checkbox"]')!);
    await settle();
    steps.ticked = take();
    fireEvent.click(buttonNamed(/^أقفل \d+ طلب$/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },

  async closePicked() {
    api.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const b = JSON.parse(init?.body ?? '{}');
      return b.action === 'close' ? { message: 'تمام' } : MEASURE_PICKED;
    });
    const onDone = vi.fn();
    render(<ClosePickedDialog orders={[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]} onClose={() => {}} onDone={onDone} />);
    const steps: Record<string, Step> = {};
    await textIs('طلب رح ينقفل كمحصَّل');
    await settle();
    steps.opened = take();
    fireEvent.click(document.body.querySelector('input[type="checkbox"]')!);
    await settle();
    steps.ticked = take();
    fireEvent.click(buttonNamed(/^أقفل \d+ طلب$/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    return { steps, requests: requests() };
  },
};

/* ───────────────────────── the record from osm/main ───────────────────────── */

// BEFORE:START
// Recorded on osm/main 8a683213 (19/11), before R11d2 touched the eight dialogs.
// 23/11 (F9): «collect» re-recorded on purpose — the walk is now an order with NO courier (a courier's orders open «تسليم
// مندوب»), the hint sentence says so (both textPrints moved), and the wallets are asked with ?scope=collect (this country's
// active ones). Its figures, controls and the POST body are unchanged.
const BEFORE: Record<string, Walk> = {
  "deliver": {
    "steps": {
      "opened": {
        "textPrint": "a3e9ac49b976cfb1",
        "figures": [
          "40.00 USD",
          "3.00 USD",
          "43.00 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|button|رفضه|on",
          "input|number||on",
          "button|button|رفضه|on",
          "input|number||on",
          "input|-|ملاحظة داخلية على الطلبتُضاف باسمك إلى ملاحظات الطلب، ويقرؤها التأكيد والمرتجعات.|on",
          "button|button|إلغاء|on",
          "button|submit|تسليم كامل|on"
        ]
      },
      "partial": {
        "textPrint": "2c85d2244bfb9ffd",
        "figures": [
          "10.00 USD",
          "3.00 USD",
          "13.00 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|button|رفضه|on",
          "input|number||on",
          "button|button|رفضه|on",
          "input|number||on",
          "input|-|ملاحظة داخلية على الطلبتُضاف باسمك إلى ملاحظات الطلب، ويقرؤها التأكيد والمرتجعات.|on",
          "button|button|إلغاء|on",
          "button|submit|تسليم جزئي|on"
        ]
      },
      "nothing": {
        "textPrint": "de440786eb9089a4",
        "figures": [
          "0.00 USD",
          "0.00 USD",
          "0.00 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|button|رفضه|on",
          "input|number||on",
          "button|button|رفضه|on",
          "input|number||on",
          "input|-|ملاحظة داخلية على الطلبتُضاف باسمك إلى ملاحظات الطلب، ويقرؤها التأكيد والمرتجعات.|on",
          "button|button|إلغاء|on",
          "button|submit|تسجيل كمرتجع|on"
        ]
      },
      "typed": {
        "textPrint": "c0abf1b49ee42176",
        "figures": [
          "20.00 USD",
          "3.00 USD",
          "23.00 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|button|رفضه|on",
          "input|number||on",
          "button|button|رفضه|on",
          "input|number||on",
          "input|-|ملاحظة داخلية على الطلبتُضاف باسمك إلى ملاحظات الطلب، ويقرؤها التأكيد والمرتجعات.|on",
          "button|button|إلغاء|on",
          "button|submit|تسليم جزئي|on"
        ]
      }
    },
    "requests": [
      "GET /api/orders/o1 ",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":3},{\"itemId\":\"i2\",\"deliveredQty\":1}],\"preview\":true}",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":0},{\"itemId\":\"i2\",\"deliveredQty\":1}],\"preview\":true}",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":0},{\"itemId\":\"i2\",\"deliveredQty\":1}],\"preview\":true}",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":0},{\"itemId\":\"i2\",\"deliveredQty\":0}],\"preview\":true}",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":2},{\"itemId\":\"i2\",\"deliveredQty\":0}],\"preview\":true}",
      "POST /api/ops/tracking/deliver {\"orderId\":\"o1\",\"lines\":[{\"itemId\":\"i1\",\"deliveredQty\":2},{\"itemId\":\"i2\",\"deliveredQty\":0}],\"note\":\"رفض قطعة\"}"
    ]
  },
  "collect": {
    "steps": {
      "opened": {
        "textPrint": "4477b68bc1ade0b2",
        "figures": [
          "57.75 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|المحفظة التي دخل إليها المبلغ|on",
          "input|number|المبلغ المستلم فعلياً (اتركه فارغاً إن كان مطابقاً)|on",
          "input|-|الملاحظة (إلزامية)|on",
          "button|button|إلغاء|on",
          "button|submit|استلمت منه|on"
        ]
      },
      "typed": {
        "textPrint": "de7b02c284b10ab2",
        "figures": [
          "57.75 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|المحفظة التي دخل إليها المبلغ|on",
          "input|number|المبلغ المستلم فعلياً (اتركه فارغاً إن كان مطابقاً)|on",
          "input|-|الملاحظة (إلزامية)|on",
          "button|button|إلغاء|on",
          "button|submit|استلمت منه|on"
        ]
      }
    },
    "requests": [
      "GET /api/finance/wallets?scope=collect ",
      "POST /api/ops/tracking/collect {\"orderIds\":[\"a\",\"b\"],\"walletId\":\"w1\",\"amount\":50,\"note\":\"استلمت نقداً\"}"
    ]
  },
  "difference": {
    "steps": {
      "decider": {
        "textPrint": "b9210e147a17a24e",
        "figures": [
          "20.00 USD",
          "17.50 USD",
          "2.50 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "input|text|تفسير القرار|on",
          "button|button|اعتُمد رقم الشركة|on",
          "button|button|رقمنا هو المعتمد|on",
          "button|button|طلب تبديل|on",
          "button|button|قيد المراجعة|on",
          "button|button|التعليقات الداخلية|on",
          "button|-|رجوع|on"
        ]
      },
      "looker": {
        "textPrint": "8142c9c55ffacebf",
        "figures": [
          "20.00 USD",
          "17.50 USD",
          "2.50 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|-|رجوع|on"
        ]
      },
      "closed": {
        "textPrint": "e7ba21dc1c314fd4",
        "figures": [
          "20.00 USD",
          "17.50 USD",
          "2.50 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "button|button|التعليقات الداخلية|on",
          "button|-|رجوع|on"
        ]
      },
      "noFigure": {
        "textPrint": "ed979069ae4a365d",
        "figures": [
          "20.00 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "input|text|تفسير القرار|on",
          "button|button|اعتُمد رقم الشركة|on",
          "button|button|رقمنا هو المعتمد|on",
          "button|button|طلب تبديل|on",
          "button|button|قيد المراجعة|on",
          "button|button|التعليقات الداخلية|on",
          "button|-|رجوع|on"
        ]
      }
    },
    "requests": []
  },
  "writeOff": {
    "steps": {
      "opened": {
        "textPrint": "1b0e509daaa0d15e",
        "figures": [
          "63.50 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "textarea|-|سبب الخسارة *|on",
          "button|button|إلغاء|on",
          "button|submit|أغلقه كخسارة|off"
        ]
      },
      "typed": {
        "textPrint": "e56d3d9e09247406",
        "figures": [
          "63.50 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "textarea|-|سبب الخسارة *|on",
          "button|button|إلغاء|on",
          "button|submit|أغلقه كخسارة|on"
        ]
      }
    },
    "requests": [
      "POST /api/ops/tracking/write-off {\"orderId\":\"o1\",\"reason\":\"الشركة أقرّت بفقدانها\"}"
    ]
  },
  "transfer": {
    "steps": {
      "fromAgent": {
        "textPrint": "647760f6aee0bfde",
        "figures": [],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|الجهة الجديدة|on",
          "input|-|ملاحظة (اختيارية)|on",
          "button|button|إلغاء|on",
          "button|submit|استلام وتحويل|off"
        ]
      },
      "opened": {
        "textPrint": "00944cadb570e13b",
        "figures": [],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|الجهة الجديدة|on",
          "input|-|ملاحظة (اختيارية)|on",
          "button|button|إلغاء|on",
          "button|submit|تحويل الشحنة|off"
        ]
      },
      "typed": {
        "textPrint": "5462d02845bd5322",
        "figures": [],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|الجهة الجديدة|on",
          "input|-|ملاحظة (اختيارية)|on",
          "button|button|إلغاء|on",
          "button|submit|تحويل الشحنة|on"
        ]
      }
    },
    "requests": [
      "GET /api/ops/references ",
      "GET /api/ops/references ",
      "fetch POST /api/ops/tracking/transfer {\"orderId\":\"o1\",\"toProviderId\":\"p3\",\"note\":\"سبب تجريبي\"}"
    ]
  },
  "undo": {
    "steps": {
      "refused": {
        "textPrint": "679cefbb778e3bf1",
        "figures": [],
        "controls": [
          "button|-|إغلاق|on",
          "button|-|تراجع عن التسليم|off",
          "button|-|إلغاء|on"
        ]
      },
      "opened": {
        "textPrint": "d8fc77e7597bb89e",
        "figures": [
          "55.25 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "textarea|-|سبب التراجع *|on",
          "input|checkbox|أقرّ: التراجع بيغيّر حالة الطلب وسجل الزبون وعمولتو، وبيتسجّل باسمي.|on",
          "button|-|تراجع عن التسليم|off",
          "button|-|إلغاء|on"
        ]
      },
      "ready": {
        "textPrint": "67a5e6fef605f047",
        "figures": [
          "55.25 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "textarea|-|سبب التراجع *|on",
          "input|checkbox|أقرّ: التراجع بيغيّر حالة الطلب وسجل الزبون وعمولتو، وبيتسجّل باسمي.|on",
          "button|-|تراجع عن التسليم|on",
          "button|-|إلغاء|on"
        ]
      }
    },
    "requests": [
      "POST /api/ops/tracking/undo-delivery {\"action\":\"measure\",\"orderId\":\"refused\"}",
      "POST /api/ops/tracking/undo-delivery {\"action\":\"measure\",\"orderId\":\"o1\"}",
      "POST /api/ops/tracking/undo-delivery {\"action\":\"undo\",\"orderId\":\"o1\",\"reason\":\"انسجّل بالغلط\",\"fingerprint\":\"ffffffffffffffffffffffff\",\"acknowledged\":true}"
    ]
  },
  "closeLegacy": {
    "steps": {
      "opened": {
        "textPrint": "f34ebae34fd9725d",
        "figures": [
          "1,250.50 USD",
          "300,000.00 SYP"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|اقفل اللي أقدم من|on",
          "input|checkbox|أقرّ: القفل بلا حركة مصاري، وما بيرجع من الشاشة.|on",
          "button|-|أقفل 12 طلب|off",
          "button|-|إلغاء|on"
        ]
      },
      "ticked": {
        "textPrint": "f34ebae34fd9725d",
        "figures": [
          "1,250.50 USD",
          "300,000.00 SYP"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "select|-|اقفل اللي أقدم من|on",
          "input|checkbox|أقرّ: القفل بلا حركة مصاري، وما بيرجع من الشاشة.|on",
          "button|-|أقفل 12 طلب|on",
          "button|-|إلغاء|on"
        ]
      }
    },
    "requests": [
      "GET /api/ops/tracking/close-legacy?age=14 ",
      "POST /api/ops/tracking/close-legacy {\"age\":14,\"fingerprint\":\"aaaaaaaaaaaaaaaaaaaaaaaa\",\"count\":12,\"acknowledged\":true}"
    ]
  },
  "closePicked": {
    "steps": {
      "opened": {
        "textPrint": "647664650e57365d",
        "figures": [
          "90.75 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "input|checkbox|أقرّ: القفل بلا حركة مصاري وما بيرجع من الشاشة، وإنو 1 منها حديثة وبقفلها بحكمي.|on",
          "button|-|أقفل 3 طلب|off",
          "button|-|إلغاء|on"
        ]
      },
      "ticked": {
        "textPrint": "647664650e57365d",
        "figures": [
          "90.75 USD"
        ],
        "controls": [
          "button|-|إغلاق|on",
          "input|checkbox|أقرّ: القفل بلا حركة مصاري وما بيرجع من الشاشة، وإنو 1 منها حديثة وبقفلها بحكمي.|on",
          "button|-|أقفل 3 طلب|on",
          "button|-|إلغاء|on"
        ]
      }
    },
    "requests": [
      "POST /api/ops/tracking/close-legacy/picked {\"action\":\"measure\",\"orderIds\":[\"a\",\"b\",\"c\",\"d\"]}",
      "POST /api/ops/tracking/close-legacy/picked {\"action\":\"close\",\"orderIds\":[\"a\",\"b\",\"c\",\"d\"],\"fingerprint\":\"bbbbbbbbbbbbbbbbbbbbbbbb\",\"count\":3,\"acknowledged\":true}"
    ]
  }
};
// BEFORE:END

beforeEach(() => {
  vi.clearAllMocks();
  api.mockReset();
  fetchApi.mockReset();
});
afterEach(() => cleanup());

const RECORD = process.env.RECORD_TRACKING_DIALOGS;
const recorded: Record<string, Walk> = {};

describe('the differential render: each dialog draws, offers and sends exactly what it did on osm/main', () => {
  for (const [name, walk] of Object.entries(WALKS)) {
    it(`«${name}»: the same words, figures, controls and requests`, async () => {
      const got = await walk();
      if (RECORD) {
        recorded[name] = got;
        writeFileSync(RECORD, JSON.stringify(recorded, null, 2));
        return;
      }
      const before = BEFORE[name];
      expect(before, `no record for ${name}`).toBeTruthy();
      expect(Object.keys(got.steps)).toEqual(Object.keys(before.steps));
      for (const step of Object.keys(before.steps)) {
        expect(got.steps[step].figures, `${name} · ${step} · figures`).toEqual(before.steps[step].figures);
        expect(got.steps[step].controls, `${name} · ${step} · controls`).toEqual(before.steps[step].controls);
        expect(got.steps[step].textPrint, `${name} · ${step} · words: ${fold(document.body.textContent)}`).toBe(
          before.steps[step].textPrint
        );
      }
      expect(got.requests, `${name} · requests`).toEqual(before.requests);
    });
  }
});

/* ───────────────────────── the look ───────────────────────── */

const DIR = join(process.cwd(), 'src/components/screens/tracking');
const FILES = ['DeliverDialog', 'CollectDialog', 'DifferenceDialog', 'WriteOffDialog', 'TransferDialog', 'UndoDeliveryDialog', 'CloseLegacyDialog', 'ClosePickedDialog'];
const source = (f: string) => readFileSync(join(DIR, `${f}.tsx`), 'utf8');

describe('the look is the kit', () => {
  it('every kit button inside a form says what it is — a `Button` with no `type` submits the form', () => {
    for (const f of ['DeliverDialog', 'CollectDialog', 'WriteOffDialog', 'TransferDialog']) {
      const src = source(f);
      expect(src, f).toContain('<form');
      const tags = [...src.matchAll(/<Button\b[^>]*>/g)].map((m) => m[0]);
      expect(tags.length, `${f} draws the kit's buttons`).toBeGreaterThanOrEqual(2);
      for (const t of tags) expect(t, `${f}: ${t}`).toMatch(/\btype="(button|submit)"/);
    }
  });

  // 19/11 (R19a): was «green to record» with DeliverDialog/CollectDialog on the old green alias; R19a renamed every
  // legacy button name outside the storefront owner's files, so the two record presses now wear the main colour.
  it('each submit keeps its colour: the main colour to record and to move, red for the loss nobody can undo', () => {
    const want: Record<string, string> = { DeliverDialog: 'primary', CollectDialog: 'primary', WriteOffDialog: 'danger', TransferDialog: 'primary' };
    for (const [f, variant] of Object.entries(want)) {
      const submit = [...source(f).matchAll(/<Button\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes('type="submit"'));
      expect(submit, `${f} has a kit submit`).toBeTruthy();
      expect(submit, f).toContain(`variant="${variant}"`);
    }
  });

  it('only the one press named here stays a raw button: «رفضه», a per-line toggle whose colour is its state', () => {
    const raw = FILES.flatMap((f) => [...source(f).matchAll(/<button\b/g)].map(() => f));
    expect(raw).toEqual(['DeliverDialog']);
  });

  it('the three acknowledgements are the kit’s `Checkbox`, each with its own id', () => {
    const ids = new Set<string>();
    for (const f of ['UndoDeliveryDialog', 'CloseLegacyDialog', 'ClosePickedDialog']) {
      const src = source(f);
      expect(src, f).not.toMatch(/<input\b/);
      const id = src.match(/<Checkbox\b[^>]*?\bid="([^"]+)"/)?.[1];
      expect(id, `${f} has an id`).toBeTruthy();
      ids.add(id!);
    }
    expect(ids.size).toBe(3);
  });

  it('on a 375px phone nothing is wider than the screen: no fixed width beyond it in any of the eight', () => {
    for (const f of FILES) {
      const classes = [...source(f).matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
      const wide = classes.filter((c) => /^(min-)?w-\[(\d+)px\]$/.test(c) && Number(c.match(/\d+/)![0]) > 375);
      expect(wide, f).toEqual([]);
      expect(classes.filter((c) => /^(w|min-w)-(96|screen)$/.test(c)), f).toEqual([]);
    }
  });
});
