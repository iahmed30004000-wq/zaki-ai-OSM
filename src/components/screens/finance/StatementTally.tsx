import { Rows, type Column } from '@/components/ui/Rows';
import { FoldCard } from '@/components/screens/finance/FoldCard';

/**
 * «هاد الكشف فيه مرتجع، لما رفعته ما ظهر المرتجع ليش؟» — WHERE EACH KIND OF THE COMPANY'S LINES LANDED.
 *
 * The queues are drawn by what the MATCHING made of a line (matched, a difference, no order of ours, excluded), and a
 * returned parcel falls into whichever its order allows: «مستبعدة» only when an order of ours is on the road or coming back
 * and the line is zero; «في الكشف وليس عندنا» when no order of ours carries it. The owner looked for «المرتجع» in a queue of
 * that name, found it empty, and could not tell that 44 returned parcels were in another one.
 *
 * So the count is by what the COMPANY wrote (its status word, read through the one phrase table) and says, for each kind,
 * how many lines went where — counted off the lines the screen already holds, nothing fetched and nothing worked out in
 * money. A row with no line is not counted: it is an order of ours the company never named, in its own queue.
 *
 * Drawn by the shared table (`Rows`): a table on a desk, a card per kind in a hand.
 */

import { COMPANY_WORD_AR, COMPANY_WORD_ORDER } from '@/lib/couriers/word-names';

/** The part of a match row the count reads: what the matching made of it, and what the company's word says. */
export interface TallyRow {
  result: string;
  statementLine: unknown;
  courierWord: { outcome: string } | null;
}

interface Landed {
  key: string;
  word: string;
  total: number;
  matched: number;
  mismatched: number;
  notOurs: number;
  excluded: number;
}

const COLUMNS: Column<Landed>[] = [
  { key: 'word', label: 'الشركة كتبت', primary: true, render: (r) => r.word },
  { key: 'total', label: 'العدد', align: 'end', render: (r) => r.total },
  { key: 'matched', label: 'مطابق', align: 'end', render: (r) => r.matched },
  { key: 'mismatched', label: 'فيه فرق', align: 'end', render: (r) => r.mismatched },
  { key: 'notOurs', label: 'ما عندنا طلب', align: 'end', render: (r) => r.notOurs },
  { key: 'excluded', label: 'مستبعد', align: 'end', render: (r) => r.excluded },
];

export function StatementTally({
  matches,
  open,
  onOpenChange,
}: {
  matches: TallyRow[];
  /** Open or shut as the screen kept it across a reload (see `FoldCard`). */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}) {
  const lines = matches.filter((m) => m.statementLine);
  if (lines.length === 0) return null;

  const landed = new Map<string, Landed>();
  for (const m of lines) {
    const key = m.courierWord?.outcome ?? 'NONE';
    const row = landed.get(key) ?? { key, word: COMPANY_WORD_AR[key] ?? COMPANY_WORD_AR.NONE, total: 0, matched: 0, mismatched: 0, notOurs: 0, excluded: 0 };
    row.total++;
    if (m.result === 'MATCHED') row.matched++;
    else if (m.result === 'MISMATCHED') row.mismatched++;
    else if (m.result === 'MISSING_IN_SYSTEM') row.notOurs++;
    else if (m.result === 'EXCLUDED') row.excluded++;
    landed.set(key, row);
  }
  const kinds = COMPANY_WORD_ORDER.filter((k) => landed.has(k)).map((k) => landed.get(k)!);
  const returned = landed.get('RETURNED');

  return (
    <section aria-label="شو كتبت الشركة وين صار">
      {/* Folded, closed (the owner, 12/11: «هدول يكونو مخفيات … أصلاً ما في زر إخفاء») — the count of each kind stays on the heading. */}
      <FoldCard
        title="شو كتبت الشركة، ووين صار كل نوع"
        holds={kinds.map((k) => `${k.total} ${k.word}`).join(' · ')}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Rows rows={kinds} columns={COLUMNS} keyOf={(r) => r.key} />
        {returned && returned.notOurs > 0 && (
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            من {returned.total} سطر قالت الشركة إنو رجع: {returned.notOurs} ما عندنا طلب لها، فبتلاقيها في «في الكشف وليس عندنا»
            {returned.excluded > 0 ? `، و${returned.excluded} مستبعدة` : ''}. قسم «مستبعدة» ما بيشيل إلا الراجع الصفري اللي إله طلب عندنا.
          </p>
        )}
      </FoldCard>
    </section>
  );
}
