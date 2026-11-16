// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { DAILY_FROM_HOURS, DAILY_TO_HOURS } from '@/lib/winback-daily-words';

/**
 * THE WINBACK-V2 CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (step F1).
 *
 * The owner cannot see from «الاسترجاع اليومي» that it only adds a call list: nothing offered, discounted or closed. The sentence says so, holds its 24 and 72 hours to the constants, says the
 * postponed ones are call-only, names itself apart from the call-proof switch, and the checkbox is the only control.
 */
const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { WinbackV2Card } from './WinbackV2Card';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ winbackV2: { enabled: false, enabledAt: null } });
});
afterEach(cleanup);

async function subtitle(): Promise<string> {
  render(<WinbackV2Card />);
  return (await screen.findByText(/بتبيّن بتبويب «ملغاة سابقاً» قائمة يومية/)).textContent ?? '';
}

describe('the sentence of «الاسترجاع اليومي (تجريبي)»', () => {
  it('has its title and its hours from the constants', async () => {
    const text = await subtitle();
    expect(screen.getByText('الاسترجاع اليومي (تجريبي)')).toBeTruthy();
    const hours = /من (\d+) لحد (\d+) ساعة/.exec(text);
    expect(Number(hours?.[1])).toBe(DAILY_FROM_HOURS);
    expect(Number(hours?.[2])).toBe(DAILY_TO_HOURS);
    expect(text).toContain('غيّر رأيو');
    expect(text).toContain('خمس محاولات');
  });

  it('says what it does NOT do, that the postponed ones are call-only, that it is its own key, and that off is as it is', async () => {
    const text = await subtitle();
    expect(text).toContain('ما بتعرض خصم ولا بتسكّر ولا بتبعت شي للزبون');
    expect(text).toContain('الطلبات المؤجّلة للاتصال بس');
    expect(text).toContain('مش مفتاح «إثبات المكالمات وجدول المحاولات»');
    expect(text).toContain('مطفي = الشاشة زي ما هي');
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
    expect(api).toHaveBeenCalledWith('/api/settings/winback-v2');
  });

  it('is read-only for whoever does not hold the sensitive-settings key, and says so', async () => {
    can.value = false;
    await subtitle();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/بيشغّله بس صاحب صلاحية/)).toBeTruthy();
  });
});
