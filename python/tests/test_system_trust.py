import ssl
import subprocess
import unittest
from types import SimpleNamespace

from balancita_engine import system_trust


class SystemTrustTests(unittest.TestCase):
    def test_no_keychain_off_macos(self):
        called = []
        self.assertEqual(system_trust.keychain_pem(run=lambda *a, **k: called.append(1), platform="linux"), "")
        self.assertEqual(called, [])

    def test_reads_keychain_on_macos(self):
        run = lambda cmd, **k: SimpleNamespace(returncode=0, stdout="PEM")
        self.assertEqual(system_trust.keychain_pem(run=run, platform="darwin"), "PEM")

    def test_failing_security_tool_adds_nothing(self):
        def boom(*a, **k):
            raise OSError("no security")
        self.assertEqual(system_trust.keychain_pem(run=boom, platform="darwin"), "")
        bad = lambda *a, **k: SimpleNamespace(returncode=1, stdout="x")
        self.assertEqual(system_trust.keychain_pem(run=bad, platform="darwin"), "")

    def test_context_keeps_verification_on(self):
        context = system_trust.build_context(pem="not a certificate")
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)


if __name__ == "__main__":
    unittest.main()
