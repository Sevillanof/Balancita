"""Variants of Qwen for the quick test: other questions (prompt) or another model, each one its own version.

``config/qwen-quick-variants.json`` lists them. A prompt variant replaces the system text and/or the flat question of the v3
config (the photos are the same, so the numbers compare). A ``factors`` variant (the 8-line sheet) also changes the STATE and asks
the question by factors, one gradient per line. A model variant makes the quick test start its own ``llama-server``
on loopback (``--offline``: nothing is downloaded here) and stop it when the test ends. Qwen en vivo is never touched: its
config, its server and its database stay as they are.
"""

import copy
import json
import os
import subprocess
import time

from . import futures_llm_decisions as llm

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VARIANTS_PATH = os.path.join(ROOT, "config", "qwen-quick-variants.json")
SCHEMA = "balancita-qwen-quick-variants.v1"
CONTROL = "actual"
START_WAIT_S = 240.0


class VariantError(Exception):
    pass


def load_variants(path=None):
    with open(path or VARIANTS_PATH, encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("schema") != SCHEMA:
        raise VariantError("config/qwen-quick-variants.json: esquema desconocido {!r}".format(data.get("schema")))
    return data["variants"]


def get_variant(variant_id, variants=None):
    variants = variants if variants is not None else load_variants()
    for variant in variants:
        if variant["id"] == (variant_id or CONTROL):
            return variant
    raise VariantError("variante desconocida: {!r}".format(variant_id))


def apply_variant(cfg, variant):
    """The exam config as this variant asks Qwen. Everything that shapes a decision is hashed into the exam identity, so a
    variant never reads another one's database."""
    out = copy.deepcopy(cfg)
    prompt, change = out["prompt"], variant.get("prompt")
    if "state_extras" in variant:                       # more context in the STATE (see ``Trader._extra_lines``)
        out["state_extras"] = list(variant["state_extras"])
        out["state_context"] = list(variant.get("state_context") or ())
    if change:
        if "system" in change:
            prompt["system"] = change["system"]
        if "flat" in change:
            prompt["questions"]["flat"] = change["flat"]
    factors = variant.get("kind") == "factors"
    if factors:                                          # the 8-line sheet and the question by factors (``futures_qwen_factors``)
        out["state_ficha"] = bool(variant.get("state_ficha", True))
        out["state_context"] = list(variant.get("state_context") or ())
        out["factors"] = copy.deepcopy(variant["factors"])
    if change or factors or "state_extras" in variant:
        prompt["version"] = variant["prompt_version"]
    return out


def state_name(variant_id):
    return "rapida-v3.json" if variant_id == CONTROL else "rapida-v3-{}.json".format(variant_id)


def db_name(variant_id):
    return "exam-v3-rapida.sqlite" if variant_id == CONTROL else "exam-v3-rapida-{}.sqlite".format(variant_id)


def find_model_file(model, env=None, home=None):
    """Looks for the variant's GGUF in the places llama.cpp and Hugging Face keep them (bounded depth). ``None`` if absent."""
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    hf_home = (env.get("HF_HOME") or "").strip() or os.path.join(home, ".cache", "huggingface")
    roots = [(env.get("LLAMA_CACHE") or "").strip() or os.path.join(home, "Library", "Caches", "llama.cpp"),
             (env.get("HF_HUB_CACHE") or "").strip() or os.path.join(hf_home, "hub"),
             os.path.join(home, "models"), os.path.join(home, ".lmstudio", "models"), os.path.join(home, "Downloads")]
    extra = (env.get("QUICK_MODELS_DIR") or "").strip()
    if extra:
        roots.insert(0, extra)
    wanted = model["file"].lower()
    repo = model["hf"].split(":")[0].replace("/", "_").lower()
    for root in roots:
        for base, dirs, files in os.walk(root):
            if base[len(root):].count(os.sep) >= 6:
                dirs[:] = []
            for name in files:
                low = name.lower()
                if low == wanted or (low.endswith(wanted) and repo in low):
                    path = os.path.join(base, name)
                    if os.path.getsize(path) > 0:
                        return path
    return None


class ModelServer:
    """Context manager: ``llama-server`` for one model variant, on loopback and offline, stopped on exit."""

    def __init__(self, model, *, env=None, binary="llama-server", log=print, popen=subprocess.Popen, health=None):
        self.model, self.env, self.binary, self.log = model, dict(os.environ if env is None else env), binary, log
        self.popen, self.health = popen, health
        self.proc = None
        self.url = "http://127.0.0.1:{}".format(int(model["port"]))

    def __enter__(self):
        llm.check_loopback_url(self.url)
        path = find_model_file(self.model, self.env)
        if path is None:
            raise VariantError("falta el modelo {} (~{} GB): todavía no está descargado en esta Mac. Esta prueba no descarga "
                               "nada.".format(self.model["hf"], self.model["approx_gb"]))
        provider = llm.LlamaCppProvider(self.url, None, timeout=30.0)
        if (self.health or provider.health)():
            raise VariantError("el puerto {} ya está ocupado por otro llama-server".format(self.model["port"]))
        args = [self.binary, "-m", path, "--offline", "--host", "127.0.0.1", "--port", str(self.model["port"]), "-c", "8192",
                "-np", "2", "--no-mmproj", "--no-webui"]
        self.log("variante de modelo: levantando {} en {}".format(os.path.basename(path), self.url))
        self.proc = self.popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               env=self.env)
        deadline = time.monotonic() + START_WAIT_S
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise VariantError("llama-server se cortó al arrancar con {}".format(os.path.basename(path)))
            if (self.health or provider.health)():
                return self
            time.sleep(2.0)
        self.__exit__()
        raise VariantError("llama-server no respondió en {} s".format(int(START_WAIT_S)))

    def __exit__(self, *exc):
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        return False
