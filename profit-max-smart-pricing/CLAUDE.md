# Profit Max: Smart Pricing — Project Guide

## What This Is

A Shopify embedded app that runs automated price experiments (A/B testing with Thompson Sampling / contextual bandits) on merchant storefronts. The app creates hidden Shopify product variants at different price points, randomly assigns visitors to see one price, and tracks impressions/purchases to optimize pricing over time.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Shopify Admin (embedded app)                           │
│  React Router flat-file routes (app/routes/app.*.tsx)   │
│  Polaris web components UI                              │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Backend API routes (app/routes/api.*.tsx)               │
│  - api.activate.tsx   — create/cancel experiments        │
│  - api.experiment-config.tsx — per-product config fetch   │
│  - api.collection-prices.tsx — batch config for lists     │
│  - api.impression.tsx — record visitor impressions        │
│  - api.products.tsx   — list merchant products            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  PostgreSQL (Prisma ORM)                                 │
│  prisma/schema.prisma                                    │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Storefront (Theme App Extension — app embed block)      │
│  extensions/profit-max-embed/                            │
│    blocks/profit-max-embed.liquid  — Liquid in <head>    │
│    assets/profit-max.js            — deferred JS          │
└─────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Bandit Optimisation (Python cron service)               │
│  bandit/                                                 │
│    run_bandit.py          — entry point (Railway cron)    │
│    thompson_sampling.py   — algorithm (swappable)         │
│    db.py                  — DB queries (psycopg2)         │
│    sync_metafield.py      — Shopify metafield update      │
└─────────────────────────────────────────────────────────┘
```

## Key Files

### Storefront (the critical path)

- **`extensions/profit-max-embed/blocks/profit-max-embed.liquid`** — App embed block with `target: "head"`. Contains anti-flicker CSS, experiment config injection via shop metafield, and page-specific product ID injection via Liquid. This is the first thing that executes on any storefront page.

- **`extensions/profit-max-embed/assets/profit-max.js`** — The main storefront script (~1000 lines). Handles: visitor ID (cookie+session), page type detection, experiment config loading (inline from `__pmConfig` or API fallback), weighted-random visitor assignment, price display, variant UI suppression, add-to-cart interception, variant-switch watching (MutationObserver), impression tracking, and collection page batch pricing. Debug mode via `?pm_debug=1`.

### Bandit Optimisation

- **`bandit/run_bandit.py`** — Entry point. Fetches all active experiments, runs Thompson Sampling per experiment, writes updated probabilities to ExperimentSetup (deactivating old rows, inserting new ones with incremented BanditRound), updates BanditParameters + history, then syncs the shop metafield. Supports `--dry-run` flag. Designed to run as a Railway cron service (daily).

- **`bandit/thompson_sampling.py`** — The algorithm module (~100 lines). Models each price point's conversion rate as Beta(purchases+1, impressions-purchases+1). Runs 10k Monte Carlo simulations to compute win probabilities. Supports both "revenue" (price × conversion) and "profit" ((price−cost) × conversion) modes. Enforces a 1% minimum probability floor to prevent premature convergence. Swappable — replacing this module changes the algorithm without touching infrastructure.

- **`bandit/db.py`** — All database queries and writes. Uses psycopg2 directly against the same PostgreSQL database as the Node app. Reads the Shopify access token from the Session table for metafield sync.

- **`bandit/sync_metafield.py`** — Rebuilds and upserts the shop metafield via the Shopify Admin GraphQL API. Mirrors the logic in `experimentMetafield.server.ts`. Called after each bandit update cycle so the storefront picks up new probabilities.

### Backend Services

- **`app/services/experimentMetafield.server.ts`** — Manages the shop metafield (`profit_max_app/experiment_config`, type `json`, `storefront: PUBLIC_READ`). Called on activate/cancel/pause to keep the metafield current. The embed block's Liquid reads this metafield at render time.

- **`app/services/embedStatus.server.ts`** — Checks whether the Profit Max app embed is enabled on the merchant's published theme. Used as a gate before activating experiments.

- **`app/services/themeHeadInjection.server.ts`** — **DEAD CODE.** Was used to inject a Liquid snippet into `layout/theme.liquid`. Replaced by moving the embed block to `target: "head"`. No longer imported anywhere. Safe to delete.

- **`app/services/email.server.ts`** — Stub email sender (logs to console).

### API Routes

- **`app/routes/api.activate.tsx`** — The most complex route. Handles `activate`, `cancel`, and `cancel_products` actions. On activate: creates `_pm_price` option on the Shopify product, creates experiment variants via `productVariantsBulkCreate`, writes to all DB tables in a transaction, then fire-and-forget syncs the metafield. On cancel: deletes experiment variants from Shopify, updates DB status.

- **`app/routes/api.experiment-config.tsx`** — Public endpoint called by `profit-max.js` on product pages when `__pmConfig` doesn't contain the product. Returns assignments for a single product.

- **`app/routes/api.collection-prices.tsx`** — Public endpoint for batch product config. Takes comma-separated product GIDs, returns assignments for all active experiments matching those products.

- **`app/routes/api.impression.tsx`** — Receives fire-and-forget POST from `profit-max.js` on first assignment per session.

### Webhooks

- **`app/routes/webhooks.themes.publish.tsx`** — When merchant publishes a new theme: checks embed status, pauses experiments if embed not enabled, creates notification, syncs metafield.

- **`app/routes/webhooks.orders.paid.tsx`** — Commented out in `shopify.app.toml` (requires "Protected customer data" approval).

### App UI

- **`app/routes/app._index.tsx`** — Overview/home page with stats
- **`app/routes/app.products.tsx`** — Product setup: price range inputs, activation controls
- **`app/routes/app.analytics.tsx`** — Charts (Recharts)
- **`app/routes/app.docs.tsx`** — Merchant-facing documentation
- **`app/routes/app.tsx`** — App shell with embed-check warning banner

## How Experiment Pricing Works

### Activation Flow
1. Merchant selects product(s), sets min/max price range and optimization mode
2. `api.activate.tsx` creates a `_pm_price` option on the Shopify product
3. Creates experiment variants: one per (base variant × price point) combination
4. Writes to DB: `ExperimentMerchantInputs` (EAV params), `ExperimentMerchantProductSnapshot`, `ExperimentSetup` (assignments), `ExperimentLive` (status), `BanditParameters`
5. Fire-and-forget: syncs shop metafield with all active experiment configs

### Storefront Display Flow
1. **Embed block Liquid** (in `<head>`, before body parse):
   - CSS hides price elements with `opacity: 0` on product/collection/index pages
   - Injects `window.__pmConfig` from shop metafield (zero-fetch config)
   - Injects `window.__pmPageProductIds` (collection) or `window.__pmPageProductId` (product)
   - Safety timeout adds `pm-prices-ready` class after 2-3s if JS never completes

2. **profit-max.js** (deferred, executes after DOM ready):
   - Detects page type (product vs collection vs other)
   - On collection pages: uses `__pmConfig` for known products, falls back to `/api/collection-prices` for any missing
   - On product pages: uses `__pmConfig` first, falls back to `/api/experiment-config`
   - Performs weighted-random assignment per base variant, cached in `sessionStorage` under `pm_assign<numericId>`
   - Writes formatted price to DOM elements matching price selectors
   - Adds `pm-prices-ready` class to `<html>` to reveal prices with CSS transition
   - Suppresses experiment variant UI (hides `_pm_price` option group, removes experiment variants from picker)
   - Intercepts add-to-cart (form submit + fetch patch) to swap base variant → experiment variant
   - Watches for theme variant-switch rewrites via MutationObserver + form change + custom events

### Key Design Decisions
- **Same price across all size/color variants**: each base variant gets its own independent random draw, but they all draw from the same probability distribution, so within a session the same price point is shown (cached in sessionStorage)
- **Exclusion-based price element scoping**: `queryPriceEls()` finds all price elements then excludes those inside carousel/recommendations containers (regex: `CAROUSEL_RE`), preferring elements near the cart form. Results are cached and invalidated on section re-render.
- **Probability is per base variant group**: `1 / pricePointCount`, not `1 / totalVariants`. E.g., 3 sizes × 5 prices = probability 0.2 per price point, not 0.067.

## Current State (as of 2026-05-17)

### What's Working
- Experiment activation/cancellation with multi-product support
- Experiment prices display on both product pages and collection pages
- Variant UI suppression (`_pm_price` option hidden from customers)
- Add-to-cart interception (customers buy the experiment variant, not the base)
- Visitor assignment consistency across pages (sessionStorage cache)
- Embed status checking and theme publish webhook
- In-app notifications when embed is disabled
- Debug mode (`?pm_debug=1`) with comprehensive console logging
- Embed block in `<head>` with anti-flicker via `opacity:0` — committed in `45f64fa`
- All Liquid consolidated into the embed block (no theme file editing)
- `write_themes` scope removed from `shopify.app.toml`

### Previously Noted Issues — Now Resolved
- ~~**Liquid deploy blocker**~~: The `{{ pm_cfg | default: '{}' | json }}` parsing bug is fixed — current file uses `pm_cfg_raw` variable pattern. Committed in `45f64fa`.
- ~~**Uncommitted embed block changes**~~: `target: "head"`, anti-flicker, Liquid consolidation, performance optimisations, and batch cache removal all committed in `45f64fa`.

### Known Issue — Scope Re-authorization
After deploying with the changed scopes (removed `write_themes`), merchants will need to re-authorize. The dev store may need `shopify app dev` re-run to pick up the scope change. Access scopes are usually auto-granted on dev.

### Known Issue — Embed Re-enable
Changing the embed block's `target` from `body` to `head` may require merchants to re-enable the embed in their theme editor (Theme Settings > App Embeds). Test this on the dev store first.

## Database

PostgreSQL via Prisma. Key tables:

| Table | Purpose |
|-------|---------|
| `ExperimentLive` | One row per active/paused/cancelled experiment per product. Status field controls visibility. |
| `ExperimentSetup` | Assignment rows: baseVariantId → experimentVariantId + price + probability. `IsActive` (default true) marks current rows; `BanditRound` (default 0) tracks which optimization round created them. Storefront queries filter `IsActive: true`. Historical rows preserved with `IsActive: false` for analytics. |
| `ExperimentMerchantInputs` | EAV table storing merchant's experiment parameters (min/max price, optimization mode, etc.) |
| `ExperimentMerchantProductSnapshot` | Point-in-time snapshot of product/variant data at experiment creation |
| `BanditParameters` | Thompson Sampling parameters per variant (mean, variance, impressions, purchases) |
| `Impressions` | Visitor impression records (one per new assignment per session) |
| `Purchases` | Purchase records tied to experiments (OrderId is unique) |
| `Notifications` | In-app merchant notifications |
| `Merchants` | Merchant records (PK = shop domain) |

## Shop Metafield

- **Namespace:** `profit_max_app`
- **Key:** `experiment_config`
- **Type:** `json`
- **Access:** `storefront: PUBLIC_READ`
- **Shape:**
```json
{
  "gid://shopify/Product/123": {
    "experimentDatetimeSubmitted": "2026-04-18T...",
    "assignments": [
      {
        "baseVariantId": "gid://shopify/ProductVariant/456",
        "experimentVariantId": "gid://shopify/ProductVariant/789",
        "price": "19.99",
        "probability": 0.2
      }
    ]
  }
}
```
- Synced on every activate/cancel/pause via `syncExperimentMetafield()`
- Read by embed block Liquid at render time: `shop.metafields.profit_max_app.experiment_config`

### Bandit Update Flow (Python scripts, daily)
1. Query `ExperimentLive` for all `Status: "Active"` experiments
2. Query `Impressions` + `Purchases` since last run
3. Run Thompson Sampling / contextual bandit update
4. In a transaction:
   - Set `IsActive = false` on current `ExperimentSetup` rows for the product (preserves history)
   - Insert new rows with updated probabilities, `IsActive = true`, `BanditRound = prev + 1`
   - Update `BanditParameters` (and append to `BanditParametersHistory`)
5. Trigger metafield sync so the storefront config updates
6. (Future) May also create new Shopify variants for price exploration

## Config & Scopes

**`shopify.app.toml`:**
- `scopes`: `read_products,write_products,read_orders,read_inventory,read_themes`
- App proxy: `prefix: "apps"`, `subpath: "profit-max"` → routes to `/apps/profit-max/api/*`
- Webhooks: `app/uninstalled`, `app/scopes_update`, `themes/publish`
- `orders/paid` webhook is commented out (needs Protected Customer Data approval)

## Currency Formatting

`formatMoney()` in `profit-max.js` uses this priority:
1. `window.Shopify.money_format` (snake_case) — exact merchant-configured format
2. `window.Shopify.moneyFormat` (camelCase) — some themes set this instead
3. `window.theme.moneyFormat` — another theme convention
4. `window.ShopifyAnalytics.meta.currency.moneyFormat` — analytics global
5. `Intl.NumberFormat('en-US', { currency })` — fallback, hardcoded `en-US` locale so USD shows as "$" not "US$"
6. Bare `amount.toFixed(2)` — last resort

## Development

```bash
shopify app dev          # Start dev server + ngrok tunnel
npx prisma studio        # Database GUI
npx prisma db push       # Sync schema to DB
```

Debug storefront JS by appending `?pm_debug=1` to any storefront URL — logs all assignment, config, and price-writing activity to the console with `[ProfitMax]` prefix.

## Common Pitfalls

- **Stale `__pmConfig`**: The metafield is synced fire-and-forget after activate/cancel. If the sync fails silently, the inline config will be stale. The JS falls back to API fetch for missing products, so this is non-fatal but means slower load for those products.
- **SessionStorage assignment cache**: Once a visitor is assigned a price for a product (stored under `pm_assign<numericId>`), they see that price for the entire browser session. To test different prices, clear sessionStorage or use incognito.
- **Experiment variant IDs in theme caches**: Some themes capture `window.Shopify.product.variants` at init time. We splice experiment variants out of the array in-place (not replace) to update their cached reference, but edge cases exist.
- **Collection page `[data-product-id]`**: Dawn and similar themes emit multiple elements with `data-product-id` per product card (wrapper, image link, title link). The JS deduplicates by numeric ID and only updates the first element that contains price children.
