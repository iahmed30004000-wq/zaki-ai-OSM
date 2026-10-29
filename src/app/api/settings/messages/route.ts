import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { db } from '@/lib/db';
import {
  SITUATIONS,
  SITUATION_KEYS,
  saveTemplates,
  templatesFor,
  TEMPLATE_VARS,
  normalizeTemplate,
  type FillContext,
} from '@/lib/message-templates';
import { STORE_LANGUAGES, storeLanguageSchema } from '@/lib/store-languages';

/**
 * GET/PUT /api/settings/messages — the sentences sent to customers.
 *
 * Reading them needs no special permission: the tracking screen loads them
 * on every visit, and an agent who cannot read the list cannot send
 * anything. Writing them is settings work.
 */

const schema = z.object({
  templates: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(60),
        name: z.string().trim().min(2).max(60),
        channel: z.enum(['SMS', 'WHATSAPP', 'BOTH']),
        body: z.string().trim().min(5).max(1000),
        // Optional on the way in: a client that predates situations still
        // saves, and its templates land in "غير مصنّفة" rather than being
        // filed under a moment nobody chose.
        situation: z.enum(SITUATION_KEYS as [string, ...string[]]).optional(),
        lang: storeLanguageSchema.optional(),
        active: z.boolean().optional(),
      })
    )
    .max(40),
});

/**
 * A REAL order to preview against.
 *
 * The editor used to preview every template against a made-up order, which
 * checks the spelling of the placeholders and nothing else: a template can
 * read perfectly against "محمد / SY-2026-0150" and come out with a hole in
 * it on the orders this shop actually takes, because nobody here ever fills
 * in a governorate, or the courier is set after the message goes.
 *
 * So it is the most recent real order of this store — and it is behind the
 * settings permission, which the ungated read below is not: the tracking
 * screen loads the templates on every visit and has no business being
 * handed a customer it did not ask for.
 */
async function sampleOrder(companyId: string, storeId: string): Promise<FillContext | null> {
  const order = await db.order.findFirst({
    where: { companyId, storeId },
    orderBy: { createdAt: 'desc' },
    select: {
      orderNumber: true, totalAmount: true, currency: true, trackingNumber: true,
      customer: { select: { fullName: true } },
      region: { select: { name: true } },
      deliveryProvider: { select: { name: true } },
      store: { select: { name: true } },
    },
  });
  if (!order) return null;
  return {
    orderNumber: order.orderNumber,
    customerName: order.customer?.fullName ?? null,
    amount: order.totalAmount,
    currency: order.currency,
    courier: order.deliveryProvider?.name ?? null,
    barcode: order.trackingNumber,
    region: order.region?.name ?? null,
    storeName: order.store?.name ?? null,
  };
}

export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    const wantsSample = new URL(req.url).searchParams.get('sample') === '1';
    if (wantsSample) await requirePermission('settings.messages');

    return NextResponse.json({
      templates: await templatesFor(companyId),
      vars: TEMPLATE_VARS,
      situations: SITUATIONS,
      languages: STORE_LANGUAGES,
      ...(wantsSample ? { sample: await sampleOrder(companyId, storeId) } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.messages');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // Two templates sharing an id would make the picker send the wrong one.
    const ids = parsed.data.templates.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      return NextResponse.json({ error: 'يوجد قالبان بنفس المعرّف', code: 'DUPLICATE_ID' }, { status: 400 });
    }

    const saved = await saveTemplates(
      companyId,
      // Normalised here too: what is stored is always a whole template, so
      // nothing downstream has to cope with a half-written one.
      parsed.data.templates.map((t) => normalizeTemplate(t))
    );

    await logAudit({
      companyId,
      userId: user.id,
      action: 'MESSAGE_TEMPLATES_UPDATED',
      entity: 'Company',
      entityId: companyId,
      newData: { count: saved.length, names: saved.map((t) => t.name) },
    });

    return NextResponse.json({ templates: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
