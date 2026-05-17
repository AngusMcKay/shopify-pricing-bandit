import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fetchOverviewStats } from "../services/stub-data";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const stats = await fetchOverviewStats();
  return { stats };
};


export default function Home() {
  const { stats } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Profit Max: Smart Pricing">
      <s-section heading="Your experiment status" slot="aside">
        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-100">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>
                {stats.activeExperiments}
              </div>
              <s-paragraph>Active experiments</s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-100">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>
                {stats.productsEnrolled}
              </div>
              <s-paragraph>Products enrolled</s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-100">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>
                {stats.daysRunning}
              </div>
              <s-paragraph>Days running</s-paragraph>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-100">
              <div style={{ fontSize: "2rem", fontWeight: 700, color: "#108043" }}>
                {stats.avgRevenueUplift}
              </div>
              <s-paragraph>Avg. revenue uplift</s-paragraph>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <div style={{
        background: "linear-gradient(135deg, #1a3a5c 0%, #2d6a9f 100%)",
        borderRadius: "8px",
        padding: "48px 40px 36px",
        marginBottom: "4px",
        textAlign: "center",
      }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>
          Profit Max: Automated Price Optimisation
        </h1>
        <p style={{ margin: "0 0 28px", fontSize: 15, color: "rgba(255,255,255,0.7)", fontWeight: 400 }}>
          By PodencoLabs
        </p>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", fontSize: 15, fontWeight: 600 }}>
          <a href="/app/products" style={{ color: "#fff", textDecoration: "none", opacity: 0.9 }}>Set up products</a>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <a href="/app/analytics" style={{ color: "#fff", textDecoration: "none", opacity: 0.9 }}>View analytics</a>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <a href="/app/docs" style={{ color: "#fff", textDecoration: "none", opacity: 0.9 }}>Read the docs</a>
        </div>
      </div>

      <s-section heading="How it works">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Profit Max continuously tests multiple price points for your products and
            automatically shifts more traffic toward the prices that perform best —
            without you having to lift a finger.
          </s-paragraph>
          <s-paragraph>
            Unlike traditional A/B tests, there is no fixed "winner" phase. The
            algorithm keeps adapting as customer behaviour changes with seasons,
            trends, promotions, and competitor activity. When you're ready, check
            the analytics page to see which prices performed best — then set the
            winner as a permanent price.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Multi-armed bandit vs. A/B testing">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A traditional A/B test splits your traffic 50/50 and waits weeks for
            a statistically significant winner. Half your customers see a worse
            price for the entire duration of the test.
          </s-paragraph>
          <s-paragraph>
            The multi-armed bandit approach starts exploring multiple price points
            simultaneously and immediately shifts traffic toward what is working.
            Prices that underperform get less and less traffic over time —
            so you learn faster and start benefiting from the most profitable prices sooner.
          </s-paragraph>
          <s-paragraph>
            A/B testing also requires dedicated time and multiple rounds to iterate
            over many options. A bandit approach is more click-and-go: once you
            activate a product, the algorithm does all the ongoing work. You can
            leave it running permanently, constantly testing price points and
            adapting as things change. Or cancel at any point and review the
            analytics to see which prices worked best — then set a permanent price
            with confidence.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Not dynamic pricing">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Profit Max is not dynamic pricing. It does not adjust prices based on
            individual customer circumstances — there is no surge pricing, no
            personalised offers, and no attempt to extract maximum willingness to
            pay from individual shoppers. Every visitor gets assigned a randomly
            chosen price from the price points being tested. Profit Max is simply an efficient way to test many price
            points across all your visitors and find which one works best for your
            business.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="About the creator">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Profit Max was built by Angus McKay. I've spent 15 years as a data
            science and analytics professional, building pricing, discount, and
            recommendation systems for commercial enterprises. More recently,
            I've turned my attention to smaller-scale local operations — including
            setting up a coworking space and growing it by optimising its
            subscription structure. Profit Max is the result of applying those
            same techniques in a form any Shopify merchant can use.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
