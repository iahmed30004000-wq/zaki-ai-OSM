import { guardRoute, requireShellContext } from '@/lib/page-guard';
import { db } from '@/lib/db';
import { ConfirmationRulesScreen } from '@/components/screens/ConfirmationRulesScreen';
import { readRuleFacts, ruleSummaryLines } from '@/lib/confirmation-rule-summary';

export default async function Page() {
  await guardRoute('/confirmation/rules');
  // The box at the top reads what the engine reads: the two switches and the selected country's work hours. A failed read is «off» (each reader says so for itself).
  const { companyId, store } = await requireShellContext();
  const country = await db.country.findUnique({ where: { id: store.country.id }, select: { workHoursStart: true, workHoursEnd: true } }).catch(() => null);
  const facts = await readRuleFacts(db, companyId, country ?? {});
  return <ConfirmationRulesScreen lines={ruleSummaryLines(facts)} />;
}
