'use client';

import React, { useState, useEffect } from 'react';
import { onTheWire, typedFigure } from '@/lib/typed-box';
import { toLatinDigits } from '@/lib/latin-digits';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { useApp } from '@/context/AppContext';
import { apiFetch } from '@/lib/api-client';
import { useRegions } from '@/hooks/useRegions';
import { useProducts } from '@/hooks/useProducts';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { RiCheckboxCircleLine, RiClipboardLine, RiErrorWarningLine, RiMagicLine, RiSparkling2Line } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { useToast } from '@/components/ui/Toast';

/**
 * WHAT A BOX PUTS ON THE WIRE: ITS CHARACTERS, OR NOTHING AT ALL.
 *
 * The reader `CourierFees.tsx` got in `17cbe93` and `ManufacturingScreen.tsx`
 * in `509306a`. Both boxes on this form were the defect it names:
 *
 *   · `setFinalPrice(parseFloat(e.target.value) || 0)` — `parseFloat('')` is
 *     `NaN` and `||` makes it `0`. And the door this form posts to reads
 *     `p.finalPrice || product.basePrice`, so A CLEARED PRICE BOX SILENTLY
 *     CHARGED THE PRODUCT'S BASE PRICE. Not a wrong number anybody could
 *     see: the modal said one thing, the order said another.
 *   · `quantity: parseInt(…, 10) || 1` — a cleared quantity became 1, and
 *     the component wrote that 1 back into the box, so clearing «2» and
 *     typing «3» produced «13».
 *
 * `undefined` is the answer for an empty box, and `JSON.stringify` drops an
 * `undefined` property — so the field is ABSENT on the wire. Both are
 * REQUIRED at the door (`confirmSchema`: `quantity` and `finalPrice` are
 * `z.coerce.number()` with no `.optional()` and no `.default()`), over
 * columns that have no default either: `OrderItem.quantity` is `Int NOT
 * NULL` and `OrderItem.unitPrice` is `Decimal(12,2) NOT NULL`. «Nothing» is
 * not a value either column can hold, so absence is a 400 — which is what
 * an unfilled box deserves and what a silent fallback could never be.
 *
 * AND IT IS THE CHARACTERS. `''` must never be sent: `z.coerce.number()` is
 * `Number()`, and `Number('')` is `0` — the free line again, one layer down.
 */

/** The figure a box holds, for this screen's own echo of it. Never an invented 0. */

/**
 * A SERVER FIGURE FOR A BOX TO OPEN ON, or an empty box — never a `0`.
 *
 * `setFinalPrice(data.suggestedPrice ?? data.parsed.price ?? 0)` ended in an
 * invented zero, and the parser returns `price: null` whenever the message
 * named no price at all. So a message with no price opened the box at `0`,
 * and `0` is exactly what the door reads as «absent» and replaces with the
 * base price. The box is empty instead, and the door says so.
 */
function boxFor(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

interface OfferPrice {
  quantity: number;
  price: number;
  name: string;
}

interface AiOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParseResult {
  parsed: {
    customerName: string;
    phone: string;
    governorate: string;
    address: string;
    productQuery: string;
    quantity: number;
    price: number | null;
    notes: string;
    source: string;
  };
  engine: string;
  matchedProduct: { id: string; name: string; score: number } | null;
  productMatchConfident: boolean;
  suggestedPrice: number | null;
  suggestedOfferName: string | null;
  /** The box holds the offer's price for exactly this quantity (RV151). */
  priceFromOffer?: boolean;
  /** What the customer's message named, when the offer's price was put in its place. */
  typedPrice?: number | null;
  /** The matched product's bundles: quantity → the price the order is written at. */
  offerPrices?: OfferPrice[];
  // What the preview may say depends on the reader's customers key: the name and count, the name alone, or only that the number is known.
  existingCustomer: { exists: true; fullName?: string; totalOrders?: number; city?: string } | null;
  /**
   * WHY THE MODEL DID NOT READ THE TEXT, WHEN IT DID NOT.
   *
   * `null` means it did. The one the seller can act on is `'NOT_LOCAL'`:
   * the extractor refuses any model that is not on the owner's own machine,
   * because the pasted text carries the customer's name, phone and address.
   */
  aiSkipped?: 'NO_PERMISSION' | 'NOT_LOCAL' | 'NOT_CONFIGURED' | 'FAILED' | null;
}

export function AiOrderModal({ isOpen, onClose, onSuccess }: AiOrderModalProps) {
  const { t } = useApp();
  const toast = useToast();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ParseResult | null>(null);
  // Governorates of the selected country (never a hard-coded country list),
  // and the store's own currency — the price box used to be labelled «($)»
  // on every store in the world.
  const { regions, countryName, currency } = useRegions();
  const regionNames = regions.map((r) => r.name);

  // Editable confirmed fields
  const [productId, setProductId] = useState('');
  const { products } = useProducts({ enabled: isOpen });
  /*
   * THE TWO BOXES HOLD CHARACTERS, AND THEY OPEN EMPTY.
   *
   * `useState(0)` was a price of zero in a browser before the parser had
   * seen the message — and `0` is the one value the door turns into the
   * product's base price. The quantity now has state of its own rather than
   * being written back into `result.parsed`, so an empty box stays empty
   * instead of being repaired to `1`.
   */
  const [priceTyped, setPriceTyped] = useState('');
  const [quantityTyped, setQuantityTyped] = useState('');
  /*
   * THE BUNDLES OF THE PRODUCT IN THE BOX, AND WHOSE THEY ARE.
   *
   * Through this door the order is written at the offer's price for its
   * quantity (the owner's ruling, RV151), so the box follows the quantity
   * and is locked while an offer covers it. Known for the product the parse
   * matched; a product changed by hand is priced by the door, which answers
   * with the offer's price and the box takes it from there.
   */
  const [offers, setOffers] = useState<{ productId: string; list: OfferPrice[] }>({ productId: '', list: [] });
  /** Read only to SAY what the total covers — never to divide anything by. */
  const quantityFigure = typedFigure(quantityTyped);

  // Reset ALL form state whenever the modal opens — no stale AI parse result
  // or previous text should persist between opens
  useEffect(() => {
    if (isOpen) {
      setText('');
      setParsing(false);
      setSaving(false);
      setResult(null);
      setProductId('');
      setPriceTyped('');
      setQuantityTyped('');
      setOffers({ productId: '', list: [] });
    }
  }, [isOpen]);

  const handlePaste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip);
    } catch {
      // clipboard permission denied; user can paste manually
    }
  };

  const handleParse = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/orders/ai-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تحليل الطلب');
      setResult(data);
      if (data.matchedProduct) setProductId(data.matchedProduct.id);
      setOffers({ productId: data.matchedProduct?.id ?? '', list: data.offerPrices ?? [] });
      // The server's suggestion, or the price the message itself named, or an
      // EMPTY BOX. The old `?? 0` made «the message named no price» and «the
      // customer pays nothing» the same opening state.
      // Priced by an offer, the box SHOWS the offer's price (see `shownPrice`) and
      // holds nothing of its own: a quantity no offer covers then opens it empty,
      // rather than on one bundle's price or the customer's figure for another count.
      setPriceTyped(data.priceFromOffer ? '' : boxFor(data.suggestedPrice ?? data.parsed.price));
      setQuantityTyped(boxFor(data.parsed.quantity));
    } catch (err: any) {
      toast.failed(err.message);
    } finally {
      setParsing(false);
    }
  };

  const handleConfirm = async () => {
    if (!result) return;
    // The parser matches what it can. When it matched nothing, say so in one
    // sentence instead of letting the route answer with a schema error about
    // a box the screen had drawn as filled in.
    if (!productId) {
      toast.failed('اختر المنتج — لم يُطابق النص أيّ منتج في الكتالوج');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/orders/ai-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          parsed: {
            ...result.parsed,
            productId,
            /*
             * THE CHARACTERS, OR THE FIELD IS NOT THERE — and these two keys
             * come AFTER the spread deliberately. `result.parsed.quantity`
             * is a number the parser produced; what the reviewer has in
             * front of them is this box, so the box wins. An explicit
             * `undefined` after a spread removes the key from the JSON,
             * which is how «I did not fill this in» reaches the door at all.
             */
            quantity: onTheWire(quantityTyped),
            finalPrice: onTheWire(shownPrice),
            // Kept in the order's history, never charged.
            typedPrice: result.typedPrice ?? undefined,
          },
        }),
      });
      const data = await res.json();
      /*
       * THE DOOR PRICED IT FROM THE OFFER. The box takes the offer's price
       * and locks, and the reviewer presses again with the figure in front
       * of them — nothing is saved at a number the button did not show.
       */
      if (res.status === 409 && data.code === 'OFFER_PRICE' && typeof data.offerPrice === 'number') {
        const q = typedFigure(quantityTyped);
        if (q !== undefined) {
          const bundle = { quantity: q, price: data.offerPrice, name: String(data.offerName ?? '') };
          setOffers((o) => ({
            productId,
            list: [...(o.productId === productId ? o.list : []).filter((x) => x.quantity !== q), bundle],
          }));
        }
        toast.warn(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'فشل حفظ الطلب');
      /*
       * THE SAME NOTICE THE OTHER ENTRY WINDOW SHOWS. Pasting a message in
       * is entering an order exactly as much as typing one, so the agent
       * learns the same fact the same way: the cap took it to the queue.
       */
      if (data.notice) toast.warn(data.notice);
      onSuccess();
      onClose();
      setText('');
      setResult(null);
    } catch (err: any) {
      toast.failed(err.message);
    } finally {
      setSaving(false);
    }
  };

  const p = result?.parsed;
  /** The bundle that prices this product at this quantity, when there is one: the box is its price and is locked. */
  const offerNow =
    offers.productId && offers.productId === productId && quantityFigure !== undefined
      ? offers.list.find((o) => o.quantity === quantityFigure)
      : undefined;
  /*
   * WHAT THE BOX SHOWS, AND WHAT IS SENT: the offer's price while one covers
   * this quantity, otherwise what the reviewer has. Derived, never written
   * into the reviewer's own value — so typing «10» does not leave the
   * one-piece bundle's price behind after passing through «1».
   */
  const shownPrice = offerNow ? boxFor(offerNow.price) : priceTyped;
  /** The price this screen prints on its own button — never a figure it invented. */
  const priceFigure = typedFigure(shownPrice);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="إدخال طلب بالذكاء الاصطناعي"
      subtitle="الصق رسالة الطلب كما هي (واتساب / فيسبوك / الشيت) والموقع يسجلها تلقائياً"
      maxWidth="2xl"
    >
      <div className="space-y-5">

        {/* Step 1: Paste text */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-[var(--sys-foreground)]">
              1. الصق نص الطلب
            </label>
            <Button size="sm" variant="outline" onClick={handlePaste} className="text-xs">
              <RiClipboardLine className="w-4 h-4 ml-1 rtl:ml-0 rtl:mr-1" />
              لصق من الحافظة
            </Button>
          </div>
          <Textarea
            rows={7}
            dir="rtl"
            placeholder={`الاسم: عبدالله عبدالقادر عبدالعال
الرقم: 0936654998
اسم المحافظة: سووريا
العنوان: بانياس المدينة
الطلب ( المنتج ): كريم علاج فطريات الأظافر
الكمية: 1
السعر: 20$
الملاحظات: -
اسم الصفحة: الشيت`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono text-xs leading-relaxed"
          />
          <div className="flex justify-end mt-3">
            <Button onClick={handleParse} loading={parsing}>
              <RiMagicLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
              تحليل الطلب بالذكاء الاصطناعي
            </Button>
          </div>
        </div>

        {/* Step 2: Parsed preview (editable) */}
        {result && p && (
          <div className="border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)]/40 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--sys-destructive-border)] pb-2">
              <h4 className="text-xs font-bold text-[var(--sys-destructive)] flex items-center space-x-2 rtl:space-x-reverse">
                <RiCheckboxCircleLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                <span>2. تأكيد البيانات المستخرجة (قابلة للتعديل)</span>
              </h4>
              <span className="text-xs font-mono text-[var(--sys-muted)] bg-[var(--sys-card)] px-2 py-0.5 rounded-lg border">
                {result.engine === 'ai' ? 'AI محلي' : 'Smart Parser'}
              </span>
            </div>

            {/*
              THE REFUSAL, SAID WHERE THE SELLER IS LOOKING.
              Without it the extractor just «stops being clever» one day and
              nobody knows why. Built like the duplicate-customer note above
              it so the two read as one kind of message.
            */}
            {/*
              WITHOUT THE ASSISTANTS' KEY the model was never asked — said here, where the seller is looking, so the plain
              reading is not mistaken for a broken one. The order is entered all the same.
            */}
            {result.aiSkipped === 'NO_PERMISSION' && (
              <div className="p-2.5 bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 text-[var(--sys-warning)] text-xs rounded-lg">
                <RiErrorWarningLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
                حسابك ما عنده مفتاح «المساعدون الأذكياء»، فقُرئ النص بالقواعد. تقدر تعدّل الحقول وتحفظ الطلب عادي.
              </div>
            )}
            {result.aiSkipped === 'NOT_LOCAL' && (
              <div className="p-2.5 bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 text-[var(--sys-warning)] text-xs rounded-lg">
                <RiErrorWarningLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
                مستخرج الطلبات بالذكاء يعمل على نموذج محلي فقط حمايةً لبيانات الزبون، فقُرئ النص بالقواعد.
                لتشغيله: إعدادات الذكاء ← المساعدون ← مستخرج الطلبات ← نموذج على خادمك.
              </div>
            )}

            {/*
              THE CUSTOMER NAMED ANOTHER PRICE. It was the figure the box opened
              on, and one keystroke made it the charge; the offer's price is
              written now, and the customer's figure is said here — where the
              reviewer is about to call them — and kept in the order's history.
            */}
            {result.typedPrice != null && (
              <div className="p-2.5 bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 text-[var(--sys-warning)] text-xs rounded-lg">
                <RiErrorWarningLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
                الزبون كتب سعراً <strong>{result.typedPrice}</strong>
                {/* The offer as it stands NOW — the quantity or the product may have changed since the parse. */}
                {offerNow ? (
                  <>، ويُسجَّل الطلب بسعر العرض «{offerNow.name}» <strong>{offerNow.price}</strong> — راجعه معه عند التأكيد.</>
                ) : (
                  <> في رسالته.</>
                )}
              </div>
            )}

            {result.existingCustomer && (
              <div className="p-2.5 bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 text-[var(--sys-warning)] text-xs rounded-lg">
                <RiErrorWarningLine className="me-1 inline-block h-4 w-4 align-text-bottom" aria-hidden />
                {result.existingCustomer.fullName ? (
                  <>
                    هذا الرقم مسجل مسبقاً لعميل: <strong>{result.existingCustomer.fullName}</strong>
                    {typeof result.existingCustomer.totalOrders === 'number' && ` (${result.existingCustomer.totalOrders} طلب سابق)`}
                    {' '}— سيتم ربط الطلب بنفس الملف.
                  </>
                ) : (
                  <>رقم معروف — سيُربط الطلب بنفس الملف.</>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="الاسم" value={p.customerName} onChange={(e) => setResult({ ...result, parsed: { ...p, customerName: e.target.value } })} />
              {/* Arabic-Indic digits typed here become Latin as they are typed: the number is read by a dialler, a blacklist and a
                  duplicate check, none of which should have to guess which script it was written in (22/10: «حولها برمجيا»). */}
              <Input label="الرقم" value={p.phone} onChange={(e) => setResult({ ...result, parsed: { ...p, phone: toLatinDigits(e.target.value) } })} />
              <Select
              label={`المحافظة${countryName ? ` — ${countryName}` : ''}`}
              value={regionNames.includes(p.governorate) ? p.governorate : ''}
              onChange={(e) =>
                setResult({ ...result, parsed: { ...p, governorate: e.target.value } })
              }
            >
              <option value="">اختر المحافظة</option>
              {regionNames.map((gov) => (
                <option key={gov} value={gov}>
                  {gov}
                </option>
              ))}
            </Select>
            {p.governorate && !regionNames.includes(p.governorate) && (
              <p className="text-xs text-[var(--sys-warning)]">
                «{p.governorate}» ليست من محافظات {countryName ?? 'البلد الحالي'} — اختر المحافظة الصحيحة.
              </p>
            )}
            <Input label="العنوان" value={p.address} onChange={(e) => setResult({ ...result, parsed: { ...p, address: e.target.value } })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/*
                A HUNDRED AND FOURTEEN PRODUCTS, AND THE ONE THE MESSAGE MEANT.

                This was a native `<select>` over the whole catalogue with no
                search — the same fault already fixed on the new-order form and
                the return, both of which come through `ProductPicker`. Worse
                here: it had NO empty row, so when the parser matched nothing
                and `productId` stayed `''` the browser drew the FIRST product
                as though it were chosen. Accepting what the screen showed sent
                an empty productId, which the route's schema refuses
                (`z.string().min(10)`) — a 400 about a field that looked filled
                in.

                «— اختر منتجًا —» is that empty row, so the box now says what
                it holds.
              */}
              <div>
                <label className="block text-xs font-medium text-[var(--sys-foreground)] mb-1.5">
                  المنتج (تم مطابقته تلقائياً)
                </label>
                <ProductPicker
                  products={products}
                  value={productId}
                  anyOption={{ value: '', label: '— اختر منتجًا —' }}
                  placeholder="ابحث عن منتج…"
                  onChange={(id) => {
                    setProductId(id);
                    /*
                     * CHANGING THE PRODUCT NO LONGER FILLS IN A PRICE.
                     *
                     * This read `prod.offers[0].sellingPrice`, and that is
                     * the figure BEFORE the reduction: `/api/products`
                     * selects `id, name, quantity, sellingPrice, status`
                     * and NOT `discount`, so the number is not merely
                     * stale — it cannot be made right from what this
                     * screen is given. An offer of 25 with a discount of 3
                     * put 25 in the box, and the landing page, the cart
                     * quote and this door's own suggestion all charge 22.
                     *
                     * That is the defect `ai-intake-discount.test.ts`
                     * exists for, surviving on a second path: the fix
                     * there made the PREVIEW hand over the net figure, and
                     * this line reaches a different endpoint for a raw
                     * column.
                     *
                     * It also took `offers[0]` — the first row, whatever
                     * its `status` and whether or not it is the default.
                     *
                     * An empty box is the honest answer. A reviewer who
                     * changes the product is telling us the parse was
                     * wrong about WHAT is being sold, so the price it
                     * suggested is wrong too, and inventing a replacement
                     * from a column we cannot price is how 25 gets
                     * confirmed for a 22 bundle. The door refuses an
                     * absent price by name, so nothing is written blind.
                     */
                    setPriceTyped('');
                    setOffers({ productId: id, list: [] });
                  }}
                />
              </div>

              <Input
                label="الكمية"
                name="quantity"
                type="number"
                min="1"
                value={quantityTyped}
                // A quantity an offer covers shows that offer's price (`shownPrice`); nothing is written here.
                onChange={(e) => setQuantityTyped(e.target.value)}
              />

              {/*
                «السعر» BESIDE «الكمية» IS A QUESTION WITH TWO ANSWERS.

                The door reads this field as the LINE TOTAL — `computeCod`
                is handed `unitPrice: price / qty`, and `offers.ts` says of
                the figure that pre-fills it that «25 is the bundle's total,
                never a unit price». But the box said only «السعر», sat next
                to a quantity of 2, and was filled from sources that do not
                agree about units: the offer's bundle total, and whatever
                number the parser lifted out of «السعر: 20» in a pasted
                message, where the sender's own meaning is unknown.

                So a reviewer handling «الكمية: ٢ · السعر: ٢٠» confirms 20
                and records an order of 20 — when 20 each was just as likely
                to be what was meant.

                THE FIX IS A SENTENCE, NOT A SECOND NUMBER. A «÷ quantity»
                echo was the obvious move and is the wrong one:
                `the-frontend-invariants.test.ts` already measures that
                exact shape in `OrderLinesCard` — a browser dividing without
                the server's rounding reads 50.01 off a line the server
                wrote as 50. A third derivation of a unit price is a third
                thing to disagree. The label and the hint carry the meaning;
                the number stays the server's.
              */}
              <Input
                label={`الإجمالي${currency?.code ? ` (${currency.code})` : ''}`}
                name="finalPrice"
                type="number"
                step="0.01"
                value={shownPrice}
                onChange={(e) => setPriceTyped(e.target.value)}
                disabled={!!offerNow}
                helperText={
                  offerNow
                    ? `سعر العرض «${offerNow.name}» — يُسجَّل كما هو`
                    : quantityFigure !== undefined && quantityFigure > 1
                      ? `للكمية كلّها (${quantityFigure} قطعة) — لا لقطعة واحدة`
                      : 'إجمالي ما يُحصَّل عن هذا السطر'
                }
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="المصدر / اسم الصفحة" value={p.source} onChange={(e) => setResult({ ...result, parsed: { ...p, source: e.target.value } })} />
              <Input label="الملاحظات" value={p.notes === '-' ? '' : p.notes} onChange={(e) => setResult({ ...result, parsed: { ...p, notes: e.target.value } })} />
            </div>

            {/* Match info */}
            {result.matchedProduct && (
              <div
                className={`p-2.5 rounded-lg text-xs flex items-start space-x-2 rtl:space-x-reverse ${
                  result.productMatchConfident
                    ? 'bg-[var(--sys-destructive-soft)]/70 text-[var(--sys-destructive)]'
                    : 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]'
                }`}
              >
                <RiSparkling2Line className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  تمت مطابقة «{result.parsed.productQuery}» مع: <strong>{result.matchedProduct.name}</strong>
                  {result.suggestedOfferName && <> — العرض المقترح: {result.suggestedOfferName}</>}
                  {!result.productMatchConfident && ' (تأكد من المنتج المختار)'}
                </span>
              </div>
            )}

            <div className="flex items-center justify-end space-x-3 rtl:space-x-reverse pt-3 border-t border-[var(--sys-destructive-border)]">
              <Button variant="outline" onClick={() => setResult(null)}>
                إلغاء
              </Button>
              <Button onClick={handleConfirm} loading={saving}>
                <RiCheckboxCircleLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                {/* A BUTTON THAT NAMES A PRICE MUST NAME A REAL ONE. It read
                    «تسجيل الطلب (0.00)» over an empty box, which is the
                    figure the reviewer then believed they were recording. */}
                تسجيل الطلب ({priceFigure === undefined ? '—' : <Money value={priceFigure} />})
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
