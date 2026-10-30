'use client';

import React, { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/Confirm';
import { apiJson } from '@/lib/api-client';
import { uploadStoreImages } from '@/lib/store-image-upload';
import { BlockBuilder } from '@/components/landing-editor/BlockBuilder';
import { UndoBar } from '@/components/landing-editor/UndoBar';
import { useHistory, useUndoKeys } from '@/lib/use-history';
import type { LandingSection } from '@/lib/landing-sections';
import type { StoreTheme } from '@/lib/store-theme';
import { RiCheckLine, RiExternalLinkLine, RiLoader4Line, RiRocketLine, RiSaveLine } from '@remixicon/react';
import { PanelHeader } from '@/components/store-admin/PanelHeader';
import { arDateTime } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * THE SHOP'S HOME PAGE.
 *
 * This screen owns no builder of its own: it hands the store's sections to
 * BlockBuilder — the same component, the same block library and the same
 * preview renderer the landing pages use. A second builder would be two sets
 * of blocks to keep in step, and they would drift.
 *
 * SAVE, PREVIEW, PUBLISH ARE THREE SEPARATE ACTS, as the contract asks.
 * Preview is the canvas you are already looking at, drawn by the public
 * renderer. RiSaveLine writes the draft. Publish is the only one a customer feels,
 * so it asks first and says what it is about to change.
 *
 * THE THEME IS NOT EDITED HERE. It belongs to «القالب والألوان», the panel
 * beside this one in the same tab, where the colours, the fonts, the header
 * and the checkout are set together. The builder can take an onTheme
 * callback; this screen deliberately does not give it one that saves.
 *
 * AND THIS IS NOW THE ONLY PLACE THE HOME PAGE IS ARRANGED.
 *
 * The owner, 15/10 01:33: «التصميم» and «القوالب» both edited the home
 * page. They were two menu entries for one job, and the theme screen's
 * «الصفحة الرئيسية» tab is where the overlap lived. The two are one tab now
 * («الواجهة»); that tab is «صورة الغلاف» and nothing else, and the
 * arrangement of the page is here.
 */

interface Payload {
  store: {
    id: string; name: string; slug: string; type: string;
    logo: string | null; supportPhone: string | null;
    storefrontEnabled: boolean; singleProduct: boolean;
    landingPageId: string | null; currency: string;
  };
  theme: StoreTheme;
  draft: LandingSection[];
  live: LandingSection[];
  publishedAt: string | null;
  hasUnpublished: boolean;
}

export function StoreDesignScreen() {
  const confirm = useConfirm();
  const [data, setData] = useState<Payload | null>(null);
  /**
   * THE SHOP WINDOW, WITH A WAY BACK.
   *
   * The landing page editor has had this since it was written; this screen
   * drives the SAME builder and had nothing — so a seller who learned that
   * Ctrl+Z takes back a deleted block on a landing page tried it here, lost
   * the block, and stopped trusting it on either screen.
   *
   * `history.set` is the ordinary edit, and `history.reset` is loading:
   * the draft arriving from the server must not become the first step a
   * seller can undo to, because undoing to it is the same page.
   */
  const history = useHistory<LandingSection[]>([]);
  const sections = history.value;
  const setSections = history.set;
  useUndoKeys(history);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const got = await apiJson<Payload>('/api/store/design');
      setData(got);
      // Loading is not an edit: it must not become the first undo step.
      history.reset(got.draft);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر التحميل' });
    } finally {
      setLoading(false);
    }
    // `history.reset` is a stable callback with no dependencies of its own,
    // so naming it here does not make `load` change on every render.
  }, [history.reset]);

  useLiveRefresh(load);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const got = await apiJson<Payload>('/api/store/design', {
        method: 'PUT',
        body: JSON.stringify({ sections }),
      });
      setData(got);
      setMsg({ ok: true, text: 'حُفظت المسوّدة — لم يتغيّر شيء عند الزبون بعد' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    const ok = await confirm({
      title: 'نشر الصفحة الرئيسية؟',
      body:
        sections.length === 0
          ? 'المسوّدة فارغة — النشر سيعيد الواجهة إلى قائمة المنتجات العادية.'
          : 'ما تراه الآن سيصبح ما يراه كل زبون يفتح متجرك. المسوّدة المحفوظة هي ما سيُنشر.',
      confirmLabel: 'انشر',
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      // Publish copies the SAVED draft, so save first if the canvas has moved
      // since — otherwise the seller publishes something they cannot see.
      await apiJson('/api/store/design', { method: 'PUT', body: JSON.stringify({ sections }) });
      const got = await apiJson<Payload>('/api/store/design', { method: 'POST' });
      setData(got);
      setMsg({ ok: true, text: 'نُشرت — هذا ما يراه الزبون الآن' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر النشر' });
    } finally {
      setBusy(false);
    }
  }

  const upload = useCallback(async (files: FileList): Promise<string[]> => {
    try {
      // The one uploader both panels of «الواجهة» use — it carries the
      // session, the lost-context redirect and the timeout a raw call does
      // without (src/lib/store-image-upload.ts).
      return await uploadStoreImages(Array.from(files));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر رفع الصور' });
      return [];
    }
  }, []);

  if (loading || !data) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="pt-4" dir="rtl">
      <PanelHeader
        title="الصفحة الرئيسية"
        line={
          data.publishedAt
            ? `آخر نشر: ${arDateTime(data.publishedAt)}${data.hasUnpublished ? ' · فيها تغييرات غير منشورة' : ''}`
            : data.store.singleProduct && data.store.landingPageId
              ? 'لم تُنشر بعد — عنوان متجرك يعرض صفحة الواجهة المختارة.'
              : 'لم تُنشر بعد — متجرك يعرض قائمة المنتجات العادية.'
        }
        note={
          msg && (
            <span className={`text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
              {msg.ok && <RiCheckLine className="mb-0.5 ml-1 inline h-4 w-4" />}
              {msg.text}
            </span>
          )
        }
        /* THE ONE ACT A CUSTOMER FEELS. Saving is not it, and neither is
           looking at the published page or stepping back — those are
           beside it. */
        primary={
          <Button size="sm" disabled={busy} onClick={() => void publish()}>
            <RiRocketLine className="h-4 w-4" /> نشر
          </Button>
        }
        secondary={
          <>
            {/* A step back, beside the way forward — the same control, in
                the same place, as the landing page editor's. */}
            <UndoBar
              undo={history.undo}
              redo={history.redo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
            />
            <a href={`/s/${data.store.slug}`} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary" size="sm">
                <RiExternalLinkLine className="icon-mirror h-4 w-4" /> المنشورة
              </Button>
            </a>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiSaveLine className="h-4 w-4" />} حفظ
            </Button>
          </>
        }
        help={
          <>
            <p>
              الحفظ والمعاينة والنشر ثلاثة أفعال منفصلة: ما تراه هنا هو المعاينة، و«حفظ» يكتب
              المسوّدة، و«نشر» وحده هو ما يصل الزبون.
            </p>
            <p>
              {data.store.singleProduct && data.store.landingPageId
                ? 'عنوان متجرك يعرض صفحة الواجهة المختارة الآن — والنشر يجعله يعرض هذه الصفحة بدلاً منها.'
                : 'قبل أول نشر، متجرك يعرض قائمة المنتجات العادية.'}
            </p>
            <p>الألوان والخطوط والترويسة تُضبط في «القالب والألوان» — نفس التبويب، البطاقة المجاورة.</p>
            <p>وخطوة للخلف بـCtrl+Z، وللأمام بـCtrl+Shift+Z — أو من الزرّين فوق.</p>
          </>
        }
      />

      {!data.store.storefrontEnabled && (
        <p className="mb-3 rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-warning)]/10 px-3 py-2 text-xs text-[var(--sys-warning)]">
          واجهة هذا المتجر مطفأة — انشر ما شئت، لن يراه أحد حتى تُشغّلها من «البلدان والمتاجر».
        </p>
      )}

      {/*
        NO HEIGHT OF ITS OWN, NO CLIP: THE WINDOW SCROLLS THIS TOO.
        The builder draws the whole page and the window is what scrolls it (see BlockBuilder). A box with a fixed
        height or a clip around it would cut the preview at that height with nothing to move it, and would take the
        builder's pinned bars away from the window. The border alone is what this wrapper is for.
      */}
      <div className="rounded-lg border border-[var(--sys-border)]">
        {/* The one builder in this system. The preview beside it is drawn by
            the public renderer, so it cannot be wrong in a way that only
            shows up after publishing. */}
        <BlockBuilder
          theme={data.theme}
          sections={sections}
          onSections={setSections}
          // The look belongs to «القالب والألوان», where it is set once for
          // the whole shop. Changes here would be a second owner for the
          // same values.
          onTheme={() => {}}
          onUpload={upload}
          product={null}
          store={{ name: data.store.name, logo: data.store.logo, phone: data.store.supportPhone }}
          currency={data.store.currency}
          offers={[]}
        />
      </div>
    </div>
  );
}
