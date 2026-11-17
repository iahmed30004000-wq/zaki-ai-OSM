// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateRange, todayRange } from './DateRange';

/**
 * DEFINITION OF DONE — the date control (D1, the owner 17/11: «حط الأشياء ع اليوم التاريخ وحط أمس و قبل 7 أيام واخر شهر، والديفولت اليوم»).
 * What must work: the strip offers اليوم · أمس · آخر 7 أيام · آخر 30 يوم · هذا الشهر · a picked span; `todayRange()` is the range the figures screens open on; «أمس» is one
 * day (from = to = the day before). Blockers: no money, no query change — a range is two dates the screens already sent.
 */
afterEach(() => vi.useRealTimers());

describe('todayRange', () => {
  it('is one day: from and to are today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12, 0, 0));
    expect(todayRange()).toEqual({ from: '2026-11-18', to: '2026-11-18' });
  });
});

describe('the presets', () => {
  const open = (onChange: (r: { from: string; to: string }) => void) => {
    render(<DateRange value={{ from: '', to: '' }} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
  };

  it('أمس picks the one day before today, and اليوم picks today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12, 0, 0));
    const onChange = vi.fn();
    open(onChange);
    fireEvent.click(screen.getByText('أمس'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-17', to: '2026-11-17' });
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getByText('اليوم'));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-18', to: '2026-11-18' });
  });

  it('the strip lists the presets in order: today, yesterday, 7 days, 30 days, this month', () => {
    const onChange = vi.fn();
    open(onChange);
    const labels = ['اليوم', 'أمس', 'آخر 7 أيام', 'آخر 30 يوم', 'هذا الشهر'];
    const found = labels.map((l) => screen.getByText(l));
    for (let i = 1; i < found.length; i++) {
      expect(found[i - 1].compareDocumentPosition(found[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('the figures screens open on today', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const read = (p: string) => (require('node:fs') as typeof import('node:fs')).readFileSync(p, 'utf8');
  it('the audit log and the performance board start from todayRange; the dashboard and the campaigns start on the «today» period', () => {
    expect(read('src/components/screens/AuditScreen.tsx')).toMatch(/useState<Range>\(todayRange\)/);
    expect(read('src/components/screens/PerformanceScreen.tsx')).toMatch(/useState\(todayRange\)/);
    expect(read('src/components/screens/DashboardScreen.tsx')).toMatch(/'all'>\('today'\)/);
    expect(read('src/components/screens/CampaignsScreen.tsx')).toMatch(/useState<string>\('today'\)/);
  });
});
