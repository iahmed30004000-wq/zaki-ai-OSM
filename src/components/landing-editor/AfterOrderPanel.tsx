'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { moneyText } from '@/lib/money';
import { whatsappButtonStyle } from '@/components/landing/OrderForm';
import { RiWhatsappLine } from '@/components/storefront/icons';

/**
 * «بعد الطلب» — everything that happens once the order is in, in one place on the form block.
 *
 * «الابسيل والكروس سيل حاسهم مخفيين… مش اتفقنا قبل كل اشي بيدل ع بعضو؟». The «زيد علبة» offer is set on the
 * product's offers, its window in the system settings, the suggested products on the page's details screen — three
 * places, and nothing in the page editor pointed at any of them. This panel says whether each is on, and links to
 * where it is set. And the WhatsApp button after the order is set right here: on/off, its words, the message, the
 * number, and whether WhatsApp opens by itself.
 *
 * AND THE «زيد علبة» OFFER IS SWITCHED ON RIGHT HERE TOO. «بقلي انو الخدمة غير مفعلة لما اجي اعملها من صفحة الهبوط»:
 * its line used to count the product's offers by itself, by a field an offer does not have, so a stopped bundle read
 * «شغّال» — and when the line did say «مطفي», all it offered was a link away. The line is now the server's answer for
 * THIS page (`GET /api/landing-pages/[id]/after-order`, the function the order door itself asks), and whoever may
 * manage offers turns it on, off or back on from here, through the offers' own two doors, which refuse in their own
 * words. The figures are the server's, printed at the store's decimals; nothing here adds, cuts or rounds a price.
 */

export interface AfterOrderSection {
  whatsappAfter: boolean;
  whatsappLabel: string;
  whatsappMessage: string;
  whatsappNumber: string;
  whatsappAutoOpen: boolean;
  // When the button appears and how it looks. Optional here: a block saved before them reads the defaults below.
  whatsappWhen?: 'now' | 'end' | 'delay';
  whatsappDelay?: number;
  whatsappLook?: 'outline' | 'solid' | 'green' | 'floating';
  whatsappShape?: 'curved' | 'pill' | 'square';
  whatsappWide?: boolean;
  whatsappColor?: string;
  whatsappIcon?: boolean;
  whatsappPulse?: boolean;
  afterOrderFlow: 'together' | 'sequence';
  afterOrderBanner: 'none' | 'congrats' | 'countdown';
  afterOrderBannerText: string;
  upsellLook: 'card' | 'banner' | 'compact';
  crossSellLook: 'list' | 'cards';
}

/** One row of mutually exclusive choices — the editor's segmented control. */
function Choices<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-semibold text-[var(--sys-heading)]">{label}</span>
      <div className="flex gap-1 rounded-md bg-[var(--sys-surface-strong)] p-0.5">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            onClick={() => onPick(v)}
            className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-bold transition ${
              value === v ? 'bg-[var(--sys-card)] text-[var(--sys-heading)] shadow-raised' : 'text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface AfterOrderContext {
  productId?: string | null;
  pageId?: string | null;
  storePhone?: string | null;
  /** The page's currency — the code the editor already prices its preview in. */
  currency?: string | null;
}

/**
 * `GET /api/landing-pages/[id]/after-order`: what this page's thank-you screen will offer, or why it offers nothing.
 * `offer` is the order door's own view of the bundle — `price` is what the customer is charged, `listPrice` the
 * bundle before its own reduction — and `minorUnit` is the store's decimals those two were rounded by.
 */
interface AfterOrderAnswer {
  productId: string | null;
  productName: string | null;
  offer: { id: string; name: string; quantity: number; freeQuantity: number; price: number; listPrice: number | null } | null;
  why: 'NO_PRODUCT' | 'NONE' | 'STOPPED' | 'ENDED' | null;
  flagged: { id: string; name: string } | null;
  /** Writes are drawn only while this is 0 (a create) or 1 (an edit of that row) — see `postOrderOfferStateFor`. */
  flaggedCount: number;
  minorUnit: number;
  canManage: boolean;
}

/**
 * The new bundle's name, from its pieces: «قطعة كمان» · «قطعتين كمان» · «3 قطع كمان» · «11 قطعة كمان». The seller types
 * two numbers and no name, so the name says the pieces the way Arabic counts them — the plural from three to ten, the
 * singular from eleven, and by the last two digits past a hundred, as `forPieces` in `offers.ts` counts them.
 */
function bundleName(pieces: number): string {
  if (pieces === 1) return 'قطعة كمان';
  if (pieces === 2) return 'قطعتين كمان';
  const lastTwo = pieces % 100;
  return lastTwo >= 3 && lastTwo <= 10 ? `${pieces} قطع كمان` : `${pieces} قطعة كمان`;
}

/**
 * The server's own sentence, when it wrote one. Every door this panel knocks on refuses in Arabic, so a message with
 * no Arabic in it is a crash talking (`HTTP 502`), not a reason — and the panel says its own words instead.
 */
const ARABIC = /[؀-ۿ]/;
const sentenceOf = <T,>(e: unknown, otherwise: T): string | T => (e instanceof Error && ARABIC.test(e.message) ? e.message : otherwise);

/** The upsell line: the server's answer in one sentence. The figures are printed as sent, at the store's decimals. */
function upsellLine(a: AfterOrderAnswer, currency: string): string {
  if (a.offer) {
    const o = a.offer;
    const gift = o.freeQuantity > 0 ? ` + ${o.freeQuantity} مجاناً` : '';
    const was = o.listPrice === null ? '' : ` بدل ${moneyText(o.listPrice, null, a.minorUnit)}`;
    return `شغّال: ${o.name} — ${o.quantity} قطعة${gift} بـ${moneyText(o.price, currency, a.minorUnit)}${was}`;
  }
  if (a.why === 'NO_PRODUCT') return 'الصفحة ما إلها منتج — العرض بينحط على منتج الصفحة';
  if (a.why === 'STOPPED') return `مطفي — العرض «${a.flagged?.name ?? ''}» موقّف`;
  if (a.why === 'ENDED') return `مطفي — العرض «${a.flagged?.name ?? ''}» خلص`;
  return `مطفي — ما في عرض بعد الطلب لـ«${a.productName ?? ''}»`;
}

const ROW = 'flex items-start justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-2.5';
const LINK = 'shrink-0 rounded-md border border-[var(--sys-border)] px-2 py-1 text-xs font-semibold text-[var(--sys-primary)] hover:bg-[var(--sys-surface)]';
const FIELD = 'w-full rounded-md border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 py-1.5 text-xs text-[var(--sys-foreground)]';

export function AfterOrderPanel({
  section: s,
  patch,
  ctx,
}: {
  section: AfterOrderSection;
  patch: (fields: Record<string, unknown>) => void;
  ctx: AfterOrderContext;
}) {
  /** The server's answer for this page; null while it is not known. */
  const [answer, setAnswer] = useState<AfterOrderAnswer | null>(null);
  /** Why it is not known, in the server's own words — a missing permission included. */
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [crossSell, setCrossSell] = useState<number | null>(null);
  // A new after-order bundle's two boxes, as typed. The door checks them; the panel only sends them.
  const [pieces, setPieces] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  /** The door's refusal, word for word. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const readAnswer = useCallback(
    async (alive: () => boolean = () => true) => {
      if (!ctx.pageId) return;
      try {
        const d = await apiJson<AfterOrderAnswer>(`/api/landing-pages/${ctx.pageId}/after-order`);
        if (!alive()) return;
        setAnswer(d && (d.offer || d.why) ? d : null);
        setAnswerError(null);
      } catch (e) {
        if (!alive()) return;
        setAnswer(null);
        setAnswerError(sentenceOf(e, null));
      }
    },
    [ctx.pageId]
  );

  useEffect(() => {
    let live = true;
    void readAnswer(() => live);
    if (ctx.pageId) {
      apiJson<{ recommendations?: unknown[] }>(`/api/landing-pages/${ctx.pageId}/recommendations`)
        .then((d) => live && setCrossSell((d.recommendations ?? []).length))
        .catch(() => live && setCrossSell(null));
    }
    return () => {
      live = false;
    };
  }, [ctx.pageId, readAnswer]);

  /**
   * One write through the offers' own doors, then the answer read again — the line after a press is the server's,
   * never a guess. A refusal is the door's sentence, word for word, and changes nothing else: nothing was written.
   *
   * Never `postOrderOffer: false`. Taking the flag off would not switch the offer off — it would hand its cheap
   * after-order price to the page as an ordinary bundle (`liveOfferWhere`). Off is `status`, and only `status`.
   */
  async function send(url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    setBusy(true);
    setRefusal(null);
    try {
      await apiJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      setRefusal(sentenceOf(e, 'ما زبط — جرّب كمان مرة.'));
      setBusy(false);
      return;
    }
    await readAnswer();
    setBusy(false);
  }

  const count = Number(pieces);
  const canCreate = Number.isInteger(count) && count >= 1 && price.trim() !== '' && Number.isFinite(Number(price));
  // The row each control acts on, out of the answer — the live bundle, or the flagged one that is off.
  const liveId = answer?.offer?.id ?? null;
  const flaggedId = answer?.flagged?.id ?? null;
  const productId = answer?.productId ?? null;

  const number = s.whatsappNumber.trim() || ctx.storePhone || '';
  const when = s.whatsappWhen ?? 'now';
  const delay = s.whatsappDelay ?? 5;
  const look = s.whatsappLook ?? 'outline';
  const color = s.whatsappColor ?? '';

  return (
    <section aria-label="بعد الطلب" className="space-y-2 rounded-lg bg-[var(--sys-surface)] p-2.5">
      <p className="text-xs font-bold text-[var(--sys-heading)]">بعد الطلب</p>

      {/* The offer and the suggestions — whether they are on, and where to set them. */}
      <div className={ROW}>
        <div className="min-w-0 text-xs">
          <p className="font-semibold text-[var(--sys-heading)]">عرض «زيد علبة» (أب سيل)</p>
          <p className="text-[var(--sys-muted-foreground)]">
            {answer ? upsellLine(answer, ctx.currency ?? '') : (answerError ?? 'من عروض المنتج')}
          </p>
        </div>
        {ctx.productId && (
          <a href={`/products/${ctx.productId}#offers`} target="_blank" rel="noopener noreferrer" className={LINK}>
            عروض المنتج
          </a>
        )}
      </div>
      {/*
        ON, OFF AND BACK ON, WITHOUT LEAVING THE PAGE — for whoever may manage offers; the doors ask for that
        permission themselves. Each control writes only where the door's one-flagged-bundle rule has nothing to strip:
        a new bundle while none is flagged, the one flagged bundle's own switch otherwise, and nothing while two are.
      */}
      {answer?.canManage && productId && (
        <div className="space-y-1.5">
          {answer.flaggedCount > 1 ? (
            <p className="text-xs text-[var(--sys-warning)]">في أكتر من عرض معلّم «بعد الطلب» لهالمنتج — رتّبهم من «عروض المنتج» أول.</p>
          ) : liveId ? (
            <button type="button" className={`${LINK} disabled:opacity-50`} disabled={busy} onClick={() => send(`/api/offers/${liveId}`, 'PATCH', { status: 'INACTIVE' })}>
              أوقفه
            </button>
          ) : flaggedId && answer.why === 'STOPPED' ? (
            <button type="button" className={`${LINK} disabled:opacity-50`} disabled={busy} onClick={() => send(`/api/offers/${flaggedId}`, 'PATCH', { status: 'ACTIVE' })}>
              رجّعه يشتغل
            </button>
          ) : flaggedId && answer.why === 'ENDED' ? (
            <button type="button" className={`${LINK} disabled:opacity-50`} disabled={busy} onClick={() => send(`/api/offers/${flaggedId}`, 'PATCH', { endsAt: null })}>
              رجّعه يشتغل بلا تاريخ نهاية
            </button>
          ) : answer.why === 'NONE' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sys-foreground)]">
              <label className="flex items-center gap-1.5">
                كم قطعة
                <input type="number" min={1} max={999} step={1} className={`${FIELD} w-20`} value={pieces} onChange={(e) => setPieces(e.target.value)} />
              </label>
              <label className="flex items-center gap-1.5">
                بكم
                <input type="number" min={0} step="any" className={`${FIELD} w-20`} value={price} onChange={(e) => setPrice(e.target.value)} />
              </label>
              <button
                type="button"
                className={`${LINK} disabled:opacity-50`}
                disabled={busy || !canCreate}
                onClick={() =>
                  send('/api/offers', 'POST', {
                    productId,
                    name: bundleName(count),
                    quantity: count,
                    sellingPrice: Number(price),
                    postOrderOffer: true,
                  })
                }
              >
                شغّل العرض
              </button>
            </div>
          ) : null}
          {refusal && (
            <p role="alert" className="text-xs font-semibold text-[var(--sys-destructive)]">
              {refusal}
            </p>
          )}
          <p className="text-xs text-[var(--sys-muted-foreground)]">بيظهر للزبون بشاشة الشكر بس، وما بينختار قبل الطلب.</p>
        </div>
      )}
      <div className={ROW}>
        <div className="min-w-0 text-xs">
          <p className="font-semibold text-[var(--sys-heading)]">منتجات مقترحة (كروس سيل)</p>
          <p className="text-[var(--sys-muted-foreground)]">
            {crossSell === null ? 'من تفاصيل الصفحة' : crossSell > 0 ? `${crossSell} منتج` : 'ما في منتجات مقترحة'}
          </p>
        </div>
        {ctx.pageId && (
          <a href={`/store/landing-pages/${ctx.pageId}#recommendations`} target="_blank" rel="noopener noreferrer" className={LINK}>
            المنتجات المقترحة
          </a>
        )}
      </div>
      <div className={ROW}>
        <p className="min-w-0 text-xs text-[var(--sys-muted-foreground)]">كم دقيقة بيضل الزبون يقدر يزيد على طلبه</p>
        <a href="/settings/system" target="_blank" rel="noopener noreferrer" className={LINK}>
          مدّة العرض
        </a>
      </div>

      {/*
        HOW THE TWO ARE SHOWN — «يكونو يا مع بعض يا ورا بعض» · «شريط مبروك أو عدّاد» · «اشكال الأب سيل والكروس سيل».
        The countdown is the real window above, never an invented deadline.
      */}
      <Choices
        label="ترتيب العرضين"
        value={s.afterOrderFlow}
        options={[['together', 'مع بعض'], ['sequence', 'ورا بعض']] as const}
        onPick={(v) => patch({ afterOrderFlow: v })}
      />
      <Choices
        label="شريط فوق العروض"
        value={s.afterOrderBanner}
        options={[['none', 'بلا'], ['congrats', 'مبروك'], ['countdown', 'عدّاد']] as const}
        onPick={(v) => patch({ afterOrderBanner: v })}
      />
      {s.afterOrderBanner === 'congrats' && (
        <input aria-label="نص شريط مبروك" className={FIELD} maxLength={80} value={s.afterOrderBannerText} onChange={(e) => patch({ afterOrderBannerText: e.target.value })} />
      )}
      {s.afterOrderBanner === 'countdown' && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">بيعدّ مدّة العرض الحقيقية من إعدادات النظام، ولما تخلص العروض بتختفي.</p>
      )}
      <Choices
        label="شكل الأب سيل"
        value={s.upsellLook}
        options={[['card', 'بطاقة'], ['banner', 'شريط ملوّن'], ['compact', 'سطر واحد']] as const}
        onPick={(v) => patch({ upsellLook: v })}
      />
      <Choices
        label="شكل الكروس سيل"
        value={s.crossSellLook}
        options={[['list', 'قائمة'], ['cards', 'بطاقات']] as const}
        onPick={(v) => patch({ crossSellLook: v })}
      />

      {/* The WhatsApp button after the order. */}
      <label className="flex items-center gap-2 text-xs font-semibold text-[var(--sys-heading)]">
        <input type="checkbox" checked={s.whatsappAfter} onChange={(e) => patch({ whatsappAfter: e.target.checked })} />
        زر واتساب بعد الطلب
      </label>
      {s.whatsappAfter && (
        <div className="space-y-1.5">
          <input aria-label="نص زر واتساب" className={FIELD} maxLength={40} value={s.whatsappLabel} onChange={(e) => patch({ whatsappLabel: e.target.value })} />
          <textarea
            aria-label="رسالة واتساب"
            className={FIELD}
            rows={2}
            maxLength={300}
            value={s.whatsappMessage}
            onChange={(e) => patch({ whatsappMessage: e.target.value })}
          />
          <p className="text-xs text-[var(--sys-muted-foreground)]">اكتب {'{رقم_الطلب}'} مكان ما بدك يطلع رقم الطلب.</p>
          <input
            aria-label="رقم واتساب"
            className={FIELD}
            dir="ltr"
            inputMode="tel"
            maxLength={30}
            placeholder={ctx.storePhone ? `رقم المتجر: ${ctx.storePhone}` : '+9639XXXXXXXX'}
            value={s.whatsappNumber}
            onChange={(e) => patch({ whatsappNumber: e.target.value.replace(/[^+0-9 ()-]/g, '') })}
          />
          {!number && (
            <p className="text-xs font-semibold text-[var(--sys-warning)]">ما في رقم — الزر ما رح يطلع. اكتب رقماً هون أو من إعدادات المتجر.</p>
          )}
          {/* «متى اقدر اظهر زر الواتس بعد الشراء… واتحكم بشكل الزر، اشكالو والوانو». */}
          <Choices
            label="إيمتى بيطلع الزر"
            value={when}
            options={[['now', 'فوراً'], ['end', 'آخر شي'], ['delay', 'بعد ثواني']] as const}
            onPick={(v) => patch({ whatsappWhen: v })}
          />
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            {when === 'now'
              ? 'بيطلع أول ما الطلب يمشي، فوق العروض.'
              : when === 'end'
                ? 'بيطلع تحت العروض، بعد ما الزبون يجاوب عليها (يضيف أو يقول «لا شكراً»).'
                : `بيطلع بعد ${delay} ثانية من الطلب.`}
          </p>
          {when === 'delay' && (
            <label className="flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
              عدد الثواني
              <input
                aria-label="عدد الثواني قبل ما يطلع زر واتساب"
                type="number"
                min={1}
                max={120}
                className={`${FIELD} w-20`}
                value={delay}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) patch({ whatsappDelay: Math.min(120, Math.max(1, n)) });
                }}
              />
            </label>
          )}
          <Choices
            label="شكل الزر"
            value={look}
            options={[['outline', 'إطار'], ['solid', 'لون المتجر'], ['green', 'أخضر واتساب'], ['floating', 'دائرة بالزاوية']] as const}
            onPick={(v) => patch({ whatsappLook: v })}
          />
          {look !== 'floating' && (
            <Choices
              label="الزوايا"
              value={s.whatsappShape ?? 'curved'}
              options={[['curved', 'مدوّرة'], ['pill', 'كبسولة'], ['square', 'حادّة']] as const}
              onPick={(v) => patch({ whatsappShape: v })}
            />
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--sys-foreground)]">
            <label className="flex items-center gap-1.5">
              اللون
              <input
                aria-label="لون زر واتساب"
                type="color"
                value={color || (look === 'outline' ? '#121926' : look === 'solid' ? '#b8256e' : '#25d366')}
                onChange={(e) => patch({ whatsappColor: e.target.value })}
              />
            </label>
            {color && (
              <button type="button" className={LINK} onClick={() => patch({ whatsappColor: '' })}>
                رجّع لون الشكل
              </button>
            )}
            {look !== 'floating' && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={!!s.whatsappWide} onChange={(e) => patch({ whatsappWide: e.target.checked })} />
                بعرض الشاشة
              </label>
            )}
            {look !== 'floating' && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={!!s.whatsappIcon} onChange={(e) => patch({ whatsappIcon: e.target.checked })} />
                أيقونة واتساب
              </label>
            )}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!s.whatsappPulse} onChange={(e) => patch({ whatsappPulse: e.target.checked })} />
              حركة بتلفت النظر
            </label>
          </div>
          {/* The button as the customer will see it — the same style the thank-you screen draws. */}
          <div className="rounded-md bg-[var(--sys-surface-strong)] p-2 text-center" aria-label="معاينة زر واتساب">
            <span
              style={{
                ...whatsappButtonStyle(
                  { look, shape: s.whatsappShape, wide: s.whatsappWide, color, icon: s.whatsappIcon, pulse: s.whatsappPulse },
                  true
                ),
                ...(look === 'floating' ? { position: 'static' } : { marginTop: 0 }),
              }}
            >
              {(s.whatsappIcon || look === 'floating') && <RiWhatsappLine size={look === 'floating' ? 30 : 20} aria-hidden />}
              {look !== 'floating' && <span>{s.whatsappLabel.trim() || 'أكّد طلبك على واتساب'}</span>}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--sys-foreground)]">
            <input type="checkbox" checked={s.whatsappAutoOpen} onChange={(e) => patch({ whatsappAutoOpen: e.target.checked })} />
            افتح واتساب لحاله بعد 3 ثواني من ما يطلع الزر
          </label>
          {s.whatsappAutoOpen && when !== 'end' && (
            <p className="text-xs text-[var(--sys-warning)]">الزبون بيطلع من الصفحة — عرض «زيد علبة» والمنتجات المقترحة ما رح يشوفهم. اختار «آخر شي» إذا بدك يشوفهم أول.</p>
          )}
        </div>
      )}
    </section>
  );
}
