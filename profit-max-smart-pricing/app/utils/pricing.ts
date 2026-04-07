// ---------------------------------------------------------------------------
// Price point generation utility
//
// Generates a set of test price points for a multi-armed bandit experiment.
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWED_ENDINGS = [9, 4, 0]; // last digit of the price in cents
const MIN_PRICE_GAP_RATIO = 0.02; // 2% minimum gap between adjacent points
const MAX_PRICE_POINTS = 5;
const MIN_PRICE_POINTS = 2;

export class PricePointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricePointError";
  }
}

/**
 * Returns the last digit of a price in cents (e.g. $19.94 → 4, $19.99 → 9).
 */
function getLastDigit(price: number): number {
  return Math.round(price * 100) % 10;
}

/**
 * Round a price to the nearest value whose last cent-digit is in allowedEndings.
 * Searches outward from the price by ±0.01 increments (trying +offset before
 * −offset at each step), skipping candidates outside [minPrice, maxPrice].
 * Returns null if no valid ending can be found within the allowed range.
 */
function roundToNearestEnding(
  price: number,
  allowedEndings: number[],
  minPrice: number,
  maxPrice: number,
): number | null {
  const base = parseFloat(price.toFixed(2));
  if (allowedEndings.includes(getLastDigit(base))) {
    return base;
  }
  for (let cents = 1; cents <= 99; cents++) {
    const higher = parseFloat((base + cents / 100).toFixed(2));
    if (higher <= maxPrice && allowedEndings.includes(getLastDigit(higher))) {
      return higher;
    }
    const lower = parseFloat((base - cents / 100).toFixed(2));
    if (lower >= minPrice && allowedEndings.includes(getLastDigit(lower))) {
      return lower;
    }
  }
  return null;
}

/**
 * Determine how many evenly-spaced price points fit between minPrice and
 * maxPrice while maintaining at least MIN_PRICE_GAP_RATIO between every pair.
 *
 * N points require (N−1) gaps of MIN_PRICE_GAP_RATIO each:
 *   5 points → range must be ≥ 8% above minPrice
 *   4 points → range must be ≥ 6% above minPrice
 *   3 points → range must be ≥ 4% above minPrice
 *   2 points → range must be ≥ 2% above minPrice
 */
function calculateNumPricePoints(minPrice: number, maxPrice: number): number {
  const ratio = maxPrice / minPrice;
  for (let n = MAX_PRICE_POINTS; n >= MIN_PRICE_POINTS; n--) {
    if (ratio >= 1 + MIN_PRICE_GAP_RATIO * (n - 1)) {
      return n;
    }
  }
  throw new PricePointError(
    `Price range too narrow: maxPrice must be at least ${(MIN_PRICE_GAP_RATIO * 100).toFixed(0)}% above minPrice to generate ${MIN_PRICE_POINTS} distinct price points.`,
  );
}

/**
 * Validate that a sorted list of price points satisfies the 2% gap rule
 * and contains at least MIN_PRICE_POINTS entries.
 *
 * Throws PricePointError if the constraints are not met.
 */
function validatePoints(points: number[]): void {
  if (points.length < MIN_PRICE_POINTS) {
    throw new PricePointError(
      `At least ${MIN_PRICE_POINTS} distinct price points are required, but only ${points.length} ${points.length === 1 ? "was" : "were"} generated. Widen the min/max price range.`,
    );
  }

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const gap = (curr - prev) / prev;
    if (gap < MIN_PRICE_GAP_RATIO) {
      throw new PricePointError(
        `Price points $${prev.toFixed(2)} and $${curr.toFixed(2)} are too close (gap ${(gap * 100).toFixed(2)}% < required 2%). Widen the min/max price range or adjust allowed endings.`,
      );
    }
  }
}

/**
 * Generate evenly-spaced test price points between minPrice and maxPrice,
 * rounded to the nearest value whose last cent-digit is in allowedEndings,
 * with duplicates and out-of-range points removed.
 *
 * The number of price points is determined upfront by how many 2%-gapped
 * points fit in the range (up to MAX_PRICE_POINTS), ensuring even spacing.
 *
 * @param minPrice        Lower bound of the price range (inclusive).
 * @param maxPrice        Upper bound of the price range (inclusive).
 * @param allowedEndings  Allowed last digits in cents (default: [9, 4, 0],
 *                        matching prices like x.x9, x.x4, or x.x0).
 * @param exactPricePoints  Merchant override — if provided and non-empty, these
 *                          prices are validated and returned directly (sorted).
 * @returns Sorted array of price points.
 * @throws PricePointError if fewer than 2 valid price points can be produced.
 */
export function generatePricePoints(
  minPrice: number,
  maxPrice: number,
  allowedEndings: number[] = DEFAULT_ALLOWED_ENDINGS,
  exactPricePoints?: number[],
): number[] {
  // Merchant override path
  if (exactPricePoints && exactPricePoints.length > 0) {
    const sorted = [...exactPricePoints]
      .map((p) => parseFloat(p.toFixed(2)))
      .sort((a, b) => a - b);
    const deduped = sorted.filter((p, i) => i === 0 || p !== sorted[i - 1]);
    validatePoints(deduped);
    return deduped;
  }

  if (minPrice >= maxPrice) {
    throw new PricePointError("minPrice must be less than maxPrice.");
  }

  // Determine how many evenly-spaced points the range can support.
  const numPoints = calculateNumPricePoints(minPrice, maxPrice);

  // Generate evenly-spaced raw candidates, round each to the nearest allowed
  // ending (constrained to [minPrice, maxPrice]), then deduplicate.
  const seen = new Set<number>();
  const points: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    const ratio = i / (numPoints - 1);
    const raw = minPrice + (maxPrice - minPrice) * ratio;
    const rounded = roundToNearestEnding(raw, allowedEndings, minPrice, maxPrice);
    if (rounded !== null && !seen.has(rounded)) {
      seen.add(rounded);
      points.push(rounded);
    }
  }
  points.sort((a, b) => a - b);

  validatePoints(points);

  return points;
}
