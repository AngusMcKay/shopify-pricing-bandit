import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { injectSnippetIntoAllThemes } from "../services/themeInjection.server";

// ---------------------------------------------------------------------------
// Loader — runs on every authenticated admin page load
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // Detect new installs before the upsert so we can trigger one-time setup.
  const existingMerchant = await db.merchants.findUnique({
    where: { MerchantId: session.shop },
    select: { MerchantId: true },
  });
  const isNewInstall = existingMerchant === null;

  // Upsert merchant on every authenticated load — idempotent.
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

  // On first install, inject the snippet into all existing themes. Fire and forget.
  if (isNewInstall) {
    injectSnippetIntoAllThemes(admin).catch((e) => {
      console.error(`[ProfitMax] Theme injection on install failed for ${session.shop}:`, e);
    });
  }

  // Fetch unread notifications for this merchant, newest first.
  const notifications = await db.notifications.findMany({
    where: { MerchantId: session.shop, IsRead: false },
    orderBy: { CreatedAt: "desc" },
    select: { Id: true, Message: true, Type: true },
  });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", notifications };
};

// ---------------------------------------------------------------------------
// Action — POST to mark a notification as read
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { notificationId?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.notificationId) {
    return Response.json({ error: "Missing notificationId" }, { status: 400 });
  }

  // Only allow merchants to dismiss their own notifications.
  await db.notifications.updateMany({
    where: { Id: body.notificationId, MerchantId: session.shop },
    data: { IsRead: true },
  });

  return Response.json({ success: true });
};

// ---------------------------------------------------------------------------
// Notification banner component
// ---------------------------------------------------------------------------

interface NotificationBannerProps {
  id: number;
  message: string;
  type: string;
}

function NotificationBanner({ id, message, type }: NotificationBannerProps) {
  const fetcher = useFetcher();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const tone = type === "warning" ? "warning" : type === "error" ? "critical" : "info";

  const dismiss = () => {
    setDismissed(true);
    fetcher.submit(
      JSON.stringify({ notificationId: id }),
      { method: "POST", action: "/app", encType: "application/json" },
    );
  };

  return (
    <s-banner tone={tone} heading="Profit Max notification">
      <s-stack direction="inline" gap="base">
        <s-paragraph>{message}</s-paragraph>
        <s-button variant="tertiary" onClick={dismiss}>Dismiss</s-button>
      </s-stack>
    </s-banner>
  );
}

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

export default function App() {
  const { apiKey, notifications } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Overview</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/docs">Docs &amp; FAQ</s-link>
      </s-app-nav>
      {notifications.map((n: { Id: number; Message: string; Type: string }) => (
        <NotificationBanner key={n.Id} id={n.Id} message={n.Message} type={n.Type} />
      ))}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
