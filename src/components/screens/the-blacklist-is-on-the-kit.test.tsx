// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القائمة السوداء» ON THE KIT SENDS WHAT IT SENT AND PRINTS A PHONE WHERE IT DID (R16i, 18/11)
 *
 * The screen moved into `PageShell` (the title read from the registry), its surfaces into `Card`, its six hand-written
 * buttons into `Button`, its one tick into `Checkbox` with an explicit id, and its small words to the 13px size. Nothing
 * it fetches, sends, asks a key for, or says moved with it.
 *
 * So the screen as it stood on main — a frozen copy beside this file, `BlacklistScreen.as-on-main.test.tsx` — and the
 * live screen are driven through the SAME presses against the same fake door, and each must make the same requests
 * (method, address, and the body exactly as the string that leaves the browser), draw the same set of buttons, and
 * print a blocked phone the same number of times at every step: no new place shows it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  user: { current: { id: 'u0', role: 'COMPANY_ADMIN', permissions: [] as string[] } as Record<string, unknown> },
  blocks: [] as Record<string, unknown>[],
  calls: [] as string[],
  refuse: null as null | string,
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/control/blacklist', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', isRtl: true, t: {}, currentUser: h.user.current }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  // Once on mount and again when the search changes (the real hook is keyed on the term the same way).
  useLiveRefresh: (load: () => Promise<void>, opts?: { key?: unknown }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    h.calls.push(`${method} ${url} ${init?.body ?? ''}`);
    if (method !== 'GET') {
      if (h.refuse) throw new Error(h.refuse);
      return { ok: true };
    }
    return { blocks: h.blocks };
  }),
  apiFetch: vi.fn(),
}));

import { BlacklistScreen as Live } from './BlacklistScreen';
import { BlacklistScreen as OnMain } from './BlacklistScreen.as-on-main.test';

const PHONE = '0790 000 111';
const OTHER = '0933111222';
const block = (over: Record<string, unknown>) => ({
  id: 'b1', phone: PHONE, name: 'زبون تجربة', reason: 'رفض الاستلام مرتين', createdAt: '2026-11-18T10:00:00.000Z',
  blockedByName: 'مشرفة', releasedAt: null, releasedByName: null, releaseReason: null, active: true,
  customer: { totalOrders: 4, deliveredOrders: 1, cancelledOrders: 3 },
  ...over,
});

beforeEach(() => {
  h.user.current = { id: 'u0', role: 'COMPANY_ADMIN', permissions: ['control.blacklist', 'control.blacklist_manage'] };
  h.blocks = [
    block({}),
    block({ id: 'b2', phone: OTHER, name: null, active: false, releasedAt: '2026-11-18T11:00:00.000Z', releasedByName: 'مدير', releaseReason: 'اعتذر والتزم' }),
  ];
  h.calls = [];
  h.refuse = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const phoneCount = (p: string) => (document.body.textContent ?? '').split(p).length - 1;
const buttonNames = () => screen.queryAllByRole('button').map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).sort();
const pressButton = async (name: string | RegExp, where: HTMLElement = document.body) => {
  await act(async () => { fireEvent.click(within(where).getAllByRole('button', { name })[0]); });
  await flush();
};
const fill = async (el: Element, value: string) => { await act(async () => { fireEvent.change(el, { target: { value } }); }); };
const submitDialog = async () => {
  const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
  await act(async () => { fireEvent.submit(form); });
  await flush();
};

type Step = { calls: string[]; buttons: string[]; phones: number; others: number };
type Script = (snap: (label: string) => void) => Promise<void>;

async function drive(Screen: React.ComponentType, script: Script): Promise<Record<string, Step>> {
  h.calls = [];
  const out: Record<string, Step> = {};
  render(<Screen />);
  await flush();
  const snap = (label: string) => {
    out[label] = { calls: [...h.calls], buttons: buttonNames(), phones: phoneCount(PHONE), others: phoneCount(OTHER) };
  };
  snap('loaded');
  await script(snap);
  cleanup();
  return out;
}

const SCRIPTS: Record<string, Script> = {
  'block a number (trimmed phone, no name → no name key)': async (snap) => {
    await pressButton(/حظر رقم/);
    snap('dialog');
    const dialog = screen.getByRole('dialog');
    await fill(within(dialog).getByPlaceholderText('0790123456'), '  0944 555 666 ');
    await fill(within(dialog).getByPlaceholderText('مثال: رفض الاستلام 3 مرات متتالية'), '  رفض ثلاث مرات ');
    await submitDialog();
    snap('saved');
  },
  'block a number with a name': async (snap) => {
    await pressButton(/حظر رقم/);
    const dialog = screen.getByRole('dialog');
    const [phone, name] = within(dialog).getAllByRole('textbox');
    await fill(phone, '0944555666');
    await fill(name, ' اسم ');
    await fill(within(dialog).getByPlaceholderText('مثال: رفض الاستلام 3 مرات متتالية'), 'سبب كافٍ');
    await submitDialog();
    snap('saved');
  },
  'a refused block keeps the dialog and says why': async (snap) => {
    h.refuse = 'الرقم محظور أصلاً';
    await pressButton(/حظر رقم/);
    const dialog = screen.getByRole('dialog');
    await fill(within(dialog).getByPlaceholderText('0790123456'), PHONE);
    await fill(within(dialog).getByPlaceholderText('مثال: رفض الاستلام 3 مرات متتالية'), 'سبب كافٍ');
    await submitDialog();
    snap('refused');
    expect(screen.getByText('الرقم محظور أصلاً')).toBeTruthy();
  },
  'cancel the block dialog sends nothing': async (snap) => {
    await pressButton(/حظر رقم/);
    await pressButton('إلغاء', screen.getByRole('dialog'));
    snap('cancelled');
  },
  'release a block': async (snap) => {
    await pressButton(/فك الحظر/);
    snap('dialog');
    const dialog = screen.getByRole('dialog');
    await fill(within(dialog).getByRole('textbox'), ' تواصل واعتذر ');
    await submitDialog();
    snap('saved');
  },
  'cancel the release dialog sends nothing': async (snap) => {
    await pressButton(/فك الحظر/);
    await pressButton('إلغاء', screen.getByRole('dialog'));
    snap('cancelled');
  },
  'show the released ones, then search': async (snap) => {
    await act(async () => { fireEvent.click(screen.getByLabelText('أظهر المفكوكين')); });
    await flush();
    snap('shown');
    await fill(screen.getByPlaceholderText('رقم الهاتف، الاسم أو السبب'), ' 0933 ');
    await flush();
    snap('typed');
    await act(async () => { fireEvent.submit(screen.getByPlaceholderText('رقم الهاتف، الاسم أو السبب').closest('form') as HTMLFormElement); });
    await flush();
    snap('submitted');
  },
};

describe('the live screen and the copy on main, through the same presses', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`${name}: the same requests, the same buttons, a phone printed as many times`, async () => {
      const before = await drive(OnMain, script);
      const after = await drive(Live, script);
      expect(Object.keys(after)).toEqual(Object.keys(before));
      expect(after).toEqual(before);
    });
  }

  it('the bodies are the ones the door expects (the differential is not comparing two empty logs)', async () => {
    const out = await drive(Live, SCRIPTS['block a number (trimmed phone, no name → no name key)']);
    expect(out.saved.calls).toContain('POST /api/control/blacklist {"phone":"0944 555 666","reason":"رفض ثلاث مرات"}');
    const rel = await drive(Live, SCRIPTS['release a block']);
    expect(rel.saved.calls).toContain('PATCH /api/control/blacklist {"blockId":"b1","reason":"تواصل واعتذر"}');
    const search = await drive(Live, SCRIPTS['show the released ones, then search']);
    expect(search.typed.calls.at(-1)).toBe(`GET /api/control/blacklist?q=${encodeURIComponent('0933')} `);
  });

  it('for a person with only the view key, too', async () => {
    h.user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['control.blacklist'] };
    const noop: Script = async () => {};
    expect(await drive(Live, noop)).toEqual(await drive(OnMain, noop));
  });
});

describe('each action is drawn for exactly the key it was', () => {
  it('`control.blacklist` alone: no «حظر رقم», no «فك الحظر» — the row says «محظور»', async () => {
    h.user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['control.blacklist'] };
    render(<Live />);
    await flush();
    expect(screen.queryByRole('button', { name: /حظر رقم/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /فك الحظر/ })).toBeNull();
    expect(screen.getAllByText('محظور').length).toBeGreaterThan(0);
  });

  it('… and with an empty book its empty list offers nothing to press either', async () => {
    h.user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['control.blacklist'] };
    h.blocks = [];
    render(<Live />);
    await flush();
    expect(screen.getByText('لا أرقامَ محظورة')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /حظر رقم/ })).toBeNull();
  });

  it('`control.blacklist_manage`: «حظر رقم» in the header and «فك الحظر» on an active row only', async () => {
    render(<Live />);
    await flush();
    expect(screen.getAllByRole('button', { name: /حظر رقم/ })).toHaveLength(1);
    // The released row is hidden until asked for; shown, it says «مفكوك» and carries no button.
    const releases = screen.getAllByRole('button', { name: /فك الحظر/ }).length;
    await act(async () => { fireEvent.click(screen.getByLabelText('أظهر المفكوكين')); });
    expect(screen.getAllByRole('button', { name: /فك الحظر/ })).toHaveLength(releases);
    expect(screen.getAllByText('مفكوك').length).toBeGreaterThan(0);
  });

  it('the owner holds both without the keys', async () => {
    h.user.current = { id: 'u2', role: 'SUPER_ADMIN', permissions: [] };
    render(<Live />);
    await flush();
    expect(screen.getAllByRole('button', { name: /حظر رقم/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /فك الحظر/ }).length).toBeGreaterThan(0);
  });
});

describe('the kit parts behave as the hand-written ones did', () => {
  it('the tick has its own id, its words toggle it, and it never submits the search', async () => {
    render(<Live />);
    await flush();
    const box = screen.getByLabelText('أظهر المفكوكين') as HTMLInputElement;
    expect(box.id).toBe('blacklist-show-released');
    expect(document.querySelectorAll(`#${box.id}`)).toHaveLength(1);
    const calls = h.calls.length;
    await act(async () => { fireEvent.click(screen.getByText('أظهر المفكوكين')); });
    expect(box.checked).toBe(true);
    expect(screen.getAllByText(OTHER).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByText('أظهر المفكوكين')); });
    expect(box.checked).toBe(false);
    expect(h.calls.length, 'الضغطة على المربع بعتت طلب').toBe(calls);
  });

  it('inside each dialog «إلغاء» is a plain button and the confirm is the form’s submit', async () => {
    render(<Live />);
    await flush();
    await pressButton(/حظر رقم/);
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'إلغاء' }).getAttribute('type')).toBe('button');
    expect(within(dialog).getByRole('button', { name: 'حظر' }).getAttribute('type')).toBe('submit');
    await pressButton('إلغاء', dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    await pressButton(/فك الحظر/);
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'إلغاء' }).getAttribute('type')).toBe('button');
    expect(within(dialog).getByRole('button', { name: 'فك الحظر' }).getAttribute('type')).toBe('submit');
    // The release still shows what it undoes before it is pressed.
    expect(within(dialog).getByText('رفض الاستلام مرتين')).toBeTruthy();
    expect(h.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('the header button and the row button do not submit anything by themselves', async () => {
    render(<Live />);
    await flush();
    for (const b of [...screen.getAllByRole('button', { name: /حظر رقم/ }), ...screen.getAllByRole('button', { name: /فك الحظر/ })]) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });
});

describe('the frame and a phone of 375px', () => {
  const small = ['text', 'xs'].join('-');

  it('one frame, titled from the registry; the screen writes no small 12px words of its own (the list kit’s heading row is the kit’s)', async () => {
    render(<Live />);
    await flush();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const src = readFileSync(join(process.cwd(), 'src/components/screens/BlacklistScreen.tsx'), 'utf8');
    expect(src.includes(small), 'text-xs').toBe(false);
  });

  it('nothing is wider than the phone: no fixed width over 375px, and the list sits in a box that clips its own overflow', async () => {
    render(<Live />);
    await flush();
    const widths = [...document.querySelectorAll('[class]')]
      .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
      .map((c) => /^(?:min-)?w-\[(\d+)px\]$/.exec(c))
      .filter(Boolean)
      .map((m) => Number((m as RegExpExecArray)[1]));
    expect(widths.every((w) => w <= 375)).toBe(true);
    const list = screen.getAllByText(PHONE)[0].closest('.overflow-hidden');
    expect(list, 'القائمة مش جوّا صندوق بيقصّ حالو').not.toBeNull();
  });

  it('the screen source: every press, key and sentence still there; the frame is PageShell', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/BlacklistScreen.tsx'), 'utf8');
    expect(src).toContain("userCan(currentUser, 'control.blacklist_manage')");
    expect(src).toContain("<PageShell title={routeLabel('/control/blacklist')}");
    expect(src).toContain('id="blacklist-show-released"');
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).not.toMatch(/type="checkbox"/);
  });
});
