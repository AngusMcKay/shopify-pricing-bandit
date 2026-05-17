import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { AppBanner } from "../components/AppBanner";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function DocsPage() {
  return (
    <>
      <AppBanner activePage="docs" />
      <s-page heading="Documentation & FAQ" inlineSize="large">
      {/* ------------------------------------------------------------------ */}
      {/* Quick navigation                                                    */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="On this page" slot="aside">
        <s-unordered-list>
          <s-list-item>
            <s-link href="#how-it-works">How Profit Max works</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="#first-experiment">Setting up your first experiment</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="#analytics">Reading your analytics</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="#faq">Frequently asked questions</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* How it works                                                        */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="How Profit Max works">
        <s-stack direction="block" gap="base">
          <s-heading>What is a multi-armed bandit?</s-heading>
          <s-paragraph>
            The name comes from the world of casinos — imagine a row of slot machines
            (the "bandits"), each with a different payout rate. You do not know which
            machine pays best, so you have to explore. But you also want to make
            money while you learn, so you should spend more time on machines that
            seem to be paying well and less time on the ones that are not.
          </s-paragraph>
          <s-paragraph>
            Profit Max does exactly this with your product prices. It tests several
            price points simultaneously and continuously shifts more of your customers
            toward whichever prices are converting and generating revenue best — all
            in real time, with no manual work from you.
          </s-paragraph>

          <s-heading>How is this different from a traditional A/B test?</s-heading>
          <s-paragraph>
            A traditional A/B test works like a formal experiment: you split your
            traffic 50/50 between two price points, wait weeks for enough data, then
            declare a winner and move all traffic there. It is rigorous, but it has
            a significant cost — for the entire duration of the test, half your
            customers are seeing the worse price.
          </s-paragraph>
          <s-paragraph>
            Profit Max takes a different approach. Instead of waiting for a winner,
            it starts shifting traffic toward better prices immediately. A price point
            that is clearly underperforming gets less and less traffic over time,
            while top performers attract more. The result: you earn more revenue
            during the learning phase, not just after it.
          </s-paragraph>
          <s-paragraph>
            Another key difference is that bandit optimisation never stops. Customer
            behaviour changes with seasons, trends, competitor activity, and
            promotions. A traditional A/B test gives you a one-time answer. Profit
            Max keeps adapting so your prices stay optimal over time.
          </s-paragraph>

          <s-heading>Profit optimisation</s-heading>
          <s-paragraph>
            By default, Profit Max optimises for revenue — the total value of sales
            generated. If you provide a cost of production for a product, the
            algorithm shifts to optimising for profit instead. This means it will
            favour a price that maintains healthy margins over one that drives high
            volume at a thin margin.
          </s-paragraph>
          <s-paragraph>
            Profit optimisation is optional. If you do not enter a cost of
            production, revenue optimisation applies automatically.
          </s-paragraph>

          <s-heading>Regional variation</s-heading>
          <s-paragraph>
            Customers in different countries often have different price expectations
            and sensitivities. When you enable regional variation for a product,
            Profit Max runs separate optimisation for each of your active markets.
            The best price for the UK might be different from the best price for
            Australia — and this feature lets the algorithm find both independently.
          </s-paragraph>
        </s-stack>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* First experiment                                                    */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Setting up your first experiment">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Getting started takes just a few minutes. Here is the process
            step by step.
          </s-paragraph>

          <s-heading>Step 1 — Go to the Products page</s-heading>
          <s-paragraph>
            Navigate to <s-link href="/app/products">Products</s-link> in the
            app menu. You will see a list of all the products in your Shopify
            store.
          </s-paragraph>

          <s-heading>Step 2 — Choose which products to test</s-heading>
          <s-paragraph>
            Toggle the <s-text type="strong">Include in optimiser</s-text> switch
            for each product you want to include. You can also use the
            <s-text type="strong"> Include all</s-text> button at the top of the
            page to enable all products at once.
          </s-paragraph>
          <s-paragraph>
            We recommend starting with three to five products. Pick ones that
            already have a reasonable level of traffic — the more visitors a
            product gets, the faster the algorithm will learn. See the FAQ below
            for guidance on minimum traffic levels.
          </s-paragraph>

          <s-heading>Step 3 — Set your price range</s-heading>
          <s-paragraph>
            For each product, set a minimum and maximum price. The algorithm
            will test price points within this range. By default, the range is
            your current price minus 10% to your current price plus 10% — a
            reasonable starting point.
          </s-paragraph>
          <s-paragraph>
            If you want to test specific price points rather than a range,
            click <s-text type="strong">Fine-grained controls</s-text> and
            enter your exact prices as a comma-separated list.
          </s-paragraph>

          <s-heading>Step 4 — Optionally add cost of production</s-heading>
          <s-paragraph>
            If you know your cost of production (or landed cost) for a product,
            enter it in the cost field. This enables profit optimisation. You
            will also see a warning if your minimum price is set below cost —
            which would mean selling at a loss.
          </s-paragraph>

          <s-heading>Step 5 — Activate</s-heading>
          <s-paragraph>
            Click the <s-text type="strong">Activate</s-text> button at the
            top of the page. A confirmation screen will show you a summary of
            which products will be enrolled and on what settings. Confirm to
            start the experiment.
          </s-paragraph>
          <s-paragraph>
            The algorithm will begin testing immediately. You can check
            progress on the <s-link href="/app/analytics">Analytics</s-link> page,
            though it typically takes a few days before trends become clear.
          </s-paragraph>
        </s-stack>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Reading your analytics                                              */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Reading your analytics">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The <s-link href="/app/analytics">Analytics</s-link> page gives you
            a clear picture of how your price optimisation is performing.
          </s-paragraph>

          <s-heading>Aggregate performance chart</s-heading>
          <s-paragraph>
            The top-left chart shows how your best, mid, and worst performing
            price variants compare across three metrics: conversion rate (the
            percentage of visitors who made a purchase), revenue (total sales
            value), and profit (where cost data is available).
          </s-paragraph>
          <s-paragraph>
            A healthy experiment will show a clear gap between the best and
            worst variants. If the bars look similar across all three groups,
            the algorithm may still be in an early exploration phase — give it
            a few more days.
          </s-paragraph>

          <s-heading>KPI trend chart</s-heading>
          <s-paragraph>
            The top-right chart shows how your chosen metric has changed over
            time. As the algorithm shifts traffic toward better prices, you
            should see an upward trend in revenue and profit. You can switch
            between metrics using the dropdown above the chart.
          </s-paragraph>

          <s-heading>Per-product price point chart</s-heading>
          <s-paragraph>
            Use the product selector to drill into a specific product. The
            bottom-left chart shows how each individual price point is
            performing, using the same metrics as the aggregate chart above.
            This lets you see exactly which prices are strong and which are
            being phased out.
          </s-paragraph>

          <s-heading>Traffic allocation chart</s-heading>
          <s-paragraph>
            The bottom-right chart is perhaps the most satisfying to watch over
            time. It shows how the algorithm is distributing traffic across
            your price points day by day. At the start, traffic is spread
            roughly evenly across all prices. As the algorithm learns, you will
            see the bands shift — the winning prices expanding while weaker
            ones shrink to a sliver.
          </s-paragraph>
        </s-stack>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* FAQ                                                                 */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Frequently asked questions">
        <s-stack direction="block" gap="large">

          <s-stack direction="block" gap="small-100">
            <s-heading>
              Will the same customer see different prices on different visits?
            </s-heading>
            <s-paragraph>
              No. Once a visitor is shown a price, that price is stored in a
              cookie on their device. Every subsequent visit from the same
              browser will show the same price for the duration of the
              experiment. This ensures a consistent, fair experience for your
              customers.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>
              How much traffic do I need for the optimisation to work?
            </s-heading>
            <s-paragraph>
              The algorithm starts working from day one, but meaningful results
              need enough data to be reliable. As a rough guide:
            </s-paragraph>
            <s-unordered-list>
              <s-list-item>
                <s-text type="strong">Ideal:</s-text> 500+ visits per product
                per week. You will see clear trends within 7–14 days.
              </s-list-item>
              <s-list-item>
                <s-text type="strong">Workable:</s-text> 100–500 visits per
                week. Results will emerge over 2–4 weeks.
              </s-list-item>
              <s-list-item>
                <s-text type="strong">Low traffic:</s-text> Below 100 visits per
                week. The algorithm will still optimise, but it will converge
                slowly. Be patient and give it at least a month.
              </s-list-item>
            </s-unordered-list>
            <s-paragraph>
              Low-traffic products are not penalised — they simply need more
              time to gather data. There is no minimum requirement to use
              the app.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>How does regional variation work?</s-heading>
            <s-paragraph>
              When you enable regional variation for a product, the algorithm
              runs an independent optimisation for each of your active Shopify
              markets. A customer in Germany and a customer in Australia will
              each be allocated to a price point from the optimal distribution
              for their respective market, rather than a global average.
            </s-paragraph>
            <s-paragraph>
              Regional variation requires your store to have multiple markets
              set up in Shopify. If you only have one market, enabling this
              option has no effect.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>
              What is profit optimisation and should I use it?
            </s-heading>
            <s-paragraph>
              Without a cost of production, the app optimises for revenue —
              maximising the total value of sales. This is good for most stores.
            </s-paragraph>
            <s-paragraph>
              If you enter a cost of production, the algorithm switches to
              optimising for profit — maximising revenue minus cost. This means
              it might choose a slightly higher price with better margins over a
              lower price with more volume, if that gives you more money in
              your pocket overall.
            </s-paragraph>
            <s-paragraph>
              Use profit optimisation if your margins vary significantly across
              your price range, or if you have high per-unit costs that eat into
              the benefit of volume discounting. If your margins are fairly
              consistent, revenue optimisation will give you very similar results
              with less setup.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>How do I cancel an experiment?</s-heading>
            <s-paragraph>
              Go to the <s-link href="/app/products">Products</s-link> page and
              disable the toggle for any product you want to remove from
              optimisation. Then click <s-text type="strong">Activate</s-text>{" "}
              to save the change. Alternatively, use{" "}
              <s-text type="strong">Cancel all experiments</s-text> to stop
              everything in one click.
            </s-paragraph>
            <s-paragraph>
              Once a product is removed from optimisation, it will return to
              your standard Shopify price within 24 hours as the cookie-based
              assignments expire.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>Can I run optimisation on all my products at once?</s-heading>
            <s-paragraph>
              Yes. Use the <s-text type="strong">Include all</s-text> button on
              the Products page to enable every product at once. You can then
              review and adjust individual settings before clicking Activate.
            </s-paragraph>
            <s-paragraph>
              That said, we recommend starting with a handful of your best-selling
              products to build confidence in the results before rolling out more
              broadly.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>What happens to my existing product prices?</s-heading>
            <s-paragraph>
              Your current Shopify prices are not permanently changed. Profit Max
              dynamically adjusts the price shown to each visitor within your
              configured range. Your base price in Shopify remains unchanged as
              a reference point — it becomes the midpoint of your optimisation
              range by default.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>
              Will this affect my sale prices or compare-at prices?
            </s-heading>
            <s-paragraph>
              Profit Max only adjusts the selling price, not the compare-at
              price. If you run a sale where the compare-at price shows a
              discount, the algorithm will still test within your configured
              price range — but the discount amount shown to the customer
              will vary accordingly.
            </s-paragraph>
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-100">
            <s-heading>
              Does Profit Max work with Shopify Markets and multi-currency?
            </s-heading>
            <s-paragraph>
              Yes. When regional variation is enabled, the algorithm is
              market-aware and uses the correct currency for each market.
              Prices shown to customers are always in their local currency
              based on your Shopify Markets configuration.
            </s-paragraph>
          </s-stack>

        </s-stack>
      </s-section>
    </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
