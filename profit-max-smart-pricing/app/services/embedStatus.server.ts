import type { authenticate } from "../shopify.server";

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishedThemeResponse {
  data: {
    themes: {
      nodes: Array<{
        id: string;
        role: string;
      }>;
    };
  };
}

interface ThemeFilesResponse {
  data: {
    theme: {
      id: string;
      files: {
        edges: Array<{
          node: {
            filename: string;
            body: { content?: string } | null;
          };
        }>;
      };
    } | null;
  };
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const GET_PUBLISHED_THEME_QUERY = `#graphql
  query GetPublishedTheme {
    themes(first: 25) {
      nodes {
        id
        role
      }
    }
  }
`;

// App embed blocks are stored in config/settings_data.json under current.blocks.
// Each key is a shopify://apps/... URI; the value has a "disabled" boolean.
// We check for any block whose key contains our extension handle and is not disabled.
const GET_THEME_SETTINGS_DATA_QUERY = `#graphql
  query GetThemeSettingsData($themeId: ID!) {
    theme(id: $themeId) {
      id
      files(filenames: ["config/settings_data.json"]) {
        edges {
          node {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

// The extension handle as defined in shopify.extension.toml.
const EMBED_EXTENSION_HANDLE = "profit-max-embed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmbedEnabledInSettingsData(json: string): boolean {
  let data: Record<string, unknown>;
  try {
    // settings_data.json starts with a /* ... */ comment block — strip it before parsing.
    const stripped = json.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
    data = JSON.parse(stripped);
  } catch {
    console.warn("[PricePilot] Could not parse settings_data.json");
    return false;
  }

  const blocks = (data as { current?: { blocks?: Record<string, { type?: string; disabled?: boolean }> } })
    ?.current?.blocks;

  if (!blocks) return false;

  return Object.values(blocks).some((block) => {
    return block.type?.includes(EMBED_EXTENSION_HANDLE) && block.disabled !== true;
  });
}

async function checkEmbedOnTheme(
  admin: AdminClient,
  themeGid: string,
): Promise<boolean> {
  const extRes = await admin.graphql(GET_THEME_SETTINGS_DATA_QUERY, {
    variables: { themeId: themeGid },
  });
  const extJson = (await extRes.json()) as ThemeFilesResponse;
  const edges = extJson.data.theme?.files?.edges ?? [];
  const settingsFile = edges.find((e) => e.node.filename === "config/settings_data.json");
  const content = (settingsFile?.node.body as { content?: string } | null)?.content;

  if (!content) {
    console.warn("[PricePilot] settings_data.json not found or empty — assuming embed disabled");
    return false;
  }

  return isEmbedEnabledInSettingsData(content);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the PricePilot app embed block is enabled on the merchant's
 * currently published theme.
 *
 * Returns true as a safe fallback if the API call fails — we don't want a
 * transient API error to block activation.
 */
export async function isEmbedEnabledOnPublishedTheme(
  admin: AdminClient,
): Promise<boolean> {
  try {
    const themesRes = await admin.graphql(GET_PUBLISHED_THEME_QUERY);
    const themesJson = (await themesRes.json()) as PublishedThemeResponse;
    const publishedTheme = themesJson.data.themes.nodes.find(
      (t) => t.role === "MAIN",
    );

    if (!publishedTheme) {
      console.warn("[PricePilot] Could not find published (MAIN) theme — assuming embed enabled");
      return true;
    }

    return await checkEmbedOnTheme(admin, publishedTheme.id);
  } catch (e) {
    console.warn("[PricePilot] isEmbedEnabledOnPublishedTheme failed — assuming enabled:", e);
    return true;
  }
}

/**
 * Same check but for a specific theme GID (used by the themes/publish webhook).
 * Returns true as a safe fallback on error.
 */
export async function isEmbedEnabledOnTheme(
  admin: AdminClient,
  themeGid: string,
): Promise<boolean> {
  try {
    return await checkEmbedOnTheme(admin, themeGid);
  } catch (e) {
    console.warn(`[PricePilot] isEmbedEnabledOnTheme(${themeGid}) failed — assuming enabled:`, e);
    return true;
  }
}
