'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiArrowRightSLine,
  RiCloseLine,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';
import type { NavGroup } from '@/lib/route-registry';
import { iconFor } from './icons';
import { RAIL_EVENT, railed as storedRail, setRailed } from '@/lib/sidebar-rail';
import { signOut } from '@/lib/sign-out';
import { apiJson } from '@/lib/api-client';
import type { PaletteFact } from '@/lib/palette-intel';
import type { CreateRow } from '@/lib/create-intent';

/**
 * ONE BOX FOR EVERYTHING.
 *
 * The global search was a box in the header that only a SUPER_ADMIN could
 * see, that searched orders and nothing else, and that lived beside a menu
 * of fifty screens nobody could search at all. Somebody looking for
 * "الإغلاق اليومي" opened four groups to find it; somebody holding a parcel
 * typed its barcode into a screen that could not match one.
 *
 * So: one box. Type an order number, a phone or a barcode and the record
 * comes back. Type a screen's name and it is there. And the handful of
 * commands that are not screens at all — switching store, signing out,
 * folding the menu — are here too, because they live in the chrome and had
 * no other way in but the mouse.
 *
 * AN ACTION IS NEVER A SCREEN UNDER A VERB.
 *
 * The first version of this list read «شحنة جديدة», «إغلاق اليوم»,
 * «استلام مرتجع» — and every one of the six was already a route in the
 * menu, with a noun for a name. That is not a third group; it is the second
 * group again, in a second vocabulary, maintained by hand and free to drift
 * from the permissions the real routes carry. So an action here must be
 * something the registry does NOT name, and `palette-actions.test.ts`
 * refuses any that is.
 *
 * ROLE-AWARE BY CONSTRUCTION, NOT BY FILTERING.
 *
 * The screens come from `visibleNav`, which the SERVER already narrowed to
 * what this account may open. The records come from `/api/orders`, which
 * demands `orders.view` and filters by role again — a palette cannot show
 * an order the person could not have found anyway. The actions are gated on
 * the same permission keys their screens are.
 *
 * That matters more than it sounds: a palette built by listing everything
 * and hiding what the user lacks is a palette that leaks the shape of the
 * system to whoever reads the bundle.
 *
 * AND ONE DECISION IS DELIBERATELY NOT MINE TO CHANGE.
 *
 * The header's search box was the owner's alone, for a stated reason: the
 * RESULTS were always scoped, but a box inviting everyone to look up any
 * customer by phone is not the same thing as a box only the owner has. That
 * is a privacy rule, not a layout one. So `canSearchRecords` carries it
 * across unchanged: everybody gets the screens and the actions — navigating
 * to a screen you already hold is not an exposure — and record lookup stays
 * exactly where it was.
 *
 * AND A FORM IS NOT A SCREEN UNDER A VERB EITHER — «+ أنشئ».
 *
 * Seven forms already exist, each behind a button on the screen it belongs
 * to. The box lists them under their buttons' own names and goes to that
 * screen with `?new=…`; the screen opens the form it already has
 * (`useCreateIntent`). Nothing is built twice: the row is a link, and what
 * the form does when it is saved is what it did when the button opened it.
 *
 * The rows are NOT a list in this file. They arrive in `may.create`, drawn
 * by the server for THIS account (`palette-create.ts`) — the same reason as
 * above: a palette that carries the list and hides the rows an account
 * lacks has shipped the list to every account.
 */

/**
 * WHAT THE SERVER SAYS THIS ACCOUNT MAY ASK FOR.
 *
 * Not a role name and not a permission list: three answers, decided by
 * `GET /api/palette` out of the permission engine. The palette never
 * computes who may pull — it is told, by the same door that already
 * refuses the pull itself.
 */
interface PaletteMay {
  pull: boolean;
  people: boolean;
  /** The store's numbers, or this desk's. Only the wording depends on it. */
  wide: boolean;
  /** «لخّصلي اليوم» — only for who may read the numbers AND hold the assistants' key. Absent in an older answer: not offered. */
  today?: boolean;
  /**
   * «+ أنشئ» — the forms this account may be taken to, already drawn. Optional because an older answer, or a failed one, has none:
   * a box without them is a box without the group, never a box that guesses.
   */
  create?: CreateRow[];
}

/** What a command that acts rather than navigates is given to act with. */
interface ActionCtx {
  close: () => void;
  push: (href: string) => void;
  /** One line back into the open box — a refusal, or an answer. */
  say: (text: string) => void;
  working: (on: boolean) => void;
}

interface Action {
  key: string;
  label: (folded: boolean) => string;
  hint: string;
  icon: string;
  /** Where it goes, when it goes anywhere the registry does not already name. */
  href?: string;
  /** Some commands only exist for some people; `true` when it always does. */
  offered?: (ctx: { canSwitchStore: boolean; may: PaletteMay | null }) => boolean;
  /** Does its glyph point somewhere, and so turn in a right-to-left page? */
  mirror?: boolean;
  /** Or what it does, when it does not go anywhere at all. */
  run?: (ctx: ActionCtx) => void;
  /**
   * Does its answer land INSIDE the box?
   *
   * «لخّصلي اليوم» writes a paragraph into the sheet, and «اسحب» writes a
   * refusal into it. Closing first would draw both onto a sheet that is
   * already gone — which is the shape of «كبست وما صار شي».
   */
  keepsOpen?: true;
}

/**
 * «اسحب» — THE SAME DOOR THE PULL SCREEN PRESSES.
 *
 * `POST /api/confirmation/pull` and nothing else, so every refusal it
 * already enforces arrives here unchanged: «سجّل محاولة اتصال على طلبك
 * الحالي», the two caps, «لا توجد طلبات بانتظار التأكيد الآن», and the
 * 403 for an account whose desk this is not. There is no second pull path
 * and no second rule — a palette that picked its own candidate would be a
 * way around the caps, which is the whole reason the caps exist.
 */
async function pullNext(ctx: ActionCtx) {
  ctx.working(true);
  try {
    await apiJson('/api/confirmation/pull', { method: 'POST' });
    ctx.close();
    ctx.push('/confirmation/mine');
  } catch (e) {
    ctx.say(e instanceof Error ? e.message : 'تعذر سحب طلب');
  } finally {
    ctx.working(false);
  }
}

/** «لخّصلي اليوم» — numbers in, one Arabic paragraph back. See the route. */
async function summariseToday(ctx: ActionCtx) {
  ctx.working(true);
  try {
    const answer = await apiJson<{ text: string; from: string; why?: string }>(
      '/api/palette/today',
      { method: 'POST' }
    );
    // The screen says WHY it is the plain version — «الموديل مش محلّي» is
    // a setting the owner can change, and silence about it reads as a
    // worse model rather than an unused one.
    const why =
      answer.from === 'LOCAL_MODEL'
        ? ''
        : answer.why === 'NOT_LOCAL'
          ? '\nالنصّ من الأرقام لا من موديل: مسار الذكاء ليس LOCAL، فلا شيء يخرج من الجهاز.'
          : '\nالنصّ من الأرقام لا من موديل.';
    ctx.say(answer.text + why);
  } catch (e) {
    ctx.say(e instanceof Error ? e.message : 'تعذر التلخيص');
  } finally {
    ctx.working(false);
  }
}

/** The commands that live in the chrome, and so have no route to be found at. */
const ACTIONS: Action[] = [
  {
    key: 'pull',
    label: () => 'اسحب الطلب التالي',
    hint: 'من أي شاشة — وبنفس شروط شاشة السحب',
    icon: 'Inbox',
    // Exactly the pull screen's own condition, as the server reported it.
    offered: ({ may }) => may?.pull === true,
    run: (ctx) => void pullNext(ctx),
    keepsOpen: true,
  },
  {
    key: 'today',
    label: () => 'لخّصلي اليوم',
    hint: 'فقرة واحدة من الأرقام نفسها — بلا أسماء ولا هواتف',
    icon: 'Lightbulb',
    // Exactly the summary door's own two keys, as the server reported them — a button that only ever answers 403 teaches nothing.
    offered: ({ may }) => may?.today === true,
    run: (ctx) => void summariseToday(ctx),
    keepsOpen: true,
  },
  {
    key: 'switch',
    label: () => 'تبديل المتجر أو البلد',
    hint: 'كل طلب يحمل البلد والمتجر المختارَين',
    icon: 'Repeat',
    href: '/entry?change=1',
    // Exactly the header's own condition: one store and one country means
    // a picker with one thing in it.
    offered: ({ canSwitchStore }) => canSwitchStore,
  },
  {
    key: 'rail',
    label: (folded) => (folded ? 'وسّع القائمة' : 'اطوِ القائمة إلى شريط'),
    hint: 'أعرض للشاشة، أضيق للقائمة — ويُحفظ على هذا المتصفح',
    icon: 'SideBar',
    // The glyph shows a panel against one edge, so it turns with the page.
    mirror: true,
    run: () => setRailed(!storedRail()),
  },
  {
    key: 'signout',
    label: () => 'تسجيل الخروج',
    hint: 'أنهِ الجلسة على هذا الجهاز',
    icon: 'SignOut',
    run: () => signOut('manual'),
  },
];

interface Hit {
  id: string;
  orderNumber: string;
  customer?: { fullName?: string | null } | null;
  totalAmount?: number | string | null;
  currency?: string | null;
}

/** A colleague, as the server is willing to name one. No email, no phone. */
interface Person {
  id: string;
  name: string;
  roleAr: string;
}

/** A product, as the server is willing to name one: an id, a name, a code. No price, no cost, no stock. */
interface ProductHit {
  id: string;
  name: string;
  sku: string;
}

/** Same shape for all of them, so a row is a row and the list reads as one. */
interface Row {
  kind: 'count' | 'record' | 'person' | 'product' | 'screen' | 'action' | 'create';
  key: string;
  label: string;
  hint: string;
  icon: string;
  mirror?: boolean;
  /** Printed at the end of the row — a counter's own figure. */
  tally?: number;
  /** Choosing it navigates, or does something here. Never both. */
  href?: string;
  run?: () => void;
  /** See `Action.keepsOpen`. */
  keepsOpen?: true;
}

const GROUP_AR: Record<Row['kind'], string> = {
  count: 'أرقام',
  record: 'سجلات',
  person: 'الموظفون',
  product: 'المنتجات',
  screen: 'شاشات',
  action: 'أفعال',
  create: '+ أنشئ',
};

/** Long enough that typing a barcode is one request, not eleven. */
const SETTLE_MS = 220;

export function CommandPalette({
  groups,
  canSearchRecords,
  canSwitchStore,
  open,
  onClose,
}: {
  groups: NavGroup[];
  /** The header's existing rule, moved not rewritten. See the note above. */
  canSearchRecords: boolean;
  /** Likewise the header's: is there more than one store or country? */
  canSwitchStore: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  /** Only so one command can read its own name aloud both ways round. */
  const [folded, setFolded] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  /** The opening summary, and what this account may ask for. */
  const [facts, setFacts] = useState<PaletteFact[] | null>(null);
  const [may, setMay] = useState<PaletteMay | null>(null);
  /** The counters and the colleagues a typed word asked for. */
  const [counts, setCounts] = useState<PaletteFact[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [products, setProducts] = useState<ProductHit[]>([]);
  /** One line a command wrote back into the open box. */
  const [notice, setNotice] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits(null);
    setCounts([]);
    setPeople([]);
    setNotice(null);
    setCursor(0);
    // After paint, or the focus lands on an element that is still hidden.
    setFolded(storedRail());
    const id = setTimeout(() => box.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  /**
   * WHAT IS IN FRONT OF THIS ACCOUNT RIGHT NOW.
   *
   * Asked on every open rather than once: the counts are the point, and a
   * figure cached from the last time somebody pressed Ctrl+K is a figure
   * that is wrong. `GET /api/palette` takes no scope parameter — see its
   * own note — so this request cannot ask for anybody else's numbers.
   */
  useEffect(() => {
    if (!open) return;
    let dropped = false;
    apiJson<{ facts: PaletteFact[]; may: PaletteMay }>('/api/palette')
      .then((data) => {
        if (dropped) return;
        setFacts(data.facts ?? []);
        setMay(data.may ?? null);
      })
      // A refused or dropped summary leaves the box a box. It is the thing
      // the palette gained, not the thing it is for.
      .catch(() => {
        if (!dropped) setFacts([]);
      });
    return () => {
      dropped = true;
    };
  }, [open]);

  /**
   * THE COUNTERS, AND THE COLLEAGUES.
   *
   * `POST` with the term in the BODY, because one of the things a person
   * types here is a customer's phone number and a query string is written
   * into every log on the way. The route's own note says the rest.
   */
  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setCounts([]);
      setPeople([]);
      setProducts([]);
      return;
    }
    let dropped = false;
    const id = setTimeout(async () => {
      try {
        const data = await apiJson<{ facts: PaletteFact[]; people: Person[]; products?: ProductHit[] }>('/api/palette', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: term }),
        });
        if (dropped) return;
        setCounts(data.facts ?? []);
        setPeople(data.people ?? []);
        setProducts(data.products ?? []);
      } catch {
        if (dropped) return;
        setCounts([]);
        setPeople([]);
        setProducts([]);
      }
    }, SETTLE_MS);
    return () => {
      dropped = true;
      clearTimeout(id);
    };
  }, [query, open]);

  useEffect(() => {
    const heard = () => setFolded(storedRail());
    window.addEventListener(RAIL_EVENT, heard);
    return () => window.removeEventListener(RAIL_EVENT, heard);
  }, []);

  /**
   * The records. A scanned barcode and a typed order number take the same
   * path — the one the orders screen uses — so the palette can never find
   * something the screen behind it could not.
   */
  useEffect(() => {
    const term = query.trim();
    if (!open || !canSearchRecords || term.length < 2) {
      setHits(null);
      return;
    }
    let dropped = false;
    setLooking(true);
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/orders?q=${encodeURIComponent(term)}&limit=6`, {
          credentials: 'same-origin',
        });
        const data = res.ok ? await res.json() : { orders: [] };
        if (!dropped) setHits(data.orders ?? []);
      } catch {
        if (!dropped) setHits([]);
      } finally {
        if (!dropped) setLooking(false);
      }
    }, SETTLE_MS);
    return () => {
      dropped = true;
      clearTimeout(id);
    };
  }, [query, open, canSearchRecords]);

  /**
   * WHAT AN OPEN, EMPTY BOX SHOULD SAY.
   *
   * Not "here are the first twenty-four of your fifty screens". That is the
   * menu again in a smaller window, and it answers a question nobody asked.
   * So an empty box offers the three commands that have no route to be
   * found at; typing is what asks for a screen or a record.
   *
   * And each group is capped on its own, never the list as a whole — a
   * common order number must not be able to push the commands out of reach.
   */
  /**
   * One context, handed to whichever command was chosen. Built here and
   * not inside each command so «اسحب» and «لخّصلي اليوم» cannot differ
   * about what closing the box means.
   */
  const ctx: ActionCtx = useMemo(
    () => ({
      close: onClose,
      push: (href: string) => router.push(href),
      say: setNotice,
      working: setLooking,
    }),
    [onClose, router]
  );

  const rows: Row[] = useMemo(() => {
    const term = query.trim().toLowerCase();
    const asRow = (a: Action): Row => ({
      kind: 'action',
      key: `a:${a.key}`,
      label: a.label(folded),
      hint: a.hint,
      icon: a.icon,
      mirror: a.mirror,
      href: a.href,
      run: a.run ? () => a.run!(ctx) : undefined,
      keepsOpen: a.keepsOpen,
    });

    const offered = ACTIONS.filter((a) => !a.offered || a.offered({ canSwitchStore, may }));

    /*
     * «+ أنشئ» — FIRST IN THE OPEN BOX, because «what do I want to make» is the question people open it with, and after the screens
     * when a word is typed, because by then the word is what they are looking for. A row is a link to the screen the form is on.
     */
    const creatable = may?.create ?? [];
    const asCreate = (c: CreateRow): Row => ({
      kind: 'create',
      key: `n:${c.key}`,
      label: c.label,
      hint: c.hint,
      icon: c.icon,
      href: c.href,
    });

    if (!term) return [...creatable.map(asCreate), ...offered.map(asRow)];

    /*
     * THE COUNTERS FIRST, because they are the answer to the shortest
     * thing anybody types. «مؤجل» is four letters and the question behind
     * it is «كم», not «أيّ شاشة».
     */
    const counters: Row[] = counts.map((fact) => ({
      kind: 'count' as const,
      key: `c:${fact.key}`,
      label: fact.label,
      hint: fact.rule,
      tally: fact.count,
      href: fact.href,
      icon: 'Gauge',
    }));

    const records: Row[] = (hits ?? []).slice(0, 6).map((hit) => ({
      kind: 'record',
      key: `r:${hit.id}`,
      label: hit.orderNumber,
      hint: hit.customer?.fullName ?? 'طلب',
      href: `/orders?q=${encodeURIComponent(hit.orderNumber)}`,
      icon: 'Receipt',
    }));

    /*
     * A COLLEAGUE'S NAME OPENS THEIR PAGE — for whoever may open it.
     *
     * The list arrives empty unless the server found `users.view` on this
     * account, so there is nothing to filter here and nothing to hide: a
     * palette that received names and then declined to draw them would
     * have shipped them to the browser anyway.
     */
    const colleagues: Row[] = people.map((person) => ({
      kind: 'person' as const,
      key: `p:${person.id}`,
      label: person.name,
      hint: person.roleAr,
      href: `/admin/users/${person.id}`,
      icon: 'CircleUser',
    }));

    // A product, one press from its page — the list arrives empty unless the server found `products.view`.
    const catalogue: Row[] = products.map((product) => ({
      kind: 'product' as const,
      key: `g:${product.id}`,
      label: product.name,
      hint: product.sku,
      href: `/products/${product.id}`,
      icon: 'Package',
    }));

    const screens: Row[] = groups
      .flatMap((group) => group.routes.map((route) => ({ group, route })))
      .filter(({ route }) => route.label.toLowerCase().includes(term) || route.path.includes(term))
      .slice(0, 8)
      .map(({ group, route }) => ({
        kind: 'screen' as const,
        key: `s:${route.path}`,
        label: route.label,
        hint: group.label,
        href: route.path,
        icon: route.icon,
      }));

    const actions: Row[] = offered.map(asRow).filter((r) => r.label.toLowerCase().includes(term));

    const creating: Row[] = creatable
      .filter((c) => c.label.toLowerCase().includes(term) || c.words.some((w) => w.toLowerCase().includes(term)))
      .map(asCreate);

    return [...counters, ...records, ...colleagues, ...catalogue, ...screens, ...creating, ...actions];
  }, [groups, hits, counts, people, products, query, folded, canSwitchStore, may, ctx]);

  const go = useCallback(
    (row: Row) => {
      // A destination closes the box. A command whose answer is drawn
      // INSIDE the box must not close it first, or the answer lands on a
      // sheet that is already gone — see `Action.keepsOpen`.
      if (!row.keepsOpen) onClose();
      if (row.href) router.push(row.href);
      else row.run?.();
    },
    [onClose, router]
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[cursor];
        if (row) go(row);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [rows, cursor, go, onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-[var(--sys-background)]/70 backdrop-blur-sm md:p-4 md:pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="بحث وتنقّل وأفعال"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden border-[var(--sys-border)] bg-[var(--sys-card)] shadow-overlay md:h-auto md:max-h-[70vh] md:max-w-xl md:rounded-lg md:border"
      >
        <div className="flex items-center gap-2 border-b border-[var(--sys-border)] px-4">
          <RiSearchLine className="w-5 h-5 shrink-0 text-[var(--sys-muted)]" aria-hidden />
          <input
            ref={box}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKey}
            placeholder={
              canSearchRecords
                ? 'رقم طلب، هاتف، باركود، «مؤجل»، اسم منتج، اسم شاشة، أو فعل…'
                : '«مؤجل»، «متأخر»، اسم منتج، هاتف، اسم شاشة، أو ما تريد فعله…'
            }
            aria-label="ابحث أو انتقل أو نفّذ"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-[var(--sys-muted)]"
          />
          {looking && <RiLoader4Line className="w-4 h-4 shrink-0 animate-spin text-[var(--sys-muted)]" aria-hidden />}
          {/* A full-screen sheet covers the backdrop, and a phone has no
              Esc. Without this there is no way back out. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:hidden -mr-1 p-2 text-[var(--sys-muted-foreground)]"
          >
            <RiCloseLine className="w-5 h-5" />
          </button>
        </div>

        {/*
          WHAT AN OPEN BOX ANSWERS BEFORE ANYTHING IS TYPED.

          Five counts and, under each, the rule it was counted by. The rule
          is not a tooltip and not a help page: «متأخرة» is the kind of
          number two people read two ways, and the sentence that settles it
          costs one line.

          A PANEL AND NOT ROWS, deliberately. These are not choices — they
          are the state of the desk — so they are not in the ↑↓ list and
          Enter never lands on one. The ones with a list behind them are
          still pressable, because a number you cannot open is a number you
          have to go and find by hand.
        */}
        {!query.trim() && facts !== null && facts.length > 0 && (
          <section
            aria-label="ملخّص اليوم"
            className="border-b border-[var(--sys-border)] bg-[var(--sys-surface)] px-4 py-3"
          >
            <p className="pb-2 text-xs font-semibold text-[var(--sys-muted-foreground)]">
              {may?.wide ? 'المتجر الآن' : 'عملك الآن'}
            </p>
            <ul className="space-y-1.5">
              {facts.map((fact) => (
                <li key={fact.key}>
                  <button
                    type="button"
                    disabled={!fact.href}
                    onClick={() => {
                      if (!fact.href) return;
                      onClose();
                      router.push(fact.href);
                    }}
                    aria-label={`${fact.label}: ${fact.count} — ${fact.rule}`}
                    className="flex w-full items-start gap-3 text-start"
                  >
                    <span className="w-8 shrink-0 text-sm font-semibold tabular-nums text-[var(--sys-heading)]">
                      {fact.count}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-[var(--sys-heading)]">{fact.label}</span>
                      {/* The rule, in full. Not truncated: half a rule is
                          worse than none — it reads as a different rule. */}
                      <span className="block text-xs text-[var(--sys-muted-foreground)]">{fact.rule}</span>
                    </span>
                    {fact.href && (
                      <RiArrowRightSLine className="icon-mirror w-4 h-4 shrink-0 text-[var(--sys-muted)]" aria-hidden />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* What a command wrote back: «لخّصلي اليوم»'s paragraph, or the
            refusal «اسحب» came back with. `whitespace-pre-line` because the
            summary carries its own second line saying where it came from. */}
        {notice && (
          <p
            role="status"
            className="whitespace-pre-line border-b border-[var(--sys-border)] bg-[var(--sys-surface)] px-4 py-3 text-sm leading-relaxed text-[var(--sys-heading)]"
          >
            {notice}
          </p>
        )}

        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-[var(--sys-muted-foreground)]">
              {query.trim().length < 2
                ? canSearchRecords
                  ? 'اكتب حرفين على الأقل — أو امسح باركوداً.'
                  : 'اكتب حرفين على الأقل.'
                : 'لا شيء بهذا الاسم ولا بهذا الرقم، ضمن ما تملك صلاحية رؤيته.'}
            </li>
          )}

          {rows.map((row, i) => {
            // Derived, not accumulated: a heading appears where the kind
            // changes. A running variable mutated mid-render happens to
            // work and is the kind of thing that stops working.
            const head = i === 0 || rows[i - 1].kind !== row.kind ? GROUP_AR[row.kind] : null;
            const Icon = iconFor(row.icon);
            return (
              <React.Fragment key={row.key}>
                {head && (
                  <li className="px-4 pb-1 pt-3 text-xs font-semibold text-[var(--sys-muted-foreground)]">{head}</li>
                )}
                <li>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(row)}
                    aria-current={i === cursor ? 'true' : undefined}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-start ${
                      i === cursor ? 'bg-[var(--sys-primary-soft)]' : ''
                    }`}
                  >
                    <Icon
                      className={`w-5 h-5 shrink-0 text-[var(--sys-muted-foreground)] ${
                        row.mirror ? 'icon-mirror' : ''
                      }`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-[var(--sys-heading)]">{row.label}</span>
                      {/* A counter's rule is the whole point of the row, so
                          it is not truncated — every other hint is a group
                          name or a role name and fits. */}
                      <span
                        className={`block text-xs text-[var(--sys-muted-foreground)] ${
                          row.kind === 'count' ? '' : 'truncate'
                        }`}
                      >
                        {row.hint}
                      </span>
                    </span>
                    {row.tally !== undefined && (
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--sys-heading)]">
                        {row.tally}
                      </span>
                    )}
                    {/* A chevron promises a destination; a command that
                        acts right here has none. */}
                    {row.href ? (
                      <RiArrowRightSLine className="icon-mirror w-4 h-4 shrink-0 text-[var(--sys-muted)]" aria-hidden />
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                  </button>
                </li>
              </React.Fragment>
            );
          })}
        </ul>

        {/* Esc and Enter are a desk's vocabulary. On a phone the ✕ above is
            the whole instruction, and a line naming keys that are not there
            is one more thing to read and ignore. */}
        <p className="hidden md:block border-t border-[var(--sys-border)] px-4 py-2 text-xs text-[var(--sys-muted-foreground)]">
          ↑ ↓ للتنقّل · Enter للفتح · Esc للإغلاق
        </p>
      </div>
    </div>
  );
}

/** Ctrl/Cmd + K, from anywhere, without every screen knowing about it. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { open, setOpen };
}
