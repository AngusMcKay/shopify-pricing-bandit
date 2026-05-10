#!/usr/bin/env python3
"""
Seed realistic test impression and purchase data for active experiments.

For each active experiment, generates impressions spread over the past 30 days
with conversion rates that decrease as price increases — i.e. lower prices
convert slightly better. This produces the kind of data the bandit needs to
meaningfully update probabilities, and gives the analytics page real data to display.

Usage:
    python3 seed_test_data.py                    # seed all active experiments
    python3 seed_test_data.py --clear            # remove all seeded data first
    python3 seed_test_data.py --clear --dry-run  # preview without writing

Environment:
    DATABASE_URL  — PostgreSQL connection string (same as the Node app)

Seeded rows are identifiable by:
    Impressions.UserAgent = 'seed-test-data'
    Purchases.TrafficSource = 'seed-test-data'
"""

from __future__ import annotations

import argparse
import random
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg2
import psycopg2.extras

from db import get_connection, fetch_active_experiments, fetch_active_setups

# Reproducible results across runs for the same experiment state.
random.seed(42)

SEED_TAG = "seed-test-data"

# Impressions per price point per day — uniform random within this range.
IMPRESSIONS_PER_PRICE_PER_DAY_MIN = 6
IMPRESSIONS_PER_PRICE_PER_DAY_MAX = 14

# Conversion rate model: base rate + premium * (n_prices - 1 - rank)
# where rank 0 = lowest price, rank n-1 = highest price.
# E.g. with 5 prices: lowest → 4.9%, highest → 2.5%
BASE_CONVERSION_RATE = 0.025
CONVERSION_RATE_PREMIUM_PER_RANK = 0.006

SEED_DAYS = 30


def price_sorted_variants(setups) -> list[tuple[str, str]]:
    """
    Return deduplicated (price_str, experiment_variant_id) pairs sorted by price ascending.
    In the linked-draws case (multiple base variants same price), keeps one representative
    variant per price — the bandit aggregates all variants at each price anyway.
    """
    seen_prices: set[str] = set()
    result = []
    for s in sorted(setups, key=lambda x: x.price):
        price_str = str(s.price)
        if price_str not in seen_prices:
            seen_prices.add(price_str)
            result.append((price_str, s.experiment_variant_id))
    return result


def seed_experiment(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
    dry_run: bool,
) -> tuple[int, int]:
    """Seed one experiment. Returns (impressions_inserted, purchases_inserted)."""
    setups = fetch_active_setups(conn, merchant_id, product_id, experiment_datetime)
    if not setups:
        print(f"  No active setups for {product_id[:40]} — skipping")
        return 0, 0

    price_variants = price_sorted_variants(setups)
    n_prices = len(price_variants)
    if n_prices == 0:
        return 0, 0

    now = datetime.now(timezone.utc)
    impression_rows = []
    purchase_rows = []

    for day_offset in range(SEED_DAYS):
        day_start = now - timedelta(days=SEED_DAYS - day_offset)
        day_start = day_start.replace(hour=0, minute=0, second=0, microsecond=0)

        for rank, (price_str, variant_id) in enumerate(price_variants):
            conv_rate = BASE_CONVERSION_RATE + CONVERSION_RATE_PREMIUM_PER_RANK * (n_prices - 1 - rank)
            n_impressions = random.randint(
                IMPRESSIONS_PER_PRICE_PER_DAY_MIN,
                IMPRESSIONS_PER_PRICE_PER_DAY_MAX,
            )

            for _ in range(n_impressions):
                cookie_id = str(uuid.uuid4())
                imp_time = day_start + timedelta(seconds=random.randint(0, 86399))
                impression_rows.append({
                    "cookie_id": cookie_id,
                    "session_id": cookie_id,
                    "datetime": imp_time,
                    "merchant_id": merchant_id,
                    "experiment_datetime": experiment_datetime,
                    "product_id": product_id,
                    "experiment_variant_id": variant_id,
                    "experiment_subset": None,
                    "price": Decimal(price_str),
                    "currency": "USD",
                    "market": None,
                    "country": "US",
                    "device_type": random.choice(["desktop", "mobile"]),
                    "traffic_source": None,
                    "referrer_url": None,
                    "user_agent": SEED_TAG,
                    "is_new_visitor": True,
                })

                if random.random() < conv_rate:
                    pur_time = imp_time + timedelta(seconds=random.randint(30, 600))
                    purchase_rows.append({
                        "cookie_id": cookie_id,
                        "session_id": cookie_id,
                        "datetime": pur_time,
                        "merchant_id": merchant_id,
                        "experiment_datetime": experiment_datetime,
                        "product_id": product_id,
                        "experiment_variant_id": variant_id,
                        "experiment_subset": None,
                        "price": Decimal(price_str),
                        "currency": "USD",
                        "market": None,
                        "country": "US",
                        "device_type": None,
                        "traffic_source": SEED_TAG,
                        "order_id": f"SEED-{uuid.uuid4()}",
                        "order_value": Decimal(price_str),
                        "is_first_purchase": True,
                        "discount_applied": False,
                    })

    if dry_run:
        print(f"  DRY RUN — would insert {len(impression_rows)} impressions, {len(purchase_rows)} purchases")
        return len(impression_rows), len(purchase_rows)

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO "Impressions"
                ("CookieId", "SessionId", "Datetime", "MerchantId",
                 "ExperimentDatetimeSubmitted", "ProductId", "ExperimentVariantId",
                 "ExperimentSubset", "Price", "Currency", "Market", "Country",
                 "DeviceType", "TrafficSource", "ReferrerURL", "UserAgent", "IsNewVisitor")
            VALUES %s
            ON CONFLICT DO NOTHING
            """,
            [
                (
                    r["cookie_id"], r["session_id"], r["datetime"], r["merchant_id"],
                    r["experiment_datetime"], r["product_id"], r["experiment_variant_id"],
                    r["experiment_subset"], r["price"], r["currency"], r["market"],
                    r["country"], r["device_type"], r["traffic_source"],
                    r["referrer_url"], r["user_agent"], r["is_new_visitor"],
                )
                for r in impression_rows
            ],
        )

        if purchase_rows:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO "Purchases"
                    ("CookieId", "SessionId", "Datetime", "MerchantId",
                     "ExperimentDatetimeSubmitted", "ProductId", "ExperimentVariantId",
                     "ExperimentSubset", "Price", "Currency", "Market", "Country",
                     "DeviceType", "TrafficSource", "OrderId", "OrderValue",
                     "IsFirstPurchase", "DiscountApplied")
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                [
                    (
                        r["cookie_id"], r["session_id"], r["datetime"], r["merchant_id"],
                        r["experiment_datetime"], r["product_id"], r["experiment_variant_id"],
                        r["experiment_subset"], r["price"], r["currency"], r["market"],
                        r["country"], r["device_type"], r["traffic_source"],
                        r["order_id"], r["order_value"], r["is_first_purchase"],
                        r["discount_applied"],
                    )
                    for r in purchase_rows
                ],
            )

    conn.commit()
    return len(impression_rows), len(purchase_rows)


def clear_seeded_data(conn, dry_run: bool) -> None:
    """Remove all rows previously inserted by this script."""
    with conn.cursor() as cur:
        if dry_run:
            cur.execute('SELECT COUNT(*) FROM "Impressions" WHERE "UserAgent" = %s', (SEED_TAG,))
            imp_count = cur.fetchone()[0]
            cur.execute('SELECT COUNT(*) FROM "Purchases" WHERE "TrafficSource" = %s', (SEED_TAG,))
            pur_count = cur.fetchone()[0]
            print(f"DRY RUN — would delete {imp_count} impressions, {pur_count} purchases")
            return

        cur.execute('DELETE FROM "Impressions" WHERE "UserAgent" = %s', (SEED_TAG,))
        imp_deleted = cur.rowcount
        cur.execute('DELETE FROM "Purchases" WHERE "TrafficSource" = %s', (SEED_TAG,))
        pur_deleted = cur.rowcount

    conn.commit()
    print(f"Cleared {imp_deleted} seeded impressions, {pur_deleted} seeded purchases")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed test impression and purchase data")
    parser.add_argument("--clear", action="store_true", help="Delete previously seeded data first")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    conn = get_connection()
    try:
        if args.clear:
            clear_seeded_data(conn, dry_run=args.dry_run)

        experiments = fetch_active_experiments(conn)
        if not experiments:
            print("No active experiments found — nothing to seed")
            return

        print(f"Found {len(experiments)} active experiment(s)")
        total_imps, total_purs = 0, 0

        for exp in experiments:
            print(f"\nSeeding {exp.merchant_id} / {exp.product_id[:60]}")
            imps, purs = seed_experiment(
                conn,
                exp.merchant_id,
                exp.product_id,
                exp.experiment_datetime,
                dry_run=args.dry_run,
            )
            print(f"  → {imps} impressions, {purs} purchases")
            total_imps += imps
            total_purs += purs

        print(f"\nTotal: {total_imps} impressions, {total_purs} purchases inserted")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
