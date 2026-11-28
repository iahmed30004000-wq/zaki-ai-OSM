// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DESIGN_CHOICES, DESIGN_ELEMENTS, LOCKED_REASON, WAYBILL_ELEMENTS } from '@/lib/waybill-print-settings';

/**
 * «التصميم» ON THE CARD (27/11): «التصميم الأساسي» is a visible choice, listed first beside «أ» and «ب»; the preview is
 * asked for the choice being looked at; going back to the first sends no design; the offer's tick box shows with the new
 * designs only.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  saidBy: async () => 'تعذّرت المعاينة',
}));

import { WaybillPrintCard } from './WaybillPrintCard';
import { forgetLabelSize } from '@/components/labels/LabelSize';

const STORE = '11111111-1111-4111-8111-111111111111';
const loaded = (settings: Record<string, unknown> = { hide: [], logo: 'store' }) => ({
  settings, ownLogo: null, storeLogo: null, elements: WAYBILL_ELEMENTS, designElements: DESIGN_ELEMENTS, designs: DESIGN_CHOICES,
  lockedReason: LOCKED_REASON,
});
const serve = (settings?: Record<string, unknown>) =>
  apiJson.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? { settings: JSON.parse(String(init.body)) } : loaded(settings)
  );

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  apiFetch.mockImplementation(async () => new Response('<!DOCTYPE html><p>ورقة</p>', { status: 200 }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  forgetLabelSize();
});

/** This device's printer, as the size picker remembers it. */
const printer = (width: number, height: number) => {
  localStorage.setItem('salesflow.labelSize', JSON.stringify({ key: 'custom', custom: { width, height } }));
  forgetLabelSize();
};
const SMALL_PAPER = /بينطبع عليه «التصميم الأساسي»/;

const designs = () => within(screen.getByRole('radiogroup', { name: 'تصميم البوليصة' })).getAllByRole('radio');
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
const lastPreview = () => JSON.parse(apiFetch.mock.calls.at(-1)![1].body);
const sent = () => JSON.parse(apiJson.mock.calls.filter((c) => c[1]?.method === 'PUT').at(-1)![1].body);
const offerBox = () => screen.queryByRole('checkbox', { name: 'بطاقة العرض (اسم العرض)' });

describe('the design picker', () => {
  it('lists «التصميم الأساسي» first, chosen for a store that never chose', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    expect(designs().map((r) => r.textContent)).toEqual(['التصميم الأساسي', 'التصميم أ', 'التصميم ب']);
    expect(designs()[0].getAttribute('aria-checked')).toBe('true');
    expect(offerBox()).toBeNull();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(lastPreview()).not.toHaveProperty('design');
  });

  it('picking «أ» previews it, shows the offer’s tick box, and «حفظ» sends it', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    pick('التصميم أ');
    await waitFor(() => expect(lastPreview().design).toBe('a'));
    expect((offerBox() as HTMLInputElement).checked).toBe(true);
    fireEvent.click(offerBox()!);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(sent()).toEqual({ hide: ['offer'], logo: 'store', design: 'a' }));
  });

  it('choosing «التصميم الأساسي» again previews it and saves with no design', async () => {
    serve({ hide: [], logo: 'store', design: 'b' });
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    expect(designs()[2].getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(lastPreview().design).toBe('b'));
    pick('التصميم الأساسي');
    await waitFor(() => expect(lastPreview()).not.toHaveProperty('design'));
    expect(offerBox()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(sent()).toEqual({ hide: [], logo: 'store' }));
  });

  it('on a paper under 70 mm a new design says, in one sentence, that the basic one prints there', async () => {
    printer(60, 40);
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    expect(screen.queryByText(SMALL_PAPER)).toBeNull();
    pick('التصميم ب');
    expect(screen.getByText(SMALL_PAPER)).toBeTruthy();
    pick('التصميم الأساسي');
    expect(screen.queryByText(SMALL_PAPER)).toBeNull();
  });

  it('NEGATIVE: on 70×70 and up there is no such sentence', async () => {
    printer(70, 70);
    serve({ hide: [], logo: 'store', design: 'a' });
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    await waitFor(() => expect(lastPreview()).toMatchObject({ width: 70, height: 70 }));
    expect(screen.queryByText(SMALL_PAPER)).toBeNull();
  });

  it('NEGATIVE: without geo.manage the design is shown and cannot be changed', async () => {
    serve({ hide: [], logo: 'store', design: 'a' });
    render(<WaybillPrintCard storeId={STORE} mayManage={false} />);
    await screen.findByText('البوليصة المطبوعة');
    for (const r of designs()) expect((r as HTMLButtonElement).disabled).toBe(true);
    expect((offerBox() as HTMLInputElement).disabled).toBe(true);
  });
});
