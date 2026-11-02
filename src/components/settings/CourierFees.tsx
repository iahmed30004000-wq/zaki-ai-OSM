'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { NOT_A_NUMBER, typedNumber } from '@/lib/typed-box';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { RiAlertLine, RiLoader4Line, RiMagicLine, RiSaveLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { defaultCityOf, placeNote, type CourierPlaces } from '@/lib/couriers/place-note';

/**
 * ONE COURIER'S FEES — a row per region: the fee, the late threshold in
 * days, and the courier's return fee.
 *
 * THIS WAS ITS OWN SCREEN, AND THE COURIER IT PRICED WAS A DROPDOWN AT THE
 * TOP OF IT. Two screens, each opening with a link to the other, and the
 * same question asked twice: which courier? Once by the row you tapped, and
 * again by a select that did not know you had.
 *
 * So the courier arrives as a prop and there is no select. The component
 * knows nothing about where it is shown, which is why the same fourteen
 * rows can sit in the courier's panel without the panel owning them.
 *
 * Changing an EXISTING fee asks for a written reason, which goes to the
 * audit log. Live orders keep the fee they were shipped with.
 */

interface Fee {
  id: string;
  deliveryProviderId: string;
  regionId: string;
  fee: number;
  lateThresholdDays: number;
  returnFee: number;
  /** The courier's own id for this region; null until we are told it. */
  courierCityId: number | null;
  isActive: boolean;
}

interface FeesData {
  regions: { id: string; name: string }[];
  fees: Fee[];
}

/**
 * A TYPED NUMBER, OR «NOTHING» — AND A TYPED `0` IS A NUMBER.
 *
 * Every box on this form used to be read as `Number(box) || 0`.
 * `Number('')` is `0` and `Number('abc')` is `NaN` which `||` turns into
 * `0`, so **an empty box and a typed zero left the browser as the same
 * number**: a courier whose return fee nobody knows was recorded as
 * "charges nothing", and an empty late-threshold box overwrote a real 3
 * with "never late".
 *
 * `undefined` is the third answer. `JSON.stringify` DROPS an `undefined`
 * property, so an empty box makes the field absent on the wire rather than
 * zero — and the endpoint, not this component, decides what absent means
 * (keep what is stored, or let the column's default decide). That is also
 * why there is no `3` and no `0` left in this file: the default lives in
 * `prisma/schema.prisma` and nowhere else.
 *
 * `NOT_A_NUMBER` is the fourth outcome and it is NOT silently zero either.
 * A `type="number"` box normally reports `''` for unparseable input, so
 * this is the unreachable branch — named rather than folded into «empty»,
 * because folding it into «empty» is how `|| 0` got here.
 */

export function CourierFees({
  courierId,
  /**
   * Told when a fee is written, because the list behind this panel shows
   * «٨ من ١٢ محافظة» per courier. A coverage number that stays stale while
   * the fee it counts is being edited in front of it is worse than none.
   */
  onChanged,
}: {
  courierId: string;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<FeesData | null>(null);
  const [draft, setDraft] = useState<Record<string, { fee: string; lateThresholdDays: string; returnFee: string; courierCityId: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  // The names in the courier's own list, so a typed code can say which place it is. Null = we hold no list for them.
  const [places, setPlaces] = useState<CourierPlaces | null>(null);
  // Changing an existing fee needs a written reason; this holds the request
  // until the dialog collects one, instead of a browser prompt.
  const [reasonFor, setReasonFor] = useState<{ regionId: string; regionName: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ regions: { id: string; name: string }[]; fees: Fee[] }>(
        '/api/settings/delivery-fees'
      );
      setData({ regions: res.regions, fees: res.fees });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    apiJson<{ places?: CourierPlaces | null }>(`/api/settings/delivery-fees/places?courier=${courierId}`)
      .then((res) => { if (alive) setPlaces(res.places ?? null); })
      // The hint is a courtesy: without it the box is the plain box it always was.
      .catch(() => { if (alive) setPlaces(null); });
    return () => { alive = false; };
  }, [courierId]);

  // A different courier is a different set of fees: keeping the typed
  // drafts would show one courier's unsaved numbers under another's name.
  useEffect(() => {
    setDraft({});
    setSaved(null);
  }, [courierId]);

  const feeFor = (regionId: string) =>
    data?.fees.find((f) => f.deliveryProviderId === courierId && f.regionId === regionId);

  /**
   * The row's draft, and one setter for it. A card's cells are separate
   * render functions, so this lives here — one definition read by five of
   * them, rather than five copies of the same defaults.
   *
   * AN UNPRICED REGION OPENS WITH EVERY BOX EMPTY, including the two that
   * used to open pre-filled. `String(current?.lateThresholdDays ?? 3)` put
   * the SCHEMA'S OWN DEFAULT into a browser and then saved it as though a
   * person had typed it — two copies of one number, and the browser's copy
   * was the one that reached the database. The same went for `?? 0` on the
   * return fee, which is where thirteen rows of "the courier charges us
   * nothing to return a parcel" came from.
   *
   * So the boxes are empty, and empty now MEANS something: the field is
   * left off the request and the column decides. An existing row shows what
   * is stored — including a stored `0`, which is a value, not a blank.
   */
  const draftFor = (id: string) => {
    const current = feeFor(id);
    return (
      draft[id] ?? {
        fee: current ? String(current.fee) : '',
        lateThresholdDays: current ? String(current.lateThresholdDays) : '',
        returnFee: current ? String(current.returnFee) : '',
        courierCityId: current?.courierCityId ? String(current.courierCityId) : '',
      }
    );
  };
  const setField = (id: string, patch: Partial<ReturnType<typeof draftFor>>) =>
    setDraft({ ...draft, [id]: { ...draftFor(id), ...patch } });

  /** Regions this courier has no fee row for — the ones that block orders. */
  const missing = (data?.regions ?? []).filter((r) => !feeFor(r.id));

  const save = async (regionId: string, reason?: string) => {
    const current = feeFor(regionId);
    const d = draftFor(regionId);

    // The fee itself is the one field with no "nothing" to say: a region
    // with no fee cannot be shipped to, which is what the warning above the
    // table is about. So an empty fee box is refused here rather than sent.
    const fee = typedNumber(d.fee);
    if (typeof fee !== 'number') {
      toast.failed('أجرة غير صالحة');
      return;
    }

    const lateThresholdDays = typedNumber(d.lateThresholdDays);
    if (lateThresholdDays === NOT_A_NUMBER) {
      toast.failed('حد تأخير غير صالح');
      return;
    }
    const returnFee = typedNumber(d.returnFee);
    if (returnFee === NOT_A_NUMBER) {
      toast.failed('أجرة إرجاع غير صالحة');
      return;
    }

    // The courier's own id for the region, typed from their list. Empty = leave what is stored; anything but a positive
    // whole number is refused here rather than sent, because their API would refuse the shipment later.
    const code = d.courierCityId.trim();
    const courierCityId = code === '' ? undefined : Number(code);
    if (courierCityId !== undefined && !(Number.isInteger(courierCityId) && courierCityId > 0)) {
      toast.failed('رمز الشركة غير صالح — رقم صحيح من قائمتهم');
      return;
    }

    // Changing an existing fee is an override: the API demands a reason, and
    // it is collected in a real dialog rather than a browser prompt.
    if (current && current.fee !== fee && !reason) {
      const region = data?.regions.find((r) => r.id === regionId);
      setReasonFor({ regionId, regionName: region?.name ?? '' });
      return;
    }

    setBusy(regionId);
    try {
      await apiJson('/api/settings/delivery-fees', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deliveryProviderId: courierId,
          regionId,
          fee,
          // `undefined` is dropped by `JSON.stringify`, so an empty box is
          // ABSENT on the wire. A typed `0` is sent as `0`.
          lateThresholdDays,
          returnFee,
          courierCityId,
          reason,
        }),
      });
      setSaved(regionId);
      setTimeout(() => setSaved(null), 2000);
      await load();
      onChanged?.();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          الطلبات المشحونة تحتفظ بالأجرة وقت شحنها؛ التعديل هنا يسري على الشحنات الجديدة فقط.
          {/* The one sentence that makes an empty box mean something. Before
              it, an empty box and a typed zero were the same request. */}
          <span className="mt-0.5 block">
            خانة <b>فارغة</b> في «حد التأخير» أو «أجرة الإرجاع» تعني «لم تُحدَّد»: الصفّ القائم يبقى على
            ما هو عليه، والصفّ الجديد يأخذ افتراضي النظام. و<b>صفر مكتوب</b> يُحفَظ صفراً ويُحاسَب صفراً.
          </span>
        </p>
        {missing.length > 0 && (
          <button
            onClick={() => setBulkOpen(true)}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-[var(--sys-primary)] px-3 text-xs font-medium text-[var(--sys-primary-foreground)] md:h-10"
          >
            <RiMagicLine className="h-4 w-4" /> عبّئ الفارغة ({missing.length})
          </button>
        )}
      </div>

      {/* A region with no fee row cannot be priced, so its orders stop dead
          at the shipment screen. Saying so here is the difference between a
          blank cell and a known cause. */}
      {missing.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)] p-3 text-sm text-[var(--sys-warning)]">
          <RiAlertLine className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b>{missing.length}</b> محافظة بلا أجرة عند هذه الشركة — أي طلب إليها سيتوقف في شاشة إنشاء
            الشحنة برسالة «لا توجد أجرة توصيل لهذه المحافظة».
            {missing.length <= 6 && <span className="mt-0.5 block">{missing.map((r) => r.name).join(' · ')}</span>}
          </span>
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
        {/* A table somebody fills in from a courier's price list. Six
            columns of inputs on a phone is one row per screen; as cards
            each governorate is a labelled little form. */}
        <Rows
          rows={data.regions}
          keyOf={(r) => r.id}
          alert={(r) => !feeFor(r.id)}
          columns={[
            {
              key: 'region',
              label: 'المحافظة',
              primary: true,
              render: (r) => <span className="text-[var(--sys-heading)]">{r.name}</span>,
            },
            {
              key: 'fee',
              label: 'الأجرة',
              render: (r) => (
                <input
                  value={draftFor(r.id).fee}
                  onChange={(e) => setField(r.id, { fee: e.target.value })}
                  aria-label={`أجرة ${r.name}`}
                  type="number"
                  min={0}
                  step="0.001"
                  dir="ltr"
                  className="h-11 w-24 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm md:h-10"
                />
              ),
            },
            {
              key: 'late',
              label: 'حد التأخير (أيام)',
              render: (r) => (
                <input
                  value={draftFor(r.id).lateThresholdDays}
                  onChange={(e) => setField(r.id, { lateThresholdDays: e.target.value })}
                  aria-label={`حد التأخير في ${r.name}`}
                  // The placeholder says «default» and NOT the number itself:
                  // printing «3» here would put the schema's default back into
                  // the browser, which is the duplication this change removes.
                  // The operator sees the real number the moment the row exists.
                  placeholder="الافتراضي"
                  title="اتركها فارغة لتُترك على ما هي عليه (أو على افتراضي النظام لصفٍّ جديد). اكتب صفراً إن كانت هذه المحافظة لا تُعلَّم متأخّرة أبداً."
                  type="number"
                  min={0}
                  max={90}
                  dir="ltr"
                  className="h-11 w-20 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm md:h-10"
                />
              ),
            },
            {
              key: 'return',
              label: 'أجرة الإرجاع',
              render: (r) => (
                <input
                  value={draftFor(r.id).returnFee}
                  onChange={(e) => setField(r.id, { returnFee: e.target.value })}
                  aria-label={`أجرة إرجاع ${r.name}`}
                  placeholder="الافتراضي"
                  title="اتركها فارغة إن كانت أجرة الإرجاع غير معروفة. اكتب صفراً إن كانت الشركة لا تأخذ شيئاً على الإرجاع — الصفر المكتوب يُحاسَب صفراً."
                  type="number"
                  min={0}
                  step="0.001"
                  dir="ltr"
                  className="h-11 w-24 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm md:h-10"
                />
              ),
            },
            {
              key: 'courierId',
              label: 'رمزها عند الشركة',
              // Their id, from THEIR list (the villages sheet they send) — never invented. A number typed here is saved
              // with the row's «تحديث» and always wins. An EMPTY box is no longer a gap when their list names this
              // governorate: the press takes that city by itself (`couriers/city-id`), and the box shows which. Only a
              // governorate their list cannot answer keeps the warning it always had: without an id their API refuses.
              render: (r) => {
                const typed = draftFor(r.id).courierCityId;
                const note = placeNote(typed, places);
                const byList = typed.trim() === '' ? defaultCityOf(r.name, places) : null;
                return (
                  <div>
                    <input
                      value={typed}
                      onChange={(e) => setField(r.id, { courierCityId: e.target.value })}
                      aria-label={`رمز ${r.name} عند الشركة`}
                      placeholder={byList ? String(byList.cityId) : 'بلا رمز'}
                      title={
                        byList
                          ? 'اتركه فاضي وبيُستعمل رمز قايمة الشركة الظاهر تحته، أو اكتب رقماً ثانياً وبيصير هو المعتمد.'
                          : 'رمز هذه المحافظة لدى الشركة، من قائمة مناطقهم — بدونه لا تُنشأ الشحنة آلياً.'
                      }
                      type="number"
                      min={1}
                      step={1}
                      dir="ltr"
                      className={`h-11 w-28 rounded-lg border bg-[var(--sys-card)] px-2 text-sm md:h-10 ${
                        typed || byList ? 'border-[var(--sys-border-input)]' : 'border-[var(--sys-warning)]'
                      }`}
                    />
                    {/* Which place the number is — and a warning, never a block, when it is a Region Id. */}
                    {note && (
                      <p className={note.kind === 'region' ? 'text-xs text-[var(--sys-warning)]' : 'text-xs text-[var(--sys-muted-foreground)]'}>
                        {note.text}
                      </p>
                    )}
                    {/* Nothing typed, and the list answers: say which city the shipment goes to. */}
                    {byList && (
                      <p className="text-xs text-[var(--sys-muted-foreground)]">افتراضي من قايمة الشركة: {byList.label}</p>
                    )}
                  </div>
                );
              },
            },
          ]}
          actions={(r) => (
            <button
              onClick={() => save(r.id)}
              disabled={busy === r.id}
              className="inline-flex items-center gap-1 text-xs text-[var(--sys-primary)] hover:underline disabled:opacity-50"
            >
              <RiSaveLine className="h-4 w-4" />
              {saved === r.id ? 'تم الحفظ' : feeFor(r.id) ? 'تحديث' : 'إضافة'}
            </button>
          )}
          empty={
            <EmptyState
              title="لا محافظات في هذا البلد"
              why="أجرةُ التوصيل تُسعَّر بالمحافظة. عرّف المحافظات من «الإعدادات ← البلدان والمتاجر» ثمّ عُد لتسعيرها."
            />
          }
        />
      </div>

      {bulkOpen && (
        <BulkFillDialog
          regions={missing}
          courier={courierId}
          onClose={() => setBulkOpen(false)}
          onSaved={async () => {
            setBulkOpen(false);
            setError(null);
            await load();
            onChanged?.();
          }}
        />
      )}

      {reasonFor && (
        <ReasonDialog
          regionName={reasonFor.regionName}
          onClose={() => setReasonFor(null)}
          onConfirm={async (reason) => {
            const id = reasonFor.regionId;
            setReasonFor(null);
            await save(id, reason);
          }}
        />
      )}
    </div>
  );
}

/**
 * Filling every empty region at once.
 *
 * Writes only the regions that have NO fee yet. An existing fee is an
 * override that needs its own reason, so a bulk pass must never quietly
 * reprice what somebody already decided.
 */
function BulkFillDialog({
  regions,
  courier,
  onClose,
  onSaved,
}: {
  regions: { id: string; name: string }[];
  courier: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [fee, setFee] = useState('');
  // EMPTY, NOT '3' AND '0'. This dialog writes fourteen regions in one pass,
  // so a pre-filled box here is fourteen rows claiming a number nobody
  // chose — and the audit log holds twenty-eight `DELIVERY_FEE_CREATED`
  // entries reading exactly `lateThresholdDays: 3, returnFee: 0`, two runs
  // of this dialog with its boxes untouched.
  const [days, setDays] = useState('');
  const [returnFee, setReturnFee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);

  return (
    <Modal isOpen onClose={onClose} title={`تعبئة ${regions.length} محافظة`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const amount = typedNumber(fee);
          const lateThresholdDays = typedNumber(days);
          const feeOnReturn = typedNumber(returnFee);
          if (typeof amount !== 'number') {
            setError('أجرة غير صالحة');
            return;
          }
          if (lateThresholdDays === NOT_A_NUMBER || feeOnReturn === NOT_A_NUMBER) {
            setError('قيمة غير صالحة');
            return;
          }
          setSaving(true);
          setError(null);
          let done = 0;
          try {
            for (const region of regions) {
              await apiJson('/api/settings/delivery-fees', {
                method: 'PUT',
                body: JSON.stringify({
                  deliveryProviderId: courier,
                  regionId: region.id,
                  fee: amount,
                  // Left out of the body when the box is empty, so each new
                  // row takes the column's default instead of a zero.
                  lateThresholdDays,
                  returnFee: feeOnReturn,
                }),
              });
              done++;
              setProgress(done);
            }
            onSaved(`عُبِّئت ${done} محافظة`);
          } catch (err) {
            setError(
              `${err instanceof Error ? err.message : 'تعذر الحفظ'} — حُفظت ${done} من ${regions.length}`
            );
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-3"
      >
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
          تُكتب على المحافظات التي <b>لا أجرة لها</b> فقط. المحافظات المسعّرة مسبقاً لا تُلمس — تعديلها
          قرار منفصل يحتاج سبباً مكتوباً. تقدر تعدّل أي محافظة بعدها من الجدول.
          <span className="mt-1 block">
            خانة فارغة = <b>لم تُحدَّد</b>، فيأخذ الصفّ الجديد افتراضي النظام. وصفر مكتوب = <b>صفر</b>.
          </span>
        </p>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">الأجرة</span>
          <input
            type="number" min="0" step="0.001" value={fee} onChange={(e) => setFee(e.target.value)}
            required autoFocus dir="ltr"
            className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] px-3 text-sm md:h-10"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">حد التأخير (أيام)</span>
            <input
              type="number" min="0" max="90" value={days} onChange={(e) => setDays(e.target.value)} dir="ltr"
              placeholder="الافتراضي"
              title="فارغة = افتراضي النظام. صفر = لا تُعلَّم متأخّرة أبداً."
              className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] px-3 text-sm md:h-10"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">أجرة الإرجاع</span>
            <input
              type="number" min="0" step="0.001" value={returnFee} onChange={(e) => setReturnFee(e.target.value)} dir="ltr"
              placeholder="الافتراضي"
              title="فارغة = غير معروفة. صفر = الشركة لا تأخذ شيئاً على الإرجاع."
              className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] px-3 text-sm md:h-10"
            />
          </label>
        </div>

        <p className="text-xs text-[var(--sys-muted)]">{regions.map((r) => r.name).join(' · ')}</p>

        {saving && (
          <p className="text-xs tabular-nums text-[var(--sys-muted-foreground)]">
            جارٍ الحفظ… {progress} / {regions.length}
          </p>
        )}
        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[var(--sys-border)] px-4 text-sm md:h-10">
            إلغاء
          </button>
          <button
            type="submit" disabled={saving || !fee}
            className="h-11 rounded-lg bg-[var(--sys-primary)] px-4 text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50 md:h-10"
          >
            {saving ? 'جارٍ…' : `عبّئ ${regions.length}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The written reason an existing fee change needs, for the audit log. */
function ReasonDialog({
  regionName,
  onClose,
  onConfirm,
}: {
  regionName: string;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');

  return (
    <Modal isOpen onClose={onClose} title={`تعديل أجرة ${regionName}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onConfirm(reason.trim());
        }}
        className="space-y-3"
      >
        <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs text-[var(--sys-muted-foreground)]">
          تغيير أجرة قائمة يُسجَّل في سجل التدقيق باسمك وبالسبب. الشحنات القائمة تحتفظ بأجرتها.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--sys-foreground)]">السبب (إلزامي)</span>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)}
            required minLength={3} rows={3} autoFocus
            placeholder="مثال: اتفاق جديد مع الشركة على هذه المحافظة"
            className="w-full rounded-lg border border-[var(--sys-border-input)] p-3 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[var(--sys-border)] px-4 text-sm md:h-10">
            إلغاء
          </button>
          <button type="submit" className="h-11 rounded-lg bg-[var(--sys-primary)] px-4 text-sm font-medium text-[var(--sys-primary-foreground)] md:h-10">
            حفظ التعديل
          </button>
        </div>
      </form>
    </Modal>
  );
}
