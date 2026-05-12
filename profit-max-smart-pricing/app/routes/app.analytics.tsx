import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchAnalyticsData } from "../services/analytics.server";
import type { AnalyticsData, Metric } from "../services/stub-data";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [data7d, data14d, data30d] = await Promise.all([
    fetchAnalyticsData(session.shop, "7d"),
    fetchAnalyticsData(session.shop, "14d"),
    fetchAnalyticsData(session.shop, "30d"),
  ]);
  return { allAnalytics: { "7d": data7d, "14d": data14d, "30d": data30d } };
};

// ---------------------------------------------------------------------------
// Chart colour palette
// ---------------------------------------------------------------------------
const CHART_COLORS = [
  "#5C6AC4",
  "#47C1BF",
  "#F49342",
  "#50B83C",
  "#9C6ADE",
  "#DE3618",
];

// Best/worst scenario colours
const BEST_PROFIT_COLOR = "#50B83C";   // green
const BEST_COST_COLOR = "#2C6B2F";     // dark green (cost is darker than profit)
const WORST_PROFIT_COLOR = "#F49342";  // orange
const WORST_COST_COLOR = "#BF5C00";    // dark orange

// Single-metric price point bar
const PRICE_POINT_BAR_COLOR = "#47C1BF"; // teal

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: number, unit: Metric["unit"]): string {
  if (unit === "percentage") return `${value}%`;
  if (unit === "currency") return `$${value.toLocaleString()}`;
  return value.toLocaleString();
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString()}`;
}

/** Shorten ISO date "2026-03-28" → "Mar 28" */
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Show every Nth tick on x-axis to avoid crowding
function buildXAxisTicks(dates: string[], maxTicks = 8): string[] {
  const step = Math.ceil(dates.length / maxTicks);
  return dates.filter((_, i) => i % step === 0);
}

// Truncate long product titles for chart labels
function shortTitle(title: string, max = 16): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const { allAnalytics } = useLoaderData<typeof loader>();

  const [analytics, setAnalytics] = useState<AnalyticsData>(allAnalytics["7d"]);
  const [period, setPeriod] = useState("7d");
  const [impactMode, setImpactMode] = useState<"revenue" | "profit">("revenue");
  const [selectedProductId, setSelectedProductId] = useState(
    allAnalytics["7d"].productOptions[0]?.id ?? "",
  );
  const [selectedPriceMetric, setSelectedPriceMetric] = useState(
    allAnalytics["7d"].productPriceKpi[allAnalytics["7d"].productOptions[0]?.id ?? ""]?.metrics[0]?.id ?? "profit_per_impression",
  );
  const [allocationMode, setAllocationMode] = useState<"percentage" | "absolute">("percentage");

  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    setAnalytics(allAnalytics[newPeriod as keyof typeof allAnalytics]);
  };

  const { aggregateKpi, productOptions, productPriceKpi, dailyPriceImpressions, priceImpact } =
    analytics;

  // ---------------------------------------------------------------------------
  // Row 1: Price impact potential chart data
  // ---------------------------------------------------------------------------

  // Aggregate chart: single group with best_ / worst_ prefixed keys (same shape as per-product)
  const aggImpact = priceImpact?.aggregate;
  const aggregateImpactData = aggImpact
    ? [{
        label: "All products",
        best_cost: impactMode === "revenue" ? aggImpact.revenueBest.cost : 0,
        best_profit: impactMode === "revenue" ? aggImpact.revenueBest.profit : aggImpact.profitBest.profit,
        worst_cost: impactMode === "revenue" ? aggImpact.revenueWorst.cost : 0,
        worst_profit: impactMode === "revenue" ? aggImpact.revenueWorst.profit : aggImpact.profitWorst.profit,
      }]
    : [];

  // Per-product chart: one group per product, each with best + worst bars
  const MIN_BAR_WIDTH = 90; // px per product group
  const productImpactData = (priceImpact?.byProduct ?? []).map((entry) => ({
    label: shortTitle(entry.productTitle),
    best_cost: impactMode === "revenue" ? entry.revenueBest.cost : 0,
    best_profit: impactMode === "revenue" ? entry.revenueBest.profit : entry.profitBest.profit,
    worst_cost: impactMode === "revenue" ? entry.revenueWorst.cost : 0,
    worst_profit: impactMode === "revenue" ? entry.revenueWorst.profit : entry.profitWorst.profit,
  }));
  const productImpactScrollWidth = Math.max(
    400,
    productImpactData.length * MIN_BAR_WIDTH,
  );
  const needsScroll = productImpactData.length > 10;

  // ---------------------------------------------------------------------------
  // Row 2: Per-product price point + traffic charts
  // ---------------------------------------------------------------------------

  const selectedPriceKpi = productPriceKpi[selectedProductId];
  const productBarData = selectedPriceKpi
    ? selectedPriceKpi.pricePoints.map((price) => ({
        label: `$${price}`,
        ...selectedPriceKpi.data[price.toString()],
      }))
    : [];

  const selectedDailyImps = dailyPriceImpressions[selectedProductId];
  const allocationBarData = selectedDailyImps
    ? selectedDailyImps.dates.map((date, di) => {
        const counts = selectedDailyImps.pricePoints.map(
          (_: number, pi: number) => selectedDailyImps.counts[di]?.[pi] ?? 0,
        );
        const total = counts.reduce((s: number, v: number) => s + v, 0);
        const entry: Record<string, number | string> = { date };
        selectedDailyImps.pricePoints.forEach((price: number, pi: number) => {
          const val = counts[pi] ?? 0;
          entry[`price_${price}`] =
            allocationMode === "percentage" && total > 0
              ? parseFloat(((val / total) * 100).toFixed(1))
              : val;
        });
        return entry;
      })
    : [];

  const allocationXAxisTicks = buildXAxisTicks(selectedDailyImps?.dates ?? []);

  const divider = (
    <div style={{ borderBottom: "1px solid #e1e3e5", margin: "4px 0 20px" }} />
  );

  const toggleButton = (mode: "revenue" | "profit", label: string) => (
    <button
      onClick={() => setImpactMode(mode)}
      style={{
        padding: "6px 14px",
        borderRadius: "4px",
        border: "1px solid #c4cdd5",
        background: impactMode === mode ? "#5C6AC4" : "#fff",
        color: impactMode === mode ? "#fff" : "#212b36",
        fontWeight: 600,
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <s-page heading="Analytics" inlineSize="large">
      {/* ------------------------------------------------------------------ */}
      {/* Global control: time period                                         */}
      {/* ------------------------------------------------------------------ */}
      <s-section>
        <s-select
          label="Time period"
          value={period}
          onChange={(e: Event) =>
            handlePeriodChange((e.target as HTMLSelectElement).value)
          }
        >
          {aggregateKpi.timePeriods.map((tp) => (
            <s-option key={tp.value} value={tp.value}>
              {tp.label}
            </s-option>
          ))}
        </s-select>
      </s-section>

      {divider}

      {/* ------------------------------------------------------------------ */}
      {/* Row 1: Price impact potential charts                                */}
      {/* ------------------------------------------------------------------ */}
      {/* Section header + toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#212b36" }}>
          Overall Price Effects
        </h2>
        <div style={{ display: "flex", gap: "8px" }}>
          {toggleButton("revenue", "Revenue & Costs")}
          {toggleButton("profit", "Profit")}
        </div>
      </div>

      {priceImpact ? (
        <>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginBottom: "16px",
            }}
          >
            {/* Row 1, Chart 1: Aggregate best vs worst */}
            <s-section heading="Price impact potential (all products)">
              <s-paragraph>
                Projected{" "}
                {impactMode === "revenue" ? "revenue and costs" : "profit"} if the best or
                worst price point for each product had served all visitors this period.
              </s-paragraph>
              <div style={{ width: "100%", height: 300, marginTop: "8px" }}>
                <ResponsiveContainer>
                  <BarChart
                    data={aggregateImpactData}
                    margin={{ top: 16, right: 24, left: 16, bottom: 8 }}
                    barCategoryGap="30%"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 13, fontWeight: 600 }} />
                    <YAxis
                      tickFormatter={formatCurrency}
                      tick={{ fontSize: 11 }}
                      width={72}
                    />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Legend />
                    {impactMode === "revenue" ? (
                      <>
                        <Bar dataKey="best_cost" name="Best: Cost" stackId="best" fill={BEST_COST_COLOR} />
                        <Bar dataKey="best_profit" name="Best: Profit" stackId="best" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="worst_cost" name="Worst: Cost" stackId="worst" fill={WORST_COST_COLOR} />
                        <Bar dataKey="worst_profit" name="Worst: Profit" stackId="worst" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                      </>
                    ) : (
                      <>
                        <Bar dataKey="best_profit" name="Best price profit" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                          <LabelList
                            dataKey="best_profit"
                            position="top"
                            style={{ fontSize: 11, fontWeight: 600 }}
                            formatter={(v: unknown) => formatCurrency(v as number)}
                          />
                        </Bar>
                        <Bar dataKey="worst_profit" name="Worst price profit" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                          <LabelList
                            dataKey="worst_profit"
                            position="top"
                            style={{ fontSize: 11, fontWeight: 600 }}
                            formatter={(v: unknown) => formatCurrency(v as number)}
                          />
                        </Bar>
                      </>
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </s-section>

            {/* Row 1, Chart 2: Per-product best vs worst */}
            <s-section heading="Price impact potential by product">
              <s-paragraph>
                Same projection broken down by product.{" "}
                {needsScroll ? "Scroll horizontally to see all products." : ""}
              </s-paragraph>
              <div
                style={{
                  overflowX: needsScroll ? "auto" : "visible",
                  marginTop: "8px",
                }}
              >
                <div style={{ width: needsScroll ? productImpactScrollWidth : "100%", height: 300 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={productImpactData}
                      margin={{ top: 16, right: 16, left: 16, bottom: 8 }}
                      barCategoryGap="25%"
                      barGap={2}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis
                        tickFormatter={formatCurrency}
                        tick={{ fontSize: 11 }}
                        width={72}
                      />
                      <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                      <Legend />
                      {impactMode === "revenue" ? (
                        <>
                          <Bar dataKey="best_cost" name="Best: Cost" stackId="best" fill={BEST_COST_COLOR} />
                          <Bar dataKey="best_profit" name="Best: Profit" stackId="best" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                          <Bar dataKey="worst_cost" name="Worst: Cost" stackId="worst" fill={WORST_COST_COLOR} />
                          <Bar dataKey="worst_profit" name="Worst: Profit" stackId="worst" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                        </>
                      ) : (
                        <>
                          <Bar dataKey="best_profit" name="Best price profit" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                          <Bar dataKey="worst_profit" name="Worst price profit" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]} />
                        </>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </s-section>
          </div>
        </>
      ) : (
        <s-section>
          <s-paragraph>
            No active experiments with impression data yet. Price impact
            projections will appear once visitors have been served experiment
            prices.
          </s-paragraph>
        </s-section>
      )}

      {divider}

      {/* ------------------------------------------------------------------ */}
      {/* Row 2: Per-product charts                                           */}
      {/* ------------------------------------------------------------------ */}
      {/* Section header + product selector */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#212b36", whiteSpace: "nowrap" }}>
          Per Product Stats
        </h2>
        <div style={{ width: "660px", flexShrink: 0 }}>
          <s-select
            label=""
            value={selectedProductId}
            onChange={(e: Event) =>
              setSelectedProductId((e.target as HTMLSelectElement).value)
            }
          >
            {productOptions.map((p) => (
              <s-option key={p.id} value={p.id}>
                {p.title}
              </s-option>
            ))}
          </s-select>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
        }}
      >
        {/* Row 2, Chart 1: Per-product price point — single metric */}
        <s-section heading="Performance by price point">
          {(() => {
            const activeMetric = selectedPriceKpi?.metrics.find((m) => m.id === selectedPriceMetric)
              ?? selectedPriceKpi?.metrics[0];
            return (
              <>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
                  <select
                    value={selectedPriceMetric}
                    onChange={(e) => setSelectedPriceMetric(e.target.value)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 13,
                      borderRadius: "4px",
                      border: "1px solid #c4cdd5",
                      background: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    {(selectedPriceKpi?.metrics ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ width: "100%", height: 300 }}>
                  <ResponsiveContainer>
                    <BarChart
                      data={productBarData}
                      margin={{ top: 16, right: 16, left: 16, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        width={64}
                        tickFormatter={(v) => activeMetric ? formatValue(Number(v), activeMetric.unit) : v}
                      />
                      <Tooltip
                        formatter={(value) => [
                          activeMetric ? formatValue(Number(value), activeMetric.unit) : value,
                          activeMetric?.label ?? selectedPriceMetric,
                        ]}
                      />
                      {activeMetric && (
                        <Bar
                          dataKey={activeMetric.id}
                          name={activeMetric.label}
                          fill={PRICE_POINT_BAR_COLOR}
                          radius={[3, 3, 0, 0]}
                        >
                          <LabelList
                            dataKey={activeMetric.id}
                            position="top"
                            style={{ fontSize: 11, fontWeight: 600 }}
                            formatter={(v: unknown) => formatValue(v as number, activeMetric.unit)}
                          />
                        </Bar>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            );
          })()}
        </s-section>

        {/* Row 2, Chart 2: Daily impressions by price — stacked bar */}
        <s-section heading="Daily impressions by price">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
            <select
              value={allocationMode}
              onChange={(e) => setAllocationMode(e.target.value as "percentage" | "absolute")}
              style={{
                padding: "4px 8px",
                fontSize: 13,
                borderRadius: "4px",
                border: "1px solid #c4cdd5",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              <option value="percentage">% of daily impressions</option>
              <option value="absolute">Daily impressions</option>
            </select>
          </div>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart
                data={allocationBarData}
                margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                barCategoryGap="10%"
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  ticks={allocationXAxisTicks}
                  tickFormatter={shortDate}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  tickFormatter={(v) => allocationMode === "percentage" ? `${v}%` : String(v)}
                  domain={allocationMode === "percentage" ? [0, 100] : ["auto", "auto"]}
                  ticks={allocationMode === "percentage" ? [0, 25, 50, 75, 100] : undefined}
                  tick={{ fontSize: 11 }}
                  width={40}
                />
                <Tooltip
                  labelFormatter={(label: unknown) => shortDate(String(label))}
                  formatter={(value, name) => [
                    allocationMode === "percentage"
                      ? `${Number(value).toFixed(1)}%`
                      : String(value),
                    String(name).replace("price_", "$"),
                  ]}
                />
                <Legend
                  content={() => (
                    <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "12px", fontSize: 12, paddingTop: 4 }}>
                      {[...(selectedDailyImps?.pricePoints ?? [])].sort((a, b) => a - b).map((price, idx) => (
                        <span key={price} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: 10, height: 10, borderRadius: 2, background: CHART_COLORS[idx % CHART_COLORS.length], flexShrink: 0 }} />
                          ${price}
                        </span>
                      ))}
                    </div>
                  )}
                />
                {[...(selectedDailyImps?.pricePoints ?? [])].sort((a, b) => a - b).map((price: number, idx: number) => (
                  <Bar
                    key={price}
                    dataKey={`price_${price}`}
                    name={`price_${price}`}
                    stackId="stack"
                    fill={CHART_COLORS[idx % CHART_COLORS.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
