import { NextResponse } from 'next/server';
import { tooManyAiCalls } from '@/lib/ai-rate';
import { capReachedResponse } from '@/lib/ai-spend';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { allowedScopes, scopeContext, scopeProductStats } from '@/lib/ai-scope';
import { assistantByKey, scopesOf, type AiScope } from '@/lib/ai-assistants';
import type { SessionUser } from '@/types/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { customerFacts } from '@/lib/customer-insights';
import { aiChat, AiEndpointMissing, AiNotConfigured, aiSettings, providerInfo } from '@/lib/ai-provider';
import { getCompanyAnalytics } from '@/lib/analytics';
import { teamPerformance } from '@/lib/team-performance';

/**
 * POST /api/growth/intelligence/ask — ask the AI about THIS company.
 *
 * The findings on the screen are rule-based and carry their evidence, which
 * is what makes them checkable. The AI does not replace them: it is handed
 * the same numbers and asked to read across them, and it is told — in the
 * strongest terms the prompt allows — never to invent a figure.
 *
 * That is why the context is assembled here and not chosen by the caller.
 * A question is free text; the data it may see is not.
 */

const schema = z.object({
  question: z.string().trim().min(3).max(2000),
  /** Which slices to hand it. Fewer means a cheaper, sharper answer. */
  sources: z.array(z.enum(['SALES', 'PRODUCTS', 'TEAM', 'CUSTOMERS'])).min(1).max(4).optional(),
});

/** What the AI can be given, named so the screen can list it honestly. */
export const DATA_SOURCES = [
  { id: 'SALES', label: 'المبيعات والأرباح', detail: 'الإيراد والتكاليف والهوامش ونِسب التأكيد والتوصيل' },
  { id: 'PRODUCTS', label: 'المنتجات', detail: 'أداء كل منتج: طلبات، مؤكد، موصَّل، مرفوض، ربح' },
  { id: 'TEAM', label: 'أداء الفريق', detail: 'موظفو التأكيد: ما سحبوه وأكّدوه وأزمنتهم' },
  {
    id: 'CUSTOMERS',
    label: 'العملاء',
    // Said plainly on the screen, because «العملاء» could be read as the
    // book itself. It is counts and rates — never a name, a phone or an
    // address. Nothing worth asking a model needs to know who somebody is.
    detail: 'أعداد ونِسب فقط: من طلب، من كرّر، من رفض، والمحافظات — بلا أسماء ولا أرقام',
  },
] as const;

type SourceId = (typeof DATA_SOURCES)[number]['id'];

/**
 * WHAT THIS PERSON MAY HAND THE MODEL — decided here, per source.
 *
 * Every source used to travel with «استخدام المساعد الذكي» alone. A
 * confirmation agent on «العملاء» could tick «المبيعات والأرباح» and «أداء
 * الفريق» and ask what the company made and who her weakest colleague is,
 * and be told. And the ticks the owner sets for «مركز الذكاء» in AI settings
 * — whose row promises «لا يقرأ إلا المجالات التي تؤشّرها أنت» — were stored
 * and never read.
 *
 * Now each source has its own condition, all of them on THIS person's keys
 * (role + their exceptions, as every check here is):
 *   • sales, products, team: the intelligence centre's key, AND the scope
 *     ticked by the owner, AND the person's own key for it — money with
 *     «عرض المالية», a colleague's numbers with a key of a screen that
 *     already shows them;
 *   • customers: the address book's key. Counts only, as before.
 */
function sourcePlan(user: SessionUser, ownerTicks: AiScope[]) {
  const intel = assistantByKey('intelligence')!;
  const ticked = scopesOf(intel, ownerTicks);
  const mine = allowedScopes(['orders', 'finance', 'team'], (p) => can(user, p));
  const allowed = ticked.filter((s) => mine.includes(s));
  const centre = can(user, 'growth.intelligence');
  const why = (scope: AiScope): string | null => {
    if (!centre) return 'يحتاج «مركز الذكاء»';
    if (!ticked.includes(scope)) return 'غير مؤشَّر في إعدادات الذكاء — مركز الذكاء';
    if (!mine.includes(scope)) return 'غير متاح لصلاحيتك';
    return null;
  };
  const withheld: Partial<Record<SourceId, string>> = {};
  const sales = why('orders');
  if (sales) withheld.SALES = sales;
  if (sales) withheld.PRODUCTS = sales;
  const team = why('team');
  if (team) withheld.TEAM = team;
  if (!can(user, 'customers.view') && !can(user, 'customers.view_basic')) withheld.CUSTOMERS = 'يحتاج «عرض العملاء»';
  return { allowed, withheld };
}

export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('ai.use');
    const settings = await aiSettings(companyId);
    const { withheld } = sourcePlan(user, settings.intelligenceScopes);
    return NextResponse.json({
      provider: providerInfo(settings.provider).label,
      model: settings.model,
      ready: settings.hasKey,
      // The house prompt is the owner's wording, written in settings — the
      // settings key reads it, not everyone who may ask a question.
      housePrompt: can(user, 'settings.view') ? settings.prompt : '',
      // Only what this person may tick; what is held back, and why, beside it.
      sources: DATA_SOURCES.filter((s) => !withheld[s.id]),
      withheld: DATA_SOURCES.filter((s) => withheld[s.id]).map((s) => ({ id: s.id, label: s.label, why: withheld[s.id] })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ai.use');
    const limited = tooManyAiCalls('ask', companyId, user.id);
    if (limited) return limited;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'اكتب سؤالاً أولاً' }, { status: 400 });
    }
    const settingsBefore = await aiSettings(companyId);
    const { allowed, withheld } = sourcePlan(user, settingsBefore.intelligenceScopes);
    const asked = new Set<SourceId>(parsed.data.sources ?? ['SALES', 'PRODUCTS', 'TEAM', 'CUSTOMERS']);
    const want = new Set([...asked].filter((id) => !withheld[id]));
    const notRead = [...asked].filter((id) => withheld[id]);
    if (want.size === 0) {
      const msg = `ما في مصدر متاح لهالسؤال: ${notRead.map((id) => `${DATA_SOURCES.find((s) => s.id === id)!.label} (${withheld[id]})`).join('، ')}.`;
      return NextResponse.json({ error: msg, errorAr: msg, withheld: notRead }, { status: 403 });
    }

    const analytics = await getCompanyAnalytics({ companyId, storeId }, { period: '30d' });
    const context: Record<string, unknown> = { currency: country.currencyCode, window: 'آخر 30 يوماً' };

    // Through the same closed maps as the bubble: money only when the finance
    // scope survived, the best moderator only when the team scope did.
    if (want.has('SALES')) context.sales = scopeContext(analytics.aiContext, allowed).context;
    if (want.has('PRODUCTS')) {
      // Trimmed: the whole table is mostly zeros and costs tokens to say so.
      context.products = scopeProductStats((analytics.productStats ?? []).slice(0, 15), allowed);
    }
    if (want.has('TEAM')) {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 864e5);
      const team = await teamPerformance({
        companyId,
        storeId,
        calendar: {
          workHoursStart: country.workHoursStart,
          workHoursEnd: country.workHoursEnd,
          weekendDays: country.weekendDays,
          timezone: country.timezone,
        },
        start,
        end,
      });
      context.team = team.employees;
    }
    if (want.has('CUSTOMERS')) {
      /**
       * The same figures the customers screen shows above its list — one
       * function, so the assistant cannot be told a different story from
       * the one the seller is reading.
       *
       * Only the counters are selected. A name or a phone number has no
       * place in a question about patterns, and a model is the last place
       * to send one.
       */
      const rows = await db.customer.findMany({
        where: { companyId, ...(storeId ? { storeId } : {}) },
        select: {
          city: true,
          totalOrders: true,
          deliveredOrders: true,
          cancelledOrders: true,
          totalPurchaseValue: true,
          lastOrderDate: true,
        },
      });
      const facts = customerFacts(rows, new Date());
      context.customers = { ...facts, cities: facts.cities.slice(0, 10) };
    }

    const system = [
      'أنت محلل أعمال للتجارة الإلكترونية بالدفع عند الاستلام.',
      'أجب بالعربية، بإيجاز، وبما يمكن تنفيذه.',
      'قاعدة قاطعة: لا تخترع أي رقم. استعمل الأرقام المعطاة حرفياً، وإن لم تكن البيانات كافية قل ذلك صراحةً.',
      'ميّز دائماً بين الطلب (طلبات) والربح الحقيقي (إيراد الموصَّل ناقص التكاليف).',
    ].join('\n');

    const answer = await aiChat({
      companyId,
      // «مركز الذكاء» in AI settings routes THIS door — the screen says
      // «بيروح على: …» beside that row, and it used to go to the default.
      job: 'advisor',
      system,
      user: `البيانات:\n${JSON.stringify(context, null, 2)}\n\nالسؤال: ${parsed.data.question}`,
    });

    const settings = settingsBefore;
    return NextResponse.json({
      answer,
      model: settings.model,
      provider: providerInfo(settings.provider).label,
      sources: [...want],
      // Said, not dropped in silence: an answer read from less than was asked.
      ...(notRead.length
        ? {
            noteAr: `ما قُرئ: ${notRead.map((id) => `${DATA_SOURCES.find((s) => s.id === id)!.label} (${withheld[id]})`).join('، ')}.`,
          }
        : {}),
    });
  } catch (error) {
    // Over the daily or monthly ceiling: a sentence, not a 500.
    const capped = capReachedResponse(error);
    if (capped) return capped;
    if (error instanceof AiEndpointMissing) {
      return NextResponse.json(
        {
          error: 'مركز الذكاء موجَّه لنموذج على خادمك، وعنوانه لسا ما انضبط — إعدادات الذكاء ← المساعدون.',
          code: 'AI_ENDPOINT_MISSING',
        },
        { status: 409 }
      );
    }
    if (error instanceof AiNotConfigured) {
      return NextResponse.json(
        {
          error: 'لم يُضبط الذكاء الاصطناعي بعد — اختر المزوّد وأدخل المفتاح من إعدادات الذكاء الاصطناعي.',
          code: 'AI_NOT_CONFIGURED',
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message.startsWith('AI_HTTP_')) {
      /*
       * The thrown message is now `AI_HTTP_<status>|<model>|<what the
       * vendor said>`, so only the status is read out. Pasting the whole
       * thing into an Arabic sentence would put a vendor's JSON — or its
       * HTML error page — in front of the person asking a question.
       */
      const status = error.message.match(/^AI_HTTP_(\d+)/)?.[1] ?? '';
      return NextResponse.json(
        {
          error: `رفض المزوّد الطلب (${status}) — تحقّق من المفتاح واسم النموذج.`,
          code: `AI_HTTP_${status}`,
        },
        { status: 502 }
      );
    }
    return apiErrorResponse(error);
  }
}
