"""
End-of-run digest email for the bandit update script.

Sends a summary of the run to the operator (not the merchant).

Required env vars:
    ALERT_EMAIL_TO    — recipient address (your personal email)
    ALERT_EMAIL_FROM  — verified sender address in Resend
    RESEND_API_KEY    — Resend API key (https://resend.com)

If RESEND_API_KEY is not set the digest is printed to stdout instead,
which is useful during local development.
If ALERT_EMAIL_TO is not set, the digest is skipped entirely.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

import requests

logger = logging.getLogger("bandit.email")


@dataclass
class ExperimentResult:
    merchant_id: str
    product_id: str
    # "updated" | "skipped_no_impressions" | "skipped_no_setups" | "failed"
    status: str
    error: str | None = None
    bandit_round: int = 0           # round number *before* this run
    total_impressions: int = 0
    min_impressions: int = 0
    max_impressions: int = 0
    total_purchases: int = 0
    min_purchases: int = 0
    max_purchases: int = 0
    top_price: str | None = None    # price string with highest probability
    top_probability: float = 0.0


def send_digest(results: list[ExperimentResult], dry_run: bool = False) -> None:
    """Format and send (or log) the end-of-run digest."""
    to_addr = os.environ.get("ALERT_EMAIL_TO")
    if not to_addr:
        logger.debug("ALERT_EMAIL_TO not set — skipping digest")
        return

    api_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("ALERT_EMAIL_FROM", "bandit@notifications.profitmax.app")

    now = datetime.now(timezone.utc)
    subject = (
        f"Profit Max Bandit — {'[DRY RUN] ' if dry_run else ''}"
        f"Daily Update [{now.strftime('%Y-%m-%d')}]"
    )
    body = _format_digest(results, now, dry_run)

    if not api_key:
        logger.info("RESEND_API_KEY not set — printing digest to stdout:\n%s", body)
        return

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"from": from_addr, "to": [to_addr], "subject": subject, "text": body},
            timeout=15,
        )
        resp.raise_for_status()
        logger.info("Digest email sent to %s", to_addr)
    except Exception:
        logger.exception("Failed to send digest email — digest follows:\n%s", body)
        raise


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

_SEP = "─" * 56


def _format_digest(
    results: list[ExperimentResult],
    now: datetime,
    dry_run: bool,
) -> str:
    updated = [r for r in results if r.status == "updated"]
    skipped_imp = [r for r in results if r.status == "skipped_no_impressions"]
    skipped_setup = [r for r in results if r.status == "skipped_no_setups"]
    failed = [r for r in results if r.status == "failed"]

    lines: list[str] = []
    lines.append(f"Run completed at {now.strftime('%Y-%m-%d %H:%M UTC')}")
    if dry_run:
        lines.append("(DRY RUN — no writes performed)")
    lines.append("")
    lines.append(f"Experiments processed:          {len(results)}")
    lines.append(f"  Updated:                      {len(updated)}")
    lines.append(f"  Skipped (no impressions yet): {len(skipped_imp)}")
    lines.append(f"  Skipped (no active setup):    {len(skipped_setup)}")
    lines.append(f"  Failed:                       {len(failed)}")

    if updated:
        lines += ["", _SEP, "UPDATED EXPERIMENTS", _SEP]
        for r in updated:
            lines.append(_fmt_updated(r))

    if skipped_imp:
        lines += ["", _SEP, "SKIPPED — NO IMPRESSIONS YET  (consider follow-up)", _SEP]
        for r in skipped_imp:
            lines.append(_fmt_skipped(r))

    if skipped_setup:
        lines += ["", _SEP, "SKIPPED — NO ACTIVE SETUP ROWS", _SEP]
        for r in skipped_setup:
            lines.append(f"Merchant: {r.merchant_id}\nProduct:  {r.product_id}\n")

    if failed:
        lines += ["", _SEP, "FAILED", _SEP]
        for r in failed:
            lines.append(_fmt_failed(r))

    return "\n".join(lines)


def _fmt_updated(r: ExperimentResult) -> str:
    lines = [
        f"Merchant: {r.merchant_id}",
        f"Product:  {r.product_id}",
        f"Round:    {r.bandit_round} → {r.bandit_round + 1}",
        f"Impressions per variant: {r.min_impressions} – {r.max_impressions}"
        f"  (total: {r.total_impressions})",
        f"Purchases per variant:   {r.min_purchases} – {r.max_purchases}"
        f"  (total: {r.total_purchases})",
    ]
    if r.top_price:
        lines.append(
            f"Leading price:           ${r.top_price} @ {r.top_probability * 100:.1f}%"
        )
    lines.append("")
    return "\n".join(lines)


def _fmt_skipped(r: ExperimentResult) -> str:
    times = "never updated" if r.bandit_round == 0 else f"updated {r.bandit_round} time(s)"
    return (
        f"Merchant: {r.merchant_id}\n"
        f"Product:  {r.product_id}\n"
        f"Bandit rounds so far: {times}\n"
    )


def _fmt_failed(r: ExperimentResult) -> str:
    return (
        f"Merchant: {r.merchant_id}\n"
        f"Product:  {r.product_id}\n"
        f"Error: {r.error}\n"
    )
