'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { apiJson } from '@/lib/api-client';
import { CombinationBoxes, badBox, typedCombinations } from './CombinationBoxes';

/**
 * THE OPENING PLACEMENT SHEET — once per store, the keepers' counts divide the book between the warehouses
 * (warehouse plan, request W1b; the doors and every rule are W1a's: `/api/inventory/placement` and its preview).
 *
 * THIS FILE DOES NO ARITHMETIC ON A FIGURE. Every number drawn here — what there is to place, what is with the courier,
 * what was counted, the difference, the units per warehouse — is the server's (`warehouse-placement.planPlacement`), read
 * from the preview after every change of a box. The screen only reads the boxes as typed and asks. A sum made here would be
 * a second copy of the rule, and the day the two disagree the press refuses a sheet the screen called exact.
 *
 * A BLANK BOX IS NOT A ZERO ON THE WIRE — it is simply not sent; the server counts what it was not sent as nothing in that
 * warehouse, which for a product with nothing to place is the right answer and for one with stock is a difference the
 * preview names. A box that is not a whole number from zero up is said under the box and stops the check.
 *
 * Nothing configured = today: a store with no warehouse it can be placed in (or already placed) draws no banner at all.
 */

interface Warehouse {
  id: string;
  name: string;
}

interface PlacementRow {
  productId: string;
  name: string;
  sku: string | null;
  onHand: number;
  withCourier: number;
  toPlace: number;
  counted: number;
  difference: number;
  perWarehouse: Record<string, number>;
  hasVariants: boolean;
}

/** 20/11 (W8c): one combination of a product, as the door sends it — its label and its store-level count. */
interface Combination {
  variantId: string;
  label: string;
  onHand: number;
}

interface Gate {
  placed?: boolean;
  warehouses?: Warehouse[];
  rows?: PlacementRow[];
  variantsNote?: string;
  /** Present only when some product of the store has combinations. */
  combinations?: Record<string, Combination[]>;
}

interface Check {
  /** The counts this answer is about — the press waits until it is about the boxes as they are now. */
  key: string;
  exact: boolean;
  rows: PlacementRow[];
  differing: PlacementRow[];
  totals: Record<string, number>;
  messageAr?: string;
}

const WHOLE = /^\d+$/;
/** Cards drawn at once; «اعرض المزيد» draws the next ones. Three hundred cards of boxes is a page nobody reaches the end of. */
const PAGE = 30;

/** Now, as the date-and-time box writes it — formatted by the browser, not assembled from parts. */
function nowForBox() {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date())
    .replace(' ', 'T');
}

/** The difference as the server gave it, with its sign said. */
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function PlacementBanner({ onPlaced }: { onPlaced: () => void }) {
  const { currentUser } = useApp();
  /** UX only: the door asks `inventory.adjust` itself. */
  const canPlace = userCan(currentUser, 'inventory.adjust');
  const [gate, setGate] = useState<Gate | null>(null);
  const [open, setOpen] = useState(false);
  /** Bumped after the press: the door is asked again, and a placed store's banner goes. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    // Through `Promise.resolve().then`, so a read that throws before it is a promise is the same «no banner» as a refusal.
    Promise.resolve()
      .then(() => apiJson<Gate>('/api/inventory/placement'))
      .then(
        (g) => live && setGate(g ?? null),
        () => live && setGate(null)
      );
    return () => {
      live = false;
    };
  }, [reads]);

  // Placed, refused, or no warehouse to place in: today's screen, untouched.
  if (!gate || gate.placed !== false || !gate.warehouses || gate.warehouses.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] px-3 py-2.5">
        <p className="text-note leading-relaxed text-[var(--sys-warning)]">
          بضاعة هالمتجر لسا مش موزّعة على المخازن. بتعدّ كل مخزن، والنظام بيوزّع رصيد الدفتر عليهم مرة وحدة. لحد ما
          توزّع، كل شي بيشتغل متل اليوم.
          {!canPlace && ' التوزيع بيعمله اللي معه صلاحية تعديل المخزون.'}
        </p>
        {canPlace && (
          <Button type="button" className="shrink-0" onClick={() => setOpen(true)}>
            وزّع الرصيد على المخازن
          </Button>
        )}
      </div>

      {open && (
        <PlacementSheet
          warehouses={gate.warehouses}
          rows={gate.rows ?? []}
          variantsNote={gate.variantsNote ?? null}
          combinations={gate.combinations ?? {}}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            setReads((n) => n + 1);
            onPlaced();
          }}
        />
      )}
    </>
  );
}

function PlacementSheet({
  warehouses,
  rows,
  variantsNote,
  combinations,
  onClose,
  onDone,
}: {
  warehouses: Warehouse[];
  rows: PlacementRow[];
  variantsNote: string | null;
  combinations: Record<string, Combination[]>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState<Record<string, Record<string, string>>>({});
  /** 20/11 (W8c): the combination boxes as typed — by product, then warehouse, then combination. */
  const [typedV, setTypedV] = useState<Record<string, Record<string, Record<string, string>>>>({});
  const [countedByName, setCountedByName] = useState('');
  const [countedAt, setCountedAt] = useState(nowForBox);
  const [note, setNote] = useState('');
  const [term, setTerm] = useState('');
  const [only, setOnly] = useState<'all' | 'diff'>('all');
  const [limit, setLimit] = useState(PAGE);
  /** The last answer of the preview, with the counts and the round it was asked about. */
  const [answer, setAnswer] = useState<{ key: string; round: number; check?: Check; error?: string } | null>(null);
  /** Bumped after a refused press: the same boxes are asked about again, and the press waits for that answer. */
  const [again, setAgain] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const box = (productId: string, warehouseId: string) => typed[productId]?.[warehouseId] ?? '';
  const setBox = (productId: string, warehouseId: string, value: string) =>
    setTyped((t) => ({ ...t, [productId]: { ...t[productId], [warehouseId]: value } }));
  const comboValues = (productId: string, warehouseId: string) => typedV[productId]?.[warehouseId] ?? {};
  const setComboBox = (productId: string, warehouseId: string, variantId: string, value: string) =>
    setTypedV((t) => ({ ...t, [productId]: { ...t[productId], [warehouseId]: { ...t[productId]?.[warehouseId], [variantId]: value } } }));

  /**
   * The counts as the door reads them: every warehouse in the order shown, a line for every box with something in it.
   * 20/11 (W8c): a line of a product with combinations carries the combination boxes typed under it (a zero is a count,
   * a blank is not sent); whether they add up to the line is the preview's to say. Combinations typed under a blank
   * product box are not a line — the sheet asks for the product's own count first.
   */
  const { counts, invalid, missing } = useMemo(() => {
    const bad = new Set<string>();
    const noTotal = new Set<string>();
    const out = warehouses.map((w) => ({
      warehouseId: w.id,
      lines: rows.flatMap((r) => {
        const raw = (typed[r.productId]?.[w.id] ?? '').trim();
        const mine = combinations[r.productId] ?? [];
        const values = typedV[r.productId]?.[w.id] ?? {};
        // Its own key: the box under the product says nothing about a combination box (which says it itself).
        if (mine.some((c) => badBox(values[c.variantId]))) bad.add(`${r.productId}:${w.id}:combination`);
        const variants = typedCombinations(mine, values, { dropZero: false });
        if (raw === '') {
          if (variants.length > 0) noTotal.add(`${r.productId}:${w.id}`);
          return [];
        }
        if (!WHOLE.test(raw)) {
          bad.add(`${r.productId}:${w.id}`);
          return [];
        }
        return [{ productId: r.productId, quantity: Number(raw), ...(variants.length > 0 ? { variants } : {}) }];
      }),
    }));
    return { counts: out, invalid: bad, missing: noTotal };
  }, [typed, typedV, warehouses, rows, combinations]);
  const key = JSON.stringify(counts);

  // THE LIVE CHECK: the preview, a moment after the last key, about exactly these counts. An older answer that lands late
  // is dropped — it is about boxes that are no longer what the screen shows.
  useEffect(() => {
    if (invalid.size > 0 || missing.size > 0) return;
    let live = true;
    const timer = setTimeout(() => {
      apiJson<Omit<Check, 'key'>>('/api/inventory/placement/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"counts":${key}}`,
      }).then(
        (said) => live && setAnswer({ key, round: again, check: { ...said, key } }),
        (e: unknown) => live && setAnswer({ key, round: again, error: e instanceof Error ? e.message : 'تعذّر الفحص' })
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, invalid.size, missing.size, again]);

  const current = answer !== null && answer.key === key && answer.round === again && invalid.size === 0 && missing.size === 0;
  const check = current && answer.check ? answer.check : null;
  const checkError = current && answer.error ? answer.error : null;
  const shownRows = answer?.check?.rows ?? rows;
  const visible = useMemo(() => {
    const q = term.trim();
    return shownRows.filter((r) => {
      if (only === 'diff' && r.difference === 0) return false;
      if (!q) return true;
      return r.name.includes(q) || (r.sku ?? '').toUpperCase().includes(q.toUpperCase());
    });
  }, [shownRows, term, only]);
  const cards = visible.slice(0, limit);

  const fresh = check !== null;
  const ready = check !== null && check.exact && countedByName.trim().length >= 3 && countedAt !== '';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/placement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countedByName: countedByName.trim(),
          countedAt: new Date(countedAt).toISOString(),
          note: note.trim() || null,
          counts,
        }),
        // A few hundred products are a few hundred row writes in one transaction; the door allows it a minute.
        timeoutMs: 60_000,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر التوزيع');
      // The book may have moved under the sheet: ask again about the same boxes.
      setAgain((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="توزيع الرصيد على المخازن"
      subtitle="مرة وحدة لهالمتجر: اكتب شو عدّيت بكل مخزن، والنظام بيقارن مع الدفتر"
      maxWidth="4xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="button" onClick={() => { void submit(); }} disabled={!ready} loading={busy}>
            وزّع
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          اللي مع شركة الشحن ما بينعدّ: بيضل بلا مخزن لحد ما يتسلّم أو يرجع. المجموع لازم يطابق الدفتر بالقطعة، والفرق
          ما بينصلّح هون — بينصلّح من «جرد المتاح» أول. التوزيع ما بيغيّر ولا رقم بالأرصدة ولا بالتكلفة.
        </p>
        {variantsNote && <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">{variantsNote}</p>}

        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="مين عدّ *"
            value={countedByName}
            onChange={(e) => setCountedByName(e.target.value)}
            placeholder="الاسم متل ما بيوقّع على ورقة العدّ"
            maxLength={120}
          />
          <Input label="وقت العدّ *" type="datetime-local" value={countedAt} onChange={(e) => setCountedAt(e.target.value)} />
          <Input label="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>

        {/* THE CHECK — the server's sentence and the server's figures, nothing more. */}
        {checkError ? (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {checkError}
          </p>
        ) : invalid.size > 0 ? (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            في خانة مش رقم صحيح. العدد لازم يكون رقم صحيح من صفر وطالع.
          </p>
        ) : missing.size > 0 ? (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            في منتج كتبت عدد خياراته بمخزن وما كتبت عدده هو. اكتب عدد المنتج بهالمخزن كمان.
          </p>
        ) : !fresh ? (
          <p className="text-note text-[var(--sys-muted-foreground)]">عم نقارن مع الدفتر…</p>
        ) : check.exact ? (
          <div className="rounded-lg border border-[var(--sys-success)]/30 bg-[var(--sys-success-soft)] p-3">
            <p className="text-sm text-[var(--sys-success)]">العدّ مطابق للدفتر. جاهز للتوزيع.</p>
            <ul className="mt-1.5 space-y-1.5">
              {warehouses.map((w) => (
                <li key={w.id} className="text-note text-[var(--sys-foreground)]">
                  {w.name}:{' '}
                  <span className="tabular-nums font-bold" dir="ltr">
                    {check.totals[w.id] ?? 0}
                  </span>{' '}
                  قطعة
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-2.5 text-note leading-relaxed text-[var(--sys-warning)]">
            {check.messageAr}
          </p>
        )}

        <Input
          aria-label="ابحث باسم المنتج أو رمزه"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setLimit(PAGE);
          }}
          placeholder="ابحث باسم المنتج أو رمزه…"
        />
        <Segmented
          aria-label="أي منتجات"
          size="sm"
          value={only}
          onChange={(v) => {
            setOnly(v === 'diff' ? 'diff' : 'all');
            setLimit(PAGE);
          }}
          options={[
            { value: 'all', label: 'الكل', count: shownRows.length },
            { value: 'diff', label: 'فيها فرق', count: fresh ? check.differing.length : '—' },
          ]}
        />

        {rows.length === 0 ? (
          <Card plain padding="sm">
            <p className="text-sm text-[var(--sys-muted-foreground)]">ما في منتجات بهالمتجر. ما في شي يتوزّع.</p>
          </Card>
        ) : visible.length === 0 ? (
          <Card plain padding="sm">
            <p className="text-sm text-[var(--sys-muted-foreground)]">ولا منتج بيطابق اللي اخترته.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {cards.map((r) => (
              <Card key={r.productId} padding="sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block text-sm font-bold text-[var(--sys-heading)]">{r.name}</span>
                    {r.sku && (
                      <span className="block text-note text-[var(--sys-muted-foreground)]" dir="ltr">
                        {r.sku}
                      </span>
                    )}
                  </div>
                  <span
                    className={
                      r.difference === 0
                        ? 'shrink-0 rounded-full bg-[var(--sys-success-soft)] px-2 py-0.5 text-note font-semibold text-[var(--sys-success)]'
                        : 'shrink-0 rounded-full bg-[var(--sys-warning-soft)] px-2 py-0.5 text-note font-semibold text-[var(--sys-warning)]'
                    }
                  >
                    {r.difference === 0 ? 'مطابق' : 'فيه فرق'}
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  <Figure label="لازم يتوزّع" value={r.toPlace} />
                  <Figure label="المعدود" value={r.counted} />
                  <Figure label="الفرق" value={signed(r.difference)} />
                </div>
                <p className="mt-1.5 text-note text-[var(--sys-muted)]">
                  على الرف {r.onHand} · مع الشحن {r.withCourier}
                </p>
                <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {warehouses.map((w) => {
                    const bad = invalid.has(`${r.productId}:${w.id}`);
                    return (
                      <Input
                        key={w.id}
                        label={w.name}
                        aria-label={`عدد «${r.name}» بـ${w.name}`}
                        inputMode="numeric"
                        dir="ltr"
                        value={box(r.productId, w.id)}
                        onChange={(e) => setBox(r.productId, w.id, e.target.value)}
                        error={bad ? 'رقم صحيح من صفر وطالع' : undefined}
                      />
                    );
                  })}
                </div>

                {/* 20/11 (W8c): its combinations, a grid per warehouse — the store-level count beside each is the server's. */}
                {(combinations[r.productId] ?? []).length > 0 && (
                  <div className="mt-2.5 space-y-3">
                    {warehouses.map((w) => (
                      <CombinationBoxes
                        key={w.id}
                        title={`${w.name}: كم قطعة من كل خيار؟`}
                        combos={(combinations[r.productId] ?? []).map((c) => ({ variantId: c.variantId, label: c.label, hint: `بالمتجر كله ${c.onHand}` }))}
                        values={comboValues(r.productId, w.id)}
                        onChange={(variantId, value) => setComboBox(r.productId, w.id, variantId, value)}
                        ariaOf={(label) => `عدد «${r.name}» «${label}» بـ${w.name}`}
                      />
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {visible.length > cards.length && (
          <Button type="button" variant="secondary" className="w-full" onClick={() => setLimit((n) => n + PAGE)}>
            اعرض المزيد
          </Button>
        )}

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** One figure of a card, as the server sent it. */
function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-[var(--sys-surface)] p-2 text-center">
      <span className="block text-note text-[var(--sys-muted)]">{label}</span>
      <span className="tabular-nums text-[var(--sys-heading)] text-sm font-bold" dir="ltr">
        {value}
      </span>
    </div>
  );
}
