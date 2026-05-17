import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isEmbedEnabledOnPublishedTheme } from "../services/embedStatus.server";

// ---------------------------------------------------------------------------
// Loader — runs on every authenticated admin page load
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

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

  // Check embed status and notifications in parallel.
  const [notifications, embedEnabled] = await Promise.all([
    db.notifications.findMany({
      where: { MerchantId: session.shop, IsRead: false },
      orderBy: { CreatedAt: "desc" },
      select: { Id: true, Message: true, Type: true },
    }),
    isEmbedEnabledOnPublishedTheme(admin),
  ]);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", notifications, embedEnabled };
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
  const { apiKey, notifications, embedEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/docs">Docs &amp; FAQ</s-link>
      </s-app-nav>
      {!embedEnabled && (
        <s-banner tone="warning" heading="Profit Max embed not enabled">
          <s-paragraph>
            The Profit Max app embed is not enabled on your current theme. Experiments will not run
            until it is enabled. Go to <strong>Online Store → Themes → Customize → App embeds</strong> and
            toggle on &quot;Profit Max&quot;.
          </s-paragraph>
        </s-banner>
      )}
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
