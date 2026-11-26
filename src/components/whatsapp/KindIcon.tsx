'use client';

import React from 'react';
import {
  RiContactsLine,
  RiEmotionLine,
  RiFileTextLine,
  RiImageLine,
  RiMapPinLine,
  RiMicLine,
  RiReplyLine,
  RiStickyNoteLine,
  RiVideoLine,
} from '@remixicon/react';

/** The small picture before a conversation's last-message preview: a photo, a voice note, a file… Nothing for plain text. */
export function KindIcon({ type, className = 'w-4 h-4 shrink-0' }: { type: string | null | undefined; className?: string }) {
  switch (type) {
    case 'IMAGE':
      return <RiImageLine aria-hidden="true" className={className} />;
    case 'AUDIO':
      return <RiMicLine aria-hidden="true" className={className} />;
    case 'VIDEO':
      return <RiVideoLine aria-hidden="true" className={className} />;
    case 'DOCUMENT':
      return <RiFileTextLine aria-hidden="true" className={className} />;
    case 'STICKER':
      return <RiStickyNoteLine aria-hidden="true" className={className} />;
    case 'LOCATION':
      return <RiMapPinLine aria-hidden="true" className={className} />;
    case 'CONTACTS':
      return <RiContactsLine aria-hidden="true" className={className} />;
    case 'REACTION':
      return <RiEmotionLine aria-hidden="true" className={className} />;
    case 'INTERACTIVE':
    case 'BUTTON':
      return <RiReplyLine aria-hidden="true" className={className} />;
    default:
      return null;
  }
}
