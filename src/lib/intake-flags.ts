/**
 * THE NAMES OF THE TWO INTAKE FLAGS — A FILE WITH NO IMPORTS (step C1 of Confirmation Center v2).
 *
 * `intake-filter.ts` writes them with the database; the order timeline (which a screen imports) and the flags route only need the names and the window. They live
 * here so nothing that reaches the browser pulls the database client in with a constant.
 */
export const INTAKE_DUPLICATE_ACTION = 'INTAKE_DUPLICATE';
export const INTAKE_SUSPECT_ACTION = 'INTAKE_SUSPECT_NUMBER';

/** «the same product within a day». The first order must be older than the new one, and no more than this much older. */
export const INTAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
