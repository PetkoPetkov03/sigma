import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('csvCell', () => {
  it('neutralizes formula-prefixed cells and forces quotes', () => {
    expect(csvCell('=1+1')).toBe('"\'=1+1"');
    expect(csvCell('+sum(A1:A2)')).toBe('"\'+sum(A1:A2)"');
    expect(csvCell('-10')).toBe('"\'-10"');
    expect(csvCell('@cmd')).toBe('"\'@cmd"');
    expect(csvCell('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvCell(' =cmd')).toBe('"\' =cmd"');
    expect(csvCell('  \t+cmd')).toBe('"\'  \t+cmd"');
    expect(csvCell('\u00A0=cmd')).toBe('"\'\u00A0=cmd"');
    expect(csvCell('\u2007+cmd')).toBe('"\'\u2007+cmd"');
    expect(csvCell('\uFEFF@cmd')).toBe('"\'\uFEFF@cmd"');
    expect(csvCell('\u0001=cmd')).toBe('"\'\u0001=cmd"');
  });

  it('quotes CR-containing cells', () => {
    expect(csvCell('first\rsecond')).toBe('"first\rsecond"');
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('neutralizes newline-leading cells', () => {
    expect(csvCell('\n=1+1')).toBe('"\'\n=1+1"');
    expect(csvCell('\nplain')).toBe('"\'\nplain"');
  });
});
