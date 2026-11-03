import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * AN EDITOR SHOWS YOU THE THING YOU ARE EDITING.
 *
 * There are three in this product and they did not agree about it.
 *
 *   · the page editor (BlockBuilder) drew the page beside the controls with
 *     the public renderer, and could be undone with Ctrl+Z;
 *   · the shop's home designer drives the SAME builder and had no undo at
 *     all, so a seller who learned that Ctrl+Z takes back a deleted block
 *     on a landing page lost one here and stopped trusting it on either;
 *   · the templates screen had a preview for ONE of its eight tabs. The
 *     colours, the type, the arrangement, the header, the product page and
 *     the checkout were forms. A seller changed «لون السعر», saved,
 *     published, opened the shop in another tab and found out — which makes
 *     publishing the preview, on a live shop, in front of customers.
 *
 * And on a phone «side by side» was a stack: the preview sat below a panel
 * taller than the screen, so a change was invisible without scrolling past
 * every control that could have made it.
 *
 * These guards hold the four things that are easy to lose again, and they
 * read the source because the failure worth catching is a well-meant edit
 * that quietly takes one of them away:
 *
 *   ① the preview is drawn by the renderer that draws the real thing;
 *   ② both panes are reachable on a phone, one tap apart;
 *   ③ every editor has an undo, and it is the same control everywhere;
 *   ④ the common controls are in front and only the rare ones are folded;
 *   ⑤ save, preview and publish are still three separate acts.
 */

const BUILDER = 'src/components/landing-editor/BlockBuilder.tsx';
const DESIGN = 'src/components/screens/StoreDesignScreen.tsx';
const THEMES = 'src/components/screens/StoreThemeScreen.tsx';
const PAGE_EDITOR = 'src/components/screens/LandingPageEditorScreen.tsx';

const src = (p: string) => stripComments(repoFile(p));

describe('① the preview is the real renderer', () => {
  it('the page editor draws the page with the component the public page uses', () => {
    const b = src(BUILDER);
    // Not an approximation of the page. A preview drawn by different code
    // is a preview that can be wrong, and the one moment you find out is
    // after publishing.
    expect(b, 'المعاينة ما بترسم بمُصيّر الصفحة نفسه').toMatch(/<PageBlocks\b/);
    expect(b).toMatch(/from '@\/components\/landing\/blocks\/PageBlocks'/);
    // And it never takes an order: the form is a stand-in.
    expect(b, 'المعاينة فيها نموذج طلب حقيقي').toMatch(/form: <FormPlaceholder/);
  });

  it('and the shop preview is the gallery’s own miniature, not a second drawing', () => {
    const p = src('src/components/landing-editor/StoreThemePreview.tsx');
    expect(p).toMatch(/from '@\/components\/store\/SkinPreview'/);
    expect(p).toMatch(/<SkinPreview\b/);
    // The colours are RESOLVED the way the shop resolves them. Reading
    // `theme.colors` directly would show white wherever a colour is unset,
    // which is most of them and none of what a customer sees.
    expect(p, 'الألوان ما مرّت من محلّل المتجر').toMatch(/themeRoleColors\(theme\)/);
    expect(p, 'الترتيب ما مرّ من layoutOf').toMatch(/layoutOf\(theme, slot\)/);
    // And it is the UNSAVED theme, or it would be a picture of the shop as
    // it was before the seller touched it.
    const t = src(THEMES);
    expect(t).toMatch(/<StoreThemePreview\b/);
    expect(t, 'المعاينة بتقرأ المحفوظ لا اللي بيد البائع').toMatch(/theme=\{theme\}/);
  });

  it('and the templates screen shows it on every tab, not only the gallery', () => {
    /*
     * The preview sits OUTSIDE the `{tab === …}` blocks: the colour tab is
     * not the only one whose change is visible, and a seller setting the
     * header height needs the same answer the gallery gives.
     */
    const t = src(THEMES);
    const previewAt = t.indexOf('<StoreThemePreview');
    const lastTabAt = t.lastIndexOf("{tab === ");
    expect(previewAt).toBeGreaterThan(-1);
    expect(previewAt, 'المعاينة جوّا تبويب واحد').toBeGreaterThan(lastTabAt);
  });
});

describe('② a phone reaches both halves', () => {
  it.each([
    ['the block builder', BUILDER],
    ['the templates screen', THEMES],
  ])('%s offers the edit/preview toggle', (_name, file) => {
    const s = src(file);
    expect(s).toMatch(/<PaneToggle\b/);
    // Both panes, by the shared helpers — so «which pane is shown» is one
    // decision in one place rather than three sets of breakpoint classes.
    expect(s).toMatch(/editPaneClass\(pane\)/);
    expect(s).toMatch(/previewPaneClass\(pane\)/);
  });

  it('and the toggle is drawn on a phone only, where the two do not fit', () => {
    const p = src('src/components/landing-editor/EditorPanes.tsx');
    expect(p, 'المبدّل ظاهر على الشاشة الكبيرة كمان').toMatch(/lg:hidden/);
    // Hidden, not unmounted: switching back must show the preview that was
    // already there — its scroll, its zoom, the block that was open.
    expect(p).toMatch(/'hidden lg:block'/);
    expect(p).toMatch(/'hidden lg:flex'/);
    expect(p, 'المبدّل ما بيوصل ٤٤ بكسل على الجوّال').toMatch(/min-h-11/);
  });

  it('and the shop designer gets it through the one builder', () => {
    // It owns no builder of its own; a second one would be two sets of
    // blocks to keep in step, and they would drift.
    expect(src(DESIGN)).toMatch(/<BlockBuilder\b/);
  });
});

describe('③ every editor can be undone', () => {
  it.each([
    ['the page editor', PAGE_EDITOR],
    ['the shop designer', DESIGN],
    ['the templates screen', THEMES],
  ])('%s keeps a history and offers the step back', (_name, file) => {
    const s = src(file);
    expect(s, 'المحرّر ما عنده تاريخ').toMatch(/useHistory</);
    // Loading is not an edit: the value arriving from the server must not
    // become the first step a seller can undo to, because undoing to it is
    // the same screen they are already looking at.
    expect(s, 'التحميل انحسب تعديلاً').toMatch(/history\.reset\(/);
  });

  it('and the two screens that had none now draw the shared control', () => {
    for (const file of [DESIGN, THEMES]) {
      const s = src(file);
      expect(s).toMatch(/<UndoBar\b/);
      expect(s).toMatch(/canUndo=\{history\.canUndo\}/);
      expect(s).toMatch(/useUndoKeys\(history\)/);
    }
  });

  it('and the keystroke is left alone while somebody is typing', () => {
    /*
     * Ctrl+Z inside a textarea is the browser's own undo for that text.
     * Stealing it would make typing feel broken in order to deliver a
     * feature nobody asked to be global — and the block builder lets a
     * seller type directly on the page, which is a contenteditable.
     */
    const h = stripComments(repoFile('src/lib/use-history.ts'));
    expect(h).toMatch(/export function useUndoKeys/);
    expect(h).toMatch(/isContentEditable/);
    expect(h).toMatch(/TEXTAREA/);
    // And it does not reach for Ctrl+S: saving is a different act with a
    // different owner on each of the three screens.
    expect(h, 'هوك التراجع بيحجز زرّ الحفظ كمان').not.toMatch(/'s'/);
  });

  it('and the reset beside it is no longer called the same thing', () => {
    /*
     * The templates screen already had a «تراجع» and it throws away EVERY
     * unsaved change. A seller who moved four colours and wanted the fourth
     * one back had two options: lose all four, or remember the old colour.
     * Both are the product failing to keep a note it could have kept — so
     * the step was added and the reset was renamed. Neither was removed.
     */
    const t = src(THEMES);
    expect(t, 'الزرّان بنفس الاسم').toMatch(/أرجِع للمحفوظة/);
    expect(t).toMatch(/history\.reset\(saved\)/);
  });
});

describe('④ the controls in front are the ones a seller uses', () => {
  it('the block builder folds the brand decisions and keeps the page ones', () => {
    const b = src(BUILDER);
    expect(b).toMatch(/<Advanced\b/);
    const foldAt = b.indexOf('<Advanced');
    // In front: the colour, the mood and the typeface — the three decisions
    // somebody makes on every page.
    for (const marker of ['اللون الأساسي', 'الطابع', 'الخط']) {
      const at = b.indexOf(marker);
      expect(at, `«${marker}» ما عاد ظاهراً`).toBeGreaterThan(-1);
      expect(at, `«${marker}» انطوى وهو من قرارات كل صفحة`).toBeLessThan(foldAt);
    }
    // Folded: their own uploaded font, the corner style, a photograph
    // behind the whole page — decisions a brand makes once.
    for (const marker of ['<FontUploader', 'الزوايا', 'خلفية الصفحة كلها']) {
      expect(b.indexOf(marker), `«${marker}» ما عاد موجوداً`).toBeGreaterThan(foldAt);
    }
  });

  it('the templates screen folds the fourteen derived colours, not the accent', () => {
    const t = src(THEMES);
    const foldAt = t.indexOf('<Advanced');
    expect(foldAt, 'ما في طيّ بشاشة القوالب').toBeGreaterThan(-1);
    expect(t.indexOf('aria-label="اللون الأساسي"'), 'اللون الأساسي انطوى').toBeLessThan(foldAt);
    expect(t.indexOf('COLOR_FIELDS.map'), 'الألوان المشتقّة ما انطوت').toBeGreaterThan(foldAt);
    // The contrast verdict stays OUT of the fold: a pair that fails is a
    // fact about the shop whether or not anybody opened the pickers.
    expect(t.indexOf('<ContrastNotes'), 'حكم التباين انطوى').toBeGreaterThan(-1);
  });

  it('and nothing is removed to achieve it — a fold is closed, not empty', () => {
    const a = stripComments(repoFile('src/components/landing-editor/Advanced.tsx'));
    // Closed by default, and the row says what is inside, so a seller who
    // set one of these last week knows where it went.
    expect(a).toMatch(/useState\(false\)/);
    expect(a).toMatch(/aria-expanded=\{open\}/);
    expect(a).toMatch(/\{holds\}/);
    // `hidden` and not unmounted: a half-typed hex in there must survive
    // the seller folding the section to look at the preview.
    expect(a, 'الطيّ بيهدم اللي جوّاته').toMatch(/open \? 'mt-2 space-y-3' : 'hidden'/);
  });
});

describe('⑤ save, preview and publish are still three acts', () => {
  it('the shop’s home publish promotes the saved draft and nothing else', () => {
    const route = stripComments(repoFile('src/app/api/store/design/route.ts'));
    // The draft column is what a save writes and what a publish reads.
    expect(route).toMatch(/data: \{ homeDraft: JSON\.stringify/);
    expect(route, 'النشر ما بينسخ المسوّدة المحفوظة').toMatch(/homeLive: store\.homeDraft/);
    // And the screen saves before it publishes, so the seller never
    // publishes something they cannot see on the canvas.
    const screen = src(DESIGN);
    const putAt = screen.indexOf("method: 'PUT'");
    const postAt = screen.indexOf("method: 'POST'");
    expect(putAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(putAt);
  });

  it('the theme publish promotes the saved draft, and keeps one step back', () => {
    const route = stripComments(repoFile('src/app/api/store/theme/route.ts'));
    expect(route).toMatch(/themeDraft: JSON\.stringify\(theme\)/);
    expect(route).toMatch(/const draft = store\.themeDraft \?\? store\.theme/);
    expect(route).toMatch(/theme: draft, themePrevious: store\.theme/);
  });

  it('the landing page publish promotes the draft column, and nothing in the editor writes it', () => {
    const draft = stripComments(repoFile('src/lib/landing-draft.ts'));
    expect(draft).toMatch(/export async function publishContent/);
    expect(draft).toMatch(/takeFrom\('contentDraft'\)/);
  });

  it('and the copy assistant writes nothing anywhere', () => {
    /*
     * It proposes. The answer lands in the editor's own sections, in
     * memory, and is saved by the «حفظ» the seller would press anyway —
     * into the draft, invisible until they publish. `ai-proposal-only`
     * holds «كلّ إجراء ذكاءٍ اصطناعيٍّ اقتراحٌ فقط» with a sweep behind it;
     * this is the one claim that sweep cannot see, because it is about the
     * BROWSER not writing either.
     */
    const panel = stripComments(repoFile('src/components/landing-editor/AiCopyPanel.tsx'));
    expect(panel, 'المساعد عنده باب حفظ خاصّ به').not.toMatch(/method: 'PUT'/);
    expect(panel).not.toMatch(/\/api\/landing-pages/);
    expect(panel).not.toMatch(/\/api\/store\//);
    // One call, to the proposal endpoint, and it hands the answer to the
    // editor's own setter.
    expect(panel).toMatch(/'\/api\/ai\/landing-copy'/);
    expect(panel).toMatch(/onSections\(fitted\.sections\)/);
    // And it refuses its own answer if it would move a block.
    expect(panel, 'الاقتراح ما بيتفحّص قبل ما ينزل').toMatch(/sameArrangement\(sections, fitted\.sections\)/);
  });

  it('and it is reachable from inside the page editor, not only the create dialog', () => {
    // The whole complaint: the one moment a seller could ask for words was
    // the moment before they had seen the page. Afterwards the button was
    // gone, so people created a second page, copied the words out by hand
    // and deleted it.
    const b = src(BUILDER);
    expect(b).toMatch(/<AiCopyPanel\b/);
    expect(b, 'المساعد معروض لصفحة بلا منتج').toMatch(/\{props\.productId && \(/);
    expect(src(PAGE_EDITOR), 'محرّر الصفحة ما بيمرّر المنتج').toMatch(/productId=\{/);
    // It is still in the create dialog too. A door is not moved, it is
    // added beside the one that was there.
    // (The dialog's code moved to the wizard on 3/11.)
    expect(src('src/components/landing-flow/CreateWizard.tsx')).toMatch(
      /اكتب النصوص بالذكاء الاصطناعي/
    );
  });
});
