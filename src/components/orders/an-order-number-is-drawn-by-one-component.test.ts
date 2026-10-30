import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardFiles, stripComments, stripTemplates } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN ORDER NUMBER IS DRAWN BY ONE COMPONENT — AND THE DEBT ONLY GOES DOWN.
 *
 * `OrderRef` draws the number with the buttons that copy it, the phone and
 * the courier's barcode. Fifteen files still draw it another way, so this is
 * a ratchet, not a wall (the pattern of `bare-fetch-ratchet`): every
 * remaining place is written down BY NAME, a new one fails, an old one
 * moved to `OrderRef` fails until its number is lowered, and a ceiling pins
 * the total so «just raise the number» is two edits, not one.
 *
 *   R1 · no `<OrderLink` outside `OrderRef` — the number that opens the
 *        order is drawn through the component that also copies it;
 *   R2 · no order number printed as a bare child of an element — the same;
 *   R3 · the places that CANNOT take a button (a row that is itself a
 *        control, a sentence, a sample), each with the reason, and the
 *        reason must be a sentence;
 *   R4 · copying writes nothing: the copy files hold no request, no audit
 *        line, no «contact attempt» (the confirmation desk unlocks on that
 *        count — a copy is not a call);
 *   R5 · a sweep over nothing proves nothing;
 *   R6 · no raw `navigator.clipboard.writeText` on a screen: it throws on a
 *        plain-HTTP office server and the person is told nothing — go
 *        through `copyText`.
 *
 * NOT SEEN BY THIS COUNT, on purpose: a title passed as a string to a
 * window (`Modal` takes `title: string`), and a number named something other
 * than `orderNumber`/`merchantRef` (`f.ref` in the rejection list of the
 * manual statement, `p.number` in the assistant's dialog, a few pickers).
 * They are in the plan for the screen PRs, by name.
 * ═══════════════════════════════════════════════════════════════════════
 */

/* ──────────────────────────── detectors ──────────────────────────── */

const view = (src: string) => stripTemplates(stripComments(src));

/** `<OrderLink` — a use of the link component. */
const linkSites = (src: string): number => (view(src).match(/<OrderLink\b/g) ?? []).length;

/**
 * An order number (or the merchant reference a screen shows in its place)
 * printed as text between two tags: `>{o.orderNumber}<`, `>#{o.orderNumber}<`,
 * `> افتح {x.orderNumber} <`. An attribute (`title={x.orderNumber}`) is
 * preceded by `=` and is not this.
 */
const handSites = (src: string): number =>
  (view(src).match(/>[^<>{}]*\{[^{}]*\b(?:orderNumber|merchantRef)\b[^{}]*\}[^<>{}]*</g) ?? []).length;

/** A write straight to the clipboard API. */
const rawCopies = (src: string): number =>
  (view(src).match(/navigator\.clipboard\??\.writeText/g) ?? []).length;

/* ───────────────────────────── the ledgers ───────────────────────────── */

type Ledger = ReadonlyMap<string, number>;

/**
 * R1 — `<OrderLink` still drawn by the screen itself (17 places, 15 files).
 * Each moves to `OrderRef` in its own screen PR and its number falls with it.
 */
const LINK_DEBT: Ledger = new Map<string, number>([
  ['src/components/orders/CustomerHistory.tsx', 1],
  ['src/components/screens/AgentCustodyScreen.tsx', 1],
  ['src/components/screens/ChangeRequestsScreen.tsx', 1],
  ['src/components/screens/ConfirmationIssuesScreen.tsx', 1],
  ['src/components/screens/ConfirmationPostponedScreen.tsx', 1],
  ['src/components/screens/ConfirmationQueueScreen.tsx', 1],
  ['src/components/screens/CustomersScreen.tsx', 1],
  ['src/components/screens/DiscountAlertsScreen.tsx', 1],
  ['src/components/screens/finance/ManualMatching.tsx', 1],
  ['src/components/screens/ReturnsScreen.tsx', 2],
  ['src/components/screens/ShipmentsNewScreen.tsx', 1],
  ['src/components/screens/ShippingBatchesScreen.tsx', 1],
  ['src/components/screens/TelegramOrdersScreen.tsx', 2],
  ['src/components/screens/TrackingScreen.tsx', 1],
  ['src/components/screens/WinbackScreen.tsx', 1],
]);
const LINK_CEILING = 17;

/**
 * R2 — a number the screen prints with its own markup, and that CAN take
 * the component (10 places, 7 files). Same rule: each falls to zero.
 */
const HAND_DEBT: Ledger = new Map<string, number>([
  ['src/components/products/ProductRecentOrders.tsx', 1],
  ['src/components/screens/ConfirmationMineScreen.tsx', 2],
  ['src/components/screens/finance/MatchingScreen.tsx', 2],
  ['src/components/screens/OrdersScreen.tsx', 1],
  ['src/components/screens/PreparationScreen.tsx', 2],
  ['src/components/screens/ShipmentsNewScreen.tsx', 1],
  ['src/components/screens/WhatsAppInboxScreen.tsx', 1],
]);
const HAND_CEILING = 10;

/**
 * R3 — a number that stays plain, and WHY. These do not fall to zero: they
 * fall only when the reason stops being true. A button inside a control is a
 * control inside a control — it breaks the keyboard and the thumb.
 */
const HAND_ALLOWED = new Map<string, { n: number; because: string }>([
  ['src/components/confirmation/PullPanel.tsx', { n: 1, because: 'الرقم داخل جملة على زرّ — لا زرّ داخل زرّ' }],
  ['src/components/ops/DispatchResult.tsx', { n: 1, because: 'الرقم داخل جملة على زرّ — لا زرّ داخل زرّ' }],
  ['src/components/screens/finance/LinkLineDialog.tsx', { n: 1, because: 'صفٌّ يُختار بالنقر — لا زرّ داخل صفّ الاختيار' }],
  ['src/components/screens/finance/ShortfallPeopleDialog.tsx', { n: 1, because: 'الرقم داخل جملة مالية تُقرأ كما هي' }],
  ['src/components/screens/finance/SwapDialog.tsx', { n: 2, because: 'ملصق خانة اختيار — لا زرّ داخل الملصق' }],
  ['src/components/settings/MessageTemplatesCard.tsx', { n: 1, because: 'عيّنة قالب رسالة وليست طلباً حقيقياً' }],
]);
const HAND_ALLOWED_CEILING = 7;

/**
 * R6 — raw `navigator.clipboard.writeText` still on screens. All nine copy a
 * secret or a link (a token, a store address, a rating link, a password a
 * moment after it is made); none is a customer's phone or an order number.
 * New ones go through `copyText`.
 */
const RAW_COPY_DEBT: Ledger = new Map<string, number>([
  ['src/components/apps/SystemTokensPanel.tsx', 1],
  ['src/components/orders/CourierNotifyDialog.tsx', 1],
  ['src/components/orders/RatingLinkButton.tsx', 1],
  ['src/components/screens/CampaignsScreen.tsx', 1],
  ['src/components/screens/confirmation/AssistantDialog.tsx', 1],
  ['src/components/screens/StoreDomainScreen.tsx', 1],
  ['src/components/screens/StoresScreen.tsx', 1],
  ['src/components/screens/UserDetailScreen.tsx', 1],
  ['src/components/ui/Confirm.tsx', 1],
]);
const RAW_COPY_CEILING = 9;

/* ───────────────────────────── the judging ───────────────────────────── */

/** Places that grew past what the ledger allows — a NEW one. */
function fresh(found: Ledger, allowed: Ledger): string[] {
  const out: string[] = [];
  for (const [file, n] of found) if (n > (allowed.get(file) ?? 0)) out.push(`${file}: ${n} > ${allowed.get(file) ?? 0}`);
  return out;
}

/** Debt paid and not written down — the ledger would stop being true. */
function stale(found: Ledger, allowed: Ledger): string[] {
  const out: string[] = [];
  for (const [file, n] of allowed) if ((found.get(file) ?? 0) < n) out.push(`${file}: صار ${found.get(file) ?? 0} — أنزِل الرقم من ${n}`);
  return out;
}

const total = (l: Ledger) => [...l.values()].reduce((a, b) => a + b, 0);

/* ───────────────────────────── the sweep ───────────────────────────── */

const ORDER_REF = '/src/components/orders/OrderRef.tsx';
const withoutSlash = (rel: string) => rel.replace(/^\//, '');

const tsx = dashboardFiles('.tsx');
const both = dashboardFiles('both');

function count(files: { rel: string; src: string }[], by: (s: string) => number, skip: string[] = []): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    if (skip.includes(f.rel)) continue;
    const n = by(f.src);
    if (n > 0) out.set(withoutSlash(f.rel), n);
  }
  return out;
}

const linkFound = count(tsx, linkSites, [ORDER_REF]);
const handFound = count(tsx, handSites, [ORDER_REF]);
const rawFound = count(both, rawCopies, ['/src/lib/clipboard.ts']);

const handAllowedAsLedger: Ledger = new Map<string, number>([...HAND_ALLOWED].map(([f, v]): [string, number] => [f, v.n]));
const handAllowedAll: Ledger = (() => {
  const m = new Map<string, number>(HAND_DEBT);
  for (const [f, n] of handAllowedAsLedger) m.set(f, (m.get(f) ?? 0) + n);
  return m;
})();

describe('R5 · the sweep is not empty', () => {
  it('reads the screens', () => {
    expect(tsx.length).toBeGreaterThan(300);
    expect(both.length).toBeGreaterThan(tsx.length);
  });

  it('finds the places that draw an order number — through OrderRef or not', () => {
    const throughOrderRef = tsx.filter((f) => /<OrderRef\b/.test(view(f.src)) && f.rel !== ORDER_REF).length;
    // 17 + 17 at the start. A screen that moves to OrderRef leaves the first
    // two sums and enters the third, so the whole never falls below it.
    const everywhere = total(linkFound) + total(handFound) + throughOrderRef;
    expect(everywhere).toBeGreaterThanOrEqual(34);
  });
});

describe('R1 · no `<OrderLink` outside OrderRef', () => {
  it('adds no new one', () => {
    expect(fresh(linkFound, LINK_DEBT), 'رقمُ طلبٍ جديدٌ يُرسم بـOrderLink — استعمل OrderRef').toEqual([]);
  });

  it('and the ledger says the truth about what is left', () => {
    expect(stale(linkFound, LINK_DEBT), 'دَينٌ سُدِّد ولم يُسجَّل').toEqual([]);
  });

  it('the total only goes down', () => {
    expect(total(LINK_DEBT)).toBeLessThanOrEqual(LINK_CEILING);
    expect(total(LINK_DEBT)).toBe(total(linkFound));
  });

  it('OrderRef itself still draws the link', () => {
    expect(linkSites(tsx.find((f) => f.rel === ORDER_REF)?.src ?? '')).toBeGreaterThanOrEqual(1);
  });
});

describe('R2/R3 · no order number printed by hand', () => {
  it('adds no new one', () => {
    expect(fresh(handFound, handAllowedAll), 'رقمُ طلبٍ جديدٌ يُطبع بيد الشاشة — استعمل OrderRef').toEqual([]);
  });

  it('and the ledger says the truth about what is left', () => {
    expect(stale(handFound, handAllowedAll), 'دَينٌ سُدِّد ولم يُسجَّل').toEqual([]);
  });

  it('the convertible debt only goes down', () => {
    expect(total(HAND_DEBT)).toBeLessThanOrEqual(HAND_CEILING);
  });

  it('the places that stay plain are the ones with a reason, and not more', () => {
    expect(total(handAllowedAsLedger)).toBeLessThanOrEqual(HAND_ALLOWED_CEILING);
    for (const [file, { because }] of HAND_ALLOWED) {
      expect(because.length, `${file}: السبب جملة`).toBeGreaterThan(12);
      expect(HAND_DEBT.has(file), file + ': إمّا دَين أو سببٌ دائم').toBe(false);
    }
  });

  it('every file named in a ledger exists', () => {
    const named = [...LINK_DEBT.keys(), ...HAND_DEBT.keys(), ...HAND_ALLOWED.keys(), ...RAW_COPY_DEBT.keys()];
    for (const file of named) expect(existsSync(join(process.cwd(), file)), file).toBe(true);
  });
});

describe('R4 · copying writes nothing', () => {
  const COPY_FILES = [
    '/src/components/orders/OrderRef.tsx',
    '/src/components/orders/CopyValue.tsx',
    '/src/lib/copy-values.ts',
  ];
  const sources = COPY_FILES.map((rel) => ({ rel, src: both.find((f) => f.rel === rel)?.src ?? '' }));

  it('the three files exist and are read', () => {
    for (const { rel, src } of sources) expect(src.length, rel).toBeGreaterThan(200);
  });

  it.each([
    ['apiJson', /\bapiJson\b/],
    ['apiFetch', /\bapiFetch\b/],
    ['fetch(', /(^|[^.\w])fetch\s*\(/],
    ['contact-attempts', /contact-attempts/],
    ['noteContact', /\bnoteContact\b/],
    ['logAudit', /\blogAudit\b/],
    ['ContactButtons', /\bContactButtons\b/],
  ])('holds no %s', (_name, re) => {
    for (const { rel, src } of sources) expect(stripComments(src), rel).not.toMatch(re);
  });

  it('goes through copyText, not around it', () => {
    const copy = sources.find((s) => s.rel.endsWith('CopyValue.tsx'))?.src ?? '';
    expect(stripComments(copy)).toMatch(/\bcopyText\b/);
    expect(rawCopies(copy)).toBe(0);
  });
});

describe('R6 · no new raw clipboard write on a screen', () => {
  it('adds no new one', () => {
    expect(fresh(rawFound, RAW_COPY_DEBT), 'نسخٌ خامّ — مرِّره عبر copyText من lib/clipboard').toEqual([]);
  });

  it('and the ledger says the truth about what is left', () => {
    expect(stale(rawFound, RAW_COPY_DEBT)).toEqual([]);
  });

  it('the total only goes down', () => {
    expect(total(RAW_COPY_DEBT)).toBeLessThanOrEqual(RAW_COPY_CEILING);
  });
});

describe('the guard itself catches what it claims to', () => {
  it('sees a link, a hand-printed number and a raw copy — and not their look-alikes', () => {
    expect(linkSites('<OrderLink id={a} number={b} />')).toBe(1);
    expect(linkSites('// <OrderLink id={a} />')).toBe(0);
    expect(linkSites('const s = `<OrderLink id={a} />`;')).toBe(0);
    expect(linkSites('<OrderRef id={a} number={b} />')).toBe(0);

    expect(handSites('<span>{o.orderNumber}</span>')).toBe(1);
    expect(handSites('<b>#{o.orderNumber}</b>')).toBe(1);
    expect(handSites('<b>{x.merchantRef ?? x.orderNumber}</b>')).toBe(1);
    expect(handSites('<Modal title={o.orderNumber} />')).toBe(0);
    expect(handSites('<Row aria-label={`طلب ${o.orderNumber}`} />')).toBe(0);
    expect(handSites('{/* <i>{o.orderNumber}</i> */}')).toBe(0);

    expect(rawCopies('await navigator.clipboard.writeText(x)')).toBe(1);
    expect(rawCopies('void navigator.clipboard?.writeText(x)')).toBe(1);
    expect(rawCopies('const t = await navigator.clipboard.readText()')).toBe(0);
  });

  it('a NEW place outside the ledger fails', () => {
    const found = new Map<string, number>([...LINK_DEBT, ['src/components/screens/BrandNewScreen.tsx', 1]]);
    expect(fresh(found, LINK_DEBT)).toEqual(['src/components/screens/BrandNewScreen.tsx: 1 > 0']);
  });

  it('a known file that grows fails', () => {
    const found = new Map(LINK_DEBT);
    found.set('src/components/screens/ReturnsScreen.tsx', 3);
    expect(fresh(found, LINK_DEBT)).toHaveLength(1);
  });

  it('a file that moved to OrderRef fails until its number is lowered', () => {
    const found = new Map(LINK_DEBT);
    found.delete('src/components/screens/WinbackScreen.tsx');
    expect(stale(found, LINK_DEBT)).toHaveLength(1);
  });

  it('a ledger raised without raising the ceiling fails', () => {
    const raised = new Map(LINK_DEBT);
    raised.set('src/components/screens/BrandNewScreen.tsx', 1);
    expect(total(raised)).toBeGreaterThan(LINK_CEILING);
  });

  it('the starting debt is the measured one', () => {
    expect(total(LINK_DEBT)).toBe(17);
    expect(total(HAND_DEBT) + total(handAllowedAsLedger)).toBe(17);
    expect(total(RAW_COPY_DEBT)).toBe(9);
  });
});
