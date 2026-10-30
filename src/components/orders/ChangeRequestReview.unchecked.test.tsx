// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { REVIEW_CLOSED_AR, REVIEW_UNCHECKED_AR } from '@/lib/change-request-review';

/**
 * IN THE DIALOG, A REQUEST THAT WAS NOT CHECKED IS NOT APPROVED.
 *
 * On the queue an unchecked card may be carried out — the apply door judges it on the press. Approval has no second look,
 * so in the dialog «wait» from the budget, or a request already decided, keeps «موافقة» shut with its sentence.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (url: string) => apiJson(url), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));

import { ChangeRequestReview } from './ChangeRequestReview';

const LINES = {
  v: 2,
  edits: [
    {
      lineId: 'l1',
      productId: { from: 'prod-cream-0001', to: 'prod-cream-0001' },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    },
  ],
  snapshot: { orderVersion: 7, minorUnit: 3, before: { cod: 48.5 }, after: { cod: 72.5 } },
};

const row = {
  id: 'cr1',
  orderId: 'o1',
  reason: 'الزبون زاد الكمية',
  changes: { lines: LINES },
  requestedByName: 'ريم',
  createdAt: '2026-10-29T10:00:00.000Z',
  order: { orderNumber: 'SY-2026-0148' },
  needsPriceKey: false,
};

const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, data: { code } });

function serve(failure: Error) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/preview')) throw failure;
    return { requests: [row] };
  });
}

const approve = () => screen.getByRole('button', { name: /موافقة/ }) as HTMLButtonElement;

beforeEach(() => {
  apiJson.mockReset();
});
afterEach(cleanup);

describe('the dialog', () => {
  it('keeps «موافقة» shut when the budget said wait, and says to press «افحص»', async () => {
    serve(refused(429, 'RATE_LIMITED', 'طلبات كثيرة جداً'));
    render(<ChangeRequestReview requestId="cr1" onClose={() => undefined} onDecided={() => undefined} />);
    await screen.findByText(new RegExp(`الموافقة مقفلة: ${REVIEW_UNCHECKED_AR.replace(/[«»]/g, '.')}`));
    expect(approve().disabled).toBe(true);
    expect(approve().title).toBe(REVIEW_UNCHECKED_AR);
    expect(screen.getByRole('button', { name: 'افحص' })).toBeTruthy();
  });

  it('keeps it shut, with the request’s own sentence, when it was decided while the dialog was open', async () => {
    serve(refused(409, 'NOT_OPEN', 'هذا الطلب انبتّ فيه'));
    render(<ChangeRequestReview requestId="cr1" onClose={() => undefined} onDecided={() => undefined} />);
    await screen.findByText(new RegExp(`الموافقة مقفلة: ${REVIEW_CLOSED_AR.replace('.', '\\.')}`));
    expect(approve().disabled).toBe(true);
    expect(approve().title).toBe(REVIEW_CLOSED_AR);
    expect(document.body.textContent).not.toContain('تعذّر فحص');
  });
});
