// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q4c, 21/11) — «قواعد خاصة» on the rules page, rendered.
 *
 *  1. Two ways in, SIDE BY SIDE: «قوالب جاهزة» (the eight, every one «مطفية»; the kinds that do not act yet greyed with the server's reason) and «اكتب قاعدتك».
 *  2. Pressing a template opens the same dialog, filled, and asks the server's preview at once — the body is one the door accepts.
 *  3. The preview is the server's: who it binds (with her numbers), who not and why, the notes. A rule that binds nobody saves only after the tick.
 *  4. A refusal is the server's sentence beside the field that caused it; what was typed stays.
 *  5. Every rule written, stopped ones too; «وقّفها» asks first and sends a stop (never a delete); read-only without the edit key.
 *  6. The phone: one column, two from `md`; the kit only; the desk never imports it, and it imports nothing of the rules' libraries.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body: any }[],
  answers: {} as Record<string, (body: any) => unknown>,
  confirmYes: true,
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    h.calls.push({ url, method, body });
    const key = `${method} ${url}`;
    const answer = h.answers[key] ?? h.answers[`${method} *`];
    if (!answer) throw new Error(`no answer for ${key}`);
    return answer(body);
  },
}));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => async () => h.confirmYes,
  useAsk: () => async () => null,
}));

import { OwnRulesCard, I_KNOW_IT_BINDS_NOBODY, NO_RULES_YET, type OwnRulesAnswer } from './OwnRulesCard';
import { NOT_ACTING_YET_AR, OWN_RULE_NUMBERS, PRIORITY_EFFECT_AR, candidateFromBody, notActingYetAnswer, templatesAnswer } from '@/lib/confirmation-own-rules';

const refusal = (status: number, data: Record<string, unknown>) => Object.assign(new Error(String(data.errorAr)), { status, data });

function listAnswer(over: Partial<OwnRulesAnswer> = {}): OwnRulesAnswer {
  return {
    rules: [
      {
        id: 'r1', name: 'سارة أسبوع', kind: 'EMPLOYEE_NUMBERS', kindLabel: 'أرقام الموظفة', state: 'ACTIVE', stateAr: 'شغّالة', whatAr: 'حد اليد 2',
        scopeAr: 'على: سارة · بكل المتاجر', effectiveFrom: '2026-11-21T07:00:00.000Z', effectiveTo: null, createdAt: '2026-11-21T07:00:00.000Z', createdBy: 'المالك', broken: false,
      },
      {
        id: 'r0', name: 'قديمة', kind: 'EMPLOYEE_NUMBERS', kindLabel: 'أرقام الموظفة', state: 'STOPPED', stateAr: 'موقوفة', whatAr: 'سرعة السحب 20 طلب بالساعة',
        scopeAr: 'على كل الموظفات · بكل المتاجر', effectiveFrom: '2026-11-01T07:00:00.000Z', effectiveTo: null, createdAt: '2026-11-01T07:00:00.000Z', createdBy: null, broken: false,
      },
    ],
    templates: templatesAnswer(new Map()) as OwnRulesAnswer['templates'],
    numbers: OWN_RULE_NUMBERS.filter((n) => n.kind === 'EMPLOYEE_NUMBERS').map((n) => ({ ...n })),
    notActingYetAr: NOT_ACTING_YET_AR,
    days: { min: 1, max: 90 },
    stores: [{ id: 's1', name: 'متجر أول' }],
    people: [{ id: 'sara', name: 'سارة' }, { id: 'huda', name: 'هدى' }],
    canEdit: true,
    editKeyLabel: 'إعدادات النظام الحسّاسة',
    nextWorkStart: '2026-11-22T06:00:00.000Z',
    ...over,
  };
}

const PREVIEW = {
  bound: [{ id: 'sara', name: 'سارة', numbers: ['مهلة الطلب المتروك: 30'] }],
  notBound: [{ id: 'huda', name: 'هدى', reason: 'قاعدة «هدى» أخص منها على مهلة الطلب المتروك' }],
  notes: ['بتشتغل بس من الساعة 17:00 لـ23:00 بتوقيت المتجر.'],
  bindsNobody: false,
};

const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
async function open(over: Partial<OwnRulesAnswer> = {}) {
  h.answers['GET /api/confirmation/rules'] = () => listAnswer(over);
  const onChanged = vi.fn();
  const view = render(<OwnRulesCard onChanged={onChanged} />);
  await screen.findByText('قواعد خاصة');
  return { ...view, onChanged };
}
const dialog = () => document.querySelector('[data-rule-dialog]') as HTMLElement;
const templateRow = (c: HTMLElement, key: string) => c.querySelector(`[data-template="${key}"]`) as HTMLElement;

beforeEach(() => {
  h.calls = [];
  h.answers = {};
  h.confirmYes = true;
});
afterEach(cleanup);

describe('1 · two ways in, side by side', () => {
  it('the templates and «اكتب قاعدتك» stand in one grid — one column on a phone, two from md', async () => {
    const { container } = await open();
    const t = container.querySelector('[data-templates]')!;
    const w = container.querySelector('[data-write-own]')!;
    expect(t.parentElement).toBe(w.parentElement);
    expect(t.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['grid', 'grid-cols-1', 'md:grid-cols-2']));
  });

  // UPDATED 2026-11-21 (request Q4d): was «the six of kinds that do not act yet … the two that act»; the four order templates act now — two greyed, six pressable.
  // UPDATED 2026-11-21 (request Q5c): was «two greyed (the kinds of Q5), six pressable»; priority and routing act now — all eight pressable, none greyed.
  it('eight templates, every one «مطفية», every one pressable — none greyed', async () => {
    const { container } = await open();
    const rows = container.querySelectorAll('[data-template]');
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.querySelector('[data-template-state]')!.textContent).toBe('مطفية');
    for (const key of ['new-employee-hand', 'evening-idle', 'expensive-product-attempts', 'page-leads-attempts', 'store-proof', 'product-postpone-once', 'product-first', 'store-to-its-team']) {
      expect((within(templateRow(container, key)).getByRole('button', { name: 'شغّلها' }) as HTMLButtonElement).disabled, key).toBe(false);
    }
    expect([...rows].filter((r) => r.querySelector('[data-template-blocked]'))).toHaveLength(0);
  });

  it('a template a rule came from says so', async () => {
    const templates = templatesAnswer(new Map([['evening-idle', 2]])) as OwnRulesAnswer['templates'];
    const { container } = await open({ templates });
    expect(templateRow(container, 'evening-idle').querySelector('[data-template-state]')!.textContent).toBe('شغّالة — 2 قاعدة منها');
  });
});

describe('2 · pressing a template opens the dialog filled, on its preview', () => {
  it('«دوام المسا»: name, hours and number filled; the preview asked at once with a body the door accepts', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    const { container } = await open();
    await press(within(templateRow(container, 'evening-idle')).getByRole('button', { name: 'شغّلها' }));
    await waitFor(() => expect(dialog().querySelector('[data-preview]')).toBeTruthy());
    expect((screen.getByLabelText('اسم القاعدة') as HTMLInputElement).value).toBe('دوام المسا: مهلة الطلب المتروك 30 دقيقة');
    expect((screen.getByLabelText('من الساعة') as HTMLInputElement).value).toBe('17:00');
    expect((screen.getByLabelText('الرقم') as HTMLSelectElement).value).toBe('idleMinutes');
    const sent = h.calls.find((c) => c.url === '/api/confirmation/rules/preview')!.body;
    expect(sent).toMatchObject({ kind: 'EMPLOYEE_NUMBERS', templateKey: 'evening-idle', hoursFrom: '17:00', hoursTo: '23:00', payload: { idleMinutes: 30 }, userIds: null });
    expect(candidateFromBody(sent, { companyId: 'c', userId: 'u', nowMs: Date.now(), nextWorkStart: new Date() }).ok).toBe(true);
  });

  it('the preview is the server\'s: who, her numbers, who not and why, the notes', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    const { container } = await open();
    await press(within(templateRow(container, 'evening-idle')).getByRole('button', { name: 'شغّلها' }));
    const p = await waitFor(() => dialog().querySelector('[data-preview]') as HTMLElement);
    expect(p.querySelector('[data-bound-count]')!.textContent).toBe('بتمسك 1');
    expect(p.querySelector('[data-bound]')!.textContent).toContain('سارة — مهلة الطلب المتروك: 30');
    expect(p.querySelector('[data-not-bound]')!.textContent).toContain('هدى — قاعدة «هدى» أخص منها');
    expect(p.querySelector('[data-preview-notes]')!.textContent).toContain('17:00');
    expect(p.querySelector('[data-binds-nobody]')).toBeNull();
  });
});

describe('3 · a rule that binds nobody', () => {
  it('saving is held until the tick; with it the save says so', async () => {
    const nobody = { ...PREVIEW, bound: [], bindsNobody: true };
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: nobody, overlap: null });
    h.answers['POST /api/confirmation/rules'] = () => ({ id: 'new', preview: nobody });
    const { container, onChanged } = await open();
    await press(within(templateRow(container, 'evening-idle')).getByRole('button', { name: 'شغّلها' }));
    await waitFor(() => expect(dialog().querySelector('[data-binds-nobody]')).toBeTruthy());
    const save = screen.getByRole('button', { name: 'احفظ وشغّل' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await press(screen.getByLabelText(I_KNOW_IT_BINDS_NOBODY));
    expect(save.disabled).toBe(false);
    await press(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(h.calls.find((c) => c.method === 'POST' && c.url === '/api/confirmation/rules')!.body.confirmBindsNobody).toBe(true);
  });

  it('NEGATIVE: the server\'s 409 brings the preview back and the tick appears — nothing is assumed in the browser', async () => {
    h.answers['POST /api/confirmation/rules'] = () => {
      throw refusal(409, { code: 'RULE_BINDS_NOBODY', errorAr: 'هالقاعدة ما بتمسك حدا هلق', preview: { ...PREVIEW, bound: [], bindsNobody: true } });
    };
    await open();
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    fireEvent.change(screen.getByLabelText(/حد اليد/, { selector: 'input' }), { target: { value: '2' } });
    await press(screen.getByRole('button', { name: 'احفظ وشغّل' }));
    await waitFor(() => expect(dialog().querySelector('[data-binds-nobody]')).toBeTruthy());
    expect(dialog().textContent).toContain('هالقاعدة ما بتمسك حدا هلق');
  });
});

describe('4 · the four questions and the server\'s refusals', () => {
  it('«موظفات بالاسم»: the desk\'s people as boxes; the body names who was ticked', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    await open();
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    await press(within(dialog()).getByRole('radio', { name: 'موظفات بالاسم' }));
    await press(screen.getByLabelText('سارة'));
    fireEvent.change(screen.getByLabelText(/حد اليد/, { selector: 'input' }), { target: { value: '2' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    const sent = h.calls.find((c) => c.url === '/api/confirmation/rules/preview')!.body;
    expect(sent).toMatchObject({ kind: 'EMPLOYEE_NUMBERS', userIds: ['sara'], payload: { hand: 2 }, start: 'NEXT_WORK_START', storeId: null, days: null });
    // There is no box for the order's amount.
    expect(dialog().textContent).not.toMatch(/مبلغ|قيمة الطلب/);
  });

  it('a refusal lands beside the field that caused it, and what was typed stays', async () => {
    h.answers['POST /api/confirmation/rules'] = () => {
      throw refusal(400, { code: 'RULE_PAYLOAD', field: 'payload.hand', errorAr: 'حد اليد لازم يكون من 1 لـ10.' });
    };
    await open();
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    const value = screen.getByLabelText(/حد اليد/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(value, { target: { value: '11' } });
    await press(screen.getByRole('button', { name: 'احفظ وشغّل' }));
    await waitFor(() => expect(value.parentElement!.textContent).toContain('حد اليد لازم يكون من 1 لـ10.'));
    expect(value.value).toBe('11');
  });
});

describe('5 · the rules written: stop, never delete; read-only without the key', () => {
  it('every rule with its words; the stopped one has no buttons; «وقّفها» asks, then sends a stop', async () => {
    h.answers['PATCH /api/confirmation/rules/r1'] = () => ({ id: 'r1' });
    const { container, onChanged } = await open();
    const active = container.querySelector('[data-rule="r1"]') as HTMLElement;
    const stopped = container.querySelector('[data-rule="r0"]') as HTMLElement;
    expect(active.textContent).toContain('حد اليد 2');
    expect(active.textContent).toContain('على: سارة');
    expect(stopped.textContent).toContain('موقوفة');
    expect(within(stopped).queryAllByRole('button')).toHaveLength(0);
    await press(within(active).getByRole('button', { name: 'وقّفها' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(h.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/confirmation/rules/r1', body: { action: 'stop' } });
  });

  it('NEGATIVE: «لا» to the question sends nothing', async () => {
    h.confirmYes = false;
    const { container } = await open();
    await press(within(container.querySelector('[data-rule="r1"]') as HTMLElement).getByRole('button', { name: 'وقّفها' }));
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('read-only: no press anywhere, and the key it needs by name', async () => {
    const { container } = await open({ canEdit: false });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('[data-read-only]')!.textContent).toContain('«إعدادات النظام الحسّاسة»');
  });

  it('no rule yet: says the base numbers are in force', async () => {
    const { container } = await open({ rules: [] });
    expect(container.querySelector('[data-no-rules]')!.textContent).toBe(NO_RULES_YET);
  });
});

describe('6 · the phone, the kit, the desk', () => {
  const code = readFileSync(join(process.cwd(), 'src/components/confirmation/OwnRulesCard.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('no class that makes a row wider than its parent; rows stack under md', () => {
    for (const bad of [/\bw-\[/, /\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/, /\btext-xs\b/]) expect(code, String(bad)).not.toMatch(bad);
    expect(code).toContain('flex flex-col gap-1 py-3 md:flex-row');
  });

  it('the kit only: no raw button, no raw checkbox, no raw dialog', () => {
    expect(code).not.toMatch(/<button[\s>]/);
    expect(code).not.toMatch(/type="checkbox"/);
    expect(code).not.toMatch(/<dialog[\s>]/);
  });

  it('it imports nothing of the rules\' libraries (every word is the server\'s), and the desk never imports it', () => {
    expect(code).not.toMatch(/from '@\/lib\/(confirmation-|employee-numbers|desk-readiness|db)/);
    const desk = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8');
    expect(desk).not.toContain('OwnRulesCard');
  });

  it('on the rules page, once', () => {
    const rules = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationRulesScreen.tsx'), 'utf8');
    expect(rules.match(/<OwnRulesCard /g)).toHaveLength(1);
  });
});

/** ADDED 2026-11-21 (request Q4d): an ORDER rule in the same dialog — «على أي طلبات» instead of «على مين» and the hours. */
describe('Q4d · an order rule in the dialog', () => {
  const orderAnswer = () => ({
    numbers: OWN_RULE_NUMBERS.map((n) => ({ ...n })),
    products: [{ id: 'pA', name: 'ساعة ذهب' }, { id: 'pB', name: 'قميص' }],
    channels: [{ value: 'LANDING_PAGE', label: 'صفحة هبوط' }, { value: 'FACEBOOK', label: 'فيسبوك' }],
  });

  it('«منتج غالي: 7 محاولات»: opens on its attempts, asks the product — no «على مين», no hours — and the body is one the door accepts once the product is chosen', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = (body) => {
      if (!body.productId) throw refusal(400, { code: 'RULE_TEMPLATE_BLANK', errorAr: 'هالقالب بدّو تختار المنتج.', field: 'productId' });
      return { preview: { bound: [{ id: 'sara', name: 'سارة', numbers: ['عدد محاولات «لا يرد»: 7 محاولات'] }], notBound: [], notes: [], bindsNobody: false }, overlap: null };
    };
    const { container } = await open(orderAnswer());
    await press(within(templateRow(container, 'expensive-product-attempts')).getByRole('button', { name: 'شغّلها' }));
    // The template's blank comes back as the server's sentence, beside the product.
    await waitFor(() => expect(dialog().textContent).toContain('هالقالب بدّو تختار المنتج.'));
    expect((screen.getByLabelText('الرقم') as HTMLSelectElement).value).toBe('attempts');
    expect((screen.getByLabelText(/عدد محاولات/, { selector: 'input' }) as HTMLInputElement).value).toBe('7');
    expect(dialog().querySelector('[data-order-names-nobody]')).toBeTruthy();
    expect(dialog().querySelector('[data-order-has-no-hours]')).toBeTruthy();
    expect(within(dialog()).queryByRole('radio', { name: 'موظفات بالاسم' })).toBeNull();
    expect(screen.queryByLabelText('من الساعة')).toBeNull();
    fireEvent.change(screen.getByLabelText('المنتج'), { target: { value: 'pA' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    await waitFor(() => expect(dialog().querySelector('[data-bound]')!.textContent).toContain('7 محاولات'));
    const sent = h.calls.filter((c) => c.url === '/api/confirmation/rules/preview').pop()!.body;
    expect(sent).toMatchObject({ kind: 'ORDER_NUMBERS', productId: 'pA', channelKind: null, userIds: null, hoursFrom: null, hoursTo: null, payload: { attempts: 7 }, templateKey: 'expensive-product-attempts' });
    const c = candidateFromBody(sent, { companyId: 'c', userId: 'u', nowMs: Date.now(), nextWorkStart: new Date() });
    expect(c.ok && c.rule.payload.steps).toHaveLength(6);
  });

  it('«طلبات صفحات الهبوط: 3 محاولات» opens with its channel chosen', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    const { container } = await open(orderAnswer());
    await press(within(templateRow(container, 'page-leads-attempts')).getByRole('button', { name: 'شغّلها' }));
    await waitFor(() => expect(dialog().querySelector('[data-preview]')).toBeTruthy());
    expect((screen.getByLabelText('مصدر الطلب') as HTMLSelectElement).value).toBe('LANDING_PAGE');
    expect(h.calls.find((c) => c.url === '/api/confirmation/rules/preview')!.body).toMatchObject({ channelKind: 'LANDING_PAGE', payload: { attempts: 3 } });
  });

  it('NEGATIVE: an employee number never sends a product or a channel, and shows no such box', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    await open(orderAnswer());
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    expect(screen.queryByLabelText('المنتج')).toBeNull();
    fireEvent.change(screen.getByLabelText(/حد اليد/, { selector: 'input' }), { target: { value: '2' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    const sent = h.calls.find((c) => c.url === '/api/confirmation/rules/preview')!.body;
    expect('productId' in sent || 'channelKind' in sent).toBe(false);
  });
});

/** ADDED 2026-11-21 (request Q5c): «هالطلبات أول» and «هالطلبات بس لهالموظفات» in the same dialog — from the list, their side effect under them, the server's warning. */
describe('Q5c · priority and routing in the dialog', () => {
  const wideAnswer = (over: Partial<OwnRulesAnswer> = {}) => ({
    numbers: OWN_RULE_NUMBERS.map((n) => ({ ...n })),
    notActingYetAr: notActingYetAnswer(),
    products: [{ id: 'pA', name: 'ساعة ذهب' }],
    channels: [{ value: 'LANDING_PAGE', label: 'صفحة هبوط' }],
    phases: [{ value: 'NEW', label: 'الطلبات الجديدة' }, { value: 'RETRY', label: 'طلبات الإعادة' }],
    ...over,
  });
  const accepted = (body: any) => candidateFromBody(body, { companyId: 'c', userId: 'u', nowMs: Date.now(), nextWorkStart: new Date() });

  it('every kind acts: no «لسا ما بيشتغل» line anywhere', async () => {
    const { container } = await open(wideAnswer());
    expect(container.querySelector('[data-not-acting-yet]')).toBeNull();
    expect(container.textContent).not.toContain(NOT_ACTING_YET_AR);
  });

  it('«منتج: طلباته أول»: chosen from the list, nothing to type, its side effect under it; orders by product and new / retry, with hours — a body the door accepts', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    const { container } = await open(wideAnswer());
    await press(within(templateRow(container, 'product-first')).getByRole('button', { name: 'شغّلها' }));
    expect((screen.getByLabelText('الرقم') as HTMLSelectElement).value).toBe('first');
    expect(dialog().querySelector('[data-effect]')!.textContent).toBe(PRIORITY_EFFECT_AR);
    // Nothing is typed for it: the only number box left is the rule's length.
    expect([...dialog().querySelectorAll('input[type="number"]')].map((i) => (i as HTMLInputElement).id || i.getAttribute('name'))).toHaveLength(1);
    expect(dialog().querySelector('[data-orders-wide]')).toBeTruthy();
    expect(within(dialog()).queryByRole('radio', { name: 'موظفات بالاسم' })).toBeNull();
    expect(within(dialog()).getByRole('radio', { name: 'ساعات معيّنة' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('المنتج'), { target: { value: 'pA' } });
    fireEvent.change(screen.getByLabelText('نوع الطلب'), { target: { value: 'RETRY' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    const sent = h.calls.filter((c) => c.url === '/api/confirmation/rules/preview').pop()!.body;
    expect(sent).toMatchObject({ kind: 'PRIORITY', productId: 'pA', phase: 'RETRY', userIds: null, payload: { first: true }, templateKey: 'product-first' });
    expect(accepted(sent).ok).toBe(true);
  });

  it('«متجر: طلباته بس لموظفاته»: people ticked under question four, the minutes open on 30, the side effect follows the minutes typed — a body the door accepts', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = (body) => {
      if (!body.payload.toUserIds?.length) throw refusal(400, { code: 'RULE_TEMPLATE_BLANK', field: 'payload.toUserIds', errorAr: 'هالقالب بدّو تختار الموظفات اللي إلهن الطلبات.' });
      return { preview: { ...PREVIEW, warnings: ['ولا وحدة من موظفات القاعدة بتقدر تسحب هلق'] }, overlap: null };
    };
    const { container } = await open(wideAnswer());
    await press(within(templateRow(container, 'store-to-its-team')).getByRole('button', { name: 'شغّلها' }));
    // The template ships with nobody: the server's sentence, beside the people.
    await waitFor(() => expect(dialog().querySelector('[data-refusal="toUserIds"]')!.textContent).toContain('هالقالب بدّو تختار الموظفات'));
    expect((screen.getByLabelText('الرقم') as HTMLSelectElement).value).toBe('toUserIds');
    const minutes = screen.getByLabelText(/مهلة «طلبات بلا موظفة»/, { selector: 'input' }) as HTMLInputElement;
    expect(minutes.value).toBe('30');
    expect(dialog().querySelector('[data-effect]')!.textContent).toBe('الطلبات بتروح لهالموظفات بس، وإذا ما حدا منهن قادر بتصير للكل بعد 30 دقيقة دوام.');
    fireEvent.change(minutes, { target: { value: '60' } });
    expect(dialog().querySelector('[data-effect]')!.textContent).toBe('الطلبات بتروح لهالموظفات بس، وإذا ما حدا منهن قادر بتصير للكل بعد 60 دقيقة دوام.');
    await press(within(dialog().querySelector('[data-routing-people]') as HTMLElement).getByLabelText('سارة'));
    fireEvent.change(screen.getByLabelText('المتجر'), { target: { value: 's1' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    await waitFor(() => expect(dialog().querySelector('[data-preview-warnings]')).toBeTruthy());
    expect(dialog().querySelector('[data-preview-warnings]')!.getAttribute('role')).toBe('alert');
    const sent = h.calls.filter((c) => c.url === '/api/confirmation/rules/preview').pop()!.body;
    expect(sent).toMatchObject({ kind: 'ROUTING', storeId: 's1', userIds: null, payload: { toUserIds: ['sara'], fallbackMinutes: 60 }, templateKey: 'store-to-its-team' });
    expect(accepted(sent).ok).toBe(true);
    expect(dialog().textContent).not.toMatch(/[{}]/);
  });

  it('NEGATIVE: a minutes refusal lands beside the minutes, and what was typed stays', async () => {
    h.answers['POST /api/confirmation/rules'] = () => {
      throw refusal(400, { code: 'RULE_PAYLOAD', field: 'payload.fallbackMinutes', errorAr: 'مهلة «طلبات بلا موظفة» لازم تكون رقم صحيح من 5 لـ480 دقيقة دوام.' });
    };
    await open(wideAnswer());
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: 'toUserIds' } });
    const minutes = screen.getByLabelText(/مهلة «طلبات بلا موظفة»/, { selector: 'input' }) as HTMLInputElement;
    // Empty: the effect says the default.
    expect(dialog().querySelector('[data-effect]')!.textContent).toContain('30 دقيقة');
    fireEvent.change(minutes, { target: { value: '900' } });
    await press(screen.getByRole('button', { name: 'احفظ وشغّل' }));
    await waitFor(() => expect(minutes.parentElement!.textContent).toContain('من 5 لـ480'));
    expect(minutes.value).toBe('900');
  });

  it('NEGATIVE: an empty minutes box sends no minutes; back to an employee number, «على مين» returns and the order boxes and the effect go', async () => {
    h.answers['POST /api/confirmation/rules/preview'] = () => ({ preview: PREVIEW, overlap: null });
    await open(wideAnswer());
    await press(screen.getByRole('button', { name: 'قاعدة جديدة' }));
    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: 'toUserIds' } });
    await press(screen.getByRole('button', { name: 'شوف مين بتمسك' }));
    expect('fallbackMinutes' in h.calls.filter((c) => c.url === '/api/confirmation/rules/preview').pop()!.body.payload).toBe(false);
    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: 'hand' } });
    expect(within(dialog()).getByRole('radio', { name: 'موظفات بالاسم' })).toBeTruthy();
    expect(screen.queryByLabelText('نوع الطلب')).toBeNull();
    expect(dialog().querySelector('[data-effect]')).toBeNull();
  });
});
