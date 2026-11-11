import { twoFactorRequired } from './auth-switches';

/**
 * WHAT MUST BE TRUE AT START-UP, SAID LOUDLY WHEN IT IS NOT.
 *
 * WHILE THE SECOND FACTOR IS REQUIRED (`AUTH_TWO_FACTOR_REQUIRED=on`, the rule before 11/11) the encryption key is no
 * longer a convenience for saving a courier password: the 2FA
 * secrets are encrypted with it, and `two-factor.ts` fails closed without
 * it. A deployment that starts with the key missing (or shorter than the
 * 32 characters `secrets.ts` insists on) does not misbehave on one screen —
 * it lets NOBODY sign in, and says nothing about why. The sign-in page
 * only shows a refusal.
 *
 * WITH THE SWITCH OFF (the default, the owner's ruling 11/11) nobody is asked for the second code, so a missing key locks
 * nobody out — and saying it does would be an alarm that cries wolf in the one log a deployer reads. What stays true, and
 * is still said: without the key no courier password can be saved.
 *
 * So the worker, which starts with every container, asks once and prints
 * what it finds into the log a deployer actually reads. It does not stop
 * the process: a worker that exits would be restarted in ten seconds
 * forever, burying the one line that matters under its own crash loop.
 *
 * Pure on purpose: it takes the environment and returns sentences, so a
 * test can feed it a bad one.
 */

/** The shortest key `secrets.ts` accepts. Kept here as a number, not imported, so a change to one is seen in the other's test. */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

export function bootAlarms(env: Record<string, string | undefined>): string[] {
  const alarms: string[] = [];
  const locksEveryoneOut = twoFactorRequired(env);

  // `secrets.ts` reads the new name first and the old one second.
  const key = env.APP_ENCRYPTION_KEY || env.WHATSAPP_ENCRYPTION_KEY;
  if (!key) {
    alarms.push(
      locksEveryoneOut
        ? 'مفتاح التشفير (APP_ENCRYPTION_KEY) غير موجود. التحقق الثنائي مفروض على كل الحسابات وأسراره مشفّرة بهذا المفتاح، فلن يستطيع أحد تسجيل الدخول، ولن تُحفظ كلمة سر أي شركة شحن. أضفه في إعدادات النشر ثم أعد التشغيل.'
        : 'مفتاح التشفير (APP_ENCRYPTION_KEY) غير موجود. لن تُحفظ كلمة سر أي شركة شحن. أضفه في إعدادات النشر ثم أعد التشغيل.'
    );
  } else if (key.length < MIN_ENCRYPTION_KEY_LENGTH) {
    alarms.push(
      locksEveryoneOut
        ? `مفتاح التشفير قصير (${key.length} حرفاً، والحدّ الأدنى ${MIN_ENCRYPTION_KEY_LENGTH}). النظام يرفضه، فلن يستطيع أحد تسجيل الدخول. ولّد مفتاحاً جديداً من 64 خانة.`
        : `مفتاح التشفير قصير (${key.length} حرفاً، والحدّ الأدنى ${MIN_ENCRYPTION_KEY_LENGTH}). النظام يرفضه، فلن تُحفظ كلمة سر أي شركة شحن. ولّد مفتاحاً جديداً من 64 خانة.`
    );
  }

  return alarms;
}
