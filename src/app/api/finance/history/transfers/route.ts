import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { answerHistory } from '@/lib/history-door';

/**
 * GET /api/finance/history/transfers?from=&to=&basis=real|registered&…&format=xlsx|print — «سجل التحويلات»: the company's transfers, as the transfers screen lists them.
 *
 * The list's own key (`finance.cashbox_view`), asked before anything is read; the same scope as the list on the screen (lib/history-export).
 * `format=xlsx` (the default) is the Excel file, `format=print` the page the browser prints or saves as PDF (lib/history-door).
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('finance.cashbox_view');
    return await answerHistory(req, 'transfers', { companyId, storeId, timeZone: country?.timezone ?? 'Asia/Damascus' });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
