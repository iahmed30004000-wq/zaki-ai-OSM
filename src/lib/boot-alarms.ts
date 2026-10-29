/**
 * WHAT MUST BE TRUE AT START-UP, SAID LOUDLY WHEN IT IS NOT.
 *
 * Since the second factor became mandatory on every role, the encryption
 * key is no longer a convenience for saving a courier password: the 2FA
 * secrets are encrypted with it, and `two-factor.ts` fails closed without
 * it. A deployment that starts with the key missing (or shorter than the
 * 32 characters `secrets.ts` insists on) does not misbehave on one screen —
 * it lets NOBODY sign in, and says nothing about why. The sign-in page
 * only shows a refusal.
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

  // `secrets.ts` reads the new name first and the old one second.
  const key = env.APP_ENCRYPTION_KEY || env.WHATSAPP_ENCRYPTION_KEY;
  if (!key) {
    alarms.push(
      'مفتاح التشفير (APP_ENCRYPTION_KEY) غير موجود. التحقق الثنائي مفروض على كل الحسابات وأسراره مشفّرة بهذا المفتاح، فلن يستطيع أحد تسجيل الدخول، ولن تُحفظ كلمة سر أي شركة شحن. أضفه في إعدادات النشر ثم أعد التشغيل.'
    );
  } else if (key.length < MIN_ENCRYPTION_KEY_LENGTH) {
    alarms.push(
      `مفتاح التشفير قصير (${key.length} حرفاً، والحدّ الأدنى ${MIN_ENCRYPTION_KEY_LENGTH}). النظام يرفضه، فلن يستطيع أحد تسجيل الدخول. ولّد مفتاحاً جديداً من 64 خانة.`
    );
  }

  return alarms;
}
