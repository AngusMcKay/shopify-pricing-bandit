import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generatePricePoints, PricePointError } from "../utils/pricing";
import { isEmbedEnabledOnPublishedTheme } from "../services/embedStatus.server";
import { syncExperimentMetafield, ensureMetafieldDefinition } from "../services/experimentMetafield.server";

// ---------------------------------------------------------------------------
// GraphQL types
// ---------------------------------------------------------------------------

interface SelectedOption {
  name: string;
  value: string;
}

interface ExistingVariantNode {
  id: string;
  price: string;
  title: string;
  sku: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string;
  selectedOptions: SelectedOption[];
}

interface ProductOption {
  id: string;
  name: string;
  values: string[];
}

interface ExistingVariantsResponse {
  data: {
    product: {
      id: string;
      title: string;
      tags: string[];
      options: ProductOption[];
      variants: {
        edges: Array<{ node: ExistingVariantNode }>;
      };
    } | null;
  };
}

interface CreatedVariant {
  id: string;
  price: string;
}

interface BulkCreateResponse {
  data: {
    productVariantsBulkCreate: {
      productVariants: CreatedVariant[];
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
}

interface BulkDeleteResponse {
  data: {
    productVariantsBulkDelete: {
      product: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
}

interface ProductOptionsCreateResponse {
  data: {
    productOptionsCreate: {
      product: {
        options: Array<{ id: string; name: string; values: string[] }>;
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
}

interface ProductOptionsDeleteResponse {
  data: {
    productOptionsDelete: {
      deletedOptionsIds: string[];
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };
}

interface GetProductOptionsResponse {
  data: {
    product: {
      options: Array<{ id: string; name: string }>;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface ProductActivationConfig {
  productId: string;
  minPrice: number;
  maxPrice: number;
  costOfProduction?: number | null;
  regionalVariation: boolean;
  exactPricePoints: number[]; // empty = auto-generate
  optimizationMode: "revenue" | "profit";
  priceEndings: number[]; // e.g. [0.99, 0.49, 0.00]
}

interface ActivateBody {
  action: "activate";
  products: ProductActivationConfig[];
}

interface CancelBody {
  action: "cancel";
}

interface CancelProductsBody {
  action: "cancel_products";
  productIds: string[];
}

type RequestBody = ActivateBody | CancelBody | CancelProductsBody;

// ---------------------------------------------------------------------------
// GraphQL queries / mutations
// ---------------------------------------------------------------------------

const GET_PRODUCT_VARIANTS_QUERY = `#graphql
  query GetProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      tags
      options {
        id
        name
        values
      }
      variants(first: 100) {
        edges {
          node {
            id
            price
            title
            sku
            compareAtPrice
            inventoryQuantity
            inventoryPolicy
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

const GET_PRODUCT_OPTIONS_QUERY = `#graphql
  query GetProductOptions($id: ID!) {
    product(id: $id) {
      options {
        id
        name
      }
    }
  }
`;

const PRODUCT_OPTIONS_CREATE_MUTATION = `#graphql
  mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options) {
      product {
        options {
          id
          name
          values
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_OPTIONS_DELETE_MUTATION = `#graphql
  mutation ProductOptionsDelete($productId: ID!, $options: [ID!]!) {
    productOptionsDelete(productId: $productId, options: $options) {
      deletedOptionsIds
      userErrors {
        field
        message
      }
    }
  }
`;

const BULK_CREATE_VARIANTS_MUTATION = `#graphql
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BULK_DELETE_VARIANTS_MUTATION = `#graphql
  mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Shared admin type
// ---------------------------------------------------------------------------

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
type SessionType = Awaited<ReturnType<typeof authenticate.admin>>["session"];

// ---------------------------------------------------------------------------
// Shared Shopify cleanup — delete experiment variants + _pm_price option
// for a set of products identified by their ExperimentSetup datetimes.
// ---------------------------------------------------------------------------

async function cleanupShopifyVariants(
  admin: AdminClient,
  merchantId: string,
  activeLives: Array<{ ExperimentDatetimeSubmitted: Date; ProductId: string }>,
): Promise<void> {
  const setups = await db.experimentSetup.findMany({
    where: {
      MerchantId: merchantId,
      OR: activeLives.map((l) => ({
        ProductId: l.ProductId,
        ExperimentDatetimeSubmitted: l.ExperimentDatetimeSubmitted,
      })),
    },
    select: { ProductId: true, ExperimentVariantId: true },
  });

  const variantsByProduct = new Map<string, string[]>();
  for (const setup of setups) {
    const existing = variantsByProduct.get(setup.ProductId) ?? [];
    existing.push(setup.ExperimentVariantId);
    variantsByProduct.set(setup.ProductId, existing);
  }

  for (const [productId, variantIds] of variantsByProduct) {
    const deleteRes = await admin.graphql(BULK_DELETE_VARIANTS_MUTATION, {
      variables: { productId, variantsIds: variantIds },
    });
    const deleteJson = (await deleteRes.json()) as BulkDeleteResponse;
    if (deleteJson.data.productVariantsBulkDelete.userErrors.length > 0) {
      console.error(
        `Shopify variant deletion errors for product ${productId}:`,
        deleteJson.data.productVariantsBulkDelete.userErrors,
      );
    }

    const optionsRes = await admin.graphql(GET_PRODUCT_OPTIONS_QUERY, {
      variables: { id: productId },
    });
    const optionsJson = (await optionsRes.json()) as GetProductOptionsResponse;
    const pmPriceOption = optionsJson.data.product?.options.find(
      (o) => o.name === "_pm_price",
    );

    if (pmPriceOption) {
      const optionsDeleteRes = await admin.graphql(PRODUCT_OPTIONS_DELETE_MUTATION, {
        variables: { productId, options: [pmPriceOption.id] },
      });
      const optionsDeleteJson = (await optionsDeleteRes.json()) as ProductOptionsDeleteResponse;
      if (optionsDeleteJson.data.productOptionsDelete.userErrors.length > 0) {
        console.error(
          `Shopify option deletion errors for product ${productId}:`,
          optionsDeleteJson.data.productOptionsDelete.userErrors,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activate handler
// ---------------------------------------------------------------------------

async function handleActivate(
  admin: AdminClient,
  session: SessionType,
  products: ProductActivationConfig[],
): Promise<Response> {
  const merchantId = session.shop;

  // -------------------------------------------------------------------------
  // Part 3 — Embed status check
  // Before doing any work, verify the Theme App Extension is enabled on the
  // merchant's published theme. Return 403 if not — don't touch Shopify state.
  // -------------------------------------------------------------------------
  const embedEnabled = await isEmbedEnabledOnPublishedTheme(admin);
  if (!embedEnabled) {
    return Response.json(
      {
        error:
          "The Profit Max app embed is not enabled on your published theme. " +
          "Please go to your Shopify theme editor, open App Embeds, and enable " +
          "Profit Max before activating experiments.",
        code: "EMBED_NOT_ENABLED",
      },
      { status: 403 },
    );
  }

  const experimentDatetime = new Date();

  // Process each product sequentially to avoid overwhelming the Shopify API.
  for (const config of products) {
    // Fetch current variants for this product
    const variantsRes = await admin.graphql(GET_PRODUCT_VARIANTS_QUERY, {
      variables: { id: config.productId },
    });
    const variantsJson = (await variantsRes.json()) as ExistingVariantsResponse;
    const product = variantsJson.data.product;

    if (!product) {
      return Response.json(
        { error: `Product not found: ${config.productId}` },
        { status: 422 },
      );
    }

    const existingVariants = product.variants.edges.map((e) => e.node);

    // -------------------------------------------------------------------------
    // Step 1 — DB cleanup
    // Find any Active OR Paused experiment for this product and cancel it.
    // Paused experiments are treated the same as Active for replacement purposes
    // — they still have live Shopify variants that need to be cleaned up.
    // -------------------------------------------------------------------------
    // Collect ALL known experiment variant IDs for this product (any status)
    // so we can clean up orphans from previous partial cancellations.
    const allSetups = await db.experimentSetup.findMany({
      where: {
        MerchantId: merchantId,
        ProductId: config.productId,
      },
      select: { BaseVariantId: true, ExperimentVariantId: true },
    });
    const dbBaseVariantIds = new Set(allSetups.map((s) => s.BaseVariantId));
    const dbExperimentVariantIds = new Set(allSetups.map((s) => s.ExperimentVariantId));

    // Cancel any Active/Paused experiment for this product.
    const existingExperiment = await db.experimentLive.findFirst({
      where: {
        MerchantId: merchantId,
        ProductId: config.productId,
        Status: { in: ["Active", "Paused"] },
      },
      select: { ExperimentDatetimeSubmitted: true },
    });

    if (existingExperiment) {
      await db.experimentLive.updateMany({
        where: {
          MerchantId: merchantId,
          ProductId: config.productId,
          ExperimentDatetimeSubmitted: existingExperiment.ExperimentDatetimeSubmitted,
          Status: { in: ["Active", "Paused"] },
        },
        data: { Status: "Cancelled", LastUpdatedAt: new Date() },
      });
    }

    // -------------------------------------------------------------------------
    // Step 2 — Shopify cleanup (always driven by current Shopify state)
    // -------------------------------------------------------------------------
    const experimentVariantIds = existingVariants
      .filter((v) => {
        if (dbBaseVariantIds.has(v.id)) return false;
        // Match by _pm_price option (normal case)
        const pmOpt = v.selectedOptions.find((o) => o.name === "_pm_price");
        if (pmOpt != null && pmOpt.value !== "_base") return true;
        // Match by DB record (orphaned variants whose _pm_price option was
        // already deleted in a previous partial cleanup)
        return dbExperimentVariantIds.has(v.id);
      })
      .map((v) => v.id);

    if (experimentVariantIds.length > 0) {
      const deleteRes = await admin.graphql(BULK_DELETE_VARIANTS_MUTATION, {
        variables: { productId: config.productId, variantsIds: experimentVariantIds },
      });
      const deleteJson = (await deleteRes.json()) as BulkDeleteResponse;
      if (deleteJson.data.productVariantsBulkDelete.userErrors.length > 0) {
        console.error(
          `Shopify variant deletion errors for product ${config.productId}:`,
          deleteJson.data.productVariantsBulkDelete.userErrors,
        );
      }
    }

    const existingPmOption = product.options.find((o) => o.name === "_pm_price");
    if (existingPmOption) {
      const optionsDeleteRes = await admin.graphql(PRODUCT_OPTIONS_DELETE_MUTATION, {
        variables: { productId: config.productId, options: [existingPmOption.id] },
      });
      const optionsDeleteJson = (await optionsDeleteRes.json()) as ProductOptionsDeleteResponse;
      if (optionsDeleteJson.data.productOptionsDelete.userErrors.length > 0) {
        console.error(
          `Shopify option deletion errors for product ${config.productId}:`,
          optionsDeleteJson.data.productOptionsDelete.userErrors,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 3 — Identify base (merchant) variants
    // -------------------------------------------------------------------------
    const experimentVariantIdSet = new Set(experimentVariantIds);
    const baseVariants = existingVariants.filter((v) => !experimentVariantIdSet.has(v.id));

    if (baseVariants.length === 0) {
      return Response.json(
        { error: `Product "${config.productId}" has no variants.` },
        { status: 422 },
      );
    }

    // -------------------------------------------------------------------------
    // Step 4 — Generate price points
    // -------------------------------------------------------------------------
    let pricePoints: number[];
    try {
      pricePoints = generatePricePoints(
        config.minPrice,
        config.maxPrice,
        config.priceEndings.length > 0 ? config.priceEndings : undefined,
        config.exactPricePoints.length > 0 ? config.exactPricePoints : undefined,
      );
    } catch (err) {
      if (err instanceof PricePointError) {
        return Response.json(
          {
            error: `Price point generation failed for product "${config.productId}": ${err.message}`,
          },
          { status: 422 },
        );
      }
      throw err;
    }

    // -------------------------------------------------------------------------
    // Step 5 — Create the _pm_price option fresh
    // -------------------------------------------------------------------------
    const priceOptionValues = pricePoints.map((p) => p.toFixed(2));
    const pmPriceValues = [{ name: "_base" }, ...priceOptionValues.map((v) => ({ name: v }))];
    const optionsCreateRes = await admin.graphql(PRODUCT_OPTIONS_CREATE_MUTATION, {
      variables: {
        productId: config.productId,
        options: [{ name: "_pm_price", values: pmPriceValues }],
      },
    });
    const optionsCreateJson = (await optionsCreateRes.json()) as ProductOptionsCreateResponse;
    const optionsCreateResult = optionsCreateJson.data.productOptionsCreate;

    if (optionsCreateResult.userErrors.length > 0) {
      return Response.json(
        {
          error: `Shopify option creation failed for product "${config.productId}": ${optionsCreateResult.userErrors.map((e) => e.message).join(", ")}`,
        },
        { status: 422 },
      );
    }

    const freshVariantsRes = await admin.graphql(GET_PRODUCT_VARIANTS_QUERY, {
      variables: { id: config.productId },
    });
    const freshVariantsJson = (await freshVariantsRes.json()) as ExistingVariantsResponse;
    const freshVariants = freshVariantsJson.data.product?.variants.edges.map((e) => e.node) ?? [];
    const freshVariantById = new Map(freshVariants.map((v) => [v.id, v]));

    const variantInputs: Array<{
      price: string;
      inventoryPolicy: string;
      optionValues: Array<{ optionName: string; name: string }>;
    }> = [];
    const variantBaseIds: string[] = [];

    for (const baseVariant of baseVariants) {
      const freshVariant = freshVariantById.get(baseVariant.id) ?? baseVariant;
      const inheritedOptions = freshVariant.selectedOptions
        .filter((opt) => opt.name !== "_pm_price")
        .map((opt) => ({ optionName: opt.name, name: opt.value }));

      for (const price of pricePoints) {
        variantInputs.push({
          price: price.toFixed(2),
          inventoryPolicy: baseVariant.inventoryPolicy,
          optionValues: [
            ...inheritedOptions,
            { optionName: "_pm_price", name: price.toFixed(2) },
          ],
        });
        variantBaseIds.push(baseVariant.id);
      }
    }

    const createRes = await admin.graphql(BULK_CREATE_VARIANTS_MUTATION, {
      variables: { productId: config.productId, variants: variantInputs },
    });
    const createJson = (await createRes.json()) as BulkCreateResponse;
    const createResult = createJson.data.productVariantsBulkCreate;

    if (createResult.userErrors.length > 0) {
      return Response.json(
        {
          error: `Shopify variant creation failed for product "${config.productId}": ${createResult.userErrors.map((e) => e.message).join(", ")}`,
        },
        { status: 422 },
      );
    }

    const createdVariants = createResult.productVariants;

    // Probability is per-base-variant, not across the flat list.
    // Each base variant has the same number of price-point variants (pricePoints.length).
    // The weighted draw in the JS snippet selects one experiment variant per base variant,
    // so probabilities must sum to 1.0 within each base variant group.
    const pricePointCount = baseVariants.length > 0
      ? createdVariants.length / baseVariants.length
      : createdVariants.length;
    const equalProbability = Math.round((1 / pricePointCount) * 10000) / 10000;

    // -------------------------------------------------------------------------
    // DB writes
    // -------------------------------------------------------------------------
    await db.$transaction(async (tx) => {
      const canonicalVariantId = baseVariants[0].id;
      const eavParams: Array<[string, string]> = [
        ["IncludedInExperiment", "true"],
        ["PriceMin", config.minPrice.toFixed(2)],
        ["PriceMax", config.maxPrice.toFixed(2)],
        ["RegionalVariation", String(config.regionalVariation)],
        ["OptimizationMode", config.optimizationMode],
      ];
      if (config.costOfProduction != null) {
        eavParams.push(["CostOfProduction", config.costOfProduction.toFixed(2)]);
      }

      await tx.experimentMerchantInputs.createMany({
        data: eavParams.map(([param, value]) => ({
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          VariantId: canonicalVariantId,
          ExperimentParameter: param,
          ExperimentParameterValue: value,
        })),
      });

      await tx.experimentMerchantProductSnapshot.createMany({
        data: baseVariants.map((v) => ({
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          ProductTitle: product.title,
          ProductStatus: "ACTIVE",
          VariantId: v.id,
          VariantTitle: v.title,
          VariantPrice: v.price,
          VariantCompareAtPrice: v.compareAtPrice ?? null,
          VariantInventoryQuantity: v.inventoryQuantity ?? null,
          VariantInventoryPolicy: v.inventoryPolicy,
          VariantSKU: v.sku ?? null,
        })),
      });

      await tx.experimentSetup.createMany({
        data: createdVariants.map((v, i) => ({
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          BaseVariantId: variantBaseIds[i],
          ExperimentVariantId: v.id,
          ExperimentSubset: null,
          Price: v.price,
          Probability: equalProbability,
        })),
      });

      await tx.experimentLive.create({
        data: {
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          Status: "Active",
          LastUpdatedAt: experimentDatetime,
        },
      });

      await tx.banditParameters.createMany({
        data: createdVariants.map((v) => ({
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          ExperimentVariantId: v.id,
          ExperimentSubset: null,
          Price: v.price,
          ContextualParameter: config.optimizationMode,
          ContextualParameterMean: 0,
          ContextualParameterVariance: 1,
          TotalImpressions: 0,
          TotalPurchases: 0,
          ModelVersion: 0,
          DatetimeUpdated: experimentDatetime,
        })),
      });
    });
  }

  // Fire-and-forget: update the shop metafield so the embed block's Liquid
  // renders the latest experiment config on next page load.
  void (async () => {
    await ensureMetafieldDefinition(admin);
    await syncExperimentMetafield(admin, session.shop);
  })();

  return Response.json({ success: true }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Cancel handler — cancels ALL Active or Paused experiments for this merchant
// ---------------------------------------------------------------------------

async function handleCancel(
  admin: AdminClient,
  session: SessionType,
): Promise<Response> {
  const merchantId = session.shop;

  // Part 5: treat Active and Paused the same — both need cancellation
  const activeLive = await db.experimentLive.findMany({
    where: { MerchantId: merchantId, Status: { in: ["Active", "Paused"] } },
    select: { ExperimentDatetimeSubmitted: true, ProductId: true },
  });

  if (activeLive.length === 0) {
    return Response.json({ success: true, cancelled: 0 }, { status: 200 });
  }

  await cleanupShopifyVariants(admin, merchantId, activeLive);

  const activeDatetimes = activeLive.map((e) => e.ExperimentDatetimeSubmitted);

  await db.experimentLive.updateMany({
    where: {
      MerchantId: merchantId,
      Status: { in: ["Active", "Paused"] },
      ExperimentDatetimeSubmitted: { in: activeDatetimes },
    },
    data: { Status: "Cancelled", LastUpdatedAt: new Date() },
  });

  void syncExperimentMetafield(admin, session.shop);

  return Response.json({ success: true, cancelled: activeLive.length }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Cancel-products handler — cancels specific products by ID (Active or Paused)
// ---------------------------------------------------------------------------

async function handleCancelProducts(
  admin: AdminClient,
  session: SessionType,
  productIds: string[],
): Promise<Response> {
  const merchantId = session.shop;

  // Part 5: treat Active and Paused the same
  const activeLive = await db.experimentLive.findMany({
    where: {
      MerchantId: merchantId,
      Status: { in: ["Active", "Paused"] },
      ProductId: { in: productIds },
    },
    select: { ExperimentDatetimeSubmitted: true, ProductId: true },
  });

  if (activeLive.length === 0) {
    return Response.json({ success: true, cancelled: 0 }, { status: 200 });
  }

  await cleanupShopifyVariants(admin, merchantId, activeLive);

  const activeDatetimes = activeLive.map((e) => e.ExperimentDatetimeSubmitted);

  await db.experimentLive.updateMany({
    where: {
      MerchantId: merchantId,
      Status: { in: ["Active", "Paused"] },
      ExperimentDatetimeSubmitted: { in: activeDatetimes },
    },
    data: { Status: "Cancelled", LastUpdatedAt: new Date() },
  });

  void syncExperimentMetafield(admin, session.shop);

  return Response.json({ success: true, cancelled: activeLive.length }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { admin, session } = await authenticate.admin(request);

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.action) {
    return Response.json({ error: "Missing required field: action" }, { status: 400 });
  }

  if (body.action === "activate") {
    if (!Array.isArray(body.products) || body.products.length === 0) {
      return Response.json(
        { error: "At least one product is required to activate." },
        { status: 400 },
      );
    }
    return handleActivate(admin, session, body.products);
  }

  if (body.action === "cancel") {
    return handleCancel(admin, session);
  }

  if (body.action === "cancel_products") {
    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      return Response.json(
        { error: "At least one productId is required to cancel." },
        { status: 400 },
      );
    }
    return handleCancelProducts(admin, session, body.productIds);
  }

  return Response.json(
    { error: `Unknown action: ${(body as RequestBody & { action: string }).action}` },
    { status: 400 },
  );
};
