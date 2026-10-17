"""Issue #184, PR 5a (docs/etapa-10e-camino-paper-datos-reales.md, 3.2): the paper process has no way to send a real order.

Three facts are checked, none of them by trusting a file name:

* a whole paper session (warm-up, live, orderly stop; and a funding divergence) runs in a child interpreter whose network and
  process-spawning calls are trapped BEFORE the engine is imported, and not one call reaches a trap;
* the modules that process really loads (taken from ``sys.modules`` of that child) import network or process libraries only if they
  are on an explicit list, with the reason; any other module that does so breaks this test;
* none of those modules mentions a private Kraken endpoint, a signature header or a credential variable.

The server (TypeScript) has the same inventory in ``server/src/platform/no-real-orders.test.ts``."""

import ast
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.join(os.path.dirname(HERE), "balancita_engine")

# The only engine modules the paper process loads that may import network libraries, and why. A new entry needs a reviewed reason.
NETWORK_MODULES = {
    "futures_llm_decisions": "Qwen's selector (frozen, untouched); the paper process imports it for a constant, never calls out",
}
NETWORK_LIBRARIES = {"socket", "ssl", "http", "urllib", "requests", "subprocess", "ftplib", "smtplib", "websockets", "websocket", "aiohttp", "httpx"}
FORBIDDEN_TEXT = re.compile(r"sendorder|editorder|cancelorder|batchorder|openpositions|accounts/|\bAPIKey\b|\bAuthent\b|KRAKEN_API|API_SECRET|apisecret", re.I)

CHILD = r'''
import json, os, socket, ssl, subprocess, sys, unittest

hits = []


def deny(name):
    def blocked(*args, **kwargs):
        hits.append(name)
        raise OSError("blocked by the test: " + name)
    return blocked


for owner, names in ((socket.socket, ("connect", "connect_ex")), (ssl.SSLContext, ("wrap_socket",)),
                     (socket, ("create_connection", "getaddrinfo", "gethostbyname", "gethostbyname_ex")),
                     (subprocess, ("Popen", "run", "call", "check_call", "check_output")),
                     (os, ("system", "execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe",
                           "spawnv", "spawnve", "spawnl", "spawnle", "spawnvp", "spawnlp", "posix_spawn", "posix_spawnp", "popen"))):
    for name in names:
        if hasattr(owner, name):
            setattr(owner, name, deny("{}.{}".format(getattr(owner, "__name__", owner.__class__.__name__), name)))

AUDITED = ("socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "subprocess.Popen", "os.system", "os.exec",
           "os.posix_spawn", "os.spawn")


def audit(event, args):                         # sees what the patches above cannot: C-level sockets and dynamic imports
    if event in AUDITED:
        hits.append("audit:" + event)
        raise OSError("blocked by the audit hook: " + event)


sys.addaudithook(audit)
sys.path[:0] = sys.argv[1:3]                    # only now: the engine and the test helpers are imported with the traps in place
NAMES = ["test_paper_live_process_185.TestLifecycle.test_warmup_then_live_then_an_orderly_stop_that_leaves_the_files_a_supervisor_needs",
         "test_paper_live_process_185.TestObservedLifecycle.test_a_divergence_halts_the_process_with_the_evidence_and_the_pnl_not_verified"]
result = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(unittest.defaultTestLoader.loadTestsFromNames(NAMES))
engine = sorted(m for m in sys.modules if m.startswith("balancita_engine.") and getattr(sys.modules[m], "__file__", None))
print("RESULT:" + json.dumps({"ran": result.testsRun, "ok": result.wasSuccessful(), "hits": hits, "engine": engine,
                              "problems": [str(p[1])[-300:] for p in result.errors + result.failures]}))
'''


def network_imports(path):
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read())
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names if a.name.split(".")[0] in NETWORK_LIBRARIES)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module and node.module.split(".")[0] in NETWORK_LIBRARIES:
            found.add(node.module)
    return found


class NoRealOrdersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.version_info < (3, 11):
            raise unittest.SkipTest("the engine reads its data with Python >= 3.11 (replay_data looks a library up through a subprocess the traps cut)")
        env = dict(os.environ, PYTHONPATH=os.pathsep.join([os.path.dirname(HERE), HERE]))
        done = subprocess.run([sys.executable, "-c", CHILD, os.path.dirname(HERE), HERE], env=env, capture_output=True, text=True)
        lines = [line for line in done.stdout.splitlines() if line.startswith("RESULT:")]
        if not lines:
            raise AssertionError("the child did not report: " + done.stderr[-1500:])
        cls.child = json.loads(lines[-1][len("RESULT:"):])

    def test_a_whole_session_makes_no_network_or_process_call(self):
        self.assertEqual(self.child["ran"], 2)
        self.assertTrue(self.child["ok"], self.child["problems"])
        self.assertEqual(self.child["hits"], [])

    def test_the_process_loads_engine_modules_so_the_inventory_is_not_empty(self):
        modules = self.child["engine"]
        self.assertIn("balancita_engine.paper_live_process", modules)
        self.assertGreater(len(modules), 10)

    def test_only_the_listed_modules_import_network_or_process_libraries(self):
        with_network = {}
        for module in self.child["engine"]:
            name = module.split(".", 1)[1]
            found = network_imports(os.path.join(ENGINE_DIR, name + ".py"))
            if found:
                with_network[name] = sorted(found)
        self.assertEqual(sorted(with_network), sorted(NETWORK_MODULES), with_network)

    def test_no_loaded_module_names_a_private_endpoint_a_signature_header_or_a_credential(self):
        for module in self.child["engine"]:
            name = module.split(".", 1)[1]
            with open(os.path.join(ENGINE_DIR, name + ".py"), encoding="utf-8") as handle:
                self.assertIsNone(FORBIDDEN_TEXT.search(handle.read()), name)

    def test_the_configuration_is_a_closed_schema_so_no_order_key_can_be_added(self):
        sys.path[:0] = [os.path.dirname(HERE), HERE]
        from balancita_engine import paper_live_process as LP
        from test_paper_live_process_185 import config_dict
        for key in ("api_key", "api_secret", "send_order", "order_endpoint", "private_base_url"):
            with self.assertRaises(LP.ProcessError) as caught:
                LP.validate_config(config_dict(**{key: "x"}))
            self.assertEqual(caught.exception.reason, "config_invalid", key)


if __name__ == "__main__":
    unittest.main()
