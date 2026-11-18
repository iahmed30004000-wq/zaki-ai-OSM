'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import {
  parseCategoryAttributes,
  parseProductAttributes,
  type AttributeField,
  type ProductAttributes as Answers,
} from '@/lib/product-attributes';
import { RiInformationLine } from '@remixicon/react';

/**
 * WHAT KIND OF THING THIS IS — this product's answers.
 *
 * THE QUESTIONS ARE THE CATEGORY'S, and the card says where to change them
 * rather than letting a seller add a field here. A question invented on
 * one product would be a question no filter can offer, because a filter
 * narrows a whole shelf and needs every product on it to have been asked.
 *
 * A PRODUCT WITH NO CATEGORY HAS NOTHING TO ANSWER, and the card says that
 * instead of showing an empty box. It is the likeliest state on this
 * screen and it has a fix the seller can act on in one sentence.
 *
 * Nothing is validated twice: `parseProductAttributes` is the same
 * function the server stores through and the storefront reads with, so
 * what this card keeps and what a shopper filters by are one rule.
 */

interface Category {
  id: string;
  name: string;
  attributeSchema: string | null;
}

export function ProductAttributes({ productId, canManage = true }: { productId: string; canManage?: boolean }) {
  const [fields, setFields] = useState<AttributeField[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      /*
       * ── THE PRODUCT IS INSIDE `product`, AND THIS READ THE ENVELOPE ──
       *
       * The owner, 21/10: «الخصائص مش شغالة».
       *
       * `GET /api/products/[id]` answers `{ product, currencyCode }`.
       * This read `p.category` and `p.attributes` off the envelope, so
       * both were always `undefined`: the card decided the product had no
       * category and drew «لا فئة لهذا المنتج — أسنِد له فئةً أولاً» —
       * even for a product that HAD one, with questions on it. The save
       * button sits behind that branch, so it was never rendered, and no
       * answer could be written or read back.
       *
       * Nothing else was wrong. The PATCH validates and stores the
       * answers correctly, the model has the columns, and
       * `parseCategoryAttributes` works. One misread key.
       */
      const { product: p } = await apiJson<{
        product: { attributes: string | null; category: Category | null };
      }>(`/api/products/${productId}`);
      const schema = parseCategoryAttributes(p.category?.attributeSchema ?? null);
      setCategory(p.category ?? null);
      setFields(schema);
      setAnswers(parseProductAttributes(p.attributes, schema));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر التحميل' });
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await apiJson(`/api/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ attributes: answers }),
      });
      setMsg({ ok: true, text: 'تم الحفظ' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: Answers[string] | undefined) =>
    setAnswers((a) => {
      const next = { ...a };
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete next[key];
      else next[key] = value;
      return next;
    });

  if (loading) return <p className="text-sm text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>;

  if (!category) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-[var(--sys-muted-foreground)]">
        <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
        <span>لا فئة لهذا المنتج — أسنِد له فئةً أولاً، والأسئلة تأتي منها.</span>
      </p>
    );
  }

  if (fields.length === 0) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-[var(--sys-muted-foreground)]">
        <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          فئة «{category.name}» بلا أسئلة بعد. تُكتب مرّةً واحدةً للفئة كلّها في «المتجر ›
          البحث والفلاتر».
        </span>
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        <RiInformationLine className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          أسئلة فئة «{category.name}». تُضاف وتُحذف للفئة كلّها من «المتجر › البحث والفلاتر»،
          وتُجاب هنا لكل منتج. الإجابات تصير فلاتر في المتجر.
        </span>
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((f) => {
          const value = answers[f.key];
          if (f.kind === 'text') {
            return (
              <Input
                key={f.key}
                label={f.label}
                value={typeof value === 'string' ? value : ''}
                disabled={!canManage}
                onChange={(e) => set(f.key, e.target.value)}
              />
            );
          }
          if (f.kind === 'number') {
            return (
              <Input
                key={f.key}
                label={f.unit ? `${f.label} (${f.unit})` : f.label}
                type="number"
                dir="ltr"
                value={typeof value === 'number' ? String(value) : ''}
                disabled={!canManage}
                onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            );
          }
          if (f.kind === 'select') {
            return (
              <Select
                key={f.key}
                label={f.label}
                value={typeof value === 'string' ? value : ''}
                disabled={!canManage}
                onChange={(e) => set(f.key, e.target.value || undefined)}
              >
                <option value="">— بلا إجابة —</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            );
          }
          // multi
          const picked = Array.isArray(value) ? value : [];
          return (
            <fieldset key={f.key} className="space-y-1.5">
              <legend className="mb-1.5 text-xs font-medium text-[var(--sys-heading)]">{f.label}</legend>
              <div className="flex flex-wrap gap-3">
                {f.options.map((o) => (
                  <label key={o} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--sys-primary)]"
                      checked={picked.includes(o)}
                      disabled={!canManage}
                      onChange={(e) =>
                        set(f.key, e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))
                      }
                    />
                    {o}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>

      {msg && (
        <p
          role="status"
          className={`text-sm font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}
        >
          {msg.text}
        </p>
      )}

      {canManage && (
        <Button onClick={save} disabled={busy} size="sm">
          {busy ? 'جارٍ الحفظ…' : 'حفظ الخصائص'}
        </Button>
      )}
    </div>
  );
}
