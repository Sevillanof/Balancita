"""The old Prueba rápida variants (removed from config/ on 2026-10-27) kept as a fixture: the variant machinery still supports
them and its tests need real ones."""

import os

from balancita_engine import futures_qwen_quick_variants as qv

LEGACY_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "qwen-quick-variants-legacy.json")
_saved = []


def use_legacy_variants():
    _saved.append(qv.VARIANTS_PATH)
    qv.VARIANTS_PATH = LEGACY_PATH


def restore_variants():
    qv.VARIANTS_PATH = _saved.pop()
