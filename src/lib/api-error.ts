/**
 * Centralized API error → HTTP response mapper.
 *
 * Maps thrown errors (auth guards, RBAC guards, Prisma known errors)
 * to consistent { error, code? } bodies with correct status codes.
 * Unknown errors never leak internals — a generic Arabic-safe message
 * is returned instead, and the original error is logged server-side.
 */

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { catalogItem } from './permission-catalog';

export interface ApiErrorResult {
  body: { error: string; errorAr?: string; code?: string };
  status: number;
}

/**
 * THE SENTENCE THE PERSON READS, BESIDE THE ONE THE CODE THREW.
 *
 * `errorAr` is not new: ten components already prefer it over `error`, and
 * `apiJson` in api-client.ts reads it first. What was missing is that THIS
 * function — the one every thrown refusal in two hundred and twenty-nine
 * routes passes through — never wrote one. So the orders list showed
 *
 *   Forbidden: missing required permission orders.view
 *
 * to an Arabic reader, and the order dialog showed «Order not found».
 *
 * `error` is left exactly as it was. It is the technical string: fifteen
 * test files assert on it, and support reads the permission key out of it.
 * The Arabic goes beside it, and every sentence says what to DO — a
 * translated dead end is still a dead end.
 */

/** Does a message already speak to the reader? (the Arabic block, U+0600–U+06FF) */
const ARABIC = /[؀-ۿ]/;

const ACCOUNT_AR: Record<string, string> = {
  PENDING: 'حسابك بانتظار موافقة المدير. لا يمكن العمل قبلها.',
  SUSPENDED: 'حسابك موقوف مؤقتاً. راجع مدير النظام.',
  DISABLED: 'حسابك مُعطَّل. راجع مدير النظام.',
};

/** «Forbidden: missing required permission orders.view» → a sentence. */
/*
 * Exported because the inline refusals need the same sentence. A route
 * that RETURNS `{ error: 'Forbidden: missing required permission x.y' }`
 * instead of throwing never reaches `apiError`, so it never got one —
 * and there are nineteen of those.
 */
export function forbiddenAr(message: string): string {
  const key = message.match(/missing required permission\s+([\w.]+)/)?.[1];
  if (key) {
    /*
     * The name comes from `permission-catalog.ts` — the list the roles
     * matrix draws — not from a copy here. A first version of this function
     * carried fifteen hand-written names and fell back to the bare key for
     * everything else: `confirmation.work`, `ops.track` and
     * `settlement.upload` all came out as keys, and the catalogue had
     * Arabic for every one of them. The key stays in the sentence when the
     * catalogue does not know it, because something to quote is better
     * than a sentence that names nothing.
     */
    const name = catalogItem(key)?.ar;
    return name
      ? `لا تملك صلاحية «${name}». اطلبها من مدير النظام إن كانت من عملك.`
      : `لا تملك الصلاحية المطلوبة (${key}). اطلبها من مدير النظام إن كانت من عملك.`;
  }
  // Every other Forbidden the guards throw already says what it refused,
  // but in English. One sentence covers them without pretending to know
  // which: the reader's next step is the same in all of them.
  return 'هذا الإجراء ليس من صلاحياتك. راجع مدير النظام إن كان من عملك.';
}

/**
 * ONLY A SENTENCE THIS CODEBASE WROTE MAY BE SHOWN TO A CALLER.
 *
 * Two of the branches below echo the error's own message, which is right
 * for `throw new Error('المحفظة غير موجودة')` and wrong for everything
 * else that happens to contain the same word. Measured, not feared: a
 * Prisma error whose text merely mentions «not found» came back whole, and
 * it carried
 *
 *   Invalid `prisma.order.findUnique()` invocation in
 *   C:\Users\…\src\lib\orders.ts:88:14
 *
 * — the absolute path of the server's source tree, the model and the
 * method, handed to a browser. An initialization error matched on the word
 * «version» and gave up the engine file and the Prisma version with it.
 *
 * Three signs, each of which a message we wrote never has: it came from a
 * Prisma class, it spans lines, or it holds a filesystem path.
 */
function ours(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name.startsWith('Prisma')) return false;
  const m = error.message;
  if (m.length > 200 || m.includes('\n')) return false;
  // `C:\…`, `/home/…`, `/var/…`, `/Users/…` — a path in a message meant for
  // a person is a leak whatever the rest of the sentence says.
  return !/[A-Za-z]:[\\/]{1,2}[A-Za-z]|(?:^|[\s(])\/(?:home|Users|var|opt|srv|app)\//.test(m);
}

export function apiError(error: unknown): ApiErrorResult {
  const message = error instanceof Error ? error.message : String(error);

  if (message === 'Unauthorized') {
    return {
      body: { error: 'Unauthorized', errorAr: 'انتهت الجلسة. سجّل الدخول من جديد للمتابعة.' },
      status: 401,
    };
  }
  if (/^ACCOUNT_/.test(message)) {
    /*
     * `auth.ts` throws `ACCOUNT_${user.status}` and NOTHING translated it —
     * a suspended account met the bare token `ACCOUNT_SUSPENDED` on every
     * request it made. The status word is kept in `error` for the log.
     */
    const status = message.slice('ACCOUNT_'.length);
    return {
      body: { error: message, errorAr: ACCOUNT_AR[status] ?? 'حسابك غير مفعَّل. راجع مدير النظام.' },
      status: 401,
    };
  }
  if (message.startsWith('Forbidden')) {
    return { body: { error: message, errorAr: forbiddenAr(message) }, status: 403 };
  }
  // Geo context missing (see lib/geo-context.ts requireContext)
  if (error instanceof Error && error.name === 'ContextError') {
    return {
      body: {
        error: message,
        errorAr: ARABIC.test(message) ? message : 'اختر البلد والمتجر أولاً، ثم أعد المحاولة.',
        code: (error as Error & { code: string }).code,
      },
      status: 400,
    };
  }

  // Prisma known errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return {
        body: {
          error: 'Duplicate record',
          errorAr: 'هذا السجل موجود مسبقاً. ابحث عنه بدلاً من إنشائه من جديد.',
          code: 'DUPLICATE',
        },
        status: 409,
      };
    }
    if (error.code === 'P2025') {
      return {
        body: {
          error: 'Record not found',
          errorAr: 'السجل المطلوب لم يعد موجوداً. أعد تحميل الصفحة.',
          code: 'NOT_FOUND',
        },
        status: 409,
      };
    }
  }

  /*
   * AND IN THE LANGUAGE THIS CODEBASE ACTUALLY THROWS IN.
   *
   * These two tests were English-only, and the comment at the top of this
   * file cites `throw new Error('المحفظة غير موجودة')` as the very case
   * they are for. Measured: `blacklist.ts` throws «الحظر غير موجود» and
   * «الحظر مفكوك مسبقاً», and both fell past every branch to the generic
   * 500 — so the caller got «حدث خطأ داخلي» with a 500 where a 404 and a
   * 409 were waiting, and the sentence the code wrote was thrown away.
   */
  const AR_NOT_FOUND = /غير موجود|لا يوجد|لم يُعثر/;
  const AR_CONFLICT = /مسبقا|مسبقاً|بالفعل|تعارض|عُدِّل|عدّل/;

  /*
   * A SHORT SHELF IS NOT A CRASH.
   *
   * `drawDownStock` throws «المخزون غير كافٍ: المتاح ٣ والمطلوب ١٠» when a
   * draw-down would take more than is there, and nothing here named it — so
   * the request answered 500 «حدث خطأ داخلي. أعد المحاولة، وإن تكرّر أبلغ
   * مدير النظام». A warehouse clerk was told the system broke and to call
   * the administrator, for a condition that is ordinary, expected, and
   * entirely theirs to resolve; the sentence the code had already written,
   * which names the two numbers, was thrown away on the way out.
   *
   * (30/10, P0-13: only the stocktake door still throws it. The delivery
   * doors below no longer do — a delivery is recorded whatever the shelf
   * says, see `consumeOrderStock`; the list is kept as the history of why
   * the branch is in the shared mapper.)
   *
   * ONE BRANCH, NOT FIVE. Five doors reach this thrower — the stocktake
   * shortfall in `/api/inventory`, and `consumeOrderStock` from
   * `/api/orders/[id]`, `/api/orders/[id]/shipping`,
   * `/api/finance/statements/[id]`, `/api/ops/tracking/write-off` and
   * `/api/ops/tracking/deliver` through `partial-delivery.ts` — and all of
   * them already funnel through this function. Per-door handling is how
   * `7c98b01` got two delivery doors that disagreed about the same stock
   * rule, which is what produced the single-batch defect; the shared
   * mapper is where this belongs.
   *
   * 409 rather than 400: the request was well formed and the operator is
   * allowed to make it. What refused it is the state of the shelf at this
   * instant, and that is what 409 means.
   *
   * The thrown sentence is kept WHOLE — it carries the available and the
   * required, which is the only part that tells the clerk how far short
   * they are — and the next step is added, because it is the same step in
   * all five doors. `ours` is still the gate: this never echoes a Prisma
   * message, a multi-line message or one holding a server path.
   *
   * Placed BEFORE the two below on purpose. «غير» sits in both this
   * sentence and `AR_NOT_FOUND`'s «غير موجود», and a stock shortage
   * answered 404 would be a second wrong answer rather than a fixed one.
   */
  const AR_INSUFFICIENT = /المخزون غير كاف/;

  if (ours(error) && AR_INSUFFICIENT.test(message)) {
    return {
      body: {
        error: message,
        errorAr: `${message}. استلم الكمية الناقصة من «استلام بضاعة» أو اجردها، أو أنقص الكمية المطلوبة، ثمّ أعد المحاولة.`,
        code: 'INSUFFICIENT_STOCK',
      },
      status: 409,
    };
  }

  if (ours(error) && (/version|conflict/i.test(message) || AR_CONFLICT.test(message))) {
    return {
      body: {
        error: message,
        // Already Arabic in most callers; the fallback is for the ones
        // that throw in English, and it is the same next step either way.
        errorAr: ARABIC.test(message)
          ? message
          : 'عُدِّل هذا السجل من مكان آخر بعد أن فتحتَه. أعد تحميل الصفحة ثم احفظ.',
      },
      status: 409,
    };
  }
  if (ours(error) && (/not.?found/i.test(message) || AR_NOT_FOUND.test(message))) {
    return {
      body: {
        error: message,
        errorAr: ARABIC.test(message) ? message : 'غير موجود. أعد تحميل الصفحة.',
      },
      status: 404,
    };
  }

  console.error(error);
  return {
    body: { error: 'حدث خطأ داخلي', errorAr: 'حدث خطأ داخلي. أعد المحاولة، وإن تكرّر أبلغ مدير النظام.' },
    status: 500,
  };
}

/**
 * Convenience wrapper for catch blocks: maps the error via apiError() and
 * returns a ready-to-send NextResponse. In development the original error
 * message is attached as `detail` for debugging; in production it is
 * omitted entirely so internals (Prisma messages, stack traces) never leak.
 * A 500 also logs the original error server-side (via apiError).
 */
export function apiErrorResponse(error: unknown): NextResponse {
  const { body, status } = apiError(error);
  const devDetail =
    process.env.NODE_ENV !== 'production' && error instanceof Error
      ? { detail: error.message }
      : {};
  return NextResponse.json({ ...body, ...devDetail }, { status });
}
