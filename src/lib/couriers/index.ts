import type { CourierAdapter } from './types';
import type { ShippingStatus } from '@/lib/shipping-workflow';
import { manualAdapter } from './manual';
import {
  LogesTechsAdapter,
  LOGESTECHS_STATUS,
  logesTechsFromEnv,
  logesTechsFromCredentials,
  type LogesTechsCredentials,
} from './logestechs';
import { decryptJson } from '@/lib/secrets';

/**
 * Adapter registry, keyed by DeliveryProvider.code.
 *
 * A provider with no registered adapter — or one whose `apiEnabled` is off —
 * is handled manually. That is the default on purpose: an integration starts
 * working only when someone deliberately turns it on for that provider.
 */
const ADAPTERS = new Map<string, CourierAdapter>([[manualAdapter.code, manualAdapter]]);

// LogesTechs registers itself only when its credentials are configured.
// Without them there is nothing to call, so the provider stays manual
// rather than failing at the first request.
const logesTechs = logesTechsFromEnv();
if (logesTechs) ADAPTERS.set(logesTechs.code, logesTechs);

export function registerAdapter(adapter: CourierAdapter): void {
  ADAPTERS.set(adapter.code.toUpperCase(), adapter);
}

/** What the registry needs to know about a courier to pick its adapter. */
export interface ProviderLike {
  code: string;
  /** Its display name, so the adapter's refusals read «الباشا رفض: …». */
  name?: string | null;
  apiEnabled?: boolean;
  /** Which integration it runs on. Falls back to its own code. */
  adapterCode?: string | null;
  /** That account's ids on the platform — not secret. */
  apiConfig?: unknown;
  /** The account's login, encrypted. Decrypted here and nowhere else. */
  apiCredentials?: string | null;
}

/**
 * The adapter for a courier.
 *
 * A courier is not a platform: Basha Delivery ships through LogesTechs, so
 * its adapterCode is LOGESTECHS while its own code stays BASHA. Two couriers
 * can run on the same platform under different accounts, which is why the
 * account's ids come from the courier row and not from the environment.
 *
 * Credentials come from the courier's own encrypted row when it has one,
 * and from the environment otherwise — so a second shipping company no
 * longer needs a deploy to be added, and the first one keeps working
 * untouched. A courier with an adapter named but no credentials anywhere
 * stays MANUAL rather than failing at the first call.
 */
export function adapterFor(provider: ProviderLike | null | undefined): CourierAdapter {
  if (!provider?.apiEnabled) return manualAdapter;

  const key = (provider.adapterCode || provider.code).trim().toUpperCase();

  if (key === 'LOGESTECHS') {
    // This courier's own account first; the environment only when it has none.
    const stored = decryptJson<LogesTechsCredentials>(provider.apiCredentials);
    const base = stored ? logesTechsFromCredentials(stored) : logesTechsFromEnv();
    if (!base) return manualAdapter; // no credentials — nothing to call

    const config = (provider.apiConfig ?? {}) as Record<string, unknown>;
    // A stored account carries its own company id; only fall back to the
    // config when it does not.
    const companyId = Number(stored?.companyId ?? config.companyId);
    if (!Number.isFinite(companyId)) return manualAdapter;

    // The courier's own account on the platform, over the shared credentials.
    return new LogesTechsAdapter({
      ...base.config,
      companyId,
      ...(provider.name?.trim() ? { courierName: provider.name.trim() } : {}),
      ...(Number.isFinite(Number(config.serviceTypeId)) ? { serviceTypeId: Number(config.serviceTypeId) } : {}),
      ...(Number.isFinite(Number(config.vehicleTypeId)) ? { vehicleTypeId: Number(config.vehicleTypeId) } : {}),
      ...(Number.isFinite(Number(config.originCityId))
        ? { origin: { ...base.config.origin, cityId: Number(config.originCityId) } }
        : {}),
    });
  }

  return ADAPTERS.get(key) ?? manualAdapter;
}

/**
 * Translate a courier's own status code WITHOUT needing their account.
 *
 * `adapterFor` hands back the manual adapter when there are no stored
 * credentials, and the manual adapter maps nothing — which is right for
 * CREATING a shipment, and wrong for reading one. Understanding what
 * "DELIVERED_TO_RECIPIENT" means is a lookup table, not an API call.
 *
 * This matters for the webhook: a courier can be pushing us statuses on the
 * day we set the URL up, weeks before their API login is in our hands. Tying
 * the vocabulary to the password would silently drop every one of them.
 */
/**
 * The platforms a courier can be wired to, for the picker on the settings
 * screen.
 *
 * A courier is not a platform. Basha Delivery ships through LogesTechs;
 * another courier could ship through the same platform under a different
 * account, and a third could have no platform at all and be worked by hand.
 * So the screen asks two questions — who is the courier, and what do they
 * run on — instead of assuming the name answers both.
 *
 * This list is the ONE place that knows what is wired. A new adapter is
 * added here and appears in the picker; nothing else needs touching.
 */
export const COURIER_PLATFORMS = [
  {
    code: 'LOGESTECHS',
    name: 'LogesTechs',
    /** What the account entry form will ask for, said plainly. */
    needs: 'بريد وكلمة مرور ورقم شركة لديهم',
    automated: true,
  },
  {
    code: 'MANUAL',
    name: 'يدوي — بلا ربط',
    needs: 'لا شيء: الشحنات تُنشأ والبوالص تُطبع من عندنا',
    automated: false,
  },
] as const;

export type CourierPlatformCode = (typeof COURIER_PLATFORMS)[number]['code'];

export function mapStatusFor(
  adapterCode: string | null | undefined,
  rawStatus: string
): ShippingStatus | null {
  const key = (adapterCode || '').trim().toUpperCase();
  if (key === 'LOGESTECHS') {
    // Unknown code → null, never a near match. A wrong mapping moves money.
    return LOGESTECHS_STATUS[rawStatus?.trim().toUpperCase()] ?? null;
  }
  return null;
}

export function isAutomated(provider: ProviderLike | null | undefined): boolean {
  return adapterFor(provider).automated;
}

export * from './types';
export { manualAdapter };
export { LogesTechsAdapter, LOGESTECHS_STATUS, LOGESTECHS_STATUS_AR } from './logestechs';
