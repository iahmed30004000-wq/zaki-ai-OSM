/**
 * WHY A REQUEST HAS NO SIGNED-IN PERSON — TWO ANSWERS THAT USED TO BE ONE.
 *
 * `getCurrentUser` caught every exception and answered «nobody». So a database that took too long to hand over a
 * connection (P2024) looked exactly like a signed-out agent: the API answered 401, `apiFetch` sent her to /login, and the
 * page guard did the same on every navigation. Confirmation agents read it as «the system threw me out» in the middle of
 * a shift. The owner's ruling 4/11: a busy server is not a sign-out.
 *
 * Kept in a module of its own, with no import, so `api-error.ts` can name these without pulling `next/headers` and the
 * session code in behind it — and so the tests that stand in for `@/lib/auth` still see the real classes.
 */

/**
 * What the device that was ended reads on /login (the owner's ruling 4/11: two devices, and a third ends the oldest; since
 * 12/11 five for the owner's own account — `devicesAllowed` in `sign-in.ts`). One sentence, here, because three places say
 * it: the login page, the API's 401 body, and nowhere else may invent its own.
 *
 * IT NAMES NO NUMBER. The device that reads it is signed out, so nothing says whose account it was: an agent's two and the
 * owner's five both end on this line, and «two devices … a third» was a false sentence for the second.
 */
export const SESSION_REPLACED_AR = 'انفتح حسابك على جهاز جديد وانتهى عدد الأجهزة المسموح — فطلع الأقدم، وهاد كان هو';

/** The session could not be checked because the database (or its pool) did not answer. NOT «signed out». */
export class AuthBackendDown extends Error {
  readonly code = 'SERVICE_BUSY';
  constructor(cause?: unknown) {
    super('Auth backend unavailable');
    this.name = 'AuthBackendDown';
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Nobody is signed in on this cookie — with the reason when there is one worth telling her. `message` stays
 * 'Unauthorized' on purpose: every route, test and mapper that already reads that word keeps reading it.
 *
 *   SESSION_REPLACED — this device was the oldest past the account's limit and a newer sign-in ended it (the owner's ruling
 *   4/11: two devices; five for his own account since 12/11).
 */
export class SessionEnded extends Error {
  constructor(readonly code?: 'SESSION_REPLACED') {
    super('Unauthorized');
    this.name = 'SessionEnded';
  }
}

/**
 * IS THIS THE DATABASE NOT ANSWERING, RATHER THAN A QUESTION IT ANSWERED?
 *
 * Read by name and code, not by `instanceof`, so it needs no Prisma import and survives two copies of the client in one
 * bundle. What counts: the engine could not start or connect (Initialization), it crashed (RustPanic), it failed in a
 * way it could not name (UnknownRequest), or a known error whose code is a connection one — every P1xxx (server
 * unreachable, timed out, closed) and P2024 (no connection free in the pool). Anything else — a bad token, a missing
 * cookie, a call outside a request — is not this, and stays «nobody».
 */
export function isBackendDown(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name === 'AuthBackendDown') return true;
  if (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientUnknownRequestError'
  ) {
    return true;
  }
  if (name === 'PrismaClientKnownRequestError' && typeof code === 'string') {
    return code.startsWith('P1') || code === 'P2024';
  }
  return false;
}
