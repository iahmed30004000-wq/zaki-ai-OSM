import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { importRemoteCampaigns } from '@/lib/ads/import';

/**
 * POST /api/growth/campaigns/import — pull the campaigns themselves.
 *
 * The sibling route next door pulls what each campaign SPENT, and it could
 * only ever do that for campaigns somebody had already typed in here and
 * matched by hand. This one brings the campaigns.
 *
 * ── THE SAME GATE AS THE CREATE FORM, AND I ALMOST GOT THIS WRONG ──
 *
 * This creates rows, each carrying a campaign code stamped into order
 * numbering from then on, so my first instinct was a stricter permission
 * than `/sync`'s — something like `campaigns.manage`.
 *
 * There is no such permission, and `POST /api/growth/campaigns` — typing a
 * campaign in by hand, the identical act — is gated on `reports.view`
 * alone. Inventing a permission so that the fast way
 * is harder than the slow way would be INVENTING POLICY, which is not this
 * route's to invent. Import is the create form done in bulk, so it asks for
 * exactly what the create form asks for.
 *
 * ── AND IT IS RATE LIMITED, WHICH `/sync` DOES NOT NEED TO BE ──
 *
 * A spend sync run twice writes the same figures twice. This one talks to
 * three third-party APIs and then writes rows, and a held button would be a
 * queue of `listCampaigns` calls against a rate limit the seller does not
 * control — losing the account to an `ERROR` status for everyone.
 *
 * Import is IDEMPOTENT by construction (it matches on `externalId` and
 * creates only what is missing), so the limit is about the platforms, not
 * about duplicate rows.
 */
export async function POST() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');

    const limit = rateLimit(`campaigns:import:${companyId}:${storeId ?? 'all'}`, 4, 5 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${limit.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    const result = await importRemoteCampaigns({ companyId, storeId, createdById: user.id });

    if (result.created > 0) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'CAMPAIGNS_IMPORTED',
        entity: 'Campaign',
        entityId: storeId ?? '',
        // Every code, because a code is stamped on orders from now on and
        // «created 14» is not something anybody can check afterwards.
        newData: {
          created: result.created,
          campaigns: result.accounts.flatMap((a) =>
            a.created.map((c) => ({ name: c.name, code: c.code, externalId: c.externalId }))
          ),
        },
      });
    }

    return NextResponse.json(result);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
