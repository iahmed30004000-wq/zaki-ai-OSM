'use client';

import React, { useEffect, useState } from 'react';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { screenApi as crmApi } from '@/lib/screen-api';
import { formatDate } from '@/lib/screen-api';
import { publicAddress } from '@/lib/public-address';
import { publishQuestion } from '@/lib/landing-publish';
import { copyText } from '@/lib/clipboard';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { RiAddCircleLine, RiCursorLine, RiDeleteBinLine, RiExternalLinkLine, RiEyeLine, RiFileCopy2Line, RiFileCopyLine, RiFileList3Line, RiLoader4Line, RiPencilLine, RiStoreLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { routeLabel } from '@/lib/route-registry';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { CreateWizard, type WizardStart, type Way } from '@/components/landing-flow/CreateWizard';
import { LandingTabs } from '@/components/landing-flow/LandingTabs';

/**
 * WHAT THE LIBRARY HANDED OVER IN THE ADDRESS — «استخدم هالقالب» opens this
 * list with `?new=1&way=design&design=<id>&product=<id>`, and the wizard
 * starts on its second question with that design chosen.
 */
export function wizardStartFrom(search: string): WizardStart | null {
  const q = new URLSearchParams(search);
  if (q.get('new') !== '1') return null;
  const way = q.get('way');
  return {
    ...(way === 'ai' || way === 'design' || way === 'blank' ? { way: way as Way } : {}),
    ...(q.get('design') ? { design: q.get('design') as string } : {}),
    ...(q.get('product') ? { productId: q.get('product') as string } : {}),
  };
}

export function LandingPagesScreen() {
  const tell = useTell();
  const confirm = useConfirm();
  const { currentUser } = useApp();
  // The performance screen's own gate — a link that opens onto a refusal is noise.
  const canAnalytics = userCan(currentUser, 'reports.view') || userCan(currentUser, 'analytics.view');
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  /** What just happened, said on the screen — not in a browser alert box. */
  const [apiError, setApiError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * THE WIZARD, NEW EACH TIME IT OPENS. The key is bumped on every open, so
   * a page abandoned half-way leaves nothing behind for the next one — not
   * the product, not the words, not the step it stopped on.
   */
  const [createOpen, setCreateOpen] = useState(false);
  const [wizardKey, setWizardKey] = useState(0);
  const [start, setStart] = useState<WizardStart | null>(null);
  const [products, setProducts] = useState<any[]>([]);

  const openWizard = (from: WizardStart | null = null) => {
    setStart(from);
    setWizardKey((k) => k + 1);
    setCreateOpen(true);
  };

  const [deleting, setDeleting] = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await crmApi('/api/landing-pages?limit=100');
      setPages(data.landingPages || []);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    // NO LIMIT. `?limit=200` read as 200 and was capped at 100 by the route
    // (`Math.min(…, 100)` in api/products/route.ts), so this modal could
    // reach only 100 of the 114 products — and the search box below makes
    // that worse, not better: it answers «لا يوجد» about a product that
    // exists. Not `useProducts`, because the template previews below need
    // `basePrice` and `currency`, which `PickableProduct` does not carry.
    crmApi('/api/products').then((d) => setProducts(d.products || [])).catch(() => {});
  }, []);

  /**
   * «استخدم هالقالب» FROM THE LIBRARY — the address says which design and
   * which product; the wizard opens on its second question with both
   * chosen. The address is then put back, so a refresh does not reopen it.
   */
  useEffect(() => {
    const from = wizardStartFrom(window.location.search);
    if (!from) return;
    openWizard(from);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  /**
   * The link this row hands over.
   *
   * It used to be `origin + /lp/<slug>` and ignored the page's own domain
   * entirely, so a seller who had connected one was still given the internal
   * address and concluded the domain had done nothing. One rule now, shared
   * with the storefront card and the domain screen: a connected domain is the
   * address only once a real lookup has passed.
   */
  const addressOf = (lp: any) =>
    publicAddress(typeof window === 'undefined' ? '' : window.location.origin, {
      kind: 'lp', slug: lp.slug, domain: lp.domain, domainVerifiedAt: lp.domainVerifiedAt,
    });
  const publicUrl = (lp: any) => addressOf(lp).url;

  const copyUrl = async (lp: any) => {
    // Silence was the bug: over plain HTTP the clipboard API is missing and
    // the old `catch {}` made the button look dead. Now it falls back, and
    // when even that fails it says the link out loud so it can be copied by
    // hand.
    if (await copyText(publicUrl(lp))) {
      setCopiedId(lp.id);
      setTimeout(() => setCopiedId(null), 1500);
    } else {
      void tell({ title: 'انسخ الرابط يدوياً', body: 'المتصفح لم يسمح بالنسخ التلقائي.', value: publicUrl(lp) });
    }
  };


  /**
   * RiFileCopyLine the page, not its results.
   *
   * The server decides what carries over — sections, theme and product do;
   * the slug, domain, pixel, published state and the original's view and
   * order counts do not. Deciding it here too would put one rule in two
   * places, and the copy in this screen is the one that would drift.
   */
  const duplicate = async (lp: any) => {
    setBusyId(lp.id);
    try {
      setApiError(null);
      setNotice(null);
      const d = await crmApi(`/api/landing-pages/${lp.id}/duplicate`, { method: 'POST' });
      await load();
      setNotice(d?.message ?? null);
    } catch (e: any) { setApiError(e.message); } finally { setBusyId(null); }
  };

  const togglePublish = async (lp: any) => {
    /**
     * THE SAME QUESTION AS THE EDITOR'S, FROM THE SAME SENTENCE.
     *
     * This row's toggle was the quieter of the two and the likelier to be
     * pressed by accident — it sits between «أظهِرها في المتجر» and «نسخ
     * الرابط» on a list of pages, where the hand is scanning rather than
     * deciding. `unsaved` is false here: this screen holds no edits.
     */
    if (!(await confirm(publishQuestion(!lp.isPublished, publicUrl(lp))))) return;

    setBusyId(lp.id);
    try {
      await crmApi(`/api/landing-pages/${lp.id}`, { method: 'PATCH', body: JSON.stringify({ isPublished: !lp.isPublished }) });
      await load();
    } catch (e: any) {
      void tell({ title: 'تعذر تغيير حالة النشر', body: e.message, tone: 'danger' });
    } finally { setBusyId(null); }
  };

  /**
   * SHOWN IN THE SHOP, OR REACHABLE BY ITS LINK ALONE.
   *
   * Belonging to a store is not the same as being in its window: a
   * campaign page is built for one audience and one advert, and listing
   * every page a store owns would put the half-finished ones in front of
   * every shopper.
   *
   * Publishing is still the act — an unpublished page is never shown in
   * the shop whatever this says — so the two toggles mean different things
   * and both are on the row.
   */
  const toggleInStore = async (lp: any) => {
    setBusyId(lp.id);
    try {
      await crmApi(`/api/landing-pages/${lp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ showInStore: !lp.showInStore }),
      });
      await load();
    } catch (e: any) {
      void tell({ title: 'تعذر تغيير ظهورها في المتجر', body: e.message, tone: 'danger' });
    } finally { setBusyId(null); }
  };

  /**
   * THE PRESS THAT FILLS THE SHOP — ONE UPDATE, SAME MOMENT AS THE SWITCH.
   *
   * The catalogue shows one card per product with a shown page, so until
   * this press the shop keeps showing exactly what it showed. The server
   * flips every published page of this store in a single updateMany and
   * writes the audit row — the press and the switch are one act, and the
   * store is never empty in between. Unpublished pages are not touched.
   */
  const showAllPublished = async () => {
    const storeId = pages.length > 0 ? pages[0]?.storeId : null;
    if (!storeId) return;
    const hidden = pages.filter((p) => p.isPublished && !p.showInStore).length;
    if (!(await confirm({
      title: 'اعرض كل الصفحات المنشورة؟',
      body: `ستظهر ${hidden} صفحة منشورة في المتجر، ويتحول الكتالوج لبطاقة واحدة لكل منتج له صفحة معروضة. الصفحات غير المنشورة تبقى مخفية.`,
      confirmLabel: 'اعرضها كلها',
      cancelLabel: 'إلغاء',
    }))) return;
    setBusyId('show-all');
    try {
      const d = await crmApi('/api/landing-pages/show-all', {
        method: 'POST',
        body: JSON.stringify({ storeId }),
      });
      setNotice(`ظهرت ${d.shown ?? 0} صفحة منشورة في المتجر — والكتالوج الآن بطاقة واحدة لكل منتج له صفحة معروضة.`);
      await load();
    } catch (e: any) {
      void tell({ title: 'تعذر عرض الصفحات', body: e.message, tone: 'danger' });
    } finally { setBusyId(null); }
  };

  /**
   * «معاينة» IN A NEW TAB. A published page is its public address; a draft
   * has none a visitor may open, so it is the short-lived signed preview the
   * editor already uses. The tab is opened at the press, before the token
   * is asked for, because a tab opened after an await is a popup the
   * browser blocks.
   */
  const preview = async (lp: any) => {
    if (lp.isPublished) {
      window.open(publicUrl(lp), '_blank', 'noopener');
      return;
    }
    const tab = window.open('', '_blank');
    try {
      const d = await crmApi(`/api/landing-pages/${lp.id}/preview-token`, { method: 'POST' });
      if (tab) tab.location.href = d.previewPath;
    } catch (e: any) {
      tab?.close();
      void tell({ title: 'تعذّرت المعاينة', body: e.message, tone: 'danger' });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await crmApi(`/api/landing-pages/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (e: any) {
      void tell({ title: 'تعذر حذف الصفحة', body: e.message, tone: 'danger' });
    } finally { setDeleteLoading(false); }
  };

  const iconBtn = 'min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg hover:bg-[var(--sys-surface-strong)] text-[var(--sys-foreground)] disabled:opacity-40';

  return (
    <>
      <div className="p-6 max-w-7xl mx-auto">
        <PageHeader
          title={routeLabel('/store/landing-pages')}
          description="صفحات تسويق عامة بتعمل طلبات حقيقية بالنظام لحالها"
          actions={
            <>
              {pages.some((p) => p.isPublished && !p.showInStore) && (
                <Button
                  variant="outline"
                  disabled={busyId === 'show-all'}
                  onClick={() => { void showAllPublished(); }}
                >
                  اعرض كل الصفحات المنشورة
                </Button>
              )}
              <Button variant="outline" onClick={() => { window.location.href = '/store/landing-pages/library'; }}>
                <RiFileList3Line className="w-4 h-4" /> مكتبة القوالب
              </Button>
              <Button onClick={() => openWizard()}>
                <RiAddCircleLine className="w-4 h-4" /> إنشاء صفحة هبوط
              </Button>
            </>
          }
        />
        <LandingTabs current="pages" />
        {/* The numbers in this list are lifetime totals; a period, by
            device and by campaign, is read on the performance screen. */}
        {canAnalytics && (
          <a href="/growth/performance?tab=landing" className="-mt-1 mb-4 inline-block text-xs font-semibold text-[var(--sys-primary)] hover:underline">
            تحليلات الصفحات حسب الفترة والجهاز والحملة ←
          </a>
        )}

        <Card>
          <CardContent className="p-0">
            {notice && (
              <p className="rounded-lg border border-[var(--sys-success)]/30 bg-[var(--sys-success-soft)] px-3 py-2 text-xs text-[var(--sys-success)]">
                {notice}
              </p>
            )}
            {apiError && (
              <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] px-3 py-2 text-xs text-[var(--sys-destructive)]">
                {apiError}
              </p>
            )}

            {loading ? (
              <div className="p-4"><SkeletonRows rows={4} /></div>
            ) : pages.length === 0 ? (
              <div className="p-10 text-center text-[var(--sys-muted-foreground)] text-sm">
                ما في صفحات هبوط لسّا. اعمل أول صفحة لتبلّش تستقبل طلبات.
              </div>
            ) : (
              <div className="overflow-x-auto">
                {/*
                  THE COLUMNS OF THE OWNER'S OTHER PLATFORM, IN ITS ORDER —
                  product, title, link, active, created — with this list's
                  own switches kept beside them: «في المتجر» and the row's
                  publish question are rules his platform does not have, and
                  they stay.

                  HIS VIEWS COLUMN IS THE ONE THING NOT COPIED. A page's
                  views, orders and conversion have ONE screen here
                  (`one-place.test.ts`): the performance screen, linked
                  above, by period and device and campaign. A lifetime copy
                  on this list is the duplicate that contract refuses.
                */}
                <Rows
                  rows={pages}
                  keyOf={(lp: any) => lp.id}
                  columns={[
                    { key: 'product', label: 'المنتج', primary: true,
                      render: (lp: any) => (lp.product?.name || '—') },
                    { key: 'title', label: 'عنوان الصفحة', primary: true,
                      render: (lp: any) => (
                        <a href={`/store/landing-pages/${lp.id}`} className="font-semibold text-[var(--sys-heading)] hover:underline">{lp.name}</a>
                      ) },
                    { key: 'link', label: 'الرابط',
                      render: (lp: any) => (
                        lp.isPublished ? (
                          <a href={publicUrl(lp)} target="_blank" rel="noopener noreferrer" className="text-[var(--sys-primary)] hover:underline flex items-center gap-1" dir="ltr">
                            /lp/{lp.slug} <RiExternalLinkLine className="icon-mirror w-4 h-4" />
                          </a>
                        ) : (
                          <span className="text-[var(--sys-muted)]" dir="ltr">/lp/{lp.slug}</span>
                        )
                      ) },
                    { key: 'active', label: 'نشط',
                      render: (lp: any) => (
                        <span className="flex flex-wrap items-center gap-1">
                          {/* The row's publish switch, and the question it asks first. */}
                          <button
                            type="button"
                            title={lp.isPublished ? 'إلغاء النشر' : 'نشر'}
                            aria-label={lp.isPublished ? 'إلغاء النشر' : 'نشر'}
                            disabled={busyId === lp.id}
                            onClick={() => togglePublish(lp)}
                            className="disabled:opacity-40"
                          >
                            <Badge variant={lp.isPublished ? 'success' : 'default'}>
                              {lp.isPublished ? 'منشورة' : 'مسودة'}
                            </Badge>
                          </button>
                          {lp.showInStore && <Badge variant="info">في المتجر</Badge>}
                        </span>
                      ) },
                    { key: 'created', label: 'أُنشئت',
                      render: (lp: any) => (formatDate(lp.createdAt)) },
                    { key: 'actions', label: 'إجراءات',
                      render: (lp: any) => (
                        <div className="flex items-center gap-1">
                          <button aria-label="عرض" title="عرض" onClick={() => (window.location.href = `/store/landing-pages/${lp.id}`)} className={iconBtn}>
                            <RiEyeLine className="w-4 h-4" />
                          </button>
                          <button aria-label="تعديل" title="تعديل" onClick={() => (window.location.href = `/store/landing-pages/${lp.id}/editor`)} className={iconBtn}>
                            <RiPencilLine className="w-4 h-4" />
                          </button>
                          {/* A page that converts, wanted again for the next
                              product. Rebuilding it by hand is how a working
                              page gets copied wrong. */}
                          <button aria-label="انسخ الصفحة" title="انسخ الصفحة" disabled={busyId === lp.id} onClick={() => duplicate(lp)} className={iconBtn}>
                            <RiFileCopy2Line className="w-4 h-4" />
                          </button>
                          <button aria-label="معاينة" title="معاينة" onClick={() => { void preview(lp); }} className={iconBtn}>
                            <RiExternalLinkLine className="icon-mirror w-4 h-4" />
                          </button>
                          <button
                            title={lp.showInStore ? 'أخفِها من المتجر' : 'أظهِرها في المتجر'}
                            aria-label={lp.showInStore ? 'أخفِها من المتجر' : 'أظهِرها في المتجر'}
                            disabled={busyId === lp.id}
                            onClick={() => toggleInStore(lp)}
                            className={`${iconBtn} ${lp.showInStore ? 'text-[var(--sys-primary)]' : ''}`}
                          >
                            <RiStoreLine className="w-4 h-4" />
                          </button>
                          <button aria-label="نسخ الرابط" title="نسخ الرابط" onClick={() => copyUrl(lp)} className={iconBtn}>
                            {copiedId === lp.id ? <RiCursorLine className="w-4 h-4 text-[var(--sys-success)]" /> : <RiFileCopyLine className="w-4 h-4" />}
                          </button>
                          <button aria-label="حذف" title="حذف" onClick={() => setDeleting(lp)}
                            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg hover:bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]">
                            <RiDeleteBinLine className="w-4 h-4" />
                          </button>
                        </div>
                      ) },
                  ]}
                  empty={
                    <EmptyState title="ما في صفحات هبوط لسّا" why="صفحة الهبوط بتعمل طلب جوّا النظام مباشرة. اعمل وحدة من الزر فوق واربطها بمنتج." />
                  }
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateWizard
        key={wizardKey}
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        products={products}
        start={start}
      />

      {/* Delete modal */}
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="تأكيد الحذف" maxWidth="sm">
        <p className="text-sm text-[var(--sys-foreground)] mb-4">
          حذف صفحة الهبوط «{deleting?.name}»؟ الطلبات القديمة المربوطة فيها بتضل بالطلبات.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>إلغاء</Button>
          <Button variant="danger" onClick={confirmDelete} disabled={deleteLoading}>
            {deleteLoading ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiDeleteBinLine className="w-4 h-4" />} حذف نهائي
          </Button>
        </div>
      </Modal>
    </>
  );
}
