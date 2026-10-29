import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { can, getPermissionScope } from '@/lib/authorization';
import { rateLimit } from '@/lib/rate-limit';
import {
  AiEndpointMissing,
  AiNotConfigured,
  AiNotLocal,
  aiChat,
} from '@/lib/ai-provider';
import {
  TODAY_SYSTEM_PROMPT,
  fixedTodayLine,
  paletteSummary,
  todayNumbersPrompt,
} from '@/lib/palette-intel';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لخّصلي اليوم» — ONE ARABIC PARAGRAPH, BUILT FROM NUMBERS ONLY.
 *
 * The same five counts the palette just showed, handed to a model to be
 * read as a sentence. Nothing else is handed over: no order number, no
 * name, no phone, no address, no city. `todayNumbersPrompt` can only
 * stringify a `PaletteFact`, and a `PaletteFact` is a fixed Arabic label
 * and an integer — including the phone counter, whose label is a constant
 * precisely so that this route cannot be made to leak one.
 *
 * ── AND `localOnly` ANYWAY ──
 *
 * The payload has no person in it, so this call would be safe on a vendor.
 * It still refuses one. The reason is the owner's rule read as what it is:
 * a rule about ROUTES, not about the goodwill of one payload. The next
 * person to add a line to the prompt — «وأكثر زبون يرجّع», say — will add
 * it to a route that cannot reach a vendor, instead of to one that can.
 *
 * `aiChat` throws `AiNotLocal` BEFORE the first byte leaves when the route
 * is not LOCAL, and the answer then is not an apology: it is the same five
 * numbers in a fixed sentence, with `localOnly: true` reported so the
 * screen can say WHY it is the plain version.
 *
 * ── IT WRITES NOTHING ──
 *
 * «كلّ إجراء ذكاءٍ اصطناعيٍّ اقتراحٌ فقط» — see `ai-proposal-only.test.ts`.
 * There is no cache row and no audit row here: the answer is three
 * sentences about counts that move every few minutes, and a cached
 * paragraph is a paragraph that is wrong by lunchtime.
 * ═══════════════════════════════════════════════════════════════════════
 */

export async function POST() {
  try {
    const { user, companyId, storeId } = await requireContext();

    // The numbers are the person's own scope of `orders.view`, and the sentence is the assistants' — both keys, or neither
    // (PR-5: «لخّصلي اليوم» was offered to everybody who could open the box, and wakes a model on every press).
    if (!getPermissionScope(user, 'orders.view') || !can(user, 'ai.assist')) {
      return NextResponse.json({ error: 'لا صلاحية' }, { status: 403 });
    }

    // A model call per press, so tighter than the counters above it.
    const rl = rateLimit(`palette-today:${companyId}:${user.id}`, 10, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    const facts = await paletteSummary({ companyId, storeId }, user);
    const plain = fixedTodayLine(facts);

    try {
      const answer = await aiChat({
        companyId,
        system: TODAY_SYSTEM_PROMPT,
        user: todayNumbersPrompt(facts),
        timeoutMs: 15000,
        localOnly: true,
      });
      const text = answer.trim();
      // An empty answer from a local server is not a paragraph. The numbers
      // are, and they are already in hand.
      return text
        ? NextResponse.json({ text, from: 'LOCAL_MODEL' })
        : NextResponse.json({ text: plain, from: 'NUMBERS', why: 'EMPTY_ANSWER' });
    } catch (e) {
      if (e instanceof AiNotLocal) {
        return NextResponse.json({
          text: plain,
          from: 'NUMBERS',
          why: 'NOT_LOCAL',
          // Which vendor the route currently points at, because «اذهب إلى
          // إعدادات الذكاء» is only actionable if the screen can say what
          // to change it FROM.
          provider: e.provider,
        });
      }
      if (e instanceof AiNotConfigured || e instanceof AiEndpointMissing) {
        return NextResponse.json({ text: plain, from: 'NUMBERS', why: 'NOT_CONFIGURED' });
      }
      return NextResponse.json({ text: plain, from: 'NUMBERS', why: 'FAILED' });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
