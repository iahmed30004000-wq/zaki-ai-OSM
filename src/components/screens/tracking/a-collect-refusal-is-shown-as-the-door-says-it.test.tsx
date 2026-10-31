// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «استلمت منه» REFUSES AN ORDER A STATEMENT SPEAKS FOR — AND THE SCREEN SAYS IT IN THE DOOR'S WORDS.
 *
 * The tracking screen and the manual-matching screen both collect through this one dialog, so what it shows
 * is what both show. A refusal is the sentence the door answered with, in the dialog, with the dialog still
 * open; nothing is reported as recorded.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { CollectDialog } from './CollectDialog';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const order = {
  id: 'o1', orderNumber: 'SY-2026-0001', totalAmount: 20, currency: 'USD', deliveryFee: 3, expectedCollection: 17,
  customer: { fullName: 'سامر' }, deliveryProvider: { id: 'p1', name: 'أبو علي', kind: 'AGENT' },
};

const DOOR_SAYS = 'الطلب SY-2026-0001 بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف';

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error(DOOR_SAYS);
    return { wallets: [{ id: 'w1', name: 'صندوق سوريا', currencyCode: 'USD' }] };
  });
});
afterEach(cleanup);

describe('the collect dialog', () => {
  it('shows the door’s sentence, stays open, and does not say anything was recorded', async () => {
    const onDone = vi.fn();
    render(<CollectDialog orders={[order]} onClose={vi.fn()} onDone={onDone} />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('w1'));
    fireEvent.change(screen.getByPlaceholderText('مثال: استلمت نقداً من المندوب'), { target: { value: 'استلمت منه نقداً' } });
    fireEvent.click(screen.getByRole('button', { name: /استلمت منه/ }));

    expect(await screen.findByText(DOOR_SAYS)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is the ONE dialog both screens use, and neither posts to the door on its own', () => {
    // If a screen drew its own collect form, its refusals would not be these.
    for (const file of ['src/components/screens/TrackingScreen.tsx', 'src/components/screens/finance/ManualMatching.tsx']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).toContain("import { CollectDialog } from '@/components/screens/tracking/CollectDialog'");
      expect(src, file).not.toContain("'/api/ops/tracking/collect'");
    }
  });
});
