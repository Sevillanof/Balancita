"""Configuracion por tabla: es lo unico que hay que tocar para sumar otra tabla al archivo.

Formato 2 (informe ``formatos-por-tabla.md``, secciones 5 a 10): cada tabla declara su granularidad, el orden, como se cortan los grupos de filas,
que columnas llevan diccionario / estadisticas / byte_stream_split, el nivel de zstd y las columnas derivadas del JSON (``j_*``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

DAY_MS = 86_400_000
# Version del esquema fisico del archivo (todas nullable + metadatos + derivadas). La 1 era la de las fases 1 y 2.
SCHEMA_VERSION = 2
# Version del formato que el exportador CERTIFICA (hash por fila de todas las columnas, ida y vuelta completa). La puerta de TypeScript
# (`MIN_FORMAT_VERSION` en archive-tables.ts) exige al menos esta; una linea sin el campo es del formato viejo y no se puede borrar.
FORMATO_VERSION = 2
# Filas pesadas (JSON de ~10 KB por fila): grupos chicos para que las estadisticas de grupo salten bloques en busquedas de 1 hora.
GRUPO_PESADO = 2_000
TIPOS = ("int", "text", "real", "blob", "mixto")


@dataclass(frozen=True)
class Columna:
    nombre: str
    # "int" | "text" | "real" | "blob" | "mixto". "mixto" = columna de una base no STRICT que puede traer valores de varios tipos:
    # se guarda como texto mas una columna ``tipo_<nombre>`` con el typeof() de cada valor (es la unica forma de volver exacto).
    tipo: str
    nullable: bool = False  # solo significa "un NULL no avisa": en el archivo TODAS son nullable (un NULL inesperado no tira el dia)
    diccionario: bool = False  # solo columnas de pocos valores distintos (producto, accion, motivo...); nunca hashes ni JSON
    estadisticas: bool = True  # min/max por grupo; apagado en JSON y texto largo (el min/max de 11 KB no sirve y engorda el pie)
    byte_stream_split: bool = False  # solo float64 donde se midio que ayuda y vuelve bit a bit igual


@dataclass(frozen=True)
class Derivada:
    """Columna ``j_*`` copiada de un JSON de la fila para buscar sin abrirlo. NO existe en SQLite: se verifica contra el JSON releido."""
    nombre: str
    origen: str  # columna JSON de la tabla
    ruta: Tuple[str, ...]  # claves anidadas dentro del JSON
    tipo: str  # "int" | "text"
    op: Optional[str] = None  # None = el valor; "len" = largo de la lista que hay en la ruta
    diccionario: bool = False


@dataclass(frozen=True)
class TablaConfig:
    nombre: str  # nombre en el archivo (carpeta)
    sqlite: str  # nombre de la tabla en SQLite
    tiempo: str  # columna de tiempo (ms UTC) que decide la particion por dia
    clave: Tuple[str, ...]  # orden interno y clave unica; empieza por producto y tiempo cuando existen
    columnas: Tuple[Columna, ...]
    hash: Optional[str] = None  # columna con el hash de contenido, si existe (informativa: la verificacion hashea TODAS las columnas)
    producto: Optional[str] = "product_id"
    filtro_tipico: Optional[str] = None  # columna de texto que se usa en las busquedas de ejemplo de `medir`
    schema_version: int = SCHEMA_VERSION
    granularidad: str = "dia"  # "dia" (un archivo por dia UTC) o "mes" (un archivo por mes UTC, para tablas chicas)
    filas_por_grupo: Optional[int] = None  # tope de filas por grupo; None = formato.FILAS_POR_GRUPO; chico cuando las filas son pesadas
    grupo_por: Tuple[str, ...] = ()  # columnas que delimitan un grupo de filas (ej. el producto): un grupo por valor, sin mezclar productos
    nivel_zstd: int = 3  # 3 tablas chicas, 9 las pesadas, 19 solo funding_responses (cuerpos casi iguales)
    pagina_bytes: Optional[int] = None  # tamano de pagina de datos (grande si hay que comprimir cuerpos enteros)
    derivadas: Tuple[Derivada, ...] = ()
    # Cuanto despues de terminar el periodo se exporta. Por defecto 1 dia de margen (los puntajes de 24 h llegan al dia siguiente).
    margen_cierre_ms: int = DAY_MS
    # Series que SQLite recorta (market_events): se exige que el periodo conserve su inicio; si la copia ya lo recorto, NO se confirma.
    exigir_inicio_completo: bool = False
    tolerancia_inicio_ms: int = 600_000
    # Con ``exigir_inicio_completo`` tambien se exige que la copia llegue al FINAL del periodo: su fila mas nueva (en toda la tabla)
    # debe estar a menos de esto del fin. Una copia tomada antes de que el dia terminara no lo tiene entero; ese dia queda pendiente.
    tolerancia_fin_ms: int = 60_000
    filtro_sql: Optional[str] = None  # condicion SQL fija de la configuracion (premium_1m); nunca viene del usuario
    # Tablas con filas que SQLite todavia puede MODIFICAR (operaciones del trader, miradas del auditor): condicion SQL (fija, nunca del usuario)
    # de las filas que YA NO cambian. Un periodo se exporta solo cuando TODAS sus filas (las que pasan ``filtro_sql``) la cumplen; si queda
    # una que aun puede cambiar, el periodo queda en ``pendientes_por_abrir`` (no es un hueco) hasta una copia mas nueva. Nunca se exporta
    # "lo que ya se puede" de un periodo: el manifiesto lo daria por hecho y el resto no se archivaria jamas.
    inmutable_sql: Optional[str] = None

    def __post_init__(self):
        if self.granularidad not in ("dia", "mes"):
            raise ValueError("granularidad invalida: %r" % self.granularidad)
        for c in self.columnas:
            if c.tipo not in TIPOS:
                raise ValueError("tipo invalido %r en %s" % (c.tipo, c.nombre))
        for n in self.clave + self.grupo_por + (self.tiempo,):
            if n not in self.nombres:
                raise ValueError("%s no es una columna de %s" % (n, self.nombre))
        for d in self.derivadas:
            if d.origen not in self.nombres:
                raise ValueError("la derivada %s apunta a una columna que no existe" % d.nombre)

    @property
    def nombres(self) -> Tuple[str, ...]:
        """Columnas que existen en SQLite (las que se hashean y se comparan fila a fila)."""
        return tuple(c.nombre for c in self.columnas)

    @property
    def nombres_tipo(self) -> Tuple[str, ...]:
        """Columnas ``tipo_<col>`` de las columnas mixtas (solo en el archivo)."""
        return tuple("tipo_" + c.nombre for c in self.columnas if c.tipo == "mixto")

    @property
    def nombres_archivo(self) -> Tuple[str, ...]:
        """Todas las columnas del archivo en orden: las de SQLite, los tipos de las mixtas y las derivadas ``j_*``."""
        return self.nombres + self.nombres_tipo + tuple(d.nombre for d in self.derivadas)

    def tipo_de(self, nombre: str) -> str:
        for c in self.columnas:
            if c.nombre == nombre:
                return c.tipo
        for d in self.derivadas:
            if d.nombre == nombre:
                return d.tipo
        raise KeyError(nombre)


def _cols(spec: str, dicc: Tuple[str, ...] = (), sin_stats: Tuple[str, ...] = (), bss: Tuple[str, ...] = ()) -> Tuple[Columna, ...]:
    out = []
    for item in spec.split():
        nombre, tipo = item.split(":")
        nullable = tipo.endswith("?")
        out.append(Columna(nombre, tipo.rstrip("?"), nullable, nombre in dicc, nombre not in sin_stats, nombre in bss))
    return tuple(out)


# Columnas de texto que son JSON o texto largo: sin diccionario (se llena y se descarta) y sin estadisticas (el min/max de 11 KB no sirve).
TABLAS = {
    # ---- las tres pesadas (formato 2 completo) ----
    # verdicts: 1 archivo por DIA, ordenado por (producto, minuto), UN grupo de filas por producto (<= ~1.440 filas, ~16 MB sin comprimir),
    # JSON original intacto + 6 columnas j_* (solo lo que el codigo consulta). zstd 9. Rutas del JSON: futures_verdicts.evaluate_verdict.
    "verdicts": TablaConfig(
        nombre="verdicts", sqlite="paper_futures_verdicts", tiempo="bucket_start", clave=("product_id", "bucket_start"),
        columnas=_cols("product_id:text bucket_start:int interval_ms:int decision_known_at:int regime:text action:text reason_code:text "
                       "verdict_hash:text payload_json:text written_at:int",
                       dicc=("product_id", "regime", "action", "reason_code"), sin_stats=("payload_json",)),
        hash="verdict_hash", filtro_tipico="action", grupo_por=("product_id",), nivel_zstd=9, filas_por_grupo=GRUPO_PESADO,
        derivadas=(
            Derivada("j_selected_strategy_id", "payload_json", ("selected", "strategy_id"), "text", diccionario=True),
            Derivada("j_knowledge_lag_ms", "payload_json", ("knowledge_lag_ms",), "int"),
            Derivada("j_previous_regime", "payload_json", ("previous_regime",), "text", diccionario=True),
            Derivada("j_config_hash", "payload_json", ("config_hash",), "text", diccionario=True),
            Derivada("j_schema_version", "payload_json", ("schema_version",), "text", diccionario=True),
            Derivada("j_proposals_n", "payload_json", ("proposals",), "int", op="len"),
        )),
    # funding_responses: ~1 MB por fila, cuerpos casi iguales entre si. 1 archivo por MES, zstd 19, paginas de 64 MB para que zstd vea
    # cuerpos enteros, grupos de 16 filas (~16 MB: memoria acotada), sin diccionario ni estadisticas en el cuerpo. Sin producto.
    "funding_responses": TablaConfig(
        nombre="funding_responses", sqlite="paper_futures_funding_responses", tiempo="received_at", clave=("received_at", "sha256"),
        columnas=_cols("sha256:text received_at:int server_time:text raw_response:text", sin_stats=("sha256", "raw_response")),
        hash="sha256", producto=None, granularidad="mes", filas_por_grupo=16, nivel_zstd=19, pagina_bytes=64 * 1024 * 1024),
    # candle_revisions: ~175 revisiones por vela, todas se archivan (no se pierde historia). 1 archivo por MES (por bucket_start: la vela y sus
    # revisiones caen juntas), orden (intervalo, minuto, vela, revision), grupos de hasta 50.000 filas dentro de cada intervalo. zstd 9.
    "candle_revisions": TablaConfig(
        nombre="candle_revisions", sqlite="paper_futures_candle_revisions", tiempo="bucket_start",
        clave=("interval_ms", "bucket_start", "candle_id", "revision"),
        columnas=_cols("candle_id:text interval_ms:int bucket_start:int revision:int known_at:int close_at:int? is_closed:int coverage:text "
                       "open_price:text high_price:text low_price:text close_price:text volume_btc:text trade_count:int source_hash:text",
                       dicc=("coverage",)),
        hash="source_hash", producto=None, granularidad="mes", filtro_tipico="coverage", grupo_por=("interval_ms",),
        filas_por_grupo=50_000, nivel_zstd=9),
    # ---- el resto, con el formato del informe (segunda tanda: se afinan con datos reales) ----
    "llm_decisions": TablaConfig(
        nombre="llm_decisions", sqlite="paper_futures_llm_decisions", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "question_id", "question_version"),
        columnas=_cols("product_id:text bucket_start:int question_id:text question_version:int verdict_hash:text question_type:text "
                       "model_ref:text model_info_json:text prompt_hash:text prompt_version:int probability_source:text state_text:text "
                       "top_logprobs_json:text probabilities_json:text temperature:real chosen:text value:real? confidence:real "
                       "latency_ms:int timings_json:text written_at:int",
                       dicc=("product_id", "question_id", "question_type", "model_ref", "model_info_json", "probability_source", "chosen"),
                       sin_stats=("model_info_json", "state_text", "top_logprobs_json", "probabilities_json", "timings_json")),
        hash="verdict_hash", filtro_tipico="chosen", filas_por_grupo=GRUPO_PESADO, grupo_por=("product_id",), nivel_zstd=9),
    "llm_skips": TablaConfig(
        nombre="llm_skips", sqlite="paper_futures_llm_skips", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "question_id", "question_version", "skip_id"), granularidad="mes",
        columnas=_cols("skip_id:int product_id:text bucket_start:int question_id:text question_version:int code:text reason:text written_at:int",
                       dicc=("product_id", "question_id", "code"), sin_stats=("reason",)),
        filtro_tipico="code", grupo_por=("product_id",)),
    # market_events: la retencion de la captura borra tickers a 48 h (era 24) y recorta normalized_json a las 48 h. Margen 0: el dia D se
    # exporta con cualquier copia tomada entre el fin de D y las 48 h de su inicio (o sea, UNA copia diaria siempre lo ve entero). Dos
    # guardas: se exige que la copia conserve el INICIO del dia (si no, `omitidos_por_retencion`) y que llegue a su FIN (si no, queda
    # `pendientes_por_abrir` hasta una copia mas nueva); nunca se certifica un dia incompleto. Ver docs/archivo-parquet.md.
    # La clave lleva product_id y event_id ademas de received_at: da un orden total y deja buscar por producto y tiempo.
    "market_events": TablaConfig(
        nombre="market_events", sqlite="paper_futures_market_events", tiempo="received_at",
        clave=("product_id", "received_at", "event_id"),
        columnas=_cols("event_id:text feed:text product_id:text epoch:int seq:int event_time:int received_at:int persisted_at:int "
                       "uid:text? raw_json:text normalized_json:text content_hash:text",
                       dicc=("feed", "product_id"), sin_stats=("raw_json", "normalized_json")),
        hash="content_hash", filtro_tipico="feed", filas_por_grupo=GRUPO_PESADO, grupo_por=("product_id",), nivel_zstd=9,
        margen_cierre_ms=0, exigir_inicio_completo=True),
    # ---- puntajes de pronostico (futures-forecast-scores): append-only, una fila por pronostico y componente. Tiempo = bucket_start (minuto de
    # la decision), no written_at: asi la fila cae en el dia de la decision aunque se puntue mas tarde (los puntajes de 24 h llegan al dia siguiente;
    # por eso el margen de 1 dia importa). Las columnas de precios/bp son TEXT en SQLite y se guardan tal cual. Filas chicas: grupo normal.
    "forecast_verdicts": TablaConfig(
        nombre="forecast_verdicts", sqlite="paper_futures_forecast_verdicts", tiempo="bucket_start", clave=("product_id", "bucket_start"),
        granularidad="mes", columnas=_cols("product_id:text bucket_start:int verdict_hash:text forecasts:int written_at:int", dicc=("product_id",)),
        hash="verdict_hash", grupo_por=("product_id",), filas_por_grupo=50_000),
    "forecasts": TablaConfig(
        nombre="forecasts", sqlite="paper_futures_forecasts", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text side:text regime:text utc_hour:int knowledge_lag_ms:int? "
                       "backfill:int entry_price:text proposed_stop:text? proposed_target:text? signal_key:text? verdict_hash:text written_at:int",
                       dicc=("product_id", "source", "strategy_id", "side", "regime")),
        hash="verdict_hash", filtro_tipico="strategy_id", grupo_por=("product_id",)),
    "forecast_returns": TablaConfig(
        nombre="forecast_returns", sqlite="paper_futures_forecast_returns", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id", "horizon_min"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text horizon_min:int gross_bp:text net_bp:text "
                       "exit_bucket_start:int written_at:int", dicc=("product_id", "source", "strategy_id")),
        filtro_tipico="strategy_id", grupo_por=("product_id",)),
    "forecast_barriers": TablaConfig(
        nombre="forecast_barriers", sqlite="paper_futures_forecast_barriers", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text outcome:text ambiguous:int hit_after_ms:int? written_at:int",
                       dicc=("product_id", "source", "strategy_id", "outcome")),
        filtro_tipico="outcome", grupo_por=("product_id",)),
    "forecast_excursions": TablaConfig(
        nombre="forecast_excursions", sqlite="paper_futures_forecast_excursions", tiempo="bucket_start",
        clave=("product_id", "bucket_start", "source", "strategy_id"),
        columnas=_cols("product_id:text bucket_start:int source:text strategy_id:text window_min:int mfe_bp:text mae_bp:text written_at:int",
                       dicc=("product_id", "source", "strategy_id")),
        filtro_tipico="strategy_id", grupo_por=("product_id",)),
    # ---- posicionamiento (positioning-collector): MENSUAL, foto completa del mes. Tiempo = bucket_ms (inicio del intervalo de la muestra).
    # Los float64 llevan byte_stream_split (medido: -7 %, bit a bit exacto).
    "positioning": TablaConfig(
        nombre="positioning", sqlite="positioning", tiempo="bucket_ms", clave=("product_id", "bucket_ms"), granularidad="mes",
        columnas=_cols("product_id:text bucket_ms:int long_percent:real? long_count:int? short_count:int? "
                       "top_long_percent:real? top_long_count:int? top_short_count:int? top_open_interest:real?",
                       dicc=("product_id",), bss=("long_percent", "top_long_percent", "top_open_interest")),
        grupo_por=("product_id",)),
    "premium": TablaConfig(
        nombre="premium", sqlite="premium", tiempo="bucket_ms", clave=("product_id", "interval_ms", "bucket_ms"), granularidad="mes",
        columnas=_cols("product_id:text interval_ms:int bucket_ms:int mark:real spot:real premium_bp:real", dicc=("product_id",),
                       bss=("mark", "spot", "premium_bp")),
        grupo_por=("product_id", "interval_ms")),
    # premium de 1 minuto: SQLite lo recorta a 7 dias (keep_days), asi que el archivo MENSUAL llega tarde y no lo tiene. Esta config lo archiva
    # por DIA, al dia siguiente (margen 0). El mensual sigue sin filtro (no se pierde lo que ya se archivo); lo de 1 min queda duplicado ahi.
    "premium_1m": TablaConfig(
        nombre="premium_1m", sqlite="premium", tiempo="bucket_ms", clave=("product_id", "interval_ms", "bucket_ms"), granularidad="dia",
        columnas=_cols("product_id:text interval_ms:int bucket_ms:int mark:real spot:real premium_bp:real", dicc=("product_id",),
                       bss=("mark", "spot", "premium_bp")),
        grupo_por=("product_id",), filtro_sql='"interval_ms" = 60000', margen_cierre_ms=0),
    # ---- noticias (futures-news; la base SQLite se conserva): MENSUAL, sin producto. Tiempo = received_at (cuando llego a nuestro sistema:
    # siempre presente, a diferencia de published_at, que puede ser NULL o venir adelantado/atrasado). En el analisis, analyzed_at.
    # Se deja item_id / analysis_id al final de la clave para tener orden total.
    "news_items": TablaConfig(
        nombre="news_items", sqlite="paper_futures_news_items", tiempo="received_at", clave=("received_at", "item_id"), granularidad="mes",
        columnas=_cols("item_id:int item_hash:text source_id:text source:text url:text title:text summary:text published_at:int? "
                       "received_at:int content_hash:text", dicc=("source_id", "source"), sin_stats=("url", "title", "summary")),
        hash="content_hash", producto=None, filtro_tipico="source_id", filas_por_grupo=GRUPO_PESADO),
    "news_analysis": TablaConfig(
        nombre="news_analysis", sqlite="paper_futures_news_analysis", tiempo="analyzed_at", clave=("analyzed_at", "analysis_id"), granularidad="mes",
        columnas=_cols("analysis_id:int item_hash:text question_id:text question_version:int status:text analyzed_at:int question_type:text? "
                       "model_ref:text? model_info_json:text? prompt_hash:text? prompt_version:int? probability_source:text? "
                       "top_logprobs_json:text? probabilities_json:text? temperature:real? chosen:text? value:real? confidence:real? "
                       "latency_ms:int? timings_json:text?",
                       dicc=("question_id", "status", "question_type", "model_ref", "probability_source", "chosen"),
                       sin_stats=("model_info_json", "top_logprobs_json", "probabilities_json", "timings_json")),
        producto=None, filtro_tipico="status", filas_por_grupo=GRUPO_PESADO),
}

# ---- datos-utiles (odd/tasks/datos-utiles.md). Regla de TIEMPO: cada periodo se cierra con una columna que ya no puede recibir filas nuevas
# (la hora en que el dato se grabo o se decidio), nunca con la hora de un hecho viejo que se aprende tarde: una fila agregada despues a un dia
# ya exportado no se archivaria jamas. Por eso velas, funding y analytics usan ``known_at`` (cuando llegaron) y no ``bucket_start`` / ``start_ms``
# (en la copia del VPS hay revisiones de velas aprendidas hasta 10 dias despues de su minuto, y funding aprendido hasta un ano despues).
#
# ---- base viva del trader (qwen-live__live). SQLite la modifica; solo se archiva lo que ya no cambia ----
# decisions: INSERT OR IGNORE por (product, bucket_ms), nunca se actualiza. Tiempo = t_ms (la hora de la decision; el bucket es t_ms - 15 min).
# Las columnas de SQLite (no STRICT) siguen la afinidad declarada: REAL guarda reales, INTEGER enteros, TEXT texto; un valor de otro tipo falla
# el dia con fila y columna (ver ``validar_tipos``).
_DECISIONES = ("product:text bucket_ms:int t_ms:int decided_at_ms:int kind:text action:text model_action:text? p_action:real? confidence:real? "
               "probs_json:text? orders_json:text? override:text? reason:text? reason_json:text? mirror_action:text? mirror_p:real? wake_json:text? "
               "state_text:text? state_hash:text? latency_ms:int? threshold:real? prompt_version:text? prompt_hash:text? model:text? "
               "config_hash:text? position_json:text? net_bp_now:real? trade_no:int? lean:real? lean_m:real? lean_num:real? score:real? "
               "best_score:real? look_n:int? mirror_ok:int? factors_json:text? formula_action:text? formula_json:text? opinion_agrees:int? "
               "opinion_error:text?")
TABLAS.update({
    "qwen_decisions": TablaConfig(
        nombre="qwen_decisions", sqlite="decisions", tiempo="t_ms", clave=("product", "t_ms", "bucket_ms"), producto="product",
        columnas=_cols(_DECISIONES,
                       dicc=("product", "kind", "action", "model_action", "override", "mirror_action", "prompt_version", "model", "config_hash",
                             "formula_action"),
                       sin_stats=("probs_json", "orders_json", "reason", "reason_json", "wake_json", "state_text", "position_json", "factors_json",
                                  "formula_json", "opinion_error")),
        filtro_tipico="action", filas_por_grupo=GRUPO_PESADO, grupo_por=("product",), nivel_zstd=9),
    # trades: la fila se ACTUALIZA mientras la operacion esta abierta y, ya cerrada, mientras el motor concilia su funding (funding_status deja de
    # ser 'complete' hasta que llega todo). Solo se archiva lo cerrado (status='closed'), por su hora de salida (exit_ms), y un dia solo cuando
    # TODAS sus operaciones cerradas tienen el funding completo. Las abiertas no pertenecen a ningun periodo.
    "qwen_trades": TablaConfig(
        nombre="qwen_trades", sqlite="trades", tiempo="exit_ms", clave=("product", "exit_ms", "trade_no"), producto="product",
        columnas=_cols("product:text trade_no:int status:text side:text entry_ms:int exit_ms:int? entry_px:text? exit_px:text? qty:text? "
                       "notional_usd:text? gross_usd:text? fees_usd:text? funding_usd:text? net_usd:text? net_bp:real? funding_status:text? "
                       "closed_by:text? exit_reason:text? entry_reason:text? entry_p:real? hold_min:int? mfe_bp:real? mae_bp:real? stop_px:real? "
                       "max_hold_ms:int? mark_px:real? mark_ms:int? net_now_usd:text? opened_at_ms:int? closed_at_ms:int? leverage:text? "
                       "margin_usd:text? funding_model:text? net_complete_usd:text? config_hash:text? execution_model:text? entry_receipt_id:text? "
                       "exit_receipt_id:text? mark_receipt_id:text? funding_receipt_id:text? execution_error:text? exit_plan_json:text?",
                       dicc=("product", "status", "side", "funding_status", "closed_by", "exit_reason", "leverage", "funding_model", "config_hash",
                             "execution_model"),
                       sin_stats=("entry_reason", "execution_error", "exit_plan_json")),
        filtro_tipico="closed_by", grupo_por=("product",), filtro_sql='"status" = \'closed\' AND "exit_ms" IS NOT NULL',
        inmutable_sql='"funding_status" = \'complete\''),
    # execution_receipts: STRICT, con triggers de solo-agregar. Tiempo = recorded_at_ms (cuando se grabo), NO signal_ms: el recibo de funding con que
    # el motor concilia una operacion vieja lleva el signal_ms de la salida pero se graba dias despues; con signal_ms caeria en un dia ya archivado.
    "qwen_execution_receipts": TablaConfig(
        nombre="qwen_execution_receipts", sqlite="execution_receipts", tiempo="recorded_at_ms", clave=("product", "recorded_at_ms", "receipt_id"),
        producto="product",
        columnas=_cols("receipt_id:text product:text trade_no:int purpose:text signal_ms:int recorded_at_ms:int evidence_hash:text evidence_json:text",
                       dicc=("product", "purpose"), sin_stats=("evidence_json",)),
        hash="evidence_hash", filtro_tipico="purpose", grupo_por=("product",), filas_por_grupo=GRUPO_PESADO, nivel_zstd=9),
    # news_actions: INSERT OR IGNORE por (product, event_id); nunca se actualiza. Tiempo = consumed_ms.
    "qwen_news_actions": TablaConfig(
        nombre="qwen_news_actions", sqlite="news_actions", tiempo="consumed_ms", clave=("product", "consumed_ms", "event_id"), producto="product",
        columnas=_cols("product:text event_id:text consumed_ms:int action:text evidence_json:text", dicc=("product", "action"),
                       sin_stats=("evidence_json",)),
        filtro_tipico="action", grupo_por=("product",)),
    # config_versions: solo-agregar (triggers). Pocas filas: un archivo por mes. Sin producto.
    "qwen_config_versions": TablaConfig(
        nombre="qwen_config_versions", sqlite="config_versions", tiempo="activated_ms", clave=("activated_ms", "id"), producto=None, granularidad="mes",
        columnas=_cols("id:int previous_hash:text? config_hash:text activated_ms:int config_json:text cash_usd:text", sin_stats=("config_json",)),
        hash="config_hash"),
    # ---- auditor (qwen-live__auditor): miradas. El auditor las ACTUALIZA hasta darles el veredicto de 36 h (``resuelto_ms`` queda puesto y ya no
    # las toca). Un dia se exporta solo cuando TODAS sus miradas estan resueltas. Tiempo = t_ms (la hora de la mirada). ----
    "auditor_miradas": TablaConfig(
        nombre="auditor_miradas", sqlite="miradas", tiempo="t_ms", clave=("product", "t_ms", "bucket_ms"), producto="product",
        columnas=_cols("product:text bucket_ms:int t_ms:int estado:text accion:text maestro:int? puntaje:real? umbral_flojo:real? umbral_fuerte:real? "
                       "portero_si:int? portero_p:real? portero_umbral:real? noticias_si:int? noticias_lado:int? qwen:text? qwen_coincide:int? "
                       "lado_posicion:int horas_en_posicion:real? neto_ahora_pb:real? trade_no:int? condiciones_json:text despues_json:text? "
                       "veredicto_12h_json:text? veredicto_24h_json:text? veredicto_36h_json:text? resuelto_ms:int? version:text",
                       dicc=("product", "estado", "accion", "qwen", "version"),
                       sin_stats=("condiciones_json", "despues_json", "veredicto_12h_json", "veredicto_24h_json", "veredicto_36h_json")),
        filtro_tipico="accion", grupo_por=("product",), nivel_zstd=9, inmutable_sql='"resuelto_ms" IS NOT NULL'),
    # ---- futures-market: velas oficiales, funding por periodo y puntos de analytics. Las tres son solo-agregar (triggers) y se cierran por ``known_at``. ----
    # Todos los productos (ETH y BTC incluidos): la tabla es chica y filtrar no ahorra nada.
    "official_candles": TablaConfig(
        nombre="official_candles", sqlite="paper_futures_official_candles", tiempo="known_at",
        clave=("product_id", "interval_ms", "known_at", "bucket_start", "revision_hash"),
        columnas=_cols("product_id:text interval_ms:int bucket_start:int revision_hash:text known_at:int open_price:text high_price:text "
                       "low_price:text close_price:text volume_btc:text response_sha256:text", dicc=("product_id",)),
        hash="revision_hash", grupo_por=("product_id",)),
    "funding_periods": TablaConfig(
        nombre="funding_periods", sqlite="paper_futures_funding_periods", tiempo="known_at",
        clave=("product_id", "known_at", "start_ms", "response_sha256"), granularidad="mes",
        columnas=_cols("response_sha256:text start_ms:int end_ms:int funding_rate:text known_at:int unit:text product_id:text",
                       dicc=("product_id", "unit")),
        grupo_por=("product_id",)),
    "analytics_points": TablaConfig(
        nombre="analytics_points", sqlite="paper_futures_analytics_points", tiempo="known_at",
        clave=("product_id", "metric", "interval_ms", "known_at", "bucket_start", "revision_hash"),
        columnas=_cols("product_id:text metric:text interval_ms:int bucket_start:int revision_hash:text known_at:int values_json:text "
                       "response_sha256:text", dicc=("product_id", "metric"), sin_stats=("values_json",)),
        hash="revision_hash", filtro_tipico="metric", grupo_por=("product_id",)),
})
