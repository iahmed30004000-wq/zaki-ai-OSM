/**
 * META'S 24-HOUR CUSTOMER-SERVICE WINDOW — pure, shared by the send doors and the inbox.
 *
 * A business may send a free-form message (text, photo, file, reaction) only within 24 hours of the customer's last message.
 * Outside it Meta refuses everything but an approved TEMPLATE. The doors ask before calling Meta, so the staff reads why in
 * Arabic instead of «تعذر الاتصال بواتساب».
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function serviceWindow(lastInboundAt: Date | string | null | undefined, nowMs: number = Date.now()): { open: boolean; endsAt: string | null } {
  if (!lastInboundAt) return { open: false, endsAt: null };
  const at = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(at)) return { open: false, endsAt: null };
  const end = at + SERVICE_WINDOW_MS;
  return { open: nowMs < end, endsAt: new Date(end).toISOString() };
}

export const WINDOW_CLOSED_MESSAGE =
  'مرّ أكثر من 24 ساعة على آخر رسالة من الزبون — واتساب لا يسمح الآن إلا بقالب معتمد. أرسل القالب، وحين يردّ الزبون تنفتح المحادثة من جديد.';
