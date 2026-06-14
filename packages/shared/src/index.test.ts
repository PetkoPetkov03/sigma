import { describe, expect, it } from 'vitest';
import { isNaturalPersonProfileName } from './index';

describe('shared utils', () => {
  it('exports the natural-person profile guard used by noindex checks', () => {
    expect(isNaturalPersonProfileName('  ет Example  ')).toBe(true);
  });
});
