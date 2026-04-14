import type { authenticate } from "../shopify.server";

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThemeAppExtension {
  id: string;
  enabled: boolean;
}

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

interface ThemeExtensionsResponse {
  data: {
    theme: {
      id: string;
      appExtensions?: {
        nodes: ThemeAppExtension[];
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

// The themeAppExtensions field returns app embed blocks installed on the theme.
// We filter by our extension handle to check if it's enabled.
const GET_THEME_APP_EXTENSIONS_QUERY = `#graphql
  query GetThemeAppExtensions($themeId: ID!) {
    theme(id: $themeId) {
      id
      appExtensions: themeAppExtensions {
        nodes {
          id
          enabled
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the Profit Max app embed block is enabled on the merchant's
 * currently published theme.
 *
 * Returns true as a safe fallback if the API call fails — we don't want a
 * transient API error to block activation.
 */
export async function isEmbedEnabledOnPublishedTheme(
  admin: AdminClient,
): Promise<boolean> {
  try {
    // Step 1: find the published theme ID.
    const themesRes = await admin.graphql(GET_PUBLISHED_THEME_QUERY);
    const themesJson = (await themesRes.json()) as PublishedThemeResponse;
    const publishedTheme = themesJson.data.themes.nodes.find(
      (t) => t.role === "MAIN",
    );

    if (!publishedTheme) {
      console.warn("[ProfitMax] Could not find published (MAIN) theme — assuming embed enabled");
      return true;
    }

    // Step 2: check whether any app extension on that theme is enabled.
    // The themeAppExtensions field returns only extensions belonging to this app,
    // so we just need to check that at least one is enabled.
    const extRes = await admin.graphql(GET_THEME_APP_EXTENSIONS_QUERY, {
      variables: { themeId: publishedTheme.id },
    });
    const extJson = (await extRes.json()) as ThemeExtensionsResponse;
    const extensions = extJson.data.theme?.appExtensions?.nodes ?? [];

    return extensions.some((ext) => ext.enabled);
  } catch (e) {
    console.warn("[ProfitMax] isEmbedEnabledOnPublishedTheme failed — assuming enabled:", e);
    // Safe fallback: don't block activation on an API error.
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
    const extRes = await admin.graphql(GET_THEME_APP_EXTENSIONS_QUERY, {
      variables: { themeId: themeGid },
    });
    const extJson = (await extRes.json()) as ThemeExtensionsResponse;
    const extensions = extJson.data.theme?.appExtensions?.nodes ?? [];

    return extensions.some((ext) => ext.enabled);
  } catch (e) {
    console.warn(`[ProfitMax] isEmbedEnabledOnTheme(${themeGid}) failed — assuming enabled:`, e);
    return true;
  }
}
