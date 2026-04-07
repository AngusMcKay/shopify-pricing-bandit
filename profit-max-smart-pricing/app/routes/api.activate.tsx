import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generatePricePoints, PricePointError } from "../utils/pricing";

// ---------------------------------------------------------------------------
// GraphQL types
// ---------------------------------------------------------------------------

interface ExistingVariantNode {
  id: string;
  price: string;
  title: string;
  sku: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string;
}

interface ExistingVariantsResponse {
  data: {
    product: {
      id: string;
      title: string;
      tags: string[];
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

type RequestBody = ActivateBody | CancelBody;

// ---------------------------------------------------------------------------
// GraphQL queries / mutations
// ---------------------------------------------------------------------------

const GET_PRODUCT_VARIANTS_QUERY = `#graphql
  query GetProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      tags
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
          }
        }
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
// Activate handler
// ---------------------------------------------------------------------------

async function handleActivate(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"],
  products: ProductActivationConfig[],
): Promise<Response> {
  const merchantId = session.shop;
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

    // Safety check — if any variant already carries the experiment tag,
    // this product already has a running experiment. Skip rather than double-enrol.
    const existingVariants = product.variants.edges.map((e) => e.node);
    const alreadyRunning = await db.experimentLive.findFirst({
      where: {
        MerchantId: merchantId,
        ProductId: config.productId,
        Status: "Active",
      },
    });

    if (alreadyRunning) {
      return Response.json(
        { error: `Product "${config.productId}" already has an active price experiment. Cancel it before starting a new one.` },
        { status: 409 },
      );
    }

    // Use the first (base) variant as the reference price point.
    const baseVariant = existingVariants[0];
    if (!baseVariant) {
      return Response.json(
        { error: `Product "${config.productId}" has no variants.` },
        { status: 422 },
      );
    }

    // Generate price points for this product
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

    // Create one Shopify variant per price point.
    const variantInputs = pricePoints.map((price) => ({
      price: price.toFixed(2),
      inventoryPolicy: baseVariant.inventoryPolicy,
      optionValues: [{ optionName: "Title", name: price.toFixed(2) }],
      // SKU not set — experiment variants are purely for price routing
    }));

    const createRes = await admin.graphql(BULK_CREATE_VARIANTS_MUTATION, {
      variables: {
        productId: config.productId,
        variants: variantInputs,
      },
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
    const equalProbability =
      Math.round((1 / createdVariants.length) * 10000) / 10000;

    // ---------------------------------------------------------------------------
    // DB writes (all within a single transaction per product)
    // ---------------------------------------------------------------------------
    await db.$transaction(async (tx) => {
      // 1. ExperimentMerchantInputs — EAV rows for merchant-supplied config
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
          VariantId: baseVariant.id,
          ExperimentParameter: param,
          ExperimentParameterValue: value,
        })),
      });

      // 2. ExperimentMerchantProductSnapshot — snapshot of all existing variants
      await tx.experimentMerchantProductSnapshot.createMany({
        data: existingVariants.map((v) => ({
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

      // 3. ExperimentSetup — one row per created experiment variant
      await tx.experimentSetup.createMany({
        data: createdVariants.map((v) => ({
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          BaseVariantId: baseVariant.id,
          ExperimentVariantId: v.id,
          ExperimentSubset: null,
          Price: v.price,
          Probability: equalProbability,
        })),
      });

      // 4. ExperimentLive — one row per product (Status: Active)
      await tx.experimentLive.create({
        data: {
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: experimentDatetime,
          ProductId: config.productId,
          Status: "Active",
          LastUpdatedAt: experimentDatetime,
        },
      });

      // 5. BanditParameters — one row per experiment variant, seeded with
      //    Thompson Sampling priors (mean=0, variance=1).
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

  return Response.json({ success: true }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Cancel handler — cancels ALL active experiments for this merchant
// ---------------------------------------------------------------------------

async function handleCancel(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"],
): Promise<Response> {
  const merchantId = session.shop;

  // Find all active experiment datetimes
  const activeLive = await db.experimentLive.findMany({
    where: { MerchantId: merchantId, Status: "Active" },
    select: { ExperimentDatetimeSubmitted: true, ProductId: true },
  });

  if (activeLive.length === 0) {
    return Response.json({ success: true, cancelled: 0 }, { status: 200 });
  }

  const activeDatetimes = activeLive.map((e) => e.ExperimentDatetimeSubmitted);

  // Fetch all experiment variant IDs to delete from Shopify
  const setups = await db.experimentSetup.findMany({
    where: {
      MerchantId: merchantId,
      ExperimentDatetimeSubmitted: { in: activeDatetimes },
    },
    select: {
      ProductId: true,
      ExperimentVariantId: true,
    },
  });

  // Group variant IDs by product
  const variantsByProduct = new Map<string, string[]>();
  for (const setup of setups) {
    const existing = variantsByProduct.get(setup.ProductId) ?? [];
    existing.push(setup.ExperimentVariantId);
    variantsByProduct.set(setup.ProductId, existing);
  }

  // Delete experiment variants from Shopify
  for (const [productId, variantIds] of variantsByProduct) {
    const deleteRes = await admin.graphql(BULK_DELETE_VARIANTS_MUTATION, {
      variables: { productId, variantsIds: variantIds },
    });
    const deleteJson = (await deleteRes.json()) as BulkDeleteResponse;
    const deleteResult = deleteJson.data.productVariantsBulkDelete;

    if (deleteResult.userErrors.length > 0) {
      // Log but don't abort — mark DB as cancelled regardless so the merchant
      // can re-activate. Shopify may have already deleted the variant.
      console.error(
        `Shopify variant deletion errors for product ${productId}:`,
        deleteResult.userErrors,
      );
    }
  }

  // Mark all active experiments as Cancelled in the DB
  await db.experimentLive.updateMany({
    where: {
      MerchantId: merchantId,
      Status: "Active",
      ExperimentDatetimeSubmitted: { in: activeDatetimes },
    },
    data: {
      Status: "Cancelled",
      LastUpdatedAt: new Date(),
    },
  });

  return Response.json(
    { success: true, cancelled: activeLive.length },
    { status: 200 },
  );
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

  return Response.json({ error: `Unknown action: ${(body as RequestBody & { action: string }).action}` }, { status: 400 });
};
