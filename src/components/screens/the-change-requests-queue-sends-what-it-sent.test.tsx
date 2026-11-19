// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلبات التعديل» ON THE KIT SENDS, BYTE FOR BYTE, WHAT IT SENT (R16e, 18/11)
 *
 * The queue carries out decisions on orders: an edit written through the order's own money path, a cancellation that
 * returns goods to the shelf, a postponement, a message to the courier, a replacement order. Moving it onto the kit
 * (`PageShell`, `Segmented`, `Button`, `Card`) must not change ONE request, ONE question asked before a press, or ONE
 * word or figure on a card. So the screen as it stood on main — a frozen copy beside this file,
 * `ChangeRequestsScreen.as-on-main.test.tsx` — and the live screen are driven through the SAME scripted presses against
 * the same fake doors, and the log each one leaves must be the same list:
 *
 *   every call to the server (which door, the method, the URL, the body exactly as the string that leaves the browser),
 *   every question asked before a press (its title, its body with the before ← after figures, its button, its tone),
 *   every message after one, and the screen's whole text at the moments the script reads it.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Answer = { ok: boolean; body: unknown };
const h = vi.hoisted(() => ({
  log: [] as string[],
  pending: [] as unknown[],
  awaiting: [] as unknown[],
  previews: {} as Record<string, unknown>,
  fetchAnswers: [] as Answer[],
  confirmAnswers: [] as boolean[],
  askAnswer: null as string | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string, init?: { method?: string; body?: string }) => {
    h.log.push(`apiJson ${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
    if (url.includes('status=PENDING')) return { requests: h.pending, dialCode: '+963' };
    if (url.includes('status=AWAITING_APPLY')) return { requests: h.awaiting };
    const preview = Object.entries(h.previews).find(([id]) => url === `/api/control/change-requests/${id}/preview`);
    if (preview) return preview[1];
    return { requests: [], request: {} };
  },
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    h.log.push(`apiFetch ${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
    const a = h.fetchAnswers.shift() ?? { ok: true, body: {} };
    return { ok: a.ok, json: async () => a.body };
  },
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/control/change-requests' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    failed: (m: string) => h.log.push(`toast.failed ${m}`),
    done: (m: string) => h.log.push(`toast.done ${m}`),
  }),
}));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => async (o: unknown) => {
    h.log.push(`confirm ${JSON.stringify(o)}`);
    return h.confirmAnswers.length ? h.confirmAnswers.shift()! : true;
  },
  useAsk: () => async (o: unknown) => {
    h.log.push(`ask ${JSON.stringify(o)}`);
    return h.askAnswer;
  },
  useTell: () => async (o: unknown) => {
    h.log.push(`tell ${JSON.stringify(o)}`);
  },
}));

import { ChangeRequestsScreen as Live } from './ChangeRequestsScreen';
import { ChangeRequestsScreen as OnMain } from './ChangeRequestsScreen.as-on-main.test';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  reason: 'الزبون طلب تعديل',
  status: 'APPROVED',
  blocking: false,
  changedDuringReview: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  slaDueAt: null,
  overdue: false,
  decisionNote: null,
  requestedByName: 'موظفة تجربة',
  requestedRole: 'CONFIRMATION_AGENT',
  isMine: false,
  intent: 'EDIT',
  postponeUntil: null,
  cancelReason: null,
  carryOut: { kind: 'EDIT_ORDER' },
  changes: { customerName: { from: 'اسم قديم', to: 'اسم جديد' }, deliveryFee: { from: 2.5, to: 3 } },
  order: {
    id: 'o1',
    orderNumber: 'TST-0001',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'PACKING',
    version: 4,
    customer: { fullName: 'زبون تجربة', phone: '0900000000' },
  },
  ...over,
});

const LINES = {
  v: 2,
  edits: [
    {
      lineId: 'l1',
      productId: { from: 'prod-test-0001', to: 'prod-test-0001' },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    },
  ],
  snapshot: { orderVersion: 4, minorUnit: 3, before: { cod: 48.5 }, after: { cod: 72.5 } },
};
const preview = {
  requestId: 'cr-l',
  stale: false,
  lines: [],
  before: { subtotal: 46, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 48.5, giftUnits: 0 },
  after: { subtotal: 70, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 72.5, giftUnits: 0 },
  stock: [],
  problems: [],
  blocked: false,
  drift: { known: true, moved: false, items: [] },
  door: 'REQUEST',
  orderVersion: 4,
  minorUnit: 3,
};

/** A half of the queue, by its name: the old strip's button or the kit's radio. */
const half = (name: RegExp) => screen.queryByRole('radio', { name }) ?? screen.getByRole('button', { name });
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
/** The words on the screen, read into the log. */
const snap = (label: string) => h.log.push(`text@${label} ${document.body.textContent}`);

interface Script {
  name: string;
  pending?: unknown[];
  awaiting?: unknown[];
  previews?: Record<string, unknown>;
  fetchAnswers?: Answer[];
  confirmAnswers?: boolean[];
  askAnswer?: string | null;
  /** Reads and opens only: nothing is written and nothing is asked. */
  quiet?: true;
  run: () => Promise<void>;
}

const SCRIPTS: Script[] = [
  {
    name: 'the pending half: a colleague’s request opens the review; every chip and line is drawn',
    pending: [row({ status: 'PENDING', blocking: true, overdue: true, changedDuringReview: true })],
    quiet: true,
    run: async () => {
      await screen.findByText('مراجعة واتخاذ القرار');
      snap('pending');
      await press(screen.getByRole('button', { name: 'مراجعة واتخاذ القرار' }));
      await settle();
      snap('review-open');
    },
  },
  {
    name: 'her own pending request: «اسحب طلبي», asked, then DELETE',
    pending: [row({ status: 'PENDING', isMine: true })],
    run: async () => {
      await press(await screen.findByRole('button', { name: /اسحب طلبي/ }));
      await settle();
      snap('after-withdraw');
    },
  },
  {
    name: 'a withdrawal she declines sends nothing',
    pending: [row({ status: 'PENDING', isMine: true })],
    confirmAnswers: [false],
    run: async () => {
      await press(await screen.findByRole('button', { name: /اسحب طلبي/ }));
      await settle();
    },
  },
  {
    name: 'an approved edit: the question carries every field before ← after, then the order PATCH',
    awaiting: [row({ decisionNote: 'موافق' })],
    run: async () => {
      await screen.findByText('TST-0001');
      snap('approved-edit');
      await press(await screen.findByRole('button', { name: 'طبّق التعديل على الطلب' }));
      await settle();
    },
  },
  {
    name: 'an approved edit the courier must hear about: the dialog, the copy, «أبلغتُهم», the PATCH with the word',
    awaiting: [row()],
    fetchAnswers: [
      { ok: false, body: { code: 'COURIER_ACTION_REQUIRED', action: 'CONTACT_CHANGE', errorAr: 'الطرد عند الشركة', message: 'رسالة جاهزة' } },
    ],
    run: async () => {
      await press(await screen.findByRole('button', { name: 'طبّق التعديل على الطلب' }));
      await settle();
      await press(await screen.findByRole('button', { name: /انسخ الرسالة/ }));
      await settle();
      await press(screen.getByRole('button', { name: /أبلغتُهم — طبّق التعديل الآن/ }));
      await settle();
    },
  },
  {
    name: 'a cancelled waybill: the replacement order door, then the toast with its number',
    awaiting: [row()],
    fetchAnswers: [
      { ok: false, body: { code: 'COURIER_ACTION_REQUIRED', action: 'CANCEL_AND_REORDER', errorAr: 'الطرد عند الشركة', message: 'رسالة' } },
      { ok: true, body: { replacement: { orderNumber: 'TST-0002' } } },
    ],
    run: async () => {
      await press(await screen.findByRole('button', { name: 'طبّق التعديل على الطلب' }));
      await settle();
      await press(await screen.findByRole('button', { name: /انسخ الرسالة/ }));
      await settle();
      await press(screen.getByRole('button', { name: /أبلغتُهم — ألغِ البوليصة/ }));
      await settle();
    },
  },
  {
    name: 'a cancellation with its reason: the stand-down door with the id alone',
    awaiting: [row({ intent: 'CANCEL', cancelReason: 'CUSTOMER_CHANGED_MIND', carryOut: { kind: 'CANCEL_ORDER' }, changes: {} })],
    run: async () => {
      snap('cancel');
      await press(await screen.findByRole('button', { name: 'ألغِ الطلب' }));
      await settle();
    },
  },
  {
    name: 'a packed parcel: the stand-down asks for the word, and the same press is repeated with it',
    awaiting: [row({ intent: 'CANCEL', cancelReason: 'CUSTOMER_CHANGED_MIND', carryOut: { kind: 'CANCEL_ORDER' }, changes: {} })],
    fetchAnswers: [{ ok: false, body: { code: 'ATTESTATION_REQUIRED', attestation: 'الطرد بين يديّ' } }],
    run: async () => {
      await press(await screen.findByRole('button', { name: 'ألغِ الطلب' }));
      await settle();
    },
  },
  {
    name: 'an old cancellation without its reason: the pick, then the stand-down with the picked reason',
    awaiting: [row({ intent: 'CANCEL', cancelReason: null, carryOut: { kind: 'CANCEL_ORDER' }, changes: {} })],
    run: async () => {
      const shut = (await screen.findByRole('button', { name: 'ألغِ الطلب' })) as HTMLButtonElement;
      h.log.push(`shut-before-pick ${shut.disabled}`);
      await act(async () => {
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CUSTOMER_CHANGED_MIND' } });
      });
      await press(screen.getByRole('button', { name: 'ألغِ الطلب' }));
      await settle();
    },
  },
  {
    name: 'a postponement: the hold door',
    awaiting: [row({ intent: 'POSTPONE', postponeUntil: '2026-11-25T00:00:00.000Z', carryOut: { kind: 'HOLD_SHIPMENT' }, changes: {} })],
    run: async () => {
      snap('postpone');
      await press(await screen.findByRole('button', { name: 'أجّل الشحن' }));
      await settle();
    },
  },
  {
    name: 'a cancellation the courier holds: a message, then «done» through the stand-down',
    awaiting: [row({ intent: 'CANCEL', cancelReason: 'CUSTOMER_CHANGED_MIND', carryOut: { kind: 'CANCEL_VIA_COURIER' }, changes: {} })],
    fetchAnswers: [{ ok: false, body: { code: 'COURIER_ACTION_REQUIRED', action: 'CANCEL_WAYBILL', errorAr: 'عند الشركة', message: 'أوقفوا الطرد' } }],
    run: async () => {
      await press(await screen.findByRole('button', { name: 'أبلغ شركة الشحن بالإلغاء' }));
      await settle();
      await press(await screen.findByRole('button', { name: /انسخ الرسالة/ }));
      await settle();
      await press(screen.getByRole('button', { name: /أبلغتُهم — علّم الطلب منفَّذاً/ }));
      await settle();
    },
  },
  {
    name: '«تراجع عن الموافقة»: the written reason, then REVOKED',
    awaiting: [row()],
    askAnswer: 'وافقت بالغلط',
    run: async () => {
      await press(await screen.findByRole('button', { name: /تراجع عن الموافقة/ }));
      await settle();
    },
  },
  {
    name: 'a refused carry-out: shut, with its reason, and a press sends nothing',
    awaiting: [row({ carryOut: { kind: 'REFUSED', reason: 'الدفعة مفتوحة' } })],
    quiet: true,
    run: async () => {
      const carry = (await screen.findByRole('button', { name: 'نفِّذ القرار' })) as HTMLButtonElement;
      h.log.push(`shut ${carry.disabled} ${carry.title}`);
      snap('refused');
      await press(carry);
      await settle();
    },
  },
  {
    name: 'a lines request: its sentences, the check, then the PATCH with the id and the version',
    awaiting: [row({ id: 'cr-l', changes: { lines: LINES }, lineNames: { 'prod-test-0001': 'منتج تجربة' } })],
    previews: { 'cr-l': preview },
    run: async () => {
      const carry = (await screen.findByRole('button', { name: 'طبّق التعديل على الطلب' })) as HTMLButtonElement;
      await waitFor(() => expect(carry.disabled).toBe(false));
      snap('lines');
      await press(carry);
      await settle();
    },
  },
  {
    name: 'the halves: opens on the full one, the empty one points back, and the press goes there',
    pending: [],
    awaiting: [row({ isMine: true })],
    quiet: true,
    run: async () => {
      await screen.findByText('TST-0001');
      snap('opened');
      await press(half(/بانتظار القرار/));
      snap('empty-half');
      await press(screen.getByRole('button', { name: /افتح «بانتظار التطبيق» — فيه 1 طلب/ }));
      snap('back');
    },
  },
];

async function drive(Screen: React.ComponentType, s: Script): Promise<string[]> {
  h.log = [];
  h.pending = s.pending ?? [];
  h.awaiting = s.awaiting ?? [];
  h.previews = s.previews ?? {};
  h.fetchAnswers = [...(s.fetchAnswers ?? [])];
  h.confirmAnswers = [...(s.confirmAnswers ?? [])];
  h.askAnswer = s.askAnswer ?? null;
  render(<Screen />);
  await settle();
  await s.run();
  await settle();
  const log = h.log;
  cleanup();
  return log;
}

beforeEach(() => {
  h.log = [];
});
afterEach(cleanup);

describe('«طلبات التعديل» on the kit sends what it sent', () => {
  for (const s of SCRIPTS) {
    it(s.name, async () => {
      const before = await drive(OnMain, s);
      const after = await drive(Live, s);
      // The script did something: at least one load, and (for every script that presses) a write or a question.
      expect(before.length).toBeGreaterThan(2);
      if (!s.quiet) expect(before.some((l) => !l.startsWith('apiJson GET') && !l.startsWith('text@') && !l.startsWith('shut'))).toBe(true);
      expect(after).toEqual(before);
    });
  }

  it('NEGATIVE: the comparison is not blind — a different answer from the door changes the log', async () => {
    const s = SCRIPTS.find((x) => x.name.startsWith('an approved edit:'))!;
    const before = await drive(OnMain, s);
    const after = await drive(Live, { ...s, awaiting: [row({ order: { ...row().order, version: 5 } })] });
    expect(after).not.toEqual(before);
  });
});
