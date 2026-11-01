// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «شامل التوصيل» — THE BOX ON THE IMPORT DIALOG (the owner, 1/11).
 *
 * The prices in an imported sheet are the prices the customers were told, and those are delivery-included. The dialog asks once for
 * the whole file, TICKED, and every row it posts says so (`POST /api/orders` reads `priceIncludesDelivery` as the person's word).
 * Unticked, every row says false and the fee is added when its shipment is made. Nothing else about a row changed.
 */

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));

import { apiFetch, apiJson } from '@/lib/api-client';
import { ImportOrdersDialog } from './ImportOrdersDialog';

const apiFetchMock = vi.mocked(apiFetch);
const apiJsonMock = vi.mocked(apiJson);

const COUNTS = { total: 2, importable: 2, problems: 0, duplicatesInFile: 0, alreadyOrdered: 0, blocked: 0 };
const serverRow = (line: number, over: Record<string, unknown> = {}) => ({
  line,
  values: {
    customerName: 'أحمد المغني', customerPhone: '0999123456', customerAltPhone: '', customerAddress: 'حمص — شارع الحضارة',
    customerCity: '', productName: 'كريم مرطّب', quantity: '1', sellingPrice: '', notes: '',
  },
  phone: '0999123456', quantity: 1, sellingPrice: 20 as number | null,
  problems: [] as Array<{ field: string; kind: string; ar: string }>,
  duplicateOfLine: null, blocked: false, existingOrder: null,
  productId: '11111111-1111-4111-8111-111111111111', productLabel: 'كريم مرطّب', importable: true,
  ...over,
});

beforeEach(() => {
  apiFetchMock.mockReset();
  apiJsonMock.mockReset();
  apiJsonMock.mockResolvedValue({});
  apiFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ rows: [serverRow(2), serverRow(3)], counts: COUNTS, recentDays: 14 }),
  } as unknown as Response);
});
afterEach(cleanup);

async function readFile() {
  const onDone = vi.fn();
  render(<ImportOrdersDialog onClose={() => {}} onDone={onDone} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const user = userEvent.setup();
  await user.upload(input, new File(['x'], 'orders.csv', { type: 'text/csv' }));
  await screen.findByText(/جاهز/);
  return { user, onDone };
}
const box = () => screen.getByRole('checkbox', { name: /شامل التوصيل/ }) as HTMLInputElement;
const posted = () => apiJsonMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);

describe('the import dialog', () => {
  it('draws the box ticked, once for the whole file, and says what ticked means', async () => {
    await readFile();
    expect(box().checked).toBe(true);
    expect(screen.getAllByRole('checkbox', { name: /شامل التوصيل/ })).toHaveLength(1);
    expect(screen.getByText('الزبون بيدفع السعر اللي بالملف بس، وأجرة التوصيل على المتجر.')).toBeTruthy();
  });

  it('left ticked: every row posted says delivery is in the price', async () => {
    const { user, onDone } = await readFile();
    await user.click(screen.getByText(/استورد 2 طلباً/));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(2));
    expect(posted()).toHaveLength(2);
    for (const body of posted()) expect(body).toMatchObject({ priceIncludesDelivery: true, viaImport: true, sellingPrice: 20 });
  });

  it('UNTICKED: every row says false, and the hint says the fee is added', async () => {
    const { user, onDone } = await readFile();
    await user.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getByText('بينضاف توصيل على كل طلب لما تنعمل الشحنة.')).toBeTruthy();
    await user.click(screen.getByText(/استورد 2 طلباً/));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(2));
    for (const body of posted()) expect(body.priceIncludesDelivery).toBe(false);
  });
});
