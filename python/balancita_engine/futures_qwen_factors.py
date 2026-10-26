"""La pregunta por factores de la Prueba rápida (variantes ``ficha`` y ``ficha-pista``): UNA llamada por foto en la que Qwen da un
gradiente de -2 a +2 por cada renglón F1..F8 de la ficha (``futures_qwen_ficha``), con gramática fija.

Respuesta: una sola línea ``F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0``. La gramática GBNF solo deja escribir eso; cada valor es
``("+" | "-") ("1" | "2") | "0"`` (cinco valores posibles, sin «+0» ni «-0»).

El gradiente de cada renglón es el VALOR ESPERADO sobre las probabilidades que devuelve el servidor (``logprobs`` con
``top_logprobs``, calculadas antes de la gramática), no el valor que Qwen escribió. Se calcula sin depender de cómo el
tokenizador parta la línea:

* se busca, por caracteres, qué token cubre los dos puntos de ``Fi:`` y qué texto sigue en cada alternativa del ``top_logprobs``
  de esa posición: ``+`` / ``-`` (signo), ``0`` (cero) o nada (los dos puntos solos: el valor viene en el token siguiente);
* el tokenizador de Qwen3 junta los dos puntos con el signo (``F``, ``1``, ``:+``, ``1``, `` F``, ``2``, ``:-``, ``2``, ... y
  ``:``, ``0`` para el cero), así que la decisión signo/cero cae en UNA posición: ``:+`` contra ``:-`` contra ``:``. Se probó
  también con la partida «:», «+», «1» y con «:+1» en un solo token (ver los tests): el resultado es el mismo;
* la magnitud (1 o 2) sale de la posición del dígito en la rama que Qwen escribió; si escribió 0 no hay dígito y los signos
  restantes valen 1.

Gradiente = (P(+) - P(-)) x magnitud, con las probabilidades renormalizadas sobre los valores permitidos. Una respuesta que no
respeta el formato es ``DecisionError`` (como la pregunta de letras).

Por foto se guardan los 8 gradientes reales y los 8 del espejo (tabla ``exam_factors``) y los números de cada renglón (tabla
``exam_ficha``). ``lectura_i = (F_i - F_i_espejo) / 2`` es lo que viene de los números, ``habito_i = (F_i + F_i_espejo) / 2`` lo
que Qwen diría igual; ``lean_num = suma de lectura_i de los votantes (F1 F2 F3 F4 F6 F7) / 12`` queda entre -1 y +1, como el del Examen. F5 y F8 siguen
en la ficha y en la línea de respuesta (con 0), pero no suman.
"""

import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor

from . import futures_llm_decisions as llm
from . import futures_qwen_trader as qt
from .futures_qwen_ficha import FACTORS, LABELS, VOTING, VOTING_INDEX

GRAMMAR = ('root ::= "F1:" v " F2:" v " F3:" v " F4:" v " F5:" v " F6:" v " F7:" v " F8:" v\n'
           'v ::= ("+" | "-") ("1" | "2") | "0"')
VALUE = r"(0|[+-][12])"
LINE = re.compile("^" + " ".join("F{}:{}".format(i, VALUE) for i in range(1, 9)) + "$")
MAX_TOKENS = 96
DENOMINATOR = 2.0 * len(VOTING)          # |lectura_i| <= 2, 6 renglones votan (F1 F2 F3 F4 F6 F7): lean_num queda en [-1, 1]

# Resumen: criterios fijos de la lectura por renglón (informe, sección 5). Votar (dar un gradiente que no sea cero) y leer (que
# el gradiente siga a los números) son cosas distintas: un renglón que casi nunca vota no se puede juzgar si lee o no.
MIN_ABS = 0.25                            # «votó»: |F_i| >= 0,25 en el real
VOTES_SHARE, VOTES_MIN_N = 0.20, 5        # menos que esto de las fotos (o menos de 5 fotos): «no vota»
READS_FLIP, READS_CORR = 0.80, 0.5
NO_READ_FLIP, NO_READ_CORR = 0.60, 0.2
AREA_MIN_PHOTOS = 5                       # F4 vale 0 con el precio dentro del área: se mide solo con fotos afuera, y hacen falta 5
NUMBER_TEXT = {"F1": "z de 24 h", "F2": "z de 4 h", "F3": "posición en el rango de 7 d", "F4": "distancia al área de valor",
               "F5": "volatilidad de 4 h contra la semana", "F6": "% de cuentas largas (centrado en 50)",
               "F7": "fuerza relativa a 4 h"}
RULE_FACTORS = (("F1", -1.0), ("F2", -1.0), ("F3", -1.0), ("F4", -1.0), ("F6", -1.0))   # la regla sin Qwen: reversión


# --------------------------------------------------------------------------- the request


def settings(cfg):
    factors = cfg.get("factors")
    if not factors or not factors.get("question"):
        raise qt.TraderError("falta factors.question en la configuración de la variante de factores")
    return factors


def build_prompt(state_text, question):
    """Fixed text first, STATE last (llama-server reuses the cached prefix: the real and the mirrored state share it)."""
    return "QUESTION: {}\nSTATE: {}".format(llm.sanitize_text(question), llm.sanitize_text(state_text))


def request_body(prompt, template):
    messages = []
    if template.get("system"):
        messages.append({"role": "system", "content": template["system"]})
    messages.append({"role": "user", "content": prompt})
    body = {"messages": messages, "max_tokens": MAX_TOKENS, "temperature": 0, "grammar": GRAMMAR, "logprobs": True,
            "top_logprobs": llm.TOP_LOGPROBS, "chat_template_kwargs": {"enable_thinking": False}, "cache_prompt": True}
    if template.get("lora"):
        body["lora"] = template["lora"]          # only the exam with an adapter (``exam --lora``): llama-server applies it to this request
    return body


# --------------------------------------------------------------------------- reading the answer


def parse_line(text):
    """The 8 integer values of a well-formed line, or ``None``."""
    match = LINE.match(text.strip())
    return None if match is None else [int(x) for x in match.groups()]


def _classify(alts, head, temperature):
    """Weights of what follows ``head`` in each alternative token: ``zero``, ``open`` (nothing: the value comes in the next
    token), ``plus`` / ``minus`` (sign only) and ``joint`` ({value: weight} when sign and digit share the token)."""
    top = max(lp for _, lp in alts)
    out = {"zero": 0.0, "open": 0.0, "plus": 0.0, "minus": 0.0, "joint": {}}
    for token, logprob in alts:
        if not token.startswith(head):
            continue
        rest, weight = token[len(head):], math.exp((logprob - top) / temperature)
        if rest == "":
            out["open"] += weight
        elif rest[0] == "0":
            out["zero"] += weight
        elif rest[0] in "+-" and len(rest) == 1:
            out["plus" if rest == "+" else "minus"] += weight
        elif rest[0] in "+-" and rest[1] in "12":
            value = int(rest[:2])
            out["joint"][value] = out["joint"].get(value, 0.0) + weight
    return out


def _alternatives(entry):
    """``[(token, logprob)]`` of a generated position: its ``top_logprobs`` plus the generated token if the server left it out."""
    alts = [(str(a.get("token", "")), a["logprob"]) for a in entry.get("top_logprobs") or []
            if llm._finite(a.get("logprob"))]
    if llm._finite(entry.get("logprob")) and str(entry.get("token", "")) not in {t for t, _ in alts}:
        alts.append((str(entry["token"]), entry["logprob"]))
    if not alts:
        raise llm.ModelResponseError("malformed_response", "a generated token has no logprobs")
    return alts


def _magnitude(entry, temperature):
    """Mean magnitude (1..2) of the digit position, over the digits the grammar allows."""
    weights = {1: 0.0, 2: 0.0}
    alts = _alternatives(entry)
    top = max(lp for _, lp in alts)
    for token, logprob in alts:
        if token in ("1", "2"):
            weights[int(token)] += math.exp((logprob - top) / temperature)
    total = weights[1] + weights[2]
    return (weights[1] + 2 * weights[2]) / total if total > 0 else 1.0


def gradients(entries, temperature=1.0):
    """``[{value, grad, p: {plus, minus, zero}, mag}]`` for F1..F8 from ``choices[0].logprobs.content``. Raises
    ``ModelResponseError`` when the line is not in the format or a position has no usable alternative."""
    if not isinstance(entries, list) or not entries:
        raise llm.ModelResponseError("malformed_response", "completion has no logprobs content")
    tokens = [str(e.get("token", "")) for e in entries]
    text = "".join(tokens)
    base = len(text) - len(text.lstrip())
    match = LINE.match(text.strip())
    if match is None:
        raise llm.ModelResponseError("bad_format", "the answer is not 'F1:+1 F2:-2 ... F8:0': {!r}".format(text[:80]))
    starts, end = [], 0
    for token in tokens:
        starts.append(end)
        end += len(token)
    ends = starts[1:] + [end]
    where = lambda char: next(k for k in range(len(tokens)) if starts[k] <= char < ends[k])
    out = []
    for index in range(8):
        value_at = base + match.start(index + 1)
        colon = value_at - 1
        k0 = where(colon)
        near = _classify(_alternatives(entries[k0]), text[starts[k0]:colon + 1], temperature)
        rest = text[value_at:ends[k0]]
        far, digit = None, None
        if rest == "":                                   # the value starts in the next token
            k1 = k0 + 1
            if k1 >= len(tokens):
                raise llm.ModelResponseError("bad_format", "the answer ends right after a colon")
            far = _classify(_alternatives(entries[k1]), "", temperature)
            digit = k1 + 1 if text[value_at:ends[k1]] in ("+", "-") else None
        elif rest in ("+", "-"):
            digit = k0 + 1
        mag = _magnitude(entries[digit], temperature) if digit is not None and digit < len(tokens) else 1.0
        zero, plus, minus, joint = near["zero"], near["plus"], near["minus"], dict(near["joint"])
        if far is None:
            zero += near["open"]                         # ":" alone can only be followed by the digit 0 here
        else:
            total = far["zero"] + far["plus"] + far["minus"] + sum(far["joint"].values())
            if total > 0:
                share = near["open"] / total
                zero, plus, minus = zero + far["zero"] * share, plus + far["plus"] * share, minus + far["minus"] * share
                for value, weight in far["joint"].items():
                    joint[value] = joint.get(value, 0.0) + weight * share
            else:
                zero += near["open"]
        total = zero + plus + minus + sum(joint.values())
        if not total > 0:
            raise llm.ModelResponseError("no_value", "F{} has no allowed value among the top logprobs".format(index + 1))
        grad = (mag * (plus - minus) + sum(value * weight for value, weight in joint.items())) / total
        out.append({"value": int(match.group(index + 1)), "grad": grad, "mag": mag,
                    "p": {"plus": plus / total, "minus": minus / total, "zero": zero / total}})
    return out


def read_completion(completion, temperature=1.0):
    """``{text, values, grads, detail}`` of a llama-server chat completion (grammar-constrained, with logprobs)."""
    try:
        choice = completion["choices"][0]
        entries = choice["logprobs"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise llm.ModelResponseError("malformed_response", "completion has no logprobs content") from error
    if choice.get("finish_reason") == "length":
        raise llm.ModelResponseError("bad_format", "the answer was cut by max_tokens")
    detail = gradients(entries, temperature)
    return {"text": "".join(str(e.get("token", "")) for e in entries).strip(), "values": [d["value"] for d in detail],
            "grads": [d["grad"] for d in detail], "detail": detail}


# --------------------------------------------------------------------------- per photo


def lean_of(grads):
    """Sum of the 6 voting gradients (F1 F2 F3 F4 F6 F7, by their place in the sheet) over 12: the lean in [-1, +1]."""
    return math.fsum(grads[i] for i in VOTING_INDEX) / DENOMINATOR


def summary_action(grads):
    """``(action, p)`` of a photo for the tables that expect one: the side of the sum and its size (0..1)."""
    lean = lean_of(grads)
    return ("LARGO" if lean > 1e-9 else "CORTO" if lean < -1e-9 else "ESPERAR"), abs(lean)


def photo_numbers(real, mirror):
    """Everything derived from the two answers of a photo."""
    lectura = [(a - b) / 2 for a, b in zip(real, mirror)]
    habito = [(a + b) / 2 for a, b in zip(real, mirror)]
    return {"real": list(real), "mirror": list(mirror), "lectura": lectura, "habito": habito,
            "suma": math.fsum(real[i] for i in VOTING_INDEX), "lean_num": math.fsum(lectura[i] for i in VOTING_INDEX) / DENOMINATOR}


FICHA_SQL = """
CREATE TABLE IF NOT EXISTS exam_ficha(snap_id TEXT PRIMARY KEY, numbers_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exam_factors(
  snap_id TEXT NOT NULL, step TEXT NOT NULL, text TEXT NOT NULL, grads_json TEXT NOT NULL, detail_json TEXT NOT NULL,
  latency_ms INTEGER, prompt_hash TEXT, prompt_version REAL, model TEXT, asked_at_ms INTEGER, PRIMARY KEY(snap_id, step));
"""


class FactorsDecider:
    """Asks the factors question of one STATE (``step`` ``action`` for the real numbers, ``mirror`` for the mirrored ones).

    Same contract as ``LlmDecider`` for the exam loop: ``BudgetExhausted`` when the time budget would be passed, ``ModelDown``
    after three unreachable calls in a row, ``DecisionError`` on an answer that is not in the format. With a ``store`` (the
    exam's ``PracticeDB``) every answer is saved and a question already answered is never asked again.

    ``ask_pair`` asks the real and the mirrored state of one photo at the same time (llama-server ``-np 2`` serves them in
    parallel; ``concurrent=False`` asks them one after the other). Same pattern as ``LlmDecider._call_many``: only the HTTP
    request runs in a worker thread (``_request`` touches nothing shared); the counters, the SQLite inserts (the connection
    of ``PracticeDB`` belongs to the calling thread) and the call errors are all handled by the calling thread afterwards, so
    no lock is needed."""

    def __init__(self, provider, cfg, *, store=None, clock=time.monotonic, deadline=None, model=None, concurrent=True):
        self.provider, self.cfg, self.store, self.clock, self.deadline, self.model = provider, cfg, store, clock, deadline, model
        self.template = qt.template_of(cfg)
        self.question = settings(cfg)["question"]
        self.temperature = float(cfg["prompt"]["temperature"])
        self.concurrent = concurrent
        self.calls = 0
        self.spent = 0.0              # wall seconds spent waiting for the model (a concurrent pair counts once)
        self.down = 0

    def mean_call(self):
        """Wall seconds per call: with a concurrent pair this is about half the latency of one call."""
        return self.spent / self.calls if self.calls else 0.0

    def _stored(self, snap_id, step):
        row = self.store.db.execute("SELECT * FROM exam_factors WHERE snap_id=? AND step=?", (snap_id, step)).fetchone() \
            if self.store else None
        if row is None:
            return None
        return {"text": row["text"], "grads": json.loads(row["grads_json"]), "detail": json.loads(row["detail_json"]),
                "values": [d["value"] for d in json.loads(row["detail_json"])], "latency_ms": row["latency_ms"]}

    @staticmethod
    def _decorated(result):
        action, p = summary_action(result["grads"])
        return dict(result, chosen=action, probabilities={action: p})

    def ask(self, snap_id, t_ms, step, state_text):
        """``{text, values, grads, detail, latency_ms, chosen, probabilities}`` (the last two: the side of the sum, for the tables)."""
        result = self._stored(snap_id, step)
        if result is None:
            result = self._call(snap_id, t_ms, step, state_text)
        return self._decorated(result)

    # ---- one photo: real and mirror

    def ask_pair(self, snap_id, t_ms, real_text, mirror_text):
        """``(real, mirror)``, each as ``ask`` returns it. What is already stored is not asked again; when both are missing and
        ``concurrent`` they go out at the same time (otherwise real first, then mirror), and when only one is missing it is
        asked alone.

        * ``BudgetExhausted`` before anything is launched when the pair would pass the deadline (two calls at the mean wall
          time per call).
        * ``DecisionError`` when an answer is not in the format. The other answer, if valid, is saved all the same so it is
          never asked again; the error carries ``answers``: ``{step: result}`` of what did come out (stored or new), which the
          exam uses to fill what it can of the photo's row. In series, a failed real answer means the mirror is not asked.
        * ``ModelDown`` after three unreachable calls in a row. A pair counts like its calls would one after the other,
          except that the answers that did arrive are handled first (and set ``down`` to 0): if one call of the pair is
          unreachable and the other answered, ``down`` ends at 1 and the unreachable one is asked again alone."""
        steps = (("action", real_text), ("mirror", mirror_text))
        out = {step: self._stored(snap_id, step) for step, _ in steps}
        missing = [(step, text) for step, text in steps if out[step] is None]
        if len(missing) == 2 and self.concurrent:
            self._guard(2)
            out.update(self._call_pair(snap_id, t_ms, missing))
        else:
            failure = None
            for step, text in missing:
                try:
                    out[step] = self._call(snap_id, t_ms, step, text)
                except qt.DecisionError as error:
                    failure = error
                    break                                   # as ever in series: the mirror is not asked after a failed real
            if failure is not None:
                failure.answers = {s: self._decorated(r) for s, r in out.items() if r is not None}
                raise failure
        return self._decorated(out["action"]), self._decorated(out["mirror"])

    def read_states(self, texts, concurrent):
        """Asks each STATE of ``texts`` without storing or counting anything (``check_parallel``): one after the other or all at
        once. A list with, per text, the ``read_completion`` result or ``None`` when the answer is not in the format.
        ``TraderError`` when the server does not answer."""
        bodies = [request_body(build_prompt(text, self.question), self.template) for text in texts]
        if concurrent:
            with ThreadPoolExecutor(max_workers=len(bodies)) as pool:
                got = [f.result() for f in [pool.submit(self._request, body) for body in bodies]]
        else:
            got = [self._request(body) for body in bodies]
        out = []
        for answer, _, error in got:
            if isinstance(error, llm.ModelUnavailable):
                raise qt.TraderError("llama-server no contestó: {}".format(error))
            try:
                if error is not None:
                    raise error
                out.append(read_completion(answer["completion"], self.temperature))
            except llm.ModelResponseError:
                out.append(None)
        return out

    def _guard(self, count):
        if self.deadline is not None and self.clock() + self.mean_call() * count > self.deadline:
            raise qt.BudgetExhausted()

    def _call_pair(self, snap_id, t_ms, missing):
        prepared = []
        for step, text in missing:
            prompt = build_prompt(text, self.question)
            prepared.append((step, prompt, request_body(prompt, self.template)))
        started = self.clock()
        with ThreadPoolExecutor(max_workers=len(prepared)) as pool:
            futures = [pool.submit(self._request, body) for _, _, body in prepared]
            results = [f.result() for f in futures]
        wall = self.clock() - started
        out, failure, unreachable, counted = {}, None, [], 0
        for (step, prompt, _), (answer, took, error) in zip(prepared, results):      # the answers that arrived first
            if isinstance(error, llm.ModelUnavailable):
                unreachable.append((step, prompt))
                continue
            try:
                if error is not None:
                    raise error
                out[step] = self._keep(snap_id, step, prompt, answer, took)
            except llm.ModelResponseError as bad:
                self._failed(snap_id, t_ms, step, bad)
                failure = failure or qt.DecisionError(str(bad))
                failure.__cause__ = bad
                continue
            counted += 1
            self.down = 0
        self.calls += counted
        if counted:
            self.spent += wall
        for step, prompt in unreachable:                    # each counts one; asked again alone like a call in series
            self.down += 1
            if self.down >= 3:
                raise qt.ModelDown()
            try:
                out[step] = self._call(snap_id, t_ms, step, dict(missing)[step])
            except qt.DecisionError as bad:
                failure = failure or bad
        if failure is not None:
            failure.answers = {s: self._decorated(r) for s, r in out.items() if r is not None}
            raise failure
        return out

    # ---- one call

    def _request(self, body):
        """The HTTP part only (runs in a worker thread when the pair is concurrent): ``(answer, seconds, error)``; no shared
        state is touched."""
        started = time.monotonic()
        try:
            return self.provider.chat(body), time.monotonic() - started, None
        except (llm.ModelUnavailable, llm.ModelResponseError) as error:
            return None, time.monotonic() - started, error

    def _keep(self, snap_id, step, prompt, answer, took):
        """Reads a completion and saves it (calling thread only). ``ModelResponseError`` if it is not in the format."""
        result = read_completion(answer["completion"], self.temperature)
        result["latency_ms"] = int(answer.get("latency_ms") or took * 1000)
        result["prompt_hash"] = llm.prompt_hash(prompt, self.template)
        if self.store:
            with self.store.db:
                self.store.db.execute("INSERT OR REPLACE INTO exam_factors VALUES(?,?,?,?,?,?,?,?,?,?)", (
                    snap_id, step, result["text"], json.dumps(result["grads"]), json.dumps(result["detail"]),
                    result["latency_ms"], result["prompt_hash"], self.template["version"], self.model,
                    int(time.time() * 1000)))
        return result

    def _call(self, snap_id, t_ms, step, state_text):
        prompt = build_prompt(state_text, self.question)
        body = request_body(prompt, self.template)
        for _ in range(3):
            self._guard(1)
            started = self.clock()
            answer, _, error = self._request(body)
            took = self.clock() - started
            if isinstance(error, llm.ModelUnavailable):
                self.down += 1
                if self.down >= 3:
                    raise qt.ModelDown() from None
                continue
            try:
                if error is not None:
                    raise error
                result = self._keep(snap_id, step, prompt, answer, took)
            except llm.ModelResponseError as bad:
                self._failed(snap_id, t_ms, step, bad)
                raise qt.DecisionError(str(bad)) from bad
            self.down = 0
            self.calls += 1
            self.spent += took
            return result
        raise qt.ModelDown()

    def _failed(self, snap_id, t_ms, step, error):
        if self.store:
            self.store.error(snap_id, t_ms, step, 0, error.kind, str(error))


def load_photo_factors(pdb):
    """``{snap_id: {real, mirror, lectura, habito, suma, lean_num, numbers, text, text_mirror}}`` for a (read-only) database
    that has the factor tables; ``{}`` when it has none."""
    tables = {r[0] for r in pdb.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "exam_factors" not in tables:
        return {}
    numbers = {r["snap_id"]: json.loads(r["numbers_json"]) for r in pdb.db.execute("SELECT * FROM exam_ficha")} \
        if "exam_ficha" in tables else {}
    asked = {}
    for r in pdb.db.execute("SELECT snap_id, step, text, grads_json FROM exam_factors"):
        asked.setdefault(r["snap_id"], {})[r["step"]] = (json.loads(r["grads_json"]), r["text"])
    out = {}
    for snap_id, steps in asked.items():
        if "action" not in steps:
            continue
        real, text = steps["action"]
        item = {"real": real, "mirror": None, "text": text, "numbers": numbers.get(snap_id) or {}}
        if "mirror" in steps:
            item.update(photo_numbers(real, steps["mirror"][0]), text_mirror=steps["mirror"][1])
        out[snap_id] = item
    return out


def window_look(real, mirror):
    """What the live opportunity window reads off the two answers (real and mirrored STATE) of one look: the numbers the
    Terminal already shows (``lean``, ``lean_m``, ``lean_num``), the answer shaped like the letters question's (so the
    decision row keeps its schema) and the gradients of both, for the explanation. ``real`` / ``mirror``: ``FactorsDecider.ask``."""
    lean, lean_m = lean_of(real["grads"]), lean_of(mirror["grads"])
    numbers = photo_numbers(real["grads"], mirror["grads"])
    p_largo, p_corto = probabilities_for(lean)
    answer = {"probabilities": {"LARGO": p_largo, "CORTO": p_corto}, "chosen": "LARGO" if lean >= 0 else "CORTO",
              "confidence": abs(lean), "latency_ms": real.get("latency_ms", 0) + mirror.get("latency_ms", 0),
              "orders": [{"order": ["factores"], "probabilities": {"LARGO": p_largo, "CORTO": p_corto},
                          "confidence": abs(lean), "source": "factors", "latency_ms": real.get("latency_ms", 0),
                          "prompt_hash": real.get("prompt_hash")}]}
    side_m = "LARGO" if lean_m > 1e-9 else "CORTO" if lean_m < -1e-9 else "ESPERAR"
    p_m = probabilities_for(lean_m)
    return {"lean": lean, "lean_m": lean_m, "lean_num": (lean - lean_m) / 2.0, "answer": answer,
            "mirror_action": side_m, "mirror_p": p_m[0] if side_m == "LARGO" else p_m[1] if side_m == "CORTO" else 0.5,
            "factors": {"real": [round(x, 4) for x in numbers["real"]], "mirror": [round(x, 4) for x in numbers["mirror"]],
                        "lectura": [round(x, 4) for x in numbers["lectura"]]}}


def probabilities_for(lean):
    """The (p_largo, p_corto) that make ``p_largo - p_corto`` equal ``lean``: how the factor photos reach ``split_lean``."""
    return (1.0 + lean) / 2.0, (1.0 - lean) / 2.0


# --------------------------------------------------------------------------- the summary


def _pool(rows, factor):
    """The photos a line is judged on: with the mirror answer and with a number for the line. F4 is 0 when the price is inside the
    area (the line says so and the right vote is 0): only the photos outside of it count, as a vote there is the only one that can
    be wrong."""
    index = FACTORS.index(factor)
    out = []
    for r in rows:
        f = r.get("factors")
        if not f or f.get("mirror") is None:
            continue
        number = (f.get("numbers") or {}).get(factor)
        if number is None or (factor == "F4" and number == 0):
            continue
        out.append((f["real"][index], f["mirror"][index]))
    return out


def _votes(rows, factor):
    """``(share, n, base)``: the photos where the real gradient is at least ``MIN_ABS`` in absolute value, over the ``base``
    photos of the line (``_pool``). ``share`` is ``None`` without base."""
    pool = _pool(rows, factor)
    n = sum(1 for real, _ in pool if abs(real) >= MIN_ABS)
    return (n / len(pool) if pool else None), n, len(pool)


def _flips(rows, factor):
    """``(share, n)``: of the photos where the line voted, the share whose sign flips in the mirror."""
    seen = [(real, mirror) for real, mirror in _pool(rows, factor) if abs(real) >= MIN_ABS]
    flipped = [1 for real, mirror in seen if (real > 0) == (mirror < 0) and mirror != 0]
    return (len(flipped) / len(seen) if seen else None), len(seen)


def _habit(rows, factor):
    """Mean of (real + mirror) / 2 of the line over the photos with the mirror: what Qwen says whatever the numbers say."""
    index = FACTORS.index(factor)
    both = [r["factors"] for r in rows if r.get("factors") and r["factors"].get("mirror") is not None]
    return math.fsum((f["real"][index] + f["mirror"][index]) / 2 for f in both) / len(both) if both else None


def verdict_of(vote_share, vote_n, flip, corr):
    """«no vota» / «lee» / «sesgado» / «no lee» / «a medias» (or «sin dato»), with the fixed criteria and in this order:

    * «no vota»: it votes in less than 20 % of the photos or in fewer than 5;
    * «lee»: the sign flips in 80 % or more and |corr| reaches 0,5;
    * «sesgado»: |corr| reaches 0,5 but the sign flips in less than 80 % (it reads the size, the habit decides the sign);
    * «no lee»: |corr| under 0,2 or the sign flips in less than 60 %;
    * «a medias»: anything else.

    The correlation counts in absolute value: its sign says whether Qwen follows (+) or reverts (-) the number, and both are
    reading it. «sin dato» when there is no photo to judge the line on."""
    if vote_share is None:
        return "sin dato"
    if vote_share < VOTES_SHARE or vote_n < VOTES_MIN_N:
        return "no vota"
    if flip is None:
        return "sin dato"
    size = abs(corr) if corr is not None else 0.0
    if flip >= READS_FLIP and size >= READS_CORR:
        return "lee"
    if size >= READS_CORR:
        return "sesgado"
    if size < NO_READ_CORR or flip < NO_READ_FLIP:
        return "no lee"
    return "a medias"


def reading_table(rows):
    """One entry per voting factor (F1 F2 F3 F4 F6 F7): how much it votes, how much of that is the numbers, and the verdict.

    ``vote_share`` / ``vote_n``: the photos (with the mirror) where |real gradient| >= 0,25, over ``base_n``; F4 only counts the
    photos whose number is not 0 (price outside the area), and with fewer than 5 of them it has «sin dato».
    ``flip_share`` / ``flip_n``: among those that voted, the share whose sign flips in the mirror.
    ``habit``: mean of (real + mirror) / 2 over the photos with the mirror: the bias that does not depend on the data.
    ``corr`` / ``corr_n``: Spearman between the real gradient and the number of the line (F4: only photos with a number != 0)."""
    from .futures_qwen_trader_exam import spearman
    out = []
    for factor in VOTING:
        index = FACTORS.index(factor)
        vote_share, vote_n, base_n = _votes(rows, factor)
        flip, flip_n = _flips(rows, factor)
        pairs = [(r["factors"]["real"][index], r["factors"]["numbers"].get(factor)) for r in rows
                 if r.get("factors") and r["factors"]["numbers"].get(factor) is not None
                 and not (factor == "F4" and r["factors"]["numbers"][factor] == 0)]
        corr = spearman([a for a, _ in pairs], [b for _, b in pairs]) if pairs else None
        if factor == "F4" and base_n < AREA_MIN_PHOTOS:
            vote_share, verdict = None, "sin dato"          # «sin fotos fuera del área»
        else:
            verdict = verdict_of(vote_share, vote_n, flip, corr)
        out.append({"id": factor, "label": LABELS[factor], "number": NUMBER_TEXT[factor], "vote_share": vote_share,
                    "vote_n": vote_n, "base_n": base_n, "flip_share": flip, "flip_n": flip_n, "habit": _habit(rows, factor),
                    "corr": corr, "corr_n": len(pairs), "verdict": verdict})
    return out


def rule_scores(rows):
    """The rule without Qwen: the same lines with fixed reversion signs, equal weights, each one scaled to -1..1 by its range
    over the photos. A photo missing a number counts 0 for that line. ``[(row, score)]``."""
    scaled = {}
    for factor, _ in RULE_FACTORS:
        values = [r["factors"]["numbers"].get(factor) for r in rows if r["factors"]["numbers"].get(factor) is not None]
        scaled[factor] = (min(values), max(values)) if values else (0.0, 0.0)
    out = []
    for row in rows:
        total = 0.0
        for factor, sign in RULE_FACTORS:
            value, (lo, hi) = row["factors"]["numbers"].get(factor), scaled[factor]
            if value is not None and hi > lo:
                total += sign * (2 * (value - lo) / (hi - lo) - 1)
        out.append((row, total / len(RULE_FACTORS)))
    return out


def comparison(rows, horizons):
    """On the same photos (the ones with the mirror answer): Spearman with the move of Qwen's sum, of the rule without Qwen, and
    the net of always long / always short."""
    from .futures_qwen_trader_exam import mean, net, spearman
    rows = [r for r in rows if r.get("factors") and r["factors"].get("lean_num") is not None]
    rule = rule_scores(rows)
    out = []
    for h in horizons:
        moves = [r["moves"][str(h)] for r in rows]
        out.append({"horizon_min": h, "photos": len(rows),
                    "qwen_spearman": spearman([r["lean_num"] for r in rows], moves) if rows else None,
                    "rule_spearman": spearman([s for _, s in rule], moves) if rows else None,
                    "always_long_net_bp": mean([net(r, 1, h) for r in rows]),
                    "always_short_net_bp": mean([net(r, -1, h) for r in rows])})
    return out


def ficha_summary(rows, horizons):
    """The block the screen shows for a factors variant, or ``None`` when the sample has no factor photos."""
    rows = [r for r in rows if r.get("factors")]
    if not rows:
        return None
    table = reading_table(rows)
    return {"photos": sum(1 for r in rows if r["factors"].get("mirror") is not None), "readings": table,
            "reads": sum(1 for x in table if x["verdict"] == "lee"), "comparison": comparison(rows, horizons)}


def ficha_lines(summary):
    """Markdown of the same block (the exam report)."""
    from .futures_qwen_trader_exam import _bp, _h, _pct, _rho
    lines = ["## Lectura por renglón", "",
             "Votar y leer son cosas distintas. «Vota»: en qué parte de las fotos con espejo el renglón da un gradiente de al "
             "menos 0,25 en el real (entre paréntesis, cuántas fotos). «Da vuelta»: entre las que votó, en qué parte el signo "
             "se da vuelta cuando se dan vuelta los números. «Hábito»: lo que diría igual con los números del derecho o del "
             "revés (promedio de real y espejo, de -2 a +2). «Corr»: Spearman entre el gradiente y el número del renglón "
             "(cuenta el valor absoluto: positiva sigue al número, negativa lo contradice)."]
    lines.append("")
    for item in summary["readings"]:
        name = "{} {}".format(item["id"], item["label"][:1].lower() + item["label"][1:])
        if item["verdict"] == "sin dato":
            detail = "sin fotos fuera del área" if item["id"] == "F4" else "sin fotos para medirlo"
            lines.append("- {}: {} → sin dato".format(name, detail))
            continue
        lines.append("- {}: vota {} ({}) · da vuelta {} · hábito {} · corr {} ({}) → {}".format(
            name, _pct(item["vote_share"]), item["vote_n"], _pct(item["flip_share"]), _rho(item["habit"]), _rho(item["corr"]),
            item["number"], item["verdict"]))
    lines += ["", "Criterios, en este orden: «no vota» si vota en menos de {} de las fotos o en menos de {}; «lee» si da vuelta el "
              "signo en {} o más y |corr| llega a {}; «sesgado» si |corr| llega a {} pero da vuelta menos de {} (lee el tamaño, "
              "el hábito manda el signo); «no lee» si |corr| es menor a {} o da vuelta menos de {}; si no, «a medias». F4 se mide "
              "solo con las fotos que tienen el precio fuera del área de valor (hacen falta {}).".format(
                  _pct(VOTES_SHARE), VOTES_MIN_N, _pct(READS_FLIP), qt.es(READS_CORR, 1), qt.es(READS_CORR, 1), _pct(READS_FLIP),
                  qt.es(NO_READ_CORR, 1), _pct(NO_READ_FLIP), AREA_MIN_PHOTOS)]
    lines += ["", "## Contra la regla sin Qwen", "",
              "En las mismas {} fotos: la correlación (Spearman) con el movimiento del precio de la suma de Qwen, de la regla sin "
              "Qwen (F1, F2, F3, F4 y F6 con signo de reversión, pesos iguales) y lo que rinden siempre largo y siempre corto "
              "después de costos.".format(summary["photos"]), "",
              "| Plazo | Suma de Qwen | Regla sin Qwen | Siempre largo | Siempre corto |", "|---|---|---|---|---|"]
    for c in summary["comparison"]:
        lines.append("| {} | {} | {} | {} | {} |".format(_h(c["horizon_min"]), _rho(c["qwen_spearman"]), _rho(c["rule_spearman"]),
                                                         _bp(c["always_long_net_bp"]), _bp(c["always_short_net_bp"])))
    return lines + [""]


# --------------------------------------------------------------------------- real and mirror at once: is it the same answer?

PARALLEL_SAME_SHARE = 0.95          # «sirve»: the F1..F8 line is the same in at least this share of the photos...
PARALLEL_MAX_GRAD = 0.05            # ...no gradient moves by this much or more...
                                    # ...and the sign of lean_num never changes


def _sign(x):
    return 1 if x > 1e-9 else -1 if x < -1e-9 else 0


def check_parallel(db_path, cfg, provider, n, *, log=None, clock=time.monotonic):
    """Asks the real and the mirrored state of the first ``n`` photos of an exam database twice, one after the other and at
    the same time (4 calls per photo), and compares the two ways: the text of the line ``F1..F8`` (real and mirror apart), the
    16 gradients and the sign of ``lean_num``. Nothing is written: the database is opened read-only."""
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        photos = [dict(r) for r in pdb.db.execute(
            "SELECT snap_id, state_text, mirror_text FROM exam_snapshots ORDER BY ord LIMIT ?", (max(0, int(n)),))]
    finally:
        pdb.close()
    decider = FactorsDecider(provider, cfg)
    out = {"photos": len(photos), "compared": 0, "skipped": 0, "calls": 0, "same_real": 0, "same_mirror": 0, "same_both": 0,
           "max_diff": 0.0, "sum_diff": 0.0, "grads": 0, "sign_changes": 0, "seconds": 0.0}
    started = clock()
    if log:
        log("paralelo: {} fotos, 4 llamadas por foto; preguntando a Qwen… (Ctrl+C para cortar; esto no guarda nada)".format(
            len(photos)))
    for i, photo in enumerate(photos):
        texts = [photo["state_text"], photo["mirror_text"]]
        serial = decider.read_states(texts, concurrent=False)
        parallel = decider.read_states(texts, concurrent=True)
        out["calls"] += 4
        if log and (i + 1) % 10 == 0:
            log("paralelo: {} de {} fotos, {:.1f} min".format(i + 1, len(photos), (clock() - started) / 60.0))
        if None in serial or None in parallel:
            out["skipped"] += 1
            continue
        out["compared"] += 1
        same = [a["text"] == b["text"] for a, b in zip(serial, parallel)]
        out["same_real"] += int(same[0])
        out["same_mirror"] += int(same[1])
        out["same_both"] += int(all(same))
        for a, b in zip(serial, parallel):
            for x, y in zip(a["grads"], b["grads"]):
                out["max_diff"] = max(out["max_diff"], abs(x - y))
                out["sum_diff"] += abs(x - y)
                out["grads"] += 1
        lean_serial = photo_numbers(serial[0]["grads"], serial[1]["grads"])["lean_num"]
        lean_parallel = photo_numbers(parallel[0]["grads"], parallel[1]["grads"])["lean_num"]
        out["sign_changes"] += int(_sign(lean_serial) != _sign(lean_parallel))
    out["seconds"] = clock() - started
    out["mean_diff"] = out["sum_diff"] / out["grads"] if out["grads"] else 0.0
    problems = []
    if not out["compared"]:
        problems.append("no se pudo comparar ninguna foto")
    else:
        if out["same_both"] / out["compared"] < PARALLEL_SAME_SHARE:
            problems.append("el texto cambia en más de {:.0f} % de las fotos".format(100 * (1 - PARALLEL_SAME_SHARE)))
        if out["max_diff"] >= PARALLEL_MAX_GRAD:
            problems.append("un gradiente se mueve {} o más".format(_num(PARALLEL_MAX_GRAD, 2)))
        if out["sign_changes"]:
            problems.append("el signo de lean_num cambia")
    out["verdict"], out["problems"] = ("revisar" if problems else "sirve"), problems
    return out


def _num(x, places):
    return "{:.{}f}".format(x, places).replace(".", ",")


def parallel_text(r):
    """The summary of ``check_parallel`` in Spanish, five or six lines."""
    lines = ["Real y espejo a la vez contra en serie: {} fotos, {} llamadas en {} min.".format(
        r["photos"], r["calls"], _num(r["seconds"] / 60.0, 1)),
        "- Línea F1…F8 idéntica entre los dos modos: real {} de {}, espejo {} de {}; las dos en {} de {} fotos ({} %).".format(
            r["same_real"], r["compared"], r["same_mirror"], r["compared"], r["same_both"], r["compared"],
            _num(100.0 * r["same_both"] / r["compared"], 0) if r["compared"] else "0"),
        "- Los 16 gradientes: diferencia máxima {}, media absoluta {}.".format(_num(r["max_diff"], 6), _num(r["mean_diff"], 6)),
        "- Signo de lean_num: cambia en {} de {} fotos.".format(r["sign_changes"], r["compared"])]
    if r["skipped"]:
        lines.append("- Fotos salteadas por una respuesta fuera de formato: {}.".format(r["skipped"]))
    if r["verdict"] == "sirve":
        lines.append("Lectura: sirve. Mandar real y espejo juntas da lo mismo que en serie (texto idéntico en al menos {} % de "
                     "las fotos, gradientes a menos de {}, el signo de lean_num no cambia).".format(
                         _num(100 * PARALLEL_SAME_SHARE, 0), _num(PARALLEL_MAX_GRAD, 2)))
    else:
        lines.append("Lectura: revisar ({}). Hasta aclararlo, corré el examen con --sequential.".format("; ".join(r["problems"])))
    return "\n".join(lines)
