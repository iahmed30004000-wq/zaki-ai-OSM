// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * CREATING A PAGE: ONE QUESTION A SCREEN, AND NOTHING THE OLD STEPS HELD IS LOST.
 *
 * The owner, 3/11, about his other platform: «وتتابع الخطوات عجبني ومش
 * معجوق». The dialog is now his wizard's logic — which product → how to
 * start (✨ بالذكاء الاصطناعي · 🎨 تصميم · ⬜ صفحة فاضية) → which design —
 * and every claim this file made about the four steps still stands, on
 * the path that now carries it:
 *
 *   the ten structures, the slot fields, the dialects and the ten skins
 *   are the AI path's; the fifteen ready-made shapes are the design
 *   path's, one tab from the sixty-four designs.
 *
 * ONE CLAIM WAS RETIRED, AND SAYS WHY: «the skin step says what it is
 * waiting for». The story is now asked BEFORE the look on the AI path, so
 * the skins can no longer be reached with no structure to dress — the
 * state the message was for does not exist any more.
 *
 * THE PREVIEW RENDERER IS STUBBED ON PURPOSE. What the skins claim is «نفس
 * الترتيب ونفس النص، واللون والخط بس بيتغيّروا», and a stub that records
 * every card's props is the only way to assert that.
 */

const { screenApi, preview, confirm } = vi.hoisted(() => ({
  screenApi: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/lib/screen-api', () => ({
  screenApi: (...a: unknown[]) => screenApi(...a),
  qs: (o: Record<string, unknown>) => new URLSearchParams(o as Record<string, string>).toString(),
  formatDate: () => '—',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: { id: 'u1', role: 'OWNER' } }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useTell: () => vi.fn(),
  useConfirm: () => confirm,
}));
vi.mock('@/lib/can', () => ({ userCan: () => false }));
vi.mock('@/components/landing/TemplatePreview', () => ({
  TemplatePreview: (props: Record<string, unknown>) => {
    preview(props);
    return <div data-testid="preview" />;
  },
}));

import { LandingPagesScreen, wizardStartFrom } from './LandingPagesScreen';
import { STORE_TEMPLATES } from '@/lib/store-templates';
import { LANDING_STRUCTURES, STRUCTURE_PROBLEM_SOLUTION } from '@/lib/landing-structures';
import { DESIGNS } from '@/lib/landing-designs/catalog';

const PRODUCT = { id: 'p1', name: 'حزام الظهر', sku: 'BELT-1', basePrice: 120, currency: 'SYP' };
const OTHER = { id: 'p2', name: 'كريم الإيدين', sku: 'HAND', basePrice: 40, currency: 'SYP' };

/** One live page, so the row's own publish toggle can be pressed. */
const LIVE_PAGE = {
  id: 'lp1',
  name: 'صفحة قائمة',
  slug: 'listed',
  isPublished: true,
  showInStore: false,
  domain: null,
  domainVerifiedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  viewsCount: 12,
  ordersCount: 3,
  product: { name: PRODUCT.name },
};

const sentTo = (path: string) => {
  const call = screenApi.mock.calls.find((c) => c[0] === path && (c[1] as RequestInit | undefined)?.method === 'POST');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
};
/** The POST body the wizard created the page with, parsed. */
const sentBody = () => sentTo('/api/landing-pages');

type User = ReturnType<typeof userEvent.setup>;

const dialog = () => within(screen.getByRole('dialog'));
const nextButton = () => screen.getByRole('button', { name: /^التالي$/ });
const backButton = () => screen.getByRole('button', { name: /^السابق$/ });
const createButton = () => screen.getByRole('button', { name: /^إنشاء$/ });
const writeButton = () => screen.getByRole('button', { name: /^اكتب الصفحة بالذكاء الاصطناعي$/ });

const openDialog = async (user: User) => user.click(screen.getByRole('button', { name: /إنشاء صفحة هبوط/ }));

/** Step 1: the one product picker, opened and answered. */
const pickProduct = async (user: User) => {
  await user.click(dialog().getByRole('button', { name: /اختر منتجًا/ }));
  await user.click(await dialog().findByText(new RegExp(`^${PRODUCT.name}`)));
};

/** Step 1 answered: the product chosen, standing on step 2. */
const toMethod = async (user: User) => {
  await openDialog(user);
  await pickProduct(user);
  await user.click(nextButton());
};

/** The AI path up to the story step. */
const toStory = async (user: User) => {
  await toMethod(user);
  await user.click(dialog().getByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ }));
  await user.click(nextButton());
};

/** The AI path up to the design step, with a story chosen. */
const toLook = async (user: User, structure = STRUCTURE_PROBLEM_SOLUTION) => {
  await toStory(user);
  await user.click(screen.getByText(structure.name));
  await user.click(nextButton());
};

/** The AI path up to the words. */
const toWords = async (user: User) => {
  await toLook(user);
  await user.click(writeButton());
};

/** The last step: the name and the address, cleared and typed. */
const toNaming = async (user: User) => {
  await user.click(nextButton());
  const name = screen.getByPlaceholderText('مثال: صفحة Tremella');
  const slug = screen.getByPlaceholderText('tremella');
  await user.clear(name);
  await user.type(name, 'صفحة الحزام');
  await user.clear(slug);
  await user.type(slug, 'belt');
};

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  window.history.replaceState(null, '', '/store/landing-pages');
  screenApi.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/landing-pages?')) return { landingPages: [LIVE_PAGE] };
    if (path === '/api/products') return { products: [PRODUCT, OTHER] };
    if (path === '/api/landing-pages') return { landingPage: { id: 'new1' } };
    if (path === '/api/ai/landing-copy') return { copy: { heroTitle: 'مكتوب بالذكاء' }, note: 'كُتبت خانة' };
    return {};
  });
});

afterEach(cleanup);

describe('the list', () => {
  it('has the columns of the owner’s other platform, and both doors on top', async () => {
    render(<LandingPagesScreen />);
    await screen.findAllByText(LIVE_PAGE.name);
    for (const col of ['المنتج', 'عنوان الصفحة', 'الرابط', 'نشط', 'أُنشئت']) {
      expect(screen.getAllByText(col).length).toBeGreaterThan(0);
    }
    // His views column is not copied: the numbers have one screen here.
    expect(screen.queryByText('المشاهدات')).toBeNull();
    expect(screen.getByRole('button', { name: /إنشاء صفحة هبوط/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /مكتبة القوالب/ })).toBeTruthy();
  });

  it('gives every row view, edit, duplicate and preview', async () => {
    render(<LandingPagesScreen />);
    for (const label of ['عرض', 'تعديل', 'انسخ الصفحة', 'معاينة']) {
      expect((await screen.findAllByLabelText(label)).length).toBeGreaterThan(0);
    }
  });

  it('opens a published page’s link in a new tab', async () => {
    render(<LandingPagesScreen />);
    const link = (await screen.findAllByText(`/lp/${LIVE_PAGE.slug}`))[0].closest('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('step one — the product', () => {
  it('is asked FIRST and alone, because every preview after it sells it', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await openDialog(user);

    expect(dialog().getByText('لأي منتج هاي الصفحة؟')).toBeTruthy();
    expect(dialog().getByRole('button', { name: /اختر منتجًا/ })).toBeTruthy();
    expect(dialog().queryByText(/اكتبها بالذكاء الاصطناعي/)).toBeNull();
    expect(screen.queryByPlaceholderText('مثال: صفحة Tremella')).toBeNull();
  });

  it('will not move on until a product is chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await openDialog(user);
    expect(nextButton()).toHaveProperty('disabled', true);
    await pickProduct(user);
    expect(nextButton()).toHaveProperty('disabled', false);
  });

  it('prints the chosen product’s price under the picker, and none before', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await openDialog(user);
    expect(dialog().queryByText(/^السعر:/)).toBeNull();
    await pickProduct(user);
    expect(dialog().getByText(/^السعر:/).textContent).toContain('120');
  });
});

describe('step two — three ways, named without a menu', () => {
  it('shows all three cards at once', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    expect(dialog().getByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ })).toBeTruthy();
    expect(dialog().getByRole('radio', { name: /استخدم تصميم/ })).toBeTruthy();
    expect(dialog().getByRole('radio', { name: /صفحة فاضية/ })).toBeTruthy();
    expect(nextButton()).toHaveProperty('disabled', true);
  });

  it('shows the AI options with the rule line only when the AI card is chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    expect(dialog().queryByText(/ما بيخترع تقييمات/)).toBeNull();
    await user.click(dialog().getByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ }));
    expect(dialog().getByText('الذكاء الاصطناعي ما بيخترع تقييمات ولا خصومات ولا أرقام.')).toBeTruthy();
    for (const t of ['ودود', 'عرض مقنع', 'فاخر', 'خبير وواقعي']) expect(dialog().getByRole('radio', { name: t })).toBeTruthy();
    for (const d of ['شامية', 'مصرية', 'حسانية', 'فصحى مبسّطة']) expect(dialog().getByRole('radio', { name: d })).toBeTruthy();
  });

  it('will not let a note with a phone number go on, and says why', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ }));
    await user.type(dialog().getByLabelText(/ملاحظات للذكاء الاصطناعي/), 'رقمه 0799123456');
    expect(dialog().getByText(/رقم طويل/)).toBeTruthy();
    expect(nextButton()).toHaveProperty('disabled', true);
  });

  it('and back returns to the product with the product still chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(backButton());
    expect(dialog().getByRole('button', { name: PRODUCT.name })).toBeTruthy();
  });
});

describe('the AI path — the story', () => {
  it('lists the ten structures, drawing the seller’s product into each first beat', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toStory(user);
    for (const s of LANDING_STRUCTURES) expect(screen.getAllByText(s.name).length).toBeGreaterThan(0);
    expect(dialog().getAllByText(PRODUCT.name).length).toBeGreaterThanOrEqual(LANDING_STRUCTURES.length);
    // «ابنيلي صفحة الهبوط» moved here, beside the ten it chooses between.
    expect(dialog().getAllByText(/ابنيلي صفحة الهبوط/).length).toBeGreaterThan(0);
  });

  it('will not let a page be made with no story chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toStory(user);
    expect(nextButton()).toHaveProperty('disabled', true);
    await user.click(screen.getByText(STRUCTURE_PROBLEM_SOLUTION.name));
    expect(nextButton()).toHaveProperty('disabled', false);
  });
});

describe('the AI path — the look', () => {
  it('draws the chosen structure in every store skin — one story, ten looks', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toLook(user);
    await user.click(dialog().getByRole('button', { name: /مظاهر المتجر/ }));
    await user.click(screen.getByText(STORE_TEMPLATES[3].name));

    const drawn = preview.mock.calls.slice(-STORE_TEMPLATES.length).map((c) => c[0]);
    expect(drawn).toHaveLength(STORE_TEMPLATES.length);
    expect(new Set(drawn.map((d) => d.sections)).size).toBe(1);
    expect(new Set(drawn.map((d) => d.theme.accent)).size).toBe(STORE_TEMPLATES.length);
  });

  it('offers the sixty-four designs with counted category chips', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toLook(user);
    expect(dialog().getAllByRole('radio', { name: /./ }).filter((r) => (r as HTMLInputElement).name === 'lp-design')).toHaveLength(64);
    await user.click(dialog().getByRole('button', { name: /^أكل/ }));
    expect(dialog().getAllByRole('radio').filter((r) => (r as HTMLInputElement).name === 'lp-design')).toHaveLength(1);
    // Every card carries its full-preview link, in a new tab, with the product.
    const link = dialog().getByText('معاينة كاملة ↗').closest('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toMatch(/^\/lp\/design-preview\/food-tasty\?product=p1$/);
  });

  it('ends on «اكتب الصفحة بالذكاء الاصطناعي», which writes in the chosen voice', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ }));
    await user.click(dialog().getByRole('radio', { name: 'فاخر' }));
    await user.click(dialog().getByRole('radio', { name: 'شامية' }));
    await user.type(dialog().getByLabelText(/ملاحظات للذكاء الاصطناعي/), 'ركّز على الريحة');
    await user.click(nextButton());
    await user.click(screen.getByText(STRUCTURE_PROBLEM_SOLUTION.name));
    await user.click(nextButton());
    await user.click(writeButton());

    const asked = sentTo('/api/ai/landing-copy');
    expect(asked.tone).toBe('premium');
    expect(asked.dialect).toBe('levantine');
    expect(asked.notes).toBe('ركّز على الريحة');
    expect(asked.structureId).toBe(STRUCTURE_PROBLEM_SOLUTION.id);
    expect(await dialog().findByDisplayValue('مكتوب بالذكاء')).toBeTruthy();
  });

  it('sends no voice when none was chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    expect('tone' in sentTo('/api/ai/landing-copy')).toBe(false);
  });
});

describe('the AI path — the words', () => {
  it('shows every slot of the chosen structure with its guide', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    for (const slot of STRUCTURE_PROBLEM_SOLUTION.slots) {
      expect(screen.getByLabelText(new RegExp(slot.label))).toBeTruthy();
    }
    expect(screen.getAllByText(/^ممنوع:/).length).toBe(STRUCTURE_PROBLEM_SOLUTION.slots.length);
  });

  it('puts what is typed into the preview as it is typed', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    const hero = STRUCTURE_PROBLEM_SOLUTION.slots.find((s) => s.key === 'heroTitle')!;
    const field = await screen.findByDisplayValue('مكتوب بالذكاء');
    await user.clear(field);
    await user.type(screen.getByLabelText(new RegExp(hero.label)), 'وجع');
    const last = preview.mock.calls[preview.mock.calls.length - 1][0];
    expect(last.sections[hero.at][hero.field]).toBe('وجع');
  });

  it('keeps the words when the AI cannot write, and says so', async () => {
    screenApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/landing-pages?')) return { landingPages: [] };
      if (path === '/api/products') return { products: [PRODUCT] };
      if (path === '/api/ai/landing-copy') throw new Error('الذكاء الاصطناعي مش مضبوط');
      return {};
    });
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    expect(await dialog().findByText(/الذكاء الاصطناعي مش مضبوط/)).toBeTruthy();
    const hero = STRUCTURE_PROBLEM_SOLUTION.slots.find((s) => s.key === 'heroTitle')!;
    expect(screen.getByLabelText(new RegExp(hero.label))).toBeTruthy();
  });
});

describe('what leaves the wizard', () => {
  it('the AI path sends the structure, the skin, the dialect and the words — and no shape', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toLook(user);
    await user.click(dialog().getByRole('button', { name: /مظاهر المتجر/ }));
    await user.click(screen.getByText(STORE_TEMPLATES[0].name));
    await user.click(writeButton());
    await dialog().findByDisplayValue('مكتوب بالذكاء');
    await toNaming(user);
    await user.click(createButton());

    const body = sentBody();
    expect(body.structure).toBe(STRUCTURE_PROBLEM_SOLUTION.id);
    expect(body.skin).toBe(STORE_TEMPLATES[0].id);
    expect(body.dialect).toBe('msa');
    expect(body.copy.heroTitle.msa).toBe('مكتوب بالذكاء');
    expect(body.productId).toBe(PRODUCT.id);
    expect(body.template).toBeUndefined();
    expect(body.design).toBeUndefined();
  });

  it('the AI path with a design sends the design and no skin', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toLook(user);
    await user.click(dialog().getByRole('radio', { name: DESIGNS[0].name }));
    await user.click(writeButton());
    await toNaming(user);
    await user.click(createButton());
    const body = sentBody();
    expect(body.design).toBe(DESIGNS[0].id);
    expect(body.skin).toBeUndefined();
  });

  it('the design path saves the chosen design on a ready page, with no copy to refuse', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /استخدم تصميم/ }));
    await user.click(nextButton());
    // A design is the step's one question: no moving on without one.
    expect(nextButton()).toHaveProperty('disabled', true);
    await user.click(dialog().getByRole('radio', { name: 'روز غولد' }));
    await toNaming(user);
    await user.click(createButton());

    const body = sentBody();
    expect(body.design).toBe('rose-gold');
    expect(body.template).toBe('classic');
    expect(body.copy).toBeUndefined();
    expect(body.structure).toBeUndefined();
  });

  it('and the fifteen ready-made shapes are one labelled tab away, sent alone', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /استخدم تصميم/ }));
    await user.click(nextButton());
    await user.click(dialog().getByRole('button', { name: /أشكال جاهزة/ }));
    await user.click(dialog().getAllByText('قصيرة وسريعة')[0]);
    await toNaming(user);
    await user.click(createButton());

    const body = sentBody();
    expect(body.template).toBe('short');
    expect(body.design).toBeUndefined();
    expect(body.copy).toBeUndefined();
  });

  it('the blank path goes straight to the name and sends the empty page', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /صفحة فاضية/ }));
    await user.click(nextButton());
    expect(screen.getByPlaceholderText('tremella')).toBeTruthy();
    await toNamingHere(user);
    await user.click(createButton());
    const body = sentBody();
    expect(body.template).toBe('blank');
    expect(body.productId).toBe(PRODUCT.id);
  });

  it('«ابدأ صفحة فاضية بدون منتج» makes a blank page that sells nothing', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await openDialog(user);
    await user.click(dialog().getByRole('button', { name: 'ابدأ صفحة فاضية بدون منتج' }));
    await toNamingHere(user);
    await user.click(createButton());
    const body = sentBody();
    expect(body.template).toBe('blank');
    expect(body.productId).toBeNull();
  });

  it('a page with no product cannot take the AI path, and the card says why', async () => {
    window.history.replaceState(null, '', '/store/landing-pages?new=1&way=design&design=rose-gold');
    render(<LandingPagesScreen />);
    const ai = await dialog().findByRole('radio', { name: /اكتبها بالذكاء الاصطناعي/ });
    expect((ai as HTMLInputElement).disabled).toBe(true);
    expect(dialog().getByText(/ارجع واختار منتج/)).toBeTruthy();
  });

  it('keeps every slot, not only the last one typed', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    await dialog().findByDisplayValue('مكتوب بالذكاء');

    const [first, second] = STRUCTURE_PROBLEM_SOLUTION.slots;
    await user.clear(screen.getByLabelText(new RegExp(first.label)));
    await user.type(screen.getByLabelText(new RegExp(first.label)), 'أوّل');
    await user.clear(screen.getByLabelText(new RegExp(second.label)));
    await user.type(screen.getByLabelText(new RegExp(second.label)), 'ثانٍ');
    await toNaming(user);
    await user.click(createButton());

    const body = sentBody();
    expect(body.copy[first.key].msa).toBe('أوّل');
    expect(body.copy[second.key].msa).toBe('ثانٍ');
  });

  it('keeps both dialects of one slot, so a second pass is not a replacement', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    const hero = STRUCTURE_PROBLEM_SOLUTION.slots.find((s) => s.key === 'heroTitle')!;
    const field = () => screen.getByLabelText(new RegExp(hero.label));
    await dialog().findByDisplayValue('مكتوب بالذكاء');
    await user.clear(field());
    await user.type(field(), 'بالفصحى');
    await user.click(screen.getByRole('button', { name: 'شامية' }));
    await user.clear(field());
    await user.type(field(), 'بالشامي');
    await toNaming(user);
    await user.click(createButton());

    const body = sentBody();
    expect(body.copy.heroTitle.msa).toBe('بالفصحى');
    expect(body.copy.heroTitle.levantine).toBe('بالشامي');
    expect(body.dialect).toBe('levantine');
  });

  it('fills the name and the address from the product, and refuses to create without them', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toMethod(user);
    await user.click(dialog().getByRole('radio', { name: /صفحة فاضية/ }));
    await user.click(nextButton());
    expect((screen.getByPlaceholderText('مثال: صفحة Tremella') as HTMLInputElement).value).toBe(PRODUCT.name);
    expect((screen.getByPlaceholderText('tremella') as HTMLInputElement).value).toBe('belt-1');
    await user.clear(screen.getByPlaceholderText('tremella'));
    expect(createButton()).toHaveProperty('disabled', true);
  });

  it('opens the editor of the page it created', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, set href(v: string) { assign(v); }, get href() { return original.href; } },
    });
    try {
      render(<LandingPagesScreen />);
      await toMethod(user);
      await user.click(dialog().getByRole('radio', { name: /صفحة فاضية/ }));
      await user.click(nextButton());
      await user.click(createButton());
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/store/landing-pages/new1/editor'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

/** On the name step already: clear and type both fields. */
async function toNamingHere(user: User) {
  const name = screen.getByPlaceholderText('مثال: صفحة Tremella');
  const slug = screen.getByPlaceholderText('tremella');
  await user.clear(name);
  await user.type(name, 'صفحة فاضية');
  await user.clear(slug);
  await user.type(slug, 'blank-page');
}

describe('from the library', () => {
  it('reads the address it was handed', () => {
    expect(wizardStartFrom('?new=1&way=ai&design=cod-bold&product=p1')).toEqual({
      way: 'ai', design: 'cod-bold', productId: 'p1',
    });
    expect(wizardStartFrom('?design=cod-bold')).toBeNull();
    expect(wizardStartFrom('?new=1&way=sideways')).toEqual({});
  });

  it('«استخدم هالقالب» starts on step two with that design chosen', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/store/landing-pages?new=1&way=design&design=rose-gold&product=p1');
    render(<LandingPagesScreen />);
    expect(await dialog().findByText('كيف بدك تبلّش؟')).toBeTruthy();
    expect((dialog().getByRole('radio', { name: /استخدم تصميم/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(nextButton());
    expect((dialog().getByRole('radio', { name: 'روز غولد' }) as HTMLInputElement).checked).toBe(true);
  });

  it('an unknown design in the address chooses nothing', async () => {
    window.history.replaceState(null, '', '/store/landing-pages?new=1&way=design&design=no-such&product=p1');
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await dialog().findByText('كيف بدك تبلّش؟');
    await user.click(nextButton());
    expect(nextButton()).toHaveProperty('disabled', true);
  });
});

describe('taking a page down from the list', () => {
  const patched = () =>
    screenApi.mock.calls.filter(
      (c) => c[0] === `/api/landing-pages/${LIVE_PAGE.id}` && (c[1] as RequestInit)?.method === 'PATCH'
    );

  it('asks, and names the paid clicks that would hit a closed page', async () => {
    const user = userEvent.setup();
    confirm.mockResolvedValue(false);
    render(<LandingPagesScreen />);
    await user.click((await screen.findAllByTitle('إلغاء النشر'))[0]);
    expect(confirm).toHaveBeenCalledTimes(1);
    const asked = confirm.mock.calls[0][0];
    expect(asked.body).toMatch(/مدفوعة/);
    expect(asked.tone).toBe('danger');
  });

  it('and leaves the page exactly as it was when the answer is no', async () => {
    const user = userEvent.setup();
    confirm.mockResolvedValue(false);
    render(<LandingPagesScreen />);
    await user.click((await screen.findAllByTitle('إلغاء النشر'))[0]);
    expect(patched()).toHaveLength(0);
  });

  it('takes it down when the answer is yes', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await user.click((await screen.findAllByTitle('إلغاء النشر'))[0]);
    expect(patched()).toHaveLength(1);
    expect(JSON.parse((patched()[0][1] as RequestInit).body as string)).toEqual({ isPublished: false });
  });

  it('and «أظهِرها في المتجر» is a different act, so it does not ask this question', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await user.click((await screen.findAllByLabelText('أظهِرها في المتجر'))[0]);
    expect(confirm).not.toHaveBeenCalled();
    expect(patched()).toHaveLength(1);
  });
});

describe('the wizard forgets the last page', () => {
  it('reopens on step one with nothing chosen', async () => {
    const user = userEvent.setup();
    render(<LandingPagesScreen />);
    await toWords(user);
    await dialog().findByDisplayValue('مكتوب بالذكاء');
    await user.click(screen.getByRole('button', { name: /^إلغاء$/ }));

    await openDialog(user);
    expect(dialog().getByText('لأي منتج هاي الصفحة؟')).toBeTruthy();
    expect(dialog().getByRole('button', { name: /اختر منتجًا/ })).toBeTruthy();
    expect(dialog().queryByDisplayValue('مكتوب بالذكاء')).toBeNull();
  });
});
