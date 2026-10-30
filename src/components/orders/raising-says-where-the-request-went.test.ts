import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeRequestValue } from '@/components/screens/confirmation/ActionDialogs';

/**
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل» — the two raisers say where the request went.
 *
 * The raisers are the REAL ones; the network is a fake. Held: the three places a request can be (carried out, approved and
 * waiting to be carried out, waiting for a decision), that the sentence names the tab, and that a person without the
 * screen is not pointed at it.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string, init?: { method?: string; body?: string }) => Promise<unknown>>(),
  apiFetch: vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(),
}));
vi.mock('@/lib/api-client', () => ({
  apiJson: (url: string, init?: { method?: string; body?: string }) => apiJson(url, init),
  apiFetch: (url: string, init?: { body?: string }) => apiFetch(url, init),
}));

import { raiseChangeRequest } from './raiseChangeRequest';
import { raiseEditRequest } from './raiseEditRequest';

const value = (over: Partial<ChangeRequestValue> = {}): ChangeRequestValue => ({
  intent: 'EDIT',
  field: 'quantity',
  to: '5',
  postponeDate: '',
  cancelReason: '',
  reason: 'الزبون زاد الكمية',
  ...over,
});

/** The POST answers `raise`; the PATCH answers `apply`, or throws it. */
function serve(raise: { readyToApply?: boolean; orderStatus?: string }, apply: 'ok' | Error = 'ok') {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/change-requests')) return { request: { id: 'cr1' }, ...raise };
    if (init?.method === 'PATCH') {
      if (apply instanceof Error) throw apply;
      return {};
    }
    return {};
  });
}

beforeEach(() => {
  apiJson.mockReset();
  apiFetch.mockReset();
});

describe('Ⅰ · raiseChangeRequest — the order screen and the confirmation desk', () => {
  it('waiting for a decision: names who decides and the tab', async () => {
    serve({ readyToApply: false, orderStatus: 'CONFIRMED' });
    const a = await raiseChangeRequest('o1', value(), 3, { canOpenQueue: true });
    expect(a.outcome).toBe('WAITING');
    expect(a.message).toContain('بانتظار قرار');
    expect(a.message).toContain('بانتظار القرار.');
    expect(apiJson).toHaveBeenCalledTimes(1);
  });

  it('waiting, for a person without the screen: «المشرف», and no link to it', async () => {
    serve({ readyToApply: false, orderStatus: 'IN_PROGRESS' });
    const a = await raiseChangeRequest('o1', value(), 3);
    expect(a.message).toBe('رُفع طلبك وبانتظار قرار المشرف.');
  });

  it('approved on the spot and carried out: «طُبِّق»', async () => {
    serve({ readyToApply: true, orderStatus: 'CONFIRMED' });
    const a = await raiseChangeRequest('o1', value(), 3, { canOpenQueue: true });
    expect(a).toEqual({ outcome: 'APPLIED', message: 'طُبِّق التعديل على الطلب.' });
    const patch = apiJson.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(patch?.[1]?.body ?? '{}')).toEqual({ changeRequestId: 'cr1', expectedVersion: 3 });
  });

  it('approved on the spot and the last step failed: throws the sentence that names «بانتظار التطبيق», with the reason', async () => {
    serve({ readyToApply: true, orderStatus: 'CONFIRMED' }, new Error('المخزون ما بيكفي لـكريم.'));
    await expect(raiseChangeRequest('o1', value(), 3, { canOpenQueue: true })).rejects.toThrow(
      /اعتُمد مباشرة وهو بانتظار التطبيق — افتح طلبات التعديل ← بانتظار التطبيق.*المخزون ما بيكفي لـكريم\./
    );
  });

  it('and for a person without the screen it says to tell the supervisor, not to open a page she cannot see', async () => {
    serve({ readyToApply: true }, new Error('سبب'));
    const failure = await raiseChangeRequest('o1', value(), 3).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('بلّغ المشرف ليطبّقه');
    expect((failure as Error).message).not.toContain('افتح طلبات التعديل');
  });

  it('a cancellation: carried out says «نُفِّذ الإلغاء»; a refusal of the stand-down door is the same «approved and waiting»', async () => {
    serve({ readyToApply: true });
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const done = await raiseChangeRequest('o1', value({ intent: 'CANCEL', cancelReason: 'PRICE_TOO_HIGH' }), 3, { canOpenQueue: true });
    expect(done.message).toBe('نُفِّذ الإلغاء.');

    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ errorAr: 'الطرد عند شركة الشحن' }) });
    await expect(raiseChangeRequest('o1', value({ intent: 'CANCEL', cancelReason: 'PRICE_TOO_HIGH' }), 3, { canOpenQueue: true })).rejects.toThrow(
      /اعتُمد مباشرة وهو بانتظار التطبيق.*الطرد عند شركة الشحن/
    );
  });

  it('a packed parcel still says what it said — that sentence already names the screen and the reason', async () => {
    serve({ readyToApply: true });
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ code: 'ATTESTATION_REQUIRED' }) });
    await expect(raiseChangeRequest('o1', value({ intent: 'POSTPONE', postponeDate: '2026-11-02' }), 3, { canOpenQueue: true })).rejects.toThrow(
      /اعتُمد الطلب وبقي تنفيذه: بوليصة الطرد مطبوعة/
    );
  });

  it('a postponement carried out says «أُجّل الشحن»', async () => {
    serve({ readyToApply: true });
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const a = await raiseChangeRequest('o1', value({ intent: 'POSTPONE', postponeDate: '2026-11-02' }), 3);
    expect(a.message).toBe('أُجّل الشحن.');
  });
});

describe('Ⅱ · raiseEditRequest — the cards of the order window', () => {
  it('waiting: returns the sentence with the tab, and applied false', async () => {
    serve({ readyToApply: false, orderStatus: 'CONFIRMED' });
    const out = await raiseEditRequest('o1', { customerName: 'سامر أحمد' }, 'الزبون صحّح اسمه', 3, { canOpenQueue: true });
    expect(out.applied).toBe(false);
    expect(out.requestId).toBe('cr1');
    expect(out.message).toContain('رُفع طلبك وبانتظار قرار');
    expect(out.message).toContain('طلبات التعديل ← بانتظار القرار');
  });

  it('carried out: applied true and «طُبِّق»', async () => {
    serve({ readyToApply: true });
    const out = await raiseEditRequest('o1', { customerName: 'سامر أحمد' }, 'الزبون صحّح اسمه', 3);
    expect(out).toEqual({ applied: true, requestId: 'cr1', message: 'طُبِّق التعديل على الطلب.' });
  });

  it('approved and the last step failed: throws, as it always did — but now the sentence says where to look', async () => {
    serve({ readyToApply: true }, new Error('تغيّرت أسطر الطلب'));
    await expect(raiseEditRequest('o1', { customerName: 'سامر أحمد' }, 'الزبون صحّح اسمه', 3, { canOpenQueue: true })).rejects.toThrow(
      /اعتُمد مباشرة وهو بانتظار التطبيق — افتح طلبات التعديل ← بانتظار التطبيق.*تغيّرت أسطر الطلب/
    );
  });
});

describe('Ⅲ · the screens print that sentence — they do not keep their own', () => {
  const src = (rel: string) =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('the order window prints the answer’s message', () => {
    expect(src('src/components/orders/OrderDetailModal.tsx')).toMatch(/answer\?\.message/);
  });

  it('the confirmation desk prints it as its notice', () => {
    expect(src('src/components/screens/ConfirmationMineScreen.tsx')).toMatch(/setNotice\(answer\.message\)/);
  });

  it('the customer card prints it, and no longer the one sentence that said nothing of where the request is', () => {
    const card = src('src/components/orders/CustomerCard.tsx');
    expect(card).toMatch(/setNotice\(message\)/);
    expect(card).not.toContain('بانتظار الموافقة — التعديل انرفع كطلب');
  });
});
