import type { authenticate } from "../shopify.server";
import db from "../db.server";

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// ---------------------------------------------------------------------------
// Shop metafield that embeds the current active experiment config.
//
// Namespace / key: profit_max_app / experiment_config
// Type: json
// Storefront access: PUBLIC_READ (so Liquid in layout/theme.liquid can read it)
//
// Shape stored:
//   {
//     "gid://shopify/Product/123": {
//       experimentDatetimeSubmitted: "2026-04-18T...",
//       assignments: [
//         { baseVariantId, experimentVariantId, price, probability }
//       ]
//     },
//     ...
//   }
//
// The metafield is re-written on every activate / cancel / pause so the Liquid
// snippet embedded in the theme always reflects the live state.
// ---------------------------------------------------------------------------

export const PM_METAFIELD_NAMESPACE = "profit_max_app";
export const PM_METAFIELD_KEY       = "experiment_config";

const METAFIELD_UPSERT = `#graphql
  mutation MetafieldUpsert($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors  { field message }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { field message code }
    }
  }
`;

const METAFIELD_DEFINITION_UPDATE = `#graphql
  mutation MetafieldDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id access { storefront } }
      userErrors { field message code }
    }
  }
`;

const GET_SHOP_ID = `#graphql
  query { shop { id } }
`;

interface ShopIdResponse {
  data: { shop: { id: string } };
}

/**
 * Ensure the metafield definition exists with PUBLIC_READ storefront access.
 * Idempotent — safe to call on every activate. If the definition already exists
 * (TAKEN error), updates its access to PUBLIC_READ in case it was created with
 * different access or Shopify downgraded it.
 */
export async function ensureMetafieldDefinition(admin: AdminClient): Promise<void> {
  try {
    const createRes = await admin.graphql(METAFIELD_DEFINITION_CREATE, {
      variables: {
        definition: {
          namespace: PM_METAFIELD_NAMESPACE,
          key: PM_METAFIELD_KEY,
          name: "Active Experiment Config",
          description: "Experiment configs served to the Profit Max storefront snippet",
          type: "json",
          ownerType: "SHOP",
          access: {
            admin: "MERCHANT_READ_WRITE",
            storefront: "PUBLIC_READ",
          },
        },
      },
    });

    const createJson = await createRes.json() as {
      data?: { metafieldDefinitionCreate?: { userErrors?: Array<{ code?: string }> } };
    };
    const createErrors = createJson.data?.metafieldDefinitionCreate?.userErrors ?? [];
    const alreadyExists = createErrors.some((e) => e.code === "TAKEN");

    if (alreadyExists) {
      // Definition exists but may have wrong access — update it.
      await admin.graphql(METAFIELD_DEFINITION_UPDATE, {
        variables: {
          definition: {
            namespace: PM_METAFIELD_NAMESPACE,
            key: PM_METAFIELD_KEY,
            ownerType: "SHOP",
            access: {
              storefront: "PUBLIC_READ",
            },
          },
        },
      });
      console.log("[ProfitMax] Updated metafield definition access to PUBLIC_READ");
    }
  } catch (e) {
    console.warn("[ProfitMax] ensureMetafieldDefinition:", e);
  }
}

/**
 * Build the experiment config payload for all currently Active experiments
 * for this merchant, then upsert it into the shop metafield.
 *
 * Call this after any state change: activate, cancel, pause.
 */
export async function syncExperimentMetafield(
  admin: AdminClient,
  merchantId: string,
): Promise<void> {
  try {
    // Fetch all active experiments and their setup rows in one go.
    const activeLives = await db.experimentLive.findMany({
      where: { MerchantId: merchantId, Status: "Active" },
      select: { ProductId: true, ExperimentDatetimeSubmitted: true },
    });

    let configValue: Record<string, unknown> = {};

    if (activeLives.length > 0) {
      const [setups, snapshots] = await Promise.all([
        db.experimentSetup.findMany({
          where: {
            MerchantId: merchantId,
            IsActive: true,
            OR: activeLives.map((l) => ({
              ProductId: l.ProductId,
              ExperimentDatetimeSubmitted: l.ExperimentDatetimeSubmitted,
            })),
          },
          select: {
            ProductId: true,
            BaseVariantId: true,
            ExperimentVariantId: true,
            Price: true,
            Probability: true,
            ExperimentDatetimeSubmitted: true,
          },
        }),
        db.experimentMerchantProductSnapshot.findMany({
          where: {
            MerchantId: merchantId,
            OR: activeLives.map((l) => ({
              ProductId: l.ProductId,
              ExperimentDatetimeSubmitted: l.ExperimentDatetimeSubmitted,
            })),
          },
          select: { ProductId: true, ProductHandle: true },
          distinct: ["ProductId"],
        }),
      ]);

      // Build handle lookup.
      const handleByProduct: Record<string, string | null> = {};
      for (const s of snapshots) {
        handleByProduct[s.ProductId] = s.ProductHandle ?? null;
      }

      // Group setups by product.
      const byProduct: Record<string, typeof setups> = {};
      for (const s of setups) {
        if (!byProduct[s.ProductId]) byProduct[s.ProductId] = [];
        byProduct[s.ProductId].push(s);
      }

      // Build the config per product.
      for (const live of activeLives) {
        const productSetups = byProduct[live.ProductId] || [];
        const handle = handleByProduct[live.ProductId];
        configValue[live.ProductId] = {
          experimentDatetimeSubmitted: live.ExperimentDatetimeSubmitted.toISOString(),
          ...(handle ? { handle } : {}),
          assignments: productSetups.map((s) => ({
            baseVariantId: s.BaseVariantId,
            experimentVariantId: s.ExperimentVariantId,
            price: s.Price.toString(),
            probability: Number(s.Probability),
          })),
        };
      }
    }
    // If no active experiments, configValue is {} — the Liquid block will see
    // an empty object and the snippet will skip assignment gracefully.

    // Get shop GID for the metafield owner.
    const shopRes = await admin.graphql(GET_SHOP_ID);
    const shopJson = (await shopRes.json()) as ShopIdResponse;
    const shopGid = shopJson.data.shop.id;

    await admin.graphql(METAFIELD_UPSERT, {
      variables: {
        metafields: [
          {
            ownerId: shopGid,
            namespace: PM_METAFIELD_NAMESPACE,
            key: PM_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(configValue),
          },
        ],
      },
    });

    console.log(
      `[ProfitMax] Synced experiment metafield for ${merchantId} — ${Object.keys(configValue).length} active product(s)`,
    );
  } catch (e) {
    // Non-fatal — the metafield is an optimisation, not a hard requirement.
    // The deferred profit-max.js will still fetch config via the API route.
    console.warn("[ProfitMax] syncExperimentMetafield failed:", e);
  }
}
