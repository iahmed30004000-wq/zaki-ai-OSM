/**
 * «مساعد الاتصال» — IS THIS BROWSER ON AN ANDROID PHONE?
 *
 * The one place the question is asked. Only Chrome on Android opens an `intent://` link; anywhere else (a laptop, an
 * iPhone) the signed link does nothing at all, so the pairing card offers nothing and «اتصال» stays today's `tel:`.
 * Read in an effect, never during a render: the server has no navigator, and a different answer on hydration would
 * change an href under her finger.
 */
export function onAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
