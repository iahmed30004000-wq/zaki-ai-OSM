/**
 * THE TWO SENTENCES «طلباتي» SHARES WITH THE SERVER — in a file of their own.
 *
 * They lived in confirmation-queue.ts, which imports the database client. The
 * desk (a browser screen) imported them from there, and that one import carried
 * src/lib/db.ts and the Prisma browser runtime — every model of the schema —
 * into the agent's download: any new table grew «طلباتي» (measured 19/11: the
 * warehouses' two tables pushed it 0.14 KB past its ceiling). confirmation-queue.ts
 * re-exports both, so every server caller and test reads them where it always did.
 */
export const CONTACT_FIRST_MESSAGE = 'اتصل بالزبون أول — أو اكبس «لا يرد»';

export const REGION_REQUIRED_MESSAGE = 'حدّد المحافظة أولاً — أجرة التوصيل مبنية عليها ولا يُؤكَّد طلب بلا محافظة';
