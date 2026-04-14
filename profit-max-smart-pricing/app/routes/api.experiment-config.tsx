import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

// ---------------------------------------------------------------------------
// GET /apps/profit-max/api/experiment-config
//
// Public endpoint — called from the storefront snippet (profit-max.js).
// Does NOT require Shopify admin authentication.
//
// Query params:
//   productId   — full GID, e.g. gid://shopify/Product/123
//   merchantId  — Shopify shop domain, e.g. my-store.myshopify.com
//
// Response (active experiment):
//   {
//     "experimentDatetimeSubmitted": "<ISO 8601>",
//     "assignments": [
//       {
//         "baseVariantId":       "gid://shopify/ProductVariant/...",
//         "experimentVariantId": "gid://shopify/ProductVariant/...",
//         "price":               "19.99",
//         "probability":         0.2
//       }
//     ]
//   }
//
// Response (no active experiment):
//   { "active": false }
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Only accept GET requests.
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const merchantId = url.searchParams.get("merchantId");

  if (!productId || !merchantId) {
    return Response.json(
      { error: "Missing required query params: productId, merchantId" },
      { status: 400 },
    );
  }

  // Only serve config for Active experiments.
  // Paused and Cancelled experiments return { active: false } so the storefront
  // snippet does nothing — the experiment is not running.
  const activeLive = await db.experimentLive.findFirst({
    where: {
      MerchantId: merchantId,
      ProductId: productId,
      Status: "Active",
    },
    select: { ExperimentDatetimeSubmitted: true },
  });

  if (!activeLive) {
    return Response.json({ active: false });
  }

  // Fetch all ExperimentSetup rows that belong to this experiment.
  const setups = await db.experimentSetup.findMany({
    where: {
      MerchantId: merchantId,
      ExperimentDatetimeSubmitted: activeLive.ExperimentDatetimeSubmitted,
    },
    select: {
      BaseVariantId: true,
      ExperimentVariantId: true,
      Price: true,
      Probability: true,
    },
  });

  const assignments = setups.map((s) => ({
    baseVariantId: s.BaseVariantId,
    experimentVariantId: s.ExperimentVariantId,
    price: s.Price.toString(),
    probability: Number(s.Probability),
  }));

  return Response.json({
    experimentDatetimeSubmitted: activeLive.ExperimentDatetimeSubmitted.toISOString(),
    assignments,
  });
};
