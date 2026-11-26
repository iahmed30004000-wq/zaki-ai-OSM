import React from 'react';
import { WA_CSS } from './wa-style';

/** The inbox's WhatsApp look, drawn by the screens that wear it (`wa-style.ts`). Nothing in the shared stylesheet. */
export function WaStyle() {
  return <style>{WA_CSS}</style>;
}
