import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { numeric } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { currencyLabel } from '@/lib/currencies';
import { companyCurrencyCodes, readRateTable, saveManualRates } from '@/lib/exchange-rates';
import { NEVER_FROM_A_SOURCE, STALE_SENTENCE, effectiveRate, missingRateSentence, normCode } from '@/lib/exchange-rates-core';

/**
 * «أسعار الصرف» (23/11, F8) — THE RATES A PARTNER'S DRAW IS CONVERTED AT.
 *
 *   GET  /api/finance/exchange-rates   every currency the company uses: today's rate, where it came from, its date, and the owner's
 *                                      typed rate; plus the two sides as stored (the wallet dialog converts with the same function)
 *   PUT  /api/finance/exchange-rates   save the owner's typed rates: `{ rates: [{ code, perUsd }] }`, `perUsd` null removes one
 *
 * THE KEY is `finance.partners` («الشركاء والسحوبات») — the rates exist for the partners' draws, and the partners' card on the same
 * screen asks the same key. Asked FIRST, before the body is read. The door never fetches anything: the daily job does.
 *
 * A typed rate is «how many units of the currency buy ONE dollar» («1 دولار = 13000 ليرة»). The dollar has none (it is 1). A rate
 * typed here wins over the automatic one; removing it gives the automatic one back (or «اكتب السعر» for the pound).
 */

const MAX_PER_USD = 1_000_000_000;
const MIN_PER_USD = 0.000001;

const bodySchema = z.object({
  rates: z
    .array(
      z.object({
        code: z.string().trim().regex(/^[A-Za-z]{3,5}$/, { message: 'رمز العملة 3 لـ5 أحرف' }),
        perUsd: numeric()
          .refine((v) => v >= MIN_PER_USD, { message: 'السعر أكبر من صفر' })
          .refine((v) => v <= MAX_PER_USD, { message: `السعر ${MAX_PER_USD} على الأكثر` })
          .nullable(),
      })
    )
    .min(1)
    .max(50),
});

async function answer(companyId: string) {
  const now = new Date();
  const [codes, table] = await Promise.all([companyCurrencyCodes(companyId), readRateTable(companyId)]);
  const all = [...new Set([...codes, ...Object.keys(table.manual.rates)])].sort();
  const rows = all.map((code) => {
    const effective = effectiveRate(code, table.auto, table.manual, now);
    const auto = effectiveRate(code, table.auto, undefined, now);
    const typed = table.manual.rates[code];
    return {
      code,
      label: currencyLabel(code),
      effective,
      auto: auto && auto.kind === 'AUTO' ? auto : null,
      manual: typed ? { perUsd: typed.perUsd, at: typed.at } : null,
      ownerOnly: NEVER_FROM_A_SOURCE.includes(code) || (code !== 'USD' && !auto),
      missingSentence: effective ? null : missingRateSentence([code]),
    };
  });
  return {
    rows,
    table: { auto: table.auto ?? null, manual: table.manual },
    attemptedAt: table.auto?.attemptedAt ?? null,
    failed: table.auto?.failed ?? {},
    staleSentence: STALE_SENTENCE,
  };
}

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('finance.partners');
    return NextResponse.json(await answer(companyId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('finance.partners');

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error), code: 'INVALID_RATES' }, { status: 400 });
    const changes = parsed.data.rates.map((r) => ({ code: normCode(r.code), perUsd: r.perUsd }));
    if (changes.some((c) => c.code === 'USD')) {
      return NextResponse.json({ error: 'الدولار سعره 1 دايماً — ما بينكتب له سعر.', code: 'USD_IS_ONE' }, { status: 400 });
    }

    const before = (await readRateTable(companyId)).manual;
    const saved = await saveManualRates(companyId, changes, user.id);
    await logAudit({
      companyId,
      userId: user.id,
      action: 'EXCHANGE_RATES_SAVED',
      entity: 'Company',
      entityId: companyId,
      previousData: { rates: before.rates },
      newData: { rates: saved.rates },
    });
    return NextResponse.json(await answer(companyId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
