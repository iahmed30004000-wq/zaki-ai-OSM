// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * R8b (18/11) — THE HEAD OF «طلباتي» AND THE PULL PANEL, ON THE KIT, AND NOTHING THE AGENT DOES CHANGED.
 *
 *   1. The new files under `src/components/screens/confirmation/` are PRESENTATION: no server call, no session, no permission —
 *      and none of them reaches the four big windows statically (the order window, «إنشاء طلب», the assistant, «مؤجّلة» stay lazy
 *      in the screen, `staff-confirmation-first-load.test.ts`).
 *   2. The conditions stayed in the screen, word for word: the return press for the holder of `orders.unlock` on a colleague's desk,
 *      the banner on her own desk only.
 *   3. `DeskHead` draws what it is handed and every press reaches its callback: the picker (`desk-watch`), «تحديث», the return press.
 *   4. At a phone's width (jsdom — nothing behind the sign-in can be opened in a browser here): every button of the head, the pull
 *      panel and «الزبون على الخط» carries the kit's phone height, and no fixed width is wider than the screen.
 *   5. «الزبون على الخط»: the kit's buttons inside its form name their type, so «سكّري» closes and never searches.
 */

const { api, toast, phone } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => undefined }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { DeskHead } from './DeskHead';
import { PullPanel } from '@/components/confirmation/PullPanel';
import { CustomerOnTheLine } from '@/components/confirmation/CustomerOnTheLine';

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
});
afterEach(cleanup);

const FOLDER = 'src/components/screens/confirmation';
const sources = async () => {
  const { repoFile, stripComments } = await import('@/lib/guard-source');
  return readdirSync(join(process.cwd(), FOLDER))
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))
    .map((n) => ({ name: n, code: stripComments(repoFile(`${FOLDER}/${n}`)) }));
};

const FOUR = ['OrderDetailModal', 'CreateOrderModal', 'AssistantDialog', 'ConfirmationPostponedScreen'];
/** A static (value) import of the module — `import type` is erased and costs nothing. */
const staticImportOf = (mod: string) => new RegExp(`import (?!type)[^;]*from '[^']*/${mod}'`);

describe('the four big windows stay lazy — no file of the desk reaches them statically', () => {
  it('no source file under the folder imports any of the four as a value', async () => {
    const files = await sources();
    expect(files.map((f) => f.name)).toContain('DeskHead.tsx');
    for (const f of files) for (const mod of FOUR) expect(f.code, `${f.name} ← ${mod}`).not.toMatch(staticImportOf(mod));
  });

  it('NEGATIVE: the check catches a static import, and lets a lazy one through', () => {
    expect("import { OrderDetailModal } from '@/components/orders/OrderDetailModal';").toMatch(staticImportOf('OrderDetailModal'));
    expect("import { AssistantDialog } from './AssistantDialog';").toMatch(staticImportOf('AssistantDialog'));
    expect("const A = dynamic(() => import('./AssistantDialog').then((m) => m.AssistantDialog));").not.toMatch(staticImportOf('AssistantDialog'));
    expect("import type { X } from '@/components/orders/CreateOrderModal';").not.toMatch(staticImportOf('CreateOrderModal'));
  });
});

describe('DeskHead is presentation: no server, no session, no permission', () => {
  const FORBIDDEN = [/\bapiJson\b/, /\bapiFetch\b/, /\bfetch\(/, /\buseApp\b/, /\buserCan\b/, /\buseMayOpen\b/, /from '@\/lib\/work-first'/];

  it('DeskHead.tsx names none of them', async () => {
    const head = (await sources()).find((f) => f.name === 'DeskHead.tsx')!;
    for (const re of FORBIDDEN) expect(head.code, String(re)).not.toMatch(re);
  });

  it('and the screen still asks them, word for word, where it hands DeskHead its props', async () => {
    const { repoFile, stripComments } = await import('@/lib/guard-source');
    const src = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    const at = src.indexOf('<DeskHead');
    expect(at).toBeGreaterThan(-1);
    const props = src.slice(at, src.indexOf('/>', at));
    expect(props).toContain("returnPile={data.viewing && data.returnPile && userCan(currentUser, 'orders.unlock') ? data.returnPile : null}");
    expect(props).toContain('due={!readOnly && data.due && (data.due.count > 0 || (queue.data?.canPull && queue.data.waiting > 0)) ? data.due : null}');
    expect(props).toContain('onRefresh={() => void refresh()}');
    expect(props).toContain('onReturnPile={() => void returnHerPile()}');
  });
});

const DESKS = [
  { id: 'a1', name: 'هدى', holding: 4 },
  { id: 'a2', name: 'سلمى', holding: 0 },
];
const PILE = { eligible: 7, thisPress: 5, remainingAfter: 2 };

function head(over: Partial<React.ComponentProps<typeof DeskHead>> = {}) {
  const props: React.ComponentProps<typeof DeskHead> = {
    desks: DESKS,
    watchedId: '',
    onWatch: vi.fn(),
    refreshing: false,
    onRefresh: vi.fn(),
    readOnly: false,
    watchedName: '',
    due: null,
    returnPile: null,
    returning: false,
    onReturnPile: vi.fn(),
    ...over,
  };
  render(<DeskHead {...props} />);
  return props;
}

describe('DeskHead draws what it is handed, and every press reaches its callback', () => {
  it('the picker is a real select with its label, id `desk-watch`, «شاشتي أنا» first, and a choice reaches onWatch', () => {
    const p = head();
    const select = screen.getByLabelText('شاشة موظفة') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBe('desk-watch');
    expect([...select.options].map((o) => o.textContent)).toEqual(['شاشتي أنا', 'هدى (4)', 'سلمى (0)']);
    fireEvent.change(select, { target: { value: 'a2' } });
    expect(p.onWatch).toHaveBeenCalledWith('a2');
  });

  it('«تحديث» reaches onRefresh once, and is shut while it reads', () => {
    const p = head();
    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    head({ refreshing: true });
    expect((screen.getByRole('button', { name: /تحديث/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('NEGATIVE: nobody to watch — no picker and no «تحديث»', () => {
    head({ desks: [] });
    expect(screen.queryByLabelText('شاشة موظفة')).toBeNull();
    expect(screen.queryByRole('button', { name: /تحديث/ })).toBeNull();
    cleanup();
    head({ desks: null });
    expect(screen.queryByLabelText('شاشة موظفة')).toBeNull();
  });

  it('a colleague’s desk says whose it is; her own says nothing', () => {
    head({ readOnly: true, watchedName: 'هدى' });
    expect(screen.getByRole('status').textContent).toBe('عم تشوف شاشة هدى — قراءة بس');
    cleanup();
    head();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the banner: the server’s sentence, the warning tone when calls are owed and the all-clear when none', () => {
    head({ due: { count: 2, sentence: 'عليكي ٢ مكالمات' } });
    expect(screen.getByText('عليكي ٢ مكالمات').className).toContain('--sys-warning');
    cleanup();
    head({ due: { count: 0, sentence: 'خلّصتي. اسحبي التالي' } });
    expect(screen.getByText('خلّصتي. اسحبي التالي').className).toContain('--sys-success');
    cleanup();
    head({ due: null });
    expect(screen.queryByText(/خلّصتي|عليكي/)).toBeNull();
  });

  it('the return press: the server’s count beside it, and a press reaches onReturnPile once', () => {
    const p = head({ returnPile: PILE });
    expect(screen.getByText('7 طلب «لا يرد» يرجعوا — 5 بكل ضغطة')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /أرجِع «لا يرد» للطابور/ }));
    expect(p.onReturnPile).toHaveBeenCalledTimes(1);
    cleanup();
    head({ returnPile: { eligible: 3, thisPress: 3, remainingAfter: 0 } });
    expect(screen.getByText('3 طلب «لا يرد» يرجعوا')).toBeTruthy();
  });

  it('NEGATIVE: nothing to return shuts the press and says why; returning shuts it too; no pile, no press', () => {
    const p = head({ returnPile: { eligible: 0, thisPress: 0, remainingAfter: 0 } });
    const b = screen.getByRole('button', { name: /أرجِع/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    fireEvent.click(b);
    expect(p.onReturnPile).not.toHaveBeenCalled();
    expect(screen.getByText(/ما في «لا يرد» يرجع هلأ/)).toBeTruthy();
    cleanup();
    head({ returnPile: PILE, returning: true });
    expect((screen.getByRole('button', { name: /أرجِع/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    head({ returnPile: null });
    expect(screen.queryByRole('button', { name: /أرجِع/ })).toBeNull();
  });
});

/** The width classes that state a fixed size in the spacing scale (each step is 4px). */
const FIXED_WIDTH = new RegExp('^(?:min-)?w-(\\d+)$');
const PHONE_PX = 375;
const tooWide = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[class]')].flatMap((el) =>
    [...el.classList].filter((c) => {
      const m = FIXED_WIDTH.exec(c);
      return (m && Number(m[1]) * 4 > PHONE_PX) || /^w-\[/.test(c) || /^min-w-\[/.test(c);
    }),
  );
/** The kit's phone height: 44px below the desk breakpoint, as a height or a minimum. */
const phoneTall = (b: HTMLElement) => b.classList.contains('h-11') || b.classList.contains('min-h-11');

const QUEUE = {
  data: {
    waiting: 9,
    waitingNew: 6,
    waitingReturned: 3,
    owned: { total: 3, withoutAttempt: 2 },
    caps: { withoutAttempt: 3, total: 10 },
    leadDays: 2,
    canPull: true,
    refusal: null,
    autoReleased: 0,
    orders: null,
    waitingRule: 'القاعدة',
  },
  error: null,
  pulling: false,
  reload: vi.fn(async () => undefined),
  pull: vi.fn(async () => true),
  lastRefusal: { current: null },
};

describe('at a phone’s width (jsdom): every press is the kit’s phone height, and nothing is wider than the screen', () => {
  it('the head, the pull panel and «الزبون على الخط» side by side', () => {
    phone.value = true;
    const onRefresh = vi.fn();
    const onReturnPile = vi.fn();
    const onPulled = vi.fn();
    const { container } = render(
      <div>
        <DeskHead
          desks={DESKS}
          watchedId=""
          onWatch={vi.fn()}
          refreshing={false}
          onRefresh={onRefresh}
          readOnly={false}
          watchedName=""
          due={{ count: 1, sentence: 'عليكي مكالمة' }}
          returnPile={PILE}
          returning={false}
          onReturnPile={onReturnPile}
        />
        <PullPanel queue={QUEUE as never} compact onPulled={onPulled} />
        <CustomerOnTheLine onTaken={vi.fn()} />
      </div>,
    );
    const buttons = within(container).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) expect(phoneTall(b), b.textContent ?? '').toBe(true);
    expect(tooWide(container)).toEqual([]);
    // the presses reach their handlers
    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
    fireEvent.click(screen.getByRole('button', { name: /أرجِع/ }));
    fireEvent.click(screen.getByRole('button', { name: 'اسحب الطلب التالي' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReturnPile).toHaveBeenCalledTimes(1);
    expect(QUEUE.pull).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: the width check catches a box wider than the phone, and the height check a short button', () => {
    const { container } = render(
      <div>
        <div className={['w', '96'].join('-')} />
        <button className={['h', '8'].join('-')}>قصير</button>
      </div>,
    );
    expect(tooWide(container)).toEqual([['w', '96'].join('-')]);
    expect(phoneTall(screen.getByRole('button', { name: 'قصير' }))).toBe(false);
  });
});

describe('«الزبون على الخط»: the kit buttons in its form name their type', () => {
  it('«سكّري» closes the box and never searches; «دوّري» submits', async () => {
    render(<CustomerOnTheLine onTaken={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'الزبون على الخط' }));
    fireEvent.change(screen.getByLabelText('رقم الزبون اللي عم يحكي'), { target: { value: '0999' } });
    const close = screen.getByRole('button', { name: 'سكّري' });
    const search = screen.getByRole('button', { name: 'دوّري' });
    expect(close.getAttribute('type')).toBe('button');
    expect(search.getAttribute('type')).toBe('submit');
    fireEvent.click(close);
    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('رقم الزبون اللي عم يحكي')).toBeNull();
    expect(screen.getByRole('button', { name: 'الزبون على الخط' })).toBeTruthy();
  });

  it('NEGATIVE: every button inside the form states a type (an unnamed kit button would submit it)', () => {
    render(<CustomerOnTheLine onTaken={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'الزبون على الخط' }));
    const form = screen.getByLabelText('رقم الزبون اللي عم يحكي').closest('form')!;
    const buttons = [...form.querySelectorAll('button')];
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(['button', 'submit'], b.textContent ?? '').toContain(b.getAttribute('type'));
  });
});
