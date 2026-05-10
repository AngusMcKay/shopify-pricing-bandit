"""
Thompson Sampling for price experiment optimisation.

Supports two modes:
  - "revenue": maximise expected revenue per impression  (price × conversion_rate)
  - "profit":  maximise expected profit per impression   ((price - cost) × conversion_rate)

Each price point's conversion rate is modelled with a Beta distribution:
  Beta(alpha, beta)  where  alpha = purchases + 1,  beta = impressions - purchases + 1

The +1 prior (Beta(1,1) = Uniform) means we start with no bias and let data speak.

To compute new assignment probabilities we run N Monte Carlo simulations:
  1. For each variant, sample conversion_rate ~ Beta(alpha, beta)
  2. Compute expected_value = price * conversion_rate  (or (price - cost) for profit)
  3. The variant with the highest expected_value "wins" this simulation
  4. New probability = wins / N  (proportion of simulations each variant won)

This naturally balances exploration and exploitation: variants with high
uncertainty get sampled across a wide range, sometimes winning, keeping them
in the mix until we have enough data to be confident.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import numpy as np


N_SIMULATIONS = 10_000

# Minimum probability floor — ensures every price point keeps getting
# some traffic even after many rounds, preventing premature convergence.
MIN_PROBABILITY = 0.01

# Default prior: Beta(alpha0, beta0) applied to every variant before any real data.
# Represents our baseline belief about e-commerce conversion rates (~3%) with
# the weight of 100 pseudo-observations. This prevents extreme probability swings
# from the first few real impressions.
# If merchant history is available, these are replaced by the pooled observed rate
# scaled to the same pseudo-count (see run_thompson_sampling).
DEFAULT_PRIOR_RATE = 0.03   # 3% baseline conversion rate
DEFAULT_PRIOR_STRENGTH = 100  # pseudo-observation count — how much weight the prior carries


@dataclass
class VariantInput:
    experiment_variant_id: str
    price: Decimal
    impressions: int
    purchases: int


@dataclass
class VariantOutput:
    experiment_variant_id: str
    probability: float
    expected_value_mean: float
    expected_value_variance: float


def run_thompson_sampling(
    variants: list[VariantInput],
    mode: str = "revenue",
    cost: Decimal | None = None,
    prior_impressions: int | None = None,
    prior_purchases: int | None = None,
    prior_strength: int | None = None,
    prior_rate: float | None = None,
) -> list[VariantOutput]:
    """
    Run Thompson Sampling and return new probabilities for each variant.

    Args:
        variants: one entry per price point (within a single base-variant group
                  or across all base variants — caller decides grouping).
        mode: "revenue" or "profit".
        cost: cost of production, required when mode="profit".
        prior_impressions: total historical impressions for the merchant across all
            experiments. Used to compute a pooled conversion rate for the prior.
            If None, falls back to prior_rate or DEFAULT_PRIOR_RATE.
        prior_purchases: total historical purchases, paired with prior_impressions.
        prior_strength: pseudo-observation count (how many virtual impressions the
            prior represents). Overrides DEFAULT_PRIOR_STRENGTH when set.
            Merchant-facing: weak=33, medium=100, strong=250.
        prior_rate: fallback conversion rate assumption when no merchant history is
            available. Overrides DEFAULT_PRIOR_RATE when set (e.g. 0.05 = 5%).

    Returns:
        One VariantOutput per input variant with the new probability and
        posterior statistics.
    """
    if not variants:
        return []

    if mode == "profit" and cost is None:
        raise ValueError("cost is required for profit optimisation mode")

    # Compute prior parameters.
    # The prior is Beta(alpha0, beta0) applied uniformly to every variant,
    # representing our belief about conversion rate before seeing any data.
    # Real observations are added on top: alpha = purchases + alpha0,
    #                                      beta  = non-purchases + beta0.
    strength = prior_strength if prior_strength is not None else DEFAULT_PRIOR_STRENGTH

    if prior_impressions is not None and prior_purchases is not None and prior_impressions > 0:
        effective_rate = prior_purchases / prior_impressions
    elif prior_rate is not None:
        effective_rate = prior_rate
    else:
        effective_rate = DEFAULT_PRIOR_RATE

    alpha0 = effective_rate * strength
    beta0 = (1.0 - effective_rate) * strength

    n = len(variants)
    prices = np.array([float(v.price) for v in variants])
    alphas = np.array([v.purchases + alpha0 for v in variants], dtype=float)
    betas = np.maximum(
        np.array([v.impressions - v.purchases + beta0 for v in variants], dtype=float),
        1e-6,
    )

    if mode == "profit":
        value_multiplier = prices - float(cost)
    else:
        value_multiplier = prices

    # Monte Carlo simulation: sample conversion rates and compute expected values.
    # Shape: (N_SIMULATIONS, n_variants)
    rng = np.random.default_rng()
    conversion_samples = rng.beta(alphas, betas, size=(N_SIMULATIONS, n))
    expected_values = conversion_samples * value_multiplier  # broadcast

    # Count wins per variant.
    winners = np.argmax(expected_values, axis=1)
    win_counts = np.bincount(winners, minlength=n)
    raw_probs = win_counts / N_SIMULATIONS

    # Apply probability floor and renormalise.
    floored = np.maximum(raw_probs, MIN_PROBABILITY)
    probabilities = floored / floored.sum()

    # Compute posterior statistics for analytics / BanditParameters.
    # E[value] = E[conversion] * value_multiplier
    # where E[conversion] = alpha / (alpha + beta)
    posterior_means = (alphas / (alphas + betas)) * value_multiplier
    # Var[value] = Var[conversion] * value_multiplier^2
    posterior_variances = (
        (alphas * betas) / ((alphas + betas) ** 2 * (alphas + betas + 1))
    ) * value_multiplier ** 2

    return [
        VariantOutput(
            experiment_variant_id=variants[i].experiment_variant_id,
            probability=round(float(probabilities[i]), 4),
            expected_value_mean=round(float(posterior_means[i]), 6),
            expected_value_variance=round(float(posterior_variances[i]), 6),
        )
        for i in range(n)
    ]
