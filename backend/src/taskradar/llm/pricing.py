"""Token cost *estimates*. Prices change; users can override them in Settings.

The defaults are list prices in USD per 1M tokens as published by OpenAI (mid-2025). They are only
used to show an approximate cost next to the measured token counts.
"""

from __future__ import annotations

DEFAULT_PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "gpt-5-nano": (0.05, 0.40),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5": (1.25, 10.00),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
}


def lookup_price(model: str, overrides: tuple[float | None, float | None] | None = None) -> tuple[float, float] | None:
    if overrides and overrides[0] is not None and overrides[1] is not None:
        return float(overrides[0]), float(overrides[1])
    name = model.lower()
    # Longest matching prefix wins ("gpt-5-mini-2025-08-07" -> "gpt-5-mini").
    for prefix in sorted(DEFAULT_PRICES_PER_MTOK, key=len, reverse=True):
        if name.startswith(prefix):
            return DEFAULT_PRICES_PER_MTOK[prefix]
    return None


def estimate_cost(
    model: str, input_tokens: int, output_tokens: int, overrides: tuple[float | None, float | None] | None = None
) -> float | None:
    price = lookup_price(model, overrides)
    if price is None:
        return None
    return round(input_tokens / 1_000_000 * price[0] + output_tokens / 1_000_000 * price[1], 6)
