import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { AI_PROVIDERS, saveSystemAi, systemAi } from '@/lib/ai-provider';
import { allowedHosts, parseCompatEndpoint, parseCompatModel, parseLocalEndpoint } from '@/lib/ai-endpoint';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';

/**
 * GET/PUT /api/settings/ai/system — the INSTALLATION's vendor accounts.
 *
 * «المزوّد والمفتاح ... واحفظو للـ System». A company's AI settings are its
 * own voice — its prompts, what its assistant may read — and stay on
 * /api/settings/ai. What lives here is infrastructure: who pays the vendor,
 * which models exist, and where the owner's own model server is.
 *
 * THE KEY IS WRITE-ONLY, and more strictly than before. It is encrypted
 * before storage, this endpoint never returns it, and it never returns a
 * fragment of it either — no mask, no last-four. The courier-credentials
 * route is the pattern: it hints the LOGIN and never the PASSWORD, and an
 * AI key has no login beside it to hint instead. What comes back is which
 * vendor holds a key, when it was put there and who put it there.
 *
 * The audit records THAT a key moved, never what it moved to. An audit log
 * holding secrets is a second place to steal them from.
 */

const schema = z.object({
  /**
   * OPTIONAL, AND THAT IS THE FIX.
   *
   * The keys card sent `provider` and `model` with EVERY key save — the
   * values it happened to be holding — so pasting an Anthropic key
   * stamped whatever the dropdown showed into the installation default.
   * With nothing stored, that is OpenRouter and a free Llama, and from
   * then on the «المزوّد» dropdown could not move it: the next key save
   * put it back.
   *
   * Absent now means «leave it alone». «المزوّد» is the one place that
   * sets the default, and saving an account is saving an account.
   */
  provider: z.enum(['OPENROUTER', 'OPENAI', 'ANTHROPIC', 'LOCAL', 'OPENAI_COMPATIBLE']).optional(),
  model: z.string().trim().max(120).optional(),
  /** A key per vendor: a value sets it, null clears it, absent leaves it. */
  providerKeys: z.record(z.string(), z.string().trim().min(8).max(400).nullable()).optional(),
  /**
   * The address of a model the owner runs. Validated by `parseLocalEndpoint`
   * rather than by zod: what makes an address acceptable here is which
   * NETWORK it is on, which is a rule with reasons, not a pattern.
   */
  localBaseUrl: z.string().trim().max(300).nullable().optional(),
  /**
   * The address of an OpenAI-compatible server on the internet. Validated by
   * `parseCompatEndpoint`, which takes no allowlist: it is always an outside
   * party, and nothing in the environment can widen what it accepts.
   */
  compatBaseUrl: z.string().trim().max(300).nullable().optional(),
  /** The name that server answers to. Validated by `parseCompatModel`. */
  compatModel: z.string().trim().max(120).nullable().optional(),
});

/**
 * INSTALLATION SETTINGS NEED AN INSTALLATION-LEVEL ROLE.
 *
 * This is a RESTRICTION, not one of the `role === 'SUPER_ADMIN'` bypasses
 * `authorization.ts` forbids: `requirePermission` has already run and
 * already decided the caller may manage settings. This narrows that further,
 * because the row being written is shared by every company on the box — a
 * company admin changing their own prompts must not be able to change the
 * key every other company's assistant runs on.
 */
function refuseUnlessInstallationAdmin(role: string) {
  if (role === 'SUPER_ADMIN') return null;
  return NextResponse.json(
    {
      error: 'إعدادات الذكاء على مستوى النظام يضبطها مدير النظام فقط.',
      code: 'SUPER_ADMIN_ONLY',
    },
    { status: 403 }
  );
}

export async function GET() {
  try {
    const { user } = await requireContext();
    await requirePermission('settings.view');
    const denied = refuseUnlessInstallationAdmin(user.role);
    if (denied) return denied;

    return NextResponse.json({
      system: await systemAi(),
      providers: AI_PROVIDERS,
      // Whether an operator has allowed any host by hand, not WHICH — the
      // browser has no use for the list and it describes the network.
      hasHostAllowlist: allowedHosts().length > 0,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');
    const denied = refuseUnlessInstallationAdmin(user.role);
    if (denied) return denied;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    /**
     * WHERE THE SERVER MAY BE POINTED.
     *
     * Checked before anything is written, and the refusal is the rule's own
     * sentence — `ai-endpoint.ts` explains at length what a free-text base
     * URL can be abused for: exfiltrating every prompt to a host somebody
     * chose, reading the cloud metadata service, or reaching into the
     * private network from inside it.
     */
    let localBaseUrl: string | null | undefined;
    if (parsed.data.localBaseUrl !== undefined) {
      if (parsed.data.localBaseUrl === null || parsed.data.localBaseUrl === '') {
        localBaseUrl = null;
      } else {
        const checked = parseLocalEndpoint(parsed.data.localBaseUrl, allowedHosts());
        if (!checked.ok) {
          return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 });
        }
        localBaseUrl = checked.url;
      }
    }

    /*
     * THE COMPATIBLE SERVER — checked before anything is written.
     *
     * Three things travel together and each can be refused on its own:
     *   the address (`parseCompatEndpoint`: https, a public name, no IP);
     *   the model name (letters and digits, never the shape of a key);
     *   and the key, which is bound to the address it is saved for.
     * A key left behind after the address changed would be sent to the new
     * host by the next call, so a changed address with no new key is refused
     * instead of saved with nothing to talk to it.
     */
    const before = await systemAi();
    let compatBaseUrl: string | null | undefined;
    if (parsed.data.compatBaseUrl !== undefined) {
      if (parsed.data.compatBaseUrl === null || parsed.data.compatBaseUrl === '') {
        compatBaseUrl = null;
      } else {
        const checked = parseCompatEndpoint(parsed.data.compatBaseUrl);
        if (!checked.ok) {
          return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 });
        }
        compatBaseUrl = checked.url;
      }
    }

    let compatModel: string | null | undefined;
    if (parsed.data.compatModel !== undefined) {
      if (parsed.data.compatModel === null || parsed.data.compatModel === '') {
        compatModel = null;
      } else {
        const checked = parseCompatModel(parsed.data.compatModel);
        if (!checked.ok) {
          return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 });
        }
        // A key pasted into the model box is still a key. The shape check
        // catches the usual ones; this catches the exact value.
        const pasted = Object.values(parsed.data.providerKeys ?? {}).filter((v): v is string => !!v);
        if (pasted.includes(checked.model)) {
          return NextResponse.json(
            { error: 'هذا مفتاح لا اسم نموذج — الصقه في خانة المفتاح.', code: 'MODEL_INVALID' },
            { status: 400 }
          );
        }
        compatModel = checked.model;
      }
    }

    const effectiveCompatUrl = compatBaseUrl === undefined ? before.compat.baseUrl : compatBaseUrl;
    const effectiveCompatModel = compatModel === undefined ? before.compat.model : compatModel;
    if (effectiveCompatUrl && !effectiveCompatModel) {
      return NextResponse.json(
        { error: 'اكتب اسم النموذج كما يعرّفه خادمك.', code: 'MODEL_REQUIRED' },
        { status: 400 }
      );
    }
    if (parsed.data.provider === 'OPENAI_COMPATIBLE' && !effectiveCompatUrl) {
      return NextResponse.json(
        { error: 'اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.', code: 'ENDPOINT_REQUIRED' },
        { status: 400 }
      );
    }
    // A new address is a new place for the key to go. It must come with a key
    // of its own — the old one is deleted with the old address.
    const addressChanged = compatBaseUrl !== undefined && compatBaseUrl !== null && compatBaseUrl !== before.compat.baseUrl;
    if (addressChanged && !parsed.data.providerKeys?.OPENAI_COMPATIBLE) {
      return NextResponse.json(
        {
          error: 'عنوان جديد يلزمه مفتاح جديد — الصق مفتاح هذا الخادم، فالمفتاح القديم لا يُرسَل إلى عنوان غيره.',
          code: 'KEY_REQUIRED_FOR_NEW_URL',
        },
        { status: 400 }
      );
    }
    // A key with no address to bind to has nowhere it could ever be sent.
    if (parsed.data.providerKeys?.OPENAI_COMPATIBLE && !effectiveCompatUrl) {
      return NextResponse.json(
        { error: 'اكتب عنوان الخادم أولاً — المفتاح يُحفظ مع عنوانه.', code: 'ENDPOINT_REQUIRED' },
        { status: 400 }
      );
    }

    // A local model with nowhere to send the request saves cleanly and then
    // fails at the moment somebody asks a question. Said now instead.
    if (parsed.data.provider === 'LOCAL' && !(localBaseUrl ?? before.localBaseUrl)) {
      return NextResponse.json(
        { error: 'اكتب عنوان الخادم الذي يشغّل النموذج قبل اختياره مزوّداً.', code: 'ENDPOINT_REQUIRED' },
        { status: 400 }
      );
    }

    let saved;
    try {
      saved = await saveSystemAi({ ...parsed.data, localBaseUrl, compatBaseUrl, compatModel }, user.id);
    } catch (e) {
      if (e instanceof Error && e.message === 'ENCRYPTION_KEY_MISSING') {
        // Refusing is the safe failure: a key stored in the clear is worse
        // than no AI at all.
        return NextResponse.json(
          {
            error:
              'مفتاح التشفير غير مُهيّأ على الخادم (APP_ENCRYPTION_KEY) — لن يُحفظ مفتاح الذكاء بلا تشفير.',
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
      action: 'AI_SYSTEM_SETTINGS_UPDATED',
      entity: 'SystemSetting',
      entityId: 'ai',
      previousData: {
        provider: before.provider,
        model: before.model,
        localBaseUrl: before.localBaseUrl,
        compatBaseUrl: before.compat.baseUrl,
        compatModel: before.compat.model,
        // WHICH vendors held a key, never any part of one.
        configured: Object.entries(before.providerKeys).filter(([, v]) => v.configured).map(([k]) => k),
      },
      newData: {
        provider: saved.provider,
        model: saved.model,
        localBaseUrl: saved.localBaseUrl,
        compatBaseUrl: saved.compat.baseUrl,
        compatModel: saved.compat.model,
        configured: Object.entries(saved.providerKeys).filter(([, v]) => v.configured).map(([k]) => k),
        // That keys moved, and for which vendors. Never their values.
        keysTouched: Object.keys(parsed.data.providerKeys ?? {}),
      },
    });

    return NextResponse.json({ system: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
