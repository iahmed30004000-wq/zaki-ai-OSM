import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, RETIRED_MODELS, liveModel, tierOf } from './ai-provider';
import { ASSISTANTS } from './ai-assistants';
import { dashboardFiles, repoFile, stripComments } from './guard-source';

/**
 * A VENDOR PER ASSISTANT, AND A KEY PER VENDOR.
 *
 * One model for the whole product could not express the decision that
 * actually matters here: the note classifier runs on every follow-up note,
 * thousands a day, and the business analysis runs when somebody asks.
 * Charging both to an opus-tier model is how an AI bill becomes a
 * surprise; charging both to the cheapest is how the analysis becomes
 * useless.
 *
 * Two things must hold for that to be safe, and neither is obvious from
 * reading the screen.
 */

describe('routing a call', () => {
  /**
   * THE KEY MUST BELONG TO THE VENDOR THAT WAS RESOLVED.
   *
   * Pointing an assistant at Anthropic while the only key in the box is
   * OpenAI's is a setting that SAVES CLEANLY and fails only when somebody
   * asks a question — far from the screen that caused it. The resolver
   * picks the key by the provider it resolved, and the environment key,
   * whose name says `OPENROUTER`, is offered to OpenRouter alone.
   */
  it('takes the key of the provider it resolved, never whichever is stored', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/routing.ts'));
    expect(src, 'لا موجِّه لكلّ مساعد').toContain('async function routeFor');
    // The per-vendor store is consulted by the resolved provider's id.
    expect(src).toMatch(/ai\.keys\?\.\[provider\]/);
    // The legacy single key is only offered to the provider it was entered
    // under — never handed to a vendor that did not issue it.
    expect(src).toMatch(/provider === fallback && ai\.apiKeyEncrypted/);
    /*
     * And the environment key is OpenRouter's, by its own name.
     *
     * Asked as a RULE and not as a line: this used to pin the one-liner
     * `if (!key && provider === 'OPENROUTER') key = process.env…`, and it
     * broke the day that statement became a block — without the property
     * changing at all. What matters is that `OPENROUTER_API_KEY` is read
     * nowhere except under a check that the resolved provider is
     * OPENROUTER and that nothing was found before it.
     */
    // The ASSIGNMENT, not every mention: `aiSettings` also reads the
    // variable to decide whether the screen says a key exists, and that
    // is a different question from which key a call carries.
    const envReads = [...src.matchAll(/key = process\.env\.OPENROUTER_API_KEY/g)];
    expect(envReads, 'ما عاد يأخذ مفتاح البيئة').toHaveLength(1);
    const before = src.slice(0, envReads[0].index);
    const guard = before.slice(before.lastIndexOf('if ('));
    expect(guard, 'مفتاح البيئة بينقرا بلا ما يتأكّد من المزوّد').toContain("provider === 'OPENROUTER'");
    expect(guard, 'مفتاح البيئة بيغلب مفتاحاً مخزَّناً').toContain('!key');
  });

  /**
   * A MODEL BELONGS TO A VENDOR.
   *
   * When an assistant switches vendor and names no model, the company's
   * model is the WRONG default: `gpt-4o` is not a name Anthropic answers
   * to. The new vendor's own default is used instead.
   */
  it('does not carry a model across a vendor switch', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/routing.ts'));
    expect(src).toMatch(/chosen && chosen !== fallback/);
    const ui = stripComments(repoFile('src/components/screens/ai/AssistantsTable.tsx'));
    expect(ui, 'تبديل المزوّد يُبقي نموذج المزوّد القديم').toMatch(
      /patch\.provider !== undefined && patch\.provider !== mine\.provider\) delete merged\.model/
    );
  });

  it('and an unknown vendor is dropped rather than stored', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/settings.ts'));
    // A typo must not route an assistant at a vendor that does not exist:
    // the failure would surface as «الذكاء غير مضبوط» on a far screen.
    expect(src).toMatch(/AI_PROVIDERS\.find\(\(p\) => p\.id === v\.provider\)\?\.id/);
  });
});

describe('what the screen offers', () => {
  it('a routing control for every assistant that has one', () => {
    const ui = stripComments(repoFile('src/components/screens/ai/AssistantsTable.tsx'));
    expect(ui).toContain('routing[a.promptJob]');
    // «الافتراضي» is a real choice, and the common one.
    expect(ui).toContain('الافتراضي');
  });

  it('and every assistant has a job to be routed by', () => {
    for (const a of ASSISTANTS) {
      expect(a.promptJob, `${a.key}: بلا وظيفة يُوجَّه بها`).toBeTruthy();
    }
  });

  it('and the tier is named beside the model, so the cost is a decision', () => {
    // The whole point of per-assistant routing is choosing a tier; a model
    // box with no sense of what a name costs is the setting that produced
    // the surprise in the first place.
    expect(tierOf('claude-opus-5-5')?.tier).toBe('الأعلى');
    expect(tierOf('claude-haiku-4-5-20251001')?.tier).toBe('اقتصادي');
    expect(tierOf('claude-sonnet-5')?.tier).toBe('متوازن');
  });

  it('and every vendor suggests models that are its own', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.models.length, `${p.id}: بلا اقتراحات`).toBeGreaterThan(0);
      expect(p.models, `${p.id}: الافتراضي ليس من قائمته`).toContain(p.defaultModel);
    }
  });
});

/**
 * A LIST OF MODELS THAT DOES NOT EXIST IS WORSE THAN NO LIST.
 *
 * Reported from a live screen: the owner picked `claude-sonnet-4-5` from the
 * box, the vendor answered 404, and the screen said «النموذج غير موجود عند
 * هذا المزوّد» — which was true, and pointed at a list that had lied to him.
 * Two of the five names offered for Anthropic were not model ids at all.
 */
describe('the models offered', () => {
  it('does not offer a name that was never real', () => {
    const anthropic = AI_PROVIDERS.find((p) => p.id === 'ANTHROPIC')!;
    for (const dead of Object.keys(RETIRED_MODELS)) {
      expect(anthropic.models, `${dead} ما زال معروضاً`).not.toContain(dead);
    }
  });

  it('and every default is one of the vendor’s own', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.models, `${p.id}: النموذج الافتراضي ليس في قائمته`).toContain(p.defaultModel);
    }
  });

  /**
   * A SETTING ALREADY SAVED WITH A RETIRED NAME KEEPS WORKING.
   *
   * Dropping the name from the list without this would leave whoever picked
   * it with a setting that 404s on every call and a box that cannot show what
   * is in it.
   */
  it('repairs a retired name instead of failing on it', () => {
    expect(liveModel('claude-sonnet-4-5')).toBe('claude-sonnet-5');
    expect(liveModel('claude-haiku-4-5')).toBe('claude-haiku-4-5-20251001');
    // And leaves a real one alone.
    expect(liveModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(liveModel('gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  it('and the repair is applied where a call is routed, not only in the screen', () => {
    const src = stripComments(repoFile('src/lib/ai-provider/routing.ts'));
    const route = src.slice(src.indexOf('async function routeFor'));
    expect(route, 'المسار لا يُصلح الاسم المتقاعد').toMatch(/const model = liveModel\(/);
  });

  /** Every retired name maps to something the vendor actually offers. */
  it('maps every retired name onto a live one', () => {
    const live = new Set(AI_PROVIDERS.flatMap((p) => p.models));
    for (const [dead, replacement] of Object.entries(RETIRED_MODELS)) {
      expect(live.has(replacement), `${dead} → ${replacement} وليس معروضاً`).toBe(true);
    }
  });
});

/**
 * A DATALIST IS NOT A DROPDOWN.
 *
 * Three complaints from one screen, all of them this element:
 *   it FILTERS its suggestions by what is in the box, so a field already
 *   holding a full value opens an empty list;
 *   its popup is drawn by the browser and cannot be styled, so it lands as a
 *   bare white panel on a dark screen;
 *   and a text box beside a password field is one Chrome offers to autofill.
 */
describe('a choice from a known set', () => {
  it('is a select, never a datalist', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      const body = stripComments(src);
      if (/<datalist\b/.test(body) || /\blist=\{?`?models/.test(body)) offenders.push(rel);
    }
    expect(offenders, `قائمةُ اقتراحاتٍ مكان قائمة اختيار:\n${offenders.join('\n')}`).toEqual([]);
  });

  /** And the vendor tab no longer offers a second place to set a model. */
  it('and the model is chosen in one place — the assistant', () => {
    const screen = stripComments(repoFile('src/components/screens/AiSettingsScreen.tsx'));
    expect(screen, 'ما زال للنموذج حقلٌ في تبويب المزوّد').not.toMatch(/id="ai-model"/);
    expect(screen).toContain('يُختار لكلِّ مساعدٍ');
    const table = stripComments(repoFile('src/components/screens/ai/AssistantsTable.tsx'));
    expect(table, 'لا منتقي نموذج للمساعد').toContain('function ModelPicker');
    // The escape hatch the free-text box used to provide, kept on purpose.
    expect(table).toContain("'__other__'");
  });
});
