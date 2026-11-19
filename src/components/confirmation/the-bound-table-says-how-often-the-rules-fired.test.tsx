// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القاعدة اشتغلت عندها كم مرة» ON THE RULES PAGE (request Q2b, 19/11) — rendered against a fake door.
 *
 * Nothing behind the sign-in can be opened in a browser here (every account has a second factor only the owner holds), so the
 * figures are proven by rendering them:
 *
 *  1. Each row carries her day's figures EXACTLY as the server sent them, and her refusals by name.
 *  2. The red line «اشتغلت اليوم وما في قاعدة مسكتها» is the server's sentence, in the danger colour — and only on her row.
 *  3. The day box offers today and yesterday only; «أمس» asks the door for the store's yesterday.
 *  4. The door refused (no `team.monitor`) or the refusal log is missing: the people still show, and the screen says why.
 *  5. The screen adds nothing up, and every word it draws is Arabic.
 * ═══════════════════════════════════════════════════════════════════════
 */

const TZ = 'Asia/Damascus';
const h = vi.hoisted(() => ({
  people: [] as unknown[],
  fired: null as unknown,
  calls: [] as string[],
}));

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string) => {
    h.calls.push(url);
    if (url === '/api/confirmation/rules/people') return { people: h.people };
    if (url.startsWith('/api/confirmation/rules/fired')) {
      if (h.fired instanceof Error) throw h.fired;
      const day = new URL(url, 'http://x').searchParams.get('day');
      return { ...(h.fired as object), ...(day ? { day, today: false } : {}) };
    }
    throw new Error('unexpected ' + url);
  }),
}));

import { DeskPeopleTable, FIRED_LABELS, NO_REFUSAL_LOG } from './DeskPeopleTable';
import { presetRange } from '@/components/ui/DateRange';
import { deskReadiness, labelledReadiness } from '@/lib/desk-readiness';
import { ALARM_TODAY_AR } from '@/lib/rule-fired';

const AGENT = ['confirmation.work', 'confirmation.pull', 'confirmation.raise_issue', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
const person = (id: string, name: string, keys: string[]) => ({ id, name, roleLabel: 'دور', readiness: labelledReadiness(deskReadiness((k) => keys.includes(k))) });
const zeros = { pulls: 0, idleReturns: 0, noAnswerReturns: 0, countedNoAnswer: 0, earlyNoAnswer: 0, autoCloses: 0, callProofRefusals: 0, decided: 0, refusals: [], alarmAr: null };
const today = presetRange('today', new Date(), TZ)!.from;

beforeEach(() => {
  h.calls = [];
  h.people = [person('sara', 'سارة', AGENT), person('mod', 'مازن', ['orders.view', 'orders.confirm', 'orders.contact_log']), person('idle', 'هدى', AGENT)];
  h.fired = {
    day: today,
    today: true,
    timeZone: TZ,
    refusalLog: true,
    truncated: false,
    people: [
      { ...zeros, userId: 'sara', hold: 'BOUND', pulls: 17, idleReturns: 4, noAnswerReturns: 6, countedNoAnswer: 9, earlyNoAnswer: 2, autoCloses: 1, callProofRefusals: 3, decided: 11, refusals: [{ code: 'CAP_TOTAL', labelAr: 'إيدها مليانة', count: 5 }] },
      { ...zeros, userId: 'mod', hold: 'DOES_NOT_WORK', decided: 8, alarmAr: ALARM_TODAY_AR },
      { ...zeros, userId: 'idle', hold: 'BOUND' },
    ],
  };
});
afterEach(cleanup);

const rowOf = (container: HTMLElement, id: string) => container.querySelector(`[data-person="${id}"]`) as HTMLElement;
const counter = (row: HTMLElement, key: string) => row.querySelector(`[data-counter="${key}"]`)?.textContent;

describe('her figures, as the server sent them', () => {
  it('every counter on her row is the server’s number, after its Arabic name', async () => {
    const { container } = render(<DeskPeopleTable />);
    await waitFor(() => expect(rowOf(container, 'sara')?.querySelector('[data-fired-counters]')).not.toBeNull());
    const sara = rowOf(container, 'sara');
    const sent = (h.fired as any).people[0];
    for (const [key, label] of FIRED_LABELS) expect(counter(sara, key)).toBe(`${label}: ${sent[key]}`);
    expect(within(sara).getByText('انرفضت — إيدها مليانة: 5')).toBeTruthy();
  });

  it('a person with no activity shows zeros, not nothing', async () => {
    const { container } = render(<DeskPeopleTable />);
    await waitFor(() => expect(rowOf(container, 'idle')?.querySelector('[data-fired-counters]')).not.toBeNull());
    expect(counter(rowOf(container, 'idle'), 'pulls')).toBe('سحب: 0');
    expect(rowOf(container, 'idle').querySelector('[data-fired-refusals]')).toBeNull();
  });

  it('the red line is the server’s sentence, in the danger colour, on her row only', async () => {
    const { container } = render(<DeskPeopleTable />);
    const line = await screen.findByText(ALARM_TODAY_AR);
    expect(rowOf(container, 'mod').contains(line)).toBe(true);
    expect(line.className).toMatch(/text-\[var\(--sys-destructive\)\]/);
    expect(container.querySelectorAll('[data-alarm]')).toHaveLength(1);
  });
});

describe('the day', () => {
  it('opens on the store’s today, offers only «اليوم» and «أمس», and «أمس» asks for that day', async () => {
    render(<DeskPeopleTable />);
    await screen.findByText(ALARM_TODAY_AR);
    expect(h.calls).toContain('/api/confirmation/rules/fired');
    const box = document.querySelector('[data-fired-day]') as HTMLElement;
    fireEvent.click(within(box).getAllByRole('button')[0]);
    expect(within(box).getByText('اليوم')).toBeTruthy();
    expect(within(box).queryByText('آخر 7 أيام')).toBeNull();
    expect(within(box).queryByText('هذا الشهر')).toBeNull();
    fireEvent.click(within(box).getByText('أمس'));
    const yesterday = presetRange('yesterday', new Date(), TZ)!.from;
    await waitFor(() => expect(h.calls).toContain(`/api/confirmation/rules/fired?day=${yesterday}`));
  });
});

describe('when the figures cannot come', () => {
  it('the door refused: the people still show, and the screen says the figures did not come', async () => {
    h.fired = new Error('ما معك صلاحية «مراقبة الفريق»');
    const { container } = render(<DeskPeopleTable />);
    await screen.findByText(/أرقام القواعد ما وصلت/);
    expect(rowOf(container, 'sara')).not.toBeNull();
    expect(container.querySelector('[data-fired-counters]')).toBeNull();
  });

  it('the refusal log is missing: said once, the other figures stand', async () => {
    (h.fired as any).refusalLog = false;
    const { container } = render(<DeskPeopleTable />);
    await screen.findByText(NO_REFUSAL_LOG);
    expect(counter(rowOf(container, 'sara'), 'pulls')).toBe('سحب: 17');
  });
});

describe('the screen counts nothing', () => {
  const code = readFileSync(join(process.cwd(), 'src/components/confirmation/DeskPeopleTable.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('NEGATIVE: no sum, no reduce, no arithmetic over a figure — and the lib comes in as types only', () => {
    expect(code).not.toMatch(/\.reduce\(/);
    expect(code).not.toMatch(/fired\.\w+\s*[-+*/]|[-+*/]\s*fired\.\w+|\bcount\s*[-+*/]/);
    expect(code).toMatch(/import type \{ FiredPerson, RuleFiredAnswer \} from '@\/lib\/rule-fired';/);
  });

  it('every word drawn is Arabic', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findByText(ALARM_TODAY_AR);
    expect(container.textContent).not.toMatch(/[A-Za-z]/);
  });
});
