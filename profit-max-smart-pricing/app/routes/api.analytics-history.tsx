/**
 * api.analytics-history.tsx
 *
 * Two endpoints:
 *
 * GET  ?action=list
 *   Returns all completed/cancelled experiments for the merchant, grouped by product.
 *   Used to populate the "Add a product…" selector and pre-fill the history table.
 *
 * GET  ?action=row&productId=...&experimentDatetime=...
 *   Returns full HistoryRowStats for one product+experiment combination.
 *   Called lazily when the merchant adds a row to the history table.
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { HistoryRowStats, ScenarioValues, ProductImpactEntry, ProductPriceKpiData, DailyPriceImpressionsData, Metric } from "../services/stub-data";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// List action — returns CompletedExperiment[]
// ---------------------------------------------------------------------------

async function handleList(merchantId: string) {
  const experiments = await db.experimentLive.findMany({
    where: { MerchantId: merchantId },
    select: {
      ProductId: true,
      ExperimentDatetimeSubmitted: true,
      LastUpdatedAt: true,
      Status: true,
    },
    orderBy: { LastUpdatedAt: "desc" },
  });

  const productIds = [...new Set(experiments.map((e) => e.ProductId))];
  const snapshots = await db.experimentMerchantProductSnapshot.findMany({
    where: {
      MerchantId: merchantId,
      ProductId: { in: productIds },
      ExperimentDatetimeSubmitted: { in: experiments.map((e) => e.ExperimentDatetimeSubmitted) },
    },
    select: { ProductId: true, ProductTitle: true, ExperimentDatetimeSubmitted: true },
    distinct: ["ProductId", "ExperimentDatetimeSubmitted"],
  });

  const titleMap = new Map(
    snapshots.map((s) => [`${s.ProductId}|${s.ExperimentDatetimeSubmitted.toISOString()}`, s.ProductTitle]),
  );

  const rows = experiments.map((e) => {
    const key = `${e.ProductId}|${e.ExperimentDatetimeSubmitted.toISOString()}`;
    const startDate = e.ExperimentDatetimeSubmitted;
    const isActive = e.Status === "Active";
    // For active experiments, endedAt is now; for completed it's LastUpdatedAt
    const endDate = isActive ? new Date() : e.LastUpdatedAt;
    const daysRunning = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    return {
      productId: e.ProductId,
      productTitle: titleMap.get(key) ?? e.ProductId,
      experimentDatetimeSubmitted: startDate.toISOString(),
      endedAt: isActive ? null : e.LastUpdatedAt.toISOString(),
      daysRunning,
      isShortExperiment: daysRunning < 7,
      status: e.Status,
    };
  });

  return Response.json({ experiments: rows });
}

// ---------------------------------------------------------------------------
// Row action — returns HistoryRowStats
// ---------------------------------------------------------------------------

async function handleRow(merchantId: string, productId: string, experimentDatetime: string) {
  const experimentDate = new Date(experimentDatetime);

  const [live, setups, snapshots, costInput, allImpressions, allPurchases] = await Promise.all([
    db.experimentLive.findFirst({
      where: { MerchantId: merchantId, ProductId: productId, ExperimentDatetimeSubmitted: experimentDate },
      select: { LastUpdatedAt: true, Status: true },
    }),
    db.experimentSetup.findMany({
      where: {
        MerchantId: merchantId,
        ProductId: productId,
        ExperimentDatetimeSubmitted: experimentDate,
        IsActive: true,
      },
      select: { Price: true, Probability: true },
    }),
    db.experimentMerchantProductSnapshot.findFirst({
      where: { MerchantId: merchantId, ProductId: productId, ExperimentDatetimeSubmitted: experimentDate },
      select: { ProductTitle: true, VariantPrice: true },
    }),
    db.experimentMerchantInputs.findFirst({
      where: {
        MerchantId: merchantId,
        ProductId: productId,
        ExperimentDatetimeSubmitted: experimentDate,
        ExperimentParameter: "CostOfProduction",
      },
      select: { ExperimentParameterValue: true },
    }),
    db.impressions.findMany({
      where: { MerchantId: merchantId, ProductId: productId, ExperimentDatetimeSubmitted: experimentDate },
      select: { Price: true, Datetime: true },
    }),
    db.purchases.findMany({
      where: { MerchantId: merchantId, ProductId: productId, ExperimentDatetimeSubmitted: experimentDate },
      select: { Price: true, Datetime: true },
    }),
  ]);

  const isActive = live?.Status === "Active";
  const endDate = isActive ? new Date() : (live?.LastUpdatedAt ?? new Date());
  const daysRunning = Math.max(1, Math.round((endDate.getTime() - experimentDate.getTime()) / 86400000));
  const isShortExperiment = daysRunning < 7;

  const cost = costInput ? parseFloat(costInput.ExperimentParameterValue) : 0;
  const hasCostData = cost > 0;

  // Price range from setups
  const setupPrices = setups.map((s) => parseFloat(s.Price.toString()));
  const minPrice = setupPrices.length > 0 ? Math.min(...setupPrices) : 0;
  const maxPrice = setupPrices.length > 0 ? Math.max(...setupPrices) : 0;

  // Per-price impression/purchase counts
  const impsByPrice = new Map<string, number>();
  const pursByPrice = new Map<string, number>();
  for (const imp of allImpressions) {
    const k = imp.Price.toString();
    impsByPrice.set(k, (impsByPrice.get(k) ?? 0) + 1);
  }
  for (const pur of allPurchases) {
    const k = pur.Price.toString();
    pursByPrice.set(k, (pursByPrice.get(k) ?? 0) + 1);
  }

  const totalImpressions = allImpressions.length;

  const allPriceStrs = [...new Set([...impsByPrice.keys()])].sort((a, b) => parseFloat(a) - parseFloat(b));
  const activePrices = allPriceStrs.filter((p) => (impsByPrice.get(p) ?? 0) > 0);

  interface PriceStat { price: number; convRate: number; profitPerImp: number; revenuePerImp: number; }
  const stats: PriceStat[] = activePrices.map((priceStr) => {
    const price = parseFloat(priceStr);
    const imps = impsByPrice.get(priceStr) ?? 0;
    const purs = pursByPrice.get(priceStr) ?? 0;
    const convRate = imps > 0 ? purs / imps : 0;
    return { price, convRate, revenuePerImp: convRate * price, profitPerImp: convRate * (price - cost) };
  });

  const toScenario = (stat: PriceStat): ScenarioValues => ({
    revenue: Math.round(stat.convRate * stat.price * totalImpressions * 100) / 100,
    cost: Math.round(stat.convRate * cost * totalImpressions * 100) / 100,
    profit: Math.round(stat.convRate * (stat.price - cost) * totalImpressions * 100) / 100,
  });

  const byRevenue = [...stats].sort((a, b) => b.revenuePerImp - a.revenuePerImp);
  const byProfit = [...stats].sort((a, b) => b.profitPerImp - a.profitPerImp);

  const bestProfitStat = stats.length > 0 ? stats.reduce((a, b) => b.profitPerImp > a.profitPerImp ? b : a) : null;
  const worstProfitStat = stats.length > 0 ? stats.reduce((a, b) => b.profitPerImp < a.profitPerImp ? b : a) : null;
  const bestProfitPerImp = bestProfitStat?.profitPerImp ?? null;
  const worstProfitPerImp = worstProfitStat?.profitPerImp ?? null;
  const profitPerImpressionPctDiff =
    bestProfitPerImp !== null && worstProfitPerImp !== null && worstProfitPerImp !== 0
      ? Math.round(((bestProfitPerImp - worstProfitPerImp) / Math.abs(worstProfitPerImp)) * 100)
      : null;

  // ---- priceKpi ----
  const priceKpiMetrics: Metric[] = [
    { id: "profit_per_impression", label: "Profit Per Impression", unit: "currency" },
    { id: "revenue_per_impression", label: "Revenue Per Impression", unit: "currency" },
    { id: "conversion_rate", label: "Conversion Rate", unit: "percentage" },
    { id: "impressions", label: "Total Impressions", unit: "number" },
    { id: "profit", label: "Total Profit", unit: "currency" },
    { id: "purchases", label: "Total Purchases", unit: "number" },
    { id: "revenue", label: "Total Revenue", unit: "currency" },
  ];
  const allPriceSortedStrs = [...new Set([...impsByPrice.keys(), ...pursByPrice.keys()])].sort((a, b) => parseFloat(a) - parseFloat(b));
  const priceKpiData: Record<string, Record<string, number>> = {};
  for (const priceStr of allPriceSortedStrs) {
    const imps = impsByPrice.get(priceStr) ?? 0;
    const purs = pursByPrice.get(priceStr) ?? 0;
    const price = parseFloat(priceStr);
    const convRate = imps > 0 ? purs / imps : 0;
    const totalRevenue = parseFloat((purs * price).toFixed(2));
    const totalProfit = parseFloat((purs * (price - cost)).toFixed(2));
    priceKpiData[priceStr] = {
      impressions: imps,
      purchases: purs,
      conversion_rate: parseFloat((convRate * 100).toFixed(2)),
      revenue: totalRevenue,
      profit: totalProfit,
      revenue_per_impression: imps > 0 ? parseFloat((totalRevenue / imps).toFixed(4)) : 0,
      profit_per_impression: imps > 0 ? parseFloat((totalProfit / imps).toFixed(4)) : 0,
    };
  }
  const priceKpi: ProductPriceKpiData = {
    pricePoints: allPriceSortedStrs.map((p) => parseFloat(p)),
    currency: "USD",
    metrics: priceKpiMetrics,
    data: priceKpiData,
  };

  // ---- dailyImpressions ---- build date range covering the full experiment
  // Include today — unlike the ongoing view (where today's partial bar looks odd), here
  // the user explicitly requested this experiment's data so we show everything we have.
  // Compare by date string, not timestamp — otherwise the loop can stop before today when
  // the experiment start time is later in the day than the current time (e.g. started at
  // 14:00 UTC, current time 10:00 UTC → today@14:00 > now, so today would be excluded).
  const expDates: string[] = [];
  const endDateStr = isoDate(endDate);
  for (let d = new Date(experimentDate); isoDate(d) <= endDateStr; d.setUTCDate(d.getUTCDate() + 1)) {
    expDates.push(isoDate(d));
  }
  // Union with actual impression dates — guarantees impression data always shows even if
  // there's a timezone edge case causing a date to fall outside the generated range.
  const allImpDateStrs = allImpressions.map((imp) => isoDate(imp.Datetime));
  const filteredDates = [...new Set([...expDates, ...allImpDateStrs])].sort();
  const impsByDatePrice = new Map<string, Map<string, number>>();
  for (const imp of allImpressions) {
    const day = isoDate(imp.Datetime);
    const byPrice = impsByDatePrice.get(day) ?? new Map<string, number>();
    impsByDatePrice.set(day, byPrice);
    const k = imp.Price.toString();
    byPrice.set(k, (byPrice.get(k) ?? 0) + 1);
  }
  const dailyImpressions: DailyPriceImpressionsData = {
    dates: filteredDates,
    pricePoints: allPriceSortedStrs.map((p) => parseFloat(p)),
    currency: "USD",
    counts: filteredDates.map((date) =>
      allPriceSortedStrs.map((priceStr) => impsByDatePrice.get(date)?.get(priceStr) ?? 0),
    ),
  };

  // ---- priceImpact ----
  const priceImpact: Omit<ProductImpactEntry, "productId" | "productTitle"> = {
    hasCostData,
    daysRunning,
    isShortExperiment,
    experimentDatetimeSubmitted: experimentDatetime,
    minPrice: minPrice || parseFloat(snapshots?.VariantPrice?.toString() ?? "0"),
    maxPrice,
    totalImpressions,
    bestProfitPrice: bestProfitStat?.price ?? null,
    worstProfitPrice: worstProfitStat?.price ?? null,
    bestProfitPerImpression: bestProfitPerImp,
    worstProfitPerImpression: worstProfitPerImp,
    profitPerImpressionPctDiff,
    revenueBest: stats.length > 0 ? toScenario(byRevenue[0]) : { revenue: 0, cost: 0, profit: 0 },
    revenueWorst: stats.length > 0 ? toScenario(byRevenue[byRevenue.length - 1]) : { revenue: 0, cost: 0, profit: 0 },
    profitBest: stats.length > 0 ? toScenario(byProfit[0]) : { revenue: 0, cost: 0, profit: 0 },
    profitWorst: stats.length > 0 ? toScenario(byProfit[byProfit.length - 1]) : { revenue: 0, cost: 0, profit: 0 },
  };

  const row: HistoryRowStats = {
    productId,
    productTitle: snapshots?.ProductTitle ?? productId,
    experimentDatetimeSubmitted: experimentDatetime,
    endedAt: isActive ? null : endDate.toISOString(),
    status: live?.Status ?? "Active",
    daysRunning,
    isShortExperiment,
    hasCostData,
    basePrice: parseFloat(snapshots?.VariantPrice?.toString() ?? "0"),
    minPrice: minPrice || parseFloat(snapshots?.VariantPrice?.toString() ?? "0"),
    maxPrice,
    totalImpressions,
    bestProfitPrice: bestProfitStat?.price ?? null,
    worstProfitPrice: worstProfitStat?.price ?? null,
    bestProfitPerImpression: bestProfitPerImp,
    worstProfitPerImpression: worstProfitPerImp,
    profitPerImpressionPctDiff,
    priceKpi,
    dailyImpressions,
    priceImpact,
  };

  return Response.json({ row });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const productId = url.searchParams.get("productId");
  const experimentDatetime = url.searchParams.get("experimentDatetime");

  if (action === "row" && productId && experimentDatetime) {
    return handleRow(session.shop, productId, experimentDatetime);
  }
  return handleList(session.shop);
}
