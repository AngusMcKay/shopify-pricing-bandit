import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

// ---------------------------------------------------------------------------
// GET /apps/profit-max/api/collection-prices
//
// Public endpoint — called from the storefront snippet on collection/home pages.
// Returns the active experiment prices for every product in the given list,
// so the collection page can show experiment prices without a separate fetch
// per product.
//
// Query params:
//   merchantId  — Shopify shop domain
//   productIds  — comma-separated list of full GIDs
//                 e.g. gid://shopify/Product/1,gid://shopify/Product/2
//
// Response:
//   {
//     "prices": {
//       "gid://shopify/Product/123": {
//         "baseVariantId":       "gid://shopify/ProductVariant/...",
//         "experimentVariantId": "gid://shopify/ProductVariant/...",
//         "price": "19.99",
//         "probability": 0.2
//       }[]
//     }
//   }
//
// Products with no active experiment are omitted from the response.
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const merchantId = url.searchParams.get("merchantId");
  const rawIds = url.searchParams.get("productIds");

  if (!merchantId || !rawIds) {
    return Response.json(
      { error: "Missing required query params: merchantId, productIds" },
      { status: 400 },
    );
  }

  const productIds = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50); // cap to prevent abuse

  if (productIds.length === 0) {
    return Response.json({ prices: {} });
  }

  // Find all active experiments for these products in one query.
  const activeLives = await db.experimentLive.findMany({
    where: {
      MerchantId: merchantId,
      ProductId: { in: productIds },
      Status: "Active",
    },
    select: { ProductId: true, ExperimentDatetimeSubmitted: true },
  });

  if (activeLives.length === 0) {
    return Response.json({ prices: {} });
  }

  // Fetch all assignment rows for all active experiments in one query.
  // Use OR conditions keyed by (merchantId, datetime) pairs.
  const datetimes = activeLives.map((l) => l.ExperimentDatetimeSubmitted);

  const setups = await db.experimentSetup.findMany({
    where: {
      MerchantId: merchantId,
      ExperimentDatetimeSubmitted: { in: datetimes },
    },
    select: {
      ProductId: true,
      BaseVariantId: true,
      ExperimentVariantId: true,
      Price: true,
      Probability: true,
    },
  });

  // Build a productId → { experimentDatetimeSubmitted, assignments } map.
  const datetimeByProduct: Record<string, string> = {};
  for (const l of activeLives) {
    datetimeByProduct[l.ProductId] = l.ExperimentDatetimeSubmitted.toISOString();
  }

  const prices: Record<
    string,
    {
      experimentDatetimeSubmitted: string;
      assignments: Array<{
        baseVariantId: string;
        experimentVariantId: string;
        price: string;
        probability: number;
      }>;
    }
  > = {};

  for (const s of setups) {
    if (!prices[s.ProductId]) {
      prices[s.ProductId] = {
        experimentDatetimeSubmitted: datetimeByProduct[s.ProductId] || '',
        assignments: [],
      };
    }
    prices[s.ProductId].assignments.push({
      baseVariantId: s.BaseVariantId,
      experimentVariantId: s.ExperimentVariantId,
      price: s.Price.toString(),
      probability: Number(s.Probability),
    });
  }

  return Response.json({ prices });
};
