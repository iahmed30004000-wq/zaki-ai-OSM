'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { Segmented } from '@/components/ui/Segmented';
import { EMOJI_GROUPS } from './emoji-data';

/**
 * THE COMPOSER'S EMOJI PANEL — six groups, one grid, no library. Loaded lazily the first time the face button is pressed
 * (`Composer` imports it with `React.lazy`), so the inbox's first load does not carry it.
 *
 * A press inserts the emoji at the caret and keeps the panel open (people often add two); Escape or a press outside closes it.
 */
export default function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [group, setGroup] = useState(EMOJI_GROUPS[0].key);
  const box = useRef<HTMLDivElement>(null);
  // The closer is read when the key or the press happens, not when the listeners are attached: the caller writes it in place,
  // so its identity is new on every render, and the listeners must not be torn down and attached again for that.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (box.current && t && !box.current.contains(t) && !t.closest('[data-emoji-toggle]')) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  const current = EMOJI_GROUPS.find((g) => g.key === group) ?? EMOJI_GROUPS[0];

  return (
    <div ref={box} className="absolute bottom-full mb-2 start-0 z-20 w-full max-w-sm">
      <Card className="p-2 shadow-overlay" padding="none">
        <Segmented
          size="sm"
          aria-label="مجموعات الإيموجي"
          options={EMOJI_GROUPS.map((g) => ({ value: g.key, label: g.emojis[0] }))}
          value={group}
          onChange={setGroup}
          className="w-full"
        />
        <p className="mt-2 px-1 text-note text-[var(--sys-muted-foreground)]">{current.label}</p>
        <div role="group" aria-label={current.label} className="mt-1 grid grid-cols-7 sm:grid-cols-8 gap-0.5 max-h-52 overflow-y-auto">
          {current.emojis.map((e) => (
            <IconButton key={e} size="sm" label={`إدراج ${e}`} onClick={() => onPick(e)}>
              <span className="text-xl leading-none">{e}</span>
            </IconButton>
          ))}
        </div>
      </Card>
    </div>
  );
}
