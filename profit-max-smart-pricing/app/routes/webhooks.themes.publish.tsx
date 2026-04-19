import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { isEmbedEnabledOnTheme } from "../services/embedStatus.server";
import { sendEmail } from "../services/email.server";
import { syncExperimentMetafield, ensureMetafieldDefinition } from "../services/experimentMetafield.server";

// ---------------------------------------------------------------------------
// themes/publish webhook
//
// Fired when a merchant publishes (activates) a theme.
//
// Flow:
//   1. Check whether the Profit Max app embed is enabled on the new theme.
//   2. If NOT enabled:
//      a. Pause all Active experiments (Status → "Paused").
//      b. Create a Notification for the merchant.
//      c. Send a stub email to the merchant.
//   3. If enabled — no action needed (snippet is delivered by the embed block).
// ---------------------------------------------------------------------------

interface ThemePublishPayload {
  admin_graphql_api_id: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const { admin_graphql_api_id: themeGid } = payload as ThemePublishPayload;

  if (!themeGid) {
    console.warn(`[ProfitMax] themes/publish webhook for ${shop} missing admin_graphql_api_id`);
    return new Response(null, { status: 200 });
  }

  // Retrieve an admin client using the stored offline session for this shop.
  const { admin } = await unauthenticated.admin(shop);

  // -------------------------------------------------------------------------
  // 1. Check embed status on the newly published theme
  // -------------------------------------------------------------------------
  const embedEnabled = await isEmbedEnabledOnTheme(admin, themeGid);

  if (embedEnabled) {
    // Embed is on — sync the metafield so the embed block's Liquid renders
    // the latest experiment config on the new theme.
    void (async () => {
      await ensureMetafieldDefinition(admin);
      await syncExperimentMetafield(admin, shop);
    })();
    return new Response(null, { status: 200 });
  }

  // -------------------------------------------------------------------------
  // 2. Embed is NOT enabled — pause all active experiments for this merchant
  // -------------------------------------------------------------------------
  const activeLive = await db.experimentLive.findMany({
    where: { MerchantId: shop, Status: "Active" },
    select: { ExperimentDatetimeSubmitted: true, ProductId: true },
  });

  if (activeLive.length > 0) {
    const activeDatetimes = activeLive.map((e) => e.ExperimentDatetimeSubmitted);

    await db.experimentLive.updateMany({
      where: {
        MerchantId: shop,
        Status: "Active",
        ExperimentDatetimeSubmitted: { in: activeDatetimes },
      },
      data: { Status: "Paused", LastUpdatedAt: new Date() },
    });

    console.log(
      `[ProfitMax] Paused ${activeLive.length} experiment(s) for ${shop} — embed not enabled on published theme ${themeGid}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Create an in-app notification for the merchant
  // -------------------------------------------------------------------------
  const experimentCount = activeLive.length;
  const notificationMessage =
    experimentCount > 0
      ? `Your published theme does not have the Profit Max app embed enabled. ` +
        `${experimentCount} experiment${experimentCount === 1 ? " has" : "s have"} been paused. ` +
        `Go to Online Store → Themes → Customize → App Embeds, enable Profit Max, then re-activate your experiments.`
      : `Your published theme does not have the Profit Max app embed enabled. ` +
        `Go to Online Store → Themes → Customize → App Embeds and enable Profit Max before activating experiments.`;

  // Only create a notification if the merchant exists in our DB.
  const merchantExists = await db.merchants.findUnique({
    where: { MerchantId: shop },
    select: { MerchantId: true },
  });

  if (merchantExists) {
    await db.notifications.create({
      data: {
        MerchantId: shop,
        Message: notificationMessage,
        Type: "warning",
      },
    });
  }

  // -------------------------------------------------------------------------
  // 4. Send email notification (stubbed — logs to console)
  // -------------------------------------------------------------------------
  await sendEmail({
    to: shop, // Replace with merchant's actual email when available
    subject: "Profit Max: Your experiments have been paused",
    body: notificationMessage,
  });

  return new Response(null, { status: 200 });
};
