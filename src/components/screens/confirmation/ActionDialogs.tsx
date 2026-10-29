'use client';

import React, { useState } from 'react';
import { PICKABLE_REJECTION_REASONS, REJECTION_REASON_AR } from '@/lib/confirmation-workflow';
import { CHANGE_INTENTS, INTENT_AR, refusalFor, type ChangeIntent } from '@/lib/change-request-intent';
import { CHANGEABLE_FIELDS, CHANGE_FIELD_AR } from '@/lib/change-request-fields';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useProducts } from '@/hooks/useProducts';
import { useRegions } from '@/hooks/useRegions';
import { Modal } from '@/components/ui/Modal';
import { POSTPONE_REASONS } from '@/lib/postpone-reasons';

/**
 * Dialogs for the confirmation screen: a date picker for postponing, and
 * real dropdowns for issue and change-request reasons. Nothing here is typed
 * free-hand unless the reason itself is "other".
 */

const FIELD_CLS =
  'w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]';

function Buttons({
  onCancel,
  busy,
  disabled,
  submitLabel,
}: {
  onCancel: () => void;
  busy?: boolean;
  /** Not ready — as opposed to `busy`, which is «جارٍ الحفظ…». */
  disabled?: boolean;
  submitLabel: string;
}) {
  return (
    <div className="flex gap-2 pt-2">
      <button
        type="submit"
        disabled={busy || disabled}
        className="px-4 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-60"
      >
        {busy ? 'جارٍ الحفظ…' : submitLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]"
      >
        إلغاء
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">{label}</span>
      {children}
    </label>
  );
}

export { POSTPONE_REASONS };

const PREFERRED_TIMES = ['صباحاً (9-12)', 'ظهراً (12-3)', 'عصراً (3-6)', 'مساءً (6-9)'] as const;

export interface PostponeValue {
  date: string;
  preferredTime: string;
  reason: string;
  note: string;
}

export function PostponeDialog({
  open,
  orderNumber,
  postponeCount,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  orderNumber: string;
  postponeCount: number;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: PostponeValue) => void;
}) {
  // Computed once on mount: reading the clock during render is impure.
  const [value, setValue] = useState<PostponeValue>(() => ({
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    preferredTime: PREFERRED_TIMES[0],
    reason: 'POSTPONED',
    note: '',
  }));
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  return (
    <Modal isOpen={open} onClose={onClose} title="تأجيل الطلب" subtitle={orderNumber} maxWidth="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="space-y-3"
      >
        {postponeCount > 0 && (
          <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2">
            هذا الطلب مؤجل {postponeCount} مرة سابقاً.
          </p>
        )}
        <Field label="تاريخ المعاودة">
          <input
            type="date"
            required
            min={today}
            value={value.date}
            onChange={(e) => setValue({ ...value, date: e.target.value })}
            className={FIELD_CLS}
            dir="ltr"
          />
        </Field>
        <Field label="الوقت المفضّل للعميل">
          <select
            value={value.preferredTime}
            onChange={(e) => setValue({ ...value, preferredTime: e.target.value })}
            className={FIELD_CLS}
          >
            {PREFERRED_TIMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="السبب">
          <select
            value={value.reason}
            onChange={(e) => setValue({ ...value, reason: e.target.value })}
            className={FIELD_CLS}
          >
            {POSTPONE_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ملاحظة (اختياري)">
          <input
            value={value.note}
            onChange={(e) => setValue({ ...value, note: e.target.value })}
            className={FIELD_CLS}
            placeholder="مثال: العميل مسافر حتى الأحد"
          />
        </Field>
        <Buttons onCancel={onClose} busy={busy} submitLabel="تأجيل" />
      </form>
    </Modal>
  );
}

export const ISSUE_REASONS = [
  { value: 'WRONG_PHONE', label: 'رقم الهاتف خاطئ' },
  { value: 'WRONG_ADDRESS', label: 'العنوان خاطئ أو ناقص' },
  { value: 'WRONG_PRODUCT', label: 'المنتج خاطئ' },
  { value: 'MISSING_DATA', label: 'بيانات ناقصة' },
  { value: 'DUPLICATE', label: 'طلب مكرر' },
  { value: 'OTHER', label: 'سبب آخر' },
] as const;

export function IssueDialog({
  open,
  orderNumber,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  orderNumber: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: { reason: string; note: string }) => void;
}) {
  const [reason, setReason] = useState<string>('MISSING_DATA');
  const [note, setNote] = useState('');
  const noteRequired = reason === 'OTHER';

  return (
    <Modal isOpen={open} onClose={onClose} title="إشكال في بيانات الإدخال" subtitle={orderNumber} maxWidth="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ reason, note });
        }}
        className="space-y-3"
      >
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          يعود الطلب إلى الطابور بتاريخه الأصلي، ولا يُحتسب إلغاءً عليك.
        </p>
        <Field label="نوع الإشكال">
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD_CLS}>
            {ISSUE_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={noteRequired ? 'التفاصيل (إلزامية)' : 'تفاصيل (اختياري)'}>
          <textarea
            required={noteRequired}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
            placeholder="مثال: رقم الهاتف 8 أرقام فقط"
          />
        </Field>
        <Buttons onCancel={onClose} busy={busy} submitLabel="فتح الإشكال" />
      </form>
    </Modal>
  );
}

/**
 * DERIVED, NOT COPIED — AND NOW NOTHING IS WITHHELD.
 *
 * This was a fourth hand-written copy of the changeable fields, and the
 * copies had already drifted once — four of the ten reached the person
 * deciding under their English code names.
 *
 * Two were then held back for reasons that have both gone: the product had
 * no picker to choose it with, and `ProductPicker` now exists; the offer had
 * no way to be applied, and it has left the list rather than sit in a menu
 * promising something the apply path would refuse.
 *
 * So the list is the list. Adding a field to `CHANGEABLE_FIELDS` offers it
 * here, and a guard refuses one the apply path cannot carry out — which is
 * what kept the city, and then the offer, in this menu for months.
 */
export const CHANGE_FIELDS = CHANGEABLE_FIELDS.map((value) => ({
  value,
  label: CHANGE_FIELD_AR[value],
}));

export interface ChangeRequestValue {
  intent: ChangeIntent;
  /** EDIT only. */
  field: string;
  to: string;
  /** POSTPONE only — yyyy-mm-dd. */
  postponeDate: string;
  /** CANCEL only — one of the structured reasons. */
  cancelReason: string;
  reason: string;
}

/**
 * THREE DOORS, NOT ONE.
 *
 * What the customer says on the phone after the order is confirmed is one
 * of three things: change something, cancel it, or not this week. The agent
 * had a door for the first and, once she had pressed «تأكيد», none at all
 * for the other two — her «ألغِ» and «تأجيل» buttons live on the queue
 * screen and are gone by then.
 *
 * So the three are chosen first, because they are three different
 * conversations and asking «which field?» of somebody cancelling an order
 * is the wrong first question. Each shows only what it needs, and the
 * reason — the sentence the decider actually reads — is common to all.
 *
 * WHAT IS IMPOSSIBLE IS NOT OFFERED. A parcel already with the courier
 * cannot be postponed: there is nothing left to hold back. `refusalFor`
 * says so — the same function the route refuses with, so the door and the
 * answer can never disagree — and the button is disabled with its sentence
 * beside it rather than failing two hours later in somebody's queue.
 */
export function ChangeRequestDialog({
  open,
  orderNumber,
  busy,
  handedToCourier = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  orderNumber: string;
  busy?: boolean;
  /**
   * The courier has taken the parcel («إغلاق الشحنة — سُلّمت للشركة» was
   * pressed) — what that rules out is shown, not hidden. A printed waybill is
   * NOT this: until the press, cancelling and postponing are still ours.
   */
  handedToCourier?: boolean;
  onClose: () => void;
  onSubmit: (value: ChangeRequestValue) => void;
}) {
  const [intent, setIntent] = useState<ChangeIntent>('EDIT');
  const [field, setField] = useState<string>(CHANGE_FIELDS[0].value);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState<string>(PICKABLE_REJECTION_REASONS[0]);
  const [postponeDate, setPostponeDate] = useState(() =>
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const numeric = field === 'quantity' || field === 'discountAmount' || field === 'sellingPrice';
  /**
   * THE CATALOGUE, FOR THE OTHER FIELD THAT IS A CHOICE.
   *
   * «منتج آخر اختاره وكميته وسعره». A typed product name is the city's
   * bug again — the order takes an id — and a plain dropdown over a
   * hundred products on a phone is what the seller reported twice. One
   * hook, one fetch, the whole catalogue: see hooks/useProducts.
   */
  const { products, loading: productsLoading } = useProducts();
  const blockedPostpone = refusalFor('POSTPONE', { handedToCourier });
  /**
   * THE GOVERNORATES, FOR THE ONE FIELD THAT IS A CHOICE.
   *
   * «لازم تعطيه يختار المحافظات» — and it must be, because the delivery
   * fee is keyed on the region: a typed name is a request nobody can
   * carry out, which is how the city came to be refused with «عدّلها
   * يدوياً» every time.
   */
  const { regions, loading: regionsLoading } = useRegions();

  return (
    <Modal isOpen={open} onClose={onClose} title="طلب على طلب مؤكد" subtitle={orderNumber} maxWidth="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ intent, field, to, postponeDate, cancelReason, reason });
        }}
        className="space-y-3"
      >
        {/* WHAT YOU ARE ASKING FOR — first, because it decides the rest. */}
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--sys-surface-strong)] p-0.5">
          {CHANGE_INTENTS.map((k) => {
            const blocked = refusalFor(k, { handedToCourier });
            return (
              <button
                key={k}
                type="button"
                disabled={!!blocked}
                title={blocked ?? undefined}
                onClick={() => setIntent(k)}
                className={`min-h-11 md:min-h-9 rounded-md px-2 text-xs font-semibold transition disabled:opacity-40 ${
                  intent === k
                    ? 'bg-[var(--sys-card)] text-[var(--sys-primary)] shadow-raised'
                    : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
                }`}
              >
                {INTENT_AR[k]}
              </button>
            );
          })}
        </div>

        {handedToCourier && intent !== 'POSTPONE' && (
          <p className="text-xs text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/30 rounded-lg p-2">
            الطرد عند شركة الشحن — يُنفَّذ برسالةٍ إليهم بعد الموافقة، لا بتعديلٍ عندنا.
          </p>
        )}
        {blockedPostpone && (
          <p className="text-xs text-[var(--sys-muted-foreground)]">{blockedPostpone}</p>
        )}

        <p className="text-xs text-[var(--sys-muted-foreground)]">
          الطلب المؤكد للقراءة فقط. يراجع المشرف الطلب، ويتوقف تقدّم الطلب حتى صدور القرار.
        </p>

        {intent === 'EDIT' && (
          <>
            <Field label="الحقل المطلوب تعديله">
              <select value={field} onChange={(e) => setField(e.target.value)} className={FIELD_CLS}>
                {CHANGE_FIELDS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="القيمة الجديدة">
              {field === 'productId' ? (
                <ProductPicker
                  products={products}
                  value={to}
                  onChange={setTo}
                  disabled={productsLoading}
                  placeholder={productsLoading ? 'جارٍ تحميل المنتجات…' : 'ابحث بالاسم أو الرمز…'}
                />
              ) : field === 'regionId' ? (
                <select
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={FIELD_CLS}
                  disabled={regionsLoading}
                >
                  <option value="">{regionsLoading ? 'جارٍ التحميل…' : '— اختر المحافظة —'}</option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  required
                  type={numeric ? 'number' : 'text'}
                  min={numeric ? 0 : undefined}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={FIELD_CLS}
                  dir={field === 'customerPhone' || field === 'customerAltPhone' || numeric ? 'ltr' : undefined}
                />
              )}
            </Field>
            {/* Changing how many changes what is owed. Said here, because
                the person asking is on the phone with the customer and the
                amount is the next thing they will be asked — and said with
                the BASIS, because «يعيد الحساب» on its own does not tell her
                whether the piece price holds. It does: the stored total is
                divided by the quantity it was priced for and multiplied by
                the new one. The free piece, if there is one, stays free. */}
            {field === 'quantity' && (
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                يعيد حساب المبلغ بسعر القطعة الحالي — مثال: 3 قطع بـ 36 تصير 5 قطع
                بـ 60. القطعة المجانية تبقى مجانية.
              </p>
            )}
            {/* THE PRICE IS THE LINE'S TOTAL, NOT THE PRICE OF ONE UNIT —
                the order stores it that way. Saying it here is the whole
                difference between «سعر القطعة ستّون» and a discount nobody
                asked for, and the person asking is on the phone. */}
            {field === 'sellingPrice' && (
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                هذا سعر السطر كاملاً للكمية الحالية، لا سعر القطعة — ويعيد حساب المبلغ
                المطلوب عند التسليم وينعكس على الفاتورة.
              </p>
            )}
            {/* A different product is a different price. Said before the
                request is sent, because the approval applies both. */}
            {field === 'productId' && (
              <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                تغيير المنتج لا يغيّر السعر — إن كان سعر الجديد مختلفاً، ارفع طلباً آخر
                على السعر بعد الموافقة.
              </p>
            )}
          </>
        )}

        {intent === 'CANCEL' && (
          <Field label="سبب الإلغاء">
            {/* The taxonomy, picked by the person who heard it. The decider
                reads her sentence below; they should not also have to guess
                which of the eight she meant — the reports count this one. */}
            <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className={FIELD_CLS}>
              {PICKABLE_REJECTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REJECTION_REASON_AR[r] ?? r}
                </option>
              ))}
            </select>
          </Field>
        )}

        {intent === 'POSTPONE' && (
          <Field label="يُؤجَّل حتى">
            <input
              type="date"
              required
              min={today}
              value={postponeDate}
              onChange={(e) => setPostponeDate(e.target.value)}
              className={FIELD_CLS}
              dir="ltr"
            />
          </Field>
        )}

        <Field label={intent === 'EDIT' ? 'سبب التعديل' : 'ما قاله العميل'}>
          <textarea
            required
            minLength={5}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm focus:outline-none focus:border-[var(--sys-primary)]"
            placeholder={
              intent === 'EDIT'
                ? 'مثال: العميل أعطى عنواناً جديداً عند الاتصال'
                : intent === 'CANCEL'
                  ? 'مثال: العميل اشترى المنتج من مكان آخر'
                  : 'مثال: العميل مسافر ويعود يوم الأحد'
            }
          />
        </Field>
        {/* `required` cannot guard the picker — it is not an input — so the
            one rule covers all three: an EDIT with no new value is not a
            request, it is an empty queue entry somebody has to chase. */}
        <Buttons
          onCancel={onClose}
          busy={busy}
          disabled={intent === 'EDIT' && !to.trim()}
          submitLabel="إرسال الطلب"
        />
      </form>
    </Modal>
  );
}

/**
 * The customer said no.
 *
 * Reasons are a fixed list, not free text, because "ألغى" in a hundred rows
 * tells nobody anything while "السعر مرتفع" repeated forty times is a price
 * decision waiting to be made.
 *
 * AND THE LIST IS NOT COPIED HERE ANY MORE. This was the THIRD copy of it —
 * the workflow held ten codes, `ConfirmationActions` held eight, and this
 * held eight in a different order with different words for two of them. The
 * comment above it said «the same one the server accepts», and it had already
 * stopped being that. A reason the server stores and no screen can spell
 * renders to an Arabic reader as a raw English constant.
 */
export const REJECT_REASONS = PICKABLE_REJECTION_REASONS.map((value) => ({
  value,
  label: REJECTION_REASON_AR[value] ?? value,
}));

export function RejectDialog({
  open,
  orderNumber,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  orderNumber: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (value: { rejectionReason: string; note: string }) => void;
}) {
  const [rejectionReason, setReason] = useState<string>('CUSTOMER_CHANGED_MIND');
  const [note, setNote] = useState('');
  // The server demands a note of its own for OTHER; asking here saves a
  // round trip that ends in a red error.
  const noteRequired = rejectionReason === 'OTHER';

  return (
    <Modal isOpen={open} onClose={onClose} title="إلغاء الطلب" subtitle={orderNumber} maxWidth="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ rejectionReason, note });
        }}
        className="space-y-3"
      >
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          يُغلق الطلب ويعود المحجوز من بضاعته إلى المخزون. القرار يُسجَّل باسمك.
        </p>
        <Field label="السبب">
          <select value={rejectionReason} onChange={(e) => setReason(e.target.value)} className={FIELD_CLS}>
            {REJECT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={noteRequired ? 'التفاصيل (إلزامية)' : 'تفاصيل (اختياري)'}>
          <textarea
            required={noteRequired}
            minLength={noteRequired ? 5 : undefined}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            className={FIELD_CLS}
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-[var(--sys-destructive)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-60"
          >
            ألغِ الطلب
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]"
          >
            تراجع
          </button>
        </div>
      </form>
    </Modal>
  );
}
