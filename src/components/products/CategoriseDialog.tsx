'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiLoader4Line } from '@remixicon/react';
import {
  CATEGORISE_BATCH,
  categoryChoices,
  choiceFor,
  suggestCategory,
  type CategoryChoice,
} from '@/lib/product-categories';

/** A product that carries no category, as the products screen holds it. `label` is the name as the screen shows it. */
export interface UnfiledProduct {
  id: string;
  label: string;
  name: string;
  nameEn?: string | null;
  sku: string;
}

/** What `POST /api/products/categorise` answers. */
export interface CategoriseResult {
  filed: number;
  skipped: number;
  created: string[];
}

/**
 * THE PRODUCTS WITH NO CATEGORY, SORTED FOR THE OWNER AND SHOWN TO HIM BEFORE ANYTHING IS WRITTEN.
 *
 * THE OWNER, 22/10, about the products that carry no category: «انتا صنف افضل». Each row here arrives with the shelf its NAME points
 * at already chosen (`lib/product-categories.ts` — a written table, no model, nothing is sent anywhere to get it), a name no rule
 * recognises arrives blank, and every row is a select he can change or empty. Nothing is written until he presses «طبّق», and what
 * he presses sends only the rows that have a shelf.
 *
 * The list of shelves each row offers is the company's own, then the suggested ones it does not have yet — marked «جديد», and named
 * in a line above the button, so it is never a surprise that pressing made a shelf. Whether a shelf of that name already exists
 * under another spelling is the door's business (it matches by the folded name), not this screen's.
 *
 * WHAT THE DOOR DOES WITH IT is in `api/products/categorise/route.ts`: a product that has been filed in the meantime is left where
 * it is, and the answer says how many it filed and how many it skipped.
 *
 * ONE PRESS FILES AT MOST `CATEGORISE_BATCH` PRODUCTS — the door's limit — and the button says so when there are more rows with a
 * shelf than that; the rest wait for the next press, because a screen that quietly sent three hundred and called it done would be
 * lying about the other hundred.
 */
export function CategoriseDialog({
  products,
  onClose,
  onDone,
}: {
  products: UnfiledProduct[];
  onClose: () => void;
  onDone: (result: CategoriseResult) => void;
}) {
  // `null` until the company's shelves have been read; `[]` when they could not be.
  const [existing, setExisting] = useState<{ name: string }[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Only what the person changed; everything else is the suggestion.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ categories: { name: string }[] }>('/api/categories');
      setExisting(d.categories);
    } catch {
      setLoadFailed(true);
      setExisting([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choices: CategoryChoice[] = useMemo(() => categoryChoices(existing ?? []), [existing]);
  const suggested = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, choiceFor(suggestCategory(p.name, p.nameEn), choices)])),
    [products, choices]
  );
  const valueOf = (id: string): string => edits[id] ?? suggested[id] ?? '';

  const picked = products.filter((p) => valueOf(p.id) !== '');
  const sending = picked.slice(0, CATEGORISE_BATCH);
  const made = [...new Set(sending.map((p) => valueOf(p.id)))].filter((name) => choices.find((c) => c.name === name)?.exists === false);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson<CategoriseResult>('/api/products/categorise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: sending.map((p) => ({ productId: p.id, category: valueOf(p.id) })) }),
      });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر التصنيف');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="ترتيب المنتجات بلا تصنيف">
      <div className="space-y-3">
        <p className="text-sm text-[var(--sys-foreground)]">
          التصنيف المقترح مأخوذ من اسم كل منتج (قواعد مكتوبة، لا ذكاء اصطناعي). غيّر ما لا يناسبك، أو اتركه بلا تصنيف. لا يُنقَل منتجٌ
          له تصنيف، وما يظهر «جديد» يُنشأ عند الضغط على «طبّق» فقط.
        </p>

        {existing === null ? (
          <p className="inline-flex items-center gap-2 text-note text-[var(--sys-muted-foreground)]">
            <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden />
            جارٍ تحميل تصنيفاتك…
          </p>
        ) : (
          <>
            {loadFailed && (
              <p className="text-note leading-relaxed text-[var(--sys-warning)]">
                تعذّر تحميل تصنيفاتك الحالية — قد يظهر «جديد» لتصنيفٍ موجود، وسيُطابَق بالاسم عند التطبيق ولن يتكرّر.
              </p>
            )}

            <ul className="max-h-80 overflow-y-auto rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
              {products.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
                  <div className="min-w-[150px] flex-1">
                    <p className="truncate text-sm text-[var(--sys-heading)]">{p.label}</p>
                    <p className="truncate text-note text-[var(--sys-muted-foreground)]">{p.sku}</p>
                  </div>
                  <select
                    aria-label={`تصنيف ${p.label}`}
                    value={valueOf(p.id)}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    className="h-11 md:h-10 min-w-[200px] flex-1 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm"
                  >
                    <option value="">بلا تصنيف</option>
                    {choices.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.exists ? c.name : `${c.name} (جديد)`}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>

            <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
              {picked.length} من {products.length} منتجاً لها تصنيف مختار، والباقي يبقى بلا تصنيف.
              {made.length > 0 && ` سيُنشأ: ${made.join('، ')}.`}
              {picked.length > sending.length && ` يُطبَّق ${sending.length} في المرّة الواحدة — الباقي بعد أن تضغط من جديد.`}
            </p>
          </>
        )}

        {error && (
          <p className="rounded-lg bg-[var(--sys-destructive-soft)] px-3 py-2 text-sm text-[var(--sys-destructive)]">{error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--sys-border)] pt-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void apply();
            }}
            disabled={existing === null || sending.length === 0 || busy}
          >
            {busy && <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'جارٍ التصنيف…' : `طبّق على ${sending.length} منتجاً`}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
    </Modal>
  );
}
