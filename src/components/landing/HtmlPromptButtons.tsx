'use client';

import React, { useState } from 'react';
import { Copy, Check, FileDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LANDING_HTML_PROMPT, promptAsWordDocument } from '@/lib/landing-html-prompt';
import { copyText } from '@/lib/clipboard';

/**
 * Hands the seller the brief to give an AI.
 *
 * Two buttons because there are two habits: paste it straight into a chat,
 * or keep the file and edit the product description in it each time. The
 * copy is the same text in both, from one source.
 */
export function HtmlPromptButtons({ prompt = LANDING_HTML_PROMPT }: { prompt?: string } = {}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (!(await copyText(prompt))) throw new Error('clipboard');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* a blocked clipboard is not worth an error dialog */
    }
  }

  function download() {
    const blob = new Blob(['﻿', promptAsWordDocument(prompt)], {
      type: 'application/msword;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'برومبت-صفحة-الهبوط.doc';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'تم النسخ' : 'انسخ البرومبت'}
      </Button>
      <Button variant="outline" size="sm" onClick={download}>
        <FileDown className="h-3.5 w-3.5" /> نزّله Word
      </Button>
    </div>
  );
}
