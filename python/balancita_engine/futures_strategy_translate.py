"""Translate Pine Script or freqtrade text into a draft ``balancita-strategy.v1`` spec (PS-08f).

The local llama-server only converts text into data (ADR 0001, Use of LLMs):
the imported code is never executed, the answer is validated like any other
spec, and the result is a draft the user reviews before importing. Rules the
spec vocabulary cannot express come back listed in ``untranslatable``.
"""

import json

from .futures_llm_decisions import LlamaCppProvider, ModelResponseError, ModelUnavailable
from .futures_spec_strategy import SPEC_SCHEMA, SpecError, validate_spec

MAX_SOURCE_CHARS = 20_000
SOURCES = ("pine", "freqtrade", "auto")


class TranslationError(ValueError):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code, self.detail = code, detail


def build_messages(text, source, example_spec, operands):
    system = (
        "You convert trading strategy code into a JSON strategy spec. You never run code. "
        "Answer with one JSON object only: {\"spec\": <spec>, \"untranslatable\": [<short notes>]}. "
        "The spec follows schema " + SPEC_SCHEMA + " exactly like the example. Operands are only these "
        "feature references, $params or decimal strings: " + ", ".join(operands) + ". "
        "Comparators: > >= < <=. Nodes: cmp, available, regime_in, not, and, all, any. "
        "Every number is a decimal string in params. Indicators or periods not in the operand list, "
        "timeframes other than 1m and 5m, and order types go in untranslatable instead of being guessed."
    )
    user = "Source ({}):\n```\n{}\n```\n\nExample spec:\n{}".format(
        source, text, json.dumps(example_spec, ensure_ascii=False))
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def translate(text, source, *, provider, example_spec, operands):
    """``{"spec", "untranslatable", "valid", "error"}``; never saves anything."""
    if source not in SOURCES:
        raise TranslationError("invalid_source", "source must be pine, freqtrade or auto")
    if not isinstance(text, str) or not text.strip():
        raise TranslationError("empty_source", "paste the strategy code to translate")
    if len(text) > MAX_SOURCE_CHARS:
        raise TranslationError("too_long", "strategy code over {} characters".format(MAX_SOURCE_CHARS))
    body = {"messages": build_messages(text, source, example_spec, operands), "temperature": 0,
            "response_format": {"type": "json_object"}, "max_tokens": 4096}
    try:
        status, data = provider._request("POST", "/v1/chat/completions", provider.timeout, body)
    except ModelUnavailable as error:
        raise TranslationError("model_unavailable", "the local model is not running: {}".format(error)) from error
    if status != 200:
        raise TranslationError("model_error", "the local model answered HTTP {}".format(status))
    try:
        content = json.loads(data.decode("utf-8"))["choices"][0]["message"]["content"]
        answer = json.loads(content)
    except (ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError) as error:
        raise TranslationError("bad_answer", "the model did not answer with JSON") from error
    spec = answer.get("spec") if isinstance(answer, dict) else None
    notes = answer.get("untranslatable") if isinstance(answer, dict) else None
    notes = [str(n)[:200] for n in notes][:30] if isinstance(notes, list) else []
    try:
        validate_spec(spec)
        return {"spec": spec, "untranslatable": notes, "valid": True, "error": None}
    except (SpecError, ValueError) as error:
        return {"spec": spec, "untranslatable": notes, "valid": False, "error": str(error)}


def default_provider(env):
    from .futures_llm_decisions import llama_url, model_ref
    return LlamaCppProvider(llama_url(env), model_ref(env), timeout=120.0)


__all__ = ["ModelResponseError", "TranslationError", "default_provider", "translate"]
