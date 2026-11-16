// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { INTAKE_WINDOW_MS } from '@/lib/intake-flags';

/**
 * THE INTAKE-FILTER CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (step C1).
 *
 * The owner cannot see from «فلتر الاستقبال» that it only writes a note: nothing refused, closed, held or messaged. The sentence says so, holds its 24 hours to the
 * constant, names itself apart from the call-proof switch, and the checkbox is the only control.
 */
const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { IntakeFilterCard } from './IntakeFilterCard';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ intakeFilter: { enabled: false, enabledAt: null } });
});
afterEach(cleanup);

async function subtitle(): Promise<string> {
  render(<IntakeFilterCard />);
  return (await screen.findByText(/بعد ما يوصل طلب جديد/)).textContent ?? '';
}

describe('the sentence of «فلتر الاستقبال (تجريبي)»', () => {
  it('has its title, and says what it does with the 24 hours of the constant', async () => {
    const text = await subtitle();
    expect(screen.getByText('فلتر الاستقبال (تجريبي)')).toBeTruthy();
    expect(Number(/خلال (\d+) ساعة/.exec(text)?.[1])).toBe(INTAKE_WINDOW_MS / 3_600_000);
    expect(text).toContain('شكل أرقام بلد المتجر');
  });

  it('says what it does NOT do, that it is its own key, and that off is as it is today', async () => {
    const text = await subtitle();
    expect(text).toContain('ما في رفض ولا إغلاق ولا حجز ولا رسالة للزبون');
    expect(text).toContain('الطلبات اللي وصلت قبل التشغيل ما بتتوسم');
    expect(text).toContain('مش مفتاح «إثبات المكالمات وجدول المحاولات»');
    expect(text).toContain('مطفي = الشغل زي ما هو');
  });

  it('is plain Arabic with Western digits and no Latin words', async () => {
    const text = await subtitle();
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('the checkbox is the only control, and it reads the switch from its own door', async () => {
    await subtitle();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(api).toHaveBeenCalledWith('/api/settings/intake-filter');
  });

  it('is read-only for whoever does not hold the sensitive-settings key, and says so', async () => {
    can.value = false;
    await subtitle();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/بيشغّله بس صاحب صلاحية/)).toBeTruthy();
  });
});
