import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth';

/**
 * A PASSWORD CHECK THAT CAN NEVER SUCCEED, FOR WHEN THE EMAIL IS NOT AN ACCOUNT.
 *
 * Signing in with an email that exists costs one bcrypt comparison; one that does not used to cost nothing, and the
 * difference in time is a way to ask the login which emails are registered. This spends the same comparison against a
 * hash made once, at the same cost as every real one, from a password drawn at random and thrown away: nobody holds the
 * password, so the comparison is always false and the answer is ignored.
 *
 * Made on the first use, not at load: a hash made at import would slow the start of every route that imports this.
 */
let hash: Promise<string> | null = null;

export async function passwordMatchesNobody(attempt: string): Promise<false> {
  hash ??= hashPassword(randomUUID());
  await verifyPassword(attempt, await hash);
  return false;
}
