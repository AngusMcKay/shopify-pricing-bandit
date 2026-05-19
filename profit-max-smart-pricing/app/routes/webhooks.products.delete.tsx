import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { syncExperimentMetafield } from "../services/experimentMetafield.server";

// ---------------------------------------------------------------------------
// products/delete webhook
//
// Fired when a product is permanently deleted. Cancel any active experiment
// for the product and notify the merchant.
// ---------------------------------------------------------------------------

interface ProductDeletePayload {
  admin_graphql_api_id: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const product = payload as ProductDeletePayload;

  const productGid = product.admin_graphql_api_id;
  if (!productGid) {
    return new Response(null, { status: 200 });
  }

  // Find active/paused experiments for this product.
  const experiments = await db.experimentLive.findMany({
    where: {
      MerchantId: shop,
      ProductId: productGid,
      Status: { in: ["Active", "Paused"] },
    },
    select: { ExperimentDatetimeSubmitted: true, Status: true },
  });

  if (experiments.length === 0) {
    return new Response(null, { status: 200 });
  }

  console.log(
    `[PricePilot] Cancelling experiment for deleted product ${productGid} on ${shop}`,
  );

  await db.experimentLive.updateMany({
    where: {
      MerchantId: shop,
      ProductId: productGid,
      Status: { in: ["Active", "Paused"] },
    },
    data: { Status: "Cancelled", LastUpdatedAt: new Date() },
  });

  await db.notifications.create({
    data: {
      MerchantId: shop,
      Message:
        `A product with a running experiment was deleted and the experiment has been cancelled.\n\n` +
        `Product: ${productGid}`,
      Type: "warning",
    },
  });

  // Sync metafield to remove the deleted product's experiment config.
  try {
    const { admin } = await unauthenticated.admin(shop);
    await syncExperimentMetafield(admin, shop);
  } catch (e) {
    console.error("[PricePilot] products/delete: metafield sync failed:", e);
  }

  return new Response(null, { status: 200 });
};
