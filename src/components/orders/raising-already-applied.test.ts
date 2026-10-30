import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeRequestValue } from '@/components/screens/confirmation/ActionDialogs';

/**
 * A SECOND PRESS IS NOT A WAIT. Two presses on the same approval: the loser's apply answers «ALREADY_APPLIED», and the
 * raiser used to say «اعتُمد مباشرة وهو بانتظار التطبيق» — sending her to look for a request that was already carried out.
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

const refused = (code: string) => Object.assign(new Error('طُبّق هذا التعديل مسبقاً'), { status: 409, data: { code } });

function serve(patch: Error | 'ok', raise: { readyToApply: boolean; orderStatus?: string } = { readyToApply: true, orderStatus: 'CONFIRMED' }) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/change-requests')) return { request: { id: 'cr1' }, ...raise };
    if (init?.method === 'PATCH' && patch instanceof Error) throw patch;
    return {};
  });
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('Ⅰ · the order window and the confirmation desk', () => {
  it('an edit whose apply says ALREADY_APPLIED is reported as carried out', async () => {
    serve(refused('ALREADY_APPLIED'));
    const a = await raiseChangeRequest('o1', value(), 3, { canOpenQueue: true });
    expect(a.outcome).toBe('APPLIED');
    expect(a.message).toContain('طُبِّق مسبقاً');
  });

  it('a cancellation whose stand-down says ALREADY_APPLIED too', async () => {
    serve('ok');
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ code: 'ALREADY_APPLIED', errorAr: 'هالطلب اتنفّذ قبل ما تضغط' }) });
    const a = await raiseChangeRequest('o1', value({ intent: 'CANCEL', cancelReason: 'PRICE_TOO_HIGH' }), 3, { canOpenQueue: true });
    expect(a.outcome).toBe('APPLIED');
  });

  it('any other refusal of the apply is still «approved and waiting»', async () => {
    serve(refused('VERSION_CONFLICT'));
    await expect(raiseChangeRequest('o1', value(), 3, { canOpenQueue: true })).rejects.toThrow(/اعتُمد مباشرة وهو بانتظار التطبيق/);
  });

  it('the sentence names the deciders from what the screen knows of the order', async () => {
    serve('ok', { readyToApply: false, orderStatus: 'CONFIRMED' });
    const handed = await raiseChangeRequest('o1', value(), 3, { canOpenQueue: true, order: { handed: true, held: true } });
    expect(handed.message).toContain('بانتظار قرار المشرف —');
    const open = await raiseChangeRequest('o1', value(), 3, { canOpenQueue: true, order: { handed: false } });
    expect(open.message).toContain('المشرف أو مسؤول المخزن');
  });
});

describe('Ⅱ · the cards of the order window', () => {
  it('an edit that was already applied returns applied, not a throw', async () => {
    serve(refused('ALREADY_APPLIED'));
    const out = await raiseEditRequest('o1', { customerName: 'سامر أحمد' }, 'الزبون صحّح اسمه', 3, { canOpenQueue: true });
    expect(out.applied).toBe(true);
    expect(out.message).toContain('طُبِّق مسبقاً');
  });

  it('any other refusal still throws the sentence that names the tab', async () => {
    serve(refused('VERSION_CONFLICT'));
    await expect(raiseEditRequest('o1', { customerName: 'سامر أحمد' }, 'الزبون صحّح اسمه', 3, { canOpenQueue: true })).rejects.toThrow(
      /اعتُمد مباشرة وهو بانتظار التطبيق/
    );
  });
});
