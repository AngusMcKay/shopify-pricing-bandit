import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

// ---------------------------------------------------------------------------
// In-memory rate limiter
//
// Tracks impression event counts per CookieId over a rolling 60-second window.
// In production this MUST be replaced with a Redis-backed counter (e.g. using
// ioredis + INCR/EXPIRE) so limits are enforced across all server instances.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const RATE_LIMIT_MAX = 10;          // max impressions per CookieId
const RATE_LIMIT_WINDOW_MS = 60_000; // per 60 seconds

// Module-level map — survives request lifecycles within the same process.
const rateLimitStore = new Map<string, RateLimitEntry>();

// Purge stale entries periodically to prevent unbounded memory growth.
// This is safe to call on every request because it's O(n) only when entries exist.
function purgeExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
}

function checkRateLimit(cookieId: string): boolean {
  purgeExpiredEntries();

  const now = Date.now();
  const entry = rateLimitStore.get(cookieId);

  if (!entry || now - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(cookieId, { count: 1, windowStartMs: now });
    return true; // within limit
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false; // rate limited
  }

  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Request body type
// ---------------------------------------------------------------------------

interface ImpressionBody {
  CookieId: string;
  SessionId: string;
  MerchantId: string;
  ExperimentDatetimeSubmitted: string; // ISO 8601
  ProductId: string;
  ExperimentVariantId: string;
  ExperimentSubset?: string | null;
  Price: number | string;
  Currency: string;
  Market?: string | null;
  Country?: string | null;
  DeviceType: string;
  TrafficSource?: string | null;
  ReferrerURL?: string | null;
  UserAgent?: string | null;
}

// ---------------------------------------------------------------------------
// Route handler — POST only, no Shopify session auth (called from storefront)
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: ImpressionBody;
  try {
    body = (await request.json()) as ImpressionBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  const required: Array<keyof ImpressionBody> = [
    "CookieId",
    "SessionId",
    "MerchantId",
    "ExperimentDatetimeSubmitted",
    "ProductId",
    "ExperimentVariantId",
    "Price",
    "Currency",
    "DeviceType",
  ];
  for (const field of required) {
    if (body[field] == null || body[field] === "") {
      return Response.json(
        { error: `Missing required field: ${field}` },
        { status: 400 },
      );
    }
  }

  // Rate limit check
  if (!checkRateLimit(body.CookieId)) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429 },
    );
  }

  // Validate merchant exists and is active
  const merchant = await db.merchants.findUnique({
    where: { MerchantId: body.MerchantId },
    select: { IsActive: true },
  });

  if (!merchant || !merchant.IsActive) {
    return Response.json(
      { error: "Merchant not found or inactive" },
      { status: 403 },
    );
  }

  // Validate that the ExperimentVariantId belongs to an active experiment.
  // Stale JS snippets on the storefront may send impressions for experiments
  // that have since completed or been cancelled — accept silently without writing.
  // Only record impressions for Active experiments.
  // Paused and Cancelled experiments are dropped silently — the storefront
  // snippet should not be sending impressions for them (config returns
  // { active: false }), but stale snippet instances may still send them.
  const activeSetup = await db.experimentSetup.findFirst({
    where: {
      MerchantId: body.MerchantId,
      ExperimentVariantId: body.ExperimentVariantId,
      IsActive: true,
      ExperimentDatetimeSubmitted: {
        in: await db.experimentLive
          .findMany({
            where: { MerchantId: body.MerchantId, Status: "Active" },
            select: { ExperimentDatetimeSubmitted: true },
          })
          .then((rows) => rows.map((r) => r.ExperimentDatetimeSubmitted)),
      },
    },
    select: { Id: true },
  });

  if (!activeSetup) {
    // No active (non-paused) experiment for this variant — drop silently.
    return Response.json({ success: true }, { status: 200 });
  }

  // Derive IsNewVisitor — true if no prior impression exists for this CookieId
  const priorImpression = await db.impressions.findFirst({
    where: { CookieId: body.CookieId },
    select: { Id: true },
  });
  const isNewVisitor = priorImpression === null;

  let experimentDatetime: Date;
  try {
    experimentDatetime = new Date(body.ExperimentDatetimeSubmitted);
    if (isNaN(experimentDatetime.getTime())) throw new Error("invalid date");
  } catch {
    return Response.json(
      { error: "Invalid ExperimentDatetimeSubmitted — expected ISO 8601" },
      { status: 400 },
    );
  }

  try {
    await db.impressions.create({
      data: {
        CookieId: body.CookieId,
        SessionId: body.SessionId,
        Datetime: new Date(),
        MerchantId: body.MerchantId,
        ExperimentDatetimeSubmitted: experimentDatetime,
        ProductId: body.ProductId,
        ExperimentVariantId: body.ExperimentVariantId,
        ExperimentSubset: body.ExperimentSubset ?? null,
        Price: String(body.Price),
        Currency: body.Currency,
        Market: body.Market ?? null,
        Country: body.Country ?? null,
        DeviceType: body.DeviceType,
        TrafficSource: body.TrafficSource ?? null,
        ReferrerURL: body.ReferrerURL ?? null,
        UserAgent: body.UserAgent ?? null,
        IsNewVisitor: isNewVisitor,
      },
    });
  } catch (err: unknown) {
    // Unique constraint on [CookieId, ProductId, ExperimentDatetimeSubmitted] —
    // visitor cleared localStorage and re-triggered assignment. Skip silently.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return Response.json({ success: true }, { status: 200 });
    }
    throw err;
  }

  return Response.json({ success: true }, { status: 201 });
};
