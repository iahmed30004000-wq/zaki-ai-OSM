import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { AI_PROVIDERS, aiSettings, describeRoute, saveAiSettings, systemAi } from '@/lib/ai-provider';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { AI_JOBS, MAX_PROMPT } from '@/lib/ai-prompts';
import { ASSISTANTS } from '@/lib/ai-assistants';

/**
 * GET/PUT /api/settings/ai — which AI, which model, whose key.
 *
 * The key is WRITE-ONLY. It is encrypted before storage, this endpoint
 * never returns it, and the audit entry records that it changed without
 * recording what it changed to. Only a hint — the last four characters —
 * comes back, so somebody can tell which key is in there.
 */

const schema = z.object({
  /**
   * LOCAL IS ONE OF THEM, AND THE DROPDOWN HAS BEEN OFFERING IT.
   *
   * «نموذج على خادمك» is in `AI_PROVIDERS`, the company's provider
   * dropdown lists it, and this enum refused it — so choosing it and
   * pressing save answered with a validation error and no explanation of
   * which field was wrong. The system-settings route has accepted LOCAL
   * all along; this one simply never caught up.
   *
   * And it is refused WITHOUT an address, in the words that route already
   * uses, because a local model with nowhere to send the request saves
   * cleanly and fails at the moment somebody asks a question.
   */
  provider: z.enum(['OPENROUTER', 'OPENAI', 'ANTHROPIC', 'LOCAL', 'OPENAI_COMPATIBLE']).optional(),
  model: z.string().trim().max(120).optional(),
  /**
   * The company's own wording per AI job — the house prompt is the 'house'
   * job. Omitted leaves the stored ones alone; a job set to its default, or
   * to nothing, stops being an override.
   */
  prompts: z.record(z.string(), z.string().max(MAX_PROMPT)).optional(),
  /**
   * What the business-intelligence assistant may read. Omitted leaves it
   * alone; an unknown name is dropped rather than guessed at.
   */
  intelligenceScopes: z.array(z.string()).max(20).optional(),
  /** A new key, or null to clear it. Omitted leaves the stored one alone. */
  apiKey: z.string().trim().min(8).max(400).nullable().optional(),
  /**
   * A key per vendor. Same rules as the single key above: written, never
   * read back, and refused outright when encryption is unavailable.
   */
  providerKeys: z
    .record(z.string(), z.string().trim().min(8).max(400).nullable())
    .optional(),
  /** Per-assistant vendor and model. Unknown vendors are dropped on save. */
  assistants: z
    .record(
      z.string().max(40),
      z.object({ provider: z.string().max(20).optional(), model: z.string().trim().max(120).optional() }).strict()
    )
    .optional(),
});

/** The scopes alone — the boxes are ticked one at a time, not with the form. */
const scopesSchema = z.object({ intelligenceScopes: z.array(z.string()).max(20) });

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    /**
     * ── WHERE EACH ASSISTANT'S CALL WOULD ACTUALLY GO ──
     *
     * The screen used to answer this itself, from the company's own
     * provider and model — so an assistant routed by its own override, or
     * by the installation default, was described as something else. Two
     * answers to one question, and the wrong one on the screen beside the
     * control the owner was about to use.
     *
     * `describeRoute` is the same resolution `aiChat` performs, with the
     * key dropped before it leaves this process. `keyFrom` says WHICH
     * stored key would be used — «من النظام», «من الشركة» — never its
     * value.
     *
     * One entry per assistant plus the default, resolved in parallel:
     * each is a settings read, and the screen needs them all at once.
     */
    const jobs = [...new Set(ASSISTANTS.map((a) => a.promptJob))];
    const described = await Promise.all(jobs.map((job) => describeRoute(companyId, job)));

    return NextResponse.json({
      settings: await aiSettings(companyId),
      providers: AI_PROVIDERS,
      // The jobs and their DEFAULTS travel with the settings, because an
      // editor showing an override without what it replaces is an editor
      // nobody dares touch.
      jobs: AI_JOBS,
      /** The installation's answer when no assistant overrides it. */
      defaultRoute: await describeRoute(companyId),
      /** Per assistant job. Key-free by construction. */
      routes: Object.fromEntries(jobs.map((job, i) => [job, described[i]])),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }

    const before = await aiSettings(companyId);

    /*
     * A local model with nowhere to send the request saves cleanly and
     * then fails at the moment somebody asks a question. The address is
     * the installation's, not the company's, so the check reads the
     * system settings — the same sentence `settings/ai/system` answers
     * with, because two wordings for one refusal is two things to learn.
     */
    if (parsed.data.provider === 'LOCAL') {
      const { localBaseUrl } = await systemAi();
      if (!localBaseUrl) {
        return NextResponse.json(
          { error: 'اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.', code: 'ENDPOINT_REQUIRED' },
          { status: 400 }
        );
      }
    }

    /*
     * The compatible server's address is the installation's too, and a
     * company that picks it with none saved gets a setting that saves and
     * then fails at the first question. This route never takes an address or
     * a key for it — the schema above has no such field.
     */
    if (parsed.data.provider === 'OPENAI_COMPATIBLE') {
      const { compat } = await systemAi();
      if (!compat.baseUrl) {
        return NextResponse.json(
          { error: 'اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.', code: 'ENDPOINT_REQUIRED' },
          { status: 400 }
        );
      }
    }

    let saved;
    try {
      saved = await saveAiSettings(companyId, parsed.data, { name: user.name ?? null });
    } catch (e) {
      if (e instanceof Error && e.message === 'ENCRYPTION_KEY_MISSING') {
        // Refusing is the safe failure: a key stored in the clear is worse
        // than no AI at all.
        return NextResponse.json(
          {
            error: 'مفتاح التشفير غير مُهيّأ على الخادم (APP_ENCRYPTION_KEY) — لن يُحفظ مفتاح الذكاء بلا تشفير.',
            code: 'ENCRYPTION_UNAVAILABLE',
          },
          { status: 503 }
        );
      }
      throw e;
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'AI_SETTINGS_UPDATED',
      entity: 'Company',
      entityId: companyId,
      previousData: { provider: before.provider, model: before.model, hasKey: before.hasKey },
      // The key itself is never written to the log — only that it moved.
      newData: {
        provider: saved.provider,
        model: saved.model,
        hasKey: saved.hasKey,
        keyChanged: parsed.data.apiKey !== undefined,
      },
    });

    return NextResponse.json({ settings: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * PATCH — what the business-intelligence assistant may read.
 *
 * Its own call because a box is ticked on its own: sending the whole form
 * to change one scope would carry the provider, the model and the prompts
 * along with it, and a half-filled form would quietly undo them.
 */
export async function PATCH(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const parsed = scopesSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // Read for the audit's «before», not to be written back.
    const before = await aiSettings(companyId);
    /*
     * No `provider`/`model` here: ticking an intelligence scope is not
     * choosing a vendor, and `aiSettings()` computes those two when the
     * company never chose — so passing them was a write dressed as an
     * echo. Absent leaves what is stored.
     */
    const saved = await saveAiSettings(companyId, {
      intelligenceScopes: parsed.data.intelligenceScopes,
    });

    // Widening what an assistant may read is a decision worth a record.
    await logAudit({
      companyId,
      userId: user.id,
      action: 'AI_SCOPES_UPDATED',
      entity: 'Company',
      entityId: companyId,
      previousData: { intelligenceScopes: before.intelligenceScopes },
      newData: { intelligenceScopes: saved.intelligenceScopes },
    });

    return NextResponse.json({ settings: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
