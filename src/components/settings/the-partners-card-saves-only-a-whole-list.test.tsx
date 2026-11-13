// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الشركاء والنسب» — THE SETTINGS CARD (13/11).
 *
 * «هلأ احنا ٤ شركاء …» (the owner). This repository is public and so is its image, so with nothing saved the card draws four EMPTY rows —
 * a box for the name and a box for the share, each with a hint — and no name or share of anybody is written in the product or in these
 * tests (the partners below are made up: شريك أ … شريك د). Nothing is written anywhere until he presses «حفظ»; the total is printed as he
 * types and must read exactly 100 before the press can be made; the sentence under the list is the door's own; a partner is switched
 * off, never deleted; and nobody without the key is drawn the card or a request.
 */

const { api, can, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  can: { value: true },
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useCan', () => ({ useCan: (key: string) => can.value && key === 'finance.partners' }));

import { PartnersCard } from './PartnersCard';

const SAVED = [
  { id: 'p1', name: 'شريك أ', sharePercent: 15, isActive: true, sortOrder: 0 },
  { id: 'p2', name: 'شريك ب', sharePercent: 15, isActive: true, sortOrder: 1 },
  { id: 'p3', name: 'شريك ج', sharePercent: 15, isActive: true, sortOrder: 2 },
  { id: 'p4', name: 'شريك د', sharePercent: 55, isActive: true, sortOrder: 3 },
];
const answer = (partners: typeof SAVED) => ({ partners, sharesTotal: 100 });

const puts = () => api.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
const names = () => (screen.getAllByLabelText('الاسم') as HTMLInputElement[]).map((i) => i.value);
const shares = () => (screen.getAllByLabelText('النسبة (%)') as HTMLInputElement[]).map((i) => i.value);
const saveButton = () => screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement;
const open = async () => {
  render(<PartnersCard />);
  await screen.findByText('الشركاء والنسب');
  await waitFor(() => expect(screen.queryAllByLabelText('الاسم').length).toBeGreaterThan(0));
};
/** What the owner does with the four empty rows: types a name and a share into each. */
const fillFour = () => {
  SAVED.forEach((p, i) => {
    fireEvent.change(screen.getAllByLabelText('الاسم')[i], { target: { value: p.name } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[i], { target: { value: String(p.sharePercent) } });
  });
};
const openFilled = async () => {
  await open();
  fillFour();
};

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return answer(SAVED);
    return { partners: [], sharesTotal: 0 };
  });
});
afterEach(cleanup);

describe('who is drawn the card', () => {
  it('without the key: nothing is drawn and nothing is asked of the server', () => {
    can.value = false;
    const { container } = render(<PartnersCard />);
    expect(container.innerHTML).toBe('');
    expect(api).not.toHaveBeenCalled();
  });

  it('with the key: it reads the saved list once', async () => {
    await open();
    expect(api.mock.calls.map((c) => c[0])).toEqual(['/api/finance/partners']);
  });

  it('a list that cannot be read says so, and draws no form — empty rows are not offered over partners that may exist', async () => {
    api.mockRejectedValue(new Error('x'));
    render(<PartnersCard />);
    expect(await screen.findByText(/تعذّر تحميل الشركاء/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'حفظ' })).toBeNull();
  });
});

describe('nothing saved yet: four EMPTY rows, with hints', () => {
  it('draws four rows with nothing in them — a name box and a share box each, a hint in each — and says nothing is saved yet', async () => {
    await open();
    expect(names()).toEqual(['', '', '', '']);
    expect(shares()).toEqual(['', '', '', '']);
    expect(screen.getAllByPlaceholderText('اكتب اسم الشريك')).toHaveLength(4);
    expect(screen.getAllByPlaceholderText('مثلاً 25')).toHaveLength(4);
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked)).toEqual([true, true, true, true]);
    expect(screen.getByText(/ما في شركاء محفوظين لسا — اكتب اسم كل شريك ونسبته/)).toBeTruthy();
  });

  it('there is nothing to save from empty boxes: the total reads 0, the sentence is the door’s own, and the press is shut', async () => {
    await open();
    expect(screen.getByText('المجموع 0 — لازم يكون 100 بالضبط')).toBeTruthy();
    expect(screen.getByText('اكتب اسم كل شريك (حرفين على الأقل).')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(puts()).toHaveLength(0);
  });

  it('a name typed with no share is refused with the share’s own sentence', async () => {
    await open();
    fireEvent.change(screen.getAllByLabelText('الاسم')[0], { target: { value: 'شريك أ' } });
    expect(screen.getByText(/نسبة «شريك أ» لازم تكون رقم أكبر من صفر/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('writes NOTHING until the press: what is typed is the form’s state, not the database’s', async () => {
    await openFilled();
    expect(puts()).toHaveLength(0);
    expect(saveButton().disabled).toBe(false);
  });

  it('the press sends what was typed — the characters in the boxes, in order, with no id — and then shows what was saved', async () => {
    await openFilled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0] as [string, { body: string; method: string }];
    expect(url).toBe('/api/finance/partners');
    expect(JSON.parse(init.body)).toEqual({
      partners: [
        { name: 'شريك أ', sharePercent: '15', isActive: true },
        { name: 'شريك ب', sharePercent: '15', isActive: true },
        { name: 'شريك ج', sharePercent: '15', isActive: true },
        { name: 'شريك د', sharePercent: '55', isActive: true },
      ],
    });
    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('انحفظ الشركاء ونسبهم'));
    expect(screen.queryByText(/ما في شركاء محفوظين لسا/)).toBeNull();
    // saved now: nothing changed, nothing to press
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it('a name and a share changed before the press are what is sent', async () => {
    await openFilled();
    fireEvent.change(screen.getAllByLabelText('الاسم')[0], { target: { value: 'شريك أ الصغير' } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[0], { target: { value: '20' } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '50' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const sent = JSON.parse((puts()[0][1] as { body: string }).body).partners;
    expect(sent[0]).toMatchObject({ name: 'شريك أ الصغير', sharePercent: '20' });
    expect(sent[3]).toMatchObject({ sharePercent: '50' });
  });
});

describe('the total is live, and «حفظ» waits for exactly 100', () => {
  it('99 is not 100: the total says so in red, the refusal is the door’s own sentence, and the press is shut', async () => {
    await openFilled();
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '54' } });
    expect(screen.getByText('المجموع 99 — لازم يكون 100 بالضبط')).toBeTruthy();
    expect(screen.getByText('مجموع نسب الشركاء الفعّالين 99 — لازم يكون 100 بالضبط.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(puts()).toHaveLength(0);
  });

  it('101 and 100.01 are refused, 100.00 is accepted — to the hundredth', async () => {
    await openFilled();
    const last = () => screen.getAllByLabelText('النسبة (%)')[3];
    fireEvent.change(last(), { target: { value: '56' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(last(), { target: { value: '55.01' } });
    expect(screen.getByText('المجموع 100.01 — لازم يكون 100 بالضبط')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(last(), { target: { value: '55.00' } });
    expect(screen.getByText('المجموع 100 — تمام')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('a share of three decimals, zero or nothing is refused with its own sentence', async () => {
    await openFilled();
    const first = () => screen.getAllByLabelText('النسبة (%)')[0];
    fireEvent.change(first(), { target: { value: '15.123' } });
    expect(screen.getByText(/لازم تكون رقم أكبر من صفر وما تزيد عن 100، وبخانتين عشريتين على الأكثر/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(first(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(first(), { target: { value: '0' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('a name left empty, or repeated, is refused', async () => {
    await openFilled();
    fireEvent.change(screen.getAllByLabelText('الاسم')[1], { target: { value: '' } });
    expect(screen.getByText('اكتب اسم كل شريك (حرفين على الأقل).')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // the same name with a different spacing is the same name
    fireEvent.change(screen.getAllByLabelText('الاسم')[1], { target: { value: 'شريك   أ' } });
    expect(screen.getByText(/في اسمين متشابهين/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('a partner switched off leaves the total: 100 among the active is what counts', async () => {
    await openFilled();
    const box = () => screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    expect(screen.getByText('المجموع 85 — لازم يكون 100 بالضبط')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // the others re-cut so the active ones total 100 again
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '70' } });
    expect(screen.getByText('المجموع 100 — تمام')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('nobody active is refused', async () => {
    await openFilled();
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(screen.getByText('لازم يضل شريك فعّال واحد على الأقل.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('«إضافة شريك» adds a blank row, with its hints, that must be filled before the list can be saved', async () => {
    await openFilled();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة شريك' }));
    expect(names()).toHaveLength(5);
    expect(screen.getAllByPlaceholderText('اكتب اسم الشريك')).toHaveLength(5);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[4], { target: { value: '10' } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '45' } });
    fireEvent.change(screen.getAllByLabelText('الاسم')[4], { target: { value: 'شريك جديد' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('there is no way to delete a partner from here: no delete button, only the switch', async () => {
    await openFilled();
    expect(screen.queryByRole('button', { name: /حذف|احذف|مسح/ })).toBeNull();
    expect(screen.getByText(/الشريك ما بينحذف، بينوقّف/)).toBeTruthy();
  });
});

describe('a list that is saved', () => {
  beforeEach(() => {
    api.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return answer(SAVED);
      return answer(SAVED);
    });
  });

  it('is shown as saved — no «not saved yet» line, and nothing to press until something changes', async () => {
    await open();
    expect(names()).toEqual(['شريك أ', 'شريك ب', 'شريك ج', 'شريك د']);
    expect(screen.queryByText(/ما في شركاء محفوظين لسا/)).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('a change sends every partner WITH his id — the draws he carries stay with him', async () => {
    await open();
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[0], { target: { value: '10' } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '60' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const sent = JSON.parse((puts()[0][1] as { body: string }).body).partners;
    expect(sent.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('the door’s refusal is printed, and the form stays as it was typed', async () => {
    api.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new Error('القائمة ناقصة: في شريك محفوظ ما انبعت — حدّث الصفحة وجرّب من جديد.');
      return answer(SAVED);
    });
    await open();
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[0], { target: { value: '10' } });
    fireEvent.change(screen.getAllByLabelText('النسبة (%)')[3], { target: { value: '60' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/القائمة ناقصة/)).toBeTruthy();
    expect(shares()).toEqual(['10', '15', '15', '60']);
    expect(toast.done).not.toHaveBeenCalled();
  });
});

describe('NO NEW CSS — every class the card uses is one the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  /**
   * Every class-looking token inside a `className`: the literal ones, the text of a template, AND the quoted strings inside its
   * `${…}` holes (a ternary between two classes is the usual one) — a class hidden in a hole is still a class the stylesheet needs.
   */
  const classesOf = (src: string) =>
    [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].flatMap((m) => {
      const text = m[1] ?? m[2];
      const inHoles = [...text.matchAll(/\$\{([^}]*)\}/g)].flatMap((h) => [...h[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((q) => q[1] ?? q[2]));
      return [text.replace(/\$\{[^}]*\}/g, ' '), ...inHoles].flatMap((s) => s.split(/\s+/)).filter(Boolean);
    });

  it('`PartnersCard`’s classes all appear in another source file', () => {
    const own = join(root, 'components/settings/PartnersCard.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the card has classes').toBeGreaterThan(15);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });
});
