// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE LEADS CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (step E1).
 *
 * The owner cannot see from «ليدز الصفحات» that it only KEEPS the details a visitor left: no order is created, nothing is sent to the visitor, and the webhook accepts only what is signed with a secret
 * of the server's environment. The sentence says so, names itself apart from the call-proof switch, and the checkbox is the only control.
 */
const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { LeadsV2Card } from './LeadsV2Card';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ leadsV2: { enabled: false, enabledAt: null } });
});
afterEach(cleanup);

async function subtitle(): Promise<string> {
  render(<LeadsV2Card />);
  return (await screen.findByText(/لما حدا بيترك بياناتو بصفحة من صفحات الهبوط/)).textContent ?? '';
}

describe('the sentence of «ليدز الصفحات (تجريبي)»', () => {
  it('has its title and says what it keeps and what it flags, with the 24 hours', async () => {
    const text = await subtitle();
    expect(screen.getByText('ليدز الصفحات (تجريبي)')).toBeTruthy();
    expect(text).toContain('بينحفظ مرة وحدة');
    expect(text).toContain('خلال آخر 24 ساعة');
  });

  it('says what it does NOT do, where the secret lives, that it is its own key, and what off does', async () => {
    const text = await subtitle();
    expect(text).toContain('ما بينعمل طلب ولا بينبعت شي للزبون');
    expect(text).toContain('سرّ محفوظ ببيئة السيرفر، مش بالإعدادات');
    expect(text).toContain('مش مفتاح «إثبات المكالمات وجدول المحاولات»');
    expect(text).toContain('مطفي: بيرد «وصل» وما بيحفظ شي');
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
    expect(api).toHaveBeenCalledWith('/api/settings/leads-v2');
  });

  it('is read-only for whoever does not hold the sensitive-settings key, and says so', async () => {
    can.value = false;
    await subtitle();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/بيشغّله بس صاحب صلاحية/)).toBeTruthy();
  });
});
