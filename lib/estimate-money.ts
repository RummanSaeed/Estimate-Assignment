/**
 * Money helpers for the Estimates module.
 *
 * All monetary values are stored as integer MINOR UNITS (e.g. cents for USD).
 * Floating-point arithmetic is never used for financial calculations —
 * quantities are scaled to integers before multiplication.
 */

/**
 * Convert a major-unit amount (e.g. dollars) to integer minor units.
 * Guards against IEEE-754 noise (19.99 * 100 === 1998.9999999999998).
 * Returns null for negative, non-finite, or unsafe values.
 */
export function majorToMinor(major: number): number | null {
  if (!Number.isFinite(major) || major < 0) return null;
  const minor = Math.round(major * 100);
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

/** Convert integer minor units back to a major-unit number for display. */
export function minorToMajor(minor: number): number {
  return minor / 100;
}

/**
 * Compute a line total in minor units.
 * quantity may have up to 3 decimal places (NUMERIC(12,3) in the DB).
 * We scale quantity to an integer (×1000), multiply by unit price (minor units),
 * then divide by 1000 with half-up rounding — all in integer math.
 */
export function computeLineTotalMinor(quantity: number, unitPriceMinor: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a positive finite number');
  }
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new Error('Unit price must be a non-negative safe integer (minor units)');
  }

  // Scale quantity to 3 decimal places as an integer
  const qtyMilli = Math.round(quantity * 1000);
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) {
    throw new Error('Quantity is out of range');
  }

  // line_total = unitPriceMinor * qtyMilli / 1000, rounded half-up
  const product = unitPriceMinor * qtyMilli;
  if (!Number.isSafeInteger(product)) {
    throw new Error('Line total exceeds safe integer range');
  }
  return Math.round(product / 1000);
}

export interface EstimateTotalsInput {
  lineItems: Array<{ quantity: number; unitPriceMinor: number }>;
  taxRateBps: number; // basis points, 0–10000
}

export interface EstimateTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Compute estimate totals server-side.
 * Tax is integer math: round(subtotal * bps / 10000), half-up.
 */
export function computeEstimateTotals(input: EstimateTotalsInput): EstimateTotals {
  const { lineItems, taxRateBps } = input;

  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10000) {
    throw new Error('Tax rate must be an integer between 0 and 10000 basis points');
  }

  let subtotalMinor = 0;
  for (const item of lineItems) {
    subtotalMinor += computeLineTotalMinor(item.quantity, item.unitPriceMinor);
    if (!Number.isSafeInteger(subtotalMinor)) {
      throw new Error('Subtotal exceeds safe integer range');
    }
  }

  const taxMinor = Math.round((subtotalMinor * taxRateBps) / 10000);
  const totalMinor = subtotalMinor + taxMinor;

  return { subtotalMinor, taxMinor, totalMinor };
}

/** Format minor units as a currency string for display. */
export function formatMinor(minor: number, currency = 'USD', locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(minorToMajor(minor));
  } catch {
    // Fallback for unknown currency codes
    return `${minorToMajor(minor).toFixed(2)} ${currency}`;
  }
}

/**
 * Normalize an Idempotency-Key header value.
 * Returns null when absent; throws on invalid input.
 */
export function normalizeIdempotencyKey(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 200) {
    throw new Error('Idempotency-Key is too long (max 200 characters)');
  }
  // Allow UUIDs and reasonable token characters only
  if (!/^[A-Za-z0-9_\-.:]+$/.test(trimmed)) {
    throw new Error('Idempotency-Key contains invalid characters');
  }
  return trimmed;
}
