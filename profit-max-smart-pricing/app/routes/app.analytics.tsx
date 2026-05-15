import { useCallback, useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { authenticate } from "../shopify.server";
import { fetchAnalyticsData } from "../services/analytics.server";
import type {
  AnalyticsData,
  CompletedExperiment,
  HistoryRowStats,
  Metric,
  ProductImpactEntry,
  PriceImpactData,
  ScenarioValues,
} from "../services/stub-data";

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

const BEST_PROFIT_COLOR = "#50B83C";
const BEST_COST_COLOR = "#2C6B2F";
const WORST_PROFIT_COLOR = "#F49342";
const WORST_COST_COLOR = "#BF5C00";
const PRICE_POINT_BAR_COLOR = "#47C1BF";

const SHORT_EXPERIMENT_OPACITY = 0.65;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: number, unit: Metric["unit"]): string {
  if (unit === "percentage") return `${value}%`;
  if (unit === "currency") return `$${value.toLocaleString()}`;
  return value.toLocaleString();
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCurrencyPerWeek(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortDateFull(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function buildXAxisTicks(dates: string[], maxTicks = 8): string[] {
  const step = Math.ceil(dates.length / maxTicks);
  return dates.filter((_, i) => i % step === 0);
}

function shortTitle(title: string, max = 16): string {
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
}

// ---------------------------------------------------------------------------
// Shared chart components
// ---------------------------------------------------------------------------

function ImpactCharts({
  priceImpact,
  impactMode,
  toggleButton,
  heading1 = "Price impact potential (all products)",
  description1,
}: {
  priceImpact: PriceImpactData;
  impactMode: "revenue" | "profit";
  toggleButton: (mode: "revenue" | "profit", label: string) => React.ReactNode;
  heading1?: string;
  description1?: string;
}) {
  const aggImpact = priceImpact.aggregate;
  const aggregateImpactData = [{
    label: "All products",
    best_cost: impactMode === "revenue" ? aggImpact.revenueBest.cost : 0,
    best_profit: impactMode === "revenue" ? aggImpact.revenueBest.profit : aggImpact.profitBest.profit,
    worst_cost: impactMode === "revenue" ? aggImpact.revenueWorst.cost : 0,
    worst_profit: impactMode === "revenue" ? aggImpact.revenueWorst.profit : aggImpact.profitWorst.profit,
  }];

  const MIN_BAR_WIDTH = 90;
  const productImpactData = priceImpact.byProduct.map((entry) => ({
    label: shortTitle(entry.productTitle),
    isShort: entry.isShortExperiment,
    best_cost: impactMode === "revenue" ? entry.revenueBest.cost : 0,
    best_profit: impactMode === "revenue" ? entry.revenueBest.profit : entry.profitBest.profit,
    worst_cost: impactMode === "revenue" ? entry.revenueWorst.cost : 0,
    worst_profit: impactMode === "revenue" ? entry.revenueWorst.profit : entry.profitWorst.profit,
  }));
  const needsScroll = productImpactData.length > 10;
  const productImpactScrollWidth = Math.max(400, productImpactData.length * MIN_BAR_WIDTH);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#212b36" }}>
          Overall Price Effects
        </h2>
        <div style={{ display: "flex", gap: "8px" }}>
          {toggleButton("revenue", "Revenue & Costs")}
          {toggleButton("profit", "Profit")}
        </div>
      </div>

      {priceImpact.hasShortExperiment && (
        <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#fdf6e3", border: "1px solid #f4d87c", borderRadius: "4px", fontSize: 13, color: "#7d5a00" }}>
          * One or more products have fewer than 7 days of data — their bars are shown muted and weekly projections may not be reliable.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
        {/* Chart 1: Aggregate */}
        <s-section heading={heading1}>
          <s-paragraph>
            {description1 ?? (
              <>
                Projected {impactMode === "revenue" ? "revenue and costs" : "profit"} over the selected period
                if the best or worst price point for each product had served all visitors,
                based on each product&apos;s actual experiment data.
              </>
            )}
          </s-paragraph>
          <div style={{ width: "100%", height: 300, marginTop: "8px" }}>
            <ResponsiveContainer>
              <BarChart data={aggregateImpactData} margin={{ top: 16, right: 24, left: 16, bottom: 8 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 13, fontWeight: 600 }} />
                <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11 }} width={72} />
                <Tooltip formatter={(v) => formatCurrencyPerWeek(Number(v))} />
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
                      <LabelList dataKey="best_profit" position="top" style={{ fontSize: 11, fontWeight: 600 }} formatter={(v: unknown) => formatCurrency(v as number)} />
                    </Bar>
                    <Bar dataKey="worst_profit" name="Worst price profit" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                      <LabelList dataKey="worst_profit" position="top" style={{ fontSize: 11, fontWeight: 600 }} formatter={(v: unknown) => formatCurrency(v as number)} />
                    </Bar>
                  </>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>

        {/* Chart 2: Per-product */}
        <s-section heading="Price impact potential by product">
          <s-paragraph>
            Same projection broken down by product.{needsScroll ? " Scroll horizontally to see all products." : ""}
          </s-paragraph>
          <div style={{ overflowX: needsScroll ? "auto" : "visible", marginTop: "8px" }}>
            <div style={{ width: needsScroll ? productImpactScrollWidth : "100%", height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={productImpactData} margin={{ top: 16, right: 16, left: 16, bottom: 8 }} barCategoryGap="25%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 11 }} width={72} />
                  <Tooltip formatter={(v) => formatCurrencyPerWeek(Number(v))} />
                  <Legend />
                  {impactMode === "revenue" ? (
                    <>
                      <Bar dataKey="best_cost" name="Best: Cost" stackId="best" fill={BEST_COST_COLOR}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={BEST_COST_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                      <Bar dataKey="best_profit" name="Best: Profit" stackId="best" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={BEST_PROFIT_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                      <Bar dataKey="worst_cost" name="Worst: Cost" stackId="worst" fill={WORST_COST_COLOR}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={WORST_COST_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                      <Bar dataKey="worst_profit" name="Worst: Profit" stackId="worst" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={WORST_PROFIT_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                    </>
                  ) : (
                    <>
                      <Bar dataKey="best_profit" name="Best price profit" fill={BEST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={BEST_PROFIT_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                      <Bar dataKey="worst_profit" name="Worst price profit" fill={WORST_PROFIT_COLOR} radius={[3, 3, 0, 0]}>
                        {productImpactData.map((entry, i) => <Cell key={i} fill={WORST_PROFIT_COLOR} fillOpacity={entry.isShort ? SHORT_EXPERIMENT_OPACITY : 1} />)}
                      </Bar>
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </s-section>
      </div>
    </>
  );
}

function PerProductCharts({
  productOptions,
  selectedProductId,
  setSelectedProductId,
  selectedPriceKpi,
  productBarData,
  selectedDailyImps,
  allocationBarData,
  allocationXAxisTicks,
  selectedPriceMetric,
  setSelectedPriceMetric,
  allocationMode,
  setAllocationMode,
}: {
  productOptions: Array<{ id: string; title: string }>;
  selectedProductId: string;
  setSelectedProductId: (id: string) => void;
  selectedPriceKpi: ReturnType<typeof Object.values<AnalyticsData["productPriceKpi"][string]>> | undefined;
  productBarData: Array<Record<string, unknown>>;
  selectedDailyImps: AnalyticsData["dailyPriceImpressions"][string] | undefined;
  allocationBarData: Array<Record<string, unknown>>;
  allocationXAxisTicks: string[];
  selectedPriceMetric: string;
  setSelectedPriceMetric: (id: string) => void;
  allocationMode: "percentage" | "absolute";
  setAllocationMode: (m: "percentage" | "absolute") => void;
}) {
  const activeMetric = (selectedPriceKpi as AnalyticsData["productPriceKpi"][string] | undefined)?.metrics.find((m) => m.id === selectedPriceMetric)
    ?? (selectedPriceKpi as AnalyticsData["productPriceKpi"][string] | undefined)?.metrics[0];
  const typedPriceKpi = selectedPriceKpi as AnalyticsData["productPriceKpi"][string] | undefined;
  const typedDailyImps = selectedDailyImps as AnalyticsData["dailyPriceImpressions"][string] | undefined;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#212b36", whiteSpace: "nowrap" }}>
          Per Product Stats
        </h2>
        <div style={{ width: "660px", flexShrink: 0 }}>
          <s-select label="" value={selectedProductId} onChange={(e: Event) => setSelectedProductId((e.target as HTMLSelectElement).value)}>
            {productOptions.map((p) => (
              <s-option key={p.id} value={p.id}>{p.title}</s-option>
            ))}
          </s-select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <s-section heading="Performance by price point">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
            <select
              value={selectedPriceMetric}
              onChange={(e) => setSelectedPriceMetric(e.target.value)}
              style={{ padding: "4px 8px", fontSize: 13, borderRadius: "4px", border: "1px solid #c4cdd5", background: "#fff", cursor: "pointer" }}
            >
              {(typedPriceKpi?.metrics ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <BarChart data={productBarData} margin={{ top: 16, right: 16, left: 16, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(v) => activeMetric ? formatValue(Number(v), activeMetric.unit) : v} />
                <Tooltip formatter={(value) => [activeMetric ? formatValue(Number(value), activeMetric.unit) : value, activeMetric?.label ?? selectedPriceMetric]} />
                {activeMetric && (
                  <Bar dataKey={activeMetric.id} name={activeMetric.label} fill={PRICE_POINT_BAR_COLOR} radius={[3, 3, 0, 0]}>
                    <LabelList dataKey={activeMetric.id} position="top" style={{ fontSize: 11, fontWeight: 600 }} formatter={(v: unknown) => formatValue(v as number, activeMetric.unit)} />
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>

        <s-section heading="Daily impressions by price">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px" }}>
            <select
              value={allocationMode}
              onChange={(e) => setAllocationMode(e.target.value as "percentage" | "absolute")}
              style={{ padding: "4px 8px", fontSize: 13, borderRadius: "4px", border: "1px solid #c4cdd5", background: "#fff", cursor: "pointer" }}
            >
              <option value="percentage">% of daily impressions</option>
              <option value="absolute">Daily impressions</option>
            </select>
          </div>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={allocationBarData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }} barCategoryGap="10%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" ticks={allocationXAxisTicks} tickFormatter={shortDate} tick={{ fontSize: 11 }} />
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
                    allocationMode === "percentage" ? `${Number(value).toFixed(1)}%` : String(value),
                    String(name).replace("price_", "$"),
                  ]}
                />
                <Legend
                  content={() => (
                    <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "12px", fontSize: 12, paddingTop: 4 }}>
                      {[...(typedDailyImps?.pricePoints ?? [])].sort((a, b) => a - b).map((price, idx) => (
                        <span key={price} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: 10, height: 10, borderRadius: 2, background: CHART_COLORS[idx % CHART_COLORS.length], flexShrink: 0 }} />
                          ${price}
                        </span>
                      ))}
                    </div>
                  )}
                />
                {[...(typedDailyImps?.pricePoints ?? [])].sort((a, b) => a - b).map((price: number, idx: number) => (
                  <Bar key={price} dataKey={`price_${price}`} name={`price_${price}`} stackId="stack" fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// History table row
// ---------------------------------------------------------------------------

function HistoryTableRow({
  row,
  isSelected,
  onSelect,
  onRemove,
  availableExperiments,
  onChangeExperiment,
}: {
  row: HistoryRowStats;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  availableExperiments: CompletedExperiment[];
  onChangeExperiment: (newDatetime: string) => void;
}) {
  const pctDiff = row.profitPerImpressionPctDiff;
  const pctLabel = pctDiff !== null ? `+${pctDiff}%` : "—";

  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: "pointer",
        background: isSelected ? "#f4f6ff" : undefined,
        borderLeft: isSelected ? "3px solid #5C6AC4" : "3px solid transparent",
      }}
    >
      <td style={tdStyle}>
        {row.productTitle}
        {row.isShortExperiment && <span title="Fewer than 7 days of data — weekly projection may not be reliable" style={{ color: "#bf5c00", marginLeft: 4, fontWeight: 700 }}>*</span>}
      </td>
      <td style={tdStyle}>
        <span style={{
          display: "inline-block", padding: "2px 8px", borderRadius: "12px", fontSize: 12, fontWeight: 600,
          background: row.status === "Active" ? "#e3f1df" : row.status === "Paused" ? "#fdf6e3" : "#faf0f0",
          color: row.status === "Active" ? "#108043" : row.status === "Paused" ? "#7d5a00" : "#bf5c00",
        }}>
          {row.status}
        </span>
      </td>
      <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
        {availableExperiments.length > 1 ? (
          <select
            value={row.experimentDatetimeSubmitted}
            onChange={(e) => onChangeExperiment(e.target.value)}
            style={{ padding: "2px 6px", fontSize: 13, borderRadius: "4px", border: "1px solid #c4cdd5", background: "#fff", cursor: "pointer" }}
          >
            {availableExperiments.map((e) => (
              <option key={e.experimentDatetimeSubmitted} value={e.experimentDatetimeSubmitted}>
                {shortDateFull(e.experimentDatetimeSubmitted)} ({e.status})
              </option>
            ))}
          </select>
        ) : shortDateFull(row.experimentDatetimeSubmitted)}
      </td>
      <td style={tdStyle}>{row.endedAt ? shortDateFull(row.endedAt) : "—"}</td>
      <td style={tdStyle}>{row.daysRunning}d</td>
      <td style={tdStyle}>{formatCurrency(row.basePrice)}</td>
      <td style={tdStyle}>{formatCurrency(row.minPrice)} – {formatCurrency(row.maxPrice)}</td>
      <td style={tdStyle}>{row.totalImpressions.toLocaleString()}</td>
      <td style={tdStyle}>{row.bestProfitPrice !== null ? `$${row.bestProfitPrice}${row.bestProfitPerImpression !== null ? ` ($${row.bestProfitPerImpression.toFixed(2)})` : ""}` : "—"}</td>
      <td style={tdStyle}>{row.worstProfitPrice !== null ? `$${row.worstProfitPrice}${row.worstProfitPerImpression !== null ? ` ($${row.worstProfitPerImpression.toFixed(2)})` : ""}` : "—"}</td>
      <td style={{ ...tdStyle, color: pctDiff !== null && pctDiff > 0 ? "#108043" : "#212b36", fontWeight: 600 }}>{pctLabel}</td>
      <td style={tdStyle}>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#637381", fontSize: 16, lineHeight: 1, padding: "2px 6px" }}
          title="Remove"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

const tdStyle: React.CSSProperties = { padding: "10px 12px", fontSize: 13, borderBottom: "1px solid #e1e3e5", verticalAlign: "middle" };
const thStyle: React.CSSProperties = { padding: "8px 12px", fontSize: 12, fontWeight: 600, color: "#637381", borderBottom: "2px solid #e1e3e5", textAlign: "left", whiteSpace: "nowrap" };

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const { allAnalytics } = useLoaderData<typeof loader>();

  // -- Ongoing state --
  const [analytics, setAnalytics] = useState<AnalyticsData>(allAnalytics["7d"]);
  const [period, setPeriod] = useState("7d");
  const [impactMode, setImpactMode] = useState<"revenue" | "profit">("revenue");
  const [selectedProductId, setSelectedProductId] = useState(allAnalytics["7d"].productOptions[0]?.id ?? "");
  const [selectedPriceMetric, setSelectedPriceMetric] = useState(
    allAnalytics["7d"].productPriceKpi[allAnalytics["7d"].productOptions[0]?.id ?? ""]?.metrics[0]?.id ?? "profit_per_impression",
  );
  const [allocationMode, setAllocationMode] = useState<"percentage" | "absolute">("percentage");

  // -- View toggle --
  const [view, setView] = useState<"ongoing" | "past">("ongoing");

  // -- History state --
  const [completedExperiments, setCompletedExperiments] = useState<CompletedExperiment[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<{ id: number; row: HistoryRowStats }[]>([]);
  const [historyRowsLoading, setHistoryRowsLoading] = useState<Set<string>>(new Set());
  const [selectedHistoryKey, setSelectedHistoryKey] = useState<number | null>(null);
  const nextRowIdRef = useRef(0);
  const [ongoingTableCollapsed, setOngoingTableCollapsed] = useState(false);
  const [historyTableCollapsed, setHistoryTableCollapsed] = useState(false);
  const [addProductValue, setAddProductValue] = useState("");

  // Impact mode shared between views
  const [historyImpactMode, setHistoryImpactMode] = useState<"revenue" | "profit">("revenue");

  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    setAnalytics(allAnalytics[newPeriod as keyof typeof allAnalytics]);
  };

  const { aggregateKpi, productOptions, productPriceKpi, dailyPriceImpressions, priceImpact } = analytics;

  // -- Ongoing chart data --
  const selectedPriceKpi = productPriceKpi[selectedProductId];
  const productBarData = selectedPriceKpi
    ? selectedPriceKpi.pricePoints.map((price) => ({ label: `$${price}`, ...selectedPriceKpi.data[price.toString()] }))
    : [];

  const selectedDailyImps = dailyPriceImpressions[selectedProductId];
  const allocationBarData = selectedDailyImps
    ? selectedDailyImps.dates.map((date, di) => {
        const counts = selectedDailyImps.pricePoints.map((_: number, pi: number) => selectedDailyImps.counts[di]?.[pi] ?? 0);
        const total = counts.reduce((s: number, v: number) => s + v, 0);
        const entry: Record<string, number | string> = { date };
        selectedDailyImps.pricePoints.forEach((price: number, pi: number) => {
          const val = counts[pi] ?? 0;
          entry[`price_${price}`] = allocationMode === "percentage" && total > 0 ? parseFloat(((val / total) * 100).toFixed(1)) : val;
        });
        return entry;
      })
    : [];
  const allocationXAxisTicks = buildXAxisTicks(selectedDailyImps?.dates ?? []);

  // -- History: load experiment list when Past tab is first opened --
  const loadCompletedExperiments = useCallback(async () => {
    if (completedExperiments !== null) return;
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/analytics-history?action=list");
      const json = await res.json() as { experiments: CompletedExperiment[] };
      setCompletedExperiments(json.experiments);
    } finally {
      setHistoryLoading(false);
    }
  }, [completedExperiments]);

  useEffect(() => {
    if (view === "past") loadCompletedExperiments();
  }, [view, loadCompletedExperiments]);

  // -- History: add a product row (no duplicate guard — user can add same product multiple times) --
  const addHistoryRow = useCallback(async (productId: string, experimentDatetime: string) => {
    const loadingKey = `${productId}|${experimentDatetime}|${Date.now()}`;
    const newId = nextRowIdRef.current++;
    setHistoryRowsLoading((prev) => new Set(prev).add(loadingKey));
    try {
      const res = await fetch(`/api/analytics-history?action=row&productId=${encodeURIComponent(productId)}&experimentDatetime=${encodeURIComponent(experimentDatetime)}`);
      const json = await res.json() as { row: HistoryRowStats };
      setHistoryRows((prev) => [...prev, { id: newId, row: json.row }]);
      setSelectedHistoryKey((prev) => prev === null ? newId : prev);
    } finally {
      setHistoryRowsLoading((prev) => { const s = new Set(prev); s.delete(loadingKey); return s; });
    }
  }, []);

  const removeHistoryRow = (id: number) => {
    const remaining = historyRows.filter((r) => r.id !== id);
    setHistoryRows(remaining);
    if (selectedHistoryKey === id) setSelectedHistoryKey(remaining[0]?.id ?? null);
  };

  const changeHistoryRowExperiment = useCallback(async (rowId: number, productId: string, newDatetime: string) => {
    const loadingKey = `${productId}|${newDatetime}|${Date.now()}`;
    const newId = nextRowIdRef.current++;
    setHistoryRows((prev) => prev.filter((r) => r.id !== rowId));
    if (selectedHistoryKey === rowId) setSelectedHistoryKey(null);
    setHistoryRowsLoading((prev) => new Set(prev).add(loadingKey));
    try {
      const res = await fetch(`/api/analytics-history?action=row&productId=${encodeURIComponent(productId)}&experimentDatetime=${encodeURIComponent(newDatetime)}`);
      const json = await res.json() as { row: HistoryRowStats };
      setHistoryRows((prev) => [...prev, { id: newId, row: json.row }]);
      setSelectedHistoryKey(newId);
    } finally {
      setHistoryRowsLoading((prev) => { const s = new Set(prev); s.delete(loadingKey); return s; });
    }
  }, [selectedHistoryKey]);

  // -- History: aggregate priceImpact across all table rows --
  const historyPriceImpact: PriceImpactData | null = historyRows.length > 0 ? (() => {
    const entries: ProductImpactEntry[] = historyRows.map(({ row: r }) => ({
      productId: r.productId,
      productTitle: r.productTitle,
      ...r.priceImpact,
    }));
    const sum = (key: keyof Omit<ProductImpactEntry, "productId" | "productTitle" | "hasCostData" | "daysRunning" | "isShortExperiment">): ScenarioValues =>
      entries.reduce((acc, e) => ({
        revenue: acc.revenue + (e[key] as ScenarioValues).revenue,
        cost: acc.cost + (e[key] as ScenarioValues).cost,
        profit: acc.profit + (e[key] as ScenarioValues).profit,
      }), { revenue: 0, cost: 0, profit: 0 });
    return {
      hasCostData: entries.some((e) => e.hasCostData),
      hasShortExperiment: entries.some((e) => e.isShortExperiment),
      aggregate: { revenueBest: sum("revenueBest"), revenueWorst: sum("revenueWorst"), profitBest: sum("profitBest"), profitWorst: sum("profitWorst") },
      byProduct: entries,
    };
  })() : null;

  // -- History: selected row detail --
  const selectedHistoryRow = historyRows.find(({ id }) => id === selectedHistoryKey)?.row;

  // -- History: per-product chart data derived from selected row --
  const historyPriceKpi = selectedHistoryRow?.priceKpi;
  const historyProductBarData = historyPriceKpi
    ? historyPriceKpi.pricePoints.map((price) => ({ label: `$${price}`, ...historyPriceKpi.data[price.toString()] }))
    : [];
  const historyDailyImps = selectedHistoryRow?.dailyImpressions;
  const historyAllocationBarData = historyDailyImps
    ? historyDailyImps.dates.map((date, di) => {
        const counts = historyDailyImps.pricePoints.map((_: number, pi: number) => historyDailyImps.counts[di]?.[pi] ?? 0);
        const total = counts.reduce((s: number, v: number) => s + v, 0);
        const entry: Record<string, number | string> = { date };
        historyDailyImps.pricePoints.forEach((price: number, pi: number) => {
          const val = counts[pi] ?? 0;
          entry[`price_${price}`] = allocationMode === "percentage" && total > 0 ? parseFloat(((val / total) * 100).toFixed(1)) : val;
        });
        return entry;
      })
    : [];
  const historyAllocationXAxisTicks = buildXAxisTicks(historyDailyImps?.dates ?? []);

  // -- Group experiments by product for dropdown + in-row pickers --
  const experimentsByProduct = new Map<string, CompletedExperiment[]>();
  for (const e of completedExperiments ?? []) {
    const list = experimentsByProduct.get(e.productId) ?? [];
    list.push(e);
    experimentsByProduct.set(e.productId, list);
  }
  // Sort each product's list newest-first
  for (const [pid, exps] of experimentsByProduct) {
    experimentsByProduct.set(pid, [...exps].sort((a, b) => b.experimentDatetimeSubmitted.localeCompare(a.experimentDatetimeSubmitted)));
  }
  // Unique products for the main dropdown — one entry per product (the newest experiment)
  const productsAvailableToAdd = [...experimentsByProduct.values()].map((exps) => exps[0]);

  // -- Shared UI helpers --
  const divider = <div style={{ borderBottom: "1px solid #e1e3e5", margin: "4px 0 20px" }} />;

  const makeToggleButton = (currentMode: "revenue" | "profit", setMode: (m: "revenue" | "profit") => void) =>
    (mode: "revenue" | "profit", label: string) => (
      <button
        key={mode}
        onClick={() => setMode(mode)}
        style={{
          padding: "6px 14px", borderRadius: "4px", border: "1px solid #c4cdd5",
          background: currentMode === mode ? "#5C6AC4" : "#fff",
          color: currentMode === mode ? "#fff" : "#212b36",
          fontWeight: 600, fontSize: 13, cursor: "pointer",
        }}
      >
        {label}
      </button>
    );

  const viewTabStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 20px", borderRadius: "4px", border: "1px solid #c4cdd5",
    background: active ? "#5C6AC4" : "#fff",
    color: active ? "#fff" : "#212b36",
    fontWeight: 600, fontSize: 14, cursor: "pointer",
  });

  return (
    <s-page heading="Analytics" inlineSize="large">
      {/* ------------------------------------------------------------------ */}
      {/* View toggle + global time period (ongoing only)                     */}
      {/* ------------------------------------------------------------------ */}
      <s-section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", gap: "8px" }}>
            <button style={viewTabStyle(view === "ongoing")} onClick={() => setView("ongoing")}>Ongoing Experiments</button>
            <button style={viewTabStyle(view === "past")} onClick={() => setView("past")}>Past Experiments</button>
          </div>
          {view === "ongoing" && (
            <s-select
              label="Time period"
              value={period}
              onChange={(e: Event) => handlePeriodChange((e.target as HTMLSelectElement).value)}
            >
              {aggregateKpi.timePeriods.map((tp) => (
                <s-option key={tp.value} value={tp.value}>{tp.label}</s-option>
              ))}
            </s-select>
          )}
        </div>
      </s-section>

      {divider}

      {/* ================================================================== */}
      {/* ONGOING VIEW                                                        */}
      {/* ================================================================== */}
      {view === "ongoing" && (
        <>
          {/* Collapsible active experiments summary table */}
          {priceImpact && priceImpact.byProduct.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#212b36" }}>
                  Active experiments ({priceImpact.byProduct.length})
                </h3>
                <button
                  onClick={() => setOngoingTableCollapsed((v) => !v)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#5C6AC4", fontWeight: 600 }}
                >
                  {ongoingTableCollapsed ? "Expand ▾" : "Collapse ▴"}
                </button>
              </div>
              {!ongoingTableCollapsed && (
                <div style={{ overflowX: "auto", borderRadius: "4px", border: "1px solid #e1e3e5" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f9fafb" }}>
                        <th style={thStyle}>Product</th>
                        <th style={thStyle}>Started</th>
                        <th style={thStyle}>Days running</th>
                        <th style={thStyle}>Price range</th>
                        <th style={thStyle}>Total impressions</th>
                        <th style={thStyle}>Best price (profit/imp)</th>
                        <th style={thStyle}>Worst price (profit/imp)</th>
                        <th style={thStyle}>Best vs worst</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceImpact.byProduct.map((entry) => {
                        const pctDiff = entry.profitPerImpressionPctDiff;
                        return (
                          <tr key={entry.productId} style={{ borderBottom: "1px solid #e1e3e5" }}>
                            <td style={tdStyle}>
                              {entry.productTitle}
                              {entry.isShortExperiment && <span title="Fewer than 7 days — projection may not be reliable" style={{ color: "#bf5c00", marginLeft: 4, fontWeight: 700 }}>*</span>}
                            </td>
                            <td style={tdStyle}>{shortDateFull(entry.experimentDatetimeSubmitted)}</td>
                            <td style={tdStyle}>{entry.daysRunning}d</td>
                            <td style={tdStyle}>{formatCurrency(entry.minPrice)} – {formatCurrency(entry.maxPrice)}</td>
                            <td style={tdStyle}>{entry.totalImpressions.toLocaleString()}</td>
                            <td style={tdStyle}>{entry.bestProfitPrice !== null ? `$${entry.bestProfitPrice}${entry.bestProfitPerImpression !== null ? ` ($${entry.bestProfitPerImpression.toFixed(2)})` : ""}` : "—"}</td>
                            <td style={tdStyle}>{entry.worstProfitPrice !== null ? `$${entry.worstProfitPrice}${entry.worstProfitPerImpression !== null ? ` ($${entry.worstProfitPerImpression.toFixed(2)})` : ""}` : "—"}</td>
                            <td style={{ ...tdStyle, color: pctDiff !== null && pctDiff > 0 ? "#108043" : "#212b36", fontWeight: 600 }}>
                              {pctDiff !== null ? `+${pctDiff}%` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {priceImpact.hasShortExperiment && (
                    <div style={{ padding: "8px 12px", fontSize: 12, color: "#7d5a00", borderTop: "1px solid #e1e3e5", background: "#fdf6e3" }}>
                      * Fewer than 7 days of data — weekly projection may not be reliable
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {divider}

          {priceImpact ? (
            <ImpactCharts
              priceImpact={priceImpact}
              impactMode={impactMode}
              toggleButton={makeToggleButton(impactMode, setImpactMode)}
            />
          ) : (
            <s-section>
              <s-paragraph>
                No active experiments with impression data yet. Price impact projections will appear once visitors have been served experiment prices.
              </s-paragraph>
            </s-section>
          )}

          {divider}

          <PerProductCharts
            productOptions={productOptions}
            selectedProductId={selectedProductId}
            setSelectedProductId={setSelectedProductId}
            selectedPriceKpi={selectedPriceKpi as never}
            productBarData={productBarData}
            selectedDailyImps={selectedDailyImps as never}
            allocationBarData={allocationBarData}
            allocationXAxisTicks={allocationXAxisTicks}
            selectedPriceMetric={selectedPriceMetric}
            setSelectedPriceMetric={setSelectedPriceMetric}
            allocationMode={allocationMode}
            setAllocationMode={setAllocationMode}
          />
        </>
      )}

      {/* ================================================================== */}
      {/* PAST VIEW                                                           */}
      {/* ================================================================== */}
      {view === "past" && (
        <>
          {/* Add a product selector */}
          <div style={{ marginBottom: "16px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ flex: 1, maxWidth: 400 }}>
              <select
                value={addProductValue}
                onChange={(e) => {
                  const productId = e.target.value;
                  if (!productId) return;
                  setAddProductValue("");
                  // Always add the newest experiment for this product
                  const sorted = experimentsByProduct.get(productId) ?? [];
                  const toAdd = sorted[0];
                  if (toAdd) addHistoryRow(toAdd.productId, toAdd.experimentDatetimeSubmitted);
                }}
                style={{ width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: "4px", border: "1px solid #c4cdd5", background: "#fff", cursor: "pointer" }}
                disabled={historyLoading || productsAvailableToAdd.length === 0}
              >
                <option value="">
                  {historyLoading ? "Loading…" : productsAvailableToAdd.length === 0 ? "No experiments found" : "Add a product…"}
                </option>
                {productsAvailableToAdd.map((p) => (
                  <option key={p.productId} value={p.productId}>
                    {p.productTitle}
                  </option>
                ))}
              </select>
            </div>
            {historyRowsLoading.size > 0 && <span style={{ fontSize: 13, color: "#637381" }}>Loading…</span>}
          </div>

          {/* Summary table */}
          {historyRows.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#212b36" }}>
                  Selected experiments ({historyRows.length})
                </h3>
                <button
                  onClick={() => setHistoryTableCollapsed((v) => !v)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#5C6AC4", fontWeight: 600 }}
                >
                  {historyTableCollapsed ? "Expand ▾" : "Collapse ▴"}
                </button>
              </div>
              {!historyTableCollapsed && (
                <div style={{ overflowX: "auto", borderRadius: "4px", border: "1px solid #e1e3e5" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f9fafb" }}>
                        <th style={thStyle}>Product</th>
                        <th style={thStyle}>Status</th>
                        <th style={thStyle}>Experiment start</th>
                        <th style={thStyle}>Ended</th>
                        <th style={thStyle}>Duration</th>
                        <th style={thStyle}>Base price</th>
                        <th style={thStyle}>Price range</th>
                        <th style={thStyle}>Total impressions</th>
                        <th style={thStyle}>Best price (profit/imp)</th>
                        <th style={thStyle}>Worst price (profit/imp)</th>
                        <th style={thStyle}>Best vs worst</th>
                        <th style={thStyle}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRows.map(({ id, row }) => (
                        <HistoryTableRow
                          key={id}
                          row={row}
                          isSelected={selectedHistoryKey === id}
                          onSelect={() => setSelectedHistoryKey(id)}
                          onRemove={() => removeHistoryRow(id)}
                          availableExperiments={experimentsByProduct.get(row.productId) ?? []}
                          onChangeExperiment={(newDatetime) => changeHistoryRowExperiment(id, row.productId, newDatetime)}
                        />
                      ))}
                    </tbody>
                  </table>
                  {historyRows.some(({ row }) => row.isShortExperiment) && (
                    <div style={{ padding: "8px 12px", fontSize: 12, color: "#7d5a00", borderTop: "1px solid #e1e3e5", background: "#fdf6e3" }}>
                      * Fewer than 7 days of data — weekly projection may not be reliable
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {historyRows.length === 0 && !historyLoading && (
            <s-section>
              <s-paragraph>Add a past experiment above to see its performance charts and compare across experiments.</s-paragraph>
            </s-section>
          )}

          {/* Overall price effects — aggregate across all table rows */}
          {historyPriceImpact && (
            <>
              {divider}
              <ImpactCharts
                priceImpact={historyPriceImpact}
                impactMode={historyImpactMode}
                toggleButton={makeToggleButton(historyImpactMode, setHistoryImpactMode)}
                heading1="Projected weekly price effect (selected experiments)"
                description1="Projected weekly profit if the best or worst price point for each selected experiment had served all visitors. Values are normalised to a weekly rate to allow comparison across experiments of different lengths."
              />
            </>
          )}

          {/* Per-product detail for selected row */}
          {selectedHistoryRow && (
            <>
              {divider}
              <PerProductCharts
                productOptions={historyRows.map(({ id, row: r }) => ({ id: String(id), title: `${r.productTitle} (${shortDateFull(r.experimentDatetimeSubmitted)})` }))}
                selectedProductId={String(selectedHistoryKey)}
                setSelectedProductId={(idStr) => setSelectedHistoryKey(Number(idStr))}
                selectedPriceKpi={historyPriceKpi as never}
                productBarData={historyProductBarData}
                selectedDailyImps={historyDailyImps as never}
                allocationBarData={historyAllocationBarData}
                allocationXAxisTicks={historyAllocationXAxisTicks}
                selectedPriceMetric={selectedPriceMetric}
                setSelectedPriceMetric={setSelectedPriceMetric}
                allocationMode={allocationMode}
                setAllocationMode={setAllocationMode}
              />
            </>
          )}
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
