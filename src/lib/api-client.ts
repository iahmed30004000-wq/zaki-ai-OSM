/**
 * Shared fetch wrappers for client components.
 * - apiFetch: same-origin credentials by default; on 401 redirects to /login
 *   (layout dir/lang untouched) and throws a user-facing Arabic message.
 * - apiJson: parses JSON and throws a readable error from errorAr/error fields.
 * - All requests carry a 15s timeout via AbortSignal.timeout, merged with any
 *   caller-provided signal so a caller abort also cancels the request. A call
 *   that is slow by nature (handing a few parcels to a courier) names its own
 *   wait with `timeoutMs`; nothing else gets more than 15s.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** What a caller may add to a `RequestInit`: how long THIS request may take. */
type TimedInit = RequestInit & { timeoutMs?: number };

/** Merge the timeout signal (the default, or the caller's own) with a caller-provided signal. */
function withTimeout(signal?: AbortSignal | null, timeoutMs: number = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  // AbortSignal.any is widely available; fall back for older runtimes
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any([signal, timeoutSignal]);
  }
  // Small combined-abort helper: abort when either source fires
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export async function apiFetch(input: string, init?: TimedInit): Promise<Response> {
  let res: Response;
  const { timeoutMs, ...rest } = init ?? {};
  try {
    res = await fetch(input, {
      credentials: 'same-origin',
      ...rest,
      signal: withTimeout(rest.signal, timeoutMs),
    });
  } catch (e: any) {
    // Timeout abort surfaces as AbortError ("signal timed out" for AbortSignal.timeout)
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new Error('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.');
    }
    throw e;
  }
  if (res.status === 401) {
    // Session expired — hard redirect to login; keeps app dir/rtl untouched
    window.location.href = '/login';
    throw new Error('انتهت الجلسة، جارٍ إعادة التوجيه');
  }
  // Country/store selection missing or revoked (src/lib/geo-context.ts) —
  // back to the picker instead of showing a half-scoped screen.
  if (res.status === 400) {
    const code = await res
      .clone()
      .json()
      .then((d: { code?: string }) => d?.code)
      .catch(() => undefined);
    if (code === 'CONTEXT_REQUIRED' || code === 'STORE_REQUIRED') {
      window.location.href = '/entry';
      throw new Error('يجب اختيار البلد والمتجر');
    }
  }
  return res;
}

/**
 * WHAT THE SERVER SAID WHEN IT SAID NO — in Arabic, or the fallback.
 *
 * A board that reads its numbers with `res.ok` and does nothing else draws a
 * refusal as zeros: «٠ طلب، ٠٪» is a statement about the shop, and a 403 is
 * not. The screens that read a response by hand say what came back with this.
 */
export async function saidBy(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const said = (data as { errorAr?: unknown }).errorAr;
  return typeof said === 'string' && said ? said : fallback;
}

export async function apiJson<T>(input: string, init?: TimedInit): Promise<T> {
  const res = await apiFetch(input, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    /*
     * The body travels with the error. Some refusals carry more than one sentence — the shipment door answers
     * `exceptions` (order by order, with the reason of each) beside its generic line — and a screen that only
     * ever saw `message` could only show the generic one. Read as `(e as { data?: ... }).data`; no new export,
     * so the many tests that stand in for this module keep working.
     */
    throw Object.assign(
      new Error((data as any).errorAr || (data as any).error || `HTTP ${res.status}`),
      { status: res.status, data }
    );
  }
  return data as T;
}
