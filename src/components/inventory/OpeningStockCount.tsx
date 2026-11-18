'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Rows, type Column } from '@/components/ui/Rows';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { RiScales3Line } from '@remixicon/react';

/**
 * THE SIGNED PHYSICAL COUNT OF STOCK A STORE STARTED FROM.
 *
 * This is NOT the «الجرد» beside it on the same screen. That one is for when
 * the shelf and the system disagree about ONE product, and it works against
 * on-hand. This is the count taken at the switch time, before the system knows
 * anything, and it is signed by whoever counted.
 *
 * The two never overlap: the server refuses this once a single movement
 * exists, and the banner disappears at the same moment — so the button is
 * never offered where it can only end in a red error.
 *
 * A PRODUCT LEFT BLANK IS NOT ZERO. «We counted and found none» and «we did
 * not get to this one» are different facts, and treating the second as the
 * first would put a zero on the shelf that nobody counted. So blanks are left
 * out of the count, and their number is said out loud before submitting.
 */

interface Product {
  id: string;
  name: string;
  sku: string | null;
}

interface OpeningCount {
  countedByName: string;
  countedAt: string;
  note: string | null;
  _count: { batches: number };
}

export function OpeningStockCountBanner({ onCounted }: { onCounted: () => void }) {
  const [state, setState] = useState<{
    count: OpeningCount | null;
    movements: number;
    countable: boolean;
    products: Product[];
  } | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson('/api/inventory/opening-count'));
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;

  if (state.count) {
    return (
      <Card plain className="px-3 py-2">
        {/* The three lines inside stay byte-identical (R12c: the opening count's figures are not touched, not even re-indented). */}
        <p className="text-note text-[var(--sys-muted-foreground)]">
        العدّ الافتتاحيّ: عدَّه <span className="font-semibold text-[var(--sys-heading)]">{state.count.countedByName}</span>{' '}
        في {state.count.countedAt.slice(0, 10)} · {state.count._count.batches} بنداً
        {state.count.note ? ` · ${state.count.note}` : ''}
        </p>
      </Card>
    );
  }

  if (!state.countable) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] px-3 py-2.5">
        <p className="text-note leading-relaxed text-[var(--sys-warning)]">
          لم يُسجَّل عدٌّ افتتاحيٌّ لمخزون هذا المتجر. يُسجَّل مرّةً واحدةً لحظةَ بدء العمل على النظام،
          ويوقّعه من عدَّ بيده.
        </p>
        <Button type="button" className="shrink-0" onClick={() => setOpen(true)}>
          <RiScales3Line className="h-4 w-4" aria-hidden /> سجّل العدّ الافتتاحيّ
        </Button>
      </div>

      {open && (
        <OpeningCountDialog
          products={state.products}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void load();
            onCounted();
          }}
        />
      )}
    </>
  );
}

function OpeningCountDialog({
  products,
  onClose,
  onDone,
}: {
  products: Product[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [countedByName, setCountedByName] = useState('');
  const [countedAt, setCountedAt] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<Record<string, { qty: string; cost: string; zeroReason: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const row = (id: string) => rows[id] ?? { qty: '', cost: '', zeroReason: '' };
  const set = (id: string, patch: Partial<{ qty: string; cost: string; zeroReason: string }>) =>
    setRows((r) => ({ ...r, [id]: { ...row(id), ...patch } }));

  /**
   * ONE DEFINITION, TWO READINGS.
   *
   * `Rows` draws a table on a desk and a card per product on a phone from the
   * same `columns` array — which is what this form needs at 360px, where three
   * input columns side by side are three unusable fields. A hand-written
   * `<table>` here was caught by `one-table.test.ts`, and the guard was right:
   * the shared component is not only the rule, it is the answer.
   */
  const columns: Column<Product>[] = [
    {
      key: 'product',
      label: 'المنتج',
      render: (p) => (
        <span className="block">
          <span className="block text-[var(--sys-heading)]">{p.name}</span>
          {p.sku && (
            <span className="block text-note text-[var(--sys-muted-foreground)]" dir="ltr">
              {p.sku}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'qty',
      label: 'المعدود',
      align: 'end',
      render: (p) => (
        <input
          inputMode="numeric"
          aria-label={`الكمية المعدودة من ${p.name}`}
          value={row(p.id).qty}
          onChange={(e) => set(p.id, { qty: e.target.value })}
          className="h-11 md:h-10 w-full min-w-0 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm tabular-nums md:w-24"
        />
      ),
    },
    {
      key: 'cost',
      label: 'كلفة الوحدة',
      align: 'end',
      render: (p) => {
        const r = row(p.id);
        const zeroCost = r.qty.trim() !== '' && r.cost !== '' && Number(r.cost) === 0;
        return (
          <span className="block">
            <input
              inputMode="decimal"
              aria-label={`كلفة وحدة ${p.name}`}
              value={r.cost}
              onChange={(e) => set(p.id, { cost: e.target.value })}
              className="h-11 md:h-10 w-full min-w-0 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm tabular-nums md:w-28"
            />
            {/* Asked where the zero was typed, not in a summary at the bottom
                that names a product the reader has to go back and find. */}
            {zeroCost && (
              <input
                aria-label={`سبب كلفة الصفر لـ${p.name}`}
                value={r.zeroReason}
                onChange={(e) => set(p.id, { zeroReason: e.target.value })}
                placeholder="كلفة صفر — اكتب لماذا"
                maxLength={200}
                className="mt-1.5 h-11 md:h-10 w-full min-w-0 rounded-lg border border-[var(--sys-warning)]/60 bg-[var(--sys-card)] px-2 text-sm"
              />
            )}
          </span>
        );
      },
    },
  ];

  const filled = products.filter((p) => row(p.id).qty.trim() !== '');
  const blanks = products.length - filled.length;

  const lineReady = (p: Product) => {
    const r = row(p.id);
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty < 0) return false;
    const cost = Number(r.cost);
    if (!Number.isFinite(cost) || cost < 0) return false;
    if (cost === 0 && r.zeroReason.trim().length < 5) return false;
    return true;
  };

  const ready =
    countedByName.trim().length >= 3 && countedAt !== '' && filled.length > 0 && filled.every(lineReady);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiJson('/api/inventory/opening-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countedByName: countedByName.trim(),
          countedAt: new Date(countedAt).toISOString(),
          note: note.trim() || null,
          lines: filled.map((p) => {
            const r = row(p.id);
            return {
              productId: p.id,
              countedQty: Number(r.qty),
              unitCost: Number(r.cost),
              zeroCostReason: Number(r.cost) === 0 ? r.zeroReason.trim() : null,
            };
          }),
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="العدّ الافتتاحيّ للمخزون" maxWidth="4xl">
      <div className="space-y-3">
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          ما على الرفِّ فعلاً لحظةَ العدّ، بالكميّة والكلفة. الكلفةُ تُلتقط الآن ولا تُصحَّح لاحقاً —
          فكلُّ ما يُباع من وحدةٍ كلفتُها صفرٌ يُقرأ ربحاً صافياً إلى الأبد.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-note font-medium text-[var(--sys-heading)]">من عدَّ المخزون *</span>
            <input
              value={countedByName}
              onChange={(e) => setCountedByName(e.target.value)}
              placeholder="الاسم كما يُوقَّع على ورقة العدّ"
              maxLength={120}
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-note font-medium text-[var(--sys-heading)]">وقت العدّ *</span>
            <input
              type="datetime-local"
              value={countedAt}
              onChange={(e) => setCountedAt(e.target.value)}
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-note font-medium text-[var(--sys-heading)]">ملاحظة</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
            />
          </label>
        </div>

        {products.length === 0 ? (
          <Card plain padding="sm">
            <p className="text-sm text-[var(--sys-muted-foreground)]">لا منتجات في هذا المتجر بعد — أضف المنتجات قبل عدّ مخزونها.</p>
          </Card>
        ) : (
          <div className="max-h-[45vh] overflow-y-auto">
            <Rows<Product> columns={columns} rows={products} keyOf={(p) => p.id} />
          </div>
        )}

        {/* Said before submitting, not after: an omission is a fact about the
            count, and a blank is not a counted zero. */}
        {blanks > 0 && products.length > 0 && (
          <p className="text-note text-[var(--sys-muted-foreground)]">
            {filled.length} منتجاً معدود · <span className="text-[var(--sys-warning)]">{blanks} بلا كميّة</span> —
            المتروكُ فارغاً ليس صفراً، وهو خارج العدّ. اكتب صفراً صريحاً لما عدَدتَه ولم تجد منه شيئاً.
          </p>
        )}

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="button" onClick={() => { void submit(); }} disabled={!ready} loading={busy}>
            سجّل العدّ
          </Button>
        </div>
      </div>
    </Modal>
  );
}
