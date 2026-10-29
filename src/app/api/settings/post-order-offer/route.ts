import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import {
  DEFAULT_POST_ORDER_OFFER,
  postOrderOfferSettings,
  savePostOrderOfferSettings,
} from '@/lib/post-order-offer';

/**
 * GET/PUT /api/settings/post-order-offer — the WINDOW, and only the window.
 *
 * «زيد علبة كمان؟» may be taken while the order is still untouched, and
 * «untouched» has four halves. Three of them are facts about the order and
 * nobody sets them: it is still NEW, nobody has tried to reach the customer,
 * and it has not been taken already. The fourth is a judgement about this
 * shop — how long a seller is willing to let an order grow before the
 * confirmation team picks it up — and that is the one thing here.
 *
 * The three facts travel with the GET so the screen can state the whole rule
 * rather than the quarter of it that happens to be editable. They are not
 * read from the body on the way back in, for the reason the performance
 * door gives about its weights: a client that posted one would change
 * nothing, because they are not configuration.
 */

/** The parts of the rule the screen states and nobody sets. */
const FIXED_AR = [
  'الطلب لسا جديد — ما حدا بلّش فيه',
  'ما حدا تواصل مع الزبون بعد',
  'مرة واحدة لكل طلب',
];

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    return NextResponse.json({
      settings: await postOrderOfferSettings(companyId),
      defaults: DEFAULT_POST_ORDER_OFFER,
      // Shown, explained, and not editable anywhere.
      fixed: FIXED_AR,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('offers.rules');

    const before = await postOrderOfferSettings(companyId);
    // Parsed, clamped and narrowed by the settings module: anything that is
    // not the window is dropped rather than stored, and a window out of
    // range is clamped rather than refused — a settings row that throws
    // would take the thank-you screen down with it.
    const saved = await savePostOrderOfferSettings(companyId, await req.json().catch(() => null));

    await logAudit({
      companyId,
      userId: user.id,
      action: 'POST_ORDER_OFFER_SETTINGS_UPDATED',
      entity: 'Company',
      entityId: companyId,
      previousData: { ...before },
      newData: { ...saved },
    });

    return NextResponse.json({ settings: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
