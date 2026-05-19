import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { syncExperimentMetafield } from "../services/experimentMetafield.server";

// ---------------------------------------------------------------------------
// products/update webhook
//
// Fired whenever a product is changed in any way — including by PricePilot
// itself during activation. We only act when:
//   1. The product has an Active experiment in our DB.
//   2. The experiment is older than ACTIVATION_GRACE_MS to skip our own writes.
//   3. A significant change is detected against the snapshot.
//
// Significant changes that warrant pausing:
//   a. A base variant has been deleted (missing from current variant list).
//   b. The _pm_price option is missing (all experiment variants gone).
//   c. A new option has been added (causes Shopify variant cross-product explosion).
//   d. Variant count differs from expected (another app added/removed variants).
//   e. Product is no longer active (archived or drafted).
// ---------------------------------------------------------------------------

// How long after experiment activation to ignore products/update webhooks for
// that product. Covers the window where PricePilot itself is creating options
// and variants, which triggers this webhook.
const ACTIVATION_GRACE_MS = 5 * 60 * 1000; // 5 minutes

interface ProductVariant {
  id: string; // numeric ID from REST payload
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ProductOption {
  name: string;
}

interface ProductUpdatePayload {
  admin_graphql_api_id: string; // full GID
  title: string;                // product title
  status: string;               // "active" | "archived" | "draft"
  options: ProductOption[];
  variants: ProductVariant[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const product = payload as ProductUpdatePayload;

  const productGid = product.admin_graphql_api_id;
  if (!productGid) {
    return new Response(null, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // 1. Find active experiment for this product
  // -------------------------------------------------------------------------
  const activeLive = await db.experimentLive.findFirst({
    where: { MerchantId: shop, ProductId: productGid, Status: "Active" },
    select: { ExperimentDatetimeSubmitted: true },
  });

  if (!activeLive) {
    return new Response(null, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // 2. Skip if within the activation grace window
  // -------------------------------------------------------------------------
  const ageMs = Date.now() - activeLive.ExperimentDatetimeSubmitted.getTime();
  if (ageMs < ACTIVATION_GRACE_MS) {
    return new Response(null, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // 3. Load expected state from DB
  // -------------------------------------------------------------------------
  const [setups, snapshots] = await Promise.all([
    db.experimentSetup.findMany({
      where: {
        MerchantId: shop,
        ProductId: productGid,
        ExperimentDatetimeSubmitted: activeLive.ExperimentDatetimeSubmitted,
        IsActive: true,
      },
      select: { BaseVariantId: true, ExperimentVariantId: true },
    }),
    db.experimentMerchantProductSnapshot.findMany({
      where: {
        MerchantId: shop,
        ProductId: productGid,
        ExperimentDatetimeSubmitted: activeLive.ExperimentDatetimeSubmitted,
      },
      select: { VariantId: true },
    }),
  ]);

  const expectedBaseVariantGids = new Set(snapshots.map((s) => s.VariantId));
  const expectedExperimentVariantGids = new Set(setups.map((s) => s.ExperimentVariantId));
  const expectedTotalVariants = expectedBaseVariantGids.size + expectedExperimentVariantGids.size;

  // -------------------------------------------------------------------------
  // 4. Inspect the current product state from the webhook payload
  // -------------------------------------------------------------------------
  const currentVariantNumericIds = new Set(product.variants.map((v) => String(v.id)));
  const currentOptionNames = (product.options || []).map((o) => o.name);

  // Helper: convert GID to numeric ID for comparison with REST payload IDs.
  function numericId(gid: string) { return gid.split("/").pop() ?? ""; }

  const issues: string[] = [];

  // (a) Product archived or drafted.
  if (product.status && product.status !== "active") {
    issues.push(`product status changed to "${product.status}"`);
  }

  // (b) _pm_price option missing.
  if (!currentOptionNames.includes("_pm_price")) {
    issues.push("_pm_price option was removed from the product");
  }

  // (c) A base variant was deleted.
  for (const baseGid of expectedBaseVariantGids) {
    if (!currentVariantNumericIds.has(numericId(baseGid))) {
      issues.push(`base variant ${baseGid} was deleted`);
    }
  }

  // (d) Variant count mismatch — another app may have added/removed variants.
  if (currentVariantNumericIds.size !== expectedTotalVariants) {
    issues.push(
      `variant count changed from ${expectedTotalVariants} to ${currentVariantNumericIds.size} ` +
      `(expected ${expectedBaseVariantGids.size} base + ${expectedExperimentVariantGids.size} experiment)`,
    );
  }

  // Note: a new option being added by another app (causing variant explosion) is
  // caught by check (d) above — the variant count will diverge as soon as
  // Shopify creates the cross-product variants.

  if (issues.length === 0) {
    return new Response(null, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // 5. Pause the experiment and notify the merchant
  // -------------------------------------------------------------------------
  console.log(
    `[PricePilot] Pausing experiment for ${productGid} on ${shop} — issues: ${issues.join("; ")}`,
  );

  await db.experimentLive.updateMany({
    where: {
      MerchantId: shop,
      ProductId: productGid,
      ExperimentDatetimeSubmitted: activeLive.ExperimentDatetimeSubmitted,
      Status: "Active",
    },
    data: { Status: "Paused", LastUpdatedAt: new Date() },
  });

  const productLabel = product.title
    ? `${product.title} (${productGid})`
    : productGid;

  const issueList = issues.map((i) => `• ${i}`).join("\n");
  const message =
    `A change to one of your products may have affected a running experiment and it has been paused. ` +
    `Please review the product and re-activate the experiment if everything looks correct.\n\n` +
    `Product: ${productLabel}\nIssues detected:\n${issueList}`;

  await db.notifications.create({
    data: {
      MerchantId: shop,
      Message: message,
      Type: "warning",
    },
  });

  // Sync metafield so storefront stops serving experiment prices immediately.
  // This is awaited (not fire-and-forget) because a paused experiment with a
  // stale metafield causes checkout errors for customers still seeing old prices.
  try {
    const { admin } = await unauthenticated.admin(shop);
    await syncExperimentMetafield(admin, shop);
  } catch (e) {
    console.error("[PricePilot] products/update: metafield sync failed — storefront may serve stale prices:", e);
  }

  return new Response(null, { status: 200 });
};
