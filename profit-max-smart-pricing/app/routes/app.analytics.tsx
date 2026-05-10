import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
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
// Chart colour palette (Polaris-inspired)
// ---------------------------------------------------------------------------
const CHART_COLORS = [
  "#5C6AC4",
  "#47C1BF",
  "#F49342",
  "#50B83C",
  "#9C6ADE",
  "#DE3618",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: number, unit: Metric["unit"]): string {
  if (unit === "percentage") return `${value}%`;
  if (unit === "currency") return `$${value.toLocaleString()}`;
  return value.toLocaleString();
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const { allAnalytics } = useLoaderData<typeof loader>();

  const [analytics, setAnalytics] = useState<AnalyticsData>(allAnalytics["7d"]);
  const [period, setPeriod] = useState("7d");
  const [selectedProductId, setSelectedProductId] = useState(
    allAnalytics["7d"].productOptions[0]?.id ?? "",
  );
  const [lineMetricId, setLineMetricId] = useState(
    allAnalytics["7d"].kpiTimeSeries?.metrics[0]?.id ?? "",
  );

  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    const newData = allAnalytics[newPeriod as keyof typeof allAnalytics];
    setAnalytics(newData);
    if (!newData.kpiTimeSeries?.metrics.find((m) => m.id === lineMetricId)) {
      setLineMetricId(newData.kpiTimeSeries?.metrics[0]?.id ?? "");
    }
  };

  const { aggregateKpi, kpiTimeSeries, productOptions, productPriceKpi, trafficAllocation } =
    analytics;

  // ---------------------------------------------------------------------------
  // Build chart datasets
  // ---------------------------------------------------------------------------

  // Row 1 Chart 1: aggregate grouped bar data
  // Format: [{ label: 'Best variant', conversion_rate: 4.2, revenue: 1840, ... }, ...]
  const aggregateBarData = aggregateKpi.categories.map((cat) => ({
    label: cat.label,
    ...aggregateKpi.data[cat.id],
  }));

  // Row 1 Chart 2: KPI time series line data
  // Format: [{ date: '2026-03-05', conversion_rate: 2.8, ... }, ...]
  const lineData = kpiTimeSeries
    ? kpiTimeSeries.dates.map((date, i) => ({
        date,
        ...Object.fromEntries(
          kpiTimeSeries.metrics.map((m) => [m.id, kpiTimeSeries.series[m.id]?.[i] ?? 0]),
        ),
      }))
    : [];

  // Row 2 Chart 1: per-product price point bar data
  const selectedPriceKpi = productPriceKpi[selectedProductId];
  const productBarData = selectedPriceKpi
    ? selectedPriceKpi.pricePoints.map((price) => ({
        label: `$${price}`,
        ...selectedPriceKpi.data[price.toString()],
      }))
    : [];

  // Row 2 Chart 2: traffic allocation stacked area data
  // Format: [{ date: '2026-03-05', price_44.99: 20, price_48.9: 20, ... }, ...]
  const selectedTraffic = trafficAllocation[selectedProductId];
  const trafficAreaData = selectedTraffic
    ? selectedTraffic.dates.map((date, dayIdx) => ({
        date,
        ...Object.fromEntries(
          selectedTraffic.pricePoints.map((price, pi) => [
            `price_${price}`,
            selectedTraffic.allocations[dayIdx]?.[pi] ?? 0,
          ]),
        ),
      }))
    : [];

  const lineXAxisTicks = buildXAxisTicks(kpiTimeSeries?.dates ?? []);
  const trafficXAxisTicks = buildXAxisTicks(selectedTraffic?.dates ?? []);

  return (
    <s-page heading="Analytics" inlineSize="large">
      {/* ------------------------------------------------------------------ */}
      {/* Time period selector                                                */}
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

      {/* ------------------------------------------------------------------ */}
      {/* Row 1: Aggregate charts                                             */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: kpiTimeSeries ? "1fr 1fr" : "1fr",
          gap: "16px",
          marginBottom: "16px",
        }}
      >
        {/* Row 1, Chart 1: Aggregate grouped bar chart */}
        <s-section heading="Aggregate performance by variant">
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart
                data={aggregateBarData}
                margin={{ top: 24, right: 16, left: 16, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                {/* No YAxis — values labelled directly on bars */}
                <Tooltip
                  formatter={(value, name) => {
                    const metric = aggregateKpi.metrics.find(
                      (m) => m.label === name,
                    );
                    return [
                      metric ? formatValue(Number(value), metric.unit) : value,
                      name,
                    ];
                  }}
                />
                <Legend />
                {aggregateKpi.metrics.map((metric, idx) => (
                  <Bar
                    key={metric.id}
                    dataKey={metric.id}
                    name={metric.label}
                    fill={CHART_COLORS[idx % CHART_COLORS.length]}
                    radius={[3, 3, 0, 0]}
                  >
                    <LabelList
                      dataKey={metric.id}
                      position="top"
                      style={{ fontSize: 11, fontWeight: 600 }}
                      formatter={(v: unknown) => formatValue(v as number, metric.unit)}
                    />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>

        {/* Row 1, Chart 2: KPI over time — only rendered if data provided */}
        {kpiTimeSeries && (
          <s-section heading="KPI trend over time">
            <s-stack direction="block" gap="base">
              {kpiTimeSeries.metrics.length > 1 && (
                <s-select
                  label="Metric"
                  value={lineMetricId}
                  onChange={(e: Event) =>
                    setLineMetricId((e.target as HTMLSelectElement).value)
                  }
                >
                  {kpiTimeSeries.metrics.map((m) => (
                    <s-option key={m.id} value={m.id}>
                      {m.label}
                    </s-option>
                  ))}
                </s-select>
              )}
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer>
                  <LineChart
                    data={lineData}
                    margin={{ top: 8, right: 24, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      ticks={lineXAxisTicks}
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => {
                        const metric = kpiTimeSeries.metrics.find(
                          (m) => m.id === lineMetricId,
                        );
                        return metric ? formatValue(v, metric.unit) : v;
                      }}
                      width={56}
                    />
                    <Tooltip
                      labelFormatter={(label: unknown) => shortDate(String(label))}
                      formatter={(value) => {
                        const metric = kpiTimeSeries.metrics.find(
                          (m) => m.id === lineMetricId,
                        );
                        return [
                          metric
                            ? formatValue(Number(value), metric.unit)
                            : value,
                          metric?.label ?? lineMetricId,
                        ];
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey={lineMetricId}
                      stroke={CHART_COLORS[0]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </s-stack>
          </s-section>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Row 2: Per-product charts                                           */}
      {/* ------------------------------------------------------------------ */}
      <s-section>
        <s-select
          label="Product"
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
      </s-section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
        }}
      >
        {/* Row 2, Chart 1: Per-product price point grouped bar */}
        <s-section heading="Performance by price point">
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <BarChart
                data={productBarData}
                margin={{ top: 24, right: 16, left: 16, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value, name) => {
                    const metric = selectedPriceKpi?.metrics.find(
                      (m) => m.label === name,
                    );
                    return [
                      metric ? formatValue(Number(value), metric.unit) : value,
                      name,
                    ];
                  }}
                />
                <Legend />
                {(selectedPriceKpi?.metrics ?? []).map((metric, idx) => (
                  <Bar
                    key={metric.id}
                    dataKey={metric.id}
                    name={metric.label}
                    fill={CHART_COLORS[idx % CHART_COLORS.length]}
                    radius={[3, 3, 0, 0]}
                  >
                    <LabelList
                      dataKey={metric.id}
                      position="top"
                      style={{ fontSize: 11, fontWeight: 600 }}
                      formatter={(v: unknown) => formatValue(v as number, metric.unit)}
                    />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </s-section>

        {/* Row 2, Chart 2: Traffic allocation 100% stacked area */}
        <s-section heading="Traffic allocation over time">
          <s-paragraph>
            Shows how the algorithm is shifting traffic toward better-performing
            prices over time.
          </s-paragraph>
          <div style={{ width: "100%", height: 280, marginTop: "8px" }}>
            <ResponsiveContainer>
              <AreaChart
                data={trafficAreaData}
                margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  ticks={trafficXAxisTicks}
                  tickFormatter={shortDate}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  tickFormatter={(v) => `${v}%`}
                  domain={[0, 100]}
                  tick={{ fontSize: 11 }}
                  width={40}
                />
                <Tooltip
                  labelFormatter={(label: unknown) => shortDate(String(label))}
                  formatter={(value, name) => [
                    `${Number(value).toFixed(1)}%`,
                    String(name).replace("price_", "$"),
                  ]}
                />
                <Legend
                  formatter={(value) =>
                    String(value).replace("price_", "$")
                  }
                />
                {(selectedTraffic?.pricePoints ?? []).map((price, idx) => (
                  <Area
                    key={price}
                    type="monotone"
                    dataKey={`price_${price}`}
                    name={`price_${price}`}
                    stackId="traffic"
                    fill={CHART_COLORS[idx % CHART_COLORS.length]}
                    stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                    fillOpacity={0.85}
                  />
                ))}
              </AreaChart>
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
