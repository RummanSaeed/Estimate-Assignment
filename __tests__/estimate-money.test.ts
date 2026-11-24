import { describe, it, expect } from 'vitest';
import {
  majorToMinor,
  minorToMajor,
  computeLineTotalMinor,
  computeEstimateTotals,
  formatMinor,
  normalizeIdempotencyKey,
} from '@/lib/estimate-money';

describe('majorToMinor', () => {
  it('converts whole amounts', () => {
    expect(majorToMinor(10)).toBe(1000);
    expect(majorToMinor(0)).toBe(0);
  });

  it('handles float noise correctly', () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE754
    expect(majorToMinor(19.99)).toBe(1999);
    // 1.005 * 100 === 100.49999999999999 in IEEE754 → rounds down to 100
    expect(majorToMinor(1.005)).toBe(100);
  });

  it('rejects invalid input', () => {
    expect(majorToMinor(-1)).toBeNull();
    expect(majorToMinor(NaN)).toBeNull();
    expect(majorToMinor(Infinity)).toBeNull();
    expect(majorToMinor(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('minorToMajor', () => {
  it('converts back', () => {
    expect(minorToMajor(1999)).toBeCloseTo(19.99);
    expect(minorToMajor(0)).toBe(0);
  });
});

describe('computeLineTotalMinor', () => {
  it('computes integer line totals', () => {
    expect(computeLineTotalMinor(2, 5000)).toBe(10000); // 2 × $50.00
    expect(computeLineTotalMinor(1, 1999)).toBe(1999);
  });

  it('handles fractional quantities (3 decimals)', () => {
    // 1.5 × $10.00 = $15.00
    expect(computeLineTotalMinor(1.5, 1000)).toBe(1500);
    // 0.333 × $10.00 = $3.33
    expect(computeLineTotalMinor(0.333, 1000)).toBe(333);
    // 2.5 × $19.99 = $49.975 → rounds half-up to $49.98
    expect(computeLineTotalMinor(2.5, 1999)).toBe(4998);
  });

  it('rejects invalid input', () => {
    expect(() => computeLineTotalMinor(0, 100)).toThrow();
    expect(() => computeLineTotalMinor(-1, 100)).toThrow();
    expect(() => computeLineTotalMinor(1, -5)).toThrow();
    expect(() => computeLineTotalMinor(1, 1.5)).toThrow(); // non-integer minor units
  });
});

describe('computeEstimateTotals', () => {
  it('computes subtotal, tax, and total', () => {
    const totals = computeEstimateTotals({
      lineItems: [
        { quantity: 2, unitPriceMinor: 5000 }, // $100.00
        { quantity: 1, unitPriceMinor: 2500 }, // $25.00
      ],
      taxRateBps: 1000, // 10%
    });
    expect(totals.subtotalMinor).toBe(12500);
    expect(totals.taxMinor).toBe(1250);
    expect(totals.totalMinor).toBe(13750);
  });

  it('handles zero tax', () => {
    const totals = computeEstimateTotals({
      lineItems: [{ quantity: 1, unitPriceMinor: 1000 }],
      taxRateBps: 0,
    });
    expect(totals.taxMinor).toBe(0);
    expect(totals.totalMinor).toBe(1000);
  });

  it('rounds tax half-up with integer math', () => {
    // subtotal 333 minor units, 10% → 33.3 → 33
    const totals = computeEstimateTotals({
      lineItems: [{ quantity: 1, unitPriceMinor: 333 }],
      taxRateBps: 1000,
    });
    expect(totals.taxMinor).toBe(33);
  });

  it('rejects invalid tax rates', () => {
    expect(() =>
      computeEstimateTotals({
        lineItems: [{ quantity: 1, unitPriceMinor: 100 }],
        taxRateBps: -1,
      }),
    ).toThrow();
    expect(() =>
      computeEstimateTotals({
        lineItems: [{ quantity: 1, unitPriceMinor: 100 }],
        taxRateBps: 10001,
      }),
    ).toThrow();
    expect(() =>
      computeEstimateTotals({
        lineItems: [{ quantity: 1, unitPriceMinor: 100 }],
        taxRateBps: 12.5,
      }),
    ).toThrow();
  });
});

describe('formatMinor', () => {
  it('formats currency', () => {
    expect(formatMinor(1999, 'USD')).toContain('19.99');
    expect(formatMinor(0, 'USD')).toContain('0.00');
  });
});

describe('normalizeIdempotencyKey', () => {
  it('returns null for absent/empty', () => {
    expect(normalizeIdempotencyKey(null)).toBeNull();
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey('   ')).toBeNull();
  });

  it('accepts UUIDs and tokens', () => {
    expect(normalizeIdempotencyKey('abc-123_DEF.456:789')).toBe('abc-123_DEF.456:789');
    expect(normalizeIdempotencyKey('  padded  ')).toBe('padded');
  });

  it('rejects invalid input', () => {
    expect(() => normalizeIdempotencyKey('a'.repeat(201))).toThrow();
    expect(() => normalizeIdempotencyKey('bad key with spaces')).toThrow();
    expect(() => normalizeIdempotencyKey('key<script>')).toThrow();
  });
});
