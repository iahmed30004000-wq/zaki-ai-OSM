// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q3c, 20/11) — «أرقام القاعدة», the numbers editor on the rules page.
 *
 * The card talks to the REAL door (`/api/settings/confirmation-rule`, request Q3a): `apiJson` is routed to the route's own GET / PUT / POST,
 * over an in-memory settings document — so every range, every refusal sentence and every field name the card shows is the server's.
 *
 *  1. Every control: one box per number with the server's range under it, the steps as a list (kind · minutes or anchor + hours ·
 *     up · down · remove · add), «يسري» with «من بداية الدوام الجاي» chosen, the save.
 *  2. Save → read back; «من بداية الدوام الجاي» → pending with its moment and «إلغاء»; «رجّع» → the version is back; the box above is
 *     read again after every write (`router.refresh`).
 *  3. A refused save: the server's sentence beside THE field that caused it, everything typed kept, nothing stored.
 *  4. Two people: the second save is told somebody saved first; last write wins; the versions show both authors.
 *  5. Read-only without the edit key: every box locked, no button, the key's name said.
 *  6. The phone: one column, nothing that scrolls sideways. Never imported by the desk; only TYPES of the rule's lib.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  store: { docs: {} as Record<string, Record<string, unknown>> },
  ctx: { companyId: 'c0', userId: 'owner' },
  can: { value: true },
  refresh: vi.fn(),
  calls: [] as { url: string; method: string; body: unknown }[],
}));

vi.mock('@/lib/db', () => ({
  db: { company: { findUnique: async ({ where }: { where: { id: string } }) => ({ settings: JSON.stringify(h.store.docs[where.id] ?? {}) }) } },
}));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: h.ctx.userId },
    companyId: h.ctx.companyId,
    storeId: 's1',
    countryId: 'k1',
    country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => ({ id: h.ctx.userId }) }));
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (companyId: string, key: string, change: (cur: unknown) => unknown) => {
    const all = (h.store.docs[companyId] ??= {});
    const next = change(all[key]);
    all[key] = next;
    return next;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => k === 'settings.manage' && h.can.value }));

const NAMES: Record<string, string> = { owner: 'المالك', manager: 'المديرة' };
const KEY_LABEL = 'إعدادات النظام الحسّاسة — مفاتيح شركات الشحن وحسابات الإعلانات ومزوّد الذكاء';

vi.mock('@/lib/api-client', async () => {
  const door = await import('@/app/api/settings/confirmation-rule/route');
  return {
    apiJson: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      h.calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === '/api/settings/confirmation-rule/editors') return { keyLabel: KEY_LABEL, editors: [{ id: 'manager', name: NAMES.manager }, { id: 'owner', name: NAMES.owner }], names: NAMES };
      const req = new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: init?.body });
      const res = method === 'GET' ? await door.GET() : method === 'PUT' ? await door.PUT(req) : await door.POST(req);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.errorAr || data.error), { data });
      return data;
    },
  };
});

import { BACK_TO_DEFAULT, ConfirmationRuleEditor, NUMBER_LABELS, SOMEONE_SAVED_FIRST, WHEN_OPTIONS } from './ConfirmationRuleEditor';
import { PUT } from '@/app/api/settings/confirmation-rule/route';
import { CONFIRMATION_RULE_DEFAULT, CONFIRMATION_RULE_RANGES, type ConfirmationRuleNumbers } from '@/lib/confirmation-rule-settings';
import type { RuleAnswer } from './ConfirmationRuleEditor';

// The editor writes the door's answer shape by hand (it may import nothing of the lib): if the lib's rule changes shape, this stops compiling.
const _sameShape: [ConfirmationRuleNumbers, RuleAnswer['rule']] = [{} as Omit<RuleAnswer['rule'], 'attempts'>, {} as ConfirmationRuleNumbers & { attempts: number }];
void _sameShape;

let n = 0;
beforeEach(() => {
  h.ctx.companyId = `editor-${++n}`; // the reader caches per company: a fresh one per test
  h.ctx.userId = 'owner';
  h.store.docs[h.ctx.companyId] = {};
  h.can.value = true;
  h.calls = [];
  h.refresh.mockClear();
});
afterEach(cleanup);

const ruleCalls = () => h.calls.filter((c) => c.url === '/api/settings/confirmation-rule');
const stored = () => h.store.docs[h.ctx.companyId].confirmationRule as any;
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
/** The text printed in the same wrapper as the box — its range, or the server's refusal. */
const besideBox = (label: string) => box(label).parentElement!.textContent ?? '';
const type = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });
const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const chooseNow = () => fireEvent.click(screen.getByRole('radio', { name: 'هلق' }));
async function open() {
  const view = render(<ConfirmationRuleEditor />);
  await screen.findByText('أرقام القاعدة');
  await screen.findByText(/مين بيقدر يعدّل/);
  return view;
}

describe('1 · every control, with the server\'s range under it', () => {
  it('one box per number, its range printed under it, the two anchors, today\'s values', async () => {
    await open();
    for (const [field, label] of Object.entries(NUMBER_LABELS)) {
      const r = CONFIRMATION_RULE_RANGES[field as keyof typeof CONFIRMATION_RULE_RANGES];
      expect(box(label).value, field).toBe(String(CONFIRMATION_RULE_DEFAULT[field as keyof typeof NUMBER_LABELS]));
      expect(besideBox(label), field).toContain(`من ${r.min} لـ${r.max}`);
    }
    expect(box('موعد الصبح').value).toBe(CONFIRMATION_RULE_DEFAULT.morning);
    expect(box('موعد المسا').value).toBe(CONFIRMATION_RULE_DEFAULT.evening);
  });

  it('the steps as a list: today\'s four, each with its kind, its number and its range; attempts = steps + 1', async () => {
    const { container } = await open();
    expect(container.querySelectorAll('[data-step]')).toHaveLength(4);
    expect(container.querySelector('[data-steps]')!.textContent).toContain('المحاولات: 5');
    expect(box('الخطوة 1: بعد كم دقيقة').value).toBe('30');
    expect(besideBox('الخطوة 1: بعد كم دقيقة')).toContain(`من ${CONFIRMATION_RULE_RANGES.afterMinutes.min} لـ${CONFIRMATION_RULE_RANGES.afterMinutes.max}`);
    expect(box('الخطوة 3: مش قبل كم ساعة من اللي قبلها').value).toBe('8');
    expect(besideBox('الخطوة 3: مش قبل كم ساعة من اللي قبلها')).toContain(`من ${CONFIRMATION_RULE_RANGES.floorHours.min} لـ${CONFIRMATION_RULE_RANGES.floorHours.max}`);
    expect(screen.getByRole('radiogroup', { name: 'موعد الخطوة 4' }).querySelector('[aria-checked="true"]')!.textContent).toContain('موعد المسا');
  });

  it('«يسري» offers «هلق» and «من بداية الدوام الجاي», the second chosen, with the server\'s moment printed', async () => {
    const { container } = await open();
    const group = screen.getByRole('radiogroup', { name: 'يسري' });
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(WHEN_OPTIONS.map((o) => o.label));
    expect(group.querySelector('[aria-checked="true"]')!.textContent).toBe('من بداية الدوام الجاي');
    expect(container.querySelector('[data-next-start]')!.textContent).toContain('بداية الدوام الجاي:');
  });

  it('add · remove · up · down: within 2 to 6, and only the order of the list changes', async () => {
    const { container } = await open();
    const steps = () => container.querySelectorAll('[data-step]').length;
    fireEvent.click(screen.getByRole('button', { name: 'نزّل الخطوة 1 لتحت' }));
    expect(box('الخطوة 1: بعد كم دقيقة').value).toBe('120');
    expect(box('الخطوة 2: بعد كم دقيقة').value).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'طلّع الخطوة 2 لفوق' }));
    expect(box('الخطوة 1: بعد كم دقيقة').value).toBe('30');
    expect((screen.getByRole('button', { name: 'طلّع الخطوة 1 لفوق' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'زيد خطوة' }));
    fireEvent.click(screen.getByRole('button', { name: 'زيد خطوة' }));
    expect(steps()).toBe(6);
    expect((screen.getByRole('button', { name: 'زيد خطوة' }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 6; i > 2; i--) fireEvent.click(screen.getByRole('button', { name: `شيل الخطوة ${i}` }));
    expect(steps()).toBe(2);
    expect((screen.getByRole('button', { name: 'شيل الخطوة 1' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a step changes kind: «على موعد» shows the anchor and its hours', async () => {
    await open();
    const kind = screen.getByRole('radiogroup', { name: 'نوع الخطوة 1' });
    fireEvent.click(kind.querySelector('[role="radio"]:not([aria-checked="true"])')!);
    expect(screen.getByRole('radiogroup', { name: 'موعد الخطوة 1' })).toBeTruthy();
    expect(box('الخطوة 1: مش قبل كم ساعة من اللي قبلها').value).toBe('8');
  });
});

describe('2 · save, pending, cancel, «رجّع» — and the box above is read again', () => {
  it('«هلق»: saved, stored, read back, and the page refreshed', async () => {
    await open();
    type(NUMBER_LABELS.hand, '5');
    chooseNow();
    await press('احفظ الأرقام');
    await waitFor(() => expect(stored()?.current.hand).toBe(5));
    expect(h.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ when: 'NOW', rule: expect.objectContaining({ hand: 5 }) });
    expect(box(NUMBER_LABELS.hand).value).toBe('5');
    expect(h.refresh).toHaveBeenCalled();
    // the default it replaced is the first version, with «رجّع»
    expect(screen.getByText(/الأرقام الأصلية · انتهت/)).toBeTruthy();
  });

  it('the default «من بداية الدوام الجاي»: pending with its moment and who saved it; «إلغاء التعديل المعلّق» drops it', async () => {
    const { container } = await open();
    type(NUMBER_LABELS.proofSeconds, '45');
    await press('احفظ الأرقام');
    const pending = await waitFor(() => container.querySelector('[data-pending]')!);
    expect(pending.textContent).toContain('في تعديل معلّق — بيسري');
    expect(pending.textContent).toContain('حفظو المالك');
    expect(pending.textContent).toContain('إثبات 45 ثانية');
    expect(new Date(stored().effectiveAt).getTime()).toBeGreaterThan(Date.now());
    await press('إلغاء التعديل المعلّق');
    await waitFor(() => expect(container.querySelector('[data-pending]')).toBeNull());
    expect(stored().current.proofSeconds).toBe(CONFIRMATION_RULE_DEFAULT.proofSeconds);
    expect(ruleCalls().at(-1)).toMatchObject({ method: 'POST', body: { action: 'revert' } });
  });

  it('«رجّع» on a version brings it back now', async () => {
    const { container } = await open();
    type(NUMBER_LABELS.hand, '7');
    chooseNow();
    await press('احفظ الأرقام');
    await waitFor(() => expect(container.querySelector('[data-version="0"]')).toBeTruthy());
    await act(async () => {
      fireEvent.click(container.querySelector('[data-version="0"] button')!);
    });
    await waitFor(() => expect(stored().current.hand).toBe(CONFIRMATION_RULE_DEFAULT.hand));
    expect(ruleCalls().at(-1)).toMatchObject({ method: 'POST', body: { action: 'revert', version: 0 } });
    expect(box(NUMBER_LABELS.hand).value).toBe(String(CONFIRMATION_RULE_DEFAULT.hand));
  });
});

describe('3 · a refused save: the server\'s sentence beside its field, what was typed kept, nothing stored', () => {
  const refusedAt = async (label: string, value: string, sentence: RegExp) => {
    await open();
    type(label, value);
    await press('احفظ الأرقام');
    await waitFor(() => expect(besideBox(label)).toMatch(sentence));
    expect(box(label).value).toBe(value);
    expect(stored()).toBeUndefined();
    expect(h.refresh).not.toHaveBeenCalled();
  };

  it('hand 11 → «حد اليد…» under the hand box', () => refusedAt(NUMBER_LABELS.hand, '11', /حد اليد لازم يكون رقم صحيح من 1 لـ10/));
  it('proof 14 → under the proof box', () => refusedAt(NUMBER_LABELS.proofSeconds, '14', /ثواني إثبات الاتصال لازم تكون/));
  it('minDays 4 → under the days box', () => refusedAt(NUMBER_LABELS.minDays, '4', /عدد الأيام المختلفة لازم يكون رقم صحيح من 1 لـ3/));
  it('two days with no anchor step left → «أكتر من اللي بتسمح فيه الخطوات», under the days box', async () => {
    await open();
    for (const i of [3, 4]) {
      const kind = screen.getByRole('radiogroup', { name: `نوع الخطوة ${i}` });
      fireEvent.click(kind.querySelector('[role="radio"]:not([aria-checked="true"])')!);
    }
    await press('احفظ الأرقام');
    await waitFor(() => expect(besideBox(NUMBER_LABELS.minDays)).toMatch(/عدد الأيام المختلفة أكتر من اللي بتسمح فيه الخطوات/));
    expect(stored()).toBeUndefined();
  });
  it('step 2 at 5 minutes → under step 2, not step 1', async () => {
    await refusedAt('الخطوة 2: بعد كم دقيقة', '5', /الخطوة 2: «بعد كم دقيقة»/);
    expect(besideBox('الخطوة 1: بعد كم دقيقة')).not.toMatch(/لازم/);
  });
  it('the evening before the morning → under the evening box', () => refusedAt('موعد المسا', '10:00', /موعد الصبح لازم يكون قبل موعد المسا/));
  it('an empty box goes as it is and the SERVER refuses it — the browser decides nothing', async () => {
    await refusedAt(NUMBER_LABELS.postponeMax, '', /حد تأجيل الزبون لازم يكون/);
    expect((h.calls.find((c) => c.method === 'PUT')!.body as any).rule.postponeMax).toBeNull();
  });
  it('a sentence goes away on the next good save', async () => {
    await refusedAt(NUMBER_LABELS.hand, '11', /حد اليد/);
    type(NUMBER_LABELS.hand, '4');
    await press('احفظ الأرقام');
    await waitFor(() => expect(stored()?.current.hand).toBe(4));
    expect(besideBox(NUMBER_LABELS.hand)).not.toMatch(/لازم/);
  });
});

describe('4 · two people editing', () => {
  it('the second save is told somebody saved first; last write wins; the versions show both authors', async () => {
    const { container } = await open();
    // another person saves while this card is open
    h.ctx.userId = 'manager';
    await PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ rule: { ...structuredClone(CONFIRMATION_RULE_DEFAULT), hand: 2 }, when: 'NOW' }) }));
    h.ctx.userId = 'owner';
    type(NUMBER_LABELS.hand, '6');
    chooseNow();
    await press('احفظ الأرقام');
    await waitFor(() => expect(stored().current.hand).toBe(6));
    expect(container.querySelector('[data-notice]')!.textContent).toBe(SOMEONE_SAVED_FIRST);
    const versions = [...container.querySelectorAll('[data-version]')].map((v) => v.textContent);
    expect(versions[0]).toContain('المديرة');
    expect(versions[0]).toContain('حد اليد 2');
    expect(versions[1]).toContain('الأرقام الأصلية');
    expect(container.querySelector('[data-last-save]')!.textContent).toContain('المالك');
  });
});

describe('5 · read-only without the edit key', () => {
  it('every box locked, no save, no «رجّع», no add — and the key it needs, by name', async () => {
    h.can.value = false;
    h.store.docs[h.ctx.companyId].confirmationRule = undefined;
    const { container } = await open();
    for (const label of [...Object.values(NUMBER_LABELS), 'موعد الصبح', 'موعد المسا', 'الخطوة 1: بعد كم دقيقة']) expect(box(label).disabled, label).toBe(true);
    expect(screen.queryByRole('button', { name: 'احفظ الأرقام' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'زيد خطوة' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'يسري' })).toBeNull();
    expect(container.querySelector('[data-read-only]')!.textContent).toContain(`«${KEY_LABEL}»`);
  });

  it('NEGATIVE: with the key there is no read-only line', async () => {
    const { container } = await open();
    expect(container.querySelector('[data-read-only]')).toBeNull();
  });
});

describe('6 · the phone, the desk, the engine', () => {
  const code = readFileSync(join(process.cwd(), 'src/components/settings/ConfirmationRuleEditor.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('one column on a phone, two from `sm`; no class that makes a row wider than its parent', async () => {
    const { container } = await open();
    expect(container.querySelector('[data-numbers]')!.className.split(' ')).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
    for (const bad of [/\bw-\[/, /\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/]) expect(code, String(bad)).not.toMatch(bad);
  });

  it('the kit only: no raw button, no raw checkbox, no hand-made card', () => {
    expect(code).not.toMatch(/<button[\s>]/);
    expect(code).not.toMatch(/type="checkbox"/);
  });

  it('nothing of the rule\'s lib reaches the browser, and the desk never imports the editor', () => {
    expect(code).not.toMatch(/confirmation-rule-settings'/);
    expect(code).not.toMatch(/from '@\/lib\/(db|confirmation-queue|no-answer-cadence|confirmation-rule)'/);
    const desk = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8');
    expect(desk).not.toContain('ConfirmationRuleEditor');
  });

  it('on the rules page, once', () => {
    const rules = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationRulesScreen.tsx'), 'utf8');
    expect(rules.match(/<ConfirmationRuleEditor \/>/g)).toHaveLength(1);
  });
});

// ADDED 2026-11-21 (request Q4c, the owner's decision of 20/11): the base numbers keep their defaults with «رجّع الافتراضي».
describe('7 · «رجّع الافتراضي» fills the defaults — and saves nothing until «احفظ الأرقام»', () => {
  it('after an edit is saved, the button puts the defaults back in every box; only the save stores them', async () => {
    await open();
    type(NUMBER_LABELS.hand, '6');
    type(NUMBER_LABELS.proofSeconds, '60');
    chooseNow();
    await press('احفظ الأرقام');
    await waitFor(() => expect(stored()?.current.hand).toBe(6));
    const puts = h.calls.filter((c) => c.method === 'PUT').length;
    await press(BACK_TO_DEFAULT);
    for (const [field, label] of Object.entries(NUMBER_LABELS)) {
      expect(box(label).value, field).toBe(String(CONFIRMATION_RULE_DEFAULT[field as keyof typeof NUMBER_LABELS]));
    }
    expect(box('الخطوة 1: بعد كم دقيقة').value).toBe('30');
    expect(h.calls.filter((c) => c.method === 'PUT')).toHaveLength(puts);
    expect(stored().current.hand).toBe(6);
    chooseNow();
    await press('احفظ الأرقام');
    await waitFor(() => expect(stored().current.hand).toBe(CONFIRMATION_RULE_DEFAULT.hand));
    expect(stored().current.proofSeconds).toBe(CONFIRMATION_RULE_DEFAULT.proofSeconds);
  });

  it('NEGATIVE: without the edit key there is no «رجّع الافتراضي»', async () => {
    h.can.value = false;
    await open();
    expect(screen.queryByRole('button', { name: BACK_TO_DEFAULT })).toBeNull();
  });
});
