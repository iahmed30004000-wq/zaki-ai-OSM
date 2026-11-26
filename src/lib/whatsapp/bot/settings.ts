/**
 * THE WHATSAPP ORDER BOT'S SETTINGS — one row per company (`whatsapp_bot_settings`).
 *
 * The switch, the name the customer reads, the owner's words about personality and store (like Sarah's «الشخصية ومعلومات
 * المتجر»), short facts per product, and the model: an OpenAI-compatible server (by default the same one Sarah uses), its
 * optional model name (empty = the first the server lists) and its key.
 *
 * ── THE KEY IS WRITE-ONLY ──
 *
 * Sealed with the application's key (`secrets.ts`) and never returned by any door, never written to an audit row, never
 * logged: the screen is told its last four characters and nothing else. Without an encryption key on the server a key is
 * refused, never stored in the clear.
 *
 * ── THE ADDRESS IS CHECKED, NOT TRUSTED ──
 *
 * `parseCompatEndpoint` (https, a real public name, no IP, no secret in the path) — the same rule as the AI screen's
 * «خادم متوافق مع OpenAI», because the key rides on every request to it.
 */
import { z } from 'zod';
import { db } from '../../db';
import { decryptSecret, encryptSecret, encryptionAvailable } from '../../secrets';
import { hintOf } from '../../integration-settings';
import { parseCompatEndpoint, parseCompatModel } from '../../ai-endpoint';

export const DEFAULT_BOT_NAME = 'سارة';
export const DEFAULT_BASE_URL = 'https://glm.erv.zakiai.io/v1';
export const PERSONA_MAX = 4000;
export const PRODUCT_NOTES_MAX = 1500;
export const PRODUCT_NOTES_COUNT = 50;

export interface ProductNote {
  productId: string;
  notes: string;
}

/** What the server uses. The key is opened only here, for the call. */
export interface BotSettings {
  companyId: string;
  enabled: boolean;
  name: string;
  avatarText: string;
  persona: string;
  productNotes: ProductNote[];
  baseUrl: string;
  model: string | null;
  apiKey: string | null;
  /** A key is saved but cannot be opened (the application's key changed). */
  keyUnreadable: boolean;
}

/** What a screen is told — never the key. */
export interface BotSettingsView {
  enabled: boolean;
  name: string;
  avatarText: string;
  persona: string;
  productNotes: ProductNote[];
  baseUrl: string;
  model: string | null;
  keySet: boolean;
  keyHint: string | null;
  keyUnreadable: boolean;
  /** On AND able to talk: switched on with a key the server can open. */
  active: boolean;
}

const readNotes = (raw: unknown): ProductNote[] => {
  if (!Array.isArray(raw)) return [];
  const out: ProductNote[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const productId = typeof (r as ProductNote).productId === 'string' ? (r as ProductNote).productId : '';
    const notes = typeof (r as ProductNote).notes === 'string' ? (r as ProductNote).notes.trim() : '';
    if (productId && notes) out.push({ productId, notes: notes.slice(0, PRODUCT_NOTES_MAX) });
  }
  return out.slice(0, PRODUCT_NOTES_COUNT);
};

/** The first letter of the name, when the owner chose no initial. */
export const initialOf = (name: string): string => Array.from(name.trim())[0] ?? '؟';

type Row = Awaited<ReturnType<typeof db.whatsAppBotSettings.findUnique>>;

function fromRow(companyId: string, row: Row): BotSettings {
  let apiKey: string | null = null;
  let keyUnreadable = false;
  if (row?.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(row.apiKeyEncrypted);
    } catch {
      keyUnreadable = true;
    }
  }
  const name = row?.name?.trim() || DEFAULT_BOT_NAME;
  return {
    companyId,
    enabled: row?.enabled === true,
    name,
    avatarText: row?.avatarText?.trim() || initialOf(name),
    persona: row?.persona ?? '',
    productNotes: readNotes(row?.productNotes),
    baseUrl: row?.baseUrl?.trim() || DEFAULT_BASE_URL,
    model: row?.model?.trim() || null,
    apiKey,
    keyUnreadable,
  };
}

/** The company's bot as the server uses it. No row = the defaults, switched off. Never throws on a missing row. */
export async function loadBotSettings(companyId: string): Promise<BotSettings> {
  const row = await db.whatsAppBotSettings.findUnique({ where: { companyId } });
  return fromRow(companyId, row);
}

/** Switched on, and a key the server can open. */
export const botActive = (s: BotSettings): boolean => s.enabled && !!s.apiKey;

/** What the inbox draws about the bot, read on every poll: no key is opened for it. */
export interface BotAgent {
  active: boolean;
  name: string;
  avatarText: string;
}

export async function botAgent(companyId: string): Promise<BotAgent> {
  try {
    const row = await db.whatsAppBotSettings.findUnique({ where: { companyId }, select: { enabled: true, name: true, avatarText: true, apiKeyEncrypted: true } });
    const name = row?.name?.trim() || DEFAULT_BOT_NAME;
    // «On» only with a key the server can open — the same answer the engine gives (`botActive`), so the inbox never says
    // «شغّال» for a bot that cannot speak.
    let readable = false;
    if (row?.enabled && row.apiKeyEncrypted) {
      try {
        readable = !!decryptSecret(row.apiKeyEncrypted);
      } catch {
        readable = false;
      }
    }
    return { active: readable, name, avatarText: row?.avatarText?.trim() || initialOf(name) };
  } catch {
    return { active: false, name: DEFAULT_BOT_NAME, avatarText: initialOf(DEFAULT_BOT_NAME) };
  }
}

export function viewOf(s: BotSettings, hint: string | null): BotSettingsView {
  return {
    enabled: s.enabled,
    name: s.name,
    avatarText: s.avatarText,
    persona: s.persona,
    productNotes: s.productNotes,
    baseUrl: s.baseUrl,
    model: s.model,
    keySet: !!s.apiKey || s.keyUnreadable,
    keyHint: hint,
    keyUnreadable: s.keyUnreadable,
    active: botActive(s),
  };
}

export async function readBotSettingsView(companyId: string): Promise<BotSettingsView> {
  const row = await db.whatsAppBotSettings.findUnique({ where: { companyId } });
  return viewOf(fromRow(companyId, row), row?.apiKeyHint ?? null);
}

/** What the screen may send. `apiKey`: a new key; empty/absent keeps the saved one; `clearKey` removes it. */
export const botSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1, 'اكتب اسم البوت').max(30, 'اسم البوت طويل — 30 حرفًا على الأكثر').optional(),
  avatarText: z.string().trim().max(2, 'الحرف على الصورة حرف أو حرفان').optional(),
  persona: z.string().max(PERSONA_MAX, `الشخصية ${PERSONA_MAX} حرف على الأكثر`).optional(),
  productNotes: z
    .array(z.object({ productId: z.string().min(1).max(64), notes: z.string().max(PRODUCT_NOTES_MAX, `معلومات المنتج ${PRODUCT_NOTES_MAX} حرف على الأكثر`) }))
    .max(PRODUCT_NOTES_COUNT)
    .optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(512).optional(),
  clearKey: z.boolean().optional(),
});
export type BotSettingsInput = z.infer<typeof botSettingsSchema>;

export type SaveBotResult = { ok: true; view: BotSettingsView; changed: string[] } | { ok: false; error: string };

/** A key: printable, no spaces, not absurdly long. The refusal names no part of it. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

/**
 * Save what the owner changed. The address and the model name are checked by the AI screen's own rules; a key needs the
 * encryption key. Returns the names of the fields that changed (for the audit — never a value of the key).
 */
export async function saveBotSettings(companyId: string, input: BotSettingsInput, userId: string | null): Promise<SaveBotResult> {
  const row = await db.whatsAppBotSettings.findUnique({ where: { companyId } });
  const data: Record<string, unknown> = {};
  const changed: string[] = [];

  if (input.baseUrl !== undefined) {
    const raw = input.baseUrl || DEFAULT_BASE_URL;
    const checked = parseCompatEndpoint(raw);
    if (!checked.ok) return { ok: false, error: checked.message };
    if (checked.url !== (row?.baseUrl ?? DEFAULT_BASE_URL)) {
      data.baseUrl = checked.url;
      changed.push('baseUrl');
    }
  }
  if (input.model !== undefined) {
    let model: string | null = null;
    if (input.model) {
      const checked = parseCompatModel(input.model);
      if (!checked.ok) return { ok: false, error: checked.message };
      model = checked.model;
    }
    if (model !== (row?.model ?? null)) {
      data.model = model;
      changed.push('model');
    }
  }
  if (input.clearKey) {
    if (row?.apiKeyEncrypted) {
      data.apiKeyEncrypted = null;
      data.apiKeyHint = null;
      changed.push('apiKey');
    }
  } else if (input.apiKey) {
    if (!KEY_SHAPE.test(input.apiKey)) return { ok: false, error: 'المفتاح مش بالشكل المطلوب: بلا فراغات، 8 خانات أو أكتر' };
    if (!encryptionAvailable()) {
      return { ok: false, error: 'مفتاح التشفير (APP_ENCRYPTION_KEY) غير مُهيّأ على الخادم — ما بنحفظ مفتاح بلا تشفير.' };
    }
    data.apiKeyEncrypted = encryptSecret(input.apiKey);
    data.apiKeyHint = hintOf(input.apiKey);
    changed.push('apiKey');
  }
  const simple: Array<keyof BotSettingsInput> = ['enabled', 'name', 'avatarText', 'persona'];
  for (const k of simple) {
    const v = input[k];
    if (v === undefined) continue;
    const before = row ? (row as Record<string, unknown>)[k] : undefined;
    const next = k === 'avatarText' ? (v as string) || null : v;
    if (next !== before) {
      data[k] = next;
      changed.push(k);
    }
  }
  if (input.productNotes !== undefined) {
    const notes = readNotes(input.productNotes);
    if (JSON.stringify(notes) !== JSON.stringify(readNotes(row?.productNotes))) {
      data.productNotes = notes;
      changed.push('productNotes');
    }
  }

  if (changed.length > 0) {
    await db.whatsAppBotSettings.upsert({
      where: { companyId },
      create: { companyId, ...data, updatedById: userId } as never,
      update: { ...data, updatedById: userId },
    });
  }
  return { ok: true, view: await readBotSettingsView(companyId), changed };
}
