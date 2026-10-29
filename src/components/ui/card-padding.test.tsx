// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { CardContent } from './Card';

/**
 * A CARD THAT ASKS FOR NO PADDING GETS NONE.
 *
 * `CardContent` used to hand `p-6` AND the caller's `p-0` to the element, and in the built stylesheet the larger number
 * wins — so twenty-one table cards that asked for edge-to-edge got twenty-four pixels all round. The default now steps
 * aside when the caller states a padding of its own, and stays when it does not.
 */
afterEach(cleanup);

const classesOf = (className?: string) => {
  const { container } = render(<CardContent className={className}>x</CardContent>);
  return (container.firstElementChild as HTMLElement).className.split(/\s+/).filter(Boolean);
};

describe('CardContent padding', () => {
  it('keeps the default when the caller says nothing about padding', () => {
    expect(classesOf()).toEqual(['p-6']);
    expect(classesOf('space-y-4')).toEqual(['p-6', 'space-y-4']);
  });

  it('drops the default when the caller asks for none', () => {
    expect(classesOf('p-0')).toEqual(['p-0']);
    expect(classesOf('p-0 overflow-x-auto')).toEqual(['p-0', 'overflow-x-auto']);
  });

  it('drops the default for any padding the caller states, wherever it sits in the string', () => {
    expect(classesOf('p-4')).toEqual(['p-4']);
    expect(classesOf('space-y-3 p-5')).toEqual(['space-y-3', 'p-5']);
  });

  it('keeps the default beside a one-axis padding, which does not replace it', () => {
    expect(classesOf('py-12')).toEqual(['p-6', 'py-12']);
  });
});
