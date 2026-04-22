#!/usr/bin/env python3
"""
Bandit update script — entry point for the Railway cron service.

Runs Thompson Sampling on all active experiments, updates probabilities
in ExperimentSetup, updates BanditParameters, and syncs the Shopify
shop metafield so the storefront picks up the new weights.

Usage:
    python run_bandit.py              # process all active experiments
    python run_bandit.py --dry-run    # compute new probabilities but don't write

Environment:
    DATABASE_URL  — PostgreSQL connection string (same as the Node app)
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from db import (
    fetch_active_experiments,
    fetch_active_setups,
    fetch_bandit_params,
    fetch_cost_of_production,
    fetch_new_stats,
    deactivate_setup_rows,
    get_connection,
    insert_setup_rows,
    transaction,
    update_bandit_params,
)
from sync_metafield import sync_metafield_for_merchant
from thompson_sampling import VariantInput, run_thompson_sampling

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("bandit")


def process_experiment(
    conn,
    merchant_id: str,
    product_id: str,
    experiment_datetime: datetime,
    dry_run: bool = False,
) -> bool:
    """
    Run one bandit update cycle for a single experiment (merchant + product).

    Returns True if probabilities were updated, False if skipped.
    """
    # Fetch current state.
    setups = fetch_active_setups(conn, merchant_id, product_id, experiment_datetime)
    if not setups:
        logger.warning(
            "No active setup rows for %s / %s — skipping",
            merchant_id, product_id,
        )
        return False

    bandit_params = fetch_bandit_params(conn, merchant_id, product_id, experiment_datetime)
    params_by_variant = {p.experiment_variant_id: p for p in bandit_params}

    stats = fetch_new_stats(conn, merchant_id, product_id, experiment_datetime)

    # Determine optimisation mode from bandit params.
    mode = "revenue"
    if bandit_params:
        mode = bandit_params[0].contextual_parameter

    cost = None
    if mode == "profit":
        cost = fetch_cost_of_production(conn, merchant_id, product_id, experiment_datetime)
        if cost is None:
            logger.warning(
                "Profit mode but no CostOfProduction for %s / %s — falling back to revenue",
                merchant_id, product_id,
            )
            mode = "revenue"

    # Group setups by base variant — Thompson Sampling runs per group
    # because probabilities must sum to 1.0 within each base variant.
    by_base: dict[str, list] = defaultdict(list)
    for s in setups:
        by_base[s.base_variant_id].append(s)

    # Run Thompson Sampling for each base variant group.
    # All groups share the same price points, so they'll get the same
    # probabilities (same Beta posteriors). We run per-group anyway for
    # correctness in case future subsets differ.
    all_new_probs: dict[str, float] = {}
    all_ev_means: dict[str, float] = {}
    all_ev_vars: dict[str, float] = {}

    for base_variant_id, group in by_base.items():
        variants_in = []
        for s in group:
            st = stats.get(s.experiment_variant_id)
            variants_in.append(VariantInput(
                experiment_variant_id=s.experiment_variant_id,
                price=s.price,
                impressions=st.impressions if st else 0,
                purchases=st.purchases if st else 0,
            ))

        results = run_thompson_sampling(variants_in, mode=mode, cost=cost)
        for r in results:
            all_new_probs[r.experiment_variant_id] = r.probability
            all_ev_means[r.experiment_variant_id] = r.expected_value_mean
            all_ev_vars[r.experiment_variant_id] = r.expected_value_variance

    # Check if probabilities actually changed meaningfully.
    current_round = max(s.bandit_round for s in setups)
    new_round = current_round + 1

    total_impressions = sum(
        (stats.get(s.experiment_variant_id).impressions if stats.get(s.experiment_variant_id) else 0)
        for s in setups
    )

    if total_impressions == 0:
        logger.info(
            "No impressions yet for %s / %s — keeping equal probabilities (round %d)",
            merchant_id, product_id, current_round,
        )
        return False

    # Log the update.
    logger.info(
        "Updating %s / %s: round %d → %d, %d total impressions, %d variants",
        merchant_id, product_id, current_round, new_round,
        total_impressions, len(setups),
    )
    for s in setups:
        old_p = float(s.probability)
        new_p = all_new_probs.get(s.experiment_variant_id, old_p)
        st = stats.get(s.experiment_variant_id)
        imp = st.impressions if st else 0
        pur = st.purchases if st else 0
        logger.info(
            "  variant %s  price=$%s  imp=%d  pur=%d  prob %.4f → %.4f",
            s.experiment_variant_id, s.price, imp, pur, old_p, new_p,
        )

    if dry_run:
        logger.info("DRY RUN — no writes performed")
        return False

    # Write updates in a transaction.
    now = datetime.now(timezone.utc)

    with transaction(conn):
        # 1. Deactivate current setup rows.
        deactivate_setup_rows(conn, merchant_id, product_id, experiment_datetime)

        # 2. Insert new setup rows with updated probabilities.
        new_rows = []
        for s in setups:
            new_rows.append({
                "merchant_id": merchant_id,
                "experiment_datetime": experiment_datetime,
                "product_id": product_id,
                "base_variant_id": s.base_variant_id,
                "experiment_variant_id": s.experiment_variant_id,
                "experiment_subset": s.experiment_subset,
                "price": s.price,
                "probability": Decimal(str(all_new_probs[s.experiment_variant_id])),
                "bandit_round": new_round,
            })
        insert_setup_rows(conn, new_rows)

        # 3. Update BanditParameters and append to history.
        param_updates = []
        for s in setups:
            bp = params_by_variant.get(s.experiment_variant_id)
            if not bp:
                continue
            st = stats.get(s.experiment_variant_id)
            param_updates.append({
                "id": bp.id,
                "merchant_id": merchant_id,
                "experiment_datetime": experiment_datetime,
                "product_id": product_id,
                "experiment_variant_id": s.experiment_variant_id,
                "experiment_subset": s.experiment_subset,
                "price": s.price,
                "contextual_parameter": mode,
                "mean": Decimal(str(all_ev_means[s.experiment_variant_id])),
                "variance": Decimal(str(all_ev_vars[s.experiment_variant_id])),
                "total_impressions": st.impressions if st else 0,
                "total_purchases": st.purchases if st else 0,
                "model_version": bp.model_version + 1,
            })
        update_bandit_params(conn, param_updates, now)

    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Run bandit probability updates")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute new probabilities but don't write to DB or sync metafield",
    )
    args = parser.parse_args()

    conn = get_connection()
    try:
        experiments = fetch_active_experiments(conn)
        if not experiments:
            logger.info("No active experiments — nothing to do")
            return

        logger.info("Found %d active experiment(s)", len(experiments))

        # Track which merchants need a metafield sync.
        merchants_to_sync: set[str] = set()
        updated = 0

        for exp in experiments:
            try:
                changed = process_experiment(
                    conn,
                    exp.merchant_id,
                    exp.product_id,
                    exp.experiment_datetime,
                    dry_run=args.dry_run,
                )
                if changed:
                    updated += 1
                    merchants_to_sync.add(exp.merchant_id)
            except Exception:
                logger.exception(
                    "Failed to process %s / %s — continuing with next",
                    exp.merchant_id, exp.product_id,
                )

        # Sync metafields for all merchants that had updates.
        if not args.dry_run:
            for merchant_id in merchants_to_sync:
                try:
                    sync_metafield_for_merchant(conn, merchant_id)
                except Exception:
                    logger.exception(
                        "Metafield sync failed for %s — storefront will use API fallback",
                        merchant_id,
                    )

        logger.info(
            "Done — %d/%d experiment(s) updated, %d merchant(s) synced",
            updated, len(experiments), len(merchants_to_sync),
        )

    finally:
        conn.close()


if __name__ == "__main__":
    main()
