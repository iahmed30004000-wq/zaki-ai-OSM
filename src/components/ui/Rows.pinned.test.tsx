// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { Rows, type Column } from './Rows';

/**
 * «بدي أثبّت هاد عشان أفهم» (the owner, 8/11) — the headings of a long list stay in view.
 *
 * `pinHeader` is opt-in: every screen that does not ask draws exactly what it drew before. Asked for, the desk's table becomes a
 * scroll area of its own and EVERY heading cell (the selection cell and the actions cell included) stays at its top; the
 * cards, which have no headings, are untouched.
 */
type Row = { id: string; name: string };
const columns: Column<Row>[] = [
  { key: 'id', label: 'الرقم', primary: true, render: (r) => r.id },
  { key: 'name', label: 'الاسم', render: (r) => r.name },
];
const rows: Row[] = [{ id: 'a', name: 'سلمى' }, { id: 'b', name: 'ريما' }];

afterEach(cleanup);

const heads = (c: HTMLElement) => Array.from(c.querySelectorAll('thead th'));

describe('pinHeader', () => {
  it('is off unless asked: no marker, and the headings carry nothing extra', () => {
    const plain = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} />);
    const before = plain.container.innerHTML;
    expect(plain.container.querySelector('[data-pinned]')).toBeNull();
    plain.unmount();
    const explicitlyOff = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} pinHeader={false} />);
    expect(explicitlyOff.container.innerHTML).toBe(before);
  });

  it('asked for, the table is marked pinned and every heading cell changes — and no row does', () => {
    const off = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} />);
    const offHeads = heads(off.container).map((th) => th.className);
    const offBody = off.container.querySelector('tbody')!.innerHTML;
    off.unmount();
    const on = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} pinHeader />);
    expect(on.container.querySelector('[data-pinned]')!.getAttribute('data-pinned')).toBe('true');
    const onHeads = heads(on.container);
    expect(onHeads).toHaveLength(offHeads.length);
    onHeads.forEach((th, i) => expect(th.className, th.textContent ?? '').not.toBe(offHeads[i]));
    expect(on.container.querySelector('tbody')!.innerHTML).toBe(offBody);
  });

  it('the selection cell and the actions cell are pinned with the rest', () => {
    const { container } = render(
      <Rows
        rows={rows}
        columns={columns}
        keyOf={(r) => r.id}
        pinHeader
        selection={{ canSelect: () => true, isSelected: () => false, onToggle: () => undefined }}
        actions={() => <span>x</span>}
      />
    );
    const all = heads(container);
    // selection + two columns + actions
    expect(all).toHaveLength(4);
    const classes = new Set(all.map((th) => th.className.split(' ').filter((c) => c.startsWith('sticky') || c.startsWith('z-')).join(' ')));
    expect(classes.size).toBe(1);
    expect([...classes][0]).not.toBe('');
  });

  it('draws the same cards with or without it', () => {
    const cards = (c: HTMLElement) => Array.from(c.querySelectorAll('ul li, [data-card]')).map((e) => e.innerHTML);
    const off = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} />);
    const a = cards(off.container);
    off.unmount();
    const on = render(<Rows rows={rows} columns={columns} keyOf={(r) => r.id} pinHeader />);
    expect(cards(on.container)).toEqual(a);
  });
});
