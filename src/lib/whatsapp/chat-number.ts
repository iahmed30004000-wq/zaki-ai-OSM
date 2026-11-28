import { waNumber } from '../message-templates';
import { toLatinDigits } from '../latin-digits';

/**
 * A number a person typed, as WhatsApp keys a chat — full international digits, no + — or '' when it cannot be one.
 *
 * With + or 00 it is international; a local number takes the store's calling code (`waNumber`, the rule every WhatsApp
 * button here uses). Eight to fifteen digits: shorter is no number anywhere, longer is not a phone (E.164).
 */
export function chatNumber(raw: string, dialCode: string | null): string {
  const to = waNumber(toLatinDigits(String(raw ?? '')).trim(), dialCode);
  return /^\d{8,15}$/.test(to) ? to : '';
}
