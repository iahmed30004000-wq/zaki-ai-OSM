import { bootstrapGuardOn } from './auth-switches';

/**
 * MAY THIS REGISTRATION CREATE THE OWNER? (A3)
 *
 * `INITIAL_SUPER_ADMIN_EMAIL` exists for one moment: a fresh database with nobody in it, where the first person to
 * register with that email becomes the owner. It used to stay armed for ever, so anybody who later registered that
 * email (after the owner's row was deleted, or on a copy of the database) was made an owner with no check at all.
 *
 * Now it works only while the database has NO SUPER_ADMIN, whatever that account's status: a suspended owner is still an
 * owner, and re-creating one is a recovery done by hand and with eyes open, not by a registration form.
 *
 * `AUTH_BOOTSTRAP_GUARD=off` restores the old behaviour for a recovery the owner chooses to make.
 *
 * Pure, so the rule is read and tested without a request. The caller counts the owners.
 */
export function mayBootstrapOwner(input: {
  configuredEmail: string | undefined;
  email: string;
  superAdminCount: number;
}): boolean {
  const configured = (input.configuredEmail ?? '').trim().toLowerCase();
  if (configured === '' || input.email.trim().toLowerCase() !== configured) return false;
  return bootstrapGuardOn() ? input.superAdminCount === 0 : true;
}
