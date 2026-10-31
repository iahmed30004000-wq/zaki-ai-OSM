/**
 * Issues an enrolment code from the server's shell, for an owner nobody else can issue one to (A2).
 *
 *   npx tsx scripts/issue-enrol-code.ts owner@shop.example
 *   npx tsx scripts/issue-enrol-code.ts owner@shop.example --reset-factor     the phone and the recovery codes are lost
 *
 * Prints the code ONCE; the database keeps only its hash, and it is good for one setup and one day. Without
 * `--reset-factor` an account that already has a second factor is refused. With it, the stored second factor, its recovery
 * codes, the sessions and the fingerprints of THAT account are cleared first, as the «أعد ضبط التحقق» button does.
 *
 * The code is asked for by the sign-in only while AUTH_ENROL_CODE_REQUIRED=on; with the switch off the account simply
 * sets up its second factor at the next sign-in, and the code is not needed.
 */
import { config } from 'dotenv';
config();

import { db } from '../src/lib/db';
import { logAudit } from '../src/lib/audit';
import { issueEnrolCodeByEmail, type ServerIssueDb } from '../src/lib/enrol-code';

const REFUSALS: Record<string, string> = {
  NOT_FOUND: 'لا يوجد حساب بهذا البريد',
  NOT_ACTIVE: 'الحساب غير مفعّل — فعّله أولاً',
  ALREADY_ENROLLED: 'التحقق بخطوتين مفعّل على هذا الحساب. لو ضاع الهاتف ورموز الاسترداد أضف --reset-factor',
};

async function main() {
  const email = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const resetFactor = process.argv.includes('--reset-factor');
  if (!email) {
    console.error('الاستعمال: npx tsx scripts/issue-enrol-code.ts <البريد> [--reset-factor]');
    process.exitCode = 1;
    return;
  }

  const out = await issueEnrolCodeByEmail(db as unknown as ServerIssueDb, email, { resetFactor });
  if (!out.ok) {
    console.error(REFUSALS[out.reason]);
    process.exitCode = 1;
    return;
  }

  await logAudit({
    companyId: out.companyId || 'platform',
    userId: out.userId,
    action: 'ENROL_CODE_ISSUED_BY_SERVER',
    entity: 'User',
    entityId: out.userId,
    // Never the code.
    newData: { employee: out.name, factorReset: out.factorReset, expiresAt: out.expiresAt.toISOString() },
  });

  console.log(`\nرمز التفعيل لـ${out.name ?? email}:\n\n    ${out.code}\n`);
  console.log('يظهر هذه المرة فقط، ويصلح لمرة واحدة ولمدة يوم.');
  if (out.factorReset) console.log('أُعيد ضبط التحقق بخطوتين لهذا الحساب وأُغلقت جلساته.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
