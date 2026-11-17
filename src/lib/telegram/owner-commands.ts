import { containsCustomerData } from '../v1/notify';
import { companyListeningToStop, emitOwnerStop } from '../apps/events';
import { sendMessage } from './cloud-api';
import { ownerChatId } from './targets';

/**
 * THE OWNER WRITES «اوقف …» TO THE BOT (the media buyer's doors, PR-B, O5).
 *
 * The OMS owns the bot and its webhook, so the owner's stop request arrives HERE and is handed to the media buyer as a signed event — through the installed-apps
 * machinery (`apps/events.ts`, `emitOwnerStop`), not a second outbox. The media buyer turns it into its own safety change (pause only; anything that spends is refused
 * with a link to the site) and its own webhook on Telegram is retired once this is live.
 *
 * ── WHO MAY ──
 *
 * Only a PRIVATE chat whose id is the owner's (`TELEGRAM_OWNER_CHAT_ID`). A group message, another person's private message and any message when no owner chat is set are
 * not commands: they fall through to the order reader exactly as before. The webhook's own secret has already been checked by the route.
 *
 * ── WHICH COMPANY ──
 *
 * A chat id does not name a company. The company is the one whose enabled installed app registered for `owner.stop_requested` — and only when there is exactly one:
 * with none there is nobody to tell (the owner is told so), with several the command would be a guess about whose ads to pause, and a guess is refused.
 *
 * ── WHAT IS NOT FORWARDED ──
 *
 * A text that looks like a phone number or an address, a request over 200 characters, and a message older than five minutes (a replayed backfill must never pause an ad).
 * The owner is answered in the chat for each, in a sentence. An edited message is not a new command (`edited_message` is a different key of the update).
 */

/** «اوقف X» and its spellings; what follows is the query. */
const STOP_COMMAND = /^\s*(?:اوقف|أوقف|وقّف|وقف)\s+([\s\S]+?)\s*$/u;

export const STOP_QUERY_MAX = 200;
/** A stop older than this is not acted on. */
export const STOP_FRESH_MS = 5 * 60_000;

export interface OwnerCommandResult {
  handled: boolean;
  status?: 'OWNER_STOP' | 'OWNER_STOP_REFUSED';
}

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text);
  } catch {
    // the answer to the owner is a courtesy; the command's outcome does not depend on it
  }
}

/** If this update is the owner's «اوقف …», handle it and say so; otherwise `{ handled: false }` and nothing is touched. */
export async function handleOwnerCommand(update: unknown, now: Date = new Date()): Promise<OwnerCommandResult> {
  const msg = (update as { message?: Record<string, unknown> } | null)?.message;
  if (!msg || typeof msg !== 'object') return { handled: false };
  const chat = msg.chat as { id?: unknown; type?: unknown } | undefined;
  if (!chat || chat.type !== 'private') return { handled: false };
  const owner = ownerChatId();
  if (!owner || String(chat.id) !== owner) return { handled: false };
  const text = typeof msg.text === 'string' ? msg.text : '';
  const m = STOP_COMMAND.exec(text);
  if (!m) return { handled: false };

  const date = typeof msg.date === 'number' ? msg.date * 1000 : null;
  if (date !== null && now.getTime() - date > STOP_FRESH_MS) return { handled: true, status: 'OWNER_STOP_REFUSED' };

  const query = m[1].replace(/\s+/g, ' ').trim();
  if (query.length > STOP_QUERY_MAX) {
    await reply(owner, `الطلب طويل (أكتر من ${STOP_QUERY_MAX} حرف) — اكتب اسم الإعلان أو رمزو بس.`);
    return { handled: true, status: 'OWNER_STOP_REFUSED' };
  }
  if (containsCustomerData(query)) {
    await reply(owner, 'ما بقدر أبعت هالنص: شكلو فيو رقم هاتف أو عنوان. اكتب رمز الإعلان أو اسمو بس.');
    return { handled: true, status: 'OWNER_STOP_REFUSED' };
  }

  const companyId = await companyListeningToStop();
  if (!companyId) {
    await reply(owner, 'ما في تطبيق مثبّت بيسمع «طلب الإيقاف» (أو في أكتر من شركة). ثبّت الميديا باير من «التطبيقات» وسجّلو بحدث «طلب إيقاف من المالك».');
    return { handled: true, status: 'OWNER_STOP_REFUSED' };
  }

  const told = await emitOwnerStop(companyId, { query, source_chat: 'owner' });
  await reply(
    owner,
    told > 0 ? `استلمت طلب الإيقاف «${query}» وبعتّو للميديا باير. بيوقّف بس (ما بيصرف شي).` : 'ما قدرت أبعت طلب الإيقاف، جرّب كمان شوي.'
  );
  return { handled: true, status: 'OWNER_STOP' };
}
