"""
Sync the shop metafield with the latest active experiment config.

This mirrors what experimentMetafield.server.ts does on the Node side,
but called from Python after a bandit update so the storefront picks up
the new probabilities without waiting for the next merchant action.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict

import requests

from db import SetupRow, fetch_access_token, fetch_all_active_setups_for_merchant, fetch_product_handles_for_merchant

logger = logging.getLogger(__name__)

SHOPIFY_API_VERSION = "2025-10"
PM_METAFIELD_NAMESPACE = "profit_max_app"
PM_METAFIELD_KEY = "experiment_config"

SHOP_ID_QUERY = "query { shop { id } }"

METAFIELD_UPSERT_MUTATION = """
mutation MetafieldUpsert($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key }
    userErrors { field message }
  }
}
"""


def _graphql(shop: str, token: str, query: str, variables: dict | None = None) -> dict:
    """Execute a Shopify Admin GraphQL request."""
    url = f"https://{shop}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    payload: dict = {"query": query}
    if variables:
        payload["variables"] = variables

    resp = requests.post(url, json=payload, headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()


def _build_config(setups: list[SetupRow], handles: dict[str, str]) -> dict:
    """
    Build the metafield config JSON from active setup rows.

    Shape matches what the Node app produces:
    {
      "gid://shopify/Product/123": {
        "experimentDatetimeSubmitted": "2026-04-18T...",
        "handle": "my-product",           // present when known
        "assignments": [
          { "baseVariantId", "experimentVariantId", "price", "probability" }
        ]
      }
    }
    """
    by_product: dict[str, list[SetupRow]] = defaultdict(list)
    for s in setups:
        by_product[s.product_id].append(s)

    config: dict = {}
    for product_id, product_setups in by_product.items():
        entry: dict = {
            "experimentDatetimeSubmitted": product_setups[0].experiment_datetime.isoformat(),
            "assignments": [
                {
                    "baseVariantId": s.base_variant_id,
                    "experimentVariantId": s.experiment_variant_id,
                    "price": str(s.price),
                    "probability": float(s.probability),
                }
                for s in product_setups
            ],
        }
        if product_id in handles:
            entry["handle"] = handles[product_id]
        config[product_id] = entry
    return config


def sync_metafield_for_merchant(conn, merchant_id: str) -> bool:
    """
    Rebuild and upsert the shop metafield for a merchant.

    Returns True on success, False on failure (non-fatal — logged as warning).
    """
    token = fetch_access_token(conn, merchant_id)
    if not token:
        logger.warning("No access token found for %s — skipping metafield sync", merchant_id)
        return False

    try:
        setups = fetch_all_active_setups_for_merchant(conn, merchant_id)
        handles = fetch_product_handles_for_merchant(conn, merchant_id)
        config = _build_config(setups, handles)

        # Get the shop GID (required as metafield ownerId).
        shop_resp = _graphql(merchant_id, token, SHOP_ID_QUERY)
        shop_gid = shop_resp["data"]["shop"]["id"]

        # Upsert the metafield.
        variables = {
            "metafields": [
                {
                    "ownerId": shop_gid,
                    "namespace": PM_METAFIELD_NAMESPACE,
                    "key": PM_METAFIELD_KEY,
                    "type": "json",
                    "value": json.dumps(config),
                }
            ]
        }
        result = _graphql(merchant_id, token, METAFIELD_UPSERT_MUTATION, variables)

        errors = result.get("data", {}).get("metafieldsSet", {}).get("userErrors", [])
        if errors:
            logger.warning("Metafield upsert errors for %s: %s", merchant_id, errors)
            return False

        product_count = len(config)
        logger.info(
            "Synced metafield for %s — %d active product(s)",
            merchant_id, product_count,
        )
        return True

    except Exception:
        logger.exception("Metafield sync failed for %s", merchant_id)
        return False
