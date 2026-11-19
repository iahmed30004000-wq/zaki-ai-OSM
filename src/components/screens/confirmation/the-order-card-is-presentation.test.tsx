// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoFile, stripComments } from '@/lib/guard-source';
import { CONTACT_FIRST_MESSAGE, REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';
import { shapeCss } from '@/lib/theme-shape';
import { themeByKey } from '@/lib/system-themes';

/**
 * R8d (18/11) — THE ORDER CARD OF «طلباتي», ON THE KIT, AND NOTHING THE AGENT DOES CHANGED.
 *
 *   1. `OrderCard.tsx` is PRESENTATION: no server call, no session, no permission — and the screen hands it its presses word for
 *      word (every handler body stayed in the screen). The four big windows stay lazy: held for every file of this folder by
 *      `the-desk-head-is-presentation.test.tsx`, which now also reads this one.
 *   2. Every press of the card reaches the ONE callback it reached before, with the same order (and, for a dialog, the same kind):
 *      table-driven, in «اتصلي هلّق» and in «بانتظار», on a desk and on a phone.
 *   3. The closed-today card has NO footer, and a colleague's desk has no press at all.
 *   4. The locks are the old ones: «اتصل أول» shuts «افتح وعدّل», «تأكيد الطلب» and «تأجيل»; a missing governorate shuts «تأكيد الطلب»;
 *      «busy» shuts every press that took it before, and only those.
 *   5. At a phone's width (jsdom — nothing behind the sign-in can be opened in a browser here): every press carries the kit's phone
 *      height, the decisions fill their cell, and no fixed width is wider than the screen.
 *   6. The card is a page-level kit `Card`; the theme's decor (clean · ops · islamic-epic) is drawn on the card's own background and
 *      never on a press.
 *   7. Every press is `type="button"` — none of them is ever a form's submit.
 */

vi.mock('@/components/orders/ContactButtons', () => ({
  ContactButtons: ({ onContacted, countryCode }: { onContacted?: (m: 'PHONE') => void; countryCode?: string | null }) => (
    <button type="button" data-contact={countryCode ?? ''} onClick={() => onContacted?.('PHONE')}>
      اتصل
    </button>
  ),
}));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/CopyValue', () => ({ CopyValue: () => null }));

import { OrderCard, type CardOrder, type CardPresses } from './OrderCard';

afterEach(cleanup);

const tokens = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const ORDER: CardOrder = {
  id: 'o-1',
  orderNumber: 'ORD-26-0001',
  state: 'PENDING_CONFIRMATION',
  previousOrders: 0,
  totalAmount: 25,
  currency: 'JOD',
  claimedAt: '2026-11-18T08:00:00.000Z',
  firstActionAt: '2026-11-18T08:05:00.000Z',
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'MANUAL',
  regionId: 'r-1',
  region: { name: 'المحافظة الأولى' },
  moderatorId: 'm-1',
  moderator: { id: 'm-1', name: 'مدخلة' },
  createdBy: null,
  channel: null,
  customer: { id: 'c-1', fullName: 'زبون تجريبي', rawPhone: '0790000000', city: 'مدينة', address: 'شارع' },
  items: [{ id: 'i-1', productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  _count: { contactAttempts: 1 },
};

const DATA = { noAnswerLimit: 3, serverNow: '2026-11-18T09:00:00.000Z', dialCode: '962' };

const fn = () => vi.fn<(...a: unknown[]) => void>();
function presses() {
  return {
    onOpenOrder: fn(),
    onNoAnswer: fn(),
    onUnreachable: fn(),
    onConfirm: fn(),
    onDialog: fn(),
    onContacted: fn(),
  };
}

function card(over: Partial<React.ComponentProps<typeof OrderCard<CardOrder>>> = {}) {
  const on = presses();
  const props: React.ComponentProps<typeof OrderCard<CardOrder>> = {
    order: ORDER,
    domId: 'desk-order-o-1',
    flash: false,
    data: DATA,
    readOnly: false,
    watchedName: '',
    phone: false,
    busy: false,
    canLogContact: true,
    canRaiseIssue: true,
    canAskAssistant: true,
    proofOn: false,
    lock: { text: null },
    contactFirstText: CONTACT_FIRST_MESSAGE,
    holderId: 'u-1',
    presses: on,
    ...over,
  };
  const view = render(<OrderCard {...props} />);
  return { on, props, view };
}

/** The nine presses of the card: the label that finds it, the callback it reaches, and the arguments after the order. */
const PRESSES: [string, RegExp, keyof CardPresses<CardOrder>, unknown[]][] = [
  ['اتصل', /^اتصل$/, 'onContacted', ['PHONE']],
  ['لا يرد', /^لا يرد/, 'onNoAnswer', []],
  ['مغلق أو خارج التغطية', /^مغلق أو خارج التغطية$/, 'onUnreachable', []],
  ['تأكيد الطلب', /^تأكيد الطلب$/, 'onConfirm', []],
  ['تأجيل', /^تأجيل/, 'onDialog', ['postpone']],
  ['ألغِ', /^ألغِ$/, 'onDialog', ['reject']],
  ['إدخال إشكال', /^إدخال إشكال$/, 'onDialog', ['issue']],
  ['مساعدة', /^مساعدة$/, 'onDialog', ['assist']],
  ['افتح وعدّل', /^افتح وعدّل$/, 'onOpenOrder', []],
];
const press = (name: RegExp) => screen.getByRole('button', { name });

const PLACES: [string, Partial<CardOrder>][] = [
  ['«اتصلي هلّق»', {}],
  ['«بانتظار»', { noAnswerCount: 1, _count: { contactAttempts: 2 } }],
];

describe('every press reaches the one callback it reached before, with the same order', () => {
  for (const [place, change] of PLACES) {
    for (const phone of [false, true]) {
      it.each(PRESSES)(`${place} · ${phone ? 'phone' : 'desk'} · «%s»`, (_label, name, callback, args) => {
        const order = { ...ORDER, ...change };
        const { on } = card({ order, phone });
        fireEvent.click(press(name));
        // The order handed back is the very object the screen handed in — the screen's own row, never a copy.
        const call = on[callback].mock.calls;
        expect(call).toHaveLength(1);
        if (callback === 'onDialog') expect(call[0]).toEqual([...args, order]);
        else expect(call[0]).toEqual([order, ...args]);
        expect(call[0].includes(order)).toBe(true);
        for (const other of Object.keys(on) as (keyof typeof on)[]) if (other !== callback) expect(on[other], other).not.toHaveBeenCalled();
      });
    }
  }

  it('NEGATIVE: no contact callback → the strip is handed none (the screen had nothing to do on the press)', () => {
    const on = presses();
    card({ presses: { ...on, onContacted: undefined } });
    fireEvent.click(press(/^اتصل$/));
    for (const fn of Object.values(on)) expect(fn).not.toHaveBeenCalled();
  });

  it('the strip is given the desk’s country code', () => {
    card();
    expect(press(/^اتصل$/).getAttribute('data-contact')).toBe('962');
  });
});

describe('a closed card and a colleague’s desk carry no press', () => {
  it('closed today: no footer, none of the nine, and the sentence that says why', () => {
    const { view } = card({ order: { ...ORDER, noAnswerCount: 3 }, closed: true });
    expect(view.container.querySelector('footer')).toBeNull();
    for (const [, name] of PRESSES) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(view.container.textContent).toContain('للقراءة فقط — أُغلق');
  });

  it('a colleague’s desk: none of the nine, and whose it is', () => {
    const { view } = card({ readOnly: true, watchedName: 'زميلة' });
    expect(view.container.querySelector('footer')).toBeNull();
    for (const [, name] of PRESSES) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(view.container.textContent).toContain('للقراءة فقط — هذا الطلب بيد زميلة.');
  });
});

describe('the locks are the old ones', () => {
  const shut = () =>
    screen
      .getAllByRole('button')
      .filter((b) => (b as HTMLButtonElement).disabled)
      .map((b) => b.textContent!.replace(/\s+/g, ' ').trim())
      .sort();

  it('no attempt yet: «افتح وعدّل», «تأكيد الطلب» and «تأجيل» are shut, each saying why — «ألغِ», «إدخال إشكال», «مساعدة» stay open', () => {
    card({ order: { ...ORDER, _count: { contactAttempts: 0 } } });
    expect(shut()).toEqual(['افتح وعدّل', 'تأجيل', 'تأكيد الطلب'].sort());
    for (const name of [/^افتح وعدّل$/, /^تأكيد الطلب$/, /^تأجيل/]) {
      expect(press(name).getAttribute('title')).toBe(CONTACT_FIRST_MESSAGE);
      expect(press(name).getAttribute('aria-disabled')).toBe('true');
    }
    expect(screen.getByText(/اتصل بالزبون أول — بعدها بتفتح الأزرار/)).toBeTruthy();
  });

  it('no governorate: only «تأكيد الطلب» is shut, with the governorate’s sentence, and the screen’s select is drawn where it was', () => {
    card({ order: { ...ORDER, regionId: null }, regionGate: <p data-gate>خانة المحافظة</p> });
    expect(shut()).toEqual(['تأكيد الطلب']);
    expect(press(/^تأكيد الطلب$/).getAttribute('title')).toBe(REGION_REQUIRED_MESSAGE);
    expect(screen.getByText('اختر المحافظة لتفتح التأكيد')).toBeTruthy();
    expect(document.querySelector('[data-gate]')).toBeTruthy();
  });

  it('busy: every press that took `busy` before is shut — «افتح وعدّل», «مساعدة» and the strip are not', () => {
    card({ busy: true });
    expect(shut()).toEqual(['لا يرد 0/3', 'مغلق أو خارج التغطية', 'تأكيد الطلب', 'تأجيل', 'ألغِ', 'إدخال إشكال'].sort());
  });

  it('«إثبات المكالمات»: the proof’s lock shuts the two call results with its own words, and says them', () => {
    card({ lock: { text: 'استني 20 ثانية' } });
    expect(shut()).toEqual(['لا يرد 0/3', 'مغلق أو خارج التغطية'].sort());
    expect(press(/^لا يرد/).getAttribute('title')).toBe('استني 20 ثانية');
    expect(screen.getByText('استني 20 ثانية')).toBeTruthy();
  });

  it('NEGATIVE: without the key to log a contact, the two call results and the strip are not drawn at all', () => {
    card({ canLogContact: false });
    for (const name of [/^اتصل$/, /^لا يرد/, /^مغلق أو خارج التغطية$/]) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('the tone: the confirmation is the kit’s primary, «ألغِ» its danger, a «لا يرد» that closes now its danger, the rest secondary', () => {
    const danger = ['bg', '[var(--sys-destructive)]'].join('-');
    const primary = ['bg', '[var(--sys-primary)]'].join('-');
    card({ order: { ...ORDER, noAnswerCount: 2, _count: { contactAttempts: 2 } } });
    expect(tokens(press(/^تأكيد الطلب$/))).toContain(primary);
    expect(tokens(press(/^ألغِ$/))).toContain(danger);
    expect(tokens(press(/^لا يرد/))).toContain(danger);
    expect(tokens(press(/^تأجيل/))).not.toContain(danger);
    expect(tokens(press(/^تأجيل/))).not.toContain(primary);
  });
});

describe('at a phone’s width (jsdom)', () => {
  it('every press is the kit’s phone height, the decisions fill their cell, and nothing is wider than 375 px', () => {
    const { view } = card({ phone: true });
    for (const [label, name] of PRESSES.filter(([l]) => l !== 'اتصل')) expect(tokens(press(name)), label).toContain('h-11');
    for (const name of [/^تأكيد الطلب$/, /^تأجيل/, /^ألغِ$/, /^لا يرد/, /^مغلق أو خارج التغطية$/]) expect(tokens(press(name))).toContain('w-full');
    expect(tokens(press(/^تأجيل/).parentElement)).toContain('grid-cols-2');
    const fixed = /^(?:min-)?w-(?:\[(\d+)px\]|(\d+))$/;
    for (const el of view.container.querySelectorAll('*')) {
      for (const t of tokens(el)) {
        const m = fixed.exec(t);
        if (m) expect(Number(m[1] ?? Number(m[2]) * 4), t).toBeLessThanOrEqual(375);
      }
    }
  });

  it('a desk lays the presses in one wrapping row and fills none of them', () => {
    card();
    const footer = press(/^تأكيد الطلب$/).closest('footer')!;
    expect(tokens(footer)).toContain('flex-wrap');
    for (const b of within(footer).getAllByRole('button')) expect(tokens(b)).not.toContain('w-full');
  });
});

describe('the surface is the kit’s page-level Card, and the theme’s decor stays off the presses', () => {
  for (const key of ['clean', 'ops', 'islamic-epic']) {
    it(key, () => {
      render(
        <div data-sys-theme={key}>
          <OrderCard
            order={ORDER}
            domId="desk-order-o-1"
            flash
            data={DATA}
            readOnly={false}
            watchedName=""
            phone={false}
            busy={false}
            canLogContact
            canRaiseIssue
            canAskAssistant
            proofOn={false}
            lock={{ text: null }}
            contactFirstText={CONTACT_FIRST_MESSAGE}
            holderId={null}
            presses={presses()}
          />
        </div>
      );
      const article = document.getElementById('desk-order-o-1')!;
      expect(article.tagName).toBe('ARTICLE');
      expect(tokens(article)).toContain('ring-2');
      const surface = article.firstElementChild!;
      expect(tokens(surface)).toContain('zk-card');
      for (const b of screen.getAllByRole('button')) expect(b.closest('.zk-card')).toBe(surface);
      for (const b of screen.getAllByRole('button')) expect(tokens(b)).not.toContain('zk-card');
      // The theme's rule paints the card's own background, and a drawn crown never takes a press.
      const css = shapeCss(themeByKey(key));
      for (const rule of css.split('}').filter(Boolean)) {
        const selector = rule.slice(0, rule.indexOf('{'));
        expect(selector, key).toMatch(/\.zk-card(::before)?$/);
        if (selector.endsWith('::before')) expect(rule).toContain('pointer-events:none');
      }
    });
  }
});

describe('every press is a button that never submits', () => {
  it('type="button" on each of the nine', () => {
    card();
    for (const [label, name] of PRESSES) expect(press(name).getAttribute('type'), label).toBe('button');
  });
});

describe('OrderCard is presentation: no server, no session, no permission — the screen hands it its presses', () => {
  const FORBIDDEN = [/\bapiJson\b/, /\bapiFetch\b/, /\bfetch\(/, /\buseApp\b/, /\buserCan\b/, /\buseMayOpen\b/, /\buseRegions\b/];
  const code = () => stripComments(repoFile('src/components/screens/confirmation/OrderCard.tsx'));

  it('OrderCard.tsx names none of them — and the folder guard of the four lazy windows reads it', () => {
    for (const re of FORBIDDEN) expect(code(), String(re)).not.toMatch(re);
    expect(readdirSync(join(process.cwd(), 'src/components/screens/confirmation'))).toContain('OrderCard.tsx');
  });

  it('NEGATIVE: the check catches each of them', () => {
    const bad = ['apiJson(', 'apiFetch(', 'fetch(', 'useApp()', "userCan(u, 'x')", 'useMayOpen()', 'useRegions()'];
    bad.forEach((line, i) => expect(line).toMatch(FORBIDDEN[i]));
  });

  it('and the screen still decides and does, word for word, where it hands the card its props', () => {
    const src = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    const at = src.indexOf('<OrderCard');
    expect(at).toBeGreaterThan(-1);
    const props = src.slice(at, src.indexOf('/>\n          ))}', at));
    for (const line of [
      'busy={busyId === order.id}',
      'lock={proofLock(order)}',
      'flash={flashId === order.id}',
      'domId={deskCardId(order.id)}',
      'canLogContact={canLogContact}',
      'canRaiseIssue={canRaiseIssue}',
      'canAskAssistant={canAskAssistant}',
      'onOpenOrder: (o) => setOpenOrderId(o.id),',
      "onNoAnswer: (o) => logAttempt(o, 'PHONE', 'NO_ANSWER'),",
      "onUnreachable: (o) => logAttempt(o, 'PHONE', 'UNREACHABLE'),",
      'onConfirm: (o) => confirm(o),',
      'onDialog: (kind, o) => setDialog({ kind, order: o }),',
      'sheetOn || proofOn',
      "if (method !== 'PHONE') return;",
      'if (proofOn) holdFor(o.id, MIN_CALL_MS.NO_ANSWER + CLIENT_MARGIN_MS);',
      'if (sheetOn) startCall(o);',
      'lacksRegion(order) &&',
      'locked={needsContact(order)}',
      'onSave={(regionId) => void saveRegion(order, regionId)}',
    ])
      expect(props, line).toContain(line);
    // the permissions are asked in the screen, of the session — the same three keys as before
    expect(src).toContain("const canLogContact = userCan(currentUser, 'orders.contact_log');");
    expect(src).toContain("const canRaiseIssue = userCan(currentUser, 'confirmation.raise_issue');");
    expect(src).toContain('const canAskAssistant = userCan(currentUser, AI_ASSIST_KEY);');
  });
});
