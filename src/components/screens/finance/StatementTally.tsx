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
 */

/** The part of a match row the count reads: what the matching made of it, and what the company's word says. */
export interface TallyRow {
  result: string;
  statementLine: unknown;
  courierWord: { outcome: string } | null;
}

const COMPANY_WORD_AR: Record<string, string> = {
  DELIVERED: 'سُلِّمت',
  PARTIAL: 'سُلِّمت جزئياً',
  RETURNED: 'رجعت',
  POSTPONED: 'مؤجَّلة',
  CANCELLED: 'مُلغاة',
  IN_TRANSIT: 'ما زالت عند الشركة',
  OTHER: 'كلمة معروفة أخرى',
  UNKNOWN: 'كلمة ما نعرفها بعد',
  NONE: 'بلا كلمة',
};
const COMPANY_WORD_ORDER = ['DELIVERED', 'PARTIAL', 'RETURNED', 'POSTPONED', 'CANCELLED', 'IN_TRANSIT', 'OTHER', 'UNKNOWN', 'NONE'];

interface Landed {
  total: number;
  matched: number;
  mismatched: number;
  notOurs: number;
  excluded: number;
}

export function StatementTally({ matches }: { matches: TallyRow[] }) {
  const lines = matches.filter((m) => m.statementLine);
  if (lines.length === 0) return null;

  const landed = new Map<string, Landed>();
  for (const m of lines) {
    const key = m.courierWord?.outcome ?? 'NONE';
    const row = landed.get(key) ?? { total: 0, matched: 0, mismatched: 0, notOurs: 0, excluded: 0 };
    row.total++;
    if (m.result === 'MATCHED') row.matched++;
    else if (m.result === 'MISMATCHED') row.mismatched++;
    else if (m.result === 'MISSING_IN_SYSTEM') row.notOurs++;
    else if (m.result === 'EXCLUDED') row.excluded++;
    landed.set(key, row);
  }
  const kinds = COMPANY_WORD_ORDER.filter((k) => landed.has(k));
  const returned = landed.get('RETURNED');

  return (
    <section aria-label="شو كتبت الشركة وين صار" className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-3 space-y-2">
      <h2 className="text-sm font-medium text-[var(--sys-heading)]">شو كتبت الشركة، ووين صار كل نوع</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[var(--sys-muted-foreground)]">
            <tr>
              <th scope="col" className="text-start font-medium py-1 pe-3">الشركة كتبت</th>
              <th scope="col" className="text-end font-medium py-1 px-2">العدد</th>
              <th scope="col" className="text-end font-medium py-1 px-2">مطابق</th>
              <th scope="col" className="text-end font-medium py-1 px-2">فيه فرق</th>
              <th scope="col" className="text-end font-medium py-1 px-2">ما عندنا طلب</th>
              <th scope="col" className="text-end font-medium py-1 ps-2">مستبعد</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {kinds.map((k) => {
              const r = landed.get(k)!;
              return (
                <tr key={k} className="border-t border-[var(--sys-border)]">
                  <th scope="row" className="text-start font-medium py-1 pe-3">{COMPANY_WORD_AR[k]}</th>
                  <td className="text-end py-1 px-2">{r.total}</td>
                  <td className="text-end py-1 px-2">{r.matched}</td>
                  <td className="text-end py-1 px-2">{r.mismatched}</td>
                  <td className="text-end py-1 px-2">{r.notOurs}</td>
                  <td className="text-end py-1 ps-2">{r.excluded}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {returned && returned.notOurs > 0 && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          من {returned.total} سطر قالت الشركة إنو رجع: {returned.notOurs} ما عندنا طلب لها، فبتلاقيها في «في الكشف وليس عندنا»
          {returned.excluded > 0 ? `، و${returned.excluded} مستبعدة` : ''}. قسم «مستبعدة» ما بيشيل إلا الراجع الصفري اللي إله طلب عندنا.
        </p>
      )}
    </section>
  );
}
