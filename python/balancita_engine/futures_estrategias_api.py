"""API de la página Estrategias: listar, crear y comparar variantes de la Terminal (rutas ``/api-strategies/estrategias``).

La página solo ve variantes de la Terminal (``config/estrategias/<id>.json``, ver ``futures_estrategias``); las estrategias de reglas
C25-C33 siguen guardadas en el registro pero esta API no las toca.

- ``GET  estrategias``: el snapshot de la Terminal, la ventana honesta, las perillas permitidas (con su valor actual) y las estrategias.
- ``POST estrategias``: crea ``<id>.json`` con ``base_config_hash`` del snapshot. Solo perillas de ``PERILLAS_PERMITIDAS``; un id que
  ya existe se rechaza (los overlays son inmutables: no hay ruta para editar ni borrar).
- ``POST estrategias/<id>/comparar``: arranca ``comparar`` en un hilo (tarda ~20 s por config) y devuelve un trabajo; solo corre uno a
  la vez. ``GET estrategias/<id>/comparar/<job>`` lo consulta y ``GET estrategias/<id>/comparar`` da el último de esa estrategia.
  La reserva NUNCA se usa desde acá: ``incluir_reserva`` no existe como campo y una ventana que pase de la reserva se rechaza.

- ``GET estrategias/velas/<producto>/<intervalo>/<desde_ms>/<hasta_ms>/<antes_ms>/<limite>``: velas OHLC para el gráfico del detalle, agregadas
  de las velas de 5 m de la caché que leyó el backtest (``History``, sin red, sin escribir). ``[desde_ms, hasta_ms)`` es la ventana PROBADA
  del informe: nunca se sirve una vela fuera de ella, y un ``hasta_ms`` que pase de la reserva se rechaza (400). ``antes_ms`` es el cursor
  de paginación hacia atrás y ``limite`` (1-5000) cuenta las velas más nuevas; solo salen velas completas (alineadas a UTC).

Los trabajos viven en memoria (se pierden al reiniciar el servidor). Esta API no escribe nada más que el archivo de la estrategia nueva.
"""

import json
import os
import re
import secrets
import threading
import time
import unicodedata

from . import futures_estrategias as est
from . import futures_qwen_analista as analista
from . import futures_estrategias_backtest as bt
from . import futures_qwen_trader as qt

CAMPOS_CREAR = ("id", "nombre", "descripcion", "cambios")
CAMPOS_COMPARAR = ("desde", "hasta")
MAX_NOMBRE, MAX_DESCRIPCION = 80, 500
MAX_TRABAJOS = 20
MAX_VELAS = 5000
INTERVALOS = {"15m": 15 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 86_400_000}
PRODUCTO_RE = re.compile(r"^PF_[A-Z0-9]{2,20}$")
TIPOS = {"int": "entero", "int5": "entero", "float": "decimal", "float?": "decimal", "enum": "opcion"}


class EstrategiasApiError(Exception):
    def __init__(self, code, detail, status=400, extra=None):
        super().__init__(detail)
        self.code, self.detail, self.status, self.extra = code, detail, status, extra or {}


def _slug(texto):
    plano = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", plano).strip("-")[:64].strip("-")


def _texto(cuerpo, campo, maximo):
    valor = cuerpo.get(campo)
    if not isinstance(valor, str) or not valor.strip():
        raise EstrategiasApiError("campo_invalido", "{} tiene que ser un texto que no esté vacío.".format(campo))
    if len(valor.strip()) > maximo:
        raise EstrategiasApiError("campo_invalido", "{} no puede pasar de {} caracteres.".format(campo, maximo))
    return valor.strip()


def _entero(texto, campo, codigo, detalle, minimo=0, maximo=None):
    if not re.match(r"^[0-9]{1,16}$", str(texto)) or int(texto) < minimo or (maximo is not None and int(texto) > maximo):
        raise EstrategiasApiError(codigo, "{} {} (recibí {!r}).".format(campo, detalle, texto))
    return int(texto)


def _agregar(barras, paso):
    """Velas de ``paso`` ms desde velas de 5 m ordenadas: apertura de la primera, máximo, mínimo, cierre de la última y volumen sumado."""
    velas = []
    for barra in barras:
        t = barra["bucket_start"] // paso * paso
        alto, bajo, cierre, volumen = (float(barra[k]) for k in ("high", "low", "close", "volume_btc"))
        if velas and velas[-1]["t"] == t:
            vela = velas[-1]
            vela.update(h=max(vela["h"], alto), l=min(vela["l"], bajo), c=cierre, v=vela["v"] + volumen)
        else:
            velas.append({"t": t, "o": float(barra["open"]), "h": alto, "l": bajo, "c": cierre, "v": volumen})
    return velas


def _valor_actual(config, clave):
    nodo = config
    for parte in clave.split("."):
        nodo = nodo.get(parte) if isinstance(nodo, dict) else None
    return nodo


def _perilla(clave, config):
    tipo, minimo, maximo = est.PERILLAS_PERMITIDAS[clave]
    out = {"clave": clave, "tipo": TIPOS[tipo], "valor_actual": _valor_actual(config, clave), "admite_null": tipo == "float?"}
    if tipo == "enum":
        out["opciones"] = list(analista.MODES)
    else:
        out.update(minimo=minimo, maximo=maximo, minimo_exclusivo=tipo in ("float", "float?"), paso=5 if tipo == "int5" else None)
    return out


class EstrategiasApi:
    def __init__(self, carpeta=None, snapshot_path=None, comparador=None, cache_dir=None, funding_archivo=None, reserva_desde_ms=None):
        self.carpeta = carpeta or est.ESTRATEGIAS_DIR
        self.snapshot_path = snapshot_path
        self.comparador = comparador or bt.comparar
        self.cache_dir, self.funding_archivo = cache_dir, funding_archivo
        self.reserva_desde_ms = reserva_desde_ms
        self._lock = threading.Lock()
        self._trabajos = {}                      # job_id -> dict, en orden de creación

    # ------------------------------------------------------------------ lectura

    def _snapshot(self):
        try:
            return est.cargar_snapshot(self.snapshot_path)
        except est.EstrategiaError as error:
            raise EstrategiasApiError("snapshot_invalido", str(error), 500) from error

    def _fila(self, id, snapshot):
        """Una estrategia tal como la ve la página; si el archivo no sirve, lo dice en ``error`` sin romper la lista."""
        fila = {"id": id, "nombre": id, "descripcion": "", "cambios": None, "base_config_hash": None, "overlay_sha256": None, "error": None}
        ruta = est.ruta_overlay(id, self.carpeta)
        try:
            with open(ruta, encoding="utf-8") as handle:
                overlay = json.load(handle)
        except (OSError, ValueError) as error:
            fila["error"] = "Estrategia '{}': archivo ilegible ({}).".format(id, error)
            return fila
        if isinstance(overlay, dict):
            for campo, destino in (("nombre", "nombre"), ("descripcion", "descripcion"), ("cambios", "cambios"),
                                   ("base_config_hash", "base_config_hash")):
                if isinstance(overlay.get(campo), (str, dict)):
                    fila[destino] = overlay[campo]
        try:
            fila["overlay_sha256"] = est.sha256_overlay(id, self.carpeta)
            est.config_desde_overlay(overlay, id, snapshot)
        except est.EstrategiaError as error:
            fila["error"] = str(error)
        return fila

    def _ids(self):
        try:
            nombres = sorted(os.listdir(self.carpeta))
        except FileNotFoundError:
            return []
        return [n[:-5] for n in nombres if n.endswith(".json") and est.ID_RE.match(n[:-5])]

    def listar(self):
        snapshot = self._snapshot()
        return {"snapshot": {"config_hash": snapshot["config_hash"], "origen": snapshot.get("origen")},
                "ventana_honesta": {"desde": bt.DESDE_HONESTA, "hasta": bt.HASTA_HONESTA},
                "perillas": [_perilla(clave, snapshot["config"]) for clave in est.PERILLAS_PERMITIDAS],
                "estrategias": [self._fila(id, snapshot) for id in self._ids()]}

    # ------------------------------------------------------------------ crear

    def crear(self, cuerpo):
        if not isinstance(cuerpo, dict):
            raise EstrategiasApiError("campos_desconocidos", "El cuerpo tiene que ser un objeto con {}.".format(", ".join(CAMPOS_CREAR)))
        sobran = sorted(set(cuerpo) - set(CAMPOS_CREAR))
        if sobran:
            raise EstrategiasApiError("campos_desconocidos", "Campos que no se aceptan: {}. Solo {} (la base la pone el servidor).".format(
                ", ".join(sobran), ", ".join(CAMPOS_CREAR)))
        nombre = _texto(cuerpo, "nombre", MAX_NOMBRE)
        descripcion = _texto(cuerpo, "descripcion", MAX_DESCRIPCION)
        id = cuerpo["id"] if "id" in cuerpo else _slug(nombre)
        if not id:
            raise EstrategiasApiError("id_invalido", "No se pudo armar el id desde el nombre: escribí un id (minúsculas, números y guiones).")
        try:
            ruta = est.ruta_overlay(id, self.carpeta)
        except est.EstrategiaError as error:
            raise EstrategiasApiError("id_invalido", "{} Usá minúsculas, números y guiones (hasta 64).".format(error)) from error
        if os.path.exists(ruta):
            raise EstrategiasApiError("estrategia_existe", "Ya existe la estrategia '{}': no se puede pisar ni editar; elegí otro id.".format(id), 409)
        snapshot = self._snapshot()
        overlay = {"id": id, "nombre": nombre, "descripcion": descripcion, "base_config_hash": snapshot["config_hash"],
                   "cambios": cuerpo.get("cambios")}
        try:
            est.config_desde_overlay(overlay, id, snapshot)
        except est.EstrategiaError as error:
            raise EstrategiasApiError("estrategia_invalida", str(error)) from error
        os.makedirs(self.carpeta, exist_ok=True)
        try:
            with open(ruta, "x", encoding="utf-8") as handle:           # "x": nunca pisa un archivo que apareció entre medio
                handle.write(json.dumps(overlay, ensure_ascii=False, indent=1) + "\n")
        except FileExistsError:
            raise EstrategiasApiError("estrategia_existe", "Ya existe la estrategia '{}': no se puede pisar ni editar; elegí otro id.".format(id), 409) from None
        return self._fila(id, snapshot)

    # ------------------------------------------------------------------ comparar

    def _existente(self, id):
        try:
            ruta = est.ruta_overlay(id, self.carpeta)
        except est.EstrategiaError as error:
            raise EstrategiasApiError("id_invalido", str(error)) from error
        if not os.path.exists(ruta):
            raise EstrategiasApiError("estrategia_no_existe", "No existe la estrategia '{}'.".format(id), 404)
        return self._snapshot()

    def _ventana(self, cuerpo):
        if not isinstance(cuerpo, dict):
            raise EstrategiasApiError("campos_desconocidos", "El cuerpo tiene que ser un objeto con {}.".format(", ".join(CAMPOS_COMPARAR)))
        sobran = sorted(set(cuerpo) - set(CAMPOS_COMPARAR))
        if sobran:
            detalle = "Campos que no se aceptan: {}. Solo {}.".format(", ".join(sobran), ", ".join(CAMPOS_COMPARAR))
            if "incluir_reserva" in sobran:
                detalle += " La reserva no se puede usar desde la página."
            raise EstrategiasApiError("campos_desconocidos", detalle)
        desde, hasta = cuerpo.get("desde", bt.DESDE_HONESTA), cuerpo.get("hasta", bt.HASTA_HONESTA)
        try:
            bt.validar_ventana(desde, hasta, self.reserva_desde_ms)
        except bt.ComparacionError as error:
            raise EstrategiasApiError("ventana_invalida", str(error)) from error
        return desde, hasta

    def _vista(self, trabajo):
        return {clave: trabajo[clave] for clave in ("job_id", "estrategia_id", "estado", "desde", "hasta", "iniciado_ms", "terminado_ms",
                                                      "informe", "error")}

    def comparar(self, id, cuerpo):
        snapshot = self._existente(id)
        desde, hasta = self._ventana(cuerpo)
        try:
            est.cargar_estrategia(id, self.carpeta, snapshot)
        except est.EstrategiaError as error:
            raise EstrategiasApiError("estrategia_invalida", str(error)) from error
        with self._lock:
            corriendo = next((t for t in self._trabajos.values() if t["estado"] == "corriendo"), None)
            if corriendo:
                raise EstrategiasApiError("comparacion_en_curso", "Ya hay una comparación corriendo ({}): esperá a que termine.".format(
                    corriendo["estrategia_id"]), 409, {"job_id": corriendo["job_id"]})
            trabajo = {"job_id": secrets.token_hex(6), "estrategia_id": id, "estado": "corriendo", "desde": desde, "hasta": hasta,
                       "iniciado_ms": int(time.time() * 1000), "terminado_ms": None, "informe": None, "error": None}
            self._trabajos[trabajo["job_id"]] = trabajo
            for viejo in [j for j, t in self._trabajos.items() if t["estado"] != "corriendo"][:-MAX_TRABAJOS]:
                del self._trabajos[viejo]
        threading.Thread(target=self._correr, args=(trabajo, snapshot), daemon=True).start()
        return self._vista(trabajo)

    def _correr(self, trabajo, snapshot):
        try:
            # incluir_reserva va fijo en False: no hay camino desde la API para pedirlo.
            informe = self.comparador(trabajo["estrategia_id"], trabajo["desde"], trabajo["hasta"], incluir_reserva=False,
                                      carpeta=self.carpeta, snapshot=snapshot, cache_dir=self.cache_dir,
                                      funding_archivo=self.funding_archivo)
            resultado = {"estado": "listo", "informe": informe}
        except Exception as error:  # noqa: BLE001 - el trabajo informa cualquier falla; el hilo no puede morir callado
            resultado = {"estado": "error", "error": str(error) or type(error).__name__}
        with self._lock:
            trabajo.update(resultado, terminado_ms=int(time.time() * 1000))

    def trabajo(self, id, job_id):
        with self._lock:
            trabajo = self._trabajos.get(job_id)
            if trabajo is None or trabajo["estrategia_id"] != id:
                raise EstrategiasApiError("trabajo_no_existe", "No existe la comparación {} de '{}'.".format(job_id, id), 404)
            return self._vista(trabajo)

    def ultimo(self, id):
        with self._lock:
            propios = [t for t in self._trabajos.values() if t["estrategia_id"] == id]
            if not propios:
                raise EstrategiasApiError("sin_comparacion", "'{}' todavía no se comparó desde que arrancó el servidor.".format(id), 404)
            return self._vista(propios[-1])

    # ------------------------------------------------------------------ velas

    def velas(self, producto, intervalo, desde, hasta, antes, limite):
        """Velas de ``[desde, hasta)`` (la ventana probada) anteriores a ``antes``, las ``limite`` más nuevas. Solo lectura de la caché."""
        if not PRODUCTO_RE.match(producto):
            raise EstrategiasApiError("producto_invalido", "El producto tiene que ser un símbolo PF_… (por ejemplo PF_ETHUSD).")
        if intervalo not in INTERVALOS:
            raise EstrategiasApiError("intervalo_invalido", "El intervalo tiene que ser uno de {} (recibí {!r}).".format(
                ", ".join(INTERVALOS), intervalo))
        instante = "tiene que ser un instante en milisegundos (entero, 0 o más)"
        desde = _entero(desde, "desde", "desde_invalido", instante)
        hasta = _entero(hasta, "hasta", "hasta_invalido", instante)
        antes = _entero(antes, "antes", "antes_invalido", instante)
        limite = _entero(limite, "limite", "limite_invalido", "tiene que ser un entero entre 1 y {}".format(MAX_VELAS), 1, MAX_VELAS)
        reserva = qt.load_holdout_ms() if self.reserva_desde_ms is None else self.reserva_desde_ms
        if desde >= hasta:
            raise EstrategiasApiError("ventana_invalida", "La ventana está vacía: desde ({}) tiene que ser anterior a hasta ({}).".format(desde, hasta))
        if hasta > reserva:
            raise EstrategiasApiError("ventana_invalida", "La ventana termina en {} y entra en la reserva (desde {}): no se sirven velas de la "
                                      "reserva.".format(qt.stamp(hasta), qt.stamp(reserva)))
        cache = self.cache_dir or qt.DEFAULT_CACHE
        if not os.path.exists(os.path.join(cache, "candles-{}.sqlite".format(producto))):      # History crearía el archivo vacío
            raise EstrategiasApiError("sin_velas", "No hay velas guardadas de {}.".format(producto), 404)
        paso = INTERVALOS[intervalo]
        inicio = -(-desde // paso) * paso                      # solo velas completas dentro de la ventana
        fin = hasta // paso * paso
        corte = min(antes, hasta) // paso * paso
        velas = []
        primera = max(inicio, corte - limite * paso)
        if corte > inicio:
            barras = qt.History(cache, reserva, offline=True).bars(producto, primera, corte)
            velas = _agregar(barras, paso)
        return {"producto": producto, "intervalo": intervalo, "desde_ms": inicio, "hasta_ms": fin, "velas": velas,
                "hay_mas": bool(velas) and primera > inicio}

    # ------------------------------------------------------------------ rutas

    def route(self, method, parts, body):
        """``parts``: la ruta sin el prefijo. ``None`` si no es de esta API. ``body`` es una función que lee el cuerpo."""
        if not parts or parts[0] != "estrategias":
            return None
        if method == "GET" and len(parts) == 1:
            return self.listar()
        if method == "POST" and len(parts) == 1:
            return self.crear(body())
        if method == "GET" and len(parts) == 8 and parts[1] == "velas":
            return self.velas(*parts[2:])
        if len(parts) >= 3 and parts[2] == "comparar":
            id = parts[1]
            if method == "POST" and len(parts) == 3:
                return self.comparar(id, body())
            if method == "GET" and len(parts) == 3:
                self._existente(id)
                return self.ultimo(id)
            if method == "GET" and len(parts) == 4:
                return self.trabajo(id, parts[3])
        raise EstrategiasApiError("not_found", "no route", 404)
