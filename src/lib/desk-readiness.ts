import { mayBeHandedAnOrder, mustHoldToWork } from './confirmation-queue';
import { catalogItem } from './permission-catalog';

/**
 * The keys that free their holder from «اسحبي الطلب أول». They live HERE, in a file the desk never imports, and not beside
 * `mustHoldToWork` in confirmation-queue.ts: that file reaches the desk's bundle, which sits at its ceiling, so the rule keeps
 * the two keys written out — and `desk-readiness.test.ts` pins that its source names exactly these keys, and that the rule agrees
 * with this list on every combination. Whatever SHOWS who is free of the rule (the rules page, the permissions screen's warning)
 * reads this list. `confirmation.supervise` is NOT one of them: adding it would excuse every live agent.
 */
export const EXEMPTS_FROM_HOLD = ['orders.unlock', 'orders.assign'] as const;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO IS BOUND AT THE CONFIRMATION DESK, AND WHAT EACH PERSON CAN DO THERE — read, never decided, here.
 *
 * The desk's rules are asked by the doors one key at a time (`mustHoldToWork`, `mayBeHandedAnOrder`, each door's own
 * `can(...)`). Nothing showed the owner the result for a PERSON: whether «اسحبي الطلب أول» binds her, which key frees her of
 * it, and which of the desk's tools she can press. Two agents of one role can differ (a personal «منع» or «سماح»), and the
 * lesson of 1/11 is that a rule judged on a key list typed by hand can excuse every real agent.
 *
 * So this file is PURE and takes `holds` — the real engine's answer for one person (`(k) => can(user, k)` on a user whose
 * grants came from `computeEffectiveGrants`, exactly as her session's). It never copies a rule: «bound» IS `mustHoldToWork`,
 * «may be handed» IS `mayBeHandedAnOrder`, the exemptions ARE `EXEMPTS_FROM_HOLD`. `confirmation.supervise` frees nobody.
 *
 * `DESK_TOOLS` names each thing an agent does at the desk, the door that does it and the keys THAT DOOR asks — read from
 * the door, and pinned to it by `desk-readiness.test.ts` (a key listed here that the door no longer asks turns it red).
 * Only the keys: what a door asks of the ORDER (that she holds it, its state) is not a key and is not drawn here.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type DeskToolId = 'pull' | 'log_call' | 'decide' | 'on_the_line' | 'hand_over' | 'raise_issue';

export interface DeskTool {
  id: DeskToolId;
  labelAr: string;
  /** The door that does it, from the repository root. */
  door: string;
  /** Every one of these is asked. */
  all: readonly string[];
  /** For each group, any one key of it is enough. */
  anyOf?: readonly (readonly string[])[];
}

export const DESK_TOOLS: readonly DeskTool[] = [
  { id: 'pull', labelAr: 'سحب الطلب التالي', door: 'src/app/api/confirmation/pull/route.ts', all: ['confirmation.pull'] },
  {
    id: 'log_call',
    labelAr: 'تسجيل نتيجة الاتصال',
    door: 'src/app/api/orders/[id]/contact-attempts/route.ts',
    all: ['orders.contact_log'],
    anyOf: [['orders.edit', 'orders.claim']],
  },
  { id: 'decide', labelAr: 'تأكيد أو رفض أو تأجيل', door: 'src/app/api/orders/[id]/confirmation/route.ts', all: ['orders.confirm'] },
  {
    id: 'on_the_line',
    labelAr: '«الزبون على الخط»',
    door: 'src/app/api/confirmation/callback-take/route.ts',
    all: ['confirmation.pull', 'confirmation.work', 'orders.view'],
  },
  {
    id: 'hand_over',
    labelAr: 'تحويل الطلب لزميلة',
    door: 'src/app/api/orders/[id]/transfer/route.ts',
    all: ['orders.view'],
    anyOf: [['orders.assign', 'orders.release']],
  },
  { id: 'raise_issue', labelAr: 'إدخال إشكال', door: 'src/app/api/confirmation/issues/route.ts', all: ['confirmation.raise_issue'] },
];

/** The keys that put a person at the desk: whoever holds none of them has no row on the rules page. */
export const DESK_KEYS = ['confirmation.work', 'confirmation.pull', 'orders.confirm'] as const;

export interface ToolReadiness {
  id: DeskToolId;
  has: boolean;
  /** What is missing: each entry is one key, or a group of which any one key would do. Empty when `has`. */
  missing: string[][];
}

/** Why «اسحبي الطلب أول» does not bind her — or `BOUND` when it does. */
export type HoldVerdict = 'BOUND' | 'OWNER' | 'EXEMPT' | 'DOES_NOT_WORK';

export interface DeskReadiness {
  /** Full access (the owner): every key, so never «missing» anything. */
  owner: boolean;
  /** `confirmation.work` — «العمل على طلباتي والمؤجلة». */
  worksDesk: boolean;
  /** `orders.confirm` — may change the confirmation status. */
  mayDecide: boolean;
  /** The real `mustHoldToWork`. */
  boundToHold: boolean;
  hold: HoldVerdict;
  /** Which of `EXEMPTS_FROM_HOLD` she holds. */
  exemptBy: string[];
  /** Decides orders without `confirmation.work`: no rule of the desk follows her (the moderator's case). */
  decidesWithoutWork: boolean;
  /** The real `mayBeHandedAnOrder`. */
  mayBeHanded: boolean;
  tools: ToolReadiness[];
}

function toolReadiness(tool: DeskTool, holds: (k: string) => boolean): ToolReadiness {
  const missing: string[][] = [];
  for (const key of tool.all) if (!holds(key)) missing.push([key]);
  for (const group of tool.anyOf ?? []) if (!group.some((k) => holds(k))) missing.push([...group]);
  return { id: tool.id, has: missing.length === 0, missing };
}

/**
 * One person's readiness at the desk. `holds` is the real engine's answer for her; `fullAccess` is her grants' own flag
 * (`computeEffectiveGrants` → `{ fullAccess: true }`), so the owner is said to be the owner and not «exempt».
 */
export function deskReadiness(holds: (permission: string) => boolean, opts: { fullAccess?: boolean } = {}): DeskReadiness {
  const owner = opts.fullAccess === true;
  const worksDesk = holds('confirmation.work');
  const boundToHold = mustHoldToWork(holds);
  const exemptBy = EXEMPTS_FROM_HOLD.filter((k) => holds(k));
  const hold: HoldVerdict = boundToHold ? 'BOUND' : owner ? 'OWNER' : !worksDesk ? 'DOES_NOT_WORK' : 'EXEMPT';
  return {
    owner,
    worksDesk,
    mayDecide: holds('orders.confirm'),
    boundToHold,
    hold,
    exemptBy,
    decidesWithoutWork: holds('orders.confirm') && !worksDesk,
    mayBeHanded: mayBeHandedAnOrder(holds),
    tools: DESK_TOOLS.map((t) => toolReadiness(t, holds)),
  };
}

/** A key's Arabic name, as «الصلاحيات» prints it. */
export function deskKeyLabel(key: string): string {
  return catalogItem(key)?.ar ?? key;
}

export interface LabelledKey {
  key: string;
  label: string;
}

/** The readiness as the door answers it: every key beside its Arabic name, every tool beside its own. */
export function labelledReadiness(r: DeskReadiness) {
  return {
    ...r,
    exemptBy: r.exemptBy.map((key): LabelledKey => ({ key, label: deskKeyLabel(key) })),
    tools: r.tools.map((t) => ({
      id: t.id,
      labelAr: DESK_TOOLS.find((d) => d.id === t.id)!.labelAr,
      has: t.has,
      missing: t.missing.map((group) => ({
        keys: group,
        label: group.map((k) => `«${deskKeyLabel(k)}»`).join(' أو '),
      })),
    })),
  };
}

export type LabelledDeskReadiness = ReturnType<typeof labelledReadiness>;
