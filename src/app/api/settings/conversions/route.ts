import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import {
  CONVERSION_TRIGGERS, VALUE_SOURCES, validateEventName, collidesWithBrowserPixel, replacesBrowserPurchase, orderEventOf,
  TRIGGER_AR, TRIGGER_HINT_AR, VALUE_SOURCE_AR, SUGGESTED_EVENT_NAMES,
  type ConversionTrigger, type ValueSource,
} from '@/lib/conversions/types';

/**
 * THE CONVERSIONS A SELLER HAS DEFINED.
 *
 * Each one says: this moment in my order lifecycle, under this name, worth
 * this number. Nothing is inferred — the right moment differs per product
 * and per shop, and a system that decided for them would be deciding what
 * they buy.
 *
 * The list carries a count of what was sent, failed and skipped, because
 * this feature's one failure mode is invisible from the outside: events
 * that stopped arriving look exactly like a quiet week.
 */

const createSchema = z.object({
  pixelId: z.string().uuid(),
  name: z.string().trim().min(2).max(60),
  eventName: z.string().trim().min(3).max(40),
  trigger: z.enum(CONVERSION_TRIGGERS),
  /**
   * NO DEFAULT HERE — the trigger decides it. See `defaultValueSource`.
   * A flat `.default('ORDER_TOTAL')` made «delivered» report the ordered
   * amount, which `conversions/types.ts` calls a lie in its own words.
   */
  valueSource: z.enum(VALUE_SOURCES).optional(),
  enabled: z.boolean().default(true),
});

/**
 * WHICH NUMBER, WHEN NOBODY PICKED ONE.
 *
 * «Conversion values sent to ad platforms use the COLLECTED amount at
 * DELIVERED, not the ordered amount.» The door defaulted every conversion to
 * `ORDER_TOTAL`, including one triggered at delivery — and the module that
 * computes the value already says exactly why that is wrong: «At delivery,
 * the collected amount is the truth and the order total is a wish… Sending
 * the total there would teach Meta that every delivery is worth full price,
 * which is the same lie the delivery-rate multiplier was invented to patch.»
 *
 * A DEFAULT and not a prohibition, because this module's whole stance is
 * informed choice: a seller who means to send the order total at delivery
 * may still say so. They just have to say it.
 *
 * Before delivery the order total IS the right figure — nothing has been
 * collected yet, so `collectedAmount` would read as the full total anyway and
 * the name would be the only thing that changed.
 */
export function defaultValueSource(trigger: ConversionTrigger): ValueSource {
  return trigger === 'order.delivered' ? 'COLLECTED_AMOUNT' : 'ORDER_TOTAL';
}

export async function GET() {
  try {
    const { companyId } = await requireCompanyTenant();
    await requirePermission('settings.view');

    const conversions = await db.customConversion.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, eventName: true, trigger: true,
        valueSource: true, enabled: true, createdAt: true,
        pixel: { select: { id: true, name: true, platform: true, pixelId: true, capiTokenHint: true } },
      },
    });

    // Counts in one query rather than one per conversion: a shop with
    // twenty conversions should not cost twenty round trips to draw a list.
    const counts = await db.conversionDelivery.groupBy({
      by: ['conversionId', 'status'],
      where: { companyId },
      _count: { _all: true },
    });

    // The worst thing a seller can be told is "it is working" when the
    // events match nobody, so the average match quality is surfaced too.
    const quality = await db.conversionDelivery.groupBy({
      by: ['conversionId'],
      where: { companyId, status: 'SENT' },
      _avg: { matchQuality: true },
    });
    const avgById = new Map(quality.map((q) => [q.conversionId, q._avg.matchQuality]));

    const statsById = new Map<string, Record<string, number>>();
    for (const row of counts) {
      const s = statsById.get(row.conversionId) ?? {};
      s[row.status] = row._count._all;
      statsById.set(row.conversionId, s);
    }

    return NextResponse.json({
      conversions: conversions.map((c) => {
        const s = statsById.get(c.id) ?? {};
        return {
          ...c,
          stats: {
            sent: s.SENT ?? 0,
            pending: s.PENDING ?? 0,
            failed: s.FAILED ?? 0,
            skipped: s.SKIPPED ?? 0,
            matchQuality: avgById.get(c.id) ?? null,
          },
        };
      }),
      // The screen draws its form from this: the moments, what each means,
      // and a suggested name for each. It should not carry its own copy.
      options: {
        triggers: CONVERSION_TRIGGERS.map((t) => ({
          value: t,
          label: TRIGGER_AR[t],
          hint: TRIGGER_HINT_AR[t],
          suggested: SUGGESTED_EVENT_NAMES[t],
        })),
        valueSources: VALUE_SOURCES.map((v) => ({ value: v, label: VALUE_SOURCE_AR[v] })),
      },
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('settings.tracking');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'البيانات غير صالحة' }, { status: 400 });
    }
    const { pixelId, name, trigger, enabled } = parsed.data;
    // The trigger decides it when nobody said. See `defaultValueSource`.
    const valueSource = parsed.data.valueSource ?? defaultValueSource(trigger);

    // Meta accepts a name with a space or an Arabic letter and then it
    // appears nowhere useful in Events Manager and cannot be selected when
    // building a custom conversion — a failure that looks like success
    // until somebody tries to use it a week later.
    const eventName = validateEventName(parsed.data.eventName);
    if (!eventName) {
      return NextResponse.json(
        { error: 'اسم الحدث: حروف إنجليزية وأرقام وشرطة سفلية فقط، يبدأ بحرف، 3 إلى 40 خانة' },
        { status: 400 }
      );
    }

    const pixel = await db.trackingPixel.findFirst({
      where: { id: pixelId, companyId },
      select: { id: true, platform: true, name: true, capiToken: true, orderEvent: true },
    });
    if (!pixel) return NextResponse.json({ error: 'البكسل غير موجود' }, { status: 404 });
    if (pixel.platform !== 'META') {
      return NextResponse.json({ error: 'واجهة التحويلات متاحة لميتا فقط حالياً' }, { status: 400 });
    }

    const existing = await db.customConversion.findFirst({
      where: { pixelId, eventName, trigger },
      select: { id: true },
    });
    if (existing) {
      // Two identical rows would send Meta the same event twice for one
      // order, and the second would be silently discarded by their own
      // deduplication — so the seller would see half of what they expected.
      return NextResponse.json({ error: 'هذا التحويل معرَّف مسبقاً على نفس البكسل' }, { status: 409 });
    }

    const created = await db.customConversion.create({
      data: { companyId, pixelId, name, eventName, trigger, valueSource, enabled, createdById: user.id },
      select: { id: true, name: true, eventName: true, trigger: true, valueSource: true, enabled: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CUSTOM_CONVERSION_CREATED',
      entity: 'CustomConversion',
      entityId: created.id,
      newData: { name, eventName, trigger, valueSource, pixel: pixel.name, by: user.name },
    });

    return NextResponse.json({
      success: true,
      conversion: created,
      // Said rather than blocked. A seller who knows what they are doing may
      // want this; one who does not would otherwise discover it as a
      // doubled return on ad spend and scale a campaign on a number that
      // was never real.
      // The one combination that is meant: the page stops sending Purchase to this pixel by itself.
      // Said only when it is TRUE: the page stands down for a pixel only while the conversion is switched on and the
      // pixel holds its token (`pixelsWithServerPurchase`). A conversion saved off, or without a token, stops nothing.
      note: replacesBrowserPurchase(eventName, trigger, orderEventOf(pixel)) && enabled && !!pixel.capiToken
        ? `الطلب صار يُحسب مرة واحدة عند تأكيد الطلب: الصفحة توقفت عن إرسال ${eventName} من المتصفح لهذا البكسل تلقائياً.`
        : null,
      warning: collidesWithBrowserPixel(eventName, trigger, orderEventOf(pixel))
        ? `«${eventName}» هو نفس اسم حدث يرسله البكسل من المتصفح. ميتا ستعدّ الاثنين، وسيتضاعف الشراء المسجَّل. اختر اسماً خاصاً ما لم تكن تقصد ذلك.`
        : pixel.capiToken
          ? null
          : 'لم يُحفظ رمز واجهة التحويلات لهذا البكسل بعد — لن يُرسَل شيء حتى تضيفه.',
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
