"""Executable variants of C27: the same strategy with another Donchian period and another volume multiplier.

``make_c27_variant`` returns a NEW spec (the input is never modified) that is a valid ``balancita-strategy.v1`` and
that the engine runs as it runs any other spec, so the VectorBT version and the engine can be compared on a variant too.
"""

import copy
import re

from . import data_contract as contract
from .engine import load_spec  # noqa: F401  (also puts the engine on the import path)
from balancita_engine.futures_spec_strategy import SpecError, validate_spec

BASE_PERIOD = 20
_OPERAND = re.compile(r"\b(donchian_(?:high|low|mid)|prior_volume_mean)20\b")


def _rename(node, period):
    if isinstance(node, str):
        return _OPERAND.sub(lambda m: "{}{}".format(m.group(1), period), node)
    if isinstance(node, dict):
        return {key: _rename(value, period) for key, value in node.items()}
    if isinstance(node, list):
        return [_rename(value, period) for value in node]
    return node


def make_c27_variant(spec, donchian_period, volume_multiplier):
    if isinstance(donchian_period, bool) or not isinstance(donchian_period, int) or not 2 <= donchian_period <= 400:
        raise contract.ContractError("el período Donchian debe ser un entero entre 2 y 400")
    multiplier = float(volume_multiplier)
    if not multiplier > 0:
        raise contract.ContractError("el multiplicador de volumen debe ser positivo")
    out = copy.deepcopy(spec)
    out["rules"] = _rename(out["rules"], donchian_period)
    for check in out["rules"]["checks"]:
        if check["node"].get("cmp") == "volume_above_1_25_prior_mean":
            check["node"]["cmp"] = "volume_above_prior_mean_multiple"
    out["params"]["volume_multiplier"] = format(multiplier, "g")
    if donchian_period != BASE_PERIOD:
        out["indicators"] = {**out.get("indicators", {}), "donchian": [donchian_period]}
    out["description"] = "Variante de C27: canal Donchian de {} velas, volumen {} veces la media previa.".format(
        donchian_period, out["params"]["volume_multiplier"])
    try:
        validate_spec(out)
    except SpecError as error:
        raise contract.ContractError("la variante no es una spec válida: {}".format(error)) from error
    return out
