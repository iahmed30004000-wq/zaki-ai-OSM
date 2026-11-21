// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q4c, 21/11) — a rule written on the page is «visible in مين مربوطة with its source».
 *
 *  1. Each row prints her three numbers as the server wrote them: the value and «من القاعدة الأساسية» or «من قاعدة «…»».
 *  2. A number that does not act now (the Q4b reviewer's note: the hand while the switches it rides on are off) says so — «ما بيشتغل هلق».
 *  3. «افحص موظفة» says the same.
 *  4. An older server, or a read that failed (`numbers: null`): no line, nothing invented.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({ people: [] as unknown[], check: null as unknown }));

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string) => {
    if (url === '/api/confirmation/rules/people') return { people: h.people };
    if (url.startsWith('/api/confirmation/rules/fired')) return { day: '2026-11-21', today: true, timeZone: 'Asia/Damascus', refusalLog: true, truncated: false, people: [] };
    return h.check;
  }),
}));

import { DeskPeopleTable } from './DeskPeopleTable';
import { NOT_ACTING_NOW, numbersSentences } from './DeskPersonCheck';
import { deskReadiness, labelledReadiness } from '@/lib/desk-readiness';

const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
const readiness = labelledReadiness(deskReadiness((k) => AGENT.includes(k)));
const base = (value: number) => ({ value, source: { from: 'BASE' }, from: 'من القاعدة الأساسية' });
const fromRule = (value: number) => ({ value, source: { from: 'RULE', ruleId: 'r1', name: 'سارة أسبوع', level: 3 }, from: 'من قاعدة «سارة أسبوع»' });

beforeEach(() => {
  h.people = [
    {
      id: 'sara', name: 'سارة', roleLabel: 'موظفة', readiness,
      numbers: { hand: fromRule(2), idleMinutes: base(20), pullPerHour: base(40), inForce: { hand: true, idleMinutes: true, pullPerHour: true } },
    },
    {
      id: 'huda', name: 'هدى', roleLabel: 'موظفة', readiness,
      numbers: { hand: base(3), idleMinutes: base(20), pullPerHour: base(40), inForce: { hand: false, idleMinutes: false, pullPerHour: true } },
    },
    { id: 'old', name: 'ليلى', roleLabel: 'موظفة', readiness, numbers: null },
  ];
});
afterEach(cleanup);

const row = (c: HTMLElement, id: string) => c.querySelector(`[data-person="${id}"]`) as HTMLElement;

describe('her numbers in «مين مربوطة»', () => {
  it('the value and the rule it came from, as the server wrote them', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/سارة/);
    const lines = row(container, 'sara').querySelector('[data-person-numbers]')!.textContent!;
    expect(lines).toContain('حد اليد إلها: 2 — من قاعدة «سارة أسبوع»');
    expect(lines).toContain('سرعة السحب إلها: 40 طلب بالساعة — من القاعدة الأساسية');
    expect(lines).not.toContain(NOT_ACTING_NOW);
  });

  it('a number that does not act now says so; the pace (always on) does not', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/هدى/);
    const items = [...row(container, 'huda').querySelectorAll('[data-person-numbers] li')].map((li) => li.textContent);
    expect(items[0]).toContain(`(${NOT_ACTING_NOW})`);
    expect(items[1]).toContain(`(${NOT_ACTING_NOW})`);
    expect(items[2]).not.toContain(NOT_ACTING_NOW);
  });

  it('NEGATIVE: no numbers from the server → no line, nothing invented', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/ليلى/);
    expect(row(container, 'old').querySelector('[data-person-numbers]')).toBeNull();
  });

  it('an older server without `inForce`: the numbers, and no word about acting', () => {
    const lines = numbersSentences({ hand: base(3), idleMinutes: base(20), pullPerHour: base(40) });
    expect(lines.join(' ')).not.toContain(NOT_ACTING_NOW);
  });
});
