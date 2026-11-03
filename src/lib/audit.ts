import { db } from './db';

/**
 * Fields stripped from customer snapshots before they are persisted
 * in audit logs. Phone + fullName are kept (operationally needed);
 * physical address, secondary phone and free-text notes are redacted.
 */
const CUSTOMER_REDACTED_FIELDS = ['address', 'altPhone', 'notes'] as const;

export function redactCustomerForAudit<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return obj;
  const copy: Record<string, unknown> = { ...obj };
  for (const field of CUSTOMER_REDACTED_FIELDS) {
    if (field in copy) copy[field] = '[REDACTED]';
  }
  return copy;
}

/**
 * Recursive redaction for arbitrary settings/metadata objects: any key
 * matching password/secret/token/key has its value replaced with
 * '[REDACTED]' before being written to the audit log.
 */
const SENSITIVE_KEY_PATTERN = /password|secret|token|key/i;

export function redactSensitiveValues(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitiveValues(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : redactSensitiveValues(v, depth + 1);
  }
  return out;
}

/**
 * «عاين كـ» (preview-mode.ts): who is really looking on this request, or null. Never throws — a module that cannot
 * load here (a test's stub) means «not a preview», and the row is written as given.
 */
async function previewOf(): Promise<{ ownerId: string; targetId: string } | null> {
  try {
    return await (await import('./auth')).previewOfThisRequest();
  } catch {
    return null;
  }
}

export async function logAudit({
  companyId,
  userId,
  action,
  entity,
  entityId,
  previousData,
  newData,
}: {
  companyId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId: string;
  previousData?: any;
  newData?: any;
}) {
  try {
    // «عاين كـ» (preview-mode.ts): a row this request would write in the previewed person's name — an export, say — is
    // written under the OWNER, with a note saying whose screen he was on. Never silent, never in her name. Only a
    // request the proxy stamped is a preview; the preview's own start and end are recorded as they are.
    let who = userId || null;
    const preview = who ? await previewOf() : null;
    if (preview && who === preview.targetId) {
      const her = await db.user.findUnique({ where: { id: preview.targetId }, select: { name: true } });
      who = preview.ownerId;
      const base = newData && typeof newData === 'object' && !Array.isArray(newData) ? newData : newData === undefined ? {} : { value: newData };
      newData = { ...base, duringPreview: `أثناء المعاينة كـ ${her?.name ?? preview.targetId}` };
    }
    await db.auditLog.create({
      data: {
        companyId,
        userId: who,
        action,
        entity,
        entityId,
        previousData: previousData ? JSON.stringify(previousData) : null,
        newData: newData ? JSON.stringify(newData) : null,
      },
    });
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}
