// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «مين مربوطة بالقواعد» and «افحص موظفة» ON THE RULES PAGE (request Q1b, 19/11) — rendered against a fake door.
 *
 * Nothing behind the sign-in can be opened in a browser here (every account has a second factor only the owner holds), so the
 * section is proven by rendering it. The readiness it draws is the REAL lib's answer (`deskReadiness` → `labelledReadiness`)
 * for real key sets, so a row says what the door would send.
 *
 *  1. One row per person: name, role, bound / exempt by «<key>» / the owner / not at the desk; the tools she lacks with the
 *     missing key's Arabic name; the moderator's mark; a link to her page in «الموظفين».
 *  2. Nobody at the desk → an empty state that says where roles are set.
 *  3. «افحص موظفة» shows each refusal's sentence as the server sent it, the numbers, and a server refusal (a deactivated person).
 *  4. A phone: no table, no class that makes a row wider than the phone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  people: [] as unknown[],
  check: {} as Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string) => {
    h.calls.push(url);
    if (url === '/api/confirmation/rules/people') return { people: h.people };
    // 19/11 (Q2b): the section also asks the day's figures of the rules (`/api/confirmation/rules/fired`) — an empty day here; its own test draws them.
    if (url.startsWith('/api/confirmation/rules/fired')) return { day: '2026-11-19', today: true, timeZone: 'Asia/Damascus', refusalLog: true, truncated: false, people: [] };
    const id = new URL(url, 'http://x').searchParams.get('userId')!;
    const answer = h.check[id];
    if (answer instanceof Error) throw answer;
    return answer;
  }),
}));

import { DeskPeopleTable, DECIDES_WITHOUT_WORK, NOBODY_AT_THE_DESK, WHERE_ROLES_ARE_SET } from './DeskPeopleTable';
import { CHECK_WRITES_NOTHING } from './DeskPersonCheck';
import { deskReadiness, labelledReadiness } from '@/lib/desk-readiness';
import { catalogItem } from '@/lib/permission-catalog';

const AGENT = ['confirmation.work', 'confirmation.pull', 'confirmation.raise_issue', 'confirmation.supervise', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
const readinessOf = (keys: string[], fullAccess = false) => labelledReadiness(deskReadiness((k) => fullAccess || keys.includes(k), { fullAccess }));
const person = (id: string, name: string, keys: string[], fullAccess = false) => ({ id, name, roleLabel: 'دور', readiness: readinessOf(keys, fullAccess) });
const label = (k: string) => catalogItem(k)!.ar;

beforeEach(() => {
  h.calls = [];
  h.check = {};
  h.people = [
    person('sara', 'سارة', AGENT),
    person('lead', 'ليلى', [...AGENT, 'orders.assign']),
    person('noissue', 'هدى', AGENT.filter((k) => k !== 'confirmation.raise_issue')),
    person('mod', 'مازن', ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim']),
    person('owner', 'المالك', [], true),
  ];
});
afterEach(cleanup);

const rowOf = (container: HTMLElement, id: string) => container.querySelector(`[data-person="${id}"]`) as HTMLElement;

describe('the rows', () => {
  it('one row per person, each with her name, her role and a link to her page in «الموظفين»', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/سارة/);
    // 19/11 (Q2b): was `toEqual(['/api/confirmation/rules/people'])` — the section now also asks the rules' figures of the day (`/fired`); the people are still asked once, and the check never unasked.
    expect(h.calls.filter((u) => !u.startsWith('/api/confirmation/rules/fired'))).toEqual(['/api/confirmation/rules/people']);
    const rows = container.querySelectorAll('[data-desk-people] > li');
    expect(rows).toHaveLength(5);
    for (const id of ['sara', 'lead', 'noissue', 'mod', 'owner']) {
      const link = within(rowOf(container, id)).getByRole('link', { name: 'صفحتها بالموظفين' });
      expect(link.getAttribute('href')).toBe(`/admin/users/${id}`);
    }
  });

  it('bound — «مربوطة», even with «confirmation.supervise» (it frees nobody)', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/سارة/);
    const row = rowOf(container, 'sara');
    expect(row.dataset.hold).toBe('BOUND');
    expect(row.querySelector('[data-hold-line]')!.textContent).toBe('مربوطة');
  });

  it('exempt — «مش مربوطة — معها «<the key\'s Arabic name>»»', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/ليلى/);
    const line = rowOf(container, 'lead').querySelector('[data-hold-line]')!.textContent!;
    expect(line).toBe(`مش مربوطة — معها «${label('orders.assign')}»`);
    expect(line).not.toMatch(/[A-Za-z]/);
  });

  it('a missing tool — named, with the key it misses in Arabic', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/هدى/);
    const missing = rowOf(container, 'noissue').querySelector('[data-missing-tools]')!;
    expect(missing.textContent).toContain('إدخال إشكال');
    expect(missing.textContent).toContain(`«${label('confirmation.raise_issue')}»`);
    // NEGATIVE: the agent who holds everything has no such list.
    expect(rowOf(container, 'sara').querySelector('[data-missing-tools]')?.textContent ?? '').not.toContain('إدخال إشكال');
  });

  it('the moderator — not bound, and marked: she decides without working the desk', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/مازن/);
    const row = rowOf(container, 'mod');
    expect(row.dataset.hold).toBe('DOES_NOT_WORK');
    expect(row.querySelector('[data-decides-without-work]')!.textContent).toBe(DECIDES_WITHOUT_WORK);
    // NEGATIVE: nobody who works the desk carries the mark.
    expect(rowOf(container, 'sara').querySelector('[data-decides-without-work]')).toBeNull();
  });

  it('the owner — shown as the owner, never «missing» a key', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/المالك/);
    const row = rowOf(container, 'owner');
    expect(row.dataset.hold).toBe('OWNER');
    expect(row.querySelector('[data-hold-line]')!.textContent).toMatch(/^المالك/);
    expect(row.querySelector('[data-missing-tools]')).toBeNull();
  });
});

describe('nobody at the desk', () => {
  it('says so, says where roles are set, and offers «الصلاحيات»; no check panel', async () => {
    h.people = [];
    const { container } = render(<DeskPeopleTable />);
    await screen.findByText(NOBODY_AT_THE_DESK);
    expect(screen.getByText(WHERE_ROLES_ARE_SET)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'افتح «الصلاحيات»' }).getAttribute('href')).toBe('/admin/permissions');
    expect(container.querySelector('[data-desk-check]')).toBeNull();
  });
});

describe('«افحص موظفة»', () => {
  const answer = (pull: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    person: { id: 'sara', name: 'سارة' },
    hold: { inHand: 2, heldForHer: 1, load: 3, limit: 5, limitFrom: 'HAND', withoutAttempt: 1, withoutAttemptLimit: 40 },
    pace: { pulled: 7, perHour: 40, windowMinutes: 60 },
    pull,
    ...over,
  });

  async function pickAndCheck(id = 'sara') {
    const user = userEvent.setup();
    render(<DeskPeopleTable />);
    const select = (await screen.findByLabelText('الموظفة')) as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['اختار اسم', 'سارة', 'ليلى', 'هدى', 'مازن', 'المالك']);
    await user.selectOptions(select, id);
    await user.click(screen.getByRole('button', { name: 'افحص' }));
  }

  it.each([
    ['UNTOUCHED_ORDER', 'سجّل محاولة اتصال على الطلب ORD-7 قبل سحب طلب جديد.'],
    ['CAP_TOTAL', 'إيدك مليانة.'],
    ['CAP_WITHOUT_ATTEMPT', 'لديك 40 طلباً بلا محاولة اتصال — الحد 40.'],
    ['WORK_FIRST', 'عليك اتصالات قبل سحب طلب جديد.'],
    ['PULL_TOO_FAST', 'سحبت 40 طلباً خلال آخر 60 دقيقة — الحد 40.'],
    ['NO_PULL_KEY', 'ما معها «سحب» — السحب بيرفضها من أول ضغطة.'],
  ])('%s — the server\'s sentence, as it came', async (code, sentence) => {
    h.check.sara = answer({ open: false, code, sentence });
    await pickAndCheck();
    const line = await screen.findByText(`لو ضغطت «اسحب» هلّق: ${sentence}`);
    expect(line.getAttribute('data-pull-code')).toBe(code);
    expect(h.calls).toContain('/api/confirmation/rules/check?userId=sara');
  });

  it('open — the sentence, and her three numbers, and that the check writes nothing', async () => {
    h.check.sara = answer({ open: true, code: null, sentence: 'السحب مفتوح إلها هلّق.' });
    await pickAndCheck();
    const box = (await screen.findByText(/السحب مفتوح/)).closest('[data-check-answer]') as HTMLElement;
    expect(box.textContent).toContain('بإيدها 2 و1 محجوزين إلها — المجموع 3 من 5 (حد اليد)');
    expect(box.textContent).toContain('بلا محاولة اتصال: 1 — الحد 40');
    expect(box.textContent).toContain('سحبت 7 خلال آخر 60 دقيقة — الحد 40');
    expect(box.textContent).toContain(CHECK_WRITES_NOTHING);
    expect(box.querySelector('[data-pull-code]')!.getAttribute('data-pull-code')).toBe('OPEN');
  });

  // Q4b (21/11): the door now also answers her three numbers, each with the source in the server's words; the panel says them as three lines.
  it('her numbers and where each came from — the server\'s words, as they came; an older answer without them draws no list', async () => {
    const numbers = {
      hand: { value: 2, from: 'من قاعدة «الجديدة»' },
      idleMinutes: { value: 20, from: 'من القاعدة الأساسية' },
      pullPerHour: { value: 12, from: 'من قاعدة «الجديدة»' },
    };
    h.check.sara = answer({ open: true, code: null, sentence: 'السحب مفتوح إلها هلّق.' }, { numbers });
    await pickAndCheck();
    const list = (await screen.findByLabelText('أرقامها')) as HTMLElement;
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'حد اليد إلها: 2 — من قاعدة «الجديدة»',
      'مهلة الطلب المتروك إلها: 20 دقيقة دوام — من القاعدة الأساسية',
      'سرعة السحب إلها: 12 طلب بالساعة — من قاعدة «الجديدة»',
    ]);
  });

  it('NEGATIVE: an answer without numbers draws no numbers list', async () => {
    h.check.sara = answer({ open: true, code: null, sentence: 'السحب مفتوح إلها هلّق.' });
    await pickAndCheck();
    await screen.findByText(/السحب مفتوح/);
    expect(document.querySelector('[data-check-numbers]')).toBeNull();
  });

  it('the cap of 500 is named «السقف», and no «محجوز» when nothing is held for her', async () => {
    h.check.sara = answer({ open: true, code: null, sentence: 'مفتوح.' }, { hold: { inHand: 4, heldForHer: 0, load: 4, limit: 500, limitFrom: 'CAP', withoutAttempt: 0, withoutAttemptLimit: 40 } });
    await pickAndCheck();
    const box = (await screen.findByText(/مفتوح\./)).closest('[data-check-answer]') as HTMLElement;
    expect(box.textContent).toContain('بإيدها 4 — المجموع 4 من 500 (السقف)');
    expect(box.textContent).not.toContain('محجوز');
  });

  it('a person deactivated since the page opened — the server\'s refusal is said, no numbers', async () => {
    h.check.mod = new Error('هالموظفة موقوفة — ما بتشتغل على المكتب هلّق');
    await pickAndCheck('mod');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('هالموظفة موقوفة — ما بتشتغل على المكتب هلّق');
    expect(document.querySelector('[data-check-answer]')).toBeNull();
  });

  it('NEGATIVE: no name picked — the button is off and nothing is asked', async () => {
    render(<DeskPeopleTable />);
    await screen.findByLabelText('الموظفة');
    const button = screen.getByRole('button', { name: 'افحص' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(h.calls.filter((u) => !u.startsWith('/api/confirmation/rules/fired'))).toEqual(['/api/confirmation/rules/people']));
  });
});

describe('a phone, and the kit', () => {
  const code = (f: string) => readFileSync(join(process.cwd(), 'src/components/confirmation', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('no table and no class wider than the phone; rows stack until md', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/سارة/);
    expect(container.querySelector('table')).toBeNull();
    const row = rowOf(container, 'sara');
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bmd:flex-row\b/);
    for (const f of ['DeskPeopleTable.tsx', 'DeskPersonCheck.tsx']) {
      for (const bad of [/\bw-\[/, /\bmin-w-\[/, /\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/, /\btruncate\b/]) {
        expect(code(f), `${f}: ${bad}`).not.toMatch(bad);
      }
    }
  });

  it('no raw button, no raw select, no hand-made card: the kit only', () => {
    for (const f of ['DeskPeopleTable.tsx', 'DeskPersonCheck.tsx']) {
      expect(code(f), f).not.toMatch(/<button\b|<select\b|<input\b/);
      expect(code(f), f).not.toMatch(/bg-\[var\(--sys-card\)\]/);
    }
  });

  it('every word drawn is Arabic: no English in what the section says', async () => {
    const { container } = render(<DeskPeopleTable />);
    await screen.findAllByText(/سارة/);
    expect(container.textContent).not.toMatch(/[A-Za-z]/);
  });
});

describe('where it stands', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('on the rules page, once, right under the box', () => {
    const rules = read('src/components/screens/ConfirmationRulesScreen.tsx');
    expect(rules).toContain("import { DeskPeopleTable } from '@/components/confirmation/DeskPeopleTable';");
    expect(rules.match(/<DeskPeopleTable \/>/g)).toHaveLength(1);
    expect(rules.indexOf('<DeskPeopleTable />')).toBeLessThan(rules.indexOf('<CallProofCard />'));
  });

  it('NEGATIVE: never on the desk — «طلباتي» imports neither part (its bundle sits at its ceiling)', () => {
    const desk = read('src/components/screens/ConfirmationMineScreen.tsx');
    expect(desk).not.toMatch(/DeskPeopleTable|DeskPersonCheck|desk-readiness|desk-exempt-keys/);
  });
});
