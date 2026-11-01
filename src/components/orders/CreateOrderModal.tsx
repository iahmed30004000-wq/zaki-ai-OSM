'use client';

import React, { useState, useEffect, useId } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useApp } from '@/context/AppContext';
import { apiFetch } from '@/lib/api-client';
import { useRegions } from '@/hooks/useRegions';
import { useDeliveryEta } from '@/hooks/useDeliveryEta';
import { useProducts } from '@/hooks/useProducts';
import { productName } from '@/lib/product-name';
import { ProductLinesEditor, goodsTotal, newLine, type DraftLine } from '@/components/orders/ProductLinesEditor';
import { amount } from '@/lib/format';
import { RiArchiveLine, RiCheckboxCircleLine, RiMapPinLine, RiMegaphoneLine, RiPhoneLine, RiStickyNoteLine, RiUserFollowLine, RiUserSettingsLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useMayOpen } from '@/hooks/useMayOpen';
import { openOrderStep, openPreparationStep } from '@/lib/next-step';
import { confirmOrderNow } from '@/lib/confirm-now';
import { userCan } from '@/lib/can';
import { useIsPhone } from '@/hooks/useIsPhone';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';

interface CreateOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The created order, so a caller can act on it immediately — the batches
   * screen confirms it on the spot, through the ordinary confirmation
   * endpoint rather than a second path that would have to re-implement
   * reservation and the status log.
   */
  onSuccess: (order?: { id: string; orderNumber?: string }) => void;
}

export function CreateOrderModal({ isOpen, onClose, onSuccess }: CreateOrderModalProps) {
  const { t, locale, isRtl, currentUser } = useApp();
  const ar = locale === 'ar';
  const toast = useToast();
  const mayOpen = useMayOpen();
  /*
   * A PHONE LAYS THIS FORM OUT DIFFERENTLY — AND ONLY LAYS IT OUT (ORD-09).
   *
   * Nothing below changes what is sent: every field is still a controlled input of the same state, `handleSubmit`
   * builds the same body from it, and the order is created by the same door. What the width decides is where the
   * buttons sit (outside the part that scrolls, so the seller never loses sight of «إنشاء الطلب»), whether the
   * four sections wear a frame, and whether the two optional ones (assignment, notes) are folded. A desk is
   * drawn exactly as it was.
   */
  const phone = useIsPhone();
  /** Ties the submit button in the dialog's foot to the form in its body. */
  const formId = useId();
  const [loading, setLoading] = useState(false);
  /**
   * «الزبون على الخط — أكّده الآن». Offered only to somebody who may confirm (`orders.confirm`):
   * the server asks the same of the confirmation call, so this is the door's answer drawn early,
   * never a way past it.
   */
  const mayConfirm = userCan(currentUser, 'orders.confirm');
  const [confirmNow, setConfirmNow] = useState(false);
  // «شامل التوصيل»: ticked unless she unticks it — most of what is sold here is sold with free delivery, and a forgotten box
  // used to mean the courier's fee added on top of a price the customer had been told includes it.
  const [includesDelivery, setIncludesDelivery] = useState(true);

  const [moderators, setModerators] = useState<{ id: string; name: string }[]>([]);
  /** Naming a responsible moderator needs `orders.assign`; the server says whether this person holds it. */
  const [mayAssign, setMayAssign] = useState(false);

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAltPhone, setCustomerAltPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  // Governorates of the SELECTED country — never a hard-coded list.
  const { regions, countryName, currency } = useRegions();
  const [regionId, setRegionId] = useState('');
  const selectedRegion = regions.find((r) => r.id === regionId) ?? null;
  const customerCity = selectedRegion?.name ?? '';
  /*
   * THE FINER ANSWER. The governorate's window arrives with the list; the
   * street's has to be asked for, because the address is typed. Same
   * engine behind both — see src/lib/delivery-time.ts.
   */
  const { eta } = useDeliveryEta(regionId || null, customerAddress);
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [channelId, setChannelId] = useState('');
  const { products } = useProducts({ enabled: isOpen });
  const [channels, setChannels] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [moderatorId, setModeratorId] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  const [existingCustomerAlert, setExistingCustomerAlert] = useState<{
    exists: boolean;
    name?: string;
    totalOrders?: number;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Reset ALL form state first so stale customer data / selections from a
      // previous open never persist, then load fresh dropdown data
      setLoading(false);
      setConfirmNow(false);
      setIncludesDelivery(true);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerAltPhone('');
      setCustomerAddress('');
      setRegionId('');
      setLines([newLine()]);
      setChannelId('');
      setModeratorId('');
      setCustomerNotes('');
      setInternalNotes('');
      setExistingCustomerAlert(null);
      loadFormData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /**
   * OPEN ON THE FIRST PRODUCT, AS THIS FORM ALWAYS HAS.
   *
   * One click less for the commonest order, and nothing is assumed about
   * its price — `newLine` reads the product's own first offer, or its base
   * price. It used to happen inside the catalogue fetch this dialog no
   * longer makes; the catalogue now arrives from `useProducts`, so the
   * seeding waits for it.
   *
   * Only while the form is still untouched: a line the person has already
   * chosen is never overwritten by a list arriving late.
   *
   * AND IT WAITS FOR THE CURRENCY'S DECIMALS as well as the list. A line
   * with no offer opens at the base price, which is rounded to the store's
   * minor unit, and that unit arrives with the regions — so seeding before
   * it would open the line empty.
   */
  useEffect(() => {
    if (!isOpen || products.length === 0 || !currency) return;
    const minorUnit = currency.minorUnit;
    setLines((current) =>
      current.length === 1 && !current[0].productId ? [newLine(products[0], minorUnit)] : current
    );
  }, [isOpen, products, currency]);

  const loadFormData = async () => {
    try {
      // The catalogue is `useProducts`'s; this loads what it does not — from the order form's own door, which hands a
      // person the channel names and (only with `orders.assign`) the moderators' names, and nothing of the team's money.
      const res = await apiFetch('/api/orders/form-options');
      if (res.ok) {
        const data = await res.json();
        setChannels((data.channels ?? []).map((c: { id: string; name: string }) => ({ ...c, isActive: true })));
        setModerators(data.moderators ?? []);
        setMayAssign(data.mayAssign === true);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handlePhoneBlur = async () => {
    if (!customerPhone || customerPhone.length < 7) return;
    try {
      const res = await apiFetch(`/api/customers?q=${encodeURIComponent(customerPhone)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.customers && data.customers.length > 0) {
          const matched = data.customers[0];
          setExistingCustomerAlert({ exists: true, name: matched.fullName, totalOrders: matched.totalOrders });
          if (!customerName) setCustomerName(matched.fullName);
          if (!customerAddress && matched.address) setCustomerAddress(matched.address);
          // Reuse the customer's known city only when it is a region of THIS country.
          if (matched.city) {
            const known = regions.find((r) => r.name === matched.city);
            if (known) setRegionId(known.id);
          }
        } else {
          setExistingCustomerAlert({ exists: false });
        }
      }
    } catch (e) {
      console.error(e);
    }
  };



  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName,
          customerPhone,
          customerAltPhone,
          customerAddress,
          customerCity,
          regionId: regionId || null,
          items: lines.map((l) => ({
            productId: l.productId,
            offerId: l.offerId,
            quantity: l.quantity,
            unitPrice: l.price,
          })),
          // The delivery fee follows the courier and is set when the shipment
          // is created; sending a zero here would read as free delivery.
          // Whether the price already CARRIES it is the box below — her word for this order, sent either way.
          priceIncludesDelivery: includesDelivery,
          channelId: channelId || null,
          moderatorId: moderatorId || null,
          customerNotes,
          internalNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل إنشاء الطلب');
      const created = data.order ?? data;
      /**
       * IT SAYS SO WHEN IT WORKS.
       *
       * Only the failure spoke: a successful create closed the dialog and
       * left the moderator looking at a list, with no word that anything
       * had happened and no order number to write down. Asked for in as
       * many words: «لما أنشئ طلب وينجح: تم إنشاء الطلب بنجاح».
       *
       * With the number, because that is the thing she is about to need.
       */
      /*
       * AND WHO IT WENT TO.
       *
       * The door returns `notice` only when the agent's own cap pushed her
       * entry into the shared queue. Without this she reads «تم إنشاء
       * الطلب» and goes looking for it in «طلباتي», where it is not.
       * A warning, not a success: the order was made, but not hers.
       */
      /*
       * AND WHERE TO FIND IT.
       *
       * «تم إنشاء الطلب ORD-…» gave the number and nothing to do with it: the
       * moderator who made it, and wants to check the address or add a note,
       * went back to the list and searched for the number she had just been
       * handed. The order's own address (`/orders/<id>`) opens it where it
       * is — see that page for how.
       *
       * Offered only when she may open the orders screen: a link that ends in
       * a refusal is worse than no link.
       */
      const openIt = openOrderStep(created?.id, mayOpen);
      if (data.notice) toast.warn(`تم إنشاء الطلب ${created?.orderNumber ?? ''} — ${data.notice}`.trim(), undefined, openIt);
      // With «أكّده الآن» the one message below says both things; two toasts for one act is noise.
      else if (!(confirmNow && created?.id)) toast.done(created?.orderNumber ? `تم إنشاء الطلب ${created.orderNumber} بنجاح` : 'تم إنشاء الطلب بنجاح', undefined, openIt);
      // The customer is on the line: confirm what was just made, through the ordinary confirmation door.
      if (confirmNow && created?.id) {
        const done = await confirmOrderNow(created.id);
        const label = created.orderNumber ?? 'الطلب';
        if (done.ok) toast.done(`تم إنشاء ${label} وتأكيده — صار في شاشة التجهيز.`, undefined, openPreparationStep(mayOpen));
        else toast.warn(`أُنشئ ${label} لكن تعذّر تأكيده: ${done.reason} — أكّده من شاشة الطلبات.`, undefined, openIt);
      }
      onSuccess(created);
      onClose();
    } catch (err: any) {
      toast.failed(err.message);
    } finally {
      setLoading(false);
    }
  };

  /*
   * THE EDITOR'S OWN ECHO, NOT A SECOND COPY OF IT.
   *
   * This was `lines.reduce((sum, l) => sum + (Number(l.price) || 0), 0)` —
   * the same reduce `ProductLinesEditor` already had, written out again. Two
   * copies of one figure, and each `|| 0` printed a confident «0.00» over a
   * form with every price box empty. `goodsTotal` is that one function now,
   * and it says «nothing written» rather than «worth nothing».
   */
  const goods = goodsTotal(lines);
  const money = (n: number) => amount(n, currency);
  const ready =
    customerName.trim().length >= 2 &&
    customerPhone.trim().length >= 7 &&
    lines.length > 0 &&
    lines.every((l) => l.productId);

  const frame = phone
    ? 'space-y-3'
    : 'border border-[var(--sys-border)] rounded-lg p-4 bg-[var(--sys-surface)]/60 space-y-3';

  const SectionTitle = ({ icon: Icon, title, color }: { icon: React.ElementType; title: string; color: string }) => (
    <div className="flex items-center gap-2 pb-2 border-b border-[var(--sys-border)]">
      <div className={`p-1.5 rounded-lg ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <h4 className="text-xs font-black uppercase tracking-wide text-[var(--sys-foreground)]">{title}</h4>
    </div>
  );

  /*
   * CANCEL AND CREATE — DRAWN ONCE.
   *
   * A desk puts them at the end of the form, where they have always been. A phone hands them to the dialog's
   * foot (`footer`), which stays put while the body scrolls, and the submit button belongs to the form through
   * `form="…"`: pressing it submits the same `handleSubmit`, and Enter in a field still does.
   */
  const actions = (
    <div className={phone ? 'flex items-center gap-3' : 'flex items-center justify-end pt-1'}>
      {/* A text button here used to only CLOSE the modal while telling the
          person to try «الإدخال بالذكاء» from «the green button» — which is
          not green, and was one more way out beside «إلغاء». The AI entry
          is its own button in the orders header. */}
      <div className={phone ? 'flex w-full items-center gap-3' : 'flex items-center gap-3'}>
        <Button type="button" variant="outline" onClick={onClose}>
          إلغاء
        </Button>
        <Button type="submit" form={phone ? formId : undefined} loading={loading} disabled={!ready} className={phone ? 'flex-1' : undefined}>
          <RiMegaphoneLine className="w-4 h-4" />
          {confirmNow ? 'إنشاء الطلب وتأكيده' : 'إنشاء الطلب'} ({goods === undefined ? '—' : money(goods)})
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="طلب سريع جديد"
      subtitle={phone ? undefined : 'فحص تلقائي للعميل المكرر • تعبئة السعر تلقائياً من العرض • تعيين المودريتور'}
      maxWidth="2xl"
      footer={phone ? actions : undefined}
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>

        {/* ─── 1. Customer ─── */}
        <div className={frame}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <SectionTitle icon={RiUserFollowLine} title="1. بيانات العميل" color="bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]" />
            {existingCustomerAlert?.exists && (
              <span className="text-xs font-bold text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/60 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                <RiCheckboxCircleLine className="w-4 h-4" />
                عميل موجود — {existingCustomerAlert.name} ({existingCustomerAlert.totalOrders} طلب سابق)
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--sys-foreground)] mb-1.5">رقم الهاتف *</label>
              <div className="relative">
                <RiPhoneLine className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
                <input
                  type="tel"
                  placeholder="مثال: 0936654998"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  onBlur={handlePhoneBlur}
                  required
                  dir="ltr"
                  className="h-11 md:h-auto w-full ps-9 pe-3 md:py-2 text-sm bg-[var(--sys-card)] border border-[var(--sys-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-destructive)]/20 focus:border-[var(--sys-destructive)] transition-colors"
                />
              </div>
              {existingCustomerAlert && (
                <p className={`text-xs mt-1 flex items-center gap-1 ${existingCustomerAlert.exists ? 'text-[var(--sys-warning)]' : 'text-[var(--sys-success)]'}`}>
                  {existingCustomerAlert.exists ? (
                    <>
                      <RiCheckboxCircleLine className="w-4 h-4" /> تم ربط البيانات بملف العميل تلقائياً
                    </>
                  ) : (
                    <>
                      <RiCheckboxCircleLine className="w-4 h-4" /> عميل جديد — سيتم إنشاء ملف تلقائياً
                    </>
                  )}
                </p>
              )}
            </div>

            <Input label="اسم العميل الكامل *" placeholder="مثال: عبدالله عبدالقادر" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="رقم بديل" placeholder="اختياري" value={customerAltPhone} onChange={(e) => setCustomerAltPhone(e.target.value)} />
            <div>
              <label className="block text-xs font-medium text-[var(--sys-foreground)] mb-1.5">
                المحافظة{countryName ? ` — ${countryName}` : ''} *
              </label>
              <Select value={regionId} onChange={(e) => setRegionId(e.target.value)} aria-label="المحافظة" required>
                <option value="">اختر المحافظة</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </Select>
              {regions.length === 0 && (
                <p className="mt-1 text-xs text-[var(--sys-destructive)]">
                  لا توجد محافظات لهذا البلد — أضفها من الإعدادات ← البلدان والمتاجر والمحافظ.
                </p>
              )}
              {/*
                WHAT THIS PLACE HAS ACTUALLY TAKEN.

                «لما أدخل طلب بالمدينة والعنوان يعطيني خلال كم الفترة
                المتوقعة للاستلام» — measured from delivered orders, not
                typed by anybody. It says nothing where too few have been
                delivered to say anything honest, which is most of the
                country on the first day.

                AND IT NAMES ITS OWN GRAIN. «يصل عادةً خلال يومين» means
                one thing for this street and another for the whole
                country, so the chip says which — and the finer answer
                replaces the governorate's as soon as the address is typed,
                through the same engine, so the two can never disagree.
              */}
              {(eta?.ar ?? selectedRegion?.deliveryAr) && (
                <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
                  {eta?.ar ?? selectedRegion?.deliveryAr}
                  <span className="text-[var(--sys-muted)]">
                    {' '}· {eta?.levelAr ?? 'لهذه المحافظة'} · من{' '}
                    {eta?.window?.samples ?? selectedRegion?.delivery?.samples} تسليماً سابقاً
                  </span>
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--sys-foreground)] mb-1.5">العنوان *</label>
              <div className="relative">
                <RiMapPinLine className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--sys-muted)]" />
                <input
                  placeholder="الشارع، البناء، المنطقة..."
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  required
                  className="h-11 md:h-auto w-full ps-9 pe-3 md:py-2 text-sm bg-[var(--sys-card)] border border-[var(--sys-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--sys-destructive)]/20 focus:border-[var(--sys-destructive)]"
                />
              </div>
            </div>
          </div>
        </div>

        {/* ─── 2. المنتجات ─── */}
        <div className={frame}>
          <SectionTitle icon={RiArchiveLine} title="2. المنتجات" color="bg-[var(--sys-surface-strong)] text-[var(--sys-primary)]" />
          {/* The same editor the order screen uses, so a line means the same
              thing whether it is typed here or corrected later. */}
          <ProductLinesEditor
            lines={lines}
            products={products}
            currency={currency}
            onChange={setLines}
            disabled={loading}
          />
          {/* Under the prices, where the figure it changes is read. Ticked, the customer pays the price and the courier's fee comes out
              of the shop; unticked, the fee is added to what the courier collects when the shipment is made. */}
          <label className={phone ? 'mt-3 flex min-h-11 items-start gap-2 text-sm text-[var(--sys-foreground)]' : 'mt-3 flex items-start gap-2 text-sm text-[var(--sys-foreground)]'}>
            <input
              type="checkbox"
              checked={includesDelivery}
              onChange={(e) => setIncludesDelivery(e.target.checked)}
              disabled={loading}
              className={phone ? 'mt-1 h-5 w-5' : 'mt-1'}
            />
            <span>
              <span className="font-semibold">شامل التوصيل</span>
              <span className="block text-xs text-[var(--sys-muted-foreground)]">
                {includesDelivery
                  ? 'الزبون بيدفع سعر الطلب بس، وأجرة التوصيل على المتجر.'
                  : 'بينضاف توصيل على الزبون لما تنعمل الشحنة.'}
              </span>
            </span>
          </label>
        </div>

        {/* ─── 3 and 4: optional, so a phone folds them (ORD-09) ─── */}
        <Optional phone={phone} holds={mayAssign ? 'المودريتور · القناة · ملاحظات' : 'القناة · ملاحظات'}>
        {/* ─── 3. Assignment & Source ─── */}
        <div className={frame}>
          <SectionTitle icon={RiUserSettingsLine} title="3. التعيين والمصدر" color="bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)]" />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* The picker is for whoever may hand orders out: for everybody else the order is theirs, and the server refuses a name. */}
            {mayAssign && (
              <Select label="المودريتور المسؤول" value={moderatorId} onChange={(e) => setModeratorId(e.target.value)}>
                <option value="">تعيين تلقائي / بدون</option>
                {moderators.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </Select>
            )}

            <div>
              <label className="block text-xs font-medium text-[var(--sys-foreground)] mb-1.5">قناة الطلب</label>
              {/* The shop's own channels, not a list written into this form —
                  they are what the numbers are counted by. */}
              <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="قناة الطلب">
                <option value="">— اختر القناة —</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
              {channels.length === 0 && (
                <p className="text-xs text-[var(--sys-muted)] mt-1">
                  لا قنوات بعد — تُضاف من الإعدادات ← قنوات الطلبات.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ─── 4. Notes ─── */}
        <div className={frame}>
          <SectionTitle icon={RiStickyNoteLine} title="4. الملاحظات" color="bg-[var(--sys-warning-soft)] text-[var(--sys-warning)]" />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Textarea label="ملاحظات العميل (وقت التوصيل المفضل...)" placeholder="مثال: يرجى الاتصال قبل الوصول" rows={2} value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
            <Textarea label="ملاحظات داخلية" placeholder="مثال: عميل من إعلان تيك توك" rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
          </div>
        </div>

        </Optional>

        {/* ─── Actions ─── */}
        {mayConfirm && (
          <label className={phone ? 'flex min-h-11 items-start gap-2 text-sm text-[var(--sys-foreground)]' : 'flex items-start gap-2 text-sm text-[var(--sys-foreground)]'}>
            <input type="checkbox" checked={confirmNow} onChange={(e) => setConfirmNow(e.target.checked)} className={phone ? 'mt-1 h-5 w-5' : 'mt-1'} />
            <span>
              <span className="font-semibold">الزبون على الخط — أكّده الآن</span>
              <span className="block text-xs text-[var(--sys-muted-foreground)]">يُنشأ الطلب ويُؤكَّد فوراً ويذهب إلى التجهيز، بدل أن يدخل طابور التأكيد.</span>
            </span>
          </label>
        )}
        {!phone && actions}
      </form>
    </Modal>
  );
}

/**
 * THE TWO OPTIONAL SECTIONS — FOLDED ON A PHONE, DRAWN IN PLACE ON A DESK (ORD-09).
 *
 * «3. التعيين والمصدر» and «4. الملاحظات» are never required, and after the customer and the products they are
 * the third and fourth screenful of a form the seller is filling while the customer waits. Folded, they are one
 * line that says what is inside. The inputs stay in the page while the fold is closed (a native `<details>`
 * only stops drawing its body), and they are the same controlled inputs of the same state, so nothing that was
 * typed in them is lost and nothing is sent differently.
 */
function Optional({ phone, holds, children }: { phone: boolean; holds: string; children: React.ReactNode }) {
  if (!phone) return <>{children}</>;
  return (
    <AdvancedGroup label="اختياري" holds={holds}>
      <div className="w-full space-y-4">{children}</div>
    </AdvancedGroup>
  );
}
