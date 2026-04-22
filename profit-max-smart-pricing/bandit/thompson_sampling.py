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
) -> list[VariantOutput]:
    """
    Run Thompson Sampling and return new probabilities for each variant.

    Args:
        variants: one entry per price point (within a single base-variant group
                  or across all base variants — caller decides grouping).
        mode: "revenue" or "profit".
        cost: cost of production, required when mode="profit".

    Returns:
        One VariantOutput per input variant with the new probability and
        posterior statistics.
    """
    if not variants:
        return []

    if mode == "profit" and cost is None:
        raise ValueError("cost is required for profit optimisation mode")

    n = len(variants)
    prices = np.array([float(v.price) for v in variants])
    alphas = np.array([v.purchases + 1 for v in variants], dtype=float)
    betas = np.array([v.impressions - v.purchases + 1 for v in variants], dtype=float)

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
