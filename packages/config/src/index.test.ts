import { describe, expect, it } from 'vitest';
import {
  CPV_CATEGORIES,
  CPV_SECTORS,
  DEFAULT_RISK_WEIGHTS,
  categoryForDivision,
  procedureGroup,
  requireEnv,
  sectorForCpv,
} from './index';

describe('risk weights', () => {
  it('sum to exactly one scoring budget', () => {
    const total = Object.values(DEFAULT_RISK_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBe(1);
  });
});

describe('sectorForCpv', () => {
  it('maps a known CPV division to its sector', () => {
    expect(sectorForCpv('15800000')).toMatchObject({
      code: '15',
      short: 'Храни',
      curated: true,
    });
  });

  it('extracts the 2-digit division from a full CPV code', () => {
    expect(sectorForCpv('45233120-6')?.code).toBe('45');
  });

  it('returns null for missing or unknown CPV divisions', () => {
    expect(sectorForCpv(null)).toBeNull();
    expect(sectorForCpv('99000000')).toBeNull();
  });
});

describe('CPV_CATEGORIES', () => {
  it('partitions exactly the configured CPV sector divisions', () => {
    const sectorCodes = CPV_SECTORS.map((sector) => sector.code).sort();
    const categoryCodes = CPV_CATEGORIES.flatMap((category) => category.divisions);

    expect(categoryCodes).toHaveLength(45);
    expect(new Set(categoryCodes).size).toBe(45);
    expect([...categoryCodes].sort()).toEqual(sectorCodes);
  });

  it('does not assign a division to more than one category', () => {
    const counts = new Map<string, number>();

    for (const division of CPV_CATEGORIES.flatMap((category) => category.divisions)) {
      counts.set(division, (counts.get(division) ?? 0) + 1);
    }

    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([division]) => division);

    expect(duplicates).toEqual([]);
  });

  it('maps a CPV division/full code to its curated category', () => {
    expect(categoryForDivision('45233120-6')?.key).toBe('construction');
    expect(categoryForDivision('15800000')?.key).toBe('food-agri');
    expect(categoryForDivision(null)).toBeNull();
    expect(categoryForDivision('99000000')).toBeNull();
  });
});

describe('procedureGroup', () => {
  it('maps a known procedure type to its display group', () => {
    expect(procedureGroup('Пряко договаряне')).toMatchObject({
      key: 'direct',
      competitive: false,
      label: 'Пряко / без обявление',
    });
  });

  it('falls back to the unknown bucket for unrecognised procedure types', () => {
    expect(procedureGroup('несъществуваща процедура')).toMatchObject({
      key: 'unknown',
      competitive: null,
      label: 'Неизвестна',
    });
  });
});

describe('requireEnv', () => {
  it('returns a present string value', () => {
    expect(requireEnv({ SIGMA_API_URL: 'https://example.test' }, 'SIGMA_API_URL')).toBe(
      'https://example.test',
    );
  });

  it('throws when the variable is missing', () => {
    expect(() => requireEnv({}, 'SIGMA_API_URL')).toThrow(
      'Missing required environment variable: SIGMA_API_URL',
    );
  });
});
