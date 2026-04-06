import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Upsert merchant on every authenticated load — idempotent, handles
  // first install (create) and subsequent logins / token refreshes (update).
  await db.merchants.upsert({
    where: { MerchantId: session.shop },
    create: {
      MerchantId: session.shop,
      ShopifyAccessToken: session.accessToken ?? "",
      InstalledAt: new Date(),
      IsActive: true,
    },
    update: {
      ShopifyAccessToken: session.accessToken ?? "",
      IsActive: true,
    },
  });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Overview</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/docs">Docs &amp; FAQ</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
