import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * ===========================================================================
 * «كلّ إجراء ذكاءٍ اصطناعيٍّ اقتراحٌ فقط» — مثبّتةً لا موعودة.
 * ===========================================================================
 *
 * This is the test named by the `ai-proposal-only` entry of
 * `src/lib/launch-flags.ts`. That entry is declared `INVARIANT` rather than
 * a switch precisely because this property is not a feature somebody turns
 * on — it is a claim about the code, and a claim about code that nothing
 * checks is a claim that stops being true on a Tuesday.
 *
 * The brief's own words: «every AI action is proposal-only». The report it
 * came with said this was already true by construction. It is ALMOST true,
 * and the two exceptions are the reason this file exists rather than a
 * comment:
 *
 *   1. `POST /api/ai/daily-summary` DOES write — `aiDailySummary.upsert`.
 *      That is the model's own answer, cached for the day so the screen does
 *      not pay for a second call. It is not money, not an order, not stock,
 *      not an audit row. Allowlisted BY NAME below, because an exception
 *      nobody wrote down is how the next one gets added quietly.
 *
 *   2. `POST /api/orders/ai-intake` both calls a model AND creates orders —
 *      in two mutually exclusive request modes. `{ text, dryRun }` calls
 *      OpenRouter and writes nothing; `{ parsed, confirm }` writes an order
 *      and never consults a model. The guarantee is therefore STRUCTURAL,
 *      not textual, so a regex cannot pin it and the second half of this
 *      file drives the route and watches the network instead.
 *
 * Everything else that calls a model writes nothing at all, which was
 * measured rather than assumed.
 */

// ===========================================================================
// PART A — the sweep
// ===========================================================================

/** Files that invoke a model, by call or by talking to a provider host. */
const CALLS_A_MODEL =
  /\b(aiChat|askAiAssistant|generateAiBusinessAnalysis|aiAssistedParse)\s*(?:<[^>]*>)?\s*\(/;
const PROVIDER_HOST =
  /openrouter\.ai|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|api\.deepseek\.com|api\.groq\.com/;

/** Any Prisma write, as `delegate.method`. */
const WRITE =
  /\b(?:db|tx|prisma)\.(\w+)\.(create|createMany|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/g;

/**
 * Delegates NO file that invokes a model may write, allowlist or not.
 *
 * This is the list that gives the invariant teeth. The allowlist below says
 * «this known exception is fine»; this list says «no exception is fine
 * here», and it is the one a future author cannot talk their way past with
 * one more entry. It is the money, the state machine, the stock and the
 * audit trail — the four things this business is accountable for and that
 * `invariants.md` says a suggestion is never allowed to be.
 */
const NEVER = new Set([
  // المال
  'walletMovement',
  'walletTransfer',
  'walletOpeningCount',
  'wallet',
  'dailyClosing',
  'financialTransaction',
  'expense',
  'courierStatement',
  'statementLine',
  'statementReceipt',
  'settlementMatch',
  'commissionRule',
  'commissionEntry',
  'commissionPayout',
  'commissionPeriod',
  'penalty',
  'penaltyRule',
  'payslip',
  'deliveryFee',
  'offer',
  // حالة الطلب والشحن
  'orderStatusLog',
  'orderChangeRequest',
  'orderIssue',
  'shippingBatch',
  'deliveryAttempt',
  'returnReceipt',
  'orderAddOn',
  'orderClaimHistory',
  // المخزون
  'inventoryMovement',
  'productionBatch',
  'productionBatchCost',
  'stockOpeningCount',
  'product',
  // الصلاحيات والسجل
  'auditLog',
  'role',
  'rolePermission',
  'rolePermissionDefault',
  'userPermission',
  'user',
  'customerBlock',
  'company',
  'systemSetting',
]);

/**
 * Writes that are known, deliberate and explained.
 *
 * Keyed by the path so that a NEW file which writes gets caught even if it
 * writes something already allowed somewhere else — the question is always
 * «was this one thought about», never «is this method ever acceptable».
 */
const ALLOWED: Record<string, readonly string[]> = {
  // إجابة النموذج نفسها، مخزَّنةً ليوم واحد. ليست مالاً ولا حالةً ولا مخزوناً.
  'src/app/api/ai/daily-summary/route.ts': ['aiDailySummary.upsert'],
  /*
   * بابان في ملفٍ واحد: وضعُ المعاينة يسأل النموذج ولا يكتب، ووضعُ التأكيد
   * يكتب الطلب ولا يسأل النموذج. الفصلُ بينهما مثبَّتٌ في الجزء الثاني من
   * هذا الملف — لا هنا، لأنّ تعبيراً نمطياً لا يرى تدفّق التنفيذ.
   */
  'src/app/api/orders/ai-intake/route.ts': [
    'customer.update',
    'order.create',
    'orderActivity.create',
    'orderItem.create',
  ],
};

interface Finding {
  file: string;
  writes: string[];
  settingsWrite: boolean;
}

/** Every `.ts`/`.tsx` under a root, excluding tests. */
function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p.split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/**
 * THE SCANNER, as a pure function of (path → source).
 *
 * Pure so that it can be fed a source that does not exist on disk, which is
 * what the negative tests do: a checker nobody has ever watched FAIL is not
 * a checker, it is a green tick.
 */
export function scanForAiWrites(files: Record<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, src] of Object.entries(files)) {
    if (!CALLS_A_MODEL.test(src) && !PROVIDER_HOST.test(src)) continue;
    const writes = new Set<string>();
    for (const m of src.matchAll(WRITE)) writes.add(`${m[1]}.${m[2]}`);
    if (/\$executeRaw/.test(src)) writes.add('$executeRaw');
    out.push({
      file,
      writes: [...writes].sort(),
      // `updateCompanySettings<T>(` — the generic is why a naive `\s*\(` misses it.
      settingsWrite: /updateCompanySettings\s*(?:<[^>]*>)?\s*\(/.test(src),
    });
  }
  return out;
}

/** The violations in a set of findings: a forbidden delegate, or an unexplained write. */
export function violations(findings: Finding[]): string[] {
  const bad: string[] = [];
  for (const f of findings) {
    const allowed = ALLOWED[f.file] ?? [];
    for (const w of f.writes) {
      const delegate = w.split('.')[0];
      if (NEVER.has(delegate)) {
        bad.push(`${f.file}: يكتب ${w} — وهذا ممنوع على أيّ ملفٍ يسأل نموذجاً، بلا استثناء.`);
        continue;
      }
      if (!allowed.includes(w)) {
        bad.push(`${f.file}: يكتب ${w} ولم يُشرَح. أضِفه إلى ALLOWED مع السبب، أو أزِل الكتابة.`);
      }
    }
  }
  return bad;
}

const onDisk = (): Record<string, string> =>
  Object.fromEntries(sources('src').map((f) => [f, readFileSync(f, 'utf8')]));

describe('مسحُ كلّ ما يسأل نموذجاً', () => {
  it('يجد فعلاً الملفات التي تسأل نموذجاً — وإلا فالمسح أخضرُ لأنه فارغ', () => {
    const found = scanForAiWrites(onDisk()).map((f) => f.file);
    // لو تغيّر اسمٌ أو انتقل ملفٌ، هذا يسقط قبل أن يصير المسح بلا معنى
    expect(found).toContain('src/app/api/ai/chat/route.ts');
    expect(found).toContain('src/app/api/ai/confirmation/route.ts');
    expect(found).toContain('src/app/api/ai/picking/route.ts');
    expect(found).toContain('src/app/api/ai/daily-summary/route.ts');
    expect(found).toContain('src/app/api/orders/ai-intake/route.ts');
    expect(found).toContain('src/app/api/growth/intelligence/ask/route.ts');
    expect(found.length).toBeGreaterThanOrEqual(7);
  });

  it('ولا يكتب أيٌّ منها مالاً ولا حالةً ولا مخزوناً ولا سجلّ تدقيق', () => {
    const bad = violations(scanForAiWrites(onDisk()));
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
  });

  it('وكلّ مسارٍ تحت /api/ai لا يكتب شيئاً، إلا ملخَّص اليوم وهو إجابة النموذج نفسها', () => {
    const writers = scanForAiWrites(onDisk())
      .filter((f) => f.file.startsWith('src/app/api/ai/') && f.writes.length > 0)
      .map((f) => `${f.file} -> ${f.writes.join(', ')}`);
    expect(writers).toEqual(['src/app/api/ai/daily-summary/route.ts -> aiDailySummary.upsert']);
  });
});

describe('والمسح نفسه يسقط حين يجب أن يسقط', () => {
  it('يرفض مساراً يسأل نموذجاً ثم يحرّك محفظة', () => {
    const bad = violations(
      scanForAiWrites({
        'src/app/api/ai/evil/route.ts':
          "const s = await aiChat({ job: 'x' });\nawait db.walletMovement.create({ data: {} });",
      })
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/walletMovement\.create/);
    expect(bad[0]).toMatch(/بلا استثناء/);
  });

  it('ويرفض مساراً يحرّك حالة طلب بعد سؤال النموذج', () => {
    const bad = violations(
      scanForAiWrites({
        'src/app/api/ai/evil/route.ts':
          "await askAiAssistant('q', {});\nawait db.orderStatusLog.create({ data: {} });",
      })
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/orderStatusLog/);
  });

  it('ويرفض كتابةً جديدةً غير ممنوعة لكنها غير مشروحة', () => {
    const bad = violations(
      scanForAiWrites({
        'src/app/api/ai/evil/route.ts': "await aiChat({});\nawait db.notification.create({ data: {} });",
      })
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/لم يُشرَح/);
  });

  it('ويرفض SQL خاماً بعد سؤال النموذج', () => {
    const bad = violations(
      scanForAiWrites({
        'src/app/api/ai/evil/route.ts': 'await aiChat({});\nawait db.$executeRaw`UPDATE orders SET status = 1`;',
      })
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/\$executeRaw/);
  });

  it('ويرى الملف الذي يتكلّم مع المزوّد مباشرةً بلا دالّة وسيطة', () => {
    const found = scanForAiWrites({
      'src/x.ts': "await fetch('https://api.openai.com/v1/chat/completions');\nawait db.wallet.update({});",
    });
    expect(found).toHaveLength(1);
    expect(violations(found)).toHaveLength(1);
  });

  it('ولا يشتكي من ملفٍ لا يسأل نموذجاً أصلاً، وإلا شمل نصف الشجرة', () => {
    expect(scanForAiWrites({ 'src/x.ts': 'await db.walletMovement.create({});' })).toEqual([]);
  });
});

// ===========================================================================
// PART B — البابُ الوحيد الذي يسأل نموذجاً ويكتب: والفصلُ بينهما مثبَّت
// ===========================================================================

/**
 * `POST /api/orders/ai-intake` is the only file in the tree that both calls
 * a model and creates an order, so it is the only place the invariant could
 * actually break without anybody noticing. The regex above cannot see it:
 * both halves are in one file and the separation is control flow.
 *
 * So the route is DRIVEN. `fetch` is replaced with a spy, the API key is
 * present so the model path is live, and:
 *
 *   • the confirm request creates an order and the spy is never called;
 *   • the preview request calls the spy and writes nothing.
 *
 * The second half is the positive control, and it is not decoration: a spy
 * that is broken, or a key that is missing, would make the first assertion
 * pass for the wrong reason — «the model was not called» because the model
 * can never be called. A negative test whose subject is unreachable proves
 * nothing, and that is the commonest way a guard like this is faked.
 */

const { db, requireContext, requirePermission, logAudit, notify, findOrCreateCustomer, productCost, resolveRegionId, orderRefFields, activeBlock, activeOffersFor } =
  vi.hoisted(() => ({
    db: {
      product: { findFirst: vi.fn(), findMany: vi.fn() },
      /*
       * The AI door now asks the store what its prices mean — it wrote
       * nothing before, so every order through it took the schema default
       * `false` and the shipment added a fee to a delivery-inclusive
       * price. A store that answers «no» keeps these fixtures saying
       * exactly what they said.
       */
      store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
      user: { findFirst: vi.fn() },
      /*
       * THE TWO ROWS THAT DECIDE WHICH MODEL IS ASKED.
       *
       * `ai-intake` no longer reaches a vendor by reading an environment
       * key: it goes through `aiChat`, which asks `routeFor`, which reads
       * the installation's own setting first and the company's second. A
       * double without them routes to nothing and the whole section below
       * would pass by asking no model at all.
       */
      company: { findUnique: vi.fn() },
      systemSetting: { findUnique: vi.fn() },
      order: { create: vi.fn() },
      orderItem: { create: vi.fn() },
      customer: { update: vi.fn(), findFirst: vi.fn() },
      orderActivity: { create: vi.fn() },
      // The opening row of the state history, which this door now writes
      // beside the order — see `an-order-and-its-lines-are-one-write`.
      orderStatusLog: { create: vi.fn() },
      /*
       * THE DOUBLE IS GIVEN THE TRANSACTION, NOT THE CODE A WAY AROUND IT.
       *
       * `ai-intake` writes the order, its line, the customer's counters, the
       * activity and the opening state row in ONE transaction, because a
       * failure between the first two leaves a LINELESS ORDER — the one shape
       * no money rule in this product can price.
       *
       * So the fake hands the same object back as the transaction client, the
       * way six other doubles in this repository already do. The alternative
       * was to accommodate the fake by splitting the writes again, and that
       * is the mistake this repository has a name for: a test double is not a
       * reason to make the product worse.
       */
      $transaction: vi.fn(async (fn: unknown) =>
        typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
      ),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    findOrCreateCustomer: vi.fn(),
    productCost: vi.fn(),
    resolveRegionId: vi.fn(),
    orderRefFields: vi.fn(),
    activeBlock: vi.fn(),
    activeOffersFor: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  /*
   * `can` answers «does this account keep the orders it enters?»
   * (`entryOwnership`). False: these tests are about the money and the
   * payload, and an entry that goes to the pull queue is what every
   * one of them has always asserted. `order-entry-ownership.test.ts`
   * owns the rule itself.
   */
  can: () => false, requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/customer-identity', () => ({ findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a) }));
vi.mock('@/lib/product-cost', () => ({ productCost: (...a: unknown[]) => productCost(...a) }));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: (...a: unknown[]) => orderRefFields(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: (...a: unknown[]) => activeOffersFor(...a) }));

const { POST } = await import('@/app/api/orders/ai-intake/route');

/** Every call the route made to the outside world. */
let calledHosts: string[];
const realFetch = globalThis.fetch;

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/orders/ai-intake', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  calledHosts = [];

  /*
   * المفتاحُ موجودٌ عن قصدٍ — وهو الآنَ شاهدٌ أقوى ممّا كان.
   *
   * قبلاً كان وجودُه يَعني أنّ البابَ سيَسألُ OpenRouter. الآنَ البابُ
   * يَشترطُ نموذجاً محلّيّاً، فبقاءُ المفتاحِ يُثبِتُ أنّ وجودَه **لا
   * يَكفي**: لولاه لَما عَرَفنا هل الطريقُ سَكتَ لأنّه رَفضَ المزوّد أم
   * لأنّه لم يَجدْ مفتاحاً أصلاً.
   */
  process.env.OPENROUTER_API_KEY = 'test-key-not-a-real-one';

  /*
   * والتثبيتُ: نموذجٌ محلّيٌّ على 11434 — وهو ما يَجعلُ الشاهدةَ أدناه
   * تَضربُ عنواناً على جهازِ المالكِ لا عنوانَ مزوّد.
   */
  db.company.findUnique.mockResolvedValue({ settings: null });
  db.systemSetting.findUnique.mockResolvedValue({
    value: JSON.stringify({ provider: 'LOCAL', localBaseUrl: 'http://localhost:11434' }),
  });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calledHosts.push(String(input instanceof Request ? input.url : input));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ customerName: 'سامر', phone: '0999111222', quantity: 1 }) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف', role: 'ADMIN' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'sy',
    country: { orderPrefix: 'SY', minorUnit: 0, currencyCode: 'SYP', allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue(undefined);
  activeBlock.mockResolvedValue(null);
  findOrCreateCustomer.mockResolvedValue({ id: 'cust1', city: 'حلب', firstOrderDate: null });
  db.product.findFirst.mockResolvedValue({ id: 'p1', companyId: 'c1', name: 'منتج', basePrice: 100, image: null, batches: [] });
  db.product.findMany.mockResolvedValue([{ id: 'p1', name: 'منتج', sku: 'SKU1' }]);
  db.customer.findFirst.mockResolvedValue(null);
  productCost.mockResolvedValue({ average: 40 });
  orderRefFields.mockResolvedValue({ merchantReference: 'SY-1' });
  resolveRegionId.mockResolvedValue('r1');
  activeOffersFor.mockResolvedValue([]);
  db.order.create.mockResolvedValue({ id: 'o1', source: 'AI Intake' });
  db.orderItem.create.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

describe('ai-intake — الوضعُ الذي يكتب لا يسأل نموذجاً', () => {
  it('ينشئ الطلب ولا يلمس أيّ مزوّد', async () => {
    const res = await post({
      confirm: true,
      parsed: {
        customerName: 'سامر الأحمد',
        phone: '0999111222',
        address: 'شارع',
        governorate: 'حلب',
        productId: 'p1xxxxxxxxxx',
        quantity: 2,
        finalPrice: 200,
      },
    });

    expect(res.status).toBe(200);
    expect(db.order.create).toHaveBeenCalledTimes(1);
    // هذا هو بيت القصيد: لا طلبَ شبكيّ واحد إلى نموذج في المسار الكاتب
    expect(calledHosts).toEqual([]);
  });

  it('ولا يسأل نموذجاً حتى حين يُدسُّ نصٌّ مع التأكيد', async () => {
    await post({
      confirm: true,
      text: 'اسمي سامر ورقمي 0999111222 وبدي منتج',
      parsed: {
        customerName: 'سامر الأحمد',
        phone: '0999111222',
        productId: 'p1xxxxxxxxxx',
        quantity: 1,
        finalPrice: 100,
      },
    });
    expect(calledHosts).toEqual([]);
  });

  it('وحين يُرفض المدخل لا يكتب ولا يسأل', async () => {
    const res = await post({ confirm: true, parsed: { customerName: 'x', phone: '1' } });
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(calledHosts).toEqual([]);
  });
});

describe('ai-intake — الوضعُ الذي يسأل النموذج لا يكتب', () => {
  it('يسأل النموذجَ المحلّيَّ فعلاً — هذه هي الشاهدة على أنّ الجاسوس يعمل', async () => {
    /*
     * العنوانُ مُطابَقٌ بالكامل لا بـ«يحتوي».
     *
     * «يحتوي» كانت تَمُرُّ لو ضَربَ البابُ العنوانَ المحلّيَّ **و** مزوّداً
     * خارجيّاً في النداءِ نفسِه — وهذا بالضبطِ العطبُ الذي يَحرُسُه هذا
     * الملفّ. المصفوفةُ كلُّها تُقارَن، فنداءٌ ثانٍ إلى أيِّ مكانٍ يُسقِطُها.
     */
    const res = await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    expect(res.status).toBe(200);
    expect(calledHosts).toEqual(['http://localhost:11434/v1/chat/completions']);
    expect((await res.json()).engine).toBe('ai');
  });

  it('ولا يُرسِلُ شيئاً إذا لم يكن النموذجُ محلّيّاً — ومفتاحُ البيئةِ موجود', async () => {
    /*
     * الحالةُ التي كانت تُسرِّب: لا إعدادَ تثبيتٍ إطلاقاً، ومفتاحُ
     * `OPENROUTER_API_KEY` في البيئة. الكودُ القديمُ كان يَقرأُ المفتاحَ
     * ويُرسِلُ نصَّ الطلبِ كلَّه — بالاسمِ والهاتفِ والعنوان — إلى
     * OpenRouter على نموذجٍ مجّانيٍّ افتراضاً.
     */
    db.systemSetting.findUnique.mockResolvedValue(null);

    const res = await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    const body = await res.json();

    expect(calledHosts, 'خرجَ نداءٌ وفيه بياناتُ زبون').toEqual([]);
    expect(body.engine).toBe('deterministic');
    expect(body.aiSkipped).toBe('NOT_LOCAL');
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('ولا حتى لو وُجِّهَ مستخرجُ الطلباتِ وحدَه إلى مزوّدٍ خارجيٍّ بمفتاحِه', async () => {
    /*
     * الطريقُ لكلِّ مساعدٍ على حدة: الشركةُ تَضبطُ `order_intake` على
     * OPENAI بمفتاحِها الخاصّ، بينما التثبيتُ محلّيّ. الرفضُ يَقرأُ طريقَ
     * **هذا المساعدِ** لا الطريقَ العامّ — وإلا لَمرَّ.
     */
    db.company.findUnique.mockResolvedValue({
      settings: JSON.stringify({
        ai: {
          assistants: { order_intake: { provider: 'OPENAI' } },
          keys: { OPENAI: { enc: 'not-a-real-encrypted-key' } },
        },
      }),
    });

    const res = await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    const body = await res.json();

    expect(calledHosts, 'خرجَ نداءٌ إلى مزوّدٍ خارجيٍّ ومعه بياناتُ زبون').toEqual([]);
    expect(body.aiSkipped).toBe('NOT_LOCAL');
    expect(body.engine).toBe('deterministic');
  });

  it('ولا لخادمٍ متوافقٍ مع OpenAI بمفتاحه وعنوانه المحفوظَين — خارجيٌّ دائماً', async () => {
    /*
     * كلُّ شيءٍ سليم: عنوانٌ https عامّ، ومفتاحٌ مربوطٌ بعنوانه، والمساعدُ
     * موجَّهٌ إليه. ومع ذلك لا يخرجُ نداءٌ — لأنّ هذا المزوّد خارجيٌّ ولا
     * يوجد مفتاحٌ «هذا خادمي» يجعله غير ذلك. غيابُ ذلك المفتاح هو الشاهد.
     */
    const { encryptSecret } = await import('@/lib/secrets');
    process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
    db.systemSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        provider: 'OPENAI_COMPATIBLE',
        compat: { baseUrl: 'https://models.example.com/v1', model: 'glm-4.6' },
        keys: { OPENAI_COMPATIBLE: { enc: encryptSecret('test-compat-key-0001'), url: 'https://models.example.com/v1' } },
      }),
    });

    const res = await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    const body = await res.json();

    expect(calledHosts, 'خرجَ نداءٌ وفيه بياناتُ زبون إلى خادمٍ خارجيّ').toEqual([]);
    expect(body.aiSkipped).toBe('NOT_LOCAL');
    expect(body.engine).toBe('deterministic');
    expect(db.order.create).not.toHaveBeenCalled();
    delete process.env.APP_ENCRYPTION_KEY;
  });

  it('ولا يكتب شيئاً وهو يسأل', async () => {
    await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.orderItem.create).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('وإذا سقط النموذجُ المحلّيُّ يرجع إلى المحلّل الحتمي، ولا يكتب أيضاً', async () => {
    globalThis.fetch = vi.fn(async () => {
      calledHosts.push('boom');
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await post({ text: 'اسمي سامر ورقمي 0999111222 وبدي منتج واحد' });
    expect(res.status).toBe(200);
    expect((await res.json()).engine).toBe('deterministic');
    expect(db.order.create).not.toHaveBeenCalled();
  });
});
