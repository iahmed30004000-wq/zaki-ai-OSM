// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { defaultWalletColorKey, WALLET_COLOR_KEYS, WALLET_ICON_KEYS } from '@/lib/wallet-look';

/**
 * «كل محفظة لازم تكون مميزة» — THE WALLETS SCREEN: EACH WALLET BY ITS FACE, AND THE EDITOR THAT GIVES IT ONE.
 *
 * The owner approved a drawing with «تم»: a card per wallet with its picture (or its icon in its colour), the name, «البلد ·
 * العملة» and the balance; and in the manage menu «تعديل شكل المحفظة», which opens a dialog — a preview, «ارفع صورة» (or «غيّر
 * الصورة» and «شيل الصورة»), «أو اختار أيقونة جاهزة», «واللون».
 *
 * WHAT IS HELD
 *   · the list, the ledger's heading and the movement dialog all wear the face `walletLook` gives, with nothing chosen too;
 *   · who is offered the editor: the wallets' own key, in the fold beside the rename — nobody else;
 *   · the editor: the preview follows every press; a picture is uploaded to ITS door at once and kept as a key until the save;
 *     a refusal — the door's, or the screen's own before the bytes leave — is read in the dialog and leaves nothing to save;
 *   · THE WIRE of the save: only what changed, as the PATCH door reads it, `null` to clear; «إلغاء» sends nothing.
 *
 * The real shared client runs (only `fetch` is a stand-in), so the upload really is a multipart body with a `file` part.
 */

const { who, phone } = vi.hoisted(() => ({ who: { keys: [] as string[] }, phone: { value: true } }));

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { WalletsScreen } from './WalletsScreen';

const COMPANY = '4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31';
const keyFor = (wallet: string, file = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d') => `companies/${COMPANY}/products/${wallet}/${file}.webp`;
const NEW_KEY = keyFor('w1', '5e5e5e5e-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
const OLD_KEY = keyFor('w1', '1d1d1d1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');

/** A wallet as the list answers it — the look fields are typed as what they are, a key or nothing. */
interface TestWallet {
  id: string; name: string; currencyCode: string; isActive: boolean;
  opening: number; in: number; out: number; balance: number; movements: number; openingCount: null;
  country: { id: string; name: string } | null;
  imageKey: string | null; iconKey: string | null; colorKey: string | null;
}
const base = { opening: 0, in: 0, out: 0, movements: 2, openingCount: null, isActive: true, imageKey: null, iconKey: null, colorKey: null };
const makeWallets = (): TestWallet[] => [
  { ...base, id: 'w1', name: 'بينانس', currencyCode: 'USDT', balance: 250, country: { id: 'c1', name: 'سوريا' } },
  { ...base, id: 'w2', name: 'الصندوق', currencyCode: 'USD', balance: 40, country: { id: 'c1', name: 'سوريا' }, iconKey: 'drawer', colorKey: 'chart-4' },
];

interface Call { url: string; method: string; body?: unknown; form?: FormData }
let calls: Call[] = [];
let wallets: TestWallet[] = makeWallets();
let uploadAnswer: { status: number; body: unknown };
let patchAnswer: { status: number; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  who.keys = ['finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage'];
  phone.value = true;
  calls = [];
  wallets = makeWallets();
  uploadAnswer = { status: 200, body: { success: true, imageKey: NEW_KEY } };
  patchAnswer = { status: 200, body: { wallet: { id: 'w1' } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/image')) {
        calls.push({ url, method, form: init?.body as FormData });
        return json(uploadAnswer.body, uploadAnswer.status);
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, method, body });
        // A save that went through is what the next read of the list says.
        if (patchAnswer.status === 200) Object.assign(wallets.find((w) => url.endsWith(`/${w.id}`)) ?? {}, body);
        return json(patchAnswer.body, patchAnswer.status);
      }
      calls.push({ url, method });
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  render(<WalletsScreen />);
  await screen.findAllByText('بينانس');
};
const card = (name: RegExp | string) => screen.getByRole('button', { name }) as HTMLElement;
const faceIn = (el: Element) => el.querySelector('[data-wallet-picture]') as HTMLElement;
const editorButton = () => screen.queryAllByRole('button', { name: 'تعديل شكل المحفظة', hidden: true })[0] as HTMLElement | undefined;
const openEditor = async () => {
  await draw();
  fireEvent.click(editorButton()!);
  return screen.findByRole('dialog', { name: 'تعديل شكل المحفظة' });
};
const previewOf = (dialog: HTMLElement) => faceIn(dialog);
const press = (dialog: HTMLElement, name: string) => fireEvent.click(within(dialog).getByRole('button', { name }));
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'احفظ' }) as HTMLButtonElement;
const patches = () => calls.filter((c) => c.method === 'PATCH');
const uploads = () => calls.filter((c) => c.method === 'POST');
const fileBox = (dialog: HTMLElement) => within(dialog).getByLabelText('ملف الصورة') as HTMLInputElement;
const choose = (dialog: HTMLElement, file: File) => fireEvent.change(fileBox(dialog), { target: { files: [file] } });
const png = (name = 'logo.png', type = 'image/png', bytes = 2048) => new File([new Uint8Array(bytes)], name, { type });

describe('the list shows every wallet by its face', () => {
  it('a card wears the face of its wallet — what was chosen, or the currency’s icon in the id’s colour — and says «البلد · العملة»', async () => {
    await draw();
    const binance = card(/بينانس/);
    expect(faceIn(binance).dataset.icon).toBe('wallet'); // nothing chosen, and USDT is not a three-letter code
    expect(faceIn(binance).dataset.color).toBe(defaultWalletColorKey('w1'));
    expect(faceIn(binance).style.width).toBe('44px');
    expect(binance.textContent).toContain('سوريا · USDT');

    const cash = card(/الصندوق/);
    expect(faceIn(cash).dataset.icon).toBe('drawer');
    expect(faceIn(cash).dataset.color).toBe('chart-4');
    expect(cash.textContent).toContain('سوريا · USD');
    // The balance is where it was.
    expect(binance.textContent).toContain('250');
  });

  it('with no country the line is the currency alone — no stray dot', async () => {
    wallets = [{ ...makeWallets()[0], country: null }];
    await draw();
    expect(card(/بينانس/).textContent).toContain('USDT');
    expect(card(/بينانس/).textContent).not.toContain('·');
  });

  it('a card with a picture draws it, and the picture falls back to the icon when it will not load', async () => {
    wallets = [{ ...makeWallets()[0], imageKey: OLD_KEY, iconKey: 'bank', colorKey: 'success' }];
    await draw();
    const img = faceIn(card(/بينانس/)).querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/media/${OLD_KEY}`);
    fireEvent.error(img);
    expect(faceIn(card(/بينانس/)).querySelector('img')).toBeNull();
    expect(faceIn(card(/بينانس/)).dataset.icon).toBe('bank');
  });

  it('the ledger’s heading wears the face of the wallet it is about, and follows the selection', async () => {
    await draw();
    const heading = () => screen.getByRole('heading', { level: 2 });
    await waitFor(() => expect(heading().textContent).toContain('حركات بينانس'));
    expect(faceIn(heading()).dataset.icon).toBe('wallet');
    expect(faceIn(heading()).style.width).toBe('32px');
    fireEvent.click(card(/الصندوق/));
    await waitFor(() => expect(heading().textContent).toContain('حركات الصندوق'));
    expect(faceIn(heading()).dataset.icon).toBe('drawer');
  });

  it('the movement dialog shows the face of the wallet money moves on, and where it is', async () => {
    await draw();
    fireEvent.click(await screen.findByRole('button', { name: 'حركة جديدة' }));
    const dialog = await screen.findByRole('dialog', { name: /حركة جديدة — بينانس/ });
    expect(faceIn(dialog).dataset.icon).toBe('wallet');
    expect(dialog.textContent).toContain('سوريا · USDT');
  });
});

describe('who is offered «تعديل شكل المحفظة»', () => {
  it('the wallets’ key draws it in the fold beside the rename, and the fold says so', async () => {
    await draw();
    const button = editorButton()!;
    expect(button).toBeTruthy();
    const fold = button.closest('details[data-advanced-group]') as HTMLElement;
    expect(fold).not.toBeNull();
    expect(fold.querySelector('summary')!.textContent).toContain('الشكل');
    expect(within(fold).getByRole('button', { name: 'عدّل الاسم', hidden: true })).toBeTruthy();
  });

  it('NEGATIVE: who only sees the cash box, or only records its cash, is not offered it', async () => {
    for (const keys of [['finance.cashbox_view'], ['finance.cashbox_view', 'finance.cashbox'], ['finance.cashbox_view', 'storefront.manage']]) {
      who.keys = keys;
      await draw();
      expect(editorButton(), keys.join()).toBeUndefined();
      cleanup();
    }
  });

  it('a stopped wallet still has it — a stopped wallet is still recognised by its face', async () => {
    wallets = [{ ...makeWallets()[0], isActive: false }];
    await draw();
    expect(editorButton()).toBeTruthy();
  });
});

describe('the editor starts from the wallet’s current face', () => {
  it('shows it in the preview with the name and the place, offers «ارفع صورة», and has nothing to save yet', async () => {
    const dialog = await openEditor();
    expect(previewOf(dialog).dataset.icon).toBe('wallet');
    expect(previewOf(dialog).dataset.color).toBe(defaultWalletColorKey('w1'));
    expect(previewOf(dialog).style.width).toBe('64px');
    expect(dialog.textContent).toContain('بينانس');
    expect(dialog.textContent).toContain('سوريا · USDT');
    expect(within(dialog).getByRole('button', { name: 'ارفع صورة' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'شيل الصورة' })).toBeNull();
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('says what a picture may be and who will see it — the bank’s card is the owner’s own example, and it carries a number', async () => {
    const dialog = await openEditor();
    expect(dialog.textContent).toContain('PNG أو JPG أو WEBP، لحد 5 ميجابايت');
    expect(dialog.textContent).toContain('لا تحط صورة فيها رقم بطاقة أو حساب');
  });

  it('offers every icon and every colour of the lists — each a button of 44px under a finger', async () => {
    const dialog = await openEditor();
    const icons = within(within(dialog).getByRole('group', { name: 'الأيقونة' })).getAllByRole('button');
    const colours = within(within(dialog).getByRole('group', { name: 'اللون' })).getAllByRole('button');
    expect(icons).toHaveLength(WALLET_ICON_KEYS.length);
    expect(colours).toHaveLength(WALLET_COLOR_KEYS.length);
    for (const b of [...icons, ...colours]) {
      expect(b.className).toContain('min-h-11');
      expect(b.className).toContain('min-w-11');
      expect(b.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('a wallet that already has a picture opens on it, with «غيّر الصورة» and «شيل الصورة»', async () => {
    wallets = [{ ...makeWallets()[0], imageKey: OLD_KEY }];
    const dialog = await openEditor();
    expect((previewOf(dialog).querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(`/api/media/${OLD_KEY}`);
    expect(within(dialog).getByRole('button', { name: 'غيّر الصورة' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'شيل الصورة' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'ارفع صورة' })).toBeNull();
  });
});

describe('an icon and a colour — seen at once, sent only when saved', () => {
  it('the preview follows each press, the pressed ones say so, and nothing is sent before «احفظ»', async () => {
    const dialog = await openEditor();
    press(dialog, 'بنك');
    expect(previewOf(dialog).dataset.icon).toBe('bank');
    expect(within(dialog).getByRole('button', { name: 'بنك' }).getAttribute('aria-pressed')).toBe('true');
    press(dialog, 'لون 6');
    expect(previewOf(dialog).dataset.color).toBe(WALLET_COLOR_KEYS[5]);
    expect(within(dialog).getByRole('button', { name: 'لون 6' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'لون 1' }).getAttribute('aria-pressed')).toBe('false');
    expect(saveButton(dialog).disabled).toBe(false);
    expect(patches()).toHaveLength(0);
  });

  it('«احفظ» sends only what changed to the wallet’s own door, closes, says so, and the list wears the new face', async () => {
    const dialog = await openEditor();
    press(dialog, 'بنك');
    press(dialog, 'لون 3');
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].url).toBe('/api/finance/wallets/w1');
    expect(patches()[0].body).toEqual({ iconKey: 'bank', colorKey: WALLET_COLOR_KEYS[2] });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'تعديل شكل المحفظة' })).toBeNull());
    expect(await screen.findByText('تم تغيير شكل المحفظة')).toBeTruthy();
    await waitFor(() => expect(faceIn(card(/بينانس/)).dataset.icon).toBe('bank'));
    expect(faceIn(card(/بينانس/)).dataset.color).toBe(WALLET_COLOR_KEYS[2]);
    // The list was read again after the save.
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/finance/wallets').length).toBeGreaterThanOrEqual(2);
  });

  it('pressing the colour that is already saved sends nothing, and the save stays off', async () => {
    const dialog = await (async () => {
      wallets = [{ ...makeWallets()[0], colorKey: 'warning' }];
      return openEditor();
    })();
    press(dialog, `لون ${WALLET_COLOR_KEYS.indexOf('warning') + 1}`);
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('«إلغاء» sends nothing and leaves the wallet as it was', async () => {
    const dialog = await openEditor();
    press(dialog, 'عملة رقمية');
    press(dialog, 'إلغاء');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'تعديل شكل المحفظة' })).toBeNull());
    expect(patches()).toHaveLength(0);
    expect(uploads()).toHaveLength(0);
    expect(faceIn(card(/بينانس/)).dataset.icon).toBe('wallet');
  });

  it('a refused save keeps the dialog open and says what the door said', async () => {
    patchAnswer = { status: 400, body: { error: 'اللون مش من الألوان الجاهزة' } };
    const dialog = await openEditor();
    press(dialog, 'لون 2');
    fireEvent.click(saveButton(dialog));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('اللون مش من الألوان الجاهزة');
    expect(screen.getByRole('dialog', { name: 'تعديل شكل المحفظة' })).toBeTruthy();
    expect(saveButton(dialog).disabled).toBe(false);
  });
});

describe('the picture — uploaded at once to its own door, kept as a key until the save', () => {
  it('a chosen file goes to the wallet’s picture door as a multipart `file`, the preview shows it, and «احفظ» sends its key', async () => {
    const dialog = await openEditor();
    const file = png('binance.png');
    choose(dialog, file);
    await waitFor(() => expect(previewOf(dialog).dataset.hasImage).toBe('true'));
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].url).toBe('/api/finance/wallets/w1/image');
    expect((uploads()[0].form!.get('file') as File).name).toBe('binance.png');
    expect((previewOf(dialog).querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(`/api/media/${NEW_KEY}`);
    // Nothing is on the wallet yet: the key is held by the dialog.
    expect(patches()).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'غيّر الصورة' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'شيل الصورة' })).toBeTruthy();

    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ imageKey: NEW_KEY });
  });

  it('a refused upload shows the DOOR’S own sentence in the dialog, changes nothing, and leaves nothing to save', async () => {
    uploadAnswer = { status: 400, body: { error: 'محتوى الملف ليس صورة صالحة' } };
    const dialog = await openEditor();
    choose(dialog, png());
    expect((await within(dialog).findByRole('alert')).textContent).toBe('محتوى الملف ليس صورة صالحة');
    expect(previewOf(dialog).dataset.hasImage).toBe('false');
    expect(within(dialog).getByRole('button', { name: 'ارفع صورة' })).toBeTruthy();
    expect(saveButton(dialog).disabled).toBe(true);
    expect(patches()).toHaveLength(0);
  });

  it('an answer that is not a key of ours is a failed upload, never a picture', async () => {
    uploadAnswer = { status: 200, body: { success: true, imageKey: 'https://evil.example/x.png' } };
    const dialog = await openEditor();
    choose(dialog, png());
    expect((await within(dialog).findByRole('alert')).textContent).toBe('تعذّر رفع الصورة');
    expect(previewOf(dialog).dataset.hasImage).toBe('false');
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('NEGATIVE: a file that is not png, jpeg or webp (an SVG, a gif) is refused on the screen, before any byte is sent', async () => {
    const dialog = await openEditor();
    for (const [name, type] of [['a.svg', 'image/svg+xml'], ['a.gif', 'image/gif'], ['a.pdf', 'application/pdf']]) {
      choose(dialog, png(name, type));
      expect((await within(dialog).findByRole('alert')).textContent).toBe('صيغة الملف غير مدعومة. المسموح: PNG وJPG وWEBP');
    }
    expect(uploads()).toHaveLength(0);
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('NEGATIVE: a file over 5 MB is refused on the screen with the door’s sentence, before any byte is sent', async () => {
    const dialog = await openEditor();
    choose(dialog, png('big.png', 'image/png', 5 * 1024 * 1024 + 1));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('حجم الصورة يتجاوز الحد المسموح (5 ميجابايت)');
    expect(uploads()).toHaveLength(0);
  });

  it('the file box only offers the three kinds, and is named for a screen reader', async () => {
    const dialog = await openEditor();
    expect(fileBox(dialog).getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
    expect(fileBox(dialog).type).toBe('file');
  });

  it('«شيل الصورة» takes it off the preview, and saving it sends `null` — the file stays where it is', async () => {
    wallets = [{ ...makeWallets()[0], imageKey: OLD_KEY, iconKey: 'bank', colorKey: 'success' }];
    const dialog = await openEditor();
    press(dialog, 'شيل الصورة');
    expect(previewOf(dialog).dataset.hasImage).toBe('false');
    expect(previewOf(dialog).dataset.icon).toBe('bank');
    expect(within(dialog).getByRole('button', { name: 'ارفع صورة' })).toBeTruthy();
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ imageKey: null });
    expect(uploads()).toHaveLength(0);
  });

  it('an icon is chosen INSTEAD of a picture: pressing one takes the picture off, so the preview really changes', async () => {
    wallets = [{ ...makeWallets()[0], imageKey: OLD_KEY }];
    const dialog = await openEditor();
    press(dialog, 'هاتف');
    expect(previewOf(dialog).dataset.hasImage).toBe('false');
    expect(previewOf(dialog).dataset.icon).toBe('phone');
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ imageKey: null, iconKey: 'phone' });
  });

  it('while a file is on its way the button says so and cannot be pressed twice, and the save waits', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const real = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') await held;
      return real(url, init);
    }));
    const dialog = await openEditor();
    press(dialog, 'لون 2');
    choose(dialog, png());
    const busy = (await within(dialog).findByRole('button', { name: 'جارٍ الرفع…' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(saveButton(dialog).disabled).toBe(true);
    release();
    await waitFor(() => expect(previewOf(dialog).dataset.hasImage).toBe('true'));
    expect(saveButton(dialog).disabled).toBe(false);
  });
});

describe('back to the default', () => {
  it('«رجّع الشكل التلقائي» clears the picture, the icon and the colour, and saving sends `null` for what was saved', async () => {
    wallets = [{ ...makeWallets()[0], imageKey: OLD_KEY, iconKey: 'bank', colorKey: 'warning' }];
    const dialog = await openEditor();
    press(dialog, 'رجّع الشكل التلقائي');
    expect(previewOf(dialog).dataset.hasImage).toBe('false');
    expect(previewOf(dialog).dataset.icon).toBe('wallet');
    expect(previewOf(dialog).dataset.color).toBe(defaultWalletColorKey('w1'));
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ imageKey: null, iconKey: null, colorKey: null });
  });

  it('is off for a wallet with nothing chosen — there is nothing to go back from', async () => {
    const dialog = await openEditor();
    expect((within(dialog).getByRole('button', { name: 'رجّع الشكل التلقائي' }) as HTMLButtonElement).disabled).toBe(true);
    press(dialog, 'نقد');
    expect((within(dialog).getByRole('button', { name: 'رجّع الشكل التلقائي' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
