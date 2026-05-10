import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useBlocker, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface Product {
  id: string;
  title: string;
  currentPrice: number;
  currency: string;
  unitCost: number | null; // from inventoryItem.unitCost of first variant
  hasMixedPrices: boolean; // true when base variants have different prices
}

interface ProductExperimentConfig {
  productId: string;
  enabled: boolean;
  minPrice: number;
  maxPrice: number;
  costOfProduction?: number;
  regionalVariation: boolean;
  exactPricePoints: number[];
  optimizationMode?: "revenue" | "profit";
  priorRate?: number;
  priorStrength?: "weak" | "medium" | "strong";
}

// ---------------------------------------------------------------------------
// GraphQL types
// ---------------------------------------------------------------------------

interface VariantNode {
  id: string;
  price: string;
  selectedOptions: Array<{ name: string }>;
  inventoryItem: {
    unitCost: { amount: string; currencyCode: string } | null;
  } | null;
}

interface ProductNode {
  id: string;
  title: string;
  status: string;
  priceRangeV2: { minVariantPrice: { currencyCode: string } };
  variants: {
    edges: Array<{ node: VariantNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface ProductsResponse {
  data: {
    products: {
      edges: Array<{ node: ProductNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

const PRODUCTS_QUERY = `#graphql
  query GetActiveProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      edges {
        node {
          id
          title
          status
          priceRangeV2 {
            minVariantPrice {
              currencyCode
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                price
                selectedOptions {
                  name
                }
                inventoryItem {
                  unitCost {
                    amount
                    currencyCode
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const products: Product[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(PRODUCTS_QUERY, { variables: { cursor } });
    const json = (await response.json()) as ProductsResponse;
    const page = json.data.products;

    for (const { node: p } of page.edges) {
      const firstVariant = p.variants.edges[0]?.node;
      const firstVariantPrice = firstVariant?.price ?? "0";
      const unitCostAmount = firstVariant?.inventoryItem?.unitCost?.amount;
      // Check if base variants have different prices. Exclude experiment
      // variants (those with a _pm_price option) so active experiments
      // don't trigger a false positive.
      const baseVariants = p.variants.edges.filter(
        (e) => !e.node.selectedOptions.some((o) => o.name === "_pm_price"),
      );
      const uniquePrices = new Set(baseVariants.map((e) => e.node.price));
      products.push({
        id: p.id,
        title: p.title,
        currentPrice: parseFloat(firstVariantPrice),
        currency: p.priceRangeV2.minVariantPrice.currencyCode,
        unitCost: unitCostAmount != null ? parseFloat(unitCostAmount) : null,
        hasMixedPrices: uniquePrices.size > 1,
      });
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  // Fetch active and paused experiment configs (two-step pattern).
  // Paused experiments are shown in the UI so merchants can see them and
  // re-activate after enabling the app embed on their new theme.
  const activeExperiments = await db.experimentLive.findMany({
    where: { MerchantId: session.shop, Status: { in: ["Active", "Paused"] } },
    select: { ExperimentDatetimeSubmitted: true, ProductId: true },
  });

  const activeDatetimes = activeExperiments.map((e) => e.ExperimentDatetimeSubmitted);
  const activeProductIds = activeExperiments.map((e) => e.ProductId);

  const rows =
    activeDatetimes.length > 0
      ? await db.experimentMerchantInputs.findMany({
          where: {
            MerchantId: session.shop,
            ExperimentDatetimeSubmitted: { in: activeDatetimes },
            ProductId: { in: activeProductIds },
          },
          orderBy: { ExperimentDatetimeSubmitted: "desc" },
          select: {
            ProductId: true,
            ExperimentDatetimeSubmitted: true,
            ExperimentParameter: true,
            ExperimentParameterValue: true,
          },
        })
      : [];

  const savedConfigsByProductId = new Map<string, ProductExperimentConfig>();

  if (rows.length > 0) {
    const latestDateByProduct = new Map<string, Date>();
    const paramsByProduct = new Map<string, Record<string, string>>();

    for (const row of rows) {
      const latestDate = latestDateByProduct.get(row.ProductId);
      if (latestDate && row.ExperimentDatetimeSubmitted.getTime() < latestDate.getTime()) {
        continue;
      }
      if (!latestDate) {
        latestDateByProduct.set(row.ProductId, row.ExperimentDatetimeSubmitted);
        paramsByProduct.set(row.ProductId, {});
      }
      const params = paramsByProduct.get(row.ProductId)!;
      if (!(row.ExperimentParameter in params)) {
        params[row.ExperimentParameter] = row.ExperimentParameterValue;
      }
    }

    for (const [productId, params] of paramsByProduct) {
      const minPrice = parseFloat(params["PriceMin"] ?? "");
      const maxPrice = parseFloat(params["PriceMax"] ?? "");
      if (isNaN(minPrice) || isNaN(maxPrice)) continue;

      const costRaw = params["CostOfProduction"];
      const costOfProduction =
        costRaw != null && costRaw !== "" ? parseFloat(costRaw) : undefined;

      const priorRateRaw = params["PriorRate"];
      const priorStrengthRaw = params["PriorStrength"];

      savedConfigsByProductId.set(productId, {
        productId,
        enabled: params["IncludedInExperiment"] === "true",
        minPrice,
        maxPrice,
        costOfProduction:
          costOfProduction !== undefined && !isNaN(costOfProduction)
            ? costOfProduction
            : undefined,
        regionalVariation: params["RegionalVariation"] === "true",
        exactPricePoints: [],
        optimizationMode:
          params["OptimizationMode"] === "profit" ? "profit" : "revenue",
        priorRate: priorRateRaw != null ? parseFloat(priorRateRaw) * 100 : undefined, // store as %
        priorStrength:
          priorStrengthRaw === "weak" || priorStrengthRaw === "medium" || priorStrengthRaw === "strong"
            ? priorStrengthRaw
            : undefined,
      });
    }
  }

  // Every product gets a config — fall back to defaults for products with no saved config
  const configs: ProductExperimentConfig[] = products.map((p) => {
    const saved = savedConfigsByProductId.get(p.id);
    if (saved) return saved;
    return {
      productId: p.id,
      enabled: false,
      minPrice: parseFloat((p.currentPrice * 0.9).toFixed(2)),
      maxPrice: parseFloat((p.currentPrice * 1.1).toFixed(2)),
      costOfProduction: undefined,
      regionalVariation: false,
      exactPricePoints: [],
      priorRate: undefined,
      priorStrength: undefined,
    };
  });

  return { products, configs };
};

// ---------------------------------------------------------------------------
// Local state shape — price fields stored as strings for controlled inputs
// ---------------------------------------------------------------------------

interface ProductConfig {
  enabled: boolean;
  minPrice: string;
  maxPrice: string;
  costOfProduction: string;
  regionalVariation: boolean;
  exactPricePoints: string; // comma-separated
  priorRate: string; // "" = use default (3%)
  priorStrength: "weak" | "medium" | "strong";
}

type ConfigMap = Record<string, ProductConfig>;

interface GlobalSettings {
  optimizationMode: "revenue" | "profit";
  defaultCostPercent: string; // "" = not set
  priceEndings: number[]; // e.g. [0.99, 0.49, 0.0]
}


function buildInitialConfigs(
  products: Product[],
  serverConfigs: ProductExperimentConfig[],
): ConfigMap {
  const configByProductId = Object.fromEntries(
    serverConfigs.map((c) => [c.productId, c]),
  );
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const result: ConfigMap = {};
  for (const p of products) {
    const c = configByProductId[p.id];
    if (!c) continue;
    const product = productById[p.id];
    // Use saved costOfProduction if present; fall back to inventory unit cost
    const costStr =
      c.costOfProduction != null
        ? c.costOfProduction.toFixed(2)
        : product?.unitCost != null
          ? product.unitCost.toFixed(2)
          : "";
    result[p.id] = {
      enabled: c.enabled,
      minPrice: c.minPrice.toFixed(2),
      maxPrice: c.maxPrice.toFixed(2),
      costOfProduction: costStr,
      regionalVariation: c.regionalVariation,
      exactPricePoints: c.exactPricePoints.join(", "),
      priorRate: c.priorRate != null ? String(c.priorRate) : "",
      priorStrength: c.priorStrength ?? "medium",
    };
  }
  return result;
}

type ModalRef = React.RefObject<HTMLElementTagNameMap["s-modal"]>;

function openModal(ref: ModalRef) {
  ref.current?.showOverlay();
}
function closeModal(ref: ModalRef) {
  ref.current?.hideOverlay();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProductsPage() {
  const { products, configs: serverConfigs } = useLoaderData<typeof loader>();

  // Frozen snapshot of the server-loaded configs indexed by productId.
  // Using a ref so it never changes as the user edits the UI.
  const serverConfigsRef = useRef(
    Object.fromEntries(serverConfigs.map((c) => [c.productId, c])),
  );

  const initialConfigs = buildInitialConfigs(products, serverConfigs);

  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
    optimizationMode: "revenue",
    defaultCostPercent: "",
    priceEndings: [9],
  });
  const [configs, setConfigs] = useState<ConfigMap>(initialConfigs);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fineGrainedProductId, setFineGrainedProductId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateResult, setActivateResult] = useState<{
    success: boolean;
    message: string;
    isEmbedError?: boolean;
  } | null>(null);

  const activateModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const cancelModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const fineGrainedModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);

  const blocker = useBlocker(hasUnsavedChanges && !activating);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (blocker.state === "blocked") openModal(activateModalRef);
  }, [blocker.state]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const updateConfig = (productId: string, updates: Partial<ProductConfig>) => {
    setConfigs((prev) => ({ ...prev, [productId]: { ...prev[productId], ...updates } }));
    setHasUnsavedChanges(true);
  };

  const setAllEnabled = (enabled: boolean) => {
    setConfigs((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) next[id] = { ...next[id], enabled };
      return next;
    });
    setHasUnsavedChanges(true);
  };

  const openFineGrained = (productId: string) => {
    setFineGrainedProductId(productId);
    openModal(fineGrainedModalRef);
  };

  const enabledProducts = products.filter((p) => configs[p.id]?.enabled);

  const hasConfigChanged = (productId: string): boolean => {
    const server = serverConfigsRef.current[productId];
    if (!server) return true; // no active experiment — always send

    const ui = configs[productId];
    if (!ui) return false;

    if (parseFloat(ui.minPrice) !== server.minPrice) return true;
    if (parseFloat(ui.maxPrice) !== server.maxPrice) return true;

    const uiCost = ui.costOfProduction !== "" ? parseFloat(ui.costOfProduction) : undefined;
    if (uiCost !== server.costOfProduction) return true;

    if (ui.regionalVariation !== server.regionalVariation) return true;

    if (globalSettings.optimizationMode !== (server.optimizationMode ?? "revenue")) return true;

    const uiExact = ui.exactPricePoints
      .split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !isNaN(n));
    if (JSON.stringify(uiExact) !== JSON.stringify(server.exactPricePoints)) return true;

    const uiPriorRate = ui.priorRate !== "" ? parseFloat(ui.priorRate) / 100 : undefined;
    if (uiPriorRate !== server.priorRate) return true;

    const uiPriorStrength = ui.priorStrength !== "medium" ? ui.priorStrength : undefined;
    if (uiPriorStrength !== server.priorStrength) return true;

    return false;
  };

  const changedProducts = enabledProducts.filter((p) => hasConfigChanged(p.id));

  // Products that have an active server experiment but are now toggled off.
  // These need to be cancelled when the user saves.
  const productsToRemove = products.filter(
    (p) => !configs[p.id]?.enabled && serverConfigsRef.current[p.id]?.enabled,
  );

  const totalChanges = changedProducts.length + productsToRemove.length;

  // ---------------------------------------------------------------------------
  // Activate handler — POST to /api/activate
  // ---------------------------------------------------------------------------

  const handleSaveAndApplyConfirm = async () => {
    if (totalChanges === 0) return;

    setActivating(true);
    setActivateResult(null);
    closeModal(activateModalRef);

    try {
      // Step 1 — cancel products that were toggled off
      if (productsToRemove.length > 0) {
        const cancelRes = await fetch("/api/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel_products",
            productIds: productsToRemove.map((p) => p.id),
          }),
        });
        const cancelData = (await cancelRes.json()) as { error?: string };
        if (!cancelRes.ok) {
          setActivateResult({
            success: false,
            message: cancelData.error ?? "Failed to cancel removed products. Please try again.",
          });
          return;
        }
      }

      // Step 2 — activate/update changed products
      if (changedProducts.length > 0) {
        const activatePayload = {
          action: "activate",
          products: changedProducts.map((p) => {
            const config = configs[p.id];
            const exactPoints = config.exactPricePoints
              .split(",")
              .map((s) => parseFloat(s.trim()))
              .filter((n) => !isNaN(n));

            let costOfProduction: number | null = null;
            if (config.costOfProduction !== "") {
              costOfProduction = parseFloat(config.costOfProduction);
            } else if (globalSettings.defaultCostPercent !== "") {
              const pct = parseFloat(globalSettings.defaultCostPercent);
              if (!isNaN(pct) && pct > 0) {
                costOfProduction = p.currentPrice * (pct / 100);
              }
            }

            const priorRate = config.priorRate !== "" ? parseFloat(config.priorRate) / 100 : null;

            return {
              productId: p.id,
              minPrice: parseFloat(config.minPrice),
              maxPrice: parseFloat(config.maxPrice),
              costOfProduction,
              regionalVariation: config.regionalVariation,
              exactPricePoints: exactPoints,
              optimizationMode: globalSettings.optimizationMode,
              priceEndings: globalSettings.priceEndings,
              priorRate: !isNaN(priorRate as number) ? priorRate : null,
              priorStrength: config.priorStrength,
            };
          }),
        };

        const activateRes = await fetch("/api/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(activatePayload),
        });
        const activateData = (await activateRes.json()) as { error?: string; code?: string };
        if (!activateRes.ok) {
          setActivateResult({
            success: false,
            message: activateData.error ?? "Activation failed. Please try again.",
            isEmbedError: activateData.code === "EMBED_NOT_ENABLED",
          });
          return;
        }
      }

      setActivateResult({ success: true, message: "Changes applied successfully! Reloading…" });
      setHasUnsavedChanges(false);
      setTimeout(() => window.location.reload(), 1800);
    } catch {
      setActivateResult({
        success: false,
        message: "Network error. Please check your connection and try again.",
      });
    } finally {
      setActivating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Cancel handler — POST to /api/activate with action: cancel
  // ---------------------------------------------------------------------------

  const handleCancelConfirm = async () => {
    setActivating(true);
    setActivateResult(null);
    closeModal(cancelModalRef);

    try {
      const res = await fetch("/api/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const data = (await res.json()) as { error?: string; cancelled?: number };

      if (res.ok) {
        setActivateResult({
          success: true,
          message:
            data.cancelled === 0
              ? "No active experiments to cancel."
              : `${data.cancelled} experiment(s) cancelled. Reloading…`,
        });
        setHasUnsavedChanges(false);
        setTimeout(() => window.location.reload(), 1800);
      } else {
        setActivateResult({
          success: false,
          message: data.error ?? "Cancellation failed. Please try again.",
        });
      }
    } catch {
      setActivateResult({
        success: false,
        message: "Network error during cancellation.",
      });
    } finally {
      setActivating(false);
    }
  };

  const fineGrainedProduct = fineGrainedProductId
    ? products.find((p) => p.id === fineGrainedProductId)
    : null;
  const fineGrainedConfig = fineGrainedProductId
    ? configs[fineGrainedProductId]
    : null;

  return (
    <s-page heading="Product Setup">

      {/* ------------------------------------------------------------------ */}
      {/* Result banners (success / error)                                    */}
      {/* ------------------------------------------------------------------ */}
      {activateResult && (
        <s-banner
          tone={activateResult.success ? "success" : "critical"}
          heading={
            activateResult.success
              ? "Done"
              : activateResult.isEmbedError
                ? "App embed not enabled"
                : "Something went wrong"
          }
        >
          <s-stack direction="block" gap="small-100">
            <s-paragraph>{activateResult.message}</s-paragraph>
            {activateResult.isEmbedError && (
              <s-paragraph>
                To enable it: open your Shopify admin → <s-text type="strong">Online Store → Themes</s-text> → <s-text type="strong">Customize</s-text> → <s-text type="strong">App Embeds</s-text> → toggle on <s-text type="strong">Profit Max</s-text>.
              </s-paragraph>
            )}
          </s-stack>
        </s-banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Unsaved changes banner                                              */}
      {/* ------------------------------------------------------------------ */}
      {hasUnsavedChanges && !activating && (
        <s-banner tone="warning" heading="You have unsaved changes">
          Click <s-text type="strong">Save and Apply</s-text> to save and apply your
          configuration, or your changes will be lost if you navigate away.
        </s-banner>
      )}

      {/* Loading banner */}
      {activating && (
        <s-banner tone="info" heading="Processing…">
          Please wait while we apply your configuration.
        </s-banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Navigation blocker banner                                           */}
      {/* ------------------------------------------------------------------ */}
      {blocker.state === "blocked" && (
        <s-banner tone="critical" heading="Leave without saving?">
          <s-stack direction="inline" gap="base">
            <s-paragraph>
              You have unsaved changes. If you leave now they will be discarded.
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={() => {
                setHasUnsavedChanges(false);
                blocker.proceed?.();
              }}
            >
              Leave anyway
            </s-button>
            <s-button onClick={() => blocker.reset?.()}>Stay</s-button>
          </s-stack>
        </s-banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Global Settings                                                     */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Global settings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            These settings apply to all products unless overridden per-product.
          </s-paragraph>

          {/* Optimisation goal */}
          <s-select
            label="Optimisation goal"
            value={globalSettings.optimizationMode}
            onChange={(e: Event) => {
              setGlobalSettings((prev) => ({
                ...prev,
                optimizationMode: (e.target as HTMLElementTagNameMap["s-select"]).value as
                  | "revenue"
                  | "profit",
              }));
              setHasUnsavedChanges(true);
            }}
          >
            <s-option value="revenue">Revenue</s-option>
            <s-option value="profit">Profit</s-option>
          </s-select>

          {/* Default cost of production — only visible in profit mode */}
          {globalSettings.optimizationMode === "profit" && (
            <s-text-field
              label="Default cost of production (% of current price)"
              value={globalSettings.defaultCostPercent}
              placeholder="e.g. 30 (= 30% of price). Overridden by per-product cost."
              onInput={(e: Event) => {
                setGlobalSettings((prev) => ({
                  ...prev,
                  defaultCostPercent: (e.target as HTMLInputElement).value,
                }));
                setHasUnsavedChanges(true);
              }}
            />
          )}

          {/* Price endings */}
          <s-stack direction="block" gap="small-100">
            <s-text type="strong">Price endings to test</s-text>
            <s-paragraph>
              Click digits to toggle. Test prices will only end in the selected
              digits (e.g. selecting 4, 5, 9 allows $4.64 and $2.85 but not
              $4.98 — that rounds to the nearest valid price).
            </s-paragraph>
            <div style={{ display: "flex", gap: "8px" }}>
              {Array.from({ length: 10 }, (_, digit) => {
                const selected = globalSettings.priceEndings.includes(digit);
                return (
                  <span
                    key={digit}
                    role="checkbox"
                    aria-checked={selected}
                    onClick={() => {
                      setGlobalSettings((prev) => ({
                        ...prev,
                        priceEndings: selected
                          ? prev.priceEndings.filter((d) => d !== digit)
                          : [...prev.priceEndings, digit].sort((a, b) => a - b),
                      }));
                      setHasUnsavedChanges(true);
                    }}
                    style={{
                      cursor: "pointer",
                      padding: "6px 14px",
                      borderRadius: "4px",
                      border: `1px solid ${selected ? "#303030" : "#d9d9d9"}`,
                      color: selected ? "#303030" : "#999",
                      fontWeight: selected ? 700 : 400,
                      userSelect: "none",
                      fontSize: "1rem",
                    }}
                  >
                    {digit}
                  </span>
                );
              })}
            </div>
          </s-stack>
        </s-stack>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Page-level actions                                                  */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Manage all products">
        <s-stack direction="inline" gap="base">
          <s-button onClick={() => setAllEnabled(true)} disabled={activating}>
            Include all
          </s-button>
          <s-button onClick={() => setAllEnabled(false)} disabled={activating}>
            Exclude all
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => openModal(cancelModalRef)}
            disabled={activating}
          >
            Cancel all experiments
          </s-button>
          <s-button
            variant="primary"
            onClick={() => openModal(activateModalRef)}
            disabled={activating || totalChanges === 0}
          >
            {activating ? "Processing…" : `Save and Apply (${totalChanges})`}
          </s-button>
        </s-stack>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Product list                                                        */}
      {/* ------------------------------------------------------------------ */}
      {products.map((product) => {
        const config = configs[product.id];
        if (!config) return null;

        const minPriceNum = parseFloat(config.minPrice);
        const costNum = parseFloat(config.costOfProduction);
        const showCostWarning =
          config.costOfProduction !== "" &&
          !isNaN(costNum) &&
          !isNaN(minPriceNum) &&
          minPriceNum < costNum;

        return (
          <s-section key={product.id}>
            <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
              {/* Product info */}
              <div style={{ minWidth: "200px" }}>
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">{product.title}</s-text>
                  <s-paragraph>
                    Current price: ${product.currentPrice.toFixed(2)}{" "}
                    {product.currency}
                  </s-paragraph>
                  {product.unitCost != null && (
                    <s-paragraph>
                      Unit cost: ${product.unitCost.toFixed(2)}
                    </s-paragraph>
                  )}
                </s-stack>
              </div>

              {/* Controls */}
              <div style={{ flex: 1 }}>
                <s-switch
                  label="Include in optimiser"
                  checked={config.enabled}
                  onChange={(e: Event) => {
                    updateConfig(product.id, {
                      enabled: (e.target as HTMLInputElement).checked,
                    });
                  }}
                />

                {config.enabled && product.hasMixedPrices && (
                  <s-banner tone="warning">
                    This product has variants with different base prices.
                    Price experiments work best when all variants share the
                    same price. Consider excluding this product or adjusting
                    variant prices first.
                  </s-banner>
                )}

                {config.enabled && (
                  <s-stack direction="block" gap="base">
                    <s-stack direction="inline" gap="base">
                      <s-text-field
                        label="Min price ($)"
                        value={config.minPrice}
                        onInput={(e: Event) => {
                          updateConfig(product.id, {
                            minPrice: (e.target as HTMLInputElement).value,
                          });
                        }}
                      />
                      <s-text-field
                        label="Max price ($)"
                        value={config.maxPrice}
                        onInput={(e: Event) => {
                          updateConfig(product.id, {
                            maxPrice: (e.target as HTMLInputElement).value,
                          });
                        }}
                      />
                      {globalSettings.optimizationMode === "profit" && (
                        <s-text-field
                          label="Cost of production ($)"
                          value={config.costOfProduction}
                          placeholder="Optional"
                          onInput={(e: Event) => {
                            updateConfig(product.id, {
                              costOfProduction: (e.target as HTMLInputElement).value,
                            });
                          }}
                        />
                      )}
                    </s-stack>

                    {showCostWarning && (
                      <s-banner
                        tone="critical"
                        heading="Min price is below cost of production"
                      >
                        Your minimum price of ${config.minPrice} is lower than
                        your cost of production (${config.costOfProduction}). You
                        would lose money on each sale at this price.
                      </s-banner>
                    )}

                    <s-stack direction="inline" gap="base">
                      <s-switch
                        label="Regional variation"
                        checked={config.regionalVariation}
                        onChange={(e: Event) => {
                          updateConfig(product.id, {
                            regionalVariation: (e.target as HTMLInputElement).checked,
                          });
                        }}
                      />
                      <s-button
                        variant="tertiary"
                        onClick={() => openFineGrained(product.id)}
                      >
                        Fine-grained controls
                      </s-button>
                    </s-stack>
                  </s-stack>
                )}
              </div>
            </div>
          </s-section>
        );
      })}

      {/* ------------------------------------------------------------------ */}
      {/* Fine-grained controls modal                                         */}
      {/* ------------------------------------------------------------------ */}
      <s-modal
        id="fine-grained-modal"
        heading={`Fine-grained controls — ${fineGrainedProduct?.title ?? ""}`}
        ref={fineGrainedModalRef}
      >
        <s-stack direction="block" gap="base">
          <s-section heading="Exact price points">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Enter specific prices to test, separated by commas. When set,
                these override the min / max range above.
              </s-paragraph>
              <s-text-field
                label="Price points ($)"
                value={fineGrainedConfig?.exactPricePoints ?? ""}
                placeholder="e.g. 29.99, 34.99, 39.99"
                onInput={(e: Event) => {
                  if (!fineGrainedProductId) return;
                  updateConfig(fineGrainedProductId, {
                    exactPricePoints: (e.target as HTMLInputElement).value,
                  });
                }}
              />
            </s-stack>
          </s-section>

          <s-section heading="Prior conversion rate assumption">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                When there is little or no data for this product, the algorithm assumes a
                baseline conversion rate to avoid jumping to conclusions too quickly. The
                default is 3% — a reasonable starting point for most online stores. You
                can adjust this if you know your store converts significantly higher or
                lower. Over time, as real data accumulates, this assumption has less and
                less effect on the result.
              </s-paragraph>
              <s-text-field
                label="Assumed conversion rate (%)"
                value={fineGrainedConfig?.priorRate ?? ""}
                placeholder="Default: 3"
                onInput={(e: Event) => {
                  if (!fineGrainedProductId) return;
                  updateConfig(fineGrainedProductId, {
                    priorRate: (e.target as HTMLInputElement).value,
                  });
                }}
              />
            </s-stack>
          </s-section>

          <s-section heading="Assumption strength">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Controls how quickly real data overrides the initial assumption above.
                A <s-text type="strong">stronger</s-text> prior means more data is
                needed before the algorithm shifts probabilities — useful for products
                with high traffic where you want stable, confident updates.
                A <s-text type="strong">weaker</s-text> prior means the algorithm
                reacts faster to early data — useful for lower-traffic products where
                you want quicker adaptation, but be aware it may jump to conclusions
                before the longer-term picture is clear. When you have hundreds of
                impressions and multiple purchases per day, the strength setting makes
                little practical difference.
              </s-paragraph>
              <s-select
                label="Assumption strength"
                value={fineGrainedConfig?.priorStrength ?? "medium"}
                onChange={(e: Event) => {
                  if (!fineGrainedProductId) return;
                  updateConfig(fineGrainedProductId, {
                    priorStrength: (e.target as HTMLElementTagNameMap["s-select"]).value as
                      "weak" | "medium" | "strong",
                  });
                }}
              >
                <s-option value="weak">Weak — reacts quickly (~33 pseudo-observations)</s-option>
                <s-option value="medium">Medium — balanced (~100 pseudo-observations)</s-option>
                <s-option value="strong">Strong — reacts slowly (~250 pseudo-observations)</s-option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading="Exploration rate — coming soon">
            <s-banner tone="info" heading="Coming soon">
              Adjust how much traffic the algorithm allocates to exploring new
              price points vs. exploiting the current best performer.
            </s-banner>
          </s-section>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="fine-grained-modal"
          command="--hide"
        >
          Done
        </s-button>
      </s-modal>

      {/* ------------------------------------------------------------------ */}
      {/* Activate confirmation modal                                         */}
      {/* ------------------------------------------------------------------ */}
      <s-modal id="activate-modal" heading="Save and Apply" ref={activateModalRef}>
        <s-stack direction="block" gap="base">
          {changedProducts.length > 0 && (
            <>
              <s-paragraph>
                The following products will be enrolled in price optimisation using{" "}
                <s-text type="strong">
                  {globalSettings.optimizationMode === "revenue"
                    ? "revenue maximisation"
                    : "profit maximisation"}
                </s-text>
                :
              </s-paragraph>
              <s-unordered-list>
                {changedProducts.map((p) => (
                  <s-list-item key={p.id}>
                    <s-text type="strong">{p.title}</s-text>
                    <s-text type="generic">
                      {" "}
                      — ${configs[p.id].minPrice} to ${configs[p.id].maxPrice}
                      {configs[p.id].costOfProduction
                        ? `, cost $${configs[p.id].costOfProduction}`
                        : ""}
                      {configs[p.id].regionalVariation ? ", regional variation on" : ""}
                    </s-text>
                  </s-list-item>
                ))}
              </s-unordered-list>
            </>
          )}
          {productsToRemove.length > 0 && (
            <>
              <s-paragraph>
                The following products will have their experiments{" "}
                <s-text type="strong">stopped and removed</s-text>:
              </s-paragraph>
              <s-unordered-list>
                {productsToRemove.map((p) => (
                  <s-list-item key={p.id}>
                    <s-text type="strong">{p.title}</s-text>
                  </s-list-item>
                ))}
              </s-unordered-list>
            </>
          )}
          {totalChanges === 0 && (
            <s-banner tone="warning" heading="No changes to apply">
              All enabled products already match their active experiment config.
            </s-banner>
          )}
          {changedProducts.length > 0 && globalSettings.priceEndings.length === 0 && (
            <s-banner tone="warning" heading="No price endings selected">
              Select at least one price ending in Global Settings.
            </s-banner>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSaveAndApplyConfirm}
          {...(totalChanges === 0 || (changedProducts.length > 0 && globalSettings.priceEndings.length === 0)
            ? { disabled: true }
            : {})}
        >
          Confirm and save
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="activate-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      {/* ------------------------------------------------------------------ */}
      {/* Cancel confirmation modal                                           */}
      {/* ------------------------------------------------------------------ */}
      <s-modal id="cancel-modal" heading="Cancel all experiments" ref={cancelModalRef}>
        <s-stack direction="block" gap="base">
          <s-banner tone="warning" heading="This action cannot be undone">
            All active price experiments will be stopped and the experiment
            variants will be removed from your products. Your original prices
            will remain unchanged.
          </s-banner>
          <s-paragraph>
            Are you sure you want to cancel all running experiments?
          </s-paragraph>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleCancelConfirm}
        >
          Yes, cancel all experiments
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="cancel-modal"
          command="--hide"
        >
          Keep running
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
