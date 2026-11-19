// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A GREY «اصرف» THAT SAYS NOTHING IS A SCREEN THAT LOOKS BROKEN.
 *
 * Five conditions switch the pay button off on the salary screen, and
 * exactly ONE of them was ever explained — «صُرف راتب هذه الفترة من قبل».
 * The other four were silent: no wallet picked, no exchange rate typed,
 * nothing left to pay, and a save already in flight.
 *
 * On a money screen that reads as the system refusing for a reason nobody
 * will tell you, and the next move is to press it again.
 *
 * The owner's rule: «اللي مطفي عن قصد بيضل مطفي، بس بيكتب السبب جنبه».
 *
 * The claims below are about the RULE rather than about the sentences:
 * every condition in the `disabled` attribute must appear in the reason,
 * and the reason must be absent when the button works. Written that way
 * because the real fault was the two drifting — four conditions and one
 * explanation — and a test that pinned today's four sentences would pass
 * again the day a fifth condition is added with no sentence.
 * ═══════════════════════════════════════════════════════════════════════
 */

afterEach(cleanup);

const SRC = 'src/components/screens/users/UserSalary.tsx';

describe('the reason stands beside the button', () => {
  it('and covers every condition that switches it off', () => {
    const src = stripComments(repoFile(SRC));

    // The conditions, read out of the attribute itself.
    // 19/11 (R16b2): the anchor was `onClick={pay}`; «اصرف» is the kit's Button now and its press is
    // `onClick={() => { void pay(); }}` (the screen keeps its own busy flag), so the anchor is `void pay()`.
    // The `disabled` attribute it reads is the same line, unchanged.
    expect(src.indexOf('void pay()'), 'ما لقيت ضغطة «اصرف»').toBeGreaterThan(600);
    const attr = /disabled=\{([^}]*)\}/.exec(src.slice(src.indexOf('void pay()') - 600));
    expect(attr, 'ما لقيت شرط التعطيل').not.toBeNull();
    const conditions = attr![1]
      .split('||')
      .map((c) => c.trim())
      .filter((c) => c !== 'busy'); // a save in flight is a spinner, not a refusal

    // Whatever the reason is computed from, it must mention them all.
    const reason = src.slice(src.indexOf('const offReason'), src.indexOf('const offReason') + 900);
    for (const c of conditions) {
      const key = c.replace(/^!+/, '').replace(/^\(|\)$/g, '').split(/[\s<>=]/)[0];
      expect(reason, `شرط بيطفي الزرّ وما إله سبب: ${c}`).toContain(key);
    }
  });

  it('and is drawn, not only computed', () => {
    const src = stripComments(repoFile(SRC));
    expect(src, 'السبب محسوب وما حدا بيرسمه').toMatch(/\{offReason &&/);
  });

  it('and is absent when the button works', () => {
    // A reason under a working button is its own confusion.
    const src = stripComments(repoFile(SRC));
    const reason = src.slice(src.indexOf('const offReason'));
    expect(reason.slice(0, 900), 'ما في حالة «الزرّ شغّال»').toMatch(/:\s*null/);
  });
});

describe('and the sentences say what to do', () => {
  /**
   * Not «مرفوض» four times. Each one names the next move, because the
   * person reading it is holding a mouse and wants to finish paying
   * somebody.
   */
  it('each reason is an instruction or a fact, never a refusal with no exit', () => {
    const src = repoFile(SRC);
    const reason = src.slice(src.indexOf('const offReason'), src.indexOf('const offReason') + 1200);
    const sentences = [...reason.matchAll(/'([^']{10,})'/g)].map((m) => m[1]);
    expect(sentences.length, 'ما لقيت جمل السبب').toBeGreaterThanOrEqual(3);
    for (const s of sentences) {
      expect(s, `جملة ما بتقول شو يعمل: ${s}`).not.toMatch(/^(مرفوض|غير مسموح|ممنوع)\.?$/);
    }
  });
});

describe('and a disabled control that cannot work at all is not drawn', () => {
  it('— the rule this product already follows elsewhere', () => {
    /*
     * The other half of the owner's instruction, and it is already true in
     * two places: the order window draws no arrows when there are no
     * neighbour ids, and the contact strip draws no SMS button on a desk
     * (it writes the reason in its place). Named here so the two rules are
     * read together: a control that can work once a condition is met stays
     * and says why; a control that can NEVER work here is not drawn.
     */
    expect(
      stripComments(repoFile('src/components/orders/ContactButtons.tsx')),
      'زرّ SMS رجع مرسوماً ومعطّلاً على الحاسوب'
    ).not.toMatch(/disabled=\{!onPhone\}/);
  });
});
