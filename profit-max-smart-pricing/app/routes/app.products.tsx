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
  productType: string;
  currentPrice: number;
  currency: string;
  unitCost: number | null;
  hasMixedPrices: boolean;
}

interface ProductExperimentConfig {
  productId: string;
  enabled: boolean;
  minPrice: number;
  maxPrice: number;
  costOfProduction?: number;
  exactPricePoints: number[];
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
  productType: string;
  isGiftCard: boolean;
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
          productType
          isGiftCard
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
      // Skip gift card products. isGiftCard is the reliable Shopify flag;
      // productType "Gift Cards" is a secondary check for older API versions.
      // Title-based filtering is avoided since merchants may sell physical
      // greeting cards named "Gift Card".
      if (p.isGiftCard || p.productType === "Gift Cards") continue;

      const firstVariant = p.variants.edges[0]?.node;
      const firstVariantPrice = firstVariant?.price ?? "0";
      const unitCostAmount = firstVariant?.inventoryItem?.unitCost?.amount;
      const baseVariants = p.variants.edges.filter(
        (e) => !e.node.selectedOptions.some((o) => o.name === "_pm_price"),
      );
      const uniquePrices = new Set(baseVariants.map((e) => e.node.price));
      products.push({
        id: p.id,
        title: p.title,
        productType: p.productType,
        currentPrice: parseFloat(firstVariantPrice),
        currency: p.priceRangeV2.minVariantPrice.currencyCode,
        unitCost: unitCostAmount != null ? parseFloat(unitCostAmount) : null,
        hasMixedPrices: uniquePrices.size > 1,
      });
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

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
        exactPricePoints: [],
        priorRate: priorRateRaw != null ? parseFloat(priorRateRaw) * 100 : undefined,
        priorStrength:
          priorStrengthRaw === "weak" || priorStrengthRaw === "medium" || priorStrengthRaw === "strong"
            ? priorStrengthRaw
            : undefined,
      });
    }
  }

  const configs: ProductExperimentConfig[] = products.map((p) => {
    const saved = savedConfigsByProductId.get(p.id);
    if (saved) return saved;
    return {
      productId: p.id,
      enabled: false,
      minPrice: parseFloat((p.currentPrice * 0.9).toFixed(2)),
      maxPrice: parseFloat((p.currentPrice * 1.1).toFixed(2)),
      costOfProduction: undefined,
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
  exactPricePoints: string; // comma-separated
  priorRate: string; // "" = use default (3%)
  priorStrength: "weak" | "medium" | "strong";
}

type ConfigMap = Record<string, ProductConfig>;

interface GlobalSettings {
  defaultCostPercent: string; // "" = not set
  // Single-digit endings (0–9): match any price where last cent digit equals the value.
  // E.g. 9 → allows .09, .19, .29, …, .99
  priceEndingDigits: number[];
  // Exact two-digit cent endings (0–99): match only that precise cent value.
  // E.g. 99 → allows only .99; 49 → allows only .49
  priceEndingExact: number[];
}

function buildInitialConfigs(
  products: Product[],
  serverConfigs: ProductExperimentConfig[],
): ConfigMap {
  const configByProductId = Object.fromEntries(
    serverConfigs.map((c) => [c.productId, c]),
  );
  const result: ConfigMap = {};
  for (const p of products) {
    const c = configByProductId[p.id];
    if (c) {
      const costStr =
        c.costOfProduction != null
          ? c.costOfProduction.toFixed(2)
          : p.unitCost != null
            ? p.unitCost.toFixed(2)
            : "";
      result[p.id] = {
        enabled: c.enabled,
        minPrice: c.minPrice.toFixed(2),
        maxPrice: c.maxPrice.toFixed(2),
        costOfProduction: costStr,
        exactPricePoints: c.exactPricePoints.join(", "),
        priorRate: c.priorRate != null ? String(c.priorRate) : "",
        priorStrength: c.priorStrength ?? "medium",
      };
    } else {
      // No active experiment — initialise with defaults so toggling on works correctly
      result[p.id] = {
        enabled: false,
        minPrice: (p.currentPrice * 0.9).toFixed(2),
        maxPrice: (p.currentPrice * 1.1).toFixed(2),
        costOfProduction: p.unitCost != null ? p.unitCost.toFixed(2) : "",
        exactPricePoints: "",
        priorRate: "",
        priorStrength: "medium",
      };
    }
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
// Info tooltip component
// ---------------------------------------------------------------------------

function InfoTooltip({ content }: { content: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <span
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          border: "1.5px solid #8c9196",
          color: "#8c9196",
          fontSize: "10px",
          fontWeight: 700,
          cursor: "help",
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        i
      </span>
      {visible && (
        <span
          style={{
            position: "absolute",
            left: "22px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "#202223",
            color: "#fff",
            borderRadius: "4px",
            padding: "8px 12px",
            fontSize: "13px",
            lineHeight: "1.5",
            width: "300px",
            zIndex: 1000,
            pointerEvents: "none",
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Price ending presets
// ---------------------------------------------------------------------------

const PRICE_ENDING_PRESETS = [
  { label: ".00", value: 0 },
  { label: ".49", value: 49 },
  { label: ".50", value: 50 },
  { label: ".99", value: 99 },
];

const PRICE_ENDINGS_TOOLTIP =
  "Last-digit chips (0–9): allow any price whose cent value ends in that digit — e.g. selecting 9 allows $9.09, $9.19, …, $9.99. " +
  "Exact chips (.49, .99 etc.): allow only that precise cent value — e.g. selecting .99 allows $9.99 but not $9.89. " +
  "Both sets combine: a price is valid if it matches any selected digit or any exact ending. " +
  "Type a number (0–99) and press Enter to add a custom exact ending.";

// ---------------------------------------------------------------------------
// Table input style helpers
// ---------------------------------------------------------------------------

function tableInputStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "6px 8px",
    border: `1px solid ${disabled ? "#e1e3e5" : "#8c9196"}`,
    borderRadius: "4px",
    fontSize: "14px",
    textAlign: "left",
    background: disabled ? "#f6f6f7" : "#fff",
    color: disabled ? "#8c9196" : "#202223",
    cursor: disabled ? "not-allowed" : "text",
    boxSizing: "border-box",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProductsPage() {
  const { products, configs: serverConfigs } = useLoaderData<typeof loader>();

  const serverConfigsRef = useRef(
    Object.fromEntries(serverConfigs.map((c) => [c.productId, c])),
  );

  const initialConfigs = buildInitialConfigs(products, serverConfigs);

  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
    defaultCostPercent: "",
    priceEndingDigits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    priceEndingExact: [],
  });
  const [priceEndingInput, setPriceEndingInput] = useState("");
  const [priceEndingError, setPriceEndingError] = useState<string | null>(null);
  const [configs, setConfigs] = useState<ConfigMap>(initialConfigs);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fineGrainedProductId, setFineGrainedProductId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activatingProgress, setActivatingProgress] = useState<{
    current: number;
    total: number;
    productName: string;
  } | null>(null);
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

  const toggleDigitEnding = (digit: number) => {
    setGlobalSettings((prev) => ({
      ...prev,
      priceEndingDigits: prev.priceEndingDigits.includes(digit)
        ? prev.priceEndingDigits.filter((d) => d !== digit)
        : [...prev.priceEndingDigits, digit].sort((a, b) => a - b),
    }));
    setHasUnsavedChanges(true);
  };

  const toggleExactEnding = (value: number) => {
    setGlobalSettings((prev) => ({
      ...prev,
      priceEndingExact: prev.priceEndingExact.includes(value)
        ? prev.priceEndingExact.filter((e) => e !== value)
        : [...prev.priceEndingExact, value].sort((a, b) => a - b),
    }));
    setHasUnsavedChanges(true);
  };

  const addCustomPriceEnding = () => {
    setPriceEndingError(null);
    const tokens = priceEndingInput
      .split(",")
      .map((t) => t.trim().replace(/^\./, "")); // strip leading dot

    const newDigits: number[] = [];
    const newExact: number[] = [];
    const invalid: string[] = [];

    for (const token of tokens) {
      if (token === "") continue;
      if (!/^\d{1,2}$/.test(token)) {
        invalid.push(token);
        continue;
      }
      const val = parseInt(token, 10);
      if (token.length === 1) {
        // Single digit → goes to last-digit row
        if (!globalSettings.priceEndingDigits.includes(val)) newDigits.push(val);
      } else {
        // Two digits → goes to exact endings row
        if (!globalSettings.priceEndingExact.includes(val)) newExact.push(val);
      }
    }

    if (invalid.length > 0) {
      setPriceEndingError(
        `Invalid: ${invalid.map((t) => `"${t}"`).join(", ")} — enter 1 or 2 digits only (e.g. 9, 75, 99)`,
      );
      return;
    }

    if (newDigits.length > 0 || newExact.length > 0) {
      setGlobalSettings((prev) => ({
        ...prev,
        priceEndingDigits: [...prev.priceEndingDigits, ...newDigits].sort((a, b) => a - b),
        priceEndingExact: [...prev.priceEndingExact, ...newExact].sort((a, b) => a - b),
      }));
      setHasUnsavedChanges(true);
    }
    setPriceEndingInput("");
  };

  // Expand single-digit endings to all matching two-digit cent values, then
  // union with exact endings. This is what gets sent to the API / pricing engine.
  const allPriceEndings = Array.from(
    new Set([
      ...globalSettings.priceEndingDigits.flatMap((d) =>
        Array.from({ length: 10 }, (_, t) => t * 10 + d),
      ),
      ...globalSettings.priceEndingExact,
    ]),
  ).sort((a, b) => a - b);

  const enabledProducts = products.filter((p) => configs[p.id]?.enabled);

  const hasConfigChanged = (productId: string): boolean => {
    const server = serverConfigsRef.current[productId];
    if (!server) return true;

    const ui = configs[productId];
    if (!ui) return false;

    if (parseFloat(ui.minPrice) !== server.minPrice) return true;
    if (parseFloat(ui.maxPrice) !== server.maxPrice) return true;

    const uiCost = ui.costOfProduction !== "" ? parseFloat(ui.costOfProduction) : undefined;
    if (uiCost !== server.costOfProduction) return true;

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

  const productsToRemove = products.filter(
    (p) => !configs[p.id]?.enabled && serverConfigsRef.current[p.id]?.enabled,
  );

  const totalChanges = changedProducts.length + productsToRemove.length;

  // ---------------------------------------------------------------------------
  // Activate handler — processes products one at a time to show progress
  // ---------------------------------------------------------------------------

  const handleSaveAndApplyConfirm = async () => {
    if (totalChanges === 0) return;

    setActivating(true);
    setActivatingProgress(null);
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

      // Step 2 — activate/update changed products one at a time
      for (let i = 0; i < changedProducts.length; i++) {
        const p = changedProducts[i];
        setActivatingProgress({
          current: i + 1,
          total: changedProducts.length,
          productName: p.title,
        });

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

        const activateRes = await fetch("/api/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "activate",
            products: [
              {
                productId: p.id,
                minPrice: parseFloat(config.minPrice),
                maxPrice: parseFloat(config.maxPrice),
                costOfProduction,
                regionalVariation: false,
                exactPricePoints: exactPoints,
                optimizationMode: "profit",
                priceEndings: allPriceEndings,
                priorRate: !isNaN(priorRate as number) ? priorRate : null,
                priorStrength: config.priorStrength,
              },
            ],
          }),
        });

        const activateData = (await activateRes.json()) as { error?: string; code?: string };
        if (!activateRes.ok) {
          setActivateResult({
            success: false,
            message: `Failed to set up "${p.title}": ${activateData.error ?? "Activation failed. Please try again."}`,
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
      setActivatingProgress(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Cancel handler
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

  const storeCurrency = products[0]?.currency ?? "USD";
  // Extract just the symbol (e.g. "$", "£", "€") for column headers.
  // Falls back to the currency code if the symbol can't be determined.
  const currencySymbol = (() => {
    try {
      const parts = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: storeCurrency,
        minimumFractionDigits: 0,
      }).formatToParts(0);
      return parts.find((p) => p.type === "currency")?.value ?? storeCurrency;
    } catch {
      return storeCurrency;
    }
  })();

  const fineGrainedProduct = fineGrainedProductId
    ? products.find((p) => p.id === fineGrainedProductId)
    : null;
  const fineGrainedConfig = fineGrainedProductId
    ? configs[fineGrainedProductId]
    : null;

  const presetExactValues = PRICE_ENDING_PRESETS.map((p) => p.value);
  const customExactEndings = globalSettings.priceEndingExact.filter(
    (e) => !presetExactValues.includes(e),
  );

  return (
    <s-page heading="Product Setup">

      {/* ------------------------------------------------------------------ */}
      {/* Result banners                                                       */}
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

      {/* Unsaved changes banner */}
      {hasUnsavedChanges && !activating && (
        <s-banner tone="warning" heading="You have unsaved changes">
          Click <s-text type="strong">Save and Apply</s-text> to save and apply your
          configuration, or your changes will be lost if you navigate away.
        </s-banner>
      )}

      {/* Loading banner with per-product progress */}
      {activating && (
        <s-banner tone="info" heading="Processing…">
          {activatingProgress
            ? `Setting up ${activatingProgress.current} of ${activatingProgress.total} products: ${activatingProgress.productName}`
            : "Please wait while we apply your configuration."}
        </s-banner>
      )}

      {/* Navigation blocker banner */}
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
          {/* Default cost of production */}
          <s-text-field
            label="Default cost of production (% of current price) — applies only when products don't have a specific cost of production already set"
            value={globalSettings.defaultCostPercent}
            placeholder="e.g. 30 (= 30% of price)"
            onInput={(e: Event) => {
              setGlobalSettings((prev) => ({
                ...prev,
                defaultCostPercent: (e.target as HTMLInputElement).value,
              }));
              setHasUnsavedChanges(true);
            }}
          />

          {/* Price endings */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <s-text type="strong">Allowable price endings</s-text>
              <InfoTooltip content={PRICE_ENDINGS_TOOLTIP} />
            </div>

            {/* Single-digit chips (last-digit matching) */}
            <div style={{ marginBottom: "8px" }}>
              <div style={{ marginBottom: "4px" }}>
                <s-text>Last digit (x.X<s-text type="strong">d</s-text>) — all selected by default</s-text>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {Array.from({ length: 10 }, (_, d) => {
                  const selected = globalSettings.priceEndingDigits.includes(d);
                  return (
                    <span
                      key={d}
                      role="checkbox"
                      aria-checked={selected}
                      onClick={() => toggleDigitEnding(d)}
                      style={{
                        cursor: "pointer",
                        padding: "5px 12px",
                        borderRadius: "4px",
                        border: `1px solid ${selected ? "#303030" : "#d9d9d9"}`,
                        color: selected ? "#303030" : "#999",
                        fontWeight: selected ? 700 : 400,
                        userSelect: "none",
                        fontSize: "0.9rem",
                        minWidth: "32px",
                        textAlign: "center",
                      }}
                    >
                      {d}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Exact two-digit chips */}
            <div>
              <div style={{ marginBottom: "4px" }}>
                <s-text>Exact endings (x.<s-text type="strong">dd</s-text>) — add specific cent values</s-text>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                {PRICE_ENDING_PRESETS.map(({ label, value }) => {
                  const selected = globalSettings.priceEndingExact.includes(value);
                  return (
                    <span
                      key={value}
                      role="checkbox"
                      aria-checked={selected}
                      onClick={() => toggleExactEnding(value)}
                      style={{
                        cursor: "pointer",
                        padding: "5px 12px",
                        borderRadius: "4px",
                        border: `1px solid ${selected ? "#303030" : "#d9d9d9"}`,
                        color: selected ? "#303030" : "#999",
                        fontWeight: selected ? 700 : 400,
                        userSelect: "none",
                        fontSize: "0.9rem",
                      }}
                    >
                      {label}
                    </span>
                  );
                })}

                {/* Custom non-preset exact endings */}
                {customExactEndings.map((e) => (
                  <span
                    key={e}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "5px 10px",
                      borderRadius: "4px",
                      border: "1px solid #303030",
                      color: "#303030",
                      fontWeight: 700,
                      fontSize: "0.9rem",
                    }}
                  >
                    .{String(e).padStart(2, "0")}
                    <button
                      onClick={() => toggleExactEnding(e)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0 2px",
                        fontSize: "14px",
                        color: "#666",
                        lineHeight: 1,
                      }}
                      aria-label={`Remove .${String(e).padStart(2, "0")}`}
                    >
                      ×
                    </button>
                  </span>
                ))}

                {/* Custom ending input */}
                <input
                  type="text"
                  value={priceEndingInput}
                  onChange={(e) => {
                    setPriceEndingInput(e.target.value);
                    setPriceEndingError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addCustomPriceEnding();
                  }}
                  placeholder="e.g. 5, 75, .99"
                  style={{
                    width: "130px",
                    padding: "5px 10px",
                    border: `1px solid ${priceEndingError ? "#d82c0d" : "#d9d9d9"}`,
                    borderRadius: "4px",
                    fontSize: "14px",
                  }}
                />
                <button
                  onClick={addCustomPriceEnding}
                  style={{
                    padding: "5px 10px",
                    border: "1px solid #8c9196",
                    borderRadius: "4px",
                    background: "#fff",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Add
                </button>
              </div>
              {priceEndingError && (
                <div style={{ marginTop: "6px", color: "#d82c0d", fontSize: "13px" }}>
                  {priceEndingError}
                </div>
              )}
            </div>
          </div>
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
      {/* Product table                                                        */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Products">
        <s-paragraph>
          Set the minimum and maximum price allowed in price tests, and costs of production so that the system can optimise based on profit margin.
        </s-paragraph>
        {/* Table header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, 2fr) 85px 80px 95px 95px 95px 120px",
            gap: "8px",
            padding: "8px 16px",
            borderBottom: "2px solid #e1e3e5",
            marginBottom: "4px",
          }}
        >
          <s-text type="strong">Product</s-text>
          <s-text type="strong">Price ({currencySymbol})</s-text>
          <s-text type="strong">Include</s-text>
          <s-text type="strong">Min ({currencySymbol})</s-text>
          <s-text type="strong">Max ({currencySymbol})</s-text>
          <s-text type="strong">Cost ({currencySymbol})</s-text>
          <div />
        </div>

        {/* Product rows */}
        {products.map((product) => {
          const config = configs[product.id];
          if (!config) return null;

          const minPriceNum = parseFloat(config.minPrice);
          const costNum = parseFloat(config.costOfProduction);
          const showCostWarning =
            config.enabled &&
            config.costOfProduction !== "" &&
            !isNaN(costNum) &&
            !isNaN(minPriceNum) &&
            minPriceNum < costNum;

          return (
            <div key={product.id}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(140px, 2fr) 85px 80px 95px 95px 95px 120px",
                  gap: "8px",
                  padding: "10px 16px",
                  alignItems: "center",
                  borderBottom: "1px solid #f1f1f1",
                }}
              >
                {/* Product name */}
                <div style={{ overflow: "hidden" }}>
                  <s-text type="strong">{product.title}</s-text>
                </div>

                {/* Current price */}
                <div style={{ color: "#6d7175", fontSize: "14px" }}>
                  {product.currentPrice.toFixed(2)}
                </div>

                {/* Include toggle */}
                <s-switch
                  checked={config.enabled}
                  aria-label={`Include ${product.title} in optimiser`}
                  onChange={(e: Event) => {
                    updateConfig(product.id, {
                      enabled: (e.target as HTMLInputElement).checked,
                    });
                  }}
                />

                {/* Min price */}
                <input
                  type="number"
                  value={config.minPrice}
                  disabled={!config.enabled || activating}
                  style={tableInputStyle(!config.enabled || activating)}
                  onChange={(e) => {
                    updateConfig(product.id, { minPrice: e.target.value });
                  }}
                />

                {/* Max price */}
                <input
                  type="number"
                  value={config.maxPrice}
                  disabled={!config.enabled || activating}
                  style={tableInputStyle(!config.enabled || activating)}
                  onChange={(e) => {
                    updateConfig(product.id, { maxPrice: e.target.value });
                  }}
                />

                {/* Cost of production */}
                <input
                  type="number"
                  value={config.costOfProduction}
                  disabled={!config.enabled || activating}
                  placeholder="Default (set above)"
                  style={tableInputStyle(!config.enabled || activating)}
                  onChange={(e) => {
                    updateConfig(product.id, { costOfProduction: e.target.value });
                  }}
                />

                {/* Additional options */}
                <s-button
                  variant="tertiary"
                  disabled={!config.enabled || activating}
                  onClick={() => openFineGrained(product.id)}
                >
                  Additional options
                </s-button>
              </div>

              {/* Per-row warnings */}
              {config.enabled && product.hasMixedPrices && (
                <div style={{ padding: "0 16px 8px" }}>
                  <s-banner tone="warning">
                    This product has variants with different base prices. Currently the app is only
                    configured to apply the same set of experiment prices to all variants, so you
                    may want to consider excluding this product. Please contact us if adding
                    functionality for multi-price products would be beneficial.
                  </s-banner>
                </div>
              )}
              {showCostWarning && (
                <div style={{ padding: "0 16px 8px" }}>
                  <s-banner tone="critical" heading="Min price is below cost of production">
                    Your minimum price of ${config.minPrice} is lower than your cost of production
                    (${config.costOfProduction}). You would lose money on each sale at this price.
                  </s-banner>
                </div>
              )}
            </div>
          );
        })}
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Additional options modal                                            */}
      {/* ------------------------------------------------------------------ */}
      <s-modal
        id="fine-grained-modal"
        heading={`Additional options — ${fineGrainedProduct?.title ?? ""}`}
        ref={fineGrainedModalRef}
      >
        <s-stack direction="block" gap="base">
          <s-section heading="Exact price points">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Enter specific prices to test, separated by commas. When set,
                these override the min / max range.
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

          <s-section heading="Initial conversion rate assumption">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                The algorithm starts with an initial baseline assumption, which helps avoid
                jumping to conclusions too quickly. As data is gathered this assumption is
                overridden by the actual conversion rate. The default assumption is 3%, but
                if you know conversion is significantly higher or lower than this then you may
                want to adjust this setting. This will only slightly alter the initial algorithm
                behaviour until it learns the true rates.
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
                Controls how quickly real data overrides the initial conversion rate
                assumption above. A <s-text type="strong">stronger</s-text> assumption
                means more data is needed before the true conversion rate overrides the
                initial assumed rate — useful for products with high traffic where you
                want stable, confident updates. A <s-text type="strong">weaker</s-text>{" "}
                assumption means the algorithm reacts faster to early data — useful for
                lower-traffic products where you want quicker adaptation, but be aware it
                may jump to conclusions, meaning some volatility before enough data is gathered to understand the true longer-term picture.
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

          <s-section heading="Regional variation — coming soon">
            <s-banner tone="info" heading="Coming soon">
              Apply different pricing strategies based on the visitor's geographic region.
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
                The following products will be enrolled in price optimisation:
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
          {changedProducts.length > 0 && allPriceEndings.length === 0 && (
            <s-banner tone="warning" heading="No price endings selected">
              Select at least one price ending in Global Settings.
            </s-banner>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSaveAndApplyConfirm}
          {...(totalChanges === 0 || (changedProducts.length > 0 && allPriceEndings.length === 0)
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
