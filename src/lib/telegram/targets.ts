/**
 * WHO THE COMPANY'S BOT MAY TALK TO, BY NAME — for `POST /api/v1/notify` (the media buyer's doors, PR-B).
 *
 * The OMS is the ONE Telegram gateway: another system asks it to say something and never holds the bot token. That system names its audience in three ways and
 * only two of them need a table this system does not have:
 *
 *   «owner»          the owner's private chat — `TELEGRAM_OWNER_CHAT_ID`
 *   {person: key}    a member of the team, by the short key the asking system uses («sara») — `TELEGRAM_PEOPLE_CHATS`, `key:chatId` pairs separated by commas
 *   {chat_id, topic} a chat the bot is already in, and optionally one topic of a forum group — named by the caller, checked by Telegram itself
 *
 * Both values are the owner's to supply (Telegram will not let a bot start a conversation: the person writes to the bot first and only then does a chat id
 * exist). Until they are set the name is UNKNOWN — a refusal that says so, never a message to a guess. They are read from the environment today; the next
 * PR (PR-C) moves them to the site's «الربط» page, and the environment stays the fallback, exactly like the alert chat (`jobs/alerts.ts`).
 */

export interface TelegramTarget {
  chatId: string;
  topicId?: number;
}

/** A Telegram chat id: digits with an optional minus (a group or channel is negative). Anything else is not one. */
const CHAT_ID = /^-?\d{1,20}$/;

export function ownerChatId(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  return id && CHAT_ID.test(id) ? id : null;
}

/** `sara:123, ahmad:-100456` → { sara: '123', ahmad: '-100456' }. A pair that does not parse is skipped, never guessed. */
export function peopleChats(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (env.TELEGRAM_PEOPLE_CHATS ?? '').split(',')) {
    const [key, id] = pair.split(':').map((s) => s.trim());
    if (key && /^[a-z][a-z0-9_-]{1,31}$/.test(key) && id && CHAT_ID.test(id)) out.set(key, id);
  }
  return out;
}

export type TargetInput = 'owner' | { person: string } | { chat_id: number | string; topic_id?: number };

/** The chat a name means, or null when this system does not know it. */
export function resolveTelegramTarget(target: TargetInput, env: Record<string, string | undefined> = process.env): TelegramTarget | null {
  if (target === 'owner') {
    const id = ownerChatId(env);
    return id ? { chatId: id } : null;
  }
  if ('person' in target) {
    const id = peopleChats(env).get(target.person);
    return id ? { chatId: id } : null;
  }
  const id = String(target.chat_id).trim();
  return CHAT_ID.test(id) ? { chatId: id, ...(target.topic_id ? { topicId: target.topic_id } : {}) } : null;
}
