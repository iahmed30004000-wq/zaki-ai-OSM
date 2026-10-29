'use client';

/**
 * SALESFLOW — /roles: Roles & Permissions management.
 * List + create/edit permission matrix + duplicate + delete with reassignment.
 * All enforcement is server-side; this UI gates mutations with userCan().
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useApp } from '@/context/AppContext';
import { arDate } from '@/lib/format';
import { userCan } from '@/lib/can';
import {
  PERMISSION_MODULES, MODULE_LABELS, SCOPE_LABELS,
  catalogItem, dependentsOf, isRetiredKey, newOrphans, requiredChain, viewGrantFor,
  type ScopeValue, type CatalogItem,
} from '@/lib/permission-catalog';
import { RiAddCircleLine, RiAlertLine, RiArrowDownSLine, RiArrowGoBackLine, RiArrowUpSLine, RiCloseLine, RiDeleteBinLine, RiFileCopyLine, RiGroupLine, RiKey2Line, RiPencilLine, RiSearchLine, RiShieldCheckLine, RiToolsLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { AdvancedGroup } from '@/components/ui/AdvancedGroup';

interface RolePerm { permission: string; scope: string; scopeIds?: unknown }
interface RoleRow {
  id: string;
  companyId: string | null;
  name: string;
  isSystem: boolean;
  createdAt: string;
  /** The version a save is made over — sent back, and the door refuses a stale one (RV171). */
  updatedAt: string;
  usersCount: number;
  permissionsCount: number;
  permissions: RolePerm[];
}

interface DraftPerm { scope: ScopeValue; scopeIds: string[] }

const DEBOUNCE_MS = 350;

export function PermissionsScreen() {
  const { locale, isRtl, currentUser } = useApp();
  const ar = locale === 'ar';

  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRow | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Record<string, DraftPerm>>({});
  const [moduleSearch, setModuleSearch] = useState('');
  const [openModules, setOpenModules] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // Restore-defaults state: the button only exists for a role that has a
  // shipped matrix, and it fills the draft rather than writing — the admin
  // still presses Save, and can still cancel.
  const [defaultsAvailable, setDefaultsAvailable] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoredFlash, setRestoredFlash] = useState(false);
  // The views «إرجاع للافتراضي» had to add because their actions came back without them.
  const [restoredAdded, setRestoredAdded] = useState<string[]>([]);
  // What the last tick pulled in or took off, said under the row that was clicked.
  const [cascade, setCascade] = useState<{ at: string; text: string } | null>(null);

  // Delete state
  const [deletingRole, setDeletingRole] = useState<RoleRow | null>(null);
  const [replacementRoleId, setReplacementRoleId] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Duplicate state
  const [duplicatingRole, setDuplicatingRole] = useState<RoleRow | null>(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [duplicating, setDuplicating] = useState(false);
  // Drawn INSIDE the duplicate window: it used to go to the delete window's line, which is not on screen.
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  // Scope pickers
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState<{ id: string; name: string }[]>([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productPage, setProductPage] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canEdit = userCan(currentUser, 'roles.edit');
  const canCreate = userCan(currentUser, 'roles.create');
  const canDelete = userCan(currentUser, 'roles.delete');
  const isSuper = currentUser?.role === 'SUPER_ADMIN';

  const loadRoles = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/roles');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || (ar ? 'فشل تحميل الأدوار' : 'Failed to load roles'));
      }
      const data = await res.json();
      setRoles(data.roles);
    } catch (e: any) {
      setLoadError(e.message);
    }
  }, [ar]);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  const filteredRoles = useMemo(() => {
    if (!roles) return [];
    const q = search.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => r.name.toLowerCase().includes(q));
  }, [roles, search]);

  // ── Editor helpers ──
  function openCreate() {
    setDefaultsAvailable(false);
    setRestoredFlash(false);
    setRestoredAdded([]);
    setCascade(null);
    setEditingRole(null);
    setName('');
    setDraft({});
    setModuleSearch('');
    setOpenModules({});
    setEditorError(null);
    setEditorOpen(true);
  }

  function openEdit(role: RoleRow) {
    setRestoredFlash(false);
    setRestoredAdded([]);
    setCascade(null);
    setDefaultsAvailable(false);
    fetch(`/api/roles/${role.id}/default`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDefaultsAvailable(!!d?.available))
      .catch(() => setDefaultsAvailable(false));
    setEditingRole(role);
    setName(role.name);
    // Opening changes NOTHING: an old pair (an action without its screen key) stays as it is until the person touches it.
    const d: Record<string, DraftPerm> = {};
    for (const p of role.permissions) {
      if (isRetiredKey(p.permission)) continue;
      d[p.permission] = {
        scope: (p.scope as ScopeValue) || 'ALL_COMPANY',
        scopeIds: Array.isArray(p.scopeIds) ? (p.scopeIds as string[]) : [],
      };
    }
    setDraft(d);
    setModuleSearch('');
    setOpenModules({});
    setEditorError(null);
    setEditorOpen(true);
  }

  /**
   * A TICK AND WHAT IT NEEDS, TOGETHER.
   *
   * An action ticked without the key that opens its screen is a box that is
   * on and does nothing — the person can never reach the button. So ticking
   * an action ticks its screen key too, and unticking a screen key unticks
   * the actions that need it, and the line under the row says which, so
   * nothing changes behind the person's back. Worked out from the draft in
   * the click (not inside a state updater, which React runs twice).
   */
  function togglePerm(item: CatalogItem) {
    const next = { ...draft };
    const name = (k: string) => `«${catalogItem(k)?.ar ?? k}»`;
    if (next[item.key]) {
      delete next[item.key];
      const gone = dependentsOf(item.key).filter((k) => next[k]);
      for (const k of gone) delete next[k];
      const shown = gone.slice(0, 3).map(name).join('، ');
      const more = gone.length > 3 ? ` و${gone.length - 3} غيرها` : '';
      setCascade(gone.length ? { at: item.key, text: `انشالت معها ${shown}${more} — ما بتشتغل بدون ${name(item.key)}.` } : null);
    } else {
      next[item.key] = { scope: 'ALL_COMPANY', scopeIds: [] };
      const added = requiredChain(item.key).filter((k) => !next[k]);
      for (const k of added) next[k] = viewGrantFor(k, next[item.key]);
      const shown = added.map((k) => `${name(k)}${(catalogItem(k)?.scopes?.length ?? 0) > 1 ? ` (${SCOPE_LABELS[next[k].scope].ar})` : ''}`).join('، ');
      setCascade(added.length ? { at: item.key, text: `انضافت معها ${shown} — ما بتشتغل بدونها.` } : null);
    }
    setDraft(next);
  }

  function setScope(key: string, scope: ScopeValue) {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], scope, scopeIds: [] } }));
  }

  function toggleScopeId(key: string, id: string) {
    setDraft((prev) => {
      const cur = prev[key];
      const ids = cur.scopeIds.includes(id) ? cur.scopeIds.filter((x) => x !== id) : [...cur.scopeIds, id];
      return { ...prev, [key]: { ...cur, scopeIds: ids } };
    });
  }

  // Load categories when a CATEGORY scope is active.
  useEffect(() => {
    const needsCategories = Object.values(draft).some((d) => d.scope === 'CATEGORY');
    if (needsCategories && categories.length === 0) {
      fetch('/api/categories')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
        .then((d) => setCategories(d.categories ?? []))
        .catch(() => setCategories([]));
    }
  }, [draft, categories.length]);

  // Debounced product search for SPECIFIC scope.
  const activeSpecific = Object.entries(draft).some(([, d]) => d.scope === 'SPECIFIC');
  useEffect(() => {
    if (!activeSpecific) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setProductLoading(true);
      try {
        const res = await fetch(`/api/products?q=${encodeURIComponent(productQuery)}&limit=10`);
        if (res.ok) {
          const data = await res.json();
          const list: any[] = Array.isArray(data) ? data : (data.products ?? []);
          const q = productQuery.trim().toLowerCase();
          const filtered = q
            ? list.filter((p: any) => (p.name ?? '').toLowerCase().includes(q) || (p.nameEn ?? '').toLowerCase().includes(q))
            : list;
          setProductResults(filtered.slice(0, 50).map((p: any) => ({ id: p.id, name: p.name })));
          setProductPage(0);
        }
      } finally {
        setProductLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [productQuery, activeSpecific, editorOpen, editingRole]);

  /** Load the role's shipped matrix into the draft. Nothing is written until Save. */
  async function restoreDefaults() {
    if (!editingRole) return;
    setRestoring(true);
    setEditorError(null);
    try {
      const res = await fetch(`/api/roles/${editingRole.id}/default`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.available) {
        throw new Error(data.error || (ar ? 'لا توجد صلاحيات افتراضية لهذا الدور' : 'This role has no defaults'));
      }
      const d: Record<string, DraftPerm> = {};
      for (const p of data.permissions as RolePerm[]) {
        if (isRetiredKey(p.permission)) continue;
        d[p.permission] = { scope: (p.scope as ScopeValue) || 'ALL_COMPANY', scopeIds: [] };
      }
      /*
       * The door refuses a save that ADDS an action without its screen key,
       * and a shipped matrix can hold such a pair the role does not have now.
       * So the views those actions need are added here, and said — a pair the
       * role already has is left as it is (it is not new, and saves fine).
       */
      const stored = editingRole.permissions.map((p) => p.permission);
      const added: string[] = [];
      for (let round = 0; round < 8; round++) {
        const fresh = newOrphans(stored, Object.keys(d));
        if (fresh.length === 0) break;
        for (const o of fresh) {
          d[o.view] = viewGrantFor(o.view, d[o.action]);
          added.push(o.view);
        }
      }
      setDraft(d);
      setCascade(null);
      setRestoredAdded(added);
      setRestoredFlash(true);
    } catch (e: any) {
      setEditorError(e.message);
    } finally {
      setRestoring(false);
    }
  }

  async function saveEditor() {
    if (!name.trim()) {
      setEditorError(ar ? 'اسم الدور مطلوب' : 'Role name is required');
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      const permissions = Object.entries(draft).map(([permission, d]) => ({
        permission,
        scope: d.scope,
        scopeIds: d.scopeIds.length ? d.scopeIds : undefined,
      }));
      const url = editingRole ? `/api/roles/${editingRole.id}` : '/api/roles';
      const res = await fetch(url, {
        method: editingRole ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A save replaces the whole list, so it goes over the version it was read from (a stale one is refused with 409).
        body: JSON.stringify(editingRole ? { name, permissions, version: editingRole.updatedAt } : { name, permissions }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Somebody changed this role since it was opened: read it again, so the next opening carries the new version.
        if (res.status === 409) await loadRoles();
        throw new Error(data.error || data.errorAr || (ar ? 'فشل الحفظ' : 'Save failed'));
      }
      setEditorOpen(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      await loadRoles();
    } catch (e: any) {
      setEditorError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function openDuplicate(role: RoleRow) {
    setDuplicateError(null);
    setDuplicatingRole(role);
    setDuplicateName(`${role.name} (نسخة)`);
  }

  async function confirmDuplicate() {
    if (!duplicatingRole) return;
    setDuplicating(true);
    setDuplicateError(null);
    try {
      const res = await fetch(`/api/roles/${duplicatingRole.id}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || (ar ? 'فشل النسخ' : 'Duplicate failed'));
      }
      setDuplicatingRole(null);
      await loadRoles();
    } catch (e: any) {
      // Stays open and says why — a refusal here used to vanish with the window.
      setDuplicateError(e.message);
    } finally {
      setDuplicating(false);
    }
  }

  async function confirmDelete() {
    if (!deletingRole) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const needsReplacement = deletingRole.usersCount > 0;
      if (needsReplacement && !replacementRoleId) {
        throw new Error(ar ? 'اختر دورًا بديلًا أولًا' : 'Pick a replacement role first');
      }
      const url = needsReplacement
        ? `/api/roles/${deletingRole.id}?replacementRoleId=${encodeURIComponent(replacementRoleId)}`
        : `/api/roles/${deletingRole.id}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.errorAr || data.error || (ar ? 'فشل الحذف' : 'Delete failed'));
      }
      setDeletingRole(null);
      await loadRoles();
    } catch (e: any) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  }

  // ── Matrix filtering ──
  const visibleModules = useMemo(() => {
    const q = moduleSearch.trim().toLowerCase();
    if (!q) return PERMISSION_MODULES;
    return PERMISSION_MODULES
      .map((m) => ({
        ...m,
        items: m.items.filter(
          (i) => i.key.toLowerCase().includes(q) || i.ar.includes(q) || i.en.toLowerCase().includes(q)
        ),
      }))
      .filter((m) => m.items.length > 0);
  }, [moduleSearch]);

  const activeCount = Object.keys(draft).length;

  return (
    <>
      <div className="space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
        <PageHeader title={ar ? 'الأدوار والصلاحيات' : 'Roles & Permissions'}
            description={ar
                ? 'إدارة أدوار الفريق وصلاحياتهم — تُطبق التغييرات فورًا على الخادم.'
                : 'Manage team roles and their permissions — changes apply server-side immediately.'}
            actions={
              <><div className="flex items-center gap-2">
            <div className="relative w-52">
              <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-2.5 w-4 h-4 text-[var(--sys-muted)]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={ar ? 'بحث عن دور…' : 'Search roles…'}
                className="ps-8"
              />
            </div>
            {canCreate && (
              <Button onClick={openCreate}>
                <RiAddCircleLine className="w-4 h-4" />
                {ar ? 'دور جديد' : 'New Role'}
              </Button>
            )}
          </div></>
            }
          />

        {savedFlash && (
          <div className="rounded-lg bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)] text-xs font-medium px-4 py-2.5">
            {ar ? 'تم الحفظ بنجاح' : 'Saved successfully'}
          </div>
        )}

        {loadError && (
          <Card>
            <CardContent className="text-center py-10 space-y-3">
              <p className="text-sm text-[var(--sys-destructive)]">{loadError}</p>
              <Button variant="outline" size="sm" onClick={loadRoles}>{ar ? 'إعادة المحاولة' : 'Retry'}</Button>
            </CardContent>
          </Card>
        )}

        {roles && filteredRoles.length === 0 && !loadError && (
          <Card>
            <CardContent className="text-center py-12">
              <RiShieldCheckLine className="w-6 h-6 text-[var(--sys-border-strong)] mx-auto mb-3" />
              <p className="text-sm text-[var(--sys-muted-foreground)]">
                {search
                  ? `لا دورَ اسمه «${search}» — امسح البحث لترى الأدوار كلّها.`
                  : 'لا أدوارَ بعد. الدور مجموعةُ صلاحياتٍ تُسنَد لموظّفين، وبلا دورٍ يُسنَد كلُّ موظّفٍ صلاحياتِه واحدةً واحدة.'}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredRoles.map((role) => {
            const isSuperAdminRole = role.name === 'SUPER_ADMIN';
            const canEditThis = canEdit && (!role.isSystem || isSuper || currentUser?.role === 'COMPANY_ADMIN') && !isSuperAdminRole;
            const canDeleteThis = canDelete && !role.isSystem;
            return (
              <Card key={role.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-[var(--sys-heading)]">{role.name}</p>
                        <Badge variant={role.companyId === null ? 'info' : 'default'}>
                          {role.companyId === null ? (ar ? 'دور نظامي' : 'System') : (ar ? 'دور شركة' : 'Company')}
                        </Badge>
                      </div>
                      <p className="text-xs text-[var(--sys-muted)] mt-1">
                        {ar ? 'أُنشئ' : 'Created'} {arDate(role.createdAt)}
                      </p>
                    </div>
                    {isSuperAdminRole && (
                      <span title={ar ? 'وصول كامل مركزيًا' : 'Central full access'} className="cursor-help">
                        <Badge variant="purple"><RiShieldCheckLine className="w-4 h-4 me-1" />{ar ? 'وصول كامل مركزيًا' : 'Full access'}</Badge>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-3 text-xs text-[var(--sys-muted-foreground)]">
                    <span className="inline-flex items-center gap-1"><RiGroupLine className="w-4 h-4" />{role.usersCount} {ar ? 'مستخدم' : 'users'}</span>
                    <span className="inline-flex items-center gap-1"><RiKey2Line className="w-4 h-4" />{role.permissionsCount} {ar ? 'صلاحية' : 'permissions'}</span>
                  </div>

                  <div className="flex items-center gap-1.5 mt-4">
                    {isSuperAdminRole ? (
                      <span className="text-xs text-[var(--sys-muted)]" title={ar ? 'وصول كامل مركزيًا' : 'Central full access'}>
                        {ar ? 'قراءة فقط' : 'Read-only'}
                      </span>
                    ) : (
                      <>
                        {canEditThis && (
                          <Button variant="outline" size="sm" onClick={() => openEdit(role)}>
                            <RiPencilLine className="w-4 h-4" />{ar ? 'تعديل' : 'Edit'}
                          </Button>
                        )}
                        {canCreate && (
                          <Button variant="outline" size="sm" onClick={() => openDuplicate(role)}>
                            <RiFileCopyLine className="w-4 h-4" />{ar ? 'نسخ' : 'Duplicate'}
                          </Button>
                        )}
                        {canDeleteThis && (
                          <Button variant="outline" size="sm" className="text-[var(--sys-destructive)]" onClick={() => { setDeletingRole(role); setReplacementRoleId(''); setDeleteError(null); }}>
                            <RiDeleteBinLine className="w-4 h-4" />{ar ? 'حذف' : 'Delete'}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* ── Create/Edit modal ── */}
        <Modal
          isOpen={editorOpen}
          onClose={() => setEditorOpen(false)}
          title={editingRole ? (ar ? `تعديل الدور: ${editingRole.name}` : `Edit role: ${editingRole.name}`) : (ar ? 'دور جديد' : 'New Role')}
          subtitle={ar ? 'فعّل الصلاحيات وحدّد نطاقها عند الحاجة' : 'Enable permissions and set their scope where needed'}
          maxWidth="4xl"
        >
          <div className="space-y-4">
            <Input
              label={ar ? 'اسم الدور' : 'Role name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={ar ? 'مثال: موظف تأكيد الطلبات' : 'e.g. Order Confirmation Agent'}
              error={editorError ?? undefined}
            />

            <div className="flex items-center justify-between gap-3">
              <div className="relative flex-1 max-w-xs">
                <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-2.5 w-4 h-4 text-[var(--sys-muted)]" />
                <Input
                  value={moduleSearch}
                  onChange={(e) => setModuleSearch(e.target.value)}
                  placeholder={ar ? 'بحث في الصلاحيات…' : 'Search permissions…'}
                  className="ps-8"
                />
              </div>
              <div className="flex items-center gap-2">
                {editingRole && defaultsAvailable && (
                  <AdvancedGroup holds={ar ? 'إرجاع للافتراضي' : 'Restore defaults'}>
                  <Button variant="outline" size="sm" onClick={restoreDefaults} loading={restoring}>
                    <RiArrowGoBackLine className="icon-mirror w-4 h-4" />
                    {ar ? 'إرجاع للافتراضي' : 'Restore defaults'}
                  </Button>
                  </AdvancedGroup>
                )}
                <Badge variant={activeCount > 0 ? 'success' : 'default'}>
                  {activeCount} {ar ? 'صلاحية مفعّلة' : 'enabled'}
                </Badge>
              </div>
            </div>

            {restoredFlash && (
              <div className="rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] text-[var(--sys-warning)] text-xs px-4 py-2.5">
                {ar
                  ? 'تم تحميل الصلاحيات الافتراضية للدور — لن تُطبّق حتى تضغط حفظ التغييرات.'
                  : 'The role defaults are loaded — nothing changes until you press Save.'}
                {restoredAdded.length > 0 && (
                  <span className="block mt-1">
                    {`انضافت للافتراضي ${[...new Set(restoredAdded)].map((k) => `«${catalogItem(k)?.ar ?? k}»`).join('، ')} — في صلاحيات فيه ما بتشتغل بدونها.`}
                  </span>
                )}
              </div>
            )}

            {/*
              ── A ROLE THAT CANNOT FINISH ITS OWN WORK ──

              C1's rule: a confirmation agent cannot confirm, postpone or
              cancel an order until she has tried to reach the customer.
              Recording that attempt is `orders.contact_log`. So a role with
              `confirmation.work` and without it is handed a queue it can
              open and can never dispose of — every button locked, with a
              line underneath telling her to call first and no way to say
              that she did.

              Nothing here refuses the combination; the owner may want it
              for a read-only supervisor. It just says what it will do,
              beside the ticks that cause it, rather than in a support
              message three days later.
            */}
            {draft['confirmation.work'] && !draft['orders.contact_log'] && (
              <div className="rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] px-4 py-3 space-y-1.5">
                <p className="flex items-start gap-2 text-xs font-bold text-[var(--sys-warning)]">
                  <RiAlertLine className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    {ar
                      ? 'هالدور ما بيقدر يأكّد ولا يأجّل طلباته — القاعدة: اتصال أوّل'
                      : 'This role cannot confirm or postpone its own orders — the rule is: contact first'}
                  </span>
                </p>
                <p className="flex items-start gap-2 text-xs text-[var(--sys-heading)]">
                  <RiToolsLine className="w-4 h-4 shrink-0 mt-px text-[var(--sys-warning)]" />
                  <span>
                    {ar
                      ? 'فعّل «تسجيل نتيجة الاتصال»'
                      : 'Enable «Log contact result»'}
                  </span>
                </p>
              </div>
            )}

            {/*
              ── «طلباتي» DOES NOT NEED «عرض الطلبات» ──

              The order an agent holds opens through its own door
              (order-work-door.ts): `confirmation.work` is enough to open it,
              call, edit, confirm and give it back. «عرض الطلبات» is the
              «الطلبات» LIST, and both editors default it to «كل الشركة» — so
              the owner ticked a whole company's orders to let an agent work
              one. Said here, beside the tick that used to be the only way.
            */}
            {draft['confirmation.work'] && (
              <p className="text-xs text-[var(--sys-muted-foreground)]">
                {ar
                  ? '«طلباتي» ما بدها «عرض الطلبات»: الطلب اللي بين إيدين الموظف بينفتح ويشتغل عليه حتى لو «عرض الطلبات» مطفية.'
                  : '«My orders» does not need «View orders»: the order in the agent’s hands opens and can be worked even with «View orders» off.'}
              </p>
            )}

            {/*
              ── AND A PULL WITH NO DESK TO LAND ON ──

              `confirmation.pull` takes an order from the pool; the desk it
              lands on, «طلباتي», and the door it is worked through both ask
              `confirmation.work`. Without it the order is hers and she cannot
              see it — until the ninety-minute release takes it back.
            */}
            {draft['confirmation.pull'] && !draft['confirmation.work'] && (
              <div className="rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] px-4 py-3 space-y-1.5">
                <p className="flex items-start gap-2 text-xs font-bold text-[var(--sys-warning)]">
                  <RiAlertLine className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    {/* With «عرض الطلبات» the pulled order still opens from the list, so only a role without it is told it cannot work them. */}
                    {ar
                      ? `هالدور بيسحب طلبات وما رح تظهر على مكتبه${draft['orders.view'] ? '' : ' — ولا بيقدر يشتغل عليها'}`
                      : `This role pulls orders that will not appear on its desk${draft['orders.view'] ? '' : ' — and cannot work them'}`}
                  </span>
                </p>
                <p className="flex items-start gap-2 text-xs text-[var(--sys-heading)]">
                  <RiToolsLine className="w-4 h-4 shrink-0 mt-px text-[var(--sys-warning)]" />
                  <span>
                    {ar
                      ? 'فعّل «العمل على طلباتي والمؤجلة»'
                      : 'Enable «Work own and postponed orders»'}
                  </span>
                </p>
              </div>
            )}

            <div className="space-y-2">
              {visibleModules.map((m) => {
                const open = openModules[m.module] ?? false;
                const moduleActive = m.items.filter((i) => draft[i.key]).length;
                return (
                  <div key={m.module} className="rounded-lg border border-[var(--sys-border)] overflow-hidden">
                    <button
                      onClick={() => setOpenModules((p) => ({ ...p, [m.module]: !p[m.module] }))}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[var(--sys-surface)] hover:bg-[var(--sys-border)]/60 transition-colors cursor-pointer text-start"
                    >
                      <span className="text-xs font-bold text-[var(--sys-heading)]">
                        {ar ? MODULE_LABELS[m.module]?.ar ?? m.module : MODULE_LABELS[m.module]?.en ?? m.module}
                        {moduleActive > 0 && (
                          <span className="ms-2 text-xs font-bold text-[var(--sys-success)] bg-[var(--sys-success-soft)] rounded-md px-1.5 py-0.5">
                            {moduleActive}
                          </span>
                        )}
                      </span>
                      {open ? <RiArrowUpSLine className="w-4 h-4 text-[var(--sys-muted)]" /> : <RiArrowDownSLine className="w-4 h-4 text-[var(--sys-muted)]" />}
                    </button>
                    {open && (
                      <div className="divide-y divide-[var(--sys-surface)]">
                        {m.items.map((item) => {
                          const d = draft[item.key];
                          return (
                            <div key={item.key} className="px-4 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <label className="flex items-center gap-2.5 cursor-pointer min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={!!d}
                                    onChange={() => togglePerm(item)}
                                    className="w-4 h-4 accent-[var(--sys-primary)] cursor-pointer shrink-0"
                                  />
                                  <span className="text-xs text-[var(--sys-heading)] font-medium truncate">
                                    {ar ? item.ar : item.en}
                                  </span>
                                  <span className="text-xs text-[var(--sys-muted)] font-mono hidden sm:inline truncate" dir="ltr">{item.key}</span>
                                </label>
                                {d && item.scopes && item.scopes.length > 1 && (
                                  <div className="w-44 shrink-0">
                                    <Select
                                      value={d.scope}
                                      onChange={(e) => setScope(item.key, e.target.value as ScopeValue)}
                                      options={item.scopes.map((s) => ({
                                        value: s,
                                        label: ar ? SCOPE_LABELS[s].ar : SCOPE_LABELS[s].en,
                                      }))}
                                    />
                                  </div>
                                )}
                              </div>

                              {/* What the last tick pulled in or took off, under the row that was clicked */}
                              {cascade?.at === item.key && (
                                <p role="status" className="mt-1 ms-6 text-xs text-[var(--sys-warning)]">{cascade.text}</p>
                              )}
                              {/* An old pair the person has not touched: said, never fixed behind their back */}
                              {d && item.requires && !draft[item.requires] && (
                                <p className="mt-1 ms-6 text-xs text-[var(--sys-warning)]">
                                  {`بتحتاج «${catalogItem(item.requires)?.ar ?? item.requires}» — مش مفعّلة.`}
                                </p>
                              )}
                              {item.note && <p className="mt-1 ms-6 text-xs text-[var(--sys-muted)]">{item.note}</p>}
                              {item.opens && item.opens.length > 0 && (
                                <p className="mt-1 ms-6 text-xs text-[var(--sys-muted)]">{`بتفتح: ${item.opens.join(' · ')}`}</p>
                              )}

                              {/* CATEGORY scope → category checkboxes */}
                              {d && d.scope === 'CATEGORY' && (
                                <div className="mt-2 ms-6 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] p-3">
                                  {categories.length === 0 ? (
                                    <p className="text-xs text-[var(--sys-muted)]">لا تصنيفات منتجات بعد — وبلا تصنيف لا معنى لصلاحية محصورة بتصنيف. تُعرَّف من «المنتجات ← التصنيفات».</p>
                                  ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                                      {categories.map((c) => (
                                        <label key={c.id} className="flex items-center gap-1.5 text-xs text-[var(--sys-heading)] cursor-pointer">
                                          <input
                                            type="checkbox"
                                            checked={d.scopeIds.includes(c.id)}
                                            onChange={() => toggleScopeId(item.key, c.id)}
                                            className="w-3.5 h-3.5 accent-[var(--sys-primary)] cursor-pointer"
                                          />
                                          {c.name}
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* SPECIFIC scope → product search + chips */}
                              {d && d.scope === 'SPECIFIC' && (
                                <div className="mt-2 ms-6 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] p-3 space-y-2">
                                  <div className="relative">
                                    <RiSearchLine className="absolute top-1/2 -translate-y-1/2 start-2.5 w-4 h-4 text-[var(--sys-muted)]" />
                                    <Input
                                      value={productQuery}
                                      onChange={(e) => setProductQuery(e.target.value)}
                                      placeholder={ar ? 'ابحث عن منتج بالاسم…' : 'Search products by name…'}
                                      className="ps-8 text-xs"
                                    />
                                  </div>
                                  {productLoading && <p className="text-xs text-[var(--sys-muted)]">{ar ? 'جارِ البحث…' : 'Searching…'}</p>}
                                  {productResults.length > 0 && (
                                    <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] divide-y divide-[var(--sys-surface)]">
                                      {productResults.slice(0, (productPage + 1) * 10).map((p) => (
                                        <button
                                          key={p.id}
                                          onClick={() => !d.scopeIds.includes(p.id) && toggleScopeId(item.key, p.id)}
                                          className="w-full text-start px-3 py-2 text-xs text-[var(--sys-heading)] hover:bg-[var(--sys-surface)] cursor-pointer"
                                        >
                                          {p.name}
                                        </button>
                                      ))}
                                      {(productPage + 1) * 10 < productResults.length && (
                                        <button
                                          onClick={() => setProductPage((p) => p + 1)}
                                          className="w-full px-3 py-2 text-xs font-bold text-[var(--sys-primary)] hover:bg-[var(--sys-surface)] cursor-pointer"
                                        >
                                          {ar ? 'تحميل المزيد' : 'Load more'}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {d.scopeIds.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                      {d.scopeIds.map((id) => {
                                        const prod = productResults.find((p) => p.id === id);
                                        return (
                                          <span key={id} className="inline-flex items-center gap-1 text-xs font-medium bg-[var(--sys-primary-soft)] text-[var(--sys-primary)] border border-[var(--sys-primary-soft)] rounded-md px-1.5 py-0.5">
                                            {prod?.name ?? id}
                                            <button onClick={() => toggleScopeId(item.key, id)} aria-label="أزل من النطاق" title="أزل من النطاق" className="cursor-pointer hover:text-[var(--sys-destructive)]">
                                              <RiCloseLine className="w-4 h-4" />
                                            </button>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleModules.length === 0 && (
                <p className="text-xs text-[var(--sys-muted)] text-center py-6">{ar ? 'لا صلاحيات مطابقة' : 'No matching permissions'}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--sys-border)]">
              <Button variant="outline" onClick={() => setEditorOpen(false)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
              <Button onClick={saveEditor} loading={saving}>
                {editingRole ? (ar ? 'حفظ التغييرات' : 'Save changes') : (ar ? 'إنشاء الدور' : 'Create role')}
              </Button>
            </div>
          </div>
        </Modal>

        {/* ── Delete modal ── */}
        <Modal
          isOpen={!!deletingRole}
          onClose={() => setDeletingRole(null)}
          title={ar ? 'حذف الدور' : 'Delete Role'}
          maxWidth="md"
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--sys-heading)]">
              {ar
                ? `هل أنت متأكد من حذف الدور آ«${deletingRole?.name}»؟`
                : `Delete role "${deletingRole?.name}"?`}
            </p>
            {deletingRole && deletingRole.usersCount > 0 && (
              <div className="rounded-lg bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] p-3 space-y-2">
                <p className="text-xs font-bold text-[var(--sys-warning)]">
                  {ar
                    ? `هذا الدور مرتبط بـ ${deletingRole.usersCount} مستخدم. اختر دورًا بديلًا:`
                    : `${deletingRole.usersCount} user(s) hold this role. Pick a replacement:`}
                </p>
                <Select
                  value={replacementRoleId}
                  onChange={(e) => setReplacementRoleId(e.target.value)}
                  options={[
                    { value: '', label: ar ? '— اختر الدور البديل —' : '— Pick replacement role —' },
                    ...(roles ?? [])
                      .filter((r) => r.id !== deletingRole.id)
                      .map((r) => ({ value: r.id, label: r.name })),
                  ]}
                />
              </div>
            )}
            {deleteError && <p className="text-xs text-[var(--sys-destructive)]">{deleteError}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setDeletingRole(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
              <Button variant="danger" onClick={confirmDelete} loading={deleting}>{ar ? 'حذف نهائي' : 'Delete'}</Button>
            </div>
          </div>
        </Modal>

        {/* ── Duplicate modal ── */}
        <Modal
          isOpen={!!duplicatingRole}
          onClose={() => setDuplicatingRole(null)}
          title={ar ? 'نسخ الدور' : 'Duplicate Role'}
          maxWidth="sm"
        >
          <div className="space-y-4">
            <Input
              label={ar ? 'اسم الدور الجديد' : 'New role name'}
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
            />
            {duplicateError && <p className="text-xs text-[var(--sys-destructive)]">{duplicateError}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setDuplicatingRole(null)}>{ar ? 'إلغاء' : 'Cancel'}</Button>
              <Button onClick={confirmDuplicate} loading={duplicating}>{ar ? 'نسخ' : 'Duplicate'}</Button>
            </div>
          </div>
        </Modal>
      </div>
    </>
  );
}
