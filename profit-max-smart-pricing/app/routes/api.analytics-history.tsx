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
import type { HistoryRowStats, ScenarioValues, ProductImpactEntry } from "../services/stub-data";

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
      select: { Price: true },
    }),
    db.purchases.findMany({
      where: { MerchantId: merchantId, ProductId: productId, ExperimentDatetimeSubmitted: experimentDate },
      select: { Price: true },
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
