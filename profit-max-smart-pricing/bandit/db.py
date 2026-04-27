"""
Database helpers for the bandit update script.

Reads from the same PostgreSQL database as the Node app (Prisma schema).
Uses psycopg2 directly — no ORM, just parameterised queries.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Generator

import psycopg2
import psycopg2.extras


def get_connection():
    """Open a new connection using DATABASE_URL from the environment."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is not set")
    return psycopg2.connect(url)


@contextmanager
def transaction(conn) -> Generator:
    """Context manager that commits on success, rolls back on error."""
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ActiveExperiment:
    merchant_id: str
    product_id: str
    experiment_datetime: datetime


@dataclass
class SetupRow:
    id: int
    merchant_id: str
    experiment_datetime: datetime
    product_id: str
    base_variant_id: str
    experiment_variant_id: str
    experiment_subset: str | None
    price: Decimal
    probability: Decimal
    bandit_round: int


@dataclass
class BanditParamRow:
    id: int
    merchant_id: str
    experiment_datetime: datetime
    product_id: str
    experiment_variant_id: str
    experiment_subset: str | None
    price: Decimal
    contextual_parameter: str  # "revenue" or "profit"
    total_impressions: int
    total_purchases: int
    model_version: int


@dataclass
class VariantStats:
    experiment_variant_id: str
    impressions: int
    purchases: int


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

def fetch_active_experiments(conn) -> list[ActiveExperiment]:
    """Get all experiments with Status = 'Active'."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "MerchantId", "ProductId", "ExperimentDatetimeSubmitted"
            FROM "ExperimentLive"
            WHERE "Status" = 'Active'
            ORDER BY "MerchantId", "ProductId"
        """)
        return [
            ActiveExperiment(
                merchant_id=row[0],
                product_id=row[1],
                experiment_datetime=row[2],
            )
            for row in cur.fetchall()
        ]


def fetch_active_setups(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
) -> list[SetupRow]:
    """Get the current active ExperimentSetup rows for one experiment."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "Id", "MerchantId", "ExperimentDatetimeSubmitted",
                   "ProductId", "BaseVariantId", "ExperimentVariantId",
                   "ExperimentSubset", "Price", "Probability", "BanditRound"
            FROM "ExperimentSetup"
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
              AND "IsActive" = true
            ORDER BY "BaseVariantId", "Price"
        """, (merchant_id, product_id, experiment_datetime))
        return [
            SetupRow(
                id=r[0], merchant_id=r[1], experiment_datetime=r[2],
                product_id=r[3], base_variant_id=r[4],
                experiment_variant_id=r[5], experiment_subset=r[6],
                price=r[7], probability=r[8], bandit_round=r[9],
            )
            for r in cur.fetchall()
        ]


def fetch_bandit_params(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
) -> list[BanditParamRow]:
    """Get current BanditParameters for one experiment."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "Id", "MerchantId", "ExperimentDatetimeSubmitted",
                   "ProductId", "ExperimentVariantId", "ExperimentSubset",
                   "Price", "ContextualParameter",
                   "TotalImpressions", "TotalPurchases", "ModelVersion"
            FROM "BanditParameters"
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
        """, (merchant_id, product_id, experiment_datetime))
        return [
            BanditParamRow(
                id=r[0], merchant_id=r[1], experiment_datetime=r[2],
                product_id=r[3], experiment_variant_id=r[4],
                experiment_subset=r[5], price=r[6],
                contextual_parameter=r[7],
                total_impressions=r[8], total_purchases=r[9],
                model_version=r[10],
            )
            for r in cur.fetchall()
        ]


def fetch_new_stats(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
) -> dict[str, VariantStats]:
    """
    Count total impressions and purchases per experiment variant.

    Returns a dict keyed by ExperimentVariantId.
    We always recount from the full tables (not incremental) so that
    the bandit parameters are self-correcting if any counts drifted.
    """
    stats: dict[str, VariantStats] = {}

    with conn.cursor() as cur:
        # Impressions
        cur.execute("""
            SELECT "ExperimentVariantId", COUNT(*)
            FROM "Impressions"
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
            GROUP BY "ExperimentVariantId"
        """, (merchant_id, product_id, experiment_datetime))
        for variant_id, count in cur.fetchall():
            stats[variant_id] = VariantStats(
                experiment_variant_id=variant_id,
                impressions=count,
                purchases=0,
            )

        # Purchases
        cur.execute("""
            SELECT "ExperimentVariantId", COUNT(*)
            FROM "Purchases"
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
            GROUP BY "ExperimentVariantId"
        """, (merchant_id, product_id, experiment_datetime))
        for variant_id, count in cur.fetchall():
            if variant_id in stats:
                stats[variant_id].purchases = count
            else:
                stats[variant_id] = VariantStats(
                    experiment_variant_id=variant_id,
                    impressions=0,
                    purchases=count,
                )

    return stats


def fetch_cost_of_production(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
) -> Decimal | None:
    """
    Get the CostOfProduction from ExperimentMerchantInputs (EAV table).
    Returns None if not set (revenue mode doesn't need it).
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "ExperimentParameterValue"
            FROM "ExperimentMerchantInputs"
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
              AND "ExperimentParameter" = 'CostOfProduction'
            LIMIT 1
        """, (merchant_id, product_id, experiment_datetime))
        row = cur.fetchone()
        return Decimal(row[0]) if row else None


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

def deactivate_setup_rows(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
) -> None:
    """Set IsActive = false on all current active setup rows for this experiment."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "ExperimentSetup"
            SET "IsActive" = false
            WHERE "MerchantId" = %s
              AND "ProductId" = %s
              AND "ExperimentDatetimeSubmitted" = %s
              AND "IsActive" = true
        """, (merchant_id, product_id, experiment_datetime))


def insert_setup_rows(conn, rows: list[dict]) -> None:
    """Insert new ExperimentSetup rows (the updated probabilities)."""
    if not rows:
        return
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO "ExperimentSetup"
                ("MerchantId", "ExperimentDatetimeSubmitted", "ProductId",
                 "BaseVariantId", "ExperimentVariantId", "ExperimentSubset",
                 "Price", "Probability", "IsActive", "BanditRound")
            VALUES %s
            """,
            [
                (
                    r["merchant_id"], r["experiment_datetime"], r["product_id"],
                    r["base_variant_id"], r["experiment_variant_id"],
                    r["experiment_subset"], r["price"], r["probability"],
                    True, r["bandit_round"],
                )
                for r in rows
            ],
        )


def update_bandit_params(
    conn,
    params: list[dict],
    now: datetime,
) -> None:
    """
    Update BanditParameters in place and append to BanditParametersHistory.
    """
    if not params:
        return
    with conn.cursor() as cur:
        for p in params:
            cur.execute("""
                UPDATE "BanditParameters"
                SET "ContextualParameterMean" = %s,
                    "ContextualParameterVariance" = %s,
                    "TotalImpressions" = %s,
                    "TotalPurchases" = %s,
                    "ModelVersion" = %s,
                    "DatetimeUpdated" = %s
                WHERE "Id" = %s
            """, (
                p["mean"], p["variance"],
                p["total_impressions"], p["total_purchases"],
                p["model_version"], now, p["id"],
            ))

            # Append to history (append-only audit log)
            cur.execute("""
                INSERT INTO "BanditParametersHistory"
                    ("MerchantId", "ExperimentDatetimeSubmitted", "ProductId",
                     "ExperimentVariantId", "ExperimentSubset", "Price",
                     "ContextualParameter", "ContextualParameterMean",
                     "ContextualParameterVariance", "TotalImpressions",
                     "TotalPurchases", "ModelVersion", "DatetimeUpdated")
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                p["merchant_id"], p["experiment_datetime"], p["product_id"],
                p["experiment_variant_id"], p["experiment_subset"], p["price"],
                p["contextual_parameter"], p["mean"], p["variance"],
                p["total_impressions"], p["total_purchases"],
                p["model_version"], now,
            ))


def fetch_product_handles_for_merchant(
    conn,
    merchant_id: str,
) -> dict[str, str]:
    """
    Get the most recent ProductHandle for each active product for a merchant.
    Returns a dict of product_id → handle (only entries where handle is not null).
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (s."ProductId") s."ProductId", s."ProductHandle"
            FROM "ExperimentMerchantProductSnapshot" s
            JOIN "ExperimentLive" el
              ON s."MerchantId" = el."MerchantId"
             AND s."ProductId" = el."ProductId"
             AND s."ExperimentDatetimeSubmitted" = el."ExperimentDatetimeSubmitted"
            WHERE s."MerchantId" = %s
              AND el."Status" = 'Active'
              AND s."ProductHandle" IS NOT NULL
            ORDER BY s."ProductId", s."ExperimentDatetimeSubmitted" DESC
        """, (merchant_id,))
        return {row[0]: row[1] for row in cur.fetchall()}


def fetch_all_active_setups_for_merchant(
    conn,
    merchant_id: str,
) -> list[SetupRow]:
    """
    Get all active ExperimentSetup rows for a merchant (all products).
    Used for building the metafield config after a bandit update.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT es."Id", es."MerchantId", es."ExperimentDatetimeSubmitted",
                   es."ProductId", es."BaseVariantId", es."ExperimentVariantId",
                   es."ExperimentSubset", es."Price", es."Probability", es."BanditRound"
            FROM "ExperimentSetup" es
            JOIN "ExperimentLive" el
              ON es."MerchantId" = el."MerchantId"
             AND es."ProductId" = el."ProductId"
             AND es."ExperimentDatetimeSubmitted" = el."ExperimentDatetimeSubmitted"
            WHERE es."MerchantId" = %s
              AND es."IsActive" = true
              AND el."Status" = 'Active'
            ORDER BY es."ProductId", es."BaseVariantId", es."Price"
        """, (merchant_id,))
        return [
            SetupRow(
                id=r[0], merchant_id=r[1], experiment_datetime=r[2],
                product_id=r[3], base_variant_id=r[4],
                experiment_variant_id=r[5], experiment_subset=r[6],
                price=r[7], probability=r[8], bandit_round=r[9],
            )
            for r in cur.fetchall()
        ]


def fetch_access_token(conn, merchant_id: str) -> str | None:
    """
    Get the Shopify access token from the Session table.
    The Session table is managed by @shopify/shopify-app-session-storage-prisma.
    Offline tokens have id = "offline_{shop}".
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "accessToken"
            FROM "Session"
            WHERE "shop" = %s
              AND "isOnline" = false
            ORDER BY "expires" DESC NULLS FIRST
            LIMIT 1
        """, (merchant_id,))
        row = cur.fetchone()
        return row[0] if row else None
