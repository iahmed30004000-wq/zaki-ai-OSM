'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTell } from '@/components/ui/Confirm';
import { useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { ProductPicker } from '@/components/ui/ProductPicker';
import { useProducts } from '@/hooks/useProducts';
import { Badge } from '@/components/ui/Badge';
import { screenApi as crmApi } from '@/lib/screen-api';
import { copyText } from '@/lib/clipboard';
import { RiAddCircleLine, RiArrowRightLine, RiCheckLine, RiComputerLine, RiDashboard3Line, RiDeleteBinLine, RiExternalLinkLine, RiFileCodeLine, RiFileCopyLine, RiGiftLine, RiLoader4Line, RiPencilLine, RiRefreshLine, RiUpload2Line } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { publicAddress } from '@/lib/public-address';
import type { DomainCheck } from '@/lib/domain-verify';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { PageSummary, type SummaryOffer } from '@/components/landing-flow/PageSummary';

export function LandingPageDetailScreen() {
  const tell = useTell();
  const params = useParams<{ id: string }>();
  const lpId = params?.id ?? null;
  const [lp, setLp] = useState<any>(null);
  // `?limit=200` was silently capped at 100 by the route, so this screen
  // could reach only 100 of the 114 products — and a search box over a
  // truncated list is worse than a dropdown over a whole one: it answers
  // «لا يوجد» about a product that exists. The hook asks for no limit.
  const { products } = useProducts();
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  const [form, setForm] = useState({ name: '', slug: '', productId: '', domain: '' });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  /** The offers live for this page's product, as the page's GET read them. */
  const [offers, setOffers] = useState<SummaryOffer[]>([]);

  /**
   * The page's own domain, as the server sees it: the records the seller must
   * create, and whether a real lookup has ever passed.
   *
   * The screen used to tell them to «point an A or CNAME at this server»
   * without ever saying which value, and printed `https://<domain>` in
   * success green the moment the field was saved. Both were the screen
   * claiming something it had not checked.
   */
  const [domainInfo, setDomainInfo] = useState<{
    domain: string | null;
    verifiedAt: string | null;
    records: { type: string; name: string; value: string; ttl: string; note?: string }[];
    target: { kind: string; value: string } | null;
    publicPath: string;
  } | null>(null);
  const [lastCheck, setLastCheck] = useState<DomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Recommendations
  const [recs, setRecs] = useState<any[]>([]);
  const [recProductId, setRecProductId] = useState('');
  const [recSaving, setRecSaving] = useState(false);

  const loadRecs = useCallback(async () => {
    if (!lpId) return;
    try { const d = await crmApi(`/api/landing-pages/${lpId}/recommendations`); setRecs(d.recommendations || []); } catch {}
  }, [lpId]);

  const loadDomain = useCallback(async () => {
    if (!lpId) return;
    try { setDomainInfo(await crmApi(`/api/landing-pages/${lpId}/domain`)); } catch { /* the field still works */ }
  }, [lpId]);

  /** A real DNS and TLS lookup. The only thing that can verify this domain. */
  const checkDomainNow = async () => {
    if (!lpId) return;
    setChecking(true);
    try {
      const got = await crmApi(`/api/landing-pages/${lpId}/domain`, { method: 'POST' });
      setDomainInfo(got);
      setLastCheck(got.lastCheck ?? null);
      // The public-link card reads the page's own verification stamp, so a
      // check that just passed must reach it too — or the card keeps warning
      // about a domain that is now the address.
      await load();
    } catch (e: any) {
      void tell({ title: 'تعذّر التحقّق من النطاق', body: e.message, tone: 'danger' });
    } finally { setChecking(false); }
  };

  const load = useCallback(async () => {
    if (!lpId) return;
    setLoading(true);
    try {
      const data = await crmApi(`/api/landing-pages/${lpId}`);
      setLp(data.landingPage);
      setOffers(Array.isArray(data.offers) ? data.offers : []);
      setForm({
        name: data.landingPage.name,
        slug: data.landingPage.slug,
        productId: data.landingPage.productId || '',
        domain: data.landingPage.domain || '',
      });
    } catch (e: any) { setApiError(e.message); } finally { setLoading(false); }
  }, [lpId]);

  useEffect(() => { load(); }, [load]);
  useLiveRefresh(loadDomain, { key: lpId });
  useEffect(() => {
    if (lpId) { loadRecs(); }
  }, [lpId, loadRecs]);

  const save = async () => {
    setSaveMsg(null);
    setSaving(true);
    try {
      await crmApi(`/api/landing-pages/${lpId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name,
          slug: form.slug.toLowerCase().trim(),
          productId: form.productId || null,
          domain: form.domain.trim(),
        }),
      });
      setSaveMsg('تم الحفظ');
      // A saved domain is a NEW address with no verification behind it, so the
      // records and the badge are re-read rather than left showing the old
      // hostname's answer.
      setLastCheck(null);
      await Promise.all([load(), loadDomain()]);
    } catch (e: any) { setSaveMsg(e.message); } finally { setSaving(false); }
  };

  /*
   * PUBLISHING IS OUTWARD-FACING, AND IT TOOK A ROUND TRIP IN SILENCE.
   *
   * The button gave no sign it had been pressed, so it invited a second
   * press — two PATCHes and two reloads for one decision — and this state
   * existed already, declared and never wired to anything. It is the
   * guard somebody meant to add.
   */
  const [publishing, setPublishing] = useState(false);
  const togglePublish = async () => {
    if (publishing) return;
    setPublishing(true);
    setSaveMsg(null);
    try {
      await crmApi(`/api/landing-pages/${lpId}`, { method: 'PATCH', body: JSON.stringify({ isPublished: !lp.isPublished }) });
      await load();
    } catch (e: any) { setSaveMsg(e.message); }
    finally { setPublishing(false); }
  };

  const uploadHtml = async (file: File) => {
    setUploadMsg(null);
    setUploadMsg('جارٍ الرفع…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`/api/landing-pages/${lpId}/html`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUploadMsg(`تم رفع الملف (${file.name})`);
      await load();
      await refreshPreview();
    } catch (e: any) { setUploadMsg(e.message); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const refreshPreview = async () => {
    try {
      const data = await crmApi(`/api/landing-pages/${lpId}/preview-token`, { method: 'POST' });
      setPreviewToken(data.previewPath);
    } catch {}
  };
  const refreshPreviewRef = useRef(refreshPreview);

  // ─── Recommendations management ───
  const addRecommendation = async () => {
    if (!recProductId) return;
    setRecSaving(true);
    try {
      await crmApi(`/api/landing-pages/${lpId}/recommendations`, { method: 'POST', body: JSON.stringify({ productId: recProductId, sortOrder: recs.length }) });
      setRecProductId('');
      await loadRecs();
      await refreshPreview();
    } catch (e: any) {
      void tell({ title: 'تعذرت إضافة المنتج المقترح', body: e.message, tone: 'danger' });
    } finally { setRecSaving(false); }
  };

  // The one line the customer reads under the suggestion. Saved when the field is left;
  // blank goes back to the start of the product's description.
  const saveRecommendationBlurb = async (recId: string, before: string | null, value: string) => {
    const blurb = value.trim();
    if (blurb === (before ?? '')) return;
    try {
      await crmApi(`/api/landing-pages/${lpId}/recommendations/${recId}`, { method: 'PATCH', body: JSON.stringify({ blurb: blurb || null }) });
      await loadRecs();
      await refreshPreview();
    } catch (e: any) {
      void tell({ title: 'تعذّر حفظ وصف المنتج المقترح', body: e.message, tone: 'danger' });
    }
  };

  const deleteRecommendation = async (recId: string) => {
    try {
      await crmApi(`/api/landing-pages/${lpId}/recommendations/${recId}`, { method: 'DELETE' });
      await loadRecs();
      await refreshPreview();
    } catch (e: any) {
      void tell({ title: 'تعذر حذف المنتج المقترح', body: e.message, tone: 'danger' });
    }
  };

  /**
   * The link to hand over — built by the same rule every other screen uses
   * (src/lib/public-address.ts). It used to be `origin + /lp/<slug>` and
   * ignored the page's own domain completely, so a seller who had connected
   * one was still given the internal address.
   */
  const address = lp
    ? publicAddress(typeof window === 'undefined' ? '' : window.location.origin, {
        kind: 'lp', slug: lp.slug, domain: lp.domain, domainVerifiedAt: lp.domainVerifiedAt,
      })
    : null;
  const publicUrl = address?.url ?? '';

  useEffect(() => {
    if (lp && lpId) refreshPreviewRef.current();
  }, [lp, lpId]);


  const copyUrl = async () => {
    if (await copyText(publicUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      void tell({ title: 'انسخ الرابط يدوياً', body: 'المتصفح لم يسمح بالنسخ التلقائي.', value: publicUrl });
    }
  };

  if (loading) {
    return (
      <>
        <div className="p-10 text-center text-[var(--sys-muted-foreground)] text-sm">جارٍ التحميل…</div>
      </>
    );
  }
  if (apiError || !lp) {
    return (
      <>
        <div className="p-10 text-center text-[var(--sys-destructive)] text-sm">{apiError || 'الصفحة غير موجودة'}</div>
      </>
    );
  }

  // An offer price with no currency beside it is a number, not a price —
  // and this company sells into more than one country.
  const currencyCode: string = lp.store?.country?.currencyCode || '';

  /** «انسخ الصفحة» — the server decides what carries over; the copy opens on its own page. */
  const duplicatePage = async () => {
    try {
      const d = await crmApi(`/api/landing-pages/${lpId}/duplicate`, { method: 'POST' });
      if (d?.page?.id) window.location.href = `/store/landing-pages/${d.page.id}`;
    } catch (e: any) {
      void tell({ title: 'تعذّر نسخ الصفحة', body: e.message, tone: 'danger' });
      throw e;
    }
  };

  return (
    <>
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        {/* On a phone the title, the badge and two buttons cannot share one
            row: the heading wrapped onto three lines and the buttons left
            the screen. So the row breaks, and the actions sit together on
            their own line where they are still one tap each. */}
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Row one on a phone: where you came from, and where this page
              stands. The title gets its own line rather than being squeezed
              to "تحري.." between a button and a badge. */}
          <Button variant="secondary" size="sm" onClick={() => (window.location.href = '/store/landing-pages')}>
            <RiArrowRightLine className="icon-mirror w-4 h-4" /> رجوع
          </Button>
          <Badge variant={lp.isPublished ? 'success' : 'warning'}>{lp.isPublished ? 'منشورة' : 'مسودة'}</Badge>

          <PageHeader title="تحرير صفحة الهبوط"
          description={lp.name}
        />

          <div className="flex flex-1 items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => (window.location.href = `/store/landing-pages/${lpId}/editor`)}>
              <RiPencilLine className="w-4 h-4" /> المحرّر
            </Button>
            <Button
              size="sm"
              onClick={togglePublish}
              loading={publishing}
              variant={lp.isPublished ? 'outline' : 'success'}
            >
              {lp.isPublished ? 'إلغاء النشر' : 'نشر الصفحة'}
            </Button>
          </div>
        </div>

        <PageSummary
          lp={lp}
          publicUrl={publicUrl}
          offers={offers}
          copied={copied}
          onCopy={() => { void copyUrl(); }}
          onEdit={() => { window.location.href = `/store/landing-pages/${lpId}/editor`; }}
          onPreview={() => { window.open(lp.isPublished ? publicUrl : (previewToken || publicUrl), '_blank', 'noopener'); }}
          onDuplicate={duplicatePage}
        />

        {/* `min-w-0` on the columns is not cosmetic: a grid item's automatic
            minimum size is its min-content width, and a text input's is about
            twenty characters. Without it the column refused to shrink and the
            whole page scrolled sideways by 185px on a phone. */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* ─── Settings + upload ─── */}
          <div className="min-w-0 space-y-6">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-[var(--sys-foreground)]">اسم الصفحة</label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-[var(--sys-foreground)]">الرابط (slug)</label>
                  <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} dir="ltr" />
                </div>
                {/* A domain of the seller's own. The page keeps working at
                    /lp/<slug> either way — the domain is a second door, not
                    a replacement, so a mistyped DNS record never takes a
                    live page offline. */}
                <div>
                  <label className="text-xs font-semibold text-[var(--sys-foreground)]">نطاق خاص (اختياري)</label>
                  <Input
                    value={form.domain}
                    onChange={(e) => setForm({ ...form, domain: e.target.value })}
                    dir="ltr"
                    placeholder="shop.example.com"
                  />
                  <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                    اكتب النطاق هنا أولاً، ثم أضف السجلّات التي ستظهر لك عند مزوّد النطاق.
                    الصفحة تبقى تعمل على <code dir="ltr">/lp/{lp.slug}</code> في الحالتين،
                    فالنطاق باب إضافي لا بديل — وخطأ في الـDNS لا يوقف صفحة تعمل.
                  </p>

                  {/* ── WHAT WAS HERE BEFORE ──
                      A green `https://<domain>` printed the instant the field
                      was saved. Nothing had been looked up: the screen was
                      telling the seller the page was reachable while every
                      customer could be meeting an error. And the sentence
                      above told them to create «an A or CNAME record»
                      without ever saying WHICH VALUE — a step no one can
                      carry out.
                      Now: the records, and a real lookup. */}
                  {lp.domain && domainInfo && (
                    <div className="mt-2 space-y-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                            domainInfo.verifiedAt
                              ? 'bg-[var(--sys-success)]/10 text-[var(--sys-success)]'
                              : 'bg-[var(--sys-warning)]/15 text-[var(--sys-warning)]'
                          }`}
                        >
                          {domainInfo.verifiedAt ? 'متحقَّق' : 'غير متحقَّق بعد'}
                        </span>
                        <Button size="sm" variant="secondary" disabled={checking} onClick={() => void checkDomainNow()}>
                          {checking ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiRefreshLine className="h-4 w-4" />}
                          تحقّق الآن
                        </Button>
                      </div>

                      {domainInfo.verifiedAt ? (
                        <p className="text-xs text-[var(--sys-success)]" dir="ltr">
                          https://{lp.domain}
                        </p>
                      ) : (
                        <p className="text-xs leading-relaxed text-[var(--sys-warning)]">
                          لا تنشر هذا النطاق في إعلان قبل أن يصير «متحقَّق» — قد لا يفتح عند الزبون.
                        </p>
                      )}

                      {lastCheck && <p className="text-xs leading-relaxed text-[var(--sys-foreground)]">{lastCheck.detail}</p>}

                      {domainInfo.records.length === 0 || !domainInfo.target ? (
                        <p className="rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-warning)]/10 p-2 text-xs leading-relaxed text-[var(--sys-warning)]">
                          لم يُضبط عنوان التطبيق على الخادم بعد (<code dir="ltr">APP_DOMAIN</code> أو{' '}
                          <code dir="ltr">APP_PUBLIC_IP</code>)، فلا يمكن إخبارك بقيمة التوجيه المطلوبة —
                          ولن نخترع لك قيمة تُخرج صفحتك عن الخدمة. اضبطها على الخادم وستظهر هنا.
                        </p>
                      ) : (
                        <>
                          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                            أضف سجل TXT <strong>وواحداً</strong> من سجلّي التوجيه في لوحة إدارة النطاق،
                            ثم اضغط «تحقّق الآن». انتشار السجلّات قد يستغرق من دقائق إلى ساعات.
                          </p>
                          <ul className="space-y-1">
                            {domainInfo.records.map((r, i) => (
                              <li key={i} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 py-1.5">
                                <code className="block truncate text-xs text-[var(--sys-heading)]" dir="ltr" title={`${r.type} ${r.name} ${r.value} ${r.ttl}`}>
                                  {r.type} | {r.name} | {r.value} | TTL {r.ttl}
                                </code>
                                {r.note && <span className="text-xs text-[var(--sys-muted)]">{r.note}</span>}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs font-semibold text-[var(--sys-foreground)]">المنتج المرتبط</label>
                  {/*
                    114 products, measured on this database. As a `<select>`
                    that is a scroll, and the list it opens is painted by the
                    browser rather than by the theme — «لما أجي أختار منتج
                    يتضوي بيضا». `anyOption` keeps «لم يُختر» reachable,
                    because a landing page is allowed to have no product.
                  */}
                  <ProductPicker
                    products={products}
                    value={form.productId}
                    onChange={(productId) => setForm({ ...form, productId })}
                    anyOption={{ value: '', label: '— بلا منتج —' }}
                  />
                  <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">السعر يُؤخذ من المنتج في قاعدة البيانات — لا يُقبل من المتصفح أبدًا.</p>
                </div>
                <div className="flex items-center justify-between">
                  {saveMsg && <span className="text-xs text-[var(--sys-foreground)]">{saveMsg}</span>}
                  <Button onClick={save} disabled={saving}>
                    {saving ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiFileCodeLine className="w-4 h-4" />} حفظ التعديلات
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="font-semibold text-[var(--sys-heading)] text-sm">ملف HTML</h3>
                <p className="text-xs text-[var(--sys-muted-foreground)]">
                  ارفع ملف <code dir="ltr">.html</code> جاهز (حد أقصى 2MB). يُعرض دائمًا داخل iframe معزول — لا يمكنه قراءة جلسة CRM.
                  نموذج الطلب يُضاف تلقائيًا أسفل الصفحة من النظام نفسه — لا تحتاج أي <code dir="ltr">&lt;form&gt;</code> داخل الملف.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".html"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && uploadHtml(e.target.files[0])}
                />
                <Button onClick={() => fileRef.current?.click()}>
                  <RiUpload2Line className="w-4 h-4" /> رفع ملف HTML
                </Button>
                {uploadMsg && <p className="text-xs text-[var(--sys-foreground)]">{uploadMsg}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="font-semibold text-[var(--sys-heading)]">نموذج الطلب</h3>
                <div className="flex items-center gap-2 rounded-lg border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] px-3 py-2.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-[var(--sys-success)] text-[var(--sys-primary-foreground)] "><RiCheckLine className="h-4 w-4" aria-hidden /></span>
                  <div>
                    <p className="text-sm font-semibold text-[var(--sys-heading)]">نموذج الطلب مفعل</p>
                    <p className="text-xs text-[var(--sys-muted-foreground)]">يظهر تلقائيًا أسفل الصفحة لكل زائر — بدون أي إعداد إضافي. المنتج والسعر يؤخذان من قاعدة البيانات.</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Offers live on the PRODUCT now — one bundle, one price,
                wherever it is sold. This card used to hold a second copy,
                and raising a price in the catalogue never reached it. */}
            <Card>
              <CardContent className="p-4 space-y-2">
                <h3 className="font-semibold text-[var(--sys-heading)] flex items-center gap-2">
                  <RiGiftLine className="w-4 h-4 text-[var(--sys-primary)]" /> عروض المنتج
                </h3>
                <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  العروض تُدار من صفحة المنتج نفسه، وهذه الصفحة تقرأ منها مباشرة —
                  فتغيير السعر هناك يصل إلى هنا وإلى كل مكان يبيع نفس المنتج.
                </p>
                {lp.productId ? (
                  <a href={`/products/${lp.productId}`}>
                    <Button variant="outline" size="sm">
                      <RiGiftLine className="w-4 h-4" /> إدارة عروض هذا المنتج
                    </Button>
                  </a>
                ) : (
                  <p className="text-xs text-[var(--sys-warning)]">
                    اربط الصفحة بمنتج أولاً حتى تظهر عروضه عليها.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ─── Recommended products ─── (the anchor «بعد الطلب» in the editor links to) */}
            <div id="recommendations" style={{ scrollMarginTop: 80 }} />
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-[var(--sys-heading)] flex items-center gap-2">
                    <RiGiftLine className="w-4 h-4 text-[var(--sys-primary)]" /> المنتجات المقترحة بعد الطلب
                  </h3>
                </div>
                <p className="text-xs text-[var(--sys-muted-foreground)]">تظهر في شاشة النجاح بعد الطلب — يمكن للعميل إضافتها إلى نفس الطلب خلال 30 دقيقة. تحت كل منتج سطر قصير (اكتبه أو بيُأخذ من وصف المنتج)، ورابط «شوف المنتج» لصفحته إذا إله صفحة منشورة.</p>
                <div className="flex gap-2">
                  {/*
                    The same 114-row dropdown, a second time on this screen —
                    not reported, found while fixing the one above it. The
                    already-recommended products are filtered out BEFORE the
                    picker sees them, so the search never offers a product
                    that would be refused on add.

                    The row shows the SKU where it used to show the price:
                    that is `ProductPicker`'s own row, and the price is not
                    on `PickableProduct`. Named in the hand-back as the one
                    thing this conversion costs.
                  */}
                  <ProductPicker
                    className="flex-1"
                    products={products.filter((p) => !recs.some((r: any) => r.product?.id === p.id))}
                    value={recProductId}
                    onChange={setRecProductId}
                    anyOption={{ value: '', label: '— اختر منتجًا —' }}
                  />
                  <Button size="sm" onClick={addRecommendation} disabled={recSaving || !recProductId}>
                    {recSaving ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiAddCircleLine className="w-4 h-4" />} إضافة
                  </Button>
                </div>
                {recs.length === 0 ? (
                  <p className="text-xs text-[var(--sys-muted-foreground)]">
                    لا اقتراحاتٍ بعد — اضغط الزرّ أعلاه ليقرأ المساعدُ الصفحةَ ويقترح ما يناسبها.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {recs.map((r: any, i: number) => (
                      <div key={r.id} className="space-y-1.5 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[var(--sys-muted)]">{i + 1}.</span>
                          <span className="flex-1 truncate text-sm text-[var(--sys-heading)]">{r.product?.name}</span>
                          <span className="text-xs font-bold text-[var(--sys-primary)]" dir="ltr">{r.product?.basePrice ?? '—'}</span>
                          {!r.isActive && <span className="text-xs text-[var(--sys-warning)]">معطّل</span>}
                          <button aria-label="حذف" title="حذف" onClick={() => deleteRecommendation(r.id)} className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1 rounded-lg hover:bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]"><RiDeleteBinLine className="w-4 h-4" /></button>
                        </div>
                        <Input
                          key={`${r.id}:${r.blurb ?? ''}`}
                          aria-label={`سطر قصير تحت ${r.product?.name ?? 'المنتج'}`}
                          defaultValue={r.blurb ?? ''}
                          maxLength={140}
                          placeholder={r.product?.description ? `فاضي = «${String(r.product.description).slice(0, 50)}…»` : 'سطر قصير يشوّق الزبون — مثلاً: بيخلّي شعرك ناعم من أول غسلة'}
                          onBlur={(e) => saveRecommendationBlurb(r.id, r.blurb ?? null, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="font-semibold text-[var(--sys-heading)]">الرابط العام</h3>
                <div className="flex items-center gap-2" dir="ltr">
                  <code className="flex-1 text-xs bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg px-3 py-2 truncate">{publicUrl}</code>
                  <Button variant="secondary" size="sm" onClick={copyUrl}><RiFileCopyLine className="w-4 h-4" /> {copied ? 'تم' : 'نسخ'}</Button>
                  {lp.isPublished && (
                    <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="sm"><RiExternalLinkLine className="icon-mirror w-4 h-4" /></Button>
                    </a>
                  )}
                </div>
                {/* A connected domain that has not passed a lookup is named
                    with its reason instead of being handed over as the link. */}
                {address?.pending && (
                  <p className="text-xs leading-relaxed text-[var(--sys-warning)]">{address.pending.reason}</p>
                )}
                {/* The numbers are read on the performance screen, where they
                    sit beside the device, the campaign and a date range. Three
                    tiles here were the same three numbers with none of that,
                    and a second place for a number is a second answer. */}
                <a
                  href="/growth/performance?tab=landing"
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2.5 text-xs text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
                >
                  <span className="flex items-center gap-1.5">
                    <RiDashboard3Line className="h-4 w-4" />
                    الزيارات والطلبات ونسبة التحويل
                  </span>
                  <span className="font-semibold">في لوحة الأداء ←</span>
                </a>
              </CardContent>
            </Card>
          </div>

          {/* ─── Preview (sandboxed, opaque origin) ─── */}
          <div className="min-w-0">
            <Card className="h-full">
              <CardContent className="p-4 flex flex-col h-full">
                <h3 className="font-semibold text-[var(--sys-heading)] flex items-center gap-2 mb-3">
                  <RiComputerLine className="w-5 h-5 text-[var(--sys-primary)]" /> معاينة آمنة
                </h3>
                {previewToken ? (
                  /**
                   * No sandbox here, on purpose — and it is where the
                   * isolation was doing harm rather than good.
                   *
                   * What loads is /lp/<slug>: OUR page, on OUR origin. The
                   * untrusted thing — HTML the seller uploaded — is already
                   * sealed one level deeper, in an iframe that page creates
                   * with sandbox="allow-scripts allow-forms allow-popups".
                   * A block-built page has no untrusted markup at all: the
                   * seller picked blocks and typed text, and our renderer
                   * drew them.
                   *
                   * Sandboxing the outer frame without allow-same-origin
                   * gave it an opaque origin, where reading storage throws
                   * and hydration dies — so the preview came up blank while
                   * the same URL opened perfectly in a tab. It protected
                   * nothing: the part that needed sealing is sealed by the
                   * page itself, and nesting keeps those restrictions.
                   */
                  <iframe
                    src={previewToken}
                    title="معاينة صفحة الهبوط"
                    className="flex-1 w-full min-h-[480px] rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]"
                  />
                ) : (
                  <div className="flex-1 min-h-[480px] flex items-center justify-center text-sm text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] rounded-lg">
                    جارٍ تجهيز المعاينة…
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
