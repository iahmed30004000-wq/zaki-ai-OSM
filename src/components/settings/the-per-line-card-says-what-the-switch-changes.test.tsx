// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (the owner, 9/11).
 *
 * «تسوية السطور النظيفة عند الاعتماد (تجريبي)» is read by one person: the owner, in the settings. What he must be able to read there is
 * the promise the brief makes: the clean orders are settled at the approval, a line still a question holds only its own order, the
 * money does not change, a statement approved earlier is not touched by itself, and OFF is the work as it is.
 *
 * Turning it on is the owner’s click (the server asks the key again). It needs no other switch, so the box is never locked.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));
vi.mock('@/lib/db', () => ({ db: {} }));

import { PerLineSettlementCard } from './PerLineSettlementCard';

const OFF = { perLine: { enabled: false, enabledAt: null } };

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue(OFF);
});
afterEach(cleanup);

async function subtitle(): Promise<string> {
  render(<PerLineSettlementCard />);
  return (await screen.findByText(/الطلبات اللي سطرها مطابق بتتسوّى فوراً/)).textContent ?? '';
}
const box = () => screen.getByRole('checkbox') as HTMLInputElement;

describe('the sentence of «تسوية السطور النظيفة عند الاعتماد (تجريبي)»', () => {
  it('has its title, in Arabic', async () => {
    render(<PerLineSettlementCard />);
    expect(await screen.findByText('تسوية السطور النظيفة عند الاعتماد (تجريبي)')).toBeTruthy();
  });

  it('says what changes: the matched orders settle at the approval, their commission becomes payable and their stock goes out, and a line still a question holds only its own order', async () => {
    const text = await subtitle();
    expect(text).toContain('لما تعتمد الكشف، الطلبات اللي سطرها مطابق بتتسوّى فوراً');
    expect(text).toContain('بتصير عمولتها مستحقة وبينسحب مخزونها');
    expect(text).toContain('السطر اللي لسا ما انبتّ فيه بيعلّق طلبه هو بس');
  });

  it('says what does NOT change: the money — it enters the wallet at the approval as it always did; only the time the orders are settled moves', async () => {
    const text = await subtitle();
    expect(text).toContain('المصاري ما بتتغيّر ولا بقرش');
    expect(text).toContain('بتدخل المحفظة باعتماد الكشف زي ما هي');
    expect(text).toContain('وقت تسوية الطلبات المطابقة بس');
  });

  it('says a statement approved before it was turned on is not touched by itself, and where its press is', async () => {
    const text = await subtitle();
    expect(text).toContain('الكشف اللي انعتمد قبل ما تشغّليه ما بيتغيّر لحاله');
    expect(text).toContain('«سوّي الطلبات النظيفة»');
  });

  it('says OFF is the work as it is', async () => {
    expect(await subtitle()).toContain('مطفي = الشغل زي ما هو');
  });

  it('is three short lines, not one long paragraph', async () => {
    render(<PerLineSettlementCard />);
    const sentence = await screen.findByText(/الطلبات اللي سطرها مطابق بتتسوّى فوراً/);
    expect((sentence.innerHTML ?? '').split(/<br\s*\/?>/)).toHaveLength(3);
  });

  it('is spoken Arabic with no English word on the card', async () => {
    const text = await subtitle();
    expect(/[A-Za-z]/.test(text), text).toBe(false);
    expect(/[A-Za-z]/.test(document.body.textContent ?? ''), document.body.textContent ?? '').toBe(false);
  });
});

describe('the box', () => {
  it('can be ticked at once — it needs no other switch — and a tick is a PUT of a plain yes, whose answer is what the card then shows', async () => {
    render(<PerLineSettlementCard />);
    await screen.findByRole('checkbox');
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    api.mockResolvedValueOnce({ perLine: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } });
    fireEvent.click(box());
    await waitFor(() => expect(box().checked).toBe(true));
    const [url, init] = api.mock.calls.at(-1)!;
    expect(url).toBe('/api/settings/per-line-settlement');
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: true }) });
  });

  it('an unticking is a PUT of a plain no', async () => {
    api.mockResolvedValue({ perLine: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } });
    render(<PerLineSettlementCard />);
    await screen.findByRole('checkbox');
    expect(box().checked).toBe(true);
    api.mockResolvedValueOnce(OFF);
    fireEvent.click(box());
    await waitFor(() => expect(box().checked).toBe(false));
    expect(api.mock.calls.at(-1)![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: false }) });
  });

  it('is drawn for somebody who may only read it, too: the sentence is there, the box is disabled, and it says who turns it', async () => {
    can.value = false;
    const text = await subtitle();
    expect(text).toContain('مطفي = الشغل زي ما هو');
    expect(box().disabled).toBe(true);
    expect(await screen.findByText('بيشغّله بس صاحب صلاحية «إعدادات النظام الحسّاسة».')).toBeTruthy();
  });

  it('a read that fails draws nothing at all (as the other switches’ cards do)', async () => {
    api.mockRejectedValue(new Error('down'));
    const { container } = render(<PerLineSettlementCard />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
