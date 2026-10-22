"""Variations of a spec: change ONE numeric thing (a ``params`` entry or a numeric constant of a condition by its path).

Stdlib only. The VectorBT lab (``research/vectorbt/explore.py``) and the registry API (``confirm`` of an exploration) both
use these functions, so the variant a report ranks and the strategy the registry creates are the same spec.
"""

import copy
import re
from decimal import Decimal, InvalidOperation

MAX_VALUES = 12


class VariationError(ValueError):
    """The requested variation does not exist or is not a number (message in Spanish)."""


def normalize_value(value):
    """A number as a short decimal string (``2``, ``1.5``); anything else is refused."""
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        raise VariationError("«{}» no es un número".format(value)) from None
    if not number.is_finite():
        raise VariationError("«{}» no es un número finito".format(value))
    text = format(number.normalize(), "f")
    return "0" if text in ("-0", "") else text


def _walk(spec, path):
    """The container and key/index of the leaf at ``path`` (``rules.checks[2].node.right.mul[1]``; ``checks[name]`` too)."""
    node, container, key, trail = spec, None, None, []
    for piece in path.split("."):
        match = re.fullmatch(r"([A-Za-z0-9_]+)((?:\[[^\]]+\])*)", piece)
        if match is None:
            raise VariationError("la ruta «{}» no se entiende (usá, por ejemplo, rules.checks[2].node.right)".format(path))
        steps = [match.group(1)] + re.findall(r"\[([^\]]+)\]", match.group(2))
        for step in steps:
            container, key = node, None
            if isinstance(node, dict):
                if step not in node:
                    raise VariationError("la ruta «{}» no existe en la spec (falta «{}»)".format(path, step))
                key = step
            elif isinstance(node, list):
                if step.lstrip("-").isdigit():
                    index = int(step)
                else:
                    found = [i for i, item in enumerate(node) if isinstance(item, dict) and item.get("name") == step]
                    if not found:
                        raise VariationError("la ruta «{}» no existe en la spec (no hay «{}»)".format(path, step))
                    index = found[0]
                if not -len(node) <= index < len(node):
                    raise VariationError("la ruta «{}» no existe en la spec (índice {})".format(path, step))
                key = index
            else:
                raise VariationError("la ruta «{}» entra en un valor que no tiene partes".format(path))
            node = node[key]
            trail.append(node)
    return container, key, trail


def describe_variation(spec, vary):
    """What ``vary`` points at: a parameter or a numeric constant of a condition. Returns kind, label, current value."""
    if re.fullmatch(r"[A-Za-z0-9_]+", vary):
        if vary not in spec.get("params", {}):
            raise VariationError("«{}» no es un parámetro de la estrategia (tiene: {})".format(
                vary, ", ".join(sorted(spec.get("params", {}))) or "ninguno"))
        return {"kind": "param", "name": vary, "label": vary, "base_value": normalize_value(spec["params"][vary])}
    container, key, trail = _walk(spec, vary)
    leaf = container[key]
    if not isinstance(leaf, str) or leaf.startswith("$"):
        raise VariationError("«{}» no es una constante numérica (si es un parámetro, variá el parámetro por su "
                                     "nombre)".format(vary))
    try:
        base = normalize_value(leaf)
    except VariationError:
        raise VariationError("«{}» vale «{}», que no es una constante numérica".format(vary, leaf)) from None
    codes = [n["cmp"] for n in trail if isinstance(n, dict) and isinstance(n.get("cmp"), str)]
    label = "{} ({})".format(codes[-1], vary) if codes else vary
    return {"kind": "condition", "name": vary, "label": label, "base_value": base}


def apply_value(spec, variation, value):
    """A NEW spec with the one value changed; the input is never modified."""
    out = copy.deepcopy(spec)
    if variation["kind"] == "param":
        out["params"][variation["name"]] = value
    else:
        container, key, _ = _walk(out, variation["name"])
        container[key] = value
    out["id"] = spec["id"]
    return out


def check_values(values):
    if not values:
        raise VariationError("hay que dar al menos un valor para variar")
    normalized = []
    for value in values:
        text = normalize_value(value)
        if text not in normalized:
            normalized.append(text)
    if len(normalized) > MAX_VALUES:
        raise VariationError("se pidieron {} valores y el máximo es {}: la lista no se amplía sola".format(
            len(normalized), MAX_VALUES))
    return normalized
