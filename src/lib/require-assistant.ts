import { requirePermission } from '@/lib/authorization';
import type { AssistantDef } from '@/lib/ai-assistants';
import type { SessionUser } from '@/types/auth';

/**
 * THE ONE QUESTION EVERY IN-SCREEN ASSISTANT ASKS BEFORE IT WAKES A MODEL.
 *
 * The key of the work it sits in (`needs`) AND the key of the assistants (`gate`, `ai.assist`). Five routes asked only
 * the first, each in its own line, so «turn the model off for her, keep her on the desk» was a sentence nobody could
 * act on: the only box that turned the helper off was the one that turned the work off with it.
 *
 * The order matters for the message the person reads: the work key first, so a person with neither is told what they
 * miss for the work, not for the helper. A refusal on the gate throws the same `Forbidden: missing required
 * permission ai.assist` every other door throws, which `apiErrorResponse` turns into the Arabic 403.
 *
 * An assistant with no `gate` (the intelligence centre) is NOT one of these and is refused here: it answers to
 * `ai.use` at its own door, and quietly letting it through this one would make the gate optional in the one place
 * where it is the whole point.
 */
export async function requireAssistant(assistant: AssistantDef): Promise<SessionUser> {
  if (!assistant.gate) throw new Error(`Assistant ${assistant.key} has no gate`);
  const user = await requirePermission(assistant.needs);
  await requirePermission(assistant.gate);
  return user;
}
