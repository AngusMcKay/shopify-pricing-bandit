import fs from "fs";
import path from "path";
import type { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

interface ThemeNode {
  id: string;
  name: string;
  role: string;
}

interface GetThemesResponse {
  data: {
    themes: {
      nodes: ThemeNode[];
    };
  };
}

interface ThemeFileNode {
  filename: string;
  body: { content: string } | null;
}

interface GetThemeFilesResponse {
  data: {
    theme: {
      files: {
        nodes: ThemeFileNode[];
      };
    } | null;
  };
}

interface ThemeFileWriteInput {
  filename: string;
  body: { type: "TEXT"; value: string };
}

interface ThemeFilesUpsertResponse {
  data: {
    themeFilesUpsert: {
      upsertedThemeFiles: Array<{ filename: string }>;
      userErrors: Array<{ filename: string; code: string; message: string }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNIPPET_LIQUID_PATH = "snippets/profit-max.liquid";
const THEME_LIQUID_PATH = "layout/theme.liquid";
// The Liquid render tag that goes into theme.liquid. Must match the filename
// of the uploaded snippet (without extension).
const RENDER_TAG = "{% render 'profit-max' %}";

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const GET_THEMES_QUERY = `#graphql
  query GetThemes {
    themes(first: 25) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

const GET_THEME_FILES_QUERY = `#graphql
  query GetThemeFiles($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(filenames: $filenames) {
        nodes {
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
`;

const UPSERT_THEME_FILES_MUTATION = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        filename
        code
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Snippet content
//
// Reads profit-max.js from disk and wraps it in <script> tags for use as a
// Shopify Liquid snippet. The file is read on every call so deployments that
// update the JS are automatically picked up on the next inject.
//
// process.cwd() is the project root when running via `shopify app dev` or
// in production on Fly.io. The app/snippets/ directory must be included in
// the deployment artifact.
// ---------------------------------------------------------------------------

function buildSnippetContent(): string {
  const jsPath = path.join(process.cwd(), "app/snippets/profit-max.js");
  const js = fs.readFileSync(jsPath, "utf-8");
  return `<script>\n${js}\n</script>\n`;
}

// ---------------------------------------------------------------------------
// Core injection logic for a single theme
// ---------------------------------------------------------------------------

async function injectIntoTheme(
  admin: AdminClient,
  themeId: string,
  themeLabel: string,
): Promise<void> {
  // Read both the existing snippet file (if any) and theme.liquid in one query.
  const filesRes = await admin.graphql(GET_THEME_FILES_QUERY, {
    variables: {
      themeId,
      filenames: [SNIPPET_LIQUID_PATH, THEME_LIQUID_PATH],
    },
  });
  const filesJson = (await filesRes.json()) as GetThemeFilesResponse;
  const themeObj = filesJson.data.theme;

  if (!themeObj) {
    console.warn(`[ProfitMax] Theme not found: ${themeLabel} (${themeId})`);
    return;
  }

  const existingFiles = themeObj.files.nodes;
  const snippetFile = existingFiles.find((f) => f.filename === SNIPPET_LIQUID_PATH);
  const themeLiquidFile = existingFiles.find((f) => f.filename === THEME_LIQUID_PATH);

  const filesToWrite: ThemeFileWriteInput[] = [];

  // --- Snippet file ---
  // Only upload if the file is absent. If present, we assume it is current —
  // the re-inject on activation will push the latest content when experiments
  // are activated on themes that already have an older snippet. If you need
  // forced content updates, remove this check.
  if (!snippetFile) {
    console.log(`[ProfitMax] Uploading snippet to theme: ${themeLabel}`);
    filesToWrite.push({
      filename: SNIPPET_LIQUID_PATH,
      body: { type: "TEXT", value: buildSnippetContent() },
    });
  }

  // --- theme.liquid ---
  // Insert the render tag before </body> if it isn't already there.
  if (!themeLiquidFile || !themeLiquidFile.body) {
    console.warn(
      `[ProfitMax] ${THEME_LIQUID_PATH} not found in theme: ${themeLabel} — skipping render tag injection`,
    );
  } else {
    const currentContent = themeLiquidFile.body.content;
    if (currentContent.includes(RENDER_TAG)) {
      // Already injected — nothing to do.
    } else if (!currentContent.includes("</body>")) {
      console.warn(
        `[ProfitMax] No </body> tag found in ${THEME_LIQUID_PATH} for theme: ${themeLabel} — skipping render tag injection`,
      );
    } else {
      const patched = currentContent.replace(
        "</body>",
        `  ${RENDER_TAG}\n</body>`,
      );
      filesToWrite.push({
        filename: THEME_LIQUID_PATH,
        body: { type: "TEXT", value: patched },
      });
    }
  }

  if (filesToWrite.length === 0) {
    // Both checks passed — nothing to write.
    return;
  }

  const upsertRes = await admin.graphql(UPSERT_THEME_FILES_MUTATION, {
    variables: { themeId, files: filesToWrite },
  });
  const upsertJson = (await upsertRes.json()) as ThemeFilesUpsertResponse;
  const result = upsertJson.data.themeFilesUpsert;

  if (result.userErrors.length > 0) {
    console.error(
      `[ProfitMax] Theme file upsert errors for ${themeLabel}:`,
      result.userErrors,
    );
  } else {
    const written = result.upsertedThemeFiles.map((f) => f.filename).join(", ");
    console.log(`[ProfitMax] Wrote to theme ${themeLabel}: ${written}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject the profit-max snippet into all themes for this merchant.
 * Idempotent — skips files that are already present.
 * Errors for individual themes are logged but do not throw.
 */
export async function injectSnippetIntoAllThemes(
  admin: AdminClient,
): Promise<void> {
  const themesRes = await admin.graphql(GET_THEMES_QUERY);
  const themesJson = (await themesRes.json()) as GetThemesResponse;
  const themes = themesJson.data.themes.nodes;

  for (const theme of themes) {
    try {
      await injectIntoTheme(admin, theme.id, `${theme.name} (${theme.role})`);
    } catch (e) {
      console.error(
        `[ProfitMax] Theme injection failed for ${theme.name}:`,
        e,
      );
    }
  }
}

/**
 * Inject the profit-max snippet into a single theme identified by its GID.
 * Used by the themes/publish webhook handler.
 * Idempotent — skips files that are already present.
 */
export async function injectSnippetIntoThemeById(
  admin: AdminClient,
  themeGid: string,
): Promise<void> {
  await injectIntoTheme(admin, themeGid, themeGid);
}
