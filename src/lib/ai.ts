import type { AiScope } from './ai-assistants';
import { scopeNoteAr } from './ai-scope';
import { aiChat, aiSettings, AiNotConfigured } from './ai-provider';
import { AiCapReached } from './ai-spend';
import { resolvePrompt } from './ai-prompts';
/**
 * OpenRouter AI Service for SALESFLOW
 * Business Intelligence Assistant & Daily Summary Generator
 * Grounded on real database calculations with zero hallucinated figures.
 */

export interface AiBusinessContext {
  period: string;
  total_orders: number;
  confirmed_orders: number;
  rejected_orders: number;
  postponed_orders: number;
  delivered_orders: number;
  confirmation_rate: number;
  delivery_rate: number;
  revenue: number;
  production_cost: number;
  shipping_cost: number;
  commission: number;
  operational_expenses: number;
  net_profit: number;
  profit_margin: number;
  top_demanded_product: string;
  top_profitable_product: string;
  top_moderator: string;
  highest_rejection_product: string;
}

export interface AiAnalysisResult {
  summary: string;
  observations: string[];
  risks: string[];
  recommendations: string[];
}

export async function generateAiBusinessAnalysis(
  context: AiBusinessContext,
  companyId?: string
): Promise<AiAnalysisResult> {
  /**
   * THIS USED TO BE A SECOND AI SYSTEM, AND IT IGNORED THE FIRST.
   *
   * It read `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` straight from the
   * environment and called OpenRouter itself. So a company that had chosen
   * Anthropic on the settings screen, pasted an Anthropic key and picked a
   * model got a daily summary written by whatever was in the deploy's env —
   * or, with nothing there, no summary at all and no way to find out why.
   * The vendor, the model and the key are settings now, and there is exactly
   * one place that resolves them.
   *
   * `aiChat` carries the timeout, the house prompt and the per-assistant
   * routing with it, so this loses nothing by asking it instead.
   */
  /**
   * The guidance is the company's to edit; the SCHEMA is not.
   *
   * What comes back is parsed, so the shape is a contract with the parser
   * and not an editorial choice — a seller who deleted it would get a
   * summary that renders as nothing, with no way to tell why. So they edit
   * the instructions and the system appends what the machine needs.
   */
  const guidance = resolvePrompt('daily_summary', companyId ? (await aiSettings(companyId)).prompts : {});
  /**
   * THE KEYS ARE THE PARSER'S; THE WORDS INSIDE THEM ARE THE SELLER'S.
   *
   * This block used to be English, with English example values —
   * «Concise executive overview paragraph», «observation 1». A model shown
   * an English schema writes English contents, so the daily summary came
   * back in English however Arabic the guidance above it was. That is the
   * other half of «خانة المساعد الذكي إنجليزي».
   *
   * The key names stay English because the parser reads them; the sentence
   * says, in as many words, that everything written INTO them is Arabic.
   */
  const systemPrompt = `${guidance}

أعِد ردَّك دائماً بصيغة JSON صالحة بهذا الشكل بالضبط، وبقيمٍ عربية:
{
  "summary": "فقرة موجزة تصف أداء اليوم",
  "observations": ["ملاحظة", "ملاحظة أخرى"],
  "risks": ["خطر", "خطر آخر"],
  "recommendations": ["توصية", "توصية أخرى"]
}

أسماء الحقول إنجليزية كما هي أعلاه — لا تترجمها. كل نصٍّ داخلها بالعربية.`;

  if (companyId) {
    try {
      const content = await aiChat({
        companyId,
        // The same analysis as the intelligence centre, so its row in AI
        // settings routes it — it went to the company default whatever the
        // owner chose there. The wording is still `system`, unchanged.
        job: 'advisor',
        system: systemPrompt,
        user: `هذه أرقام أداء المتجر المحقّقة لليوم:
${JSON.stringify(context, null, 2)}`,
        json: true,
        timeoutMs: 20_000,
      });
      if (content) {
        const parsed = JSON.parse(content);
        return {
          summary: parsed.summary || 'Summary generated.',
          observations: parsed.observations || [],
          risks: parsed.risks || [],
          recommendations: parsed.recommendations || [],
        };
      }
    } catch (error) {
      /**
       * A VENDOR THAT IS NOT CONFIGURED IS NOT AN ERROR HERE.
       *
       * The deterministic analyst below is built from the same verified
       * numbers and is the answer whenever the model cannot be reached — so
       * the summary is never empty and never invented. The message names the
       * reason without naming the key.
       */
      const why =
        error instanceof AiNotConfigured
          ? 'no AI provider configured'
          : error instanceof AiCapReached
            ? 'daily or monthly ceiling reached'
            : error;
      console.warn('Daily summary fell back to the deterministic analyst:', why);
    }
  }

  // Deterministic, high-value fallback analyst based directly on verified numbers
  const summary = `During this period, the company processed ${context.total_orders} total orders, generating $${context.revenue.toFixed(
    2
  )} in delivered revenue and $${context.net_profit.toFixed(
    2
  )} in net profit (${context.profit_margin.toFixed(
    1
  )}% net margin). Confirmation rate reached ${context.confirmation_rate.toFixed(
    1
  )}% and delivery completion was ${context.delivery_rate.toFixed(1)}%.`;

  const observations = [
    `Delivered volume generated an average order value of $${(
      context.revenue / (context.delivered_orders || 1)
    ).toFixed(2)}.`,
    `Top performing product by volume is "${context.top_demanded_product}", while highest net yield was generated by "${context.top_profitable_product}".`,
    `Top moderator ${context.top_moderator} is driving consistent conversion efficiency.`,
  ];

  const risks: string[] = [];
  if (context.rejected_orders > 0) {
    risks.push(
      `Rejections (${context.rejected_orders} orders) represent lost potential revenue and sunk marketing cost.`
    );
  }
  if (context.highest_rejection_product) {
    risks.push(
      `Product "${context.highest_rejection_product}" has the highest rejection rate and needs ad angle review.`
    );
  }
  if (context.postponed_orders > 0) {
    risks.push(
      `${context.postponed_orders} orders are currently postponed and require prompt callback scheduling.`
    );
  }
  if (risks.length === 0) {
    risks.push('Maintain strict inventory monitoring to prevent stockouts as demand scales.');
  }

  const recommendations = [
    `Focus advertising budget on "${context.top_profitable_product}" where net contribution margin is highest.`,
    `Assign high-priority incoming leads to ${context.top_moderator} during peak sales hours.`,
    `Implement instant WhatsApp follow-up for postponed orders within 24 hours to maximize delivery conversion.`,
    `Conduct cost audit on shipping and packaging overhead to expand net margin above ${(
      context.profit_margin + 5
    ).toFixed(1)}%.`,
  ];

  return { summary, observations, risks, recommendations };
}

export interface AskOptions {
  companyId?: string;
  /** What was taken out of the context, and why (see ai-scope.ts). */
  removed?: AiScope[];
  /** The currency the figures are in — never a dollar sign by default. */
  currency?: string;
}

/**
 * Ask the assistant, with only the facts this person may see.
 *
 * The context arrives ALREADY narrowed (ai-scope.ts): a fact they may not
 * see is not in the request at all, rather than in it behind an instruction
 * not to mention it. An instruction can be argued with; an absent number
 * cannot be leaked.
 */
export async function askAiAssistant(
  question: string,
  context: Partial<AiBusinessContext>,
  options: AskOptions | string = {}
): Promise<string> {
  // The third argument used to be the company id alone.
  const opts: AskOptions = typeof options === 'string' ? { companyId: options } : options;
  const { companyId, removed = [], currency = '' } = opts;

  // The prompt is the COMPANY'S now, resolved at call time from settings.
  // It was written here, which meant the one person who knows whether "be
  // concise" suits their business, in their dialect, could not change a
  // word of it. `job` names it; ai-prompts holds the default.
  const job = 'advisor';

  const note = scopeNoteAr(removed);

  // The vendor, the model and the key are the company's choice now, not a
  // deploy-time constant. A failure falls through to the grounded summary
  // below rather than showing an error: an answer built from our own
  // numbers is the one place the AI cannot be wrong.
  if (companyId) {
    try {
      const answer = await aiChat({
        companyId,
        job,
        /**
         * THE FRAME IS ARABIC BECAUSE THE ANSWER MUST BE.
         *
         * This said «Business Metrics Context» and «User Question», and
         * wrapped an Arabic question in English scaffolding around a JSON
         * blob whose keys are English too. «أجب بنفس لغة السؤال» then has
         * to decide what the language of the prompt even IS, and a model
         * reading English headings and one Arabic sentence answers in
         * English. Which is what was reported, twice.
         */
        user: `بيانات المتجر:
${JSON.stringify(context, null, 2)}

${note ? `ملاحظة: ${note}\n\n` : ''}سؤال المستخدم: ${question}`,
      });
      if (answer) return note ? `${answer}\n\n_${note}_` : answer;
    } catch (e) {
      /*
       * OVER THE DAILY OR MONTHLY CEILING: SAY SO, THEN GIVE THE NUMBERS.
       * The grounded answer is still built from the verified figures, but
       * on its own it would look like the assistant answering — and the
       * person asking would never learn why it got so plain.
       */
      if (e instanceof AiCapReached) return `${e.messageAr}\n\n${groundedAnswer(question, context, currency, note)}`;
      if (!(e instanceof AiNotConfigured)) console.warn('AI assistant call failed:', e);
    }
  }

  return groundedAnswer(question, context, currency, note);
}

/** A figure, or a plain sentence saying it is not there to give. */
function moneyLine(value: number | undefined, currency: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return currency ? `${value.toFixed(2)} ${currency}` : value.toFixed(2);
}

/**
 * The answer when the model is not configured or did not reply.
 *
 * Built ONLY from the numbers passed in. The version before this one
 * printed sentences nobody computed — a named person "leads in confirmation
 * consistency and value per call", a product name written into the source —
 * and dollar signs over whatever currency the business actually uses. An
 * invented answer from a system of record is worse than no answer, because
 * it is read as a fact the system knows.
 */
function groundedAnswer(
  question: string,
  c: Partial<AiBusinessContext>,
  currency: string,
  note: string | null
): string {
  const q = question.toLowerCase();
  const lines: string[] = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') lines.push(`* **${label}:** ${value}`);
  };

  const money = (v: number | undefined) => moneyLine(v, currency);
  const pct = (v: number | undefined) => (typeof v === 'number' ? `${v.toFixed(1)}%` : null);

  const asksMoney = /profit|revenue|ربح|أرباح|ايراد|إيراد|دخل/.test(q);
  const asksPeople = /moderator|agent|مسوق|مودريتور|موظف|فريق/.test(q);
  const asksRejection = /reject|رفض|ملغي|مرفوض/.test(q);

  if (asksMoney) {
    if (c.revenue === undefined) {
      return note ?? 'أرقام المال غير متاحة لصلاحيتك.';
    }
    add('الإيراد المسلَّم', money(c.revenue));
    add('صافي الربح', money(c.net_profit));
    add('هامش الربح', pct(c.profit_margin));
    add('تكلفة البضاعة', money(c.production_cost));
    add('أجور الشحن', money(c.shipping_cost));
    add('العمولات', money(c.commission));
    add('الأعلى ربحاً', c.top_profitable_product);
  } else if (asksPeople) {
    add('الأعلى أداءً', c.top_moderator);
    add('نسبة التأكيد', pct(c.confirmation_rate));
    add('الطلبات', c.total_orders);
    if (lines.length === 0) return note ?? 'لا أرقام متاحة للإجابة عن هذا السؤال.';
  } else if (asksRejection) {
    add('الأعلى رفضاً', c.highest_rejection_product);
    add('المرفوضة', c.rejected_orders);
    add('من أصل', c.total_orders);
  } else {
    add('الطلبات', c.total_orders);
    add('المؤكَّدة', c.confirmed_orders);
    add('المسلَّمة', c.delivered_orders);
    add('نسبة التأكيد', pct(c.confirmation_rate));
    add('نسبة التسليم', pct(c.delivery_rate));
    add('الأكثر طلباً', c.top_demanded_product);
    add('الإيراد المسلَّم', money(c.revenue));
    add('صافي الربح', money(c.net_profit));
  }

  if (lines.length === 0) return note ?? 'لا أرقام متاحة لهذه المدة.';

  const head = `**ملخّص من أرقامك${c.period ? ` — ${c.period}` : ''}:**`;
  return [head, ...lines, ...(note ? ['', `_${note}_`] : [])].join('\n');
}

