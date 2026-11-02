"""Configuracion por tabla: es lo unico que hay que tocar para sumar otra tabla al archivo."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

DAY_MS = 86_400_000
SCHEMA_VERSION = 1
# Filas pesadas (JSON de ~10 KB por fila): grupos chicos para que las estadisticas de grupo salten bloques en busquedas de 1 hora.
GRUPO_PESADO = 2_000


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
    granularidad: str = "dia"  # "dia" (un archivo por dia UTC) o "mes" (un archivo por mes UTC, para tablas chicas)
    filas_por_grupo: Optional[int] = None  # None = formato.FILAS_POR_GRUPO; chico (~2000) cuando las filas son pesadas (payload JSON)

    def __post_init__(self):
        if self.granularidad not in ("dia", "mes"):
            raise ValueError("granularidad invalida: %r" % self.granularidad)

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
        hash="verdict_hash", filtro_tipico="action", filas_por_grupo=GRUPO_PESADO),
    "llm_decisions": TablaConfig(
        nombre="llm_decisions", sqlite="paper_futures_llm_decisions", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "question_id", "question_version"),
        columnas=_cols("product_id:text bucket_start:int question_id:text question_version:int verdict_hash:text question_type:text "
                       "model_ref:text model_info_json:text prompt_hash:text prompt_version:int probability_source:text state_text:text "
                       "top_logprobs_json:text probabilities_json:text temperature:real chosen:text value:real? confidence:real "
                       "latency_ms:int timings_json:text written_at:int"),
        hash="verdict_hash", filtro_tipico="chosen", filas_por_grupo=GRUPO_PESADO),
    # La clave lleva product_id y event_id ademas de received_at: da un orden total y deja buscar por producto y tiempo.
    "market_events": TablaConfig(
        nombre="market_events", sqlite="paper_futures_market_events", tiempo="received_at",
        clave=("product_id", "received_at", "event_id"),
        columnas=_cols("event_id:text feed:text product_id:text epoch:int seq:int event_time:int received_at:int persisted_at:int "
                       "uid:text? raw_json:text normalized_json:text content_hash:text"),
        hash="content_hash", filtro_tipico="feed", filas_por_grupo=GRUPO_PESADO),
    # ---- puntajes de pronostico (futures-forecast-scores): append-only, una fila por pronostico y componente. Tiempo = bucket_start (minuto de
    # la decision), no written_at: asi la fila cae en el dia de la decision aunque se puntue mas tarde (los puntajes de 24 h llegan al dia siguiente;
    # por eso el margen de 1 dia importa). Las columnas de precios/bp son TEXT en SQLite y se guardan tal cual. Filas chicas: grupo normal.
    "forecasts": TablaConfig(
        nombre="forecasts", sqlite="paper_futures_forecasts", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text side:text regime:text utc_hour:int knowledge_lag_ms:int? "
                       "backfill:int entry_price:text proposed_stop:text? proposed_target:text? signal_key:text? verdict_hash:text written_at:int"),
        hash="verdict_hash", filtro_tipico="strategy_id"),
    "forecast_returns": TablaConfig(
        nombre="forecast_returns", sqlite="paper_futures_forecast_returns", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id", "horizon_min"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text horizon_min:int gross_bp:text net_bp:text "
                       "exit_bucket_start:int written_at:int"),
        filtro_tipico="strategy_id"),
    "forecast_barriers": TablaConfig(
        nombre="forecast_barriers", sqlite="paper_futures_forecast_barriers", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text outcome:text ambiguous:int hit_after_ms:int? written_at:int"),
        filtro_tipico="outcome"),
    "forecast_excursions": TablaConfig(
        nombre="forecast_excursions", sqlite="paper_futures_forecast_excursions", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text window_min:int mfe_bp:text mae_bp:text written_at:int"),
        filtro_tipico="strategy_id"),
    # ---- posicionamiento (positioning-collector): MENSUAL, es chico. Tiempo = bucket_ms (inicio del intervalo de la muestra).
    "positioning": TablaConfig(
        nombre="positioning", sqlite="positioning", tiempo="bucket_ms", clave=("product_id", "bucket_ms"), granularidad="mes",
        columnas=_cols("product_id:text bucket_ms:int long_percent:real? long_count:int? short_count:int? top_long_percent:real? "
                       "top_long_count:int? top_short_count:int? top_open_interest:real?")),
    "premium": TablaConfig(
        nombre="premium", sqlite="premium", tiempo="bucket_ms", clave=("product_id", "interval_ms", "bucket_ms"), granularidad="mes",
        columnas=_cols("product_id:text interval_ms:int bucket_ms:int mark:real spot:real premium_bp:real")),
    # ---- noticias (futures-news; la base SQLite se conserva): MENSUAL, sin producto. Tiempo = received_at (cuando llego a nuestro sistema:
    # siempre presente, a diferencia de published_at, que puede ser NULL o venir adelantado/atrasado). En el analisis, analyzed_at.
    # Se deja item_id / analysis_id al final de la clave para tener orden total.
    "news_items": TablaConfig(
        nombre="news_items", sqlite="paper_futures_news_items", tiempo="received_at", clave=("received_at", "item_id"), granularidad="mes",
        columnas=_cols("item_id:int item_hash:text source_id:text source:text url:text title:text summary:text published_at:int? "
                       "received_at:int content_hash:text"),
        hash="content_hash", producto=None, filtro_tipico="source_id", filas_por_grupo=GRUPO_PESADO),
    "news_analysis": TablaConfig(
        nombre="news_analysis", sqlite="paper_futures_news_analysis", tiempo="analyzed_at", clave=("analyzed_at", "analysis_id"), granularidad="mes",
        columnas=_cols("analysis_id:int item_hash:text question_id:text question_version:int status:text analyzed_at:int question_type:text? "
                       "model_ref:text? model_info_json:text? prompt_hash:text? prompt_version:int? probability_source:text? "
                       "top_logprobs_json:text? probabilities_json:text? temperature:real? chosen:text? value:real? confidence:real? "
                       "latency_ms:int? timings_json:text?"),
        producto=None, filtro_tipico="status", filas_por_grupo=GRUPO_PESADO),
}
