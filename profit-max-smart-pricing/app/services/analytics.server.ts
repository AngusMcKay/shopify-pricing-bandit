/**
 * analytics.server.ts
 *
 * Server-side analytics queries. Returns the same AnalyticsData shape as the
 * stub-data module so the analytics route component needs minimal changes.
 */

import db from "../db.server";
import type {
  AnalyticsData,
  AggregateKpiData,
  KpiTimeSeriesData,
  ProductPriceKpiData,
  TrafficAllocationData,
  Metric,
} from "./stub-data";

const TIME_PERIODS = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
];

function periodDays(period: string): number {
  if (period === "7d") return 7;
  if (period === "14d") return 14;
  return 30;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptyData(): AnalyticsData {
  return {
    aggregateKpi: {
      timePeriods: TIME_PERIODS,
      categories: [],
      metrics: [],
      data: {},
    },
    kpiTimeSeries: null,
    productOptions: [],
    productPriceKpi: {},
    trafficAllocation: {},
  };
}

export async function fetchAnalyticsData(
  merchantId: string,
  period: string,
): Promise<AnalyticsData> {
  const days = periodDays(period);
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - days);
  periodStart.setHours(0, 0, 0, 0);

  // ---- Active experiments ----
  const activeExperiments = await db.experimentLive.findMany({
    where: { MerchantId: merchantId, Status: "Active" },
    select: { ProductId: true, ExperimentDatetimeSubmitted: true },
  });

  if (activeExperiments.length === 0) return emptyData();

  const productIds = activeExperiments.map((e) => e.ProductId);
  const experimentDatetimes = activeExperiments.map((e) => e.ExperimentDatetimeSubmitted);
  const experimentStartByProduct = new Map(
    activeExperiments.map((e) => [e.ProductId, e.ExperimentDatetimeSubmitted]),
  );

  // ---- Parallel DB reads ----
  const [setups, allSetups, snapshots, impressions, purchases, banditHistory] =
    await Promise.all([
      // Current active setup rows (current probabilities)
      db.experimentSetup.findMany({
        where: {
          MerchantId: merchantId,
          IsActive: true,
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: {
          ProductId: true,
          ExperimentVariantId: true,
          BaseVariantId: true,
          Price: true,
          Probability: true,
          BanditRound: true,
        },
      }),
      // All setup rows including history (for traffic allocation chart)
      db.experimentSetup.findMany({
        where: {
          MerchantId: merchantId,
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: {
          ProductId: true,
          ExperimentVariantId: true,
          Price: true,
          Probability: true,
          BanditRound: true,
        },
        orderBy: { BanditRound: "asc" },
      }),
      // Product titles from snapshot
      db.experimentMerchantProductSnapshot.findMany({
        where: {
          MerchantId: merchantId,
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: { ProductId: true, ProductTitle: true },
        distinct: ["ProductId"],
      }),
      // Impressions within the selected period
      db.impressions.findMany({
        where: {
          MerchantId: merchantId,
          Datetime: { gte: periodStart },
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: { ProductId: true, ExperimentVariantId: true, Price: true, Datetime: true },
      }),
      // Purchases within the selected period
      db.purchases.findMany({
        where: {
          MerchantId: merchantId,
          Datetime: { gte: periodStart },
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: { ProductId: true, ExperimentVariantId: true, Price: true, Datetime: true },
      }),
      // Bandit history — for round dates in the traffic allocation chart
      db.banditParametersHistory.findMany({
        where: {
          MerchantId: merchantId,
          ProductId: { in: productIds },
          ExperimentDatetimeSubmitted: { in: experimentDatetimes },
        },
        select: { ProductId: true, ModelVersion: true, DatetimeUpdated: true },
        distinct: ["ProductId", "ModelVersion"],
        orderBy: { ModelVersion: "asc" },
      }),
    ]);

  const titleByProduct = new Map(snapshots.map((s) => [s.ProductId, s.ProductTitle]));

  // ---- aggregateKpi ----
  // One bar group per product: total impressions, overall conversion rate, total revenue.
  const aggMetrics: Metric[] = [
    { id: "impressions", label: "Impressions", unit: "number" },
    { id: "conversion_rate", label: "Conv. Rate", unit: "percentage" },
    { id: "revenue", label: "Revenue", unit: "currency" },
  ];

  const impCountByProduct = new Map<string, number>();
  const purCountByProduct = new Map<string, number>();
  const revByProduct = new Map<string, number>();

  for (const imp of impressions) {
    impCountByProduct.set(imp.ProductId, (impCountByProduct.get(imp.ProductId) ?? 0) + 1);
  }
  for (const pur of purchases) {
    purCountByProduct.set(pur.ProductId, (purCountByProduct.get(pur.ProductId) ?? 0) + 1);
    revByProduct.set(
      pur.ProductId,
      (revByProduct.get(pur.ProductId) ?? 0) + parseFloat(pur.Price.toString()),
    );
  }

  const aggCategories = productIds.map((pid) => ({
    id: pid,
    label: titleByProduct.get(pid) ?? pid,
  }));

  const aggData: Record<string, Record<string, number>> = {};
  for (const pid of productIds) {
    const imps = impCountByProduct.get(pid) ?? 0;
    const purs = purCountByProduct.get(pid) ?? 0;
    aggData[pid] = {
      impressions: imps,
      conversion_rate: imps > 0 ? parseFloat(((purs / imps) * 100).toFixed(2)) : 0,
      revenue: parseFloat((revByProduct.get(pid) ?? 0).toFixed(2)),
    };
  }

  const aggregateKpi: AggregateKpiData = {
    timePeriods: TIME_PERIODS,
    categories: aggCategories,
    metrics: aggMetrics,
    data: aggData,
  };

  // ---- kpiTimeSeries — daily totals across all experiments ----
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(isoDate(d));
  }

  const dailyImps = new Map<string, number>();
  const dailyPurs = new Map<string, number>();
  const dailyRev = new Map<string, number>();

  for (const imp of impressions) {
    const day = isoDate(imp.Datetime);
    dailyImps.set(day, (dailyImps.get(day) ?? 0) + 1);
  }
  for (const pur of purchases) {
    const day = isoDate(pur.Datetime);
    dailyPurs.set(day, (dailyPurs.get(day) ?? 0) + 1);
    dailyRev.set(day, (dailyRev.get(day) ?? 0) + parseFloat(pur.Price.toString()));
  }

  const tsMetrics: Metric[] = [
    { id: "impressions", label: "Impressions", unit: "number" },
    { id: "purchases", label: "Purchases", unit: "number" },
    { id: "conversion_rate", label: "Conv. Rate (%)", unit: "percentage" },
    { id: "revenue", label: "Revenue", unit: "currency" },
  ];

  const kpiTimeSeries: KpiTimeSeriesData = {
    metrics: tsMetrics,
    dates,
    series: {
      impressions: dates.map((d) => dailyImps.get(d) ?? 0),
      purchases: dates.map((d) => dailyPurs.get(d) ?? 0),
      conversion_rate: dates.map((d) => {
        const imps = dailyImps.get(d) ?? 0;
        const purs = dailyPurs.get(d) ?? 0;
        return imps > 0 ? parseFloat(((purs / imps) * 100).toFixed(2)) : 0;
      }),
      revenue: dates.map((d) => parseFloat((dailyRev.get(d) ?? 0).toFixed(2))),
    },
  };

  // ---- Per-product: price-point KPI and traffic allocation ----
  const productOptions = productIds.map((pid) => ({
    id: pid,
    title: titleByProduct.get(pid) ?? pid,
  }));

  const priceKpiMetrics: Metric[] = [
    { id: "impressions", label: "Impressions", unit: "number" },
    { id: "purchases", label: "Purchases", unit: "number" },
    { id: "conversion_rate", label: "Conv. Rate (%)", unit: "percentage" },
    { id: "revenue", label: "Revenue", unit: "currency" },
    { id: "probability", label: "Current allocation", unit: "percentage" },
  ];

  const productPriceKpi: Record<string, ProductPriceKpiData> = {};
  const trafficAllocation: Record<string, TrafficAllocationData> = {};

  for (const pid of productIds) {
    const productSetups = setups.filter((s) => s.ProductId === pid);

    // Deduplicate by price (aggregate across base variants — linked draws case).
    // All base variants at the same price get the same probability; keep first.
    const priceInfo = new Map<string, { probability: number }>();
    for (const s of productSetups) {
      const priceStr = s.Price.toString();
      if (!priceInfo.has(priceStr)) {
        priceInfo.set(priceStr, { probability: parseFloat(s.Probability.toString()) });
      }
    }
    const sortedPrices = [...priceInfo.keys()].sort(
      (a, b) => parseFloat(a) - parseFloat(b),
    );

    // Aggregate impressions and purchases by price for this product.
    // Impressions.Price stores the experiment price shown to the visitor.
    const impsByPrice = new Map<string, number>();
    const pursByPrice = new Map<string, number>();

    for (const imp of impressions) {
      if (imp.ProductId !== pid) continue;
      const priceStr = imp.Price.toString();
      impsByPrice.set(priceStr, (impsByPrice.get(priceStr) ?? 0) + 1);
    }
    for (const pur of purchases) {
      if (pur.ProductId !== pid) continue;
      const priceStr = pur.Price.toString();
      pursByPrice.set(priceStr, (pursByPrice.get(priceStr) ?? 0) + 1);
    }

    const priceKpiData: Record<string, Record<string, number>> = {};
    for (const priceStr of sortedPrices) {
      const imps = impsByPrice.get(priceStr) ?? 0;
      const purs = pursByPrice.get(priceStr) ?? 0;
      const prob = priceInfo.get(priceStr)?.probability ?? 0;
      priceKpiData[priceStr] = {
        impressions: imps,
        purchases: purs,
        conversion_rate: imps > 0 ? parseFloat(((purs / imps) * 100).toFixed(2)) : 0,
        revenue: parseFloat((purs * parseFloat(priceStr)).toFixed(2)),
        probability: parseFloat((prob * 100).toFixed(1)),
      };
    }

    productPriceKpi[pid] = {
      pricePoints: sortedPrices.map((p) => parseFloat(p)),
      currency: "USD",
      metrics: priceKpiMetrics,
      data: priceKpiData,
    };

    // ---- Traffic allocation over bandit rounds ----
    // x-axis: one point per bandit round (round 0 = experiment start, round N = Nth update).
    // y-axis: probability per price point (0–100, summing to ~100).
    const productAllSetups = allSetups.filter((s) => s.ProductId === pid);
    const rounds = [...new Set(productAllSetups.map((s) => s.BanditRound))].sort(
      (a, b) => a - b,
    );

    // Date for each round: round 0 = experiment start; round N = from BanditParametersHistory.
    const roundDates = new Map<number, string>();
    const expStart = experimentStartByProduct.get(pid);
    if (expStart) roundDates.set(0, isoDate(expStart));

    const productBanditHistory = banditHistory.filter((h) => h.ProductId === pid);
    for (const h of productBanditHistory) {
      if (!roundDates.has(h.ModelVersion)) {
        roundDates.set(h.ModelVersion, isoDate(h.DatetimeUpdated));
      }
    }

    const trafficDates = rounds.map((r) => roundDates.get(r) ?? "").filter(Boolean);

    const allocations = rounds.map((round) => {
      const roundSetups = productAllSetups.filter((s) => s.BanditRound === round);
      // Deduplicate by price — pick first seen probability for each price.
      const probByPrice = new Map<string, number>();
      for (const s of roundSetups) {
        const priceStr = s.Price.toString();
        if (!probByPrice.has(priceStr)) {
          probByPrice.set(priceStr, parseFloat(s.Probability.toString()) * 100);
        }
      }
      return sortedPrices.map((p) => parseFloat((probByPrice.get(p) ?? 0).toFixed(1)));
    });

    trafficAllocation[pid] = {
      pricePoints: sortedPrices.map((p) => parseFloat(p)),
      currency: "USD",
      dates: trafficDates,
      allocations,
    };
  }

  return {
    aggregateKpi,
    kpiTimeSeries,
    productOptions,
    productPriceKpi,
    trafficAllocation,
  };
}
