'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Input';
import { ALL_ROUTES, NAV, isMenuLine } from '@/lib/route-registry';
import {
  applyArrangement,
  chooseSlot,
  EMPTY_LAYOUT,
  groupsAfterDrag,
  orderAfterDrag,
  reorderSlots,
  type NavLayout,
} from '@/lib/nav-arrangement';
import { mobileNav } from '@/lib/mobile-nav';
import type { NavGroup, RouteDef } from '@/lib/route-registry';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiDraggable,
  RiEyeLine,
  RiEyeOffLine,
  RiLoader4Line,
} from '@remixicon/react';

/**
 * «ترتيب القائمة» — the menu, arranged by the person who reads it.
 *
 * The owner, 15/10: «ما بقدر أتحكم بالقوائم والنوافذ». He sets the base per
 * role; each person adjusts on top of it; «رجّع الأساس» brings the base
 * back.
 *
 * ── DRAG AND THE EYE, NOTHING ELSE (18/11, R7) ──
 *
 * The owner, 17/11: the card was too much — pins, arrows, a role picker, a
 * theme and the phone's four in one place. What a person does here now is two
 * things: DRAG (a group by its heading's grip, a screen by its own) and the EYE
 * (show or hide a screen). Nothing else is on a row.
 *
 *   • THE ARROWS LEFT, THE KEYBOARD PATH DID NOT. The engine is `@dnd-kit`,
 *     whose keyboard sensor is the documented way for someone without a mouse:
 *     Space on the grip to pick a row up, the arrows to move it, Space to put it
 *     down, Esc to cancel — announced in Arabic for a screen reader. A drag by
 *     pointer and a drag by keyboard end in the SAME function (`orderAfterDrag`
 *     for a screen, `groupsAfterDrag` for a group), so they cannot disagree.
 *   • THE DRAG STARTS ONLY FROM A GRIP, and the grip alone has
 *     `touch-action: none`: a thumb on the rest of the row scrolls the page.
 *   • PINS ARE FOLDED, NOT DROPPED. A layout saved with `pinned` still draws
 *     its pinned screens first (the server keeps reading it). The rows below
 *     are already drawn that way, so a save posts their draw order as `order`
 *     and no pins — the same menu, with one list fewer. EXCEPT where an empty
 *     list would let the ROLE'S pins answer instead (`resolveLayout` reads an
 *     empty own list as «no opinion»): see `bodyToSave`.
 *
 * ── THE ROLE'S BASE IS SET FROM THE ROLES SCREEN ──
 *
 * `forRole` is the same card for a role's base (`RoleMenuPanel`, on
 * `/admin/permissions`): one editor, two owners of the row it writes. Only
 * there are the phone's four drawn (`slots`): the owner picks them per role.
 * A person's own saved four keep working — their save posts them back as they
 * stand — they are just no longer edited by the person.
 *
 * ── AND ARRANGING OPENS NOTHING ──
 *
 * The list below is the viewer's OWN menu, as the server built it. Hiding
 * removes a row from a list; the door is still checked when it is opened,
 * and a hidden screen reached by its URL is refused exactly as before.
 */
/** Every screen's name, by path — what the announcements say instead of an address. */
const ALL_LABELS = new Map(ALL_ROUTES.map((r) => [r.path, r.label]));
/** Every group's name, by key — for the same announcements, one level up. */
const GROUP_LABELS = new Map(NAV.map((g) => [g.key, g.label]));
/** Does a stored list hold an opinion? An empty one is none — the rule `resolveLayout` applies. */
const said = (list?: string[]) => !!list && list.length > 0;
/** What is on screen that is the role's base showing through: the resolved layout says it and the person's own does not. */
const inheritedOf = (d: { resolved: NavLayout; own?: NavLayout | null }) => ({
  groups: !said(d.own?.groups) && said(d.resolved.groups),
  slots: !said(d.own?.slots) && said(d.resolved.slots),
});
/**
 * WHAT «احفظ» POSTS — pure, so it can be held against the server's own `resolveLayout` for every shape of row.
 *
 * `order` is `flat`, the rows' draw order (pins already first in their group). `pinned` is FOLDED into it — posted
 * empty — with one exception (18/11, review of R7): an empty own list is «no opinion» to `resolveLayout`, so when the
 * person's OWN pins are what is drawn and the role's base ALSO has pins, an empty list would hand the drawing back to
 * the base's pins and a screen would jump. Then the own pins are kept as they are, and the menu stays the one drawn.
 * When the person has no pins of their own, the base's pins are what is drawn, and «no opinion» keeps exactly them.
 */
export function bodyToSave(
  layout: NavLayout,
  flat: string[],
  inherited: { groups: boolean; slots: boolean },
  keepOwnPins: boolean
): NavLayout {
  return {
    ...layout,
    order: flat,
    pinned: keepOwnPins ? layout.pinned : [],
    groups: inherited.groups ? [] : (layout.groups ?? []),
    slots: inherited.slots ? [] : (layout.slots ?? []),
  };
}
/** Own pins AND base pins: the one case where folding would let the base's pins surface — see `bodyToSave`. */
const ownPinsOverBase = (d: { own?: NavLayout | null; base?: NavLayout | null }) => said(d.own?.pinned) && said(d.base?.pinned);

/** «الأولى» is the one on the right: the bar is drawn right to left. */
const ORDINALS = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة'];

/**
 * `forRole` empty = the person's own menu (the profile page). A role id = that role's base, as the owner sets it
 * from the roles screen — remount with `key` when it changes.
 */
export function MenuOrderCard({ forRole = '' }: { forRole?: string } = {}) {
  const [layout, setLayout] = useState<NavLayout>(EMPTY_LAYOUT);
  const [paths, setPaths] = useState<string[]>([]);
  const [hasOwn, setHasOwn] = useState(false);
  /**
   * Which of the two newer opinions on screen are the ROLE'S BASE showing through and not the person's own.
   * A save posts those as «no opinion of mine» (an empty list), so pressing save for some other reason
   * does not copy the owner's choice into the person's own row and detach them from it for good.
   */
  const [inherited, setInherited] = useState({ groups: false, slots: false });
  /** The person's own pins sit over a base that has pins too — they are posted as they are (`bodyToSave`). */
  const [keepOwnPins, setKeepOwnPins] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await apiJson<{ resolved: NavLayout; own: NavLayout | null; base?: NavLayout | null; paths: string[] }>(
        '/api/nav/arrangement'
      );
      if (!alive) return;
      setPaths(d.paths);
      if (!forRole) {
        setLayout(d.resolved);
        setHasOwn(d.own !== null);
        setInherited(inheritedOf(d));
        setKeepOwnPins(ownPinsOverBase(d));
        return;
      }
      // The role's base, over the menu of the one arranging it — the screens the owner may open.
      const r = await apiJson<{ layout: NavLayout }>(`/api/nav/arrangement?roleId=${forRole}`, { method: 'POST' });
      if (!alive) return;
      setLayout(r.layout);
      // What is on screen IS the base — it is being edited, not showing through.
      setInherited({ groups: false, slots: false });
      /*
       * 18/11 (R7 review): a role's base KEEPS its pins on a save. Its members who have a row of their own with no pins
       * of their own draw the base's pins (`resolveLayout`); folding them away here would reorder those members' menus
       * the moment the owner pressed «احفظ», even with nothing changed.
       */
      setKeepOwnPins(true);
    })()
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'تعذّر القراءة'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [forRole]);

  /** The groups as the menu draws them now — the same function the server uses. */
  const mine = NAV.map((g) => ({ ...g, routes: g.routes.filter((r) => paths.includes(r.path)) })).filter(
    (g) => g.routes.length > 0
  );
  /*
   * Shown WITH the hidden rows, because this is the screen where they are
   * brought back: `applyArrangement` would drop them, and a hidden item
   * nobody can see is a hidden item nobody can unhide. Stored pins still
   * count here — so the rows stand where the menu draws them.
   */
  const ordered = applyArrangement(
    mine,
    { ...layout, hidden: [] }
  );

  const isHidden = (path: string) => layout.hidden.includes(path);

  /** Every path in draw order, which is what `order` stores — the pins already folded into it. */
  const flat = ordered.flatMap((g) => g.routes.map((r) => r.path));
  /** The groups' keys in draw order, which is what `groups` stores. */
  const groupKeys = ordered.map((g) => g.key);

  /*
   * THE PHONE'S FOUR — computed by the bar's own function, over the groups the shell would hand it.
   *
   * What the drawer draws as a line is `mine` less the screens that are not lines (`isMenuLine`), arranged
   * with the hidden ones taken OUT — the shell's `applyArrangement(menuNav(…))`. `mobileNav` then picks the
   * four exactly as the bar does (the stored choice first, the ranking for what is left). Drawn for a role's
   * base only.
   */
  const openable = new Set(paths);
  const barGroups = applyArrangement(
    mine
      .map((g) => ({ ...g, routes: g.routes.filter((r) => isMenuLine(r, openable)) }))
      .filter((g) => g.routes.length > 0),
    layout
  );
  const shownSlots = mobileNav(barGroups, null, layout.slots).primary.map((r) => r.path);

  /** A finished drag of a screen — pointer or keyboard, the same function. */
  function dropped(groupPaths: string[], end: DragEndEvent) {
    const next = orderAfterDrag(flat, groupPaths, end);
    if (next) setLayout({ ...layout, order: next });
  }

  /** The groups' new order. A move that changes nothing is not an opinion, and is not stored as one. */
  function setGroups(next: string[]) {
    if (next.every((key, i) => key === groupKeys[i])) return;
    setLayout({ ...layout, groups: next });
    setInherited({ ...inherited, groups: false });
  }

  /** A finished drag of a group — pointer or keyboard, the same function. */
  function droppedGroup(end: DragEndEvent) {
    const next = groupsAfterDrag(groupKeys, end);
    if (next) setGroups(next);
  }

  /**
   * The phone's four after the owner changed one of them — stored as the four the rows SHOW, whole.
   * Until then nothing is stored (the system's ranking answers), so a ranking improved next month still
   * reaches whoever never chose; and a change that leaves the four as they were stores nothing either.
   */
  function setSlots(next: string[]) {
    if (next.every((path, i) => path === shownSlots[i])) return;
    setLayout({ ...layout, slots: next });
    setInherited({ ...inherited, slots: false });
  }

  /** Whose four these are — said under the rows, so «ترتيب النظام» is never shown over the owner's choice. */
  const slotNote = said(layout.slots)
    ? 'هاي خانات أساس الدور — بيشوفها كل واحد فيه إلا إذا اختار لحاله.'
    : 'ترتيب النظام. غيّر أي خانة وبتصير أساس هالدور.';

  // One set of sensors for the whole card. Six pixels before a press becomes a
  // drag, so a tap on the handle (or a shaky one) is not a move; and the
  // keyboard sensor walks the rows by their own order.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const toggleHidden = (path: string) =>
    setLayout({
      ...layout,
      hidden: layout.hidden.includes(path) ? layout.hidden.filter((p) => p !== path) : [...layout.hidden, path],
    });

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      /*
       * `groups` and `slots` are ALWAYS posted. An empty list is how this client says «no opinion of mine»
       * — which is also what a value that is only the role's base showing through is posted as — and the
       * door keeps what it holds only for a post that left the key out altogether (a tab older than this).
       *
       * `pinned` is FOLDED into `order` — see `bodyToSave` for the one case it is kept.
       */
      const body = bodyToSave(layout, flat, inherited, keepOwnPins);
      await apiJson(`/api/nav/arrangement${forRole ? `?roleId=${forRole}` : ''}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // The pins stay in what is on screen: they are what the menu draws (the base's, or the person's own).
      setLayout({ ...layout, order: flat });
      setNotice(
        forRole
          ? 'انحفظ أساس الدور. كلّ واحد فيه بيشوفه إلا إذا رتّب لحاله.'
          : 'انحفظ ترتيبك. حدّث الصفحة لتشوف القائمة بترتيبها الجديد.'
      );
      if (!forRole) setHasOwn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await apiJson<{ resolved: NavLayout; base?: NavLayout | null }>('/api/nav/arrangement', { method: 'DELETE' });
      setLayout(d.resolved);
      setHasOwn(false);
      // The person's own row is gone: whatever the groups and the four are now is the role's base, or the system's.
      setInherited(inheritedOf({ resolved: d.resolved }));
      setKeepOwnPins(false);
      setNotice('رجع الأساس. القائمة صارت زي ما ضبطها المالك لدورك.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الإرجاع');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-center text-[var(--sys-muted)]">
        <RiLoader4Line className="w-4 h-4 animate-spin inline-block" />
      </div>
    );
  }

  return (
    // `id` is where the sidebar's «رتّب القائمة» link lands (`/admin/profile#menu-order`).
    <div dir="rtl" id="menu-order" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-black text-[var(--sys-foreground)]">ترتيب القائمة</h3>
          {/* The two things a row does, how to do them without a mouse, and the one thing hiding never does. */}
          <p className="mt-0.5 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
            اسحب من المقبض لترتّب المجموعات والشاشات، أو بالكيبورد: مسافة، ثم الأسهم، ثم مسافة. العين بتخفي الشاشة أو بترجّعها. الإخفاء لا يفتح ولا يغلق أي صلاحية.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasOwn && !forRole && (
            <Button size="sm" variant="outline" onClick={reset} disabled={busy}>
              رجّع الأساس
            </Button>
          )}
          <Button size="sm" onClick={save} loading={busy}>
            احفظ
          </Button>
        </div>
      </div>

      {notice && (
        <p className="text-note text-[var(--sys-success)] bg-[var(--sys-success-soft)] border border-[var(--sys-border)] rounded-lg px-2.5 py-1.5">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-note text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}

      {/*
        THE PHONE'S FOUR — a role's base only, and first, because it is four rows and the groups below are a long page.

        Each row is a real select of the screens the OTHER rows do not hold (so one screen can never sit in two slots),
        with two arrows from the kit. The rows are what `mobileNav` returns for this menu — see above.
      */}
      {forRole && shownSlots.length > 0 && (
        <Card>
          <CardHeader
            title="خانات الهاتف الأربعة — اللي بتظهر تحت الشاشة"
            subtitle="الأولى على اليمين. اختر شاشة لكل خانة، ورتّبهن بالسهمين."
          />
          <CardContent>
            <div className="divide-y divide-[var(--sys-border)]">
              {shownSlots.map((path, i) => {
                const name = `الخانة ${ORDINALS[i] ?? i + 1}`;
                return (
                  // Keyed by its PLACE, not by its screen: a select that is remounted each time its value changes
                  // loses the keyboard focus after one arrow press.
                  <div key={`slot-${i}`} className="flex items-center gap-2 py-2">
                    <span className="w-5 shrink-0 text-center text-note tabular-nums text-[var(--sys-muted)]">{i + 1}</span>
                    <Select
                      aria-label={name}
                      value={path}
                      onChange={(e) => setSlots(chooseSlot(shownSlots, i, e.target.value))}
                    >
                      {barGroups.map((g) => {
                        // The screens the other rows hold are not offered: this row's own, and the ones nobody has.
                        const free = g.routes.filter((r) => r.path === path || !shownSlots.includes(r.path));
                        return free.length === 0 ? null : (
                          <optgroup key={g.key} label={g.label}>
                            {free.map((r) => (
                              <option key={r.path} value={r.path}>
                                {r.label}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </Select>
                    <IconButton
                      size="sm"
                      label={`ارفع ${name}`}
                      onClick={() => setSlots(reorderSlots(shownSlots, i, i - 1))}
                      disabled={i === 0}
                    >
                      <RiArrowUpSLine className="w-4 h-4" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={`انزل ${name}`}
                      onClick={() => setSlots(reorderSlots(shownSlots, i, i + 1))}
                      disabled={i === shownSlots.length - 1}
                    >
                      <RiArrowDownSLine className="w-4 h-4" />
                    </IconButton>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-note leading-relaxed text-[var(--sys-muted-foreground)]">{slotNote}</p>
            <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
              لما تفتح شاشة مش من الأربعة، بتاخد الخانة الأخيرة وإنت فيها.
            </p>
          </CardContent>
        </Card>
      )}

      {/*
        THE GROUPS — a second drag context around the first kind, one level up.

        Each group is one item of a vertical sortable list; its heading carries the grip. The lines inside it keep
        their own context below, so a drag of a line never reaches this one (and the other way round): the grips are
        the only things that start either, and each starts only its own.
      */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={droppedGroup}
        accessibility={{ announcements: GROUP_ANNOUNCEMENTS, screenReaderInstructions: GROUP_INSTRUCTIONS }}
      >
        <SortableContext items={groupKeys} strategy={verticalListSortingStrategy}>
          <div className="space-y-3">
            {ordered.map((group) => {
              const groupPaths = group.routes.map((r) => r.path);
              return (
                <SortableGroup key={group.key} group={group}>
                  {/*
                    ONE DROP ZONE PER GROUP.

                    A screen does not change what it is about by being dragged
                    under another heading, so each group is its own context: a
                    row can be dropped among its own group and nowhere else, and
                    `orderAfterDrag` refuses the rest again regardless. The
                    vertical axis is locked and the row is kept inside the list,
                    so a hand that drifts sideways does not lose the row.
                  */}
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                    onDragEnd={(end) => dropped(groupPaths, end)}
                    accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: INSTRUCTIONS }}
                  >
                    <SortableContext items={groupPaths} strategy={verticalListSortingStrategy}>
                      <ul className="divide-y divide-[var(--sys-border)]">
                        {group.routes.map((route) => (
                          <SortableRow
                            key={route.path}
                            route={route}
                            hidden={isHidden(route.path)}
                            onToggle={() => toggleHidden(route.path)}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                </SortableGroup>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** What a screen reader hears, in the user's own language and the screen's own names. */
const labelOf = (id: string | number) => ALL_LABELS.get(String(id)) ?? String(id);
const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `أمسكتَ «${labelOf(active.id)}».`,
  onDragOver: ({ active, over }) =>
    over && over.id !== active.id ? `«${labelOf(active.id)}» فوق «${labelOf(over.id)}».` : undefined,
  onDragEnd: ({ active, over }) =>
    over && over.id !== active.id
      ? `أُفلتت «${labelOf(active.id)}» مكان «${labelOf(over.id)}».`
      : `أُفلتت «${labelOf(active.id)}» في مكانها.`,
  onDragCancel: ({ active }) => `أُلغي تحريك «${labelOf(active.id)}».`,
};
const INSTRUCTIONS = {
  draggable:
    'لتغيير ترتيب هذه الشاشة: اضغط مسافة لتمسكها، ثم السهم لأعلى أو لأسفل، ثم مسافة لتفلتها. اضغط Esc للإلغاء.',
};

/** The same, one level up: a group is named «مجموعة …», so it is never mistaken for a screen of the same name («الإعدادات»). */
const groupLabelOf = (id: string | number) => GROUP_LABELS.get(String(id)) ?? String(id);
const GROUP_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `أمسكتَ مجموعة «${groupLabelOf(active.id)}».`,
  onDragOver: ({ active, over }) =>
    over && over.id !== active.id
      ? `مجموعة «${groupLabelOf(active.id)}» فوق مجموعة «${groupLabelOf(over.id)}».`
      : undefined,
  onDragEnd: ({ active, over }) =>
    over && over.id !== active.id
      ? `أُفلتت مجموعة «${groupLabelOf(active.id)}» مكان مجموعة «${groupLabelOf(over.id)}».`
      : `أُفلتت مجموعة «${groupLabelOf(active.id)}» في مكانها.`,
  onDragCancel: ({ active }) => `أُلغي تحريك مجموعة «${groupLabelOf(active.id)}».`,
};
const GROUP_INSTRUCTIONS = {
  draggable:
    'لتغيير ترتيب هذه المجموعة: اضغط مسافة لتمسكها، ثم السهم لأعلى أو لأسفل، ثم مسافة لتفلتها. اضغط Esc للإلغاء.',
};

/**
 * ONE GROUP: ITS GRIP AND ITS NAME ON THE HEADING, AND ITS LINES BELOW.
 *
 * The same promise a row makes, one level up. The grip is the ONLY thing that starts the drag (the sortable's
 * listeners are on it and nowhere else) and it alone carries `touch-action: none`, so a thumb on the heading's name,
 * on a line, or on the gap between groups scrolls the page exactly as it did before there was a grip.
 *
 * The heading is built here and not by `CardHeader`: the grip has to come FIRST, before the name, as a row's does.
 * Its classes are the card header's own.
 *
 * The lift while it is carried is inline, like a row's — the stylesheet is capped to the byte.
 */
function SortableGroup({ group, children }: { group: NavGroup; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: group.key,
    // Said in Arabic, like a row's: the library's own word is English.
    attributes: { roleDescription: 'مقبض ترتيب' },
  });

  return (
    <div
      ref={setNodeRef}
      // Not a style hook: it names the group this block is, for whatever has to find it by what it IS and not by where it sits.
      data-menu-group={group.key}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging
          ? { position: 'relative', zIndex: 1, opacity: 0.85, borderRadius: '0.5rem', boxShadow: 'var(--sys-shadow-overlay)' }
          : null),
      }}
    >
      <Card>
        <div className="flex items-center gap-2 px-6 py-4 border-b border-[var(--sys-border)]">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`اسحب مجموعة ${group.label} لتغيير ترتيبها`}
            title="اسحب لتغيير ترتيب المجموعة"
            // The grip, and only the grip, refuses the browser's own scroll gesture.
            style={{ touchAction: 'none', cursor: isDragging ? 'grabbing' : 'grab' }}
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
          >
            <RiDraggable className="w-4 h-4" />
          </button>
          <h3 className="flex-1 text-base font-semibold text-[var(--sys-heading)]">{group.label}</h3>
        </div>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

/**
 * ONE ROW: ITS GRIP, ITS NAME, AND ITS EYE.
 *
 * The grip is the ONLY thing that starts a drag (`useSortable`'s listeners
 * are on it and nowhere else), and it alone carries `touch-action: none`.
 * That is the whole answer to «a drag inside a scrolling column fights the
 * scroll»: a thumb on the name, the eye, or the gap between rows scrolls
 * the page exactly as it did before there was a grip.
 *
 * The grip stays a hand-written button: the drag library needs its node, and
 * the kit's button does not hand one out. The eye is the kit's.
 *
 * The row's own look while it is carried is INLINE — a lifted shadow, a
 * little transparency, above its neighbours — because the stylesheet is capped
 * to the byte and a drag state is not worth a utility class nothing else uses.
 */
function SortableRow({ route, hidden, onToggle }: { route: RouteDef; hidden: boolean; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: route.path,
    // The library announces the grip as «sortable» unless told otherwise — one
    // English word in the middle of an Arabic sentence for a screen reader.
    attributes: { roleDescription: 'مقبض ترتيب' },
  });

  return (
    <li
      ref={setNodeRef}
      className="flex items-center gap-2 py-2"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging
          ? { position: 'relative', zIndex: 1, opacity: 0.85, background: 'var(--sys-card)', boxShadow: 'var(--sys-shadow-overlay)' }
          : null),
      }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`اسحب ${route.label} لتغيير ترتيبه`}
        title="اسحب لتغيير الترتيب"
        // The grip, and only the grip, refuses the browser's own scroll
        // gesture: this is what keeps the rest of the row scrollable.
        style={{ touchAction: 'none', cursor: isDragging ? 'grabbing' : 'grab' }}
        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-primary)]"
      >
        <RiDraggable className="w-4 h-4" />
      </button>
      <span
        className={
          hidden
            ? 'flex-1 text-sm text-[var(--sys-muted)] line-through'
            : 'flex-1 text-sm text-[var(--sys-heading)]'
        }
      >
        {route.label}
      </span>
      <IconButton size="sm" label={`${hidden ? 'أظهر' : 'اخفِ'} ${route.label}`} onClick={onToggle}>
        {hidden ? <RiEyeOffLine className="w-4 h-4" /> : <RiEyeLine className="w-4 h-4" />}
      </IconButton>
    </li>
  );
}
