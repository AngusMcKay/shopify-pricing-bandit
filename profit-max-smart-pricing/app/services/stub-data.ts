/**
 * stub-data.ts
 *
 * All backend API calls are isolated here as async functions returning typed data.
 * To connect a real backend, replace each function body with a real fetch() call —
 * the return types act as the API contract.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  title: string;
  imageUrl: string;
  currentPrice: number;
  currency: string;
}

export interface ProductExperimentConfig {
  productId: string;
  enabled: boolean;
  minPrice: number;
  maxPrice: number;
  costOfProduction?: number;
  regionalVariation: boolean;
  exactPricePoints: number[];
}

export interface TimePeriodOption {
  value: string;
  label: string;
}

export interface Metric {
  id: string;
  label: string;
  unit: "percentage" | "currency" | "number";
}

export interface Category {
  id: string;
  label: string;
}

export interface AggregateKpiData {
  timePeriods: TimePeriodOption[];
  categories: Category[];
  metrics: Metric[];
  /** data[categoryId][metricId] = value */
  data: Record<string, Record<string, number>>;
}

export interface KpiTimeSeriesData {
  metrics: Metric[];
  dates: string[];
  /** series[metricId] = array of values, one per date */
  series: Record<string, number[]>;
}

export interface ProductPriceKpiData {
  pricePoints: number[];
  currency: string;
  metrics: Metric[];
  /** data[pricePoint.toString()][metricId] = value */
  data: Record<string, Record<string, number>>;
}

export interface TrafficAllocationData {
  pricePoints: number[];
  currency: string;
  dates: string[];
  /** allocations[dateIndex][pricePointIndex] = percentage (0–100, sums to 100 per date) */
  allocations: number[][];
}

export interface DailyPriceImpressionsData {
  dates: string[];
  pricePoints: number[];
  currency: string;
  /** counts[dateIndex][pricePointIndex] = impression count */
  counts: number[][];
}

/** Revenue, cost, and profit projected at a given price scenario */
export interface ScenarioValues {
  revenue: number;
  cost: number;
  profit: number;
}

export interface ProductImpactEntry {
  productId: string;
  productTitle: string;
  hasCostData: boolean;
  /** Actual days the experiment ran within the selected window */
  daysRunning: number;
  /** True when daysRunning < 7 — projection less reliable */
  isShortExperiment: boolean;
  experimentDatetimeSubmitted: string; // ISO string
  minPrice: number;
  maxPrice: number;
  totalImpressions: number;
  bestProfitPrice: number | null;
  worstProfitPrice: number | null;
  bestProfitPerImpression: number | null;
  worstProfitPerImpression: number | null;
  profitPerImpressionPctDiff: number | null;
  /** Best/worst price selected by revenue-per-impression */
  revenueBest: ScenarioValues;
  revenueWorst: ScenarioValues;
  /** Best/worst price selected by profit-per-impression, normalised to weekly rate */
  profitBest: ScenarioValues;
  profitWorst: ScenarioValues;
}

export interface PriceImpactData {
  /** True if at least one product has a cost of production set */
  hasCostData: boolean;
  /** True if any product in byProduct has isShortExperiment */
  hasShortExperiment: boolean;
  aggregate: {
    revenueBest: ScenarioValues;
    revenueWorst: ScenarioValues;
    profitBest: ScenarioValues;
    profitWorst: ScenarioValues;
  };
  byProduct: ProductImpactEntry[];
}

// ---------------------------------------------------------------------------
// History types (past experiments)
// ---------------------------------------------------------------------------

export interface CompletedExperiment {
  productId: string;
  productTitle: string;
  experimentDatetimeSubmitted: string; // ISO string
  endedAt: string | null; // null when experiment is still active
  daysRunning: number;
  isShortExperiment: boolean;
  status: string; // "Active" | "Paused" | "Cancelled"
}

/** Per-row summary stats shown in the history table */
export interface HistoryRowStats {
  productId: string;
  productTitle: string;
  experimentDatetimeSubmitted: string;
  endedAt: string | null; // null when experiment is still active
  status: string; // "Active" | "Paused" | "Cancelled"
  daysRunning: number;
  isShortExperiment: boolean;
  hasCostData: boolean;
  basePrice: number;
  minPrice: number;
  maxPrice: number;
  totalImpressions: number;
  bestProfitPrice: number | null;
  worstProfitPrice: number | null;
  bestProfitPerImpression: number | null;
  worstProfitPerImpression: number | null;
  profitPerImpressionPctDiff: number | null;
  priceKpi: ProductPriceKpiData;
  dailyImpressions: DailyPriceImpressionsData;
  /** Price impact for this row */
  priceImpact: Omit<ProductImpactEntry, "productId" | "productTitle">;
}

export interface AnalyticsData {
  aggregateKpi: AggregateKpiData;
  /** null means "no time-series available — hide chart" */
  kpiTimeSeries: KpiTimeSeriesData | null;
  productOptions: Array<{ id: string; title: string }>;
  productPriceKpi: Record<string, ProductPriceKpiData>;
  trafficAllocation: Record<string, TrafficAllocationData>;
  dailyPriceImpressions: Record<string, DailyPriceImpressionsData>;
  /** null when there are no active experiments or insufficient impression data */
  priceImpact: PriceImpactData | null;
}

export interface OverviewStats {
  productsEnrolled: number;
  daysRunning: number;
}

// ---------------------------------------------------------------------------
// Stub API functions
// ---------------------------------------------------------------------------

/** GET /api/products */
export async function fetchProducts(): Promise<Product[]> {
  return [
    {
      id: "p1",
      title: "Classic Leather Wallet",
      imageUrl: "",
      currentPrice: 49.99,
      currency: "USD",
    },
    {
      id: "p2",
      title: "Merino Wool Beanie",
      imageUrl: "",
      currentPrice: 34.0,
      currency: "USD",
    },
    {
      id: "p3",
      title: "Bamboo Travel Mug",
      imageUrl: "",
      currentPrice: 29.95,
      currency: "USD",
    },
    {
      id: "p4",
      title: "Organic Cotton Tote",
      imageUrl: "",
      currentPrice: 19.99,
      currency: "USD",
    },
    {
      id: "p5",
      title: "Stainless Steel Water Bottle",
      imageUrl: "",
      currentPrice: 39.0,
      currency: "USD",
    },
    {
      id: "p6",
      title: "Natural Beeswax Candle",
      imageUrl: "",
      currentPrice: 24.5,
      currency: "USD",
    },
  ];
}

/** GET /api/experiment-configs */
export async function fetchExperimentConfigs(): Promise<
  ProductExperimentConfig[]
> {
  const products = await fetchProducts();
  return products.map((p) => ({
    productId: p.id,
    enabled: ["p1", "p3", "p5"].includes(p.id),
    minPrice: parseFloat((p.currentPrice * 0.9).toFixed(2)),
    maxPrice: parseFloat((p.currentPrice * 1.1).toFixed(2)),
    costOfProduction: p.id === "p1" ? 18.5 : undefined,
    regionalVariation: p.id === "p1",
    exactPricePoints: [],
  }));
}

/** GET /api/overview-stats — replaced by direct DB query in loader */
export async function fetchOverviewStats(): Promise<OverviewStats> {
  return {
    productsEnrolled: 0,
    daysRunning: 0,
  };
}

/** POST /api/experiment-configs (submit) */
export async function submitExperimentConfigs(
  _configs: ProductExperimentConfig[],
): Promise<{ success: boolean }> {
  // TODO: replace with real API call
  return { success: true };
}

/** GET /api/analytics?period=... */
export async function fetchAnalytics(_period: string): Promise<AnalyticsData> {
  const metrics: Metric[] = [
    { id: "conversion_rate", label: "Conv. Rate", unit: "percentage" },
    { id: "revenue", label: "Revenue", unit: "currency" },
    { id: "profit", label: "Profit", unit: "currency" },
  ];

  const categories: Category[] = [
    { id: "best", label: "Best variant" },
    { id: "mid", label: "Mid variant" },
    { id: "worst", label: "Worst variant" },
  ];

  const aggregateKpi: AggregateKpiData = {
    timePeriods: [
      { value: "7d", label: "Last 7 days" },
      { value: "14d", label: "Last 14 days" },
      { value: "30d", label: "Last 30 days" },
    ],
    categories,
    metrics,
    data: {
      best: { conversion_rate: 4.2, revenue: 1840, profit: 920 },
      mid: { conversion_rate: 3.1, revenue: 1340, profit: 620 },
      worst: { conversion_rate: 1.8, revenue: 780, profit: 290 },
    },
  };

  // Generate 30 days of dates ending today
  const today = new Date("2026-04-03");
  const dates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });

  const kpiTimeSeries: KpiTimeSeriesData = {
    metrics,
    dates,
    series: {
      conversion_rate: dates.map((_, i) =>
        parseFloat((2.8 + Math.sin(i / 4) * 0.8 + i * 0.02).toFixed(2)),
      ),
      revenue: dates.map((_, i) =>
        parseFloat((1100 + i * 20 + Math.sin(i / 3) * 100).toFixed(0)),
      ),
      profit: dates.map((_, i) =>
        parseFloat((500 + i * 9 + Math.sin(i / 3) * 50).toFixed(0)),
      ),
    },
  };

  const products = await fetchProducts();
  const productOptions = products.map((p) => ({ id: p.id, title: p.title }));

  const priceKpiMetrics: Metric[] = [
    { id: "profit_per_impression", label: "Profit Per Impression", unit: "currency" },
    { id: "revenue_per_impression", label: "Revenue Per Impression", unit: "currency" },
    { id: "conversion_rate", label: "Conversion Rate", unit: "percentage" },
    { id: "impressions", label: "Total Impressions", unit: "number" },
    { id: "profit", label: "Total Profit", unit: "currency" },
    { id: "purchases", label: "Total Purchases", unit: "number" },
    { id: "revenue", label: "Total Revenue", unit: "currency" },
  ];

  const buildProductPriceKpi = (
    basePrice: number,
    currency: string,
    cost = 0,
  ): ProductPriceKpiData => {
    const pricePoints = [
      parseFloat((basePrice * 0.85).toFixed(2)),
      parseFloat((basePrice * 0.92).toFixed(2)),
      parseFloat(basePrice.toFixed(2)),
      parseFloat((basePrice * 1.08).toFixed(2)),
      parseFloat((basePrice * 1.15).toFixed(2)),
    ];
    const data: Record<string, Record<string, number>> = {};
    pricePoints.forEach((price, i) => {
      const imps = 480 - i * 55;
      const purs = Math.round(imps * (0.055 - i * 0.007));
      const totalRevenue = parseFloat((purs * price).toFixed(2));
      const totalProfit = parseFloat((purs * (price - cost)).toFixed(2));
      data[price.toString()] = {
        impressions: imps,
        purchases: purs,
        conversion_rate: parseFloat(((purs / imps) * 100).toFixed(2)),
        revenue: totalRevenue,
        profit: totalProfit,
        revenue_per_impression: parseFloat((totalRevenue / imps).toFixed(4)),
        profit_per_impression: parseFloat((totalProfit / imps).toFixed(4)),
      };
    });
    return { pricePoints, currency, metrics: priceKpiMetrics, data };
  };

  // Traffic allocation: starts uniform (20% each), converges toward best price
  const buildTrafficAllocation = (
    basePrice: number,
    currency: string,
  ): TrafficAllocationData => {
    const pricePoints = [
      parseFloat((basePrice * 0.85).toFixed(2)),
      parseFloat((basePrice * 0.92).toFixed(2)),
      parseFloat(basePrice.toFixed(2)),
      parseFloat((basePrice * 1.08).toFixed(2)),
      parseFloat((basePrice * 1.15).toFixed(2)),
    ];
    const startAlloc = [20, 20, 20, 20, 20];
    const finalAlloc = [55, 25, 12, 5, 3];
    const allocations = dates.map((_, dayIdx) => {
      const t = dayIdx / 29;
      return pricePoints.map((_, pi) =>
        parseFloat(
          (startAlloc[pi] + (finalAlloc[pi] - startAlloc[pi]) * t).toFixed(1),
        ),
      );
    });
    return { pricePoints, currency, dates, allocations };
  };

  const buildDailyPriceImpressions = (basePrice: number, currency: string): DailyPriceImpressionsData => {
    const pricePoints = [
      parseFloat((basePrice * 0.85).toFixed(2)),
      parseFloat((basePrice * 0.92).toFixed(2)),
      parseFloat(basePrice.toFixed(2)),
      parseFloat((basePrice * 1.08).toFixed(2)),
      parseFloat((basePrice * 1.15).toFixed(2)),
    ];
    const startAlloc = [20, 20, 20, 20, 20];
    const finalAlloc = [55, 25, 12, 5, 3];
    const totalDailyImps = 50;
    const counts = dates.map((_, dayIdx) => {
      const t = dayIdx / Math.max(dates.length - 1, 1);
      return pricePoints.map((_, pi) => {
        const pct = startAlloc[pi] + (finalAlloc[pi] - startAlloc[pi]) * t;
        return Math.round((pct / 100) * totalDailyImps);
      });
    });
    return { dates, pricePoints, currency, counts };
  };

  const stubCost: Record<string, number> = { p1: 18.5, p3: 10 };
  const productPriceKpi: Record<string, ProductPriceKpiData> = {};
  const trafficAllocation: Record<string, TrafficAllocationData> = {};
  const dailyPriceImpressions: Record<string, DailyPriceImpressionsData> = {};
  for (const p of products) {
    productPriceKpi[p.id] = buildProductPriceKpi(p.currentPrice, p.currency, stubCost[p.id] ?? 0);
    trafficAllocation[p.id] = buildTrafficAllocation(p.currentPrice, p.currency);
    dailyPriceImpressions[p.id] = buildDailyPriceImpressions(p.currentPrice, p.currency);
  }

  // Stub price impact data — representative best-vs-worst scenarios
  const buildScenario = (price: number, convRate: number, cost: number, totalImps: number): ScenarioValues => ({
    revenue: Math.round(convRate * price * totalImps),
    cost: Math.round(convRate * cost * totalImps),
    profit: Math.round(convRate * (price - cost) * totalImps),
  });

  // Stub: give each product a plausible daysRunning within the selected period
  const stubDaysRunning: Record<string, number> = { p1: 30, p2: 5, p3: 14, p4: 30, p5: 8, p6: 30 };

  const impactByProduct: ProductImpactEntry[] = products.map((p) => {
    const daysRunning = stubDaysRunning[p.id] ?? 14;
    const isShortExperiment = daysRunning < 7;
    const totalImps = 800;
    const cost = p.id === "p1" ? 18.5 : p.id === "p3" ? 10 : 0;
    const hasCostData = cost > 0;
    const bestPrice = p.currentPrice * 1.08;
    const worstPrice = p.currentPrice * 0.85;
    // Weekly rate: raw value × 7 / daysRunning
    const weeklyRate = (v: ScenarioValues): ScenarioValues => ({
      revenue: Math.round(v.revenue * 7 / daysRunning),
      cost: Math.round(v.cost * 7 / daysRunning),
      profit: Math.round(v.profit * 7 / daysRunning),
    });
    const bestConvRate = 0.042;
    const worstConvRate = 0.018;
    const bestProfitPerImp = bestConvRate * (bestPrice - cost);
    const worstProfitPerImp = worstConvRate * (worstPrice - cost);
    const pctDiff = worstProfitPerImp !== 0
      ? Math.round(((bestProfitPerImp - worstProfitPerImp) / Math.abs(worstProfitPerImp)) * 100)
      : null;
    return {
      productId: p.id,
      productTitle: p.title,
      hasCostData,
      daysRunning,
      isShortExperiment,
      experimentDatetimeSubmitted: new Date(Date.now() - daysRunning * 86400000).toISOString(),
      minPrice: worstPrice,
      maxPrice: bestPrice,
      totalImpressions: totalImps,
      bestProfitPrice: parseFloat(bestPrice.toFixed(2)),
      worstProfitPrice: parseFloat(worstPrice.toFixed(2)),
      bestProfitPerImpression: parseFloat(bestProfitPerImp.toFixed(4)),
      worstProfitPerImpression: parseFloat(worstProfitPerImp.toFixed(4)),
      profitPerImpressionPctDiff: pctDiff,
      revenueBest: weeklyRate(buildScenario(bestPrice, bestConvRate, cost, totalImps)),
      revenueWorst: weeklyRate(buildScenario(worstPrice, worstConvRate, cost, totalImps)),
      profitBest: weeklyRate(buildScenario(bestPrice, bestConvRate, cost, totalImps)),
      profitWorst: weeklyRate(buildScenario(worstPrice, worstConvRate, cost, totalImps)),
    };
  });

  const sumScenarios = (entries: ProductImpactEntry[], key: "revenueBest" | "revenueWorst" | "profitBest" | "profitWorst"): ScenarioValues =>
    entries.reduce(
      (acc, e) => ({
        revenue: acc.revenue + e[key].revenue,
        cost: acc.cost + e[key].cost,
        profit: acc.profit + e[key].profit,
      }),
      { revenue: 0, cost: 0, profit: 0 },
    );

  const priceImpact: PriceImpactData = {
    hasCostData: impactByProduct.some((e) => e.hasCostData),
    hasShortExperiment: impactByProduct.some((e) => e.isShortExperiment),
    aggregate: {
      revenueBest: sumScenarios(impactByProduct, "revenueBest"),
      revenueWorst: sumScenarios(impactByProduct, "revenueWorst"),
      profitBest: sumScenarios(impactByProduct, "profitBest"),
      profitWorst: sumScenarios(impactByProduct, "profitWorst"),
    },
    byProduct: impactByProduct,
  };

  return {
    aggregateKpi,
    kpiTimeSeries,
    productOptions,
    productPriceKpi,
    trafficAllocation,
    dailyPriceImpressions,
    priceImpact,
  };
}
