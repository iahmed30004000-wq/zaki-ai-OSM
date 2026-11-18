// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { POSTPONE_MAX_TIMES, QUEUE_PRIORITY, QUEUE_PRIORITY_LIMITS } from '@/lib/queue-priority';

/**
 * THE QUEUE-PRIORITY CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (step D1).
 *
 * The owner cannot see from «أولوية الطابور» that it changes which order a girl is given next. The sentence says so, holds its figures to the rule's constants, says what it
 * leaves alone, names itself apart from the call-proof switch, shows the share and its rule when the server sends them, and the checkbox is the only control.
 */
const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { QueuePriorityCard } from './QueuePriorityCard';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ queuePriority: { enabled: false, enabledAt: null }, share: { percent: 37, note: 'نسبة المتأخر 37%. قاعدة الاحتساب: مثال.' } });
});
afterEach(cleanup);

async function subtitle(): Promise<string> {
  render(<QueuePriorityCard />);
  return (await screen.findByText(/بيغيّر أي طلب بيطلع/)).textContent ?? '';
}

describe('the sentence of «أولوية الطابور (تجريبي)»', () => {
  it('has its title, and its figures are the rule\'s constants', async () => {
    const text = await subtitle();
    expect(screen.getByText('أولوية الطابور (تجريبي)')).toBeTruthy();
    expect(Number(/أقل من (\d+) دقيقة/.exec(text)?.[1])).toBe(QUEUE_PRIORITY.freshMinutes);
    expect(Number(/أكتر من (\d+) ساعة/.exec(text)?.[1])).toBe(QUEUE_PRIORITY.agingHours);
    expect(Number(/آخر (\d+) أيام/.exec(text)?.[1])).toBe(QUEUE_PRIORITY.windowDays);
  });

  it('says what it changes, what it leaves alone, that it is its own key, and that off is as it is today', async () => {
    const text = await subtitle();
    expect(text).toContain('بيغيّر أي طلب بيطلع للموظفة بالسحب الجاي');
    expect(text).toContain('من 9 الصبح للـ11 ومن 9 بالليل للـ12');
    // 18/11 (C1, finding #8 of the rules map): the sentence used to say «ما بيغيّر حد اليد ولا رجوع الطلب اللي ما انلمس، وما في رفض ولا إغلاق ولا رسالة للزبون» — FALSE: the same key sets the hand to
    // 3 and the idle return to 20 working minutes (`QUEUE_PRIORITY_LIMITS`, where the plan is on) and refuses a third postponement (`POSTPONE_MAX_TIMES`). The new sentence says so, with the constants'
    // own figures; the old one is pinned ABSENT below, so it cannot come back.
    expect(text).toContain(`وبيغيّر كمان حد اليد لـ${QUEUE_PRIORITY_LIMITS.handLimit} طلبات ورجوع الطلب اللي ما انلمس لـ${QUEUE_PRIORITY_LIMITS.idleBusinessMinutes} دقيقة دوام`);
    expect(text).toContain('بس إذا «إثبات المكالمات وجدول المحاولات» شغّال');
    expect(text).toContain(`حدّو ${POSTPONE_MAX_TIMES} مرات (اللي بعدهم بينرفض)`);
    expect(text).toContain('ما في إغلاق ولا رسالة للزبون');
    expect(text).not.toContain('ما بيغيّر حد اليد');
    expect(text).not.toContain('ما في رفض');
    expect(text).toContain('مش مفتاح «إثبات المكالمات وجدول المحاولات»');
    expect(text).toContain('مطفي = السحب زي ما هو');
  });

  it('is plain Arabic with Western digits and no Latin words', async () => {
    const text = await subtitle();
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('shows the share and its rule as the server sent them, and keeps them after a switch is pressed', async () => {
    await subtitle();
    expect(screen.getByText('نسبة المتأخر 37%. قاعدة الاحتساب: مثال.')).toBeTruthy();
    api.mockResolvedValueOnce({ queuePriority: { enabled: true, enabledAt: '2026-11-16T22:00:00.000Z' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText('نسبة المتأخر 37%. قاعدة الاحتساب: مثال.')).toBeTruthy();
    expect(api).toHaveBeenLastCalledWith('/api/settings/queue-priority', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true }) }));
  });

  it('the checkbox is the only control, and it reads the switch from its own door', async () => {
    await subtitle();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(api).toHaveBeenCalledWith('/api/settings/queue-priority');
  });

  it('is read-only for whoever does not hold the sensitive-settings key, and says so', async () => {
    can.value = false;
    await subtitle();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/بيشغّله بس صاحب صلاحية/)).toBeTruthy();
  });
});
