/**
 * «زر واتساب بالمتجر» — WHICH NUMBER THE SHOP'S WHATSAPP BUTTON OPENS (the owner, 26/11).
 *
 * Client-safe: no database. The store's settings pick one of two ways, and the storefront reads the same answer:
 *
 *   EXTERNAL  «تطبيق خارجي» — wa.me with the number the owner typed for the button (`whatsappNumber`), or the store's
 *             support phone when he typed none. That is how every shop worked before this setting, so it is the default.
 *   API       «واتساب بزنس API» — wa.me with the company's WhatsApp Business API number (the one connected in «واتساب»).
 *             The shopper still writes from his own WhatsApp; the message reaches that number, so it lands in the OMS
 *             inbox, where the team and the bot answer it.
 *
 * API with no number connected falls back to the EXTERNAL number rather than drawing no button: a shop that cannot be
 * reached looks closed. The settings card says when that is happening.
 */

export const STORE_WHATSAPP_MODES = ['EXTERNAL', 'API'] as const;
export type StoreWhatsappMode = (typeof STORE_WHATSAPP_MODES)[number];

export function isStoreWhatsappMode(v: unknown): v is StoreWhatsappMode {
  return typeof v === 'string' && (STORE_WHATSAPP_MODES as readonly string[]).includes(v);
}

export const STORE_WHATSAPP_MODE_AR: Record<StoreWhatsappMode, { label: string; hint: string }> = {
  EXTERNAL: {
    label: 'تطبيق خارجي (رابط wa.me)',
    hint: 'الزر بيفتح واتساب على الرقم اللي بتكتبه هون، والمحادثة بتكون برّا النظام. إذا تركته فاضي بينفتح على هاتف الدعم.',
  },
  API: {
    label: 'واتساب بزنس API (صندوق الواتس بالنظام)',
    hint: 'الزر بيفتح واتساب على رقم الشغل المربوط بالنظام، والرسالة بتوصل لصندوق الواتس هون، وبيرد عليها الفريق أو البوت.',
  },
};

/** The store's three fields this reads. */
export interface StoreWhatsappFields {
  whatsappMode?: string | null;
  whatsappNumber?: string | null;
  supportPhone?: string | null;
}

/** The mode as stored, or EXTERNAL for anything else (an older row, a typo). */
export function storeWhatsappModeOf(raw: unknown): StoreWhatsappMode {
  return isStoreWhatsappMode(raw) ? raw : 'EXTERNAL';
}

/**
 * The number the button opens, or null for no button. `apiNumber` is the company's connected WhatsApp Business number
 * (null when none is connected) — asked by the caller only when the mode is API.
 */
export function storeWhatsappPhone(store: StoreWhatsappFields, apiNumber: string | null): string | null {
  if (storeWhatsappModeOf(store.whatsappMode) === 'API' && apiNumber?.trim()) return apiNumber.trim();
  return store.whatsappNumber?.trim() || store.supportPhone?.trim() || null;
}
