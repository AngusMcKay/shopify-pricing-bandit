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

export default function Overview() {
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
            trends, and promotions.
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
            so you learn faster and lose less revenue while learning.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Profit optimisation">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            By default, Profit Max optimises for revenue — the price that generates
            the most total sales income. If you enter a cost of production for a
            product, the algorithm shifts to optimising for profit instead, factoring
            in your margins.
          </s-paragraph>
          <s-paragraph>
            This means a slightly lower-volume price point that maintains better
            margins can outrank a high-volume, low-margin option. Great for products
            where margin matters more than top-line sales.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Regional variation">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Price sensitivity varies by market. Enable regional variation on any
            product and Profit Max will run independent optimisation per country or
            region, finding the right price for each market rather than forcing a
            global compromise.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Get started">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-button variant="primary">
              <s-link href="/app/products">Set up products</s-link>
            </s-button>
            <s-button variant="secondary">
              <s-link href="/app/analytics">View analytics</s-link>
            </s-button>
            <s-button variant="tertiary">
              <s-link href="/app/docs">Read the docs</s-link>
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
