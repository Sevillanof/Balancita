"""El adaptador LoRA de mlx-lm, convertido al GGUF que llama-server carga con ``--lora`` (hilo «Entrenar a Qwen con LoRA»).

mlx-lm guarda ``adapters.safetensors`` con, por capa lineal ``model.layers.N.<proy>``, dos tensores: ``lora_a`` de forma
``(entrada, rango)`` y ``lora_b`` de forma ``(rango, salida)``, y aplica ``y = W x + escala · (x · lora_a) · lora_b``
(``adapter_config.json`` -> ``lora_parameters.scale``, 20 por defecto). llama.cpp espera, por tensor base ``blk.N.<nombre>.weight``,
``.lora_a`` de forma ``(rango, entrada)`` y ``.lora_b`` de forma ``(salida, rango)`` (la orientación de PEFT, que
``convert_lora_to_gguf.py`` escribe sin trasponer), y aplica ``alpha / rango`` como escala. Aquí la escala de mlx se incorpora a
``lora_b`` y ``adapter.lora.alpha`` se fija igual al rango, así llama.cpp aplica exactamente ``escala · B · A`` (por 1,0 del
pedido). Nombres: ``gguf.get_tensor_name_map`` de la arquitectura ``qwen3``.

Solo numpy para el cálculo; ``gguf`` (pip install gguf) y ``safetensors`` para leer y escribir archivos. No descarga nada.
Uso: ``python -m balancita_engine.futures_qwen_lora_adapter <carpeta_adapters> <salida.gguf> [--arch qwen3]``.
"""

import argparse
import json
import os
import re

LAYER = re.compile(r"^model\.layers\.(\d+)\.(.+)\.lora_([ab])$")


def pairs(tensors):
    """``{module: (lora_a, lora_b)}`` out of mlx-lm's flat ``{name: array}``; raises on a lone half."""
    out = {}
    for name in tensors:
        match = LAYER.match(name)
        if match is None:
            raise ValueError("tensor del adaptador que no se entiende: {!r}".format(name))
        module = "model.layers.{}.{}".format(match.group(1), match.group(2))
        out.setdefault(module, {})[match.group(3)] = tensors[name]
    for module, halves in out.items():
        if set(halves) != {"a", "b"}:
            raise ValueError("{}: falta lora_a o lora_b".format(module))
    return {m: (h["a"], h["b"]) for m, h in out.items()}


def to_llama(lora_a, lora_b, scale):
    """mlx ``(in, r)``, ``(r, out)`` with ``scale`` -> llama.cpp ``(r, in)``, ``(out, r)`` with the scale inside ``lora_b``."""
    import numpy as np
    a = np.ascontiguousarray(np.asarray(lora_a, dtype=np.float32).T)
    b = np.ascontiguousarray(np.asarray(lora_b, dtype=np.float32).T * float(scale))
    if a.shape[0] != b.shape[1]:
        raise ValueError("rango distinto en lora_a {} y lora_b {}".format(a.shape, b.shape))
    return a, b


def delta(lora_a, lora_b, scale):
    """``W_delta`` (out, in) exactly as mlx-lm's ``fuse`` adds it: ``scale · lora_b.T @ lora_a.T``."""
    import numpy as np
    return float(scale) * np.asarray(lora_b, dtype=np.float32).T @ np.asarray(lora_a, dtype=np.float32).T


def n_layers(modules):
    return 1 + max(int(LAYER.match(m + ".lora_a").group(1)) for m in modules)


def convert(adapter_dir, out_path, arch="qwen3", log=print):
    """Writes ``out_path``; returns ``{tensors, rank, scale, alpha}``."""
    import gguf
    import numpy as np
    from safetensors.numpy import load_file
    with open(os.path.join(adapter_dir, "adapter_config.json"), encoding="utf-8") as handle:
        params = json.load(handle)["lora_parameters"]
    rank, scale = int(params["rank"]), float(params.get("scale", 20.0))
    tensors = load_file(os.path.join(adapter_dir, "adapters.safetensors"))
    modules = pairs(tensors)
    names = gguf.get_tensor_name_map(getattr(gguf.MODEL_ARCH, arch.upper()), n_layers(modules))
    writer = gguf.GGUFWriter(out_path, arch)
    writer.add_type(gguf.GGUFType.ADAPTER)
    writer.add_string(gguf.Keys.Adapter.TYPE, "lora")
    writer.add_float32(gguf.Keys.Adapter.LORA_ALPHA, float(rank))     # alpha / rank = 1: the mlx scale is already in lora_b
    count = 0
    for module in sorted(modules, key=lambda m: (int(LAYER.match(m + ".lora_a").group(1)), m)):
        base = names.get_name(module + ".weight", try_suffixes=(".weight",))
        if base is None:
            raise ValueError("{}: no tiene tensor en la arquitectura {}".format(module, arch))
        a, b = to_llama(*modules[module], scale)
        if a.shape[0] != rank:
            raise ValueError("{}: rango {} y la config dice {}".format(module, a.shape[0], rank))
        writer.add_tensor(base + ".lora_a", a.astype(np.float32))
        writer.add_tensor(base + ".lora_b", b.astype(np.float32))
        count += 2
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    log("adaptador: {} tensores de {} capas lineales, rango {}, escala {} -> {} ({:.1f} MB)".format(
        count, len(modules), rank, scale, out_path, os.path.getsize(out_path) / 1e6))
    return {"tensors": count, "rank": rank, "scale": scale, "alpha": float(rank)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("adapter_dir", help="carpeta con adapters.safetensors y adapter_config.json (mlx-lm)")
    parser.add_argument("out", help="archivo .gguf a escribir")
    parser.add_argument("--arch", default="qwen3")
    args = parser.parse_args(argv)
    convert(args.adapter_dir, args.out, args.arch)


if __name__ == "__main__":
    main()
