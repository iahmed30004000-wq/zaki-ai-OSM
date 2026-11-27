/**
 * THE INBOX'S OWN ARITHMETIC — what a conversation and a message look like to the screen, and the small pure rules the
 * thread draws by: which day a message belongs to, whose initials an avatar shows, how a poll's answer is merged, and which
 * reactions sit under which message. Pure, so each rule is tested without rendering anything.
 */
import { arDate, arTime } from '@/lib/format';

export interface WaConversation {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview?: string | null;
  lastMessageType?: string | null;
  assignedUserId?: string | null;
  assignedTo?: { id: string; name: string } | null;
  customerId?: string | null;
  customer?: { id: string; fullName: string; phone: string; rawPhone?: string; city?: string } | null;
  /** Meta's 24-hour window; absent = not told, drawn as open (the send door still checks). */
  windowOpen?: boolean;
  windowEndsAt?: string | null;
  templateReady?: boolean;
  hasOlder?: boolean;
  bot?: WaConversationBot;
  botAgent?: WaBotAgent;
}

export interface WaMedia {
  url: string;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  state: 'READY' | 'PENDING' | 'FAILED' | 'TOO_LARGE';
  voice: boolean;
}

export interface WaMessage {
  id: string;
  direction: string;
  messageType: string;
  text: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string;
  statusError?: string | null;
  media?: WaMedia | null;
  location?: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
  contacts?: { name: string; phones: string[] }[] | null;
  replyTo?: { id: string; direction: string; messageType: string; text: string | null } | null;
  reactionToId?: string | null;
  /** Written by the order bot (the thread labels it with the bot's name). */
  byBot?: boolean;
}

/** The order bot in one conversation (`whatsapp/bot/state.ts`). */
export interface WaConversationBot {
  paused: boolean;
  reason: string | null;
  reasonAr: string | null;
  handoff: boolean;
  typing: boolean;
}

/** The company's bot, as the inbox draws it: on, its name and the letter on its picture. */
export interface WaBotAgent {
  active: boolean;
  name: string;
  avatarText: string;
}

/** Two letters for an avatar: the first letters of the first two words of a name, or a number's last two digits. */
export function initials(name: string | null | undefined, phone: string | null | undefined): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  // No number yet (a thread still loading) is «؟», never a broken screen.
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.slice(-2) || '؟';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 24 * 60 * 60 * 1000;

/** The day a message belongs to, as a key that groups and as the words of its separator. */
export const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'أمس';
  return arDate(d);
}

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
/** The list's time: «14:05» today, «أمس», a weekday this week, else the date. */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diff <= 0) return arTime(d);
  if (diff === 1) return 'أمس';
  if (diff < 7) return WEEKDAYS[d.getDay()];
  return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`;
}

/** A poll's answer into what is on screen: a known id is REPLACED (its tick moved), a new one added, the whole kept in time order. */
export function mergeMessages(prev: WaMessage[], incoming: WaMessage[]): WaMessage[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, { ...byId.get(m.id), ...m });
  return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** The moment the next poll asks «what changed since». */
export function latestStamp(messages: WaMessage[]): string {
  let best = 0;
  for (const m of messages) {
    const t = new Date(m.updatedAt || m.createdAt).getTime();
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best ? new Date(best).toISOString() : '';
}

/**
 * THE REACTIONS UNDER EACH MESSAGE. One per side: the customer's latest and ours — a newer reaction replaces the older one, and
 * an empty one (Meta's «removed») takes it away.
 */
export function reactionsByTarget(messages: WaMessage[]): Map<string, { emoji: string; mine: boolean }[]> {
  const latest = new Map<string, WaMessage>();
  for (const m of messages) {
    if (m.messageType !== 'REACTION' || !m.reactionToId) continue;
    const k = `${m.reactionToId}|${m.direction}`;
    const had = latest.get(k);
    if (!had || new Date(m.createdAt).getTime() >= new Date(had.createdAt).getTime()) latest.set(k, m);
  }
  const out = new Map<string, { emoji: string; mine: boolean }[]>();
  for (const m of latest.values()) {
    if (!m.text) continue;
    const list = out.get(m.reactionToId!) ?? [];
    list.push({ emoji: m.text, mine: m.direction === 'OUTBOUND' });
    out.set(m.reactionToId!, list);
  }
  return out;
}

/** «3:07» */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** «1.2 م.ب» / «340 ك.ب» */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} م.ب`;
  return `${Math.max(1, Math.round(n / 1024))} ك.ب`;
}

/** A Google Maps link for a pin — opened in a new tab, never embedded. */
export const mapLink = (lat: number, lng: number): string => `https://www.google.com/maps?q=${lat},${lng}`;
