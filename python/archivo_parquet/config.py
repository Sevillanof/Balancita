"""Configuracion por tabla: es lo unico que hay que tocar para sumar otra tabla al archivo."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

DAY_MS = 86_400_000
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Columna:
    nombre: str
    tipo: str  # "int" | "text" | "real"
    nullable: bool = False


@dataclass(frozen=True)
class TablaConfig:
    nombre: str  # nombre en el archivo (carpeta)
    sqlite: str  # nombre de la tabla en SQLite
    tiempo: str  # columna de tiempo (ms UTC) que decide la particion por dia
    clave: Tuple[str, ...]  # orden interno y clave unica; empieza por producto y tiempo cuando existen
    columnas: Tuple[Columna, ...]
    hash: Optional[str] = None  # columna con el hash de contenido, si existe
    producto: Optional[str] = "product_id"
    filtro_tipico: Optional[str] = None  # columna de texto que se usa en las busquedas de ejemplo de `medir`
    schema_version: int = SCHEMA_VERSION

    @property
    def nombres(self) -> Tuple[str, ...]:
        return tuple(c.nombre for c in self.columnas)

    def tipo_de(self, nombre: str) -> str:
        for c in self.columnas:
            if c.nombre == nombre:
                return c.tipo
        raise KeyError(nombre)


def _cols(spec: str) -> Tuple[Columna, ...]:
    out = []
    for item in spec.split():
        nombre, tipo = item.split(":")
        nullable = tipo.endswith("?")
        out.append(Columna(nombre, tipo.rstrip("?"), nullable))
    return tuple(out)


TABLAS = {
    "verdicts": TablaConfig(
        nombre="verdicts", sqlite="paper_futures_verdicts", tiempo="bucket_start", clave=("product_id", "bucket_start"),
        columnas=_cols("product_id:text bucket_start:int interval_ms:int decision_known_at:int regime:text action:text reason_code:text "
                       "verdict_hash:text payload_json:text written_at:int"),
        hash="verdict_hash", filtro_tipico="action"),
    "llm_decisions": TablaConfig(
        nombre="llm_decisions", sqlite="paper_futures_llm_decisions", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "question_id", "question_version"),
        columnas=_cols("product_id:text bucket_start:int question_id:text question_version:int verdict_hash:text question_type:text "
                       "model_ref:text model_info_json:text prompt_hash:text prompt_version:int probability_source:text state_text:text "
                       "top_logprobs_json:text probabilities_json:text temperature:real chosen:text value:real? confidence:real "
                       "latency_ms:int timings_json:text written_at:int"),
        hash="verdict_hash", filtro_tipico="chosen"),
    # La clave lleva product_id y event_id ademas de received_at: da un orden total y deja buscar por producto y tiempo.
    "market_events": TablaConfig(
        nombre="market_events", sqlite="paper_futures_market_events", tiempo="received_at",
        clave=("product_id", "received_at", "event_id"),
        columnas=_cols("event_id:text feed:text product_id:text epoch:int seq:int event_time:int received_at:int persisted_at:int "
                       "uid:text? raw_json:text normalized_json:text content_hash:text"),
        hash="content_hash", filtro_tipico="feed"),
}
