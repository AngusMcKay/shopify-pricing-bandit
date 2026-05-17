import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { HeroBanner } from "../components/HeroBanner";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchantId = session.shop;

  const [activeExperiments, banditParams, costInputs] = await Promise.all([
    db.experimentLive.findMany({
      where: { MerchantId: merchantId, Status: "Active" },
      select: { ProductId: true, ExperimentDatetimeSubmitted: true },
    }),
    // BanditParameters is pre-aggregated by the daily bandit run — fast at any scale
    db.banditParameters.findMany({
      where: { MerchantId: merchantId },
      select: { ProductId: true, Price: true, TotalImpressions: true, TotalPurchases: true },
    }),
    db.experimentMerchantInputs.findMany({
      where: { MerchantId: merchantId, ExperimentParameter: "CostOfProduction" },
      select: { ProductId: true, ExperimentParameterValue: true },
    }),
  ]);

  const activeProductIds = new Set(activeExperiments.map((e) => e.ProductId));
  const productsEnrolled = activeProductIds.size;

  const oldestStart = activeExperiments.reduce<Date | null>((oldest, e) => {
    return oldest === null || e.ExperimentDatetimeSubmitted < oldest ? e.ExperimentDatetimeSubmitted : oldest;
  }, null);
  const daysRunning = oldestStart
    ? Math.round((Date.now() - oldestStart.getTime()) / 86400000)
    : 0;

  const costByProduct = new Map(costInputs.map((c) => [c.ProductId, parseFloat(c.ExperimentParameterValue)]));

  const paramsByProduct = new Map<string, typeof banditParams>();
  for (const p of banditParams) {
    if (!activeProductIds.has(p.ProductId)) continue;
    const rows = paramsByProduct.get(p.ProductId) ?? [];
    rows.push(p);
    paramsByProduct.set(p.ProductId, rows);
  }

  const upliftPcts: number[] = [];
  for (const [productId, rows] of paramsByProduct) {
    const cost = costByProduct.get(productId) ?? 0;
    const ppis = rows
      .filter((r) => r.TotalImpressions > 0)
      .map((r) => (r.TotalPurchases / r.TotalImpressions) * (parseFloat(r.Price.toString()) - cost));
    if (ppis.length < 2) continue;
    const best = Math.max(...ppis);
    const worst = Math.min(...ppis);
    if (worst === 0) continue;
    upliftPcts.push(((best - worst) / Math.abs(worst)) * 100);
  }

  const avgProfitUplift = upliftPcts.length > 0
    ? `+${Math.round(upliftPcts.reduce((a, b) => a + b, 0) / upliftPcts.length)}%`
    : null;

  return { stats: { productsEnrolled, daysRunning, avgProfitUplift } };
};

const divider = (
  <div style={{ borderBottom: "1px solid #e8e3d9", margin: "24px 0" }} />
);

function StatBox({ value, label, color, info }: { value: string | number; label: string; color?: string; info?: string }) {
  return (
    <div style={{
      padding: "16px 20px",
      border: "1px solid #e8e3d9",
      borderRadius: "8px",
      background: "#faf8f4",
    }}>
      <div style={{ fontSize: "2rem", fontWeight: 700, color: color ?? "#1c1c1a", lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: "#7a7a72", marginTop: 4 }}>
        {label}
        {info && (
          <span title={info} style={{ cursor: "help", marginLeft: 5 }}>ⓘ</span>
        )}
      </div>
    </div>
  );
}

function ContentSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "#2e3f36" }}>{heading}</h2>
      <div style={{ fontSize: 14, lineHeight: 1.65, color: "#4a4a45" }}>{children}</div>
    </div>
  );
}

export default function Home() {
  const { stats } = useLoaderData<typeof loader>();

  return (
    <>
      <HeroBanner />
      <s-page heading="" inlineSize="large">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 22%", gap: "24px", alignItems: "start" }}>
          <s-section>
          <ContentSection heading="How it works">
            <p style={{ margin: "0 0 10px" }}>
              Profit Max continuously tests multiple price points for your products and
              automatically shifts more traffic toward the prices that perform best —
              without you having to lift a finger.
            </p>
            <p style={{ margin: 0 }}>
              Unlike traditional A/B tests, there is no fixed "winner" phase. The
              algorithm keeps adapting as customer behaviour changes with seasons,
              trends, promotions, and competitor activity. When you're ready, check
              the analytics page to see which prices performed best — then set the
              winner as a permanent price.
            </p>
          </ContentSection>

          {divider}

          <ContentSection heading="Multi-armed bandit vs. A/B testing">
            <p style={{ margin: "0 0 10px" }}>
              A traditional A/B test splits your traffic 50/50 and waits weeks for
              a statistically significant winner. Half your customers see a worse
              price for the entire duration of the test.
            </p>
            <p style={{ margin: "0 0 10px" }}>
              The multi-armed bandit approach starts exploring multiple price points
              simultaneously and immediately shifts traffic toward what is working.
              Prices that underperform get less and less traffic over time —
              so you learn faster and start benefiting from the most profitable prices sooner.
            </p>
            <p style={{ margin: 0 }}>
              A/B testing also requires dedicated time and multiple rounds to iterate
              over many options. A bandit approach is more click-and-go: once you
              activate a product, the algorithm does all the ongoing work. You can
              leave it running permanently, constantly testing price points and
              adapting as things change. Or cancel at any point and review the
              analytics to see which prices worked best — then set a permanent price
              with confidence.
            </p>
          </ContentSection>

          {divider}

          <ContentSection heading="Not dynamic pricing">
            <p style={{ margin: 0 }}>
              Profit Max is not dynamic pricing. It does not adjust prices based on
              individual customer circumstances — there is no surge pricing, no
              personalised offers, and no attempt to extract maximum willingness to
              pay from individual shoppers. Every visitor gets assigned a randomly
              chosen price from the price points being tested. Profit Max is simply
              an efficient way to test many price points across all your visitors
              and find which one works best for your business.
            </p>
          </ContentSection>

          {divider}

          <ContentSection heading="About the creator">
            <p style={{ margin: 0 }}>
              Profit Max was built by Angus McKay. I've spent 15 years as a data
              science and analytics professional, building pricing, discount, and
              recommendation systems for commercial enterprises. More recently,
              I've turned my attention to smaller-scale local operations — including
              setting up a coworking space and growing it by optimising its
              subscription structure. Profit Max is the result of applying those
              same techniques in a form any Shopify merchant can use.
            </p>
          </ContentSection>
          </s-section>

          <div>
            <s-section heading="Experiment status">
              <s-stack direction="block" gap="base">
                <StatBox value={stats.productsEnrolled} label="Products enrolled" />
                <StatBox value={stats.daysRunning} label="Days running" />
                <StatBox
                  value={stats.avgProfitUplift ?? "Awaiting data"}
                  label="Avg. profit uplift (best vs worst price)"
                  color={stats.avgProfitUplift ? "#3d5548" : undefined}
                  info={stats.avgProfitUplift ? undefined : "This figure will appear after the first daily optimisation routine has run following an experiment launch, provided at least one product has impressions and purchases recorded against two or more price points."}
                />
              </s-stack>
            </s-section>
          </div>
        </div>
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
