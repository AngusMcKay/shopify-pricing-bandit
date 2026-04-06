import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ---------------------------------------------------------------------------
// Shopify webhook payload types (orders/paid)
// Only the fields we consume are typed here.
// ---------------------------------------------------------------------------

interface NoteAttribute {
  name: string;
  value: string;
}

interface DiscountCode {
  code: string;
}

interface LineItem {
  variant_id: number | null;
  price: string;
  product_id: number | null;
}

interface ShippingAddress {
  country_code: string | null;
}

interface Customer {
  orders_count: number;
}

interface OrderPayload {
  id: number;
  total_price: string;
  currency: string;
  presentment_currency?: string;
  note_attributes?: NoteAttribute[];
  discount_codes?: DiscountCode[];
  line_items: LineItem[];
  shipping_address?: ShippingAddress | null;
  customer?: Customer | null;
}

// ---------------------------------------------------------------------------
// Helper: convert a numeric Shopify variant ID to GID format.
// ExperimentSetup stores GIDs (from the GraphQL API).
// Webhook payloads deliver numeric IDs (REST format).
// ---------------------------------------------------------------------------
function toVariantGid(numericId: number): string {
  return `gid://shopify/ProductVariant/${numericId}`;
}

function toProductGid(numericId: number): string {
  return `gid://shopify/Product/${numericId}`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook verifies the HMAC signature against SHOPIFY_API_SECRET
  // and returns a 401 automatically if verification fails.
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload as OrderPayload;

  // Extract CookieId / SessionId from note_attributes set by the storefront snippet
  const noteAttributes = order.note_attributes ?? [];
  const cookieId =
    noteAttributes.find((a) => a.name === "profit_max_cookie_id")?.value ??
    null;
  const sessionId =
    noteAttributes.find((a) => a.name === "profit_max_session_id")?.value ??
    null;

  const orderId = String(order.id);
  const orderValue = order.total_price;
  const currency = order.presentment_currency ?? order.currency;
  const country = order.shipping_address?.country_code ?? null;
  const discountApplied =
    Array.isArray(order.discount_codes) && order.discount_codes.length > 0;
  const isFirstPurchase =
    order.customer == null || order.customer.orders_count <= 1;

  for (const lineItem of order.line_items) {
    if (lineItem.variant_id == null) continue;

    const variantGid = toVariantGid(lineItem.variant_id);

    // Find a matching experiment setup row for this merchant + variant
    const experimentSetup = await db.experimentSetup.findFirst({
      where: {
        MerchantId: shop,
        ExperimentVariantId: variantGid,
      },
      select: {
        ExperimentDatetimeSubmitted: true,
        ProductId: true,
        ExperimentVariantId: true,
        ExperimentSubset: true,
      },
    });

    if (!experimentSetup) {
      // This line item is not part of a Profit Max experiment — skip it.
      continue;
    }

    // Derive product GID from the line item if needed for cross-checking
    const productGid =
      lineItem.product_id != null
        ? toProductGid(lineItem.product_id)
        : experimentSetup.ProductId;

    try {
      await db.purchases.create({
        data: {
          CookieId: cookieId,
          SessionId: sessionId,
          Datetime: new Date(),
          MerchantId: shop,
          ExperimentDatetimeSubmitted:
            experimentSetup.ExperimentDatetimeSubmitted,
          ProductId: productGid,
          ExperimentVariantId: experimentSetup.ExperimentVariantId,
          ExperimentSubset: experimentSetup.ExperimentSubset,
          Price: lineItem.price,
          Currency: currency,
          Market: null, // Market not directly available in webhook payload
          Country: country,
          DeviceType: null, // Device type not available in order webhooks
          TrafficSource: null,
          OrderId: orderId,
          OrderValue: orderValue,
          IsFirstPurchase: isFirstPurchase,
          DiscountApplied: discountApplied,
        },
      });
    } catch (err: unknown) {
      // Unique constraint on OrderId — duplicate webhook delivery, skip silently.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        console.log(
          `Skipping duplicate orders/paid webhook for order ${orderId}`,
        );
        break; // OrderId is order-level, not per-line-item — no point retrying
      }
      throw err;
    }
  }

  return new Response(null, { status: 200 });
};
