/**
 * THE BOT'S MODEL — any OpenAI-compatible server (`/chat/completions` with tools), by default the one Sarah uses.
 *
 * This file talks to the model and does nothing else: it writes nothing, and it is not the file that changes an order
 * (that is `order-door.ts`, which never talks to a model — the rule `ai-proposal-only.test.ts` holds the tree to).
 *
 * The key rides in the Authorization header only. It is never logged, never put in an error, and an error text the
 * server sends back is scrubbed of it before anything else reads it. A redirect is an error, not a hop (the key would
 * follow it), and every call has a timeout.
 */
import { createHash } from 'node:crypto';
import { chatCompletionsUrl } from '../../ai-endpoint';

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}
export interface LlmReply {
  content: string;
  toolCalls: LlmToolCall[];
  finish: string;
}

export interface ModelConn {
  baseUrl: string;
  apiKey: string;
  /** Empty = the first model the server lists. */
  model: string | null;
}

/** Arabic-safe, key-free reasons. The screen shows these; nothing else of a failure leaves the server. */
export class LlmError extends Error {
  constructor(readonly code: 'AUTH' | 'TIMEOUT' | 'UNREACHABLE' | 'REFUSED' | 'NO_MODEL' | 'BAD_ANSWER', message: string) {
    super(message);
  }
}

export const MODEL_TIMEOUT_MS = 45_000;

/** The models list sits beside the chat endpoint: `…/v1` → `…/v1/models`. */
export function modelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

/** Anything key-like taken out of a text the server sent back. */
export function scrubKey(text: string, key: string): string {
  let out = text;
  if (key) out = out.split(key).join('[key]');
  return out.replace(/(sk|pk|key)[-_][A-Za-z0-9_-]{8,}/gi, '[key]').replace(/[A-Za-z0-9]{32,}/g, '[…]');
}

const keyTag = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const listed = new Map<string, { id: string; at: number }>();

/** The model to ask: the saved name, else the first the server lists (remembered for an hour per server and key). */
export async function modelId(conn: ModelConn, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (conn.model) return conn.model;
  const tag = `${conn.baseUrl}|${keyTag(conn.apiKey)}`;
  const hit = listed.get(tag);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.id;
  let res: Response;
  try {
    res = await fetchImpl(modelsUrl(conn.baseUrl), {
      headers: { authorization: `Bearer ${conn.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw (e as Error)?.name === 'TimeoutError'
      ? new LlmError('TIMEOUT', 'الموديل ما ردّ بالوقت — جرّب بعد شوي')
      : new LlmError('UNREACHABLE', 'ما قدرنا نوصل لخادم الموديل');
  }
  if (res.status === 401 || res.status === 403) throw new LlmError('AUTH', 'الخادم رفض المفتاح — تأكد منه');
  if (!res.ok) throw new LlmError('REFUSED', `خادم الموديل ردّ بخطأ (${res.status})`);
  const j = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  const id = typeof j?.data?.[0]?.id === 'string' ? (j!.data![0].id as string) : '';
  if (!id) throw new LlmError('NO_MODEL', 'الخادم ما ذكر أي موديل — اكتب اسم الموديل بالإعدادات');
  listed.set(tag, { id, at: Date.now() });
  return id;
}

/** One completion, not streamed: the text and the tool calls whole. */
export async function complete(
  conn: ModelConn,
  messages: LlmMessage[],
  tools: LlmTool[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<LlmReply> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = await modelId(conn, fetchImpl);
  // No tools, no tool_choice: some compatible servers refuse a tool_choice with an empty list.
  const body = JSON.stringify({
    model,
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    stream: false,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1200,
  });
  let res: Response;
  try {
    res = await fetchImpl(chatCompletionsUrl(conn.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? MODEL_TIMEOUT_MS),
    });
  } catch (e) {
    throw (e as Error)?.name === 'TimeoutError'
      ? new LlmError('TIMEOUT', 'الموديل ما ردّ بالوقت — جرّب بعد شوي')
      : new LlmError('UNREACHABLE', 'ما قدرنا نوصل لخادم الموديل');
  }
  // A refused key is reported by its status alone: such answers often quote part of the key back.
  if (res.status === 401 || res.status === 403) throw new LlmError('AUTH', 'الخادم رفض المفتاح — تأكد منه');
  if (!res.ok) {
    const detail = scrubKey(await res.text().catch(() => ''), conn.apiKey).replace(/\s+/g, ' ').slice(0, 160);
    throw new LlmError('REFUSED', `خادم الموديل ردّ بخطأ (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const j = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
  } | null;
  const choice = j?.choices?.[0];
  if (!choice?.message) throw new LlmError('BAD_ANSWER', 'جواب الموديل ما انقرى');
  const raw = typeof choice.message.content === 'string' ? choice.message.content : '';
  const content = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim();
  const calls: LlmToolCall[] = [];
  if (Array.isArray(choice.message.tool_calls)) {
    choice.message.tool_calls.forEach((t: any, i: number) => {
      const name = typeof t?.function?.name === 'string' ? t.function.name : '';
      if (!name) return;
      const args = typeof t?.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t?.function?.arguments ?? {});
      calls.push({ id: typeof t?.id === 'string' && t.id ? t.id : `call_${i}`, type: 'function', function: { name, arguments: args } });
    });
  }
  return { content, toolCalls: calls, finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : '' };
}

/** «اختبر الاتصال»: one tiny request — the model's name, the time it took and its word, or why it failed (never the key). */
export async function pingModel(conn: ModelConn, fetchImpl: typeof fetch = fetch) {
  const t = Date.now();
  try {
    const model = await modelId(conn, fetchImpl);
    const r = await complete(
      conn,
      [
        { role: 'system', content: 'Reply with one short Arabic word.' },
        { role: 'user', content: 'مرحبا' },
      ],
      [],
      { maxTokens: 400, timeoutMs: 30_000, fetchImpl }
    );
    return { ok: true as const, model, ms: Date.now() - t, reply: r.content.slice(0, 120) };
  } catch (e) {
    return { ok: false as const, error: e instanceof LlmError ? e.message : 'ما قدرنا نوصل للموديل' };
  }
}
