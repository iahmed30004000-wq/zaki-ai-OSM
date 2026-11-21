import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can, requirePermission } from '@/lib/authorization';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { resolveAudience } from '@/lib/notification-audience';
import { catalogItem } from '@/lib/permission-catalog';
import { DESK_KEYS } from '@/lib/desk-readiness';
import { nextWorkStart } from '@/lib/confirmation-rule-settings';
import { CONFIRMATION_RULE_KIND_AR, overlapRefusal, validateConfirmationRuleRow, type ConfirmationRuleKind, type ConfirmationRuleRow } from '@/lib/confirmation-rules';
import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { CHANNEL_KINDS, CHANNEL_KIND_AR } from '@/lib/order-channel-kinds';
import {
  BINDS_NOBODY_AR,
  KINDS_THAT_ACT,
  NOT_ACTING_YET_AR,
  OWN_RULE_NUMBERS,
  OWN_RULE_STATE_AR,
  RULE_DAYS,
  activeRowsFresh,
  lockRulesOf,
  candidateFromBody,
  payloadWords,
  previewAtTheDoor,
  ruleState,
  scopeWords,
  templateKeyOf,
  templatesAnswer,
} from '@/lib/confirmation-own-rules';

/**
 * GET/POST /api/confirmation/rules — «قواعد خاصة» on the rules page (request Q4c of the rules plan, 21/11).
 *
 *  · GET (`settings.view`) → every rule of the company, newest first, stopped ones included (never deleted), each in the server's words; the eight ready templates
 *    (OFF until pressed; how many active rules came from each); the numbers the dialog offers with their ranges; the stores; the desk's people of this store (names
 *    only with `users.view`, as «مين مربوطة»); whether the viewer may edit and the edit key's Arabic name; the store's next start of work; and (Q4d, 21/11) the
 *    company's products and the channel kinds — «على أي طلبات» of an order rule.
 *  · POST (`settings.manage` — the existing edit key of the rules page, the owner's decision R4 — AND `users.view`, since the answer names people) → the body read
 *    WHOLE (`candidateFromBody` → `validateConfirmationRuleRow`); people and store checked to be this company's; refused when another active rule of the same level
 *    sets the same number for the same target (`overlapRefusal`); then the preview (`previewAtTheDoor` — people built from their effective grants). A rule that binds
 *    nobody is saved only with `confirmBindsNobody: true` (409 `RULE_BINDS_NOBODY` with the preview otherwise). One audit row; the rules cache of this process is
 *    forgotten at once — another instance of the server follows within thirty seconds.
 * There is no DELETE: a rule is stopped from `…/[id]` and stays in the history.
 */

const READS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';
const EDIT_KEY = 'settings.manage';
const CREATED_ACTION ='CONFIRMATION_OWN_RULE_CREATED';

function refuse(status: number, code: string, errorAr: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: errorAr, errorAr, code, ...extra }, { status });
}

const tooMany = (retryAfterSec: number) =>
  NextResponse.json({ error: TOO_MANY, errorAr: TOO_MANY, code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(retryAfterSec) } });

const ROW_SELECT = {
  id: true, companyId: true, storeId: true, name: true, kind: true, userIds: true, productId: true, channelKind: true, phase: true,
  hoursFrom: true, hoursTo: true, effectiveFrom: true, effectiveTo: true, isActive: true, payload: true, createdAt: true, createdById: true,
} as const;

/** More products than a company sells by hand; the dialog's list is bounded all the same. */
const PRODUCTS_OFFERED = 500;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const viewer = await requirePermission('settings.view');
    const limit = rateLimit(`own-rules:${user.id}`, READS_PER_WINDOW, WINDOW_MS);
    if (!limit.allowed) return tooMany(limit.retryAfterSec);
    const seesNames = can(viewer, 'users.view');
    const now = Date.now();

    const rows = await db.confirmationRule.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 200, select: ROW_SELECT });
    const personIds = [...new Set(rows.flatMap((r) => [...strings(r.userIds), ...strings((r.payload as { toUserIds?: unknown } | null)?.toUserIds), r.createdById]))];
    const productIds = [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))];
    const activeIds = rows.filter((r) => r.isActive).map((r) => r.id);
    const [users, stores, products, made, desk, catalogue] = await Promise.all([
      seesNames && personIds.length ? db.user.findMany({ where: { id: { in: personIds }, companyId }, select: { id: true, name: true } }) : [],
      db.store.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      productIds.length ? db.product.findMany({ where: { id: { in: productIds }, companyId }, select: { id: true, name: true } }) : [],
      activeIds.length
        ? db.auditLog.findMany({ where: { companyId, entity: 'ConfirmationRule', action: CREATED_ACTION, entityId: { in: activeIds } }, select: { entityId: true, newData: true } })
        : [],
      seesNames && storeId ? resolveAudience({ companyId, storeId, audience: { anyPermission: DESK_KEYS } }) : null,
      // «على أي طلبات» of an order rule (Q4d): the company's products by name — names only, bounded.
      db.product.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: PRODUCTS_OFFERED }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const storeOf = new Map(stores.map((s) => [s.id, s.name]));
    const productOf = new Map(products.map((p) => [p.id, p.name]));
    const names = { person: (id: string) => nameOf.get(id) ?? null, store: (id: string) => storeOf.get(id) ?? null, product: (id: string) => productOf.get(id) ?? null };

    // How many ACTIVE rules came from each template: the create's audit row carries the template's key (a rename does not lose it).
    const fromTemplate = new Map<string, number>();
    for (const a of made) {
      let key: string | null = null;
      try {
        key = templateKeyOf((JSON.parse(a.newData ?? 'null') as { templateKey?: unknown } | null)?.templateKey);
      } catch {
        key = null;
      }
      if (key) fromTemplate.set(key, (fromTemplate.get(key) ?? 0) + 1);
    }

    return NextResponse.json({
      rules: rows.map((r) => {
        const checked = validateConfirmationRuleRow(r as ConfirmationRuleRow);
        const state = ruleState(r, now);
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          kindLabel: CONFIRMATION_RULE_KIND_AR[r.kind as ConfirmationRuleKind] ?? r.kind,
          state,
          stateAr: OWN_RULE_STATE_AR[state],
          whatAr: checked.ok ? payloadWords(checked.rule.payload, names.person).join(' · ') : 'القاعدة المحفوظة ما عادت مفهومة — ما بتشتغل',
          scopeAr: checked.ok ? scopeWords(checked.rule, names).join(' · ') : '',
          effectiveFrom: r.effectiveFrom.toISOString(),
          effectiveTo: r.effectiveTo?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          createdBy: names.person(r.createdById),
          broken: !checked.ok,
        };
      }),
      templates: templatesAnswer(fromTemplate),
      numbers: OWN_RULE_NUMBERS.filter((n) => KINDS_THAT_ACT.includes(n.kind)),
      notActingYetAr: NOT_ACTING_YET_AR,
      days: RULE_DAYS,
      stores,
      products: catalogue,
      channels: CHANNEL_KINDS.map((k) => ({ value: k, label: CHANNEL_KIND_AR[k] ?? k })),
      people: desk ? desk.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name, 'ar')) : null,
      canEdit: can(viewer, EDIT_KEY),
      editKeyLabel: catalogItem(EDIT_KEY)?.ar ?? EDIT_KEY,
      nextWorkStart: nextWorkStart(new Date(now), country).toISOString(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission(EDIT_KEY);
    await requirePermission('users.view');
    const limit = rateLimit(`own-rules-save:${user.id}`, READS_PER_WINDOW, WINDOW_MS);
    if (!limit.allowed) return tooMany(limit.retryAfterSec);
    if (!storeId) return refuse(400, 'STORE_REQUIRED', 'اختار متجر من فوق أول.');

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const now = Date.now();
    const candidate = candidateFromBody(body, { companyId, userId: user.id, nowMs: now, nextWorkStart: nextWorkStart(new Date(now), country) });
    if (!candidate.ok) return refuse(400, candidate.code, candidate.errorAr, { field: candidate.field });
    const { row, rule } = candidate;

    // Every id the rule names is this company's.
    if (rule.storeId && !(await db.store.findFirst({ where: { id: rule.storeId, companyId }, select: { id: true } }))) {
      return refuse(400, 'RULE_SCOPE', 'هالمتجر مش من متاجرك.', { field: 'storeId' });
    }
    // Q4d: the product an order rule names is this company's.
    if (rule.productId && !(await db.product.findFirst({ where: { id: rule.productId, companyId }, select: { id: true } }))) {
      return refuse(400, 'RULE_SCOPE', 'هالمنتج مش من منتجاتك.', { field: 'productId' });
    }
    if (rule.userIds) {
      const found = await db.user.findMany({ where: { id: { in: rule.userIds }, companyId }, select: { id: true } });
      if (found.length !== rule.userIds.length) return refuse(400, 'RULE_PEOPLE', 'في موظفة بالقائمة مش من شركتك.', { field: 'userIds' });
    }

    const others = await activeRowsFresh(db, companyId);
    const overlap = overlapRefusal(rule, others);
    if (overlap) return refuse(409, overlap.code, overlap.errorAr, { field: 'payload', otherRuleId: overlap.otherRuleId });

    const preview = await previewAtTheDoor(db, { companyId, storeId, country, rule, nowMs: now, others });
    if (preview.bindsNobody && body?.confirmBindsNobody !== true) {
      return refuse(409, 'RULE_BINDS_NOBODY', BINDS_NOBODY_AR, { preview });
    }

    // The overlap is asked again under the company's rules lock, and the row written in the same transaction: two saves at one moment cannot both pass it.
    const written = await db.$transaction(async (tx) => {
      await lockRulesOf(tx, companyId);
      const late = overlapRefusal(rule, await activeRowsFresh(tx, companyId));
      if (late) return { late };
      const created = await tx.confirmationRule.create({
        data: {
          companyId,
          storeId: row.storeId,
          name: rule.name,
          kind: rule.kind,
          userIds: rule.userIds ?? undefined,
          productId: row.productId,
          channelKind: row.channelKind,
          phase: row.phase,
          hoursFrom: row.hoursFrom,
          hoursTo: row.hoursTo,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          isActive: true,
          payload: rule.payload as object,
          createdById: user.id,
        },
        select: { id: true },
      });
      return { created };
    });
    if (written.late) return refuse(409, written.late.code, written.late.errorAr, { field: 'payload', otherRuleId: written.late.otherRuleId });
    const created = written.created!;
    forgetConfirmationRules(companyId);

    await logAudit({
      companyId, userId: user.id, action: CREATED_ACTION, entity: 'ConfirmationRule', entityId: created.id,
      newData: {
        templateKey: templateKeyOf(body?.templateKey),
        name: rule.name, kind: rule.kind, userIds: rule.userIds, storeId: rule.storeId, productId: rule.productId, channelKind: rule.channelKind, hoursFrom: rule.hoursFrom, hoursTo: rule.hoursTo,
        effectiveFrom: rule.effectiveFrom.toISOString(), effectiveTo: rule.effectiveTo?.toISOString() ?? null, payload: rule.payload,
        boundCount: preview.bound.length, confirmedBindsNobody: preview.bindsNobody,
      },
    });
    return NextResponse.json({ id: created.id, preview }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
