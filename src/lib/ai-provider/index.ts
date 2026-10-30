/**
 * WHICH AI, AND WITH WHOSE KEY.
 *
 * The analysis used to read one environment variable and talk to one
 * vendor. That is a decision made once, at deploy time, by whoever had
 * shell access — and it is the wrong person: the company pays for the key,
 * and the company should be able to change vendor without a deploy.
 *
 * So the provider, the model and the key live in company settings, and the
 * three vendors share one call. They differ in exactly three ways — the
 * URL, the auth header, and where the answer sits in the response — and
 * nothing above this file needs to know which one is configured.
 *
 * THE KEY IS WRITE-ONLY. It is encrypted before it is stored, no endpoint
 * ever returns it, and only a hint (last four characters) is shown back so
 * somebody can tell which key is in there. If encryption is unavailable the
 * save is REFUSED rather than writing a key in the clear — a key in a
 * database anybody can read is worse than no AI at all.
 */

/*
 * Four files, one public surface (this one), unchanged from the single file it replaces:
 *   catalogue.ts  the vendors, their models, the tiers
 *   settings.ts   what is stored, what may be shown, how it is saved
 *   routing.ts    which vendor, model and key one call uses
 *   call.ts       the request, the refusals and the one fetch
 */
export {
  AI_PROVIDERS,
  RETIRED_MODELS,
  MODEL_TIERS,
  liveModel,
  tierOf,
  providerInfo,
  type AiProvider,
  type ProviderInfo,
} from './catalogue';
export {
  systemAi,
  saveSystemAi,
  aiSettings,
  saveAiSettings,
  type AiSettings,
  type SystemAiSettings,
  type SaveSystemAiInput,
} from './settings';
export { describeRoute, type AiRoute, type KeySource, type RouteDescription } from './routing';
export { aiChat, AiNotConfigured, AiEndpointMissing, AiNotLocal, type AiImage, type ChatRequest } from './call';
