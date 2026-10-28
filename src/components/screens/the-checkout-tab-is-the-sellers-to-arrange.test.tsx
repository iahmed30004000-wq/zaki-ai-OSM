// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — the owner, 28/10.
 *
 * The «الدفع» tab of «القالب والألوان», drawn for real (the gallery and the preview are stubbed: they are not what
 * this file is about). What is held is what each control DOES to what the seller saves:
 *
 *   · a drag — by keyboard, the way a screen reader drags — reorders the fields, and «احفظ المسوّدة» writes that
 *     order to the DRAFT; nothing is published;
 *   · the ↑ ↓ buttons are still there and go through the same move;
 *   · «يظهر» takes a field off the form, and clears its «إلزامي»;
 *   · «إلزامي» cannot be ticked while the field is hidden;
 *   · the four a parcel needs are locked, shown and required «دائماً».
 *
 * jsdom has no layout, so the rows are given the rectangles a browser would give them — 60px tall, stacked in their
 * list, shifted by the `translate3d` the sortable strategy writes — the same stand-in the offers list's drag test
 * uses. Everything else is the real library and the real screen.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/store/SkinGallery', () => ({ SkinGallery: () => null }));
vi.mock('@/components/store/LayoutPanel', () => ({ LayoutPanel: () => null }));
vi.mock('@/components/store/ContrastNotes', () => ({ ContrastNotes: () => null }));
vi.mock('@/components/ui/TemplateGallery', () => ({ TemplateGallery: () => null }));
vi.mock('@/components/landing-editor/StoreThemePreview', () => ({ StoreThemePreview: () => null }));
vi.mock('@/lib/store-image-upload', () => ({ uploadStoreImages: vi.fn() }));

import { StoreThemeScreen } from './StoreThemeScreen';
import { DEFAULT_STORE_THEME, parseStoreTheme, type StoreTheme } from '@/lib/store-theme';
import { DEFAULT_SUBMIT, DEFAULT_THANKS } from '@/lib/checkout-words';

const NAMES = ['الاسم', 'الهاتف', 'هاتف بديل', 'المحافظة', 'العنوان', 'ملاحظة'];

/** What the server holds: the draft every PATCH writes, and every request made. */
let saved: StoreTheme[] = [];
let published = 0;

function serve(theme: StoreTheme = DEFAULT_STORE_THEME) {
  saved = [];
  published = 0;
  apiJson.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/api/store/theme' && method === 'GET') {
      return {
        store: { id: 's1', name: 'صحة', type: 'MULTI_PRODUCT', logo: null, favicon: null, cartBarApplies: true },
        theme,
        hasUnpublished: false,
        canRevert: false,
      };
    }
    if (path === '/api/store/templates') return { skins: [], installed: null, sample: [], storeName: 'صحة' };
    if (path === '/api/store/theme' && method === 'PATCH') {
      const draft = parseStoreTheme(String(init!.body));
      saved.push(draft);
      return { theme: draft, hasUnpublished: true };
    }
    if (path === '/api/store/theme' && method === 'POST') {
      published++;
      return { theme };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

// jsdom has no ResizeObserver, and the drag library measures its drop zones with one.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openTab(theme?: StoreTheme) {
  serve(theme);
  render(<StoreThemeScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'الدفع' }));
  await screen.findByText(/اسحب الحقل لترتيبه/);
}

const rows = () => screen.getAllByRole('listitem');
/** The fields in the order the tab shows them, by the name each row says. */
const order = () => rows().map((li) => NAMES.find((n) => within(li).queryByText(n, { exact: true })) ?? '?');
const row = (name: string) => rows().find((li) => within(li).queryByText(name, { exact: true }))!;
const shows = (name: string) => screen.getByLabelText(`«${name}» يظهر بالنموذج`) as HTMLInputElement;
const requires = (name: string) => screen.getByLabelText(`«${name}» إلزامي`) as HTMLInputElement;
const saveDraft = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /احفظ المسوّدة/ }));
  });
  await waitFor(() => expect(saved.length).toBeGreaterThan(0));
  return saved.at(-1)!.checkout!;
};
const settle = (ms = 80) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe('the tab says what it is and what cannot change', () => {
  it('the line above the list, and every field with its grip, its two boxes and its arrows', async () => {
    await openTab();
    expect(
      screen.getByText(
        'اسحب الحقل لترتيبه. الاسم والهاتف والمحافظة والعنوان ظاهرة وإلزامية دائماً: بدونها ما بتتسعّر الشحنة ولا بتوصل.'
      )
    ).toBeTruthy();
    expect(order()).toEqual(NAMES);
    for (const name of NAMES) {
      const li = row(name);
      expect(within(li).getByLabelText(`اسحب «${name}» لتغيير ترتيبه`), name).toBeTruthy();
      expect(within(li).getByLabelText(`ارفع «${name}»`), name).toBeTruthy();
      expect(within(li).getByLabelText(`انزّل «${name}»`), name).toBeTruthy();
    }
  });

  it('the four a parcel needs — shown and required, ticked and locked, «دائماً»', async () => {
    await openTab();
    for (const name of ['الاسم', 'الهاتف', 'المحافظة', 'العنوان']) {
      expect(shows(name).checked && shows(name).disabled, name).toBe(true);
      expect(requires(name).checked && requires(name).disabled, name).toBe(true);
      expect(row(name).textContent, name).toContain('يظهر (دائماً)');
      expect(row(name).textContent, name).toContain('إلزامي (دائماً)');
    }
  });

  it('NEGATIVE: the two the seller decides are not locked', async () => {
    await openTab();
    for (const name of ['هاتف بديل', 'ملاحظة']) {
      expect(shows(name).disabled, name).toBe(false);
      expect(requires(name).disabled, name).toBe(false);
      expect(row(name).textContent, name).not.toContain('(دائماً)');
    }
  });

  it('and the button’s words and the message say what a blank one really shows — no example that appears nowhere', async () => {
    await openTab();
    const inputs = [...document.querySelectorAll('input[maxlength]')] as HTMLInputElement[];
    const placeholders = inputs.map((i) => i.placeholder);
    expect(placeholders).toContain(DEFAULT_SUBMIT);
    expect(placeholders).toContain(DEFAULT_THANKS);
    expect(placeholders).not.toContain('اطلب الآن — الدفع عند الاستلام');
  });

  it('and with no colour of its own, the swatch is the shop’s primary — never a white no button wears', async () => {
    await openTab();
    const swatch = screen.getByLabelText('لون زر التأكيد') as HTMLInputElement;
    expect(swatch.value).toBe(DEFAULT_STORE_THEME.accent.toLowerCase());
    expect(swatch.value).not.toBe('#ffffff');
  });
});

describe('«يظهر» and «إلزامي» write to the draft', () => {
  it('un-ticking «يظهر» hides the field — and «إلزامي» cannot be ticked while it is hidden', async () => {
    await openTab();
    fireEvent.click(shows('هاتف بديل'));
    expect(shows('هاتف بديل').checked).toBe(false);
    expect(requires('هاتف بديل').disabled, 'إلزامي بيتعلّم وهو مخفي').toBe(true);
    expect(requires('هاتف بديل').checked).toBe(false);
    const draft = await saveDraft();
    expect(draft.hidden).toEqual(['altPhone']);
    // Still in the list — the settings keep every field in its place; only the form leaves it off.
    expect(order()).toEqual(NAMES);
    expect(published, 'انتشر بلا «انشر»').toBe(0);
  });

  it('hiding a ticked field clears its tick — a hidden field asks nothing, and shown again it starts unticked', async () => {
    await openTab();
    fireEvent.click(requires('ملاحظة'));
    expect(requires('ملاحظة').checked).toBe(true);
    fireEvent.click(shows('ملاحظة'));
    let draft = await saveDraft();
    expect(draft.hidden).toEqual(['note']);
    expect(draft.required).not.toContain('note');
    fireEvent.click(shows('ملاحظة'));
    expect(requires('ملاحظة').disabled).toBe(false);
    expect(requires('ملاحظة').checked).toBe(false);
    draft = await saveDraft();
    expect(draft.hidden).toEqual([]);
  });

  it('ticking «إلزامي» writes it, and un-ticking takes it back', async () => {
    await openTab();
    fireEvent.click(requires('هاتف بديل'));
    expect((await saveDraft()).required).toEqual(['altPhone']);
    fireEvent.click(requires('هاتف بديل'));
    expect((await saveDraft()).required).toEqual([]);
  });

  it('NEGATIVE: a stored hidden «phone» (an old file) is not obeyed on the tab — it is shown, locked', async () => {
    await openTab({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, hidden: ['phone'] } });
    expect(shows('الهاتف').checked).toBe(true);
    expect(shows('الهاتف').disabled).toBe(true);
  });
});

describe('the order — the arrows, and a real drag by keyboard', () => {
  const ROW = 60;
  let restoreLayout: () => void;
  const announced = () => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? '').join(' ');

  beforeEach(() => {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = (top: number, height: number) =>
        ({ x: 0, y: top, left: 0, top, right: 400, bottom: top + height, width: 400, height, toJSON: () => ({}) }) as DOMRect;
      if (this.tagName === 'LI' && this.parentElement) {
        const slot = [...this.parentElement.children].indexOf(this) * ROW;
        const shift = /translate3d\(\s*[-\d.]+(?:px)?\s*,\s*([-\d.]+)px/.exec((this as HTMLElement).style.transform)?.[1];
        return rect(slot + (shift ? Number(shift) : 0), ROW);
      }
      if (this.tagName === 'UL') return rect(0, this.children.length * ROW);
      return real.call(this);
    };
    restoreLayout = () => {
      Element.prototype.getBoundingClientRect = real;
    };
  });
  afterEach(() => restoreLayout());

  it('the ↓ on the first field moves it one down, and the draft keeps that order', async () => {
    await openTab();
    fireEvent.click(screen.getByLabelText('انزّل «الاسم»'));
    expect(order()).toEqual(['الهاتف', 'الاسم', 'هاتف بديل', 'المحافظة', 'العنوان', 'ملاحظة']);
    expect((await saveDraft()).fieldOrder).toEqual(['phone', 'name', 'altPhone', 'region', 'address', 'note']);
  });

  it('NEGATIVE: the first cannot go up and the last cannot go down', async () => {
    await openTab();
    expect((screen.getByLabelText('ارفع «الاسم»') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('انزّل «ملاحظة»') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('ارفع «ملاحظة»') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Space to pick a field up, ↓ twice, Space to put it down — said in Arabic, and the draft takes the new order', async () => {
    await openTab();
    await waitFor(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]').length).toBeGreaterThan(0));
    const grip = screen.getByLabelText('اسحب «الاسم» لتغيير ترتيبه');
    expect(grip.getAttribute('aria-roledescription')).toBe('مقبض ترتيب');
    await act(async () => {
      fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    });
    await waitFor(() => expect(announced()).toContain('أمسكتَ «الاسم»'));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await waitFor(() => expect(announced()).toContain('«الاسم» فوق «الهاتف»'));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await waitFor(() => expect(announced()).toContain('«الاسم» فوق «هاتف بديل»'));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });
    await waitFor(() => expect(order()).toEqual(['الهاتف', 'هاتف بديل', 'الاسم', 'المحافظة', 'العنوان', 'ملاحظة']));
    const draft = await saveDraft();
    expect(draft.fieldOrder).toEqual(['phone', 'altPhone', 'name', 'region', 'address', 'note']);
    expect(published, 'انتشر بلا «انشر»').toBe(0);
  });

  it('NEGATIVE: Esc puts it back, says so, and there is nothing to save', async () => {
    await openTab();
    await waitFor(() => expect(document.querySelectorAll('[id^="DndDescribedBy"]').length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('اسحب «الاسم» لتغيير ترتيبه'), { code: 'Space', key: ' ' });
    });
    await waitFor(() => expect(announced()).toContain('أمسكتَ «الاسم»'));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    });
    await waitFor(() => expect(announced()).toContain('«الاسم» فوق «الهاتف»'));
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    });
    await waitFor(() => expect(announced()).toContain('أُلغي تحريك «الاسم»'));
    await settle();
    expect(order()).toEqual(NAMES);
    expect((screen.getByRole('button', { name: /احفظ المسوّدة/ }) as HTMLButtonElement).disabled, 'في شي للحفظ').toBe(true);
  });

  it('and only the grip refuses the browser’s scroll — a thumb on the rest of the row scrolls', async () => {
    await openTab();
    const noScroll = [...document.querySelectorAll<HTMLElement>('[style*="touch-action"]')];
    expect(noScroll).toHaveLength(NAMES.length);
    for (const el of noScroll) expect(el.getAttribute('aria-label')).toMatch(/^اسحب «.*» لتغيير ترتيبه$/);
  });
});
