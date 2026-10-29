import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { isAdPlatform } from '@/lib/ads';
import { authorizeUrl, makeState, oauthMissing } from '@/lib/ads/oauth';

/**
 * GET /api/settings/ad-accounts/oauth/:platform/start
 *
 * Sends the seller to the platform's consent screen. A GET because it ends
 * in a redirect a browser follows — a POST could not be a link, and a form
 * posting to a third party is the shape phishing takes.
 *
 * ── WHAT IT REFUSES, AND WHY EACH REFUSAL IS ITS OWN ANSWER ──
 *
 * An unsupported platform is 404: the path named something that is not one
 * of the three.
 *
 * A platform with no APP CONFIGURED is 503 with the env var names and where
 * to register — not 404 and not 500. The distinction matters because the
 * fix is an administrator's, not a seller's, and «not configured» is the
 * only message that leads anybody to it. The screen reads this and draws a
 * sentence instead of a button, so this path is normally unreachable; it
 * exists because a button can be clicked faster than a screen can refresh.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  try {
    const { platform } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.manage');

    if (!isAdPlatform(platform)) {
      return NextResponse.json({ error: 'منصّة غير مدعومة' }, { status: 404 });
    }

    const state = makeState({ companyId, storeId, platform });
    const url = authorizeUrl(platform, state);

    if (!url) {
      const missing = oauthMissing(platform);
      return NextResponse.json(
        {
          error: 'الربط بتسجيل الدخول غير مهيّأ على الخادم بعد',
          code: 'OAUTH_NOT_CONFIGURED',
          // The names, not the values — there are no values to leak, and
          // naming them is the whole point of this answer.
          envKeys: missing?.envKeys ?? [],
          register: missing?.register ?? null,
        },
        { status: 503 }
      );
    }

    /*
     * AUDITED BEFORE THE REDIRECT, not after the token arrives.
     *
     * A flow that was started and never finished is a fact worth having:
     * a seller who presses this three times and never connects is a seller
     * whose consent screen is refusing them, and nothing else in the system
     * would say so. The platform and who pressed it — never the state,
     * which is a credential for ten minutes.
     */
    await logAudit({
      companyId,
      userId: user.id,
      action: 'AD_ACCOUNT_OAUTH_STARTED',
      entity: 'AdAccount',
      entityId: storeId ?? '',
      newData: { platform, by: user.name },
    });

    return NextResponse.redirect(url, { status: 302 });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
