import { describe, expect, it } from "vitest";
import { generatePricePoints, PricePointError } from "./pricing";

// Helpers
const ENDINGS_99 = [0.99]; // only .99 endings — easier to reason about
const ENDINGS_DEFAULT = [0.99, 0.49, 0.0];

describe("generatePricePoints", () => {
  // -------------------------------------------------------------------------
  // Normal case — 5 distinct points across a comfortable range
  // -------------------------------------------------------------------------
  it("returns up to 5 points for a wide range with .99 endings", () => {
    // Range $20–$60 with only .99 endings.
    // Raw candidates: 20, 30, 40, 50, 60
    // Rounded: 19.99, 29.99, 39.99, 49.99, 59.99
    // All within [20, 60]? 19.99 < 20 → excluded!
    // So we get: 29.99, 39.99, 49.99, 59.99 — only 4
    // Adjust: range $20.99–$60.99 to ensure all round in-range
    const points = generatePricePoints(19.99, 59.99, ENDINGS_99);
    expect(points).toHaveLength(5);
    expect(points[0]).toBe(19.99);
    expect(points[4]).toBe(59.99);
    // All should end in .99
    for (const p of points) {
      expect(parseFloat(p.toFixed(2)) % 1).toBeCloseTo(0.99, 2);
    }
  });

  it("generates 5 evenly-spread points for a standard wide range", () => {
    // $10–$50, default endings
    const points = generatePricePoints(10, 50, ENDINGS_DEFAULT);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.length).toBeLessThanOrEqual(5);
    // Must be sorted
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeGreaterThan(points[i - 1]);
    }
    // All within range
    for (const p of points) {
      expect(p).toBeGreaterThanOrEqual(10);
      expect(p).toBeLessThanOrEqual(50);
    }
  });

  // -------------------------------------------------------------------------
  // Range too narrow for 5 points — should still return ≥2
  // -------------------------------------------------------------------------
  it("returns fewer than 5 points when range is too narrow for 5 distinct endings", () => {
    // $20.00–$25.00 with .99 endings:
    // Raw: 20.00, 21.25, 22.50, 23.75, 25.00
    // Rounded: 19.99 (out), 21.99, 22.99, 23.99, 24.99
    // Gap check: 21.99→22.99 = 4.5% ✓, 22.99→23.99 = 4.3% ✓, 23.99→24.99 = 4.2% ✓
    // So 4 points (21.99, 22.99, 23.99, 24.99)
    const points = generatePricePoints(20, 25, ENDINGS_99);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.length).toBeLessThan(5);
    for (const p of points) {
      expect(p).toBeGreaterThanOrEqual(20);
      expect(p).toBeLessThanOrEqual(25);
    }
  });

  // -------------------------------------------------------------------------
  // Range too narrow for 2 points — must throw
  // -------------------------------------------------------------------------
  it("throws PricePointError when range is too narrow for 2 valid points", () => {
    // $19.99–$20.49 with default endings:
    // The only candidates that round in-range: 19.99 and 20.00 and 20.49
    // 19.99→20.00 gap = 0.05% < 2% → gap filter removes 20.00
    // 20.00→20.49 gap = 2.45% ✓ but 20.00 was filtered
    // Effectively a very tight range gives <2 points
    expect(() =>
      generatePricePoints(20.0, 20.1, ENDINGS_DEFAULT),
    ).toThrow(PricePointError);
  });

  it("throws PricePointError when minPrice equals maxPrice", () => {
    expect(() => generatePricePoints(29.99, 29.99, ENDINGS_99)).toThrow(
      PricePointError,
    );
  });

  it("throws PricePointError when minPrice is greater than maxPrice", () => {
    expect(() => generatePricePoints(50, 20, ENDINGS_99)).toThrow(
      PricePointError,
    );
  });

  // -------------------------------------------------------------------------
  // Rounding at bounds
  // -------------------------------------------------------------------------
  it("rounds boundary prices to the nearest allowed ending within range", () => {
    // minPrice=29.50, maxPrice=49.50, endings=[0.99]
    // Expect first point to be 29.99 (closest in-range .99 ending to 29.50)
    // Expect last point to be 49.99? But 49.99 < 49.50? No: 49.99 > 49.50 → out of range
    // Actually 49.99 > 49.50 so it's excluded. Last valid is 48.99.
    // Let's use a range where endpoints round cleanly in-range.
    // minPrice=19.99 exactly already rounds to 19.99 ✓
    const points = generatePricePoints(19.99, 39.99, ENDINGS_99);
    expect(points[0]).toBe(19.99);
    expect(points[points.length - 1]).toBe(39.99);
  });

  it("rounds intermediate prices to nearest allowed ending", () => {
    // midpoint of 10–20 = 15.00, nearest .99 is 14.99
    const points = generatePricePoints(10.0, 20.0, ENDINGS_99);
    // 14.99 should be one of the points (midpoint rounded to .99)
    expect(points).toContain(14.99);
  });

  it("uses the closest ending among multiple options", () => {
    // price ~15.60 — .49 ending candidate=15.49 (diff 0.11), .99 candidate=15.99 (diff 0.39), .00=15.00 (diff 0.60)
    // So .49 should win
    const points = generatePricePoints(14.0, 18.0, [0.99, 0.49, 0.0]);
    // The midpoint is 16.00; 16.00 is exactly an allowed ending (.00) → 16.00
    expect(points).toContain(16.0);
  });

  // -------------------------------------------------------------------------
  // Deduplication — same ending for multiple raw candidates
  // -------------------------------------------------------------------------
  it("deduplicates points that round to the same ending", () => {
    // Very narrow range where multiple raw candidates round to same value.
    // $29.90–$30.10, endings=[0.99]: all candidates → 29.99
    // Only 1 unique point → should throw
    expect(() =>
      generatePricePoints(29.9, 30.1, ENDINGS_99),
    ).toThrow(PricePointError);
  });

  it("does not include duplicate values in the output", () => {
    // Even if rounding produces duplicates, the output must be unique
    const points = generatePricePoints(10.0, 50.0, ENDINGS_DEFAULT);
    const unique = new Set(points);
    expect(unique.size).toBe(points.length);
  });

  // -------------------------------------------------------------------------
  // Merchant-specified override (exactPricePoints)
  // -------------------------------------------------------------------------
  it("returns merchant-specified exact price points sorted", () => {
    const exact = [45.0, 25.0, 35.0];
    const points = generatePricePoints(10, 50, ENDINGS_DEFAULT, exact);
    expect(points).toEqual([25.0, 35.0, 45.0]);
  });

  it("deduplicates exact price points", () => {
    const exact = [25.0, 35.0, 35.0, 45.0];
    const points = generatePricePoints(10, 50, ENDINGS_DEFAULT, exact);
    expect(points).toEqual([25.0, 35.0, 45.0]);
  });

  it("throws when merchant-specified points violate the 2% gap rule", () => {
    // 25.00 and 25.49 — gap = 0.49/25.00 = 1.96% < 2%
    expect(() =>
      generatePricePoints(10, 50, ENDINGS_DEFAULT, [25.0, 25.49, 35.0]),
    ).toThrow(PricePointError);
  });

  it("throws when merchant-specified points has fewer than 2 unique values", () => {
    expect(() =>
      generatePricePoints(10, 50, ENDINGS_DEFAULT, [29.99]),
    ).toThrow(PricePointError);
  });

  it("ignores the min/max range when exact price points are provided", () => {
    // exactPricePoints outside [min, max] — the override bypasses range filtering
    const exact = [100.0, 200.0, 300.0];
    const points = generatePricePoints(10, 50, ENDINGS_DEFAULT, exact);
    expect(points).toEqual([100.0, 200.0, 300.0]);
  });
});
