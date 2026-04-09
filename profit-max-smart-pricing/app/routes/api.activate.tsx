import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generatePricePoints, PricePointError } from "../utils/pricing";

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

    const existingVariants = product.variants.edges.map((e) => e.node);

    // If an active experiment already exists for this product, cancel it first
    // before starting fresh (cancel-and-replace flow).
    const existingExperiment = await db.experimentLive.findFirst({
      where: {
        MerchantId: merchantId,
        ProductId: config.productId,
        Status: "Active",
      },
      select: { ExperimentDatetimeSubmitted: true },
    });

    if (existingExperiment) {
      // Fetch base variant IDs from DB so we never accidentally delete them.
      const existingSetups = await db.experimentSetup.findMany({
        where: {
          MerchantId: merchantId,
          ExperimentDatetimeSubmitted: existingExperiment.ExperimentDatetimeSubmitted,
        },
        select: { BaseVariantId: true },
      });

      const baseVariantIds = new Set(existingSetups.map((s) => s.BaseVariantId));

      // Identify experiment variants directly from Shopify (resilient to stale DB IDs):
      // any variant with a _pm_price selected option that isn't itself a base variant.
      const experimentVariantIds = existingVariants
        .filter(
          (v) =>
            v.selectedOptions.some((o) => o.name === "_pm_price") &&
            !baseVariantIds.has(v.id),
        )
        .map((v) => v.id);

      if (experimentVariantIds.length > 0) {
        const deleteRes = await admin.graphql(BULK_DELETE_VARIANTS_MUTATION, {
          variables: { productId: config.productId, variantsIds: experimentVariantIds },
        });
        const deleteJson = (await deleteRes.json()) as BulkDeleteResponse;
        if (deleteJson.data.productVariantsBulkDelete.userErrors.length > 0) {
          console.error(
            `Shopify variant deletion errors during replace for product ${config.productId}:`,
            deleteJson.data.productVariantsBulkDelete.userErrors,
          );
        }
      }

      // Remove the _pm_price option
      const optionsRes = await admin.graphql(GET_PRODUCT_OPTIONS_QUERY, {
        variables: { id: config.productId },
      });
      const optionsJson = (await optionsRes.json()) as GetProductOptionsResponse;
      const pmPriceOption = optionsJson.data.product?.options.find(
        (o) => o.name === "_pm_price",
      );

      if (pmPriceOption) {
        const optionsDeleteRes = await admin.graphql(PRODUCT_OPTIONS_DELETE_MUTATION, {
          variables: { productId: config.productId, options: [pmPriceOption.id] },
        });
        const optionsDeleteJson = (await optionsDeleteRes.json()) as ProductOptionsDeleteResponse;
        if (optionsDeleteJson.data.productOptionsDelete.userErrors.length > 0) {
          console.error(
            `Shopify option deletion errors during replace for product ${config.productId}:`,
            optionsDeleteJson.data.productOptionsDelete.userErrors,
          );
        }
      }

      // Mark the existing experiment as Cancelled
      await db.experimentLive.updateMany({
        where: {
          MerchantId: merchantId,
          ProductId: config.productId,
          ExperimentDatetimeSubmitted: existingExperiment.ExperimentDatetimeSubmitted,
          Status: "Active",
        },
        data: {
          Status: "Cancelled",
          LastUpdatedAt: new Date(),
        },
      });
    }

    if (existingVariants.length === 0) {
      return Response.json(
        { error: `Product "${config.productId}" has no variants.` },
        { status: 422 },
      );
    }

    // Generate price points once for this product
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

    // Add a new _pm_price option to the product with all price point values.
    // This allows experiment variants to carry distinct option combinations.
    const priceOptionValues = pricePoints.map((p) => p.toFixed(2));
    const optionsCreateRes = await admin.graphql(PRODUCT_OPTIONS_CREATE_MUTATION, {
      variables: {
        productId: config.productId,
        options: [{ name: "_pm_price", values: priceOptionValues.map((v) => ({ name: v })) }],
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

    // Build variant inputs: existingVariants × pricePoints, one new variant per combo.
    // Track the base variant for each input so we can write ExperimentSetup correctly.
    const variantInputs: Array<{
      price: string;
      inventoryPolicy: string;
      optionValues: Array<{ optionName: string; name: string }>;
    }> = [];
    const variantBaseIds: string[] = []; // parallel array — baseVariantId for each input

    for (const baseVariant of existingVariants) {
      const inheritedOptions = baseVariant.selectedOptions.map((opt) => ({
        optionName: opt.name,
        name: opt.value,
      }));

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

    // Single bulk create call for all new variants across all base variants.
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
      // 1. ExperimentMerchantInputs — EAV rows for merchant-supplied config.
      //    Keyed against the first existing variant as the canonical reference.
      const canonicalVariantId = existingVariants[0].id;
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

      // 3. ExperimentSetup — one row per created experiment variant.
      //    BaseVariantId is the existing variant this experiment variant was created from.
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

  // Delete experiment variants from Shopify, then remove the _pm_price option
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

    // Fetch the product's current options to find the _pm_price option ID
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
      const optionsDeleteResult = optionsDeleteJson.data.productOptionsDelete;

      if (optionsDeleteResult.userErrors.length > 0) {
        console.error(
          `Shopify option deletion errors for product ${productId}:`,
          optionsDeleteResult.userErrors,
        );
      }
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
