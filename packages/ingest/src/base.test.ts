import { describe, expect, it } from 'vitest';
import { BASE_CONTRACT_COLS, mapBaseRecord } from './base';

describe('base EOP mapper', () => {
  it('maps the full contract staging column set and keeps register numbers as text', () => {
    const row = mapBaseRecord(
      'contracts',
      {
        contractNumber: 'C-1',
        publicationDate: '2026-06-01T12:34:56Z',
        buyerRegistryNumber: '001234567',
        supplierRegisterNumber: '000987654',
        contractValue: '1 234,56',
        offersCount: '3',
      },
      { day: '2026-06-01', fetchedAt: '2026-06-07T00:00:00Z' },
    );

    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {})).toEqual(BASE_CONTRACT_COLS);
    expect(row?.source).toBe('eop:contracts:2026-06-01');
    expect(row?.published_at).toBe('2026-06-01');
    expect(row?.authority_eik).toBe('001234567');
    expect(row?.contractor_eik).toBe('000987654');
    expect(row?.signing_value).toBe(1234.56);
    expect(row?.bids_received).toBe(3);
  });

  it('applies tender-specific inverse and enum coercions', () => {
    const row = mapBaseRecord(
      'tenders',
      {
        publicationDate: '01.06.2026',
        hasUnsecuredFunding: 'да',
        hasVariants: 'Разрешено',
      },
      { day: '2026-06-01', fetchedAt: '2026-06-07T00:00:00Z' },
    );

    expect(row?.published_at).toBe('2026-06-01');
    expect(row?.secured_financing).toBe(0);
    expect(row?.variants).toBe(1);
  });
});
