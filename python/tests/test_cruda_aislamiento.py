"""Issue #248 (D condition P2): nothing outside ``python/experimentos/cruda_parquet`` may import ``pyarrow`` or ``duckdb``, and the engine and the
capture never import the experiment. No dependencies: it only parses source files."""
import ast
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
EXPERIMENT = os.path.join(ROOT, "python", "experimentos", "cruda_parquet")
FORBIDDEN = {"pyarrow", "duckdb"}


def python_files():
    for base in ("python", "scripts", "server"):
        for directory, dirs, files in os.walk(os.path.join(ROOT, base)):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__", ".venv")]
            for name in files:
                if name.endswith(".py"):
                    yield os.path.join(directory, name)


def imports(path):
    with open(path, "rb") as handle:
        tree = ast.parse(handle.read(), filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split(".")[0], node.lineno
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            yield node.module.split(".")[0], node.lineno


class IsolationTests(unittest.TestCase):
    def test_only_the_experiment_may_import_pyarrow_or_duckdb(self):
        offenders = []
        for path in python_files():
            if path.startswith(EXPERIMENT + os.sep):
                continue
            for module, line in imports(path):
                if module in FORBIDDEN:
                    offenders.append("%s:%d imports %s" % (os.path.relpath(path, ROOT), line, module))
        self.assertEqual(offenders, [])

    def test_engine_and_capture_do_not_import_the_experiment(self):
        offenders = []
        for path in python_files():
            relative = os.path.relpath(path, ROOT)
            if relative.startswith(os.path.join("python", "balancita_engine")) or relative.startswith("server"):
                for module, line in imports(path):
                    if module == "experimentos":
                        offenders.append("%s:%d" % (relative, line))
        self.assertEqual(offenders, [])

    def test_the_experiment_package_runs_without_the_optional_dependencies(self):
        for name in ("corpus.py", "archivo_a.py", "derivacion.py", "confirmacion.py", "medir.py"):
            for module, _ in imports(os.path.join(EXPERIMENT, name)):
                self.assertNotIn(module, FORBIDDEN, name)

    def test_only_candidate_b_imports_pyarrow_and_never_duckdb(self):
        for name in sorted(os.listdir(EXPERIMENT)):
            if not name.endswith(".py"):
                continue
            modules = {module for module, _ in imports(os.path.join(EXPERIMENT, name))}
            self.assertNotIn("duckdb", modules, name)
            if name != "archivo_b.py":
                self.assertNotIn("pyarrow", modules, name)

    def test_no_dependency_file_lists_them(self):
        for name in ("pyproject.toml", "requirements.txt", "package.json", "pnpm-lock.yaml"):
            path = os.path.join(ROOT, name)
            if os.path.exists(path):
                with open(path, encoding="utf-8") as handle:
                    text = handle.read().lower()
                self.assertNotIn("pyarrow", text, name)
                self.assertNotIn("duckdb", text, name)


if __name__ == "__main__":
    unittest.main()
