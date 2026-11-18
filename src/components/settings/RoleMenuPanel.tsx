'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Input';
import { THEME_CHOICES } from '@/lib/system-themes';
import { MenuOrderCard } from '@/components/settings/MenuOrderCard';

/**
 * «قائمة كل دور» — the role's three decisions, on the roles screen (18/11, R7).
 *
 * They used to sit inside «ترتيب القائمة» on everybody's profile page, behind a role picker only the owner saw. The
 * owner asked for that card to be drag and the eye, nothing else — so what it also did for a ROLE moved here, where
 * roles are managed, and nothing of it was dropped:
 *
 *   • the role's BASE MENU — the same card, in role mode (`forRole`): one editor, not a second copy of it;
 *   • the PHONE'S FOUR for the role — drawn by that card in role mode, saved by its one «احفظ»;
 *   • the LOOK the role opens on — `RoleOpeningTheme`, moved as it was.
 *
 * Drawn only for whoever the door says may set a role's base (`maySetRoleBase`, the flag the card read before): no new
 * check, and nobody else sees a role picker anywhere.
 */
export function RoleMenuPanel() {
  const [may, setMay] = useState(false);
  const [roles, setRoles] = useState<{ id: string; name: string }[] | null>(null);
  const [roleId, setRoleId] = useState('');

  useEffect(() => {
    let alive = true;
    // Awaited inside one try: a door that refuses, or answers nothing at all, draws nothing — the roles screen stays as it was.
    (async () => {
      try {
        const d = await apiJson<{ maySetRoleBase: boolean }>('/api/nav/arrangement');
        if (!alive || !d?.maySetRoleBase) return;
        setMay(true);
        const r = await apiJson<{ roles: { id: string; name: string }[] }>('/api/roles');
        if (alive) setRoles(r?.roles ?? []);
      } catch {
        /* nothing drawn */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!may) return null;

  return (
    <Card>
      <CardHeader
        title="قائمة كل دور"
        subtitle="اختر دور، ورتّب قائمته الأساسية وخانات الهاتف الأربعة والمظهر اللي بيفتح عليه."
      />
      <CardContent>
        {roles === null ? null : roles.length === 0 ? (
          <p className="text-note text-[var(--sys-muted-foreground)]">ما في أدوار بعد. اعمل دور أول، وبعدين رتّب قائمته من هون.</p>
        ) : (
          <div className="space-y-3">
            <Select id="role-menu-role" label="الدور" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">اختر دور</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            {roleId && (
              <>
                <p className="text-note text-[var(--sys-warning)]">
                  هذا أساس الدور — بيشوفه كلّ واحد فيه إلا إذا رتّب لحاله.
                </p>
                {/* Keyed by the role: a new role is a new card, read from the start — never the last role's rows under a new name. */}
                <MenuOrderCard key={roleId} forRole={roleId} />
                {/*
                  AND THE LOOK THE ROLE OPENS ON, IN THE SAME PLACE.

                  The menu base and the opening theme are the same kind of decision — what a new person in this role
                  finds on their first morning — set by the same permission. ⚠️ It is a BASE, not a cage, and the
                  sentence says so: the moment that person picks a look of their own, this stops being read for them.
                */}
                <RoleOpeningTheme key={roleId} roleId={roleId} />
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * THE LOOK A NEW PERSON IN THIS ROLE OPENS ON.
 *
 * «بلا» writes NULL and not the default's key — «nobody chose» and «somebody
 * chose the default» are different facts the day the default moves, and the
 * door refuses to collapse them.
 */
function RoleOpeningTheme({ roleId }: { roleId: string }) {
  const [theme, setTheme] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  // A new role is a new mount (`key` above): what the previous one was set to is never shown against the new name.

  const save = async (next: string) => {
    setTheme(next);
    setState('saving');
    try {
      await apiJson(`/api/roles/${roleId}/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="mt-3 border-t border-[var(--sys-border)] pt-2.5">
      <Select
        id="role-opening-theme"
        label="المظهر الذي يفتح عليه هذا الدور"
        value={theme}
        onChange={(e) => void save(e.target.value)}
      >
        <option value="">بلا — الافتراضي</option>
        {THEME_CHOICES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.ar}
          </option>
        ))}
      </Select>
      <p className="mt-1.5 text-note text-[var(--sys-muted-foreground)]">
        أساسٌ لا قيد: أوّلُ ما يختارُ الواحدُ مظهرَه، يُقرأُ اختيارُه هو ولا يُقرأُ هذا.
      </p>
      {state === 'saved' && <p className="mt-1 text-note text-[var(--sys-success)]">انحفظ.</p>}
      {state === 'failed' && (
        <p className="mt-1 text-note text-[var(--sys-destructive)]">تعذّر الحفظ — جرّب مرّة ثانية.</p>
      )}
    </div>
  );
}
