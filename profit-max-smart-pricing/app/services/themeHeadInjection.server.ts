import type { authenticate } from "../shopify.server";
import { PM_METAFIELD_NAMESPACE, PM_METAFIELD_KEY } from "./experimentMetafield.server";

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// ---------------------------------------------------------------------------
// Theme head injection
//
// Inserts a small Liquid snippet into the <head> of every layout file in the
// merchant's published theme. The snippet:
//   1. Reads the shop metafield containing active experiment configs.
//   2. Embeds it as window.__pmConfig (inline JSON — zero network requests).
//   3. Embeds page-specific product IDs so collection-page assignment can
//      happen synchronously in the App Embed Block's inline script, before
//      DOMContentLoaded.
//
// The snippet is identified by a sentinel comment so inject/remove are
// idempotent and safe to call on every state change.
// ---------------------------------------------------------------------------

const SENTINEL_START = "<!-- PricePilot:start -->";
const SENTINEL_END   = "<!-- PricePilot:end -->";

/**
 * The Liquid snippet injected just before </head>.
 *
 * Uses shop.metafields.<namespace>.<key> to read the experiment config.
 * On collection pages, also embeds the product IDs visible on the page.
 * On product pages, embeds the single product's numeric ID.
 */
function buildSnippet(namespace: string, key: string): string {
  return `${SENTINEL_START}
{%- assign pm_cfg = shop.metafields.${namespace}.${key} -%}
<script>
window.__pmConfig={{ pm_cfg.value | default: '{}' | json }};
{%- if request.page_type == 'collection' -%}
window.__pmPageProductIds=[{%- for p in collection.products limit:50 -%}"gid://shopify/Product/{{ p.id }}"{%- unless forloop.last -%},{%- endunless -%}{%- endfor -%}];
{%- elsif request.page_type == 'product' -%}
window.__pmPageProductId="{{ product.id }}";
{%- elsif request.page_type == 'index' -%}
window.__pmPageProductIds=[{%- for section in sections -%}{%- for block in section.blocks -%}{%- if block.settings.product -%}"gid://shopify/Product/{{ block.settings.product.id }}"{%- unless forloop.last -%},{%- endunless -%}{%- endif -%}{%- endfor -%}{%- endfor -%}];
{%- endif -%}
</script>
${SENTINEL_END}`;
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

const GET_PUBLISHED_THEME_QUERY = `#graphql
  query GetPublishedTheme {
    themes(first: 25) {
      nodes { id role }
    }
  }
`;

const GET_THEME_FILES_QUERY = `#graphql
  query GetThemeFiles($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(filenames: $filenames) {
        nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }
`;

const UPSERT_THEME_FILES_MUTATION = `#graphql
  mutation UpsertThemeFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { filename message }
    }
  }
`;

interface ThemesResponse {
  data: { themes: { nodes: Array<{ id: string; role: string }> } };
}

interface ThemeFilesResponse {
  data: {
    theme: {
      files: {
        nodes: Array<{
          filename: string;
          body: { content: string } | null;
        }>;
      };
    } | null;
  };
}

// Layout files we want to inject into. Most themes use layout/theme.liquid;
// some add layout/password.liquid etc. We try all that exist.
const LAYOUT_FILENAMES = [
  "layout/theme.liquid",
  "layout/password.liquid",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function getPublishedThemeId(admin: AdminClient): Promise<string | null> {
  try {
    const res = await admin.graphql(GET_PUBLISHED_THEME_QUERY);
    const json = (await res.json()) as ThemesResponse;
    const main = json.data.themes.nodes.find((t) => t.role === "MAIN");
    return main?.id ?? null;
  } catch (e) {
    console.warn("[PricePilot] getPublishedThemeId failed:", e);
    return null;
  }
}

/**
 * Inject the PricePilot Liquid snippet into the published theme's layout files.
 * Idempotent — re-injecting replaces the existing snippet in-place.
 */
export async function injectHeadSnippet(admin: AdminClient): Promise<void> {
  try {
    const themeId = await getPublishedThemeId(admin);
    if (!themeId) return;

    const snippet = buildSnippet(PM_METAFIELD_NAMESPACE, PM_METAFIELD_KEY);

    // Fetch current content of all layout files.
    const filesRes = await admin.graphql(GET_THEME_FILES_QUERY, {
      variables: { themeId, filenames: LAYOUT_FILENAMES },
    });
    const filesJson = (await filesRes.json()) as ThemeFilesResponse;
    const fileNodes = filesJson.data?.theme?.files?.nodes ?? [];

    if (fileNodes.length === 0) return;

    const filesToWrite: Array<{ filename: string; body: { type: string; value: string } }> = [];

    for (const node of fileNodes) {
      if (!node.body) continue;
      let content = node.body.content;

      // Remove any existing PricePilot snippet (idempotency).
      content = content.replace(
        new RegExp(
          escapeRegex(SENTINEL_START) + "[\\s\\S]*?" + escapeRegex(SENTINEL_END),
          "g",
        ),
        "",
      );

      // Insert before </head>.
      if (!content.includes("</head>")) {
        console.warn(`[PricePilot] No </head> found in ${node.filename} — skipping`);
        continue;
      }

      content = content.replace("</head>", snippet + "\n</head>");
      filesToWrite.push({
        filename: node.filename,
        body: { type: "TEXT", value: content },
      });
    }

    if (filesToWrite.length === 0) return;

    await admin.graphql(UPSERT_THEME_FILES_MUTATION, {
      variables: { themeId, files: filesToWrite },
    });

    console.log(`[PricePilot] Injected head snippet into ${filesToWrite.map((f) => f.filename).join(", ")}`);
  } catch (e) {
    console.warn("[PricePilot] injectHeadSnippet failed:", e);
  }
}

/**
 * Remove the PricePilot snippet from all layout files in the published theme.
 * Safe to call on uninstall or cancel.
 */
export async function removeHeadSnippet(admin: AdminClient): Promise<void> {
  try {
    const themeId = await getPublishedThemeId(admin);
    if (!themeId) return;

    const filesRes = await admin.graphql(GET_THEME_FILES_QUERY, {
      variables: { themeId, filenames: LAYOUT_FILENAMES },
    });
    const filesJson = (await filesRes.json()) as ThemeFilesResponse;
    const fileNodes = filesJson.data?.theme?.files?.nodes ?? [];

    const filesToWrite: Array<{ filename: string; body: { type: string; value: string } }> = [];

    for (const node of fileNodes) {
      if (!node.body) continue;
      const original = node.body.content;
      const cleaned = original.replace(
        new RegExp(
          escapeRegex(SENTINEL_START) + "[\\s\\S]*?" + escapeRegex(SENTINEL_END),
          "g",
        ),
        "",
      );
      if (cleaned !== original) {
        filesToWrite.push({
          filename: node.filename,
          body: { type: "TEXT", value: cleaned },
        });
      }
    }

    if (filesToWrite.length === 0) return;

    await admin.graphql(UPSERT_THEME_FILES_MUTATION, {
      variables: { themeId, files: filesToWrite },
    });

    console.log(`[PricePilot] Removed head snippet from ${filesToWrite.map((f) => f.filename).join(", ")}`);
  } catch (e) {
    console.warn("[PricePilot] removeHeadSnippet failed:", e);
  }
}

/**
 * Re-inject into a specific theme GID (used by the themes/publish webhook when
 * a merchant switches to a new theme — we need to inject into the new one).
 */
export async function injectHeadSnippetIntoTheme(
  admin: AdminClient,
  themeId: string,
): Promise<void> {
  try {
    const snippet = buildSnippet(PM_METAFIELD_NAMESPACE, PM_METAFIELD_KEY);

    const filesRes = await admin.graphql(GET_THEME_FILES_QUERY, {
      variables: { themeId, filenames: LAYOUT_FILENAMES },
    });
    const filesJson = (await filesRes.json()) as ThemeFilesResponse;
    const fileNodes = filesJson.data?.theme?.files?.nodes ?? [];

    const filesToWrite: Array<{ filename: string; body: { type: string; value: string } }> = [];

    for (const node of fileNodes) {
      if (!node.body) continue;
      let content = node.body.content;
      content = content.replace(
        new RegExp(
          escapeRegex(SENTINEL_START) + "[\\s\\S]*?" + escapeRegex(SENTINEL_END),
          "g",
        ),
        "",
      );
      if (!content.includes("</head>")) continue;
      content = content.replace("</head>", snippet + "\n</head>");
      filesToWrite.push({ filename: node.filename, body: { type: "TEXT", value: content } });
    }

    if (filesToWrite.length === 0) return;

    await admin.graphql(UPSERT_THEME_FILES_MUTATION, {
      variables: { themeId, files: filesToWrite },
    });

    console.log(`[PricePilot] Injected head snippet into theme ${themeId}`);
  } catch (e) {
    console.warn(`[PricePilot] injectHeadSnippetIntoTheme(${themeId}) failed:`, e);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
