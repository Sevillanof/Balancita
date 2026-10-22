"""HTTPS that trusts the certificates the operating system already trusts, with verification fully ON.

On a Mac behind a company proxy that re-signs HTTPS, the proxy's root certificate lives in the macOS keychain
(``System.keychain``) but not in the file Python's OpenSSL reads, so every request to Kraken fails with
``CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain``. ``install()`` adds the keychain's
certificates to the default context used by ``urllib.request.urlopen``; it never turns verification off.
Other systems, and a Mac whose keychain cannot be read, keep Python's defaults.
"""

import ssl
import subprocess
import sys
import urllib.request

KEYCHAINS = ("/Library/Keychains/System.keychain",)
_installed = False


def keychain_pem(run=subprocess.run, platform=None):
    """The certificates of the macOS system keychain as PEM text, or ``""`` when there is nothing to add."""
    if (platform or sys.platform) != "darwin":
        return ""
    try:
        done = run(["/usr/bin/security", "find-certificate", "-a", "-p", *KEYCHAINS],
                   capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def build_context(pem=None):
    """Python's default verifying context plus the extra trusted certificates (``pem``, else the keychain's)."""
    context = ssl.create_default_context()
    extra = keychain_pem() if pem is None else pem
    if extra.strip():
        try:
            context.load_verify_locations(cadata=extra)
        except ssl.SSLError:
            pass  # a malformed export: keep the defaults rather than fail
    return context


def install():
    """Make ``urllib.request.urlopen`` use :func:`build_context`. Safe to call many times; a no-op off macOS."""
    global _installed
    if _installed or sys.platform != "darwin":
        return
    _installed = True
    handler = urllib.request.HTTPSHandler(context=build_context())
    urllib.request.install_opener(urllib.request.build_opener(handler))
