"""Versioned run scope, deliberately independent of the gate's statistical PASA/NO PASA.

Only the producer assigns metadata. Missing historical metadata is never inferred from
current specs, dates or configuration. This delivery cannot certify a full policy.
"""

SCHEMA = "balancita.strategy-evaluation-policy.v1"
BASELINE_MODE = "baseline_only"
MODE_ERROR = "El modo de evaluación no está admitido; solo se admite baseline_only (no valida la política completa)."


def require_mode(mode):
    if not isinstance(mode, str) or mode != BASELINE_MODE:
        raise ValueError(MODE_ERROR)
    return mode


def _unknown(reason):
    return {"schema": SCHEMA, "classification": "unclassified", "account_scope": None,
            "notional_per_trade_usd": None, "qwen_open_decisions_replayed": None,
            "full_policy_validated": False, "reasons": [reason]}


def metadata(*, recorded_model=False):
    """Describe the actual producer path, not a requested/client-supplied certification."""
    if recorded_model:
        return _unknown("recorded_model_trades_not_policy_replay")
    return {"schema": SCHEMA, "classification": BASELINE_MODE, "account_scope": "independent_fixed_notional",
            "notional_per_trade_usd": "100", "qwen_open_decisions_replayed": False,
            "full_policy_validated": False,
            "reasons": ["deterministic_book_only", "qwen_open_not_replayed", "full_policy_not_supported"]}


def stored(value):
    """Read only this version's producer shapes; absent/malformed/future payloads remain unknown."""
    if isinstance(value, dict):
        for expected in (metadata(), metadata(recorded_model=True)):
            if (value == expected and value.get("full_policy_validated") is False
                    and value.get("qwen_open_decisions_replayed") is expected["qwen_open_decisions_replayed"]):
                return expected
    return _unknown("missing_evaluation_policy" if value is None else "invalid_evaluation_policy")
