import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useBlocker, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fetchExperimentConfigs,
  fetchProducts,
} from "../services/stub-data";
import type { Product, ProductExperimentConfig } from "../services/stub-data";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [products, configs] = await Promise.all([
    fetchProducts(),
    fetchExperimentConfigs(),
  ]);
  return { products, configs };
};

// ---------------------------------------------------------------------------
// Local state shape — keeps price fields as strings for controlled inputs
// ---------------------------------------------------------------------------
interface ProductConfig {
  enabled: boolean;
  minPrice: string;
  maxPrice: string;
  costOfProduction: string;
  regionalVariation: boolean;
  exactPricePoints: string; // comma-separated, e.g. "29.99, 34.99, 39.99"
}

type ConfigMap = Record<string, ProductConfig>;

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
    if (!c) continue;
    result[p.id] = {
      enabled: c.enabled,
      minPrice: c.minPrice.toFixed(2),
      maxPrice: c.maxPrice.toFixed(2),
      costOfProduction: c.costOfProduction?.toFixed(2) ?? "",
      regionalVariation: c.regionalVariation,
      exactPricePoints: c.exactPricePoints.join(", "),
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
  const { products, configs: serverConfigs } =
    useLoaderData<typeof loader>();

  const initialConfigs = buildInitialConfigs(products, serverConfigs);

  const [configs, setConfigs] = useState<ConfigMap>(initialConfigs);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fineGrainedProductId, setFineGrainedProductId] = useState<
    string | null
  >(null);

  const activateModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const fineGrainedModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);

  // Block in-app navigation when there are unsaved changes
  const blocker = useBlocker(hasUnsavedChanges);

  // Block browser-level navigation (refresh, close tab, external links)
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  // If the blocker fires, show the confirm-leave modal
  useEffect(() => {
    if (blocker.state === "blocked") {
      openModal(activateModalRef); // reuse a simple confirm pattern below
    }
  }, [blocker.state]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const updateConfig = (
    productId: string,
    updates: Partial<ProductConfig>,
  ) => {
    setConfigs((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], ...updates },
    }));
    setHasUnsavedChanges(true);
  };

  const setAllEnabled = (enabled: boolean) => {
    setConfigs((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        next[id] = { ...next[id], enabled };
      }
      return next;
    });
    setHasUnsavedChanges(true);
  };

  const handleActivate = () => {
    // TODO: replace with real API call — submitExperimentConfigs(buildPayload(configs))
    setHasUnsavedChanges(false);
    closeModal(activateModalRef);
  };

  const handleCancelAll = () => {
    setConfigs((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        next[id] = { ...next[id], enabled: false };
      }
      return next;
    });
    setHasUnsavedChanges(true);
  };

  const openFineGrained = (productId: string) => {
    setFineGrainedProductId(productId);
    openModal(fineGrainedModalRef);
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
      {/* Unsaved changes banner                                              */}
      {/* ------------------------------------------------------------------ */}
      {hasUnsavedChanges && (
        <s-banner tone="warning" heading="You have unsaved changes">
          Click <s-text type="strong">Activate</s-text> to save and apply your
          configuration, or your changes will be lost if you navigate away.
        </s-banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Navigation blocker banner (in-app navigation intercepted)          */}
      {/* ------------------------------------------------------------------ */}
      {blocker.state === "blocked" && (
        <s-banner tone="critical" heading="Leave without activating?">
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
      {/* Page-level actions                                                  */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Manage all products">
        <s-stack direction="inline" gap="base">
          <s-button onClick={() => setAllEnabled(true)}>Include all</s-button>
          <s-button onClick={() => setAllEnabled(false)}>Exclude all</s-button>
          <s-button variant="secondary" onClick={handleCancelAll}>
            Cancel all experiments
          </s-button>
          <s-button
            variant="primary"
            onClick={() => openModal(activateModalRef)}
          >
            Activate
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
                </s-stack>
              </div>

              {/* Controls */}
              <div style={{ flex: 1 }}>
                {/* Include toggle */}
                <s-switch
                  label="Include in optimiser"
                  checked={config.enabled}
                  onChange={(e: Event) => {
                    updateConfig(product.id, {
                      enabled: (e.target as HTMLInputElement).checked,
                    });
                  }}
                />

                {config.enabled && (
                  <s-stack direction="block" gap="base">
                    {/* Price range row */}
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
                      <s-text-field
                        label="Cost of production ($)"
                        value={config.costOfProduction}
                        placeholder="Optional — enables profit optimisation"
                        onInput={(e: Event) => {
                          updateConfig(product.id, {
                            costOfProduction: (e.target as HTMLInputElement)
                              .value,
                          });
                        }}
                      />
                    </s-stack>

                    {/* Cost warning */}
                    {showCostWarning && (
                      <s-banner
                        tone="critical"
                        heading="Min price is below cost of production"
                      >
                        Your minimum price of ${config.minPrice} is lower than
                        your cost of production (${config.costOfProduction}).
                        You would lose money on each sale at this price.
                      </s-banner>
                    )}

                    {/* Regional variation + fine-grained controls */}
                    <s-stack direction="inline" gap="base">
                      <s-switch
                        label="Regional variation"
                        checked={config.regionalVariation}
                        onChange={(e: Event) => {
                          updateConfig(product.id, {
                            regionalVariation: (e.target as HTMLInputElement)
                              .checked,
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

          <s-section heading="Algorithm memory — coming soon">
            <s-banner tone="info" heading="Coming soon">
              Control how quickly the algorithm forgets past performance and
              re-explores prices. Useful for seasonal products or after a
              catalogue change.
            </s-banner>
          </s-section>

          <s-section heading="Exploration rate — coming soon">
            <s-banner tone="info" heading="Coming soon">
              Adjust how much traffic the algorithm allocates to exploring
              new price points vs. exploiting the current best performer.
            </s-banner>
          </s-section>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => closeModal(fineGrainedModalRef)}
        >
          Done
        </s-button>
      </s-modal>

      {/* ------------------------------------------------------------------ */}
      {/* Activate confirmation modal                                         */}
      {/* ------------------------------------------------------------------ */}
      <s-modal
        heading="Activate experiments"
        ref={activateModalRef}
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The following products will be enrolled in price optimisation:
          </s-paragraph>
          <s-unordered-list>
            {products
              .filter((p) => configs[p.id]?.enabled)
              .map((p) => (
                <s-list-item key={p.id}>
                  <s-text type="strong">{p.title}</s-text>
                  <s-text type="generic">
                    {" "}
                    — ${configs[p.id].minPrice} to ${configs[p.id].maxPrice}
                    {configs[p.id].costOfProduction
                      ? `, cost $${configs[p.id].costOfProduction} (profit optimisation on)`
                      : ""}
                    {configs[p.id].regionalVariation
                      ? ", regional variation on"
                      : ""}
                  </s-text>
                </s-list-item>
              ))}
          </s-unordered-list>
          {products.filter((p) => configs[p.id]?.enabled).length === 0 && (
            <s-banner tone="warning" heading="No products selected">
              Enable at least one product before activating.
            </s-banner>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleActivate}
          {...(products.filter((p) => configs[p.id]?.enabled).length === 0
            ? { disabled: true }
            : {})}
        >
          Confirm &amp; activate
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => closeModal(activateModalRef)}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
