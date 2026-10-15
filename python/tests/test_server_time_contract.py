"""Server-time contract between the TypeScript store and the Python adapter (synthetic strings only; no real data).

Context (#183, stage 2 repeat): 3 stored funding responses came back ``server_time_invalid``. The store
(``historical-funding.ts``) accepts any string ``Date.parse`` understands and saves it verbatim; the adapter
(``funding_adapter._ms``) accepts only ISO strings ending in ``Z``. This table documents both sides for the same strings, so a
contradiction in the data can be told apart from a contract gap without reading the database again. It changes no behaviour.
``JS_ACCEPTS`` was produced with ``Number.isFinite(Date.parse(s))`` on Node 22 and is copied here as fixed data.
"""
import unittest

from balancita_engine import funding_adapter as FA

# string -> accepted by the TypeScript store (Date.parse finite)
JS_ACCEPTS = {
    "2026-10-11T19:00:00Z": True,
    "2026-10-11T19:00:00.316Z": True,
    "2026-10-11T19:00:00.3Z": True,
    "2026-10-11T19:00:00.316123456Z": True,
    "2026-10-11T19:00:00+00:00": True,
    "2026-10-11T19:00:00.316+00:00": True,
    "2026-10-11T19:00:00": True,                      # JS reads a no-offset datetime as LOCAL time
    "2026-10-11": True,
    "Sat, 11 Oct 2026 19:00:00 GMT": True,
    "2026-10-11 19:00:00Z": True,
    "1791745200316": False,
}
# the strings the adapter must accept today, with the instant (ms) it must return
PY_ACCEPTS = {
    "2026-10-11T19:00:00Z": 1791745200000,
    "2026-10-11T19:00:00.316Z": 1791745200316,
    "2026-10-11T19:00:00.3Z": 1791745200300,
    "2026-10-11T19:00:00.316123456Z": 1791745200316,
    "2026-10-11 19:00:00Z": 1791745200000,
}


class ServerTimeContractTests(unittest.TestCase):
    def test_adapter_accepts_exactly_the_documented_z_forms(self):
        for text, expected in PY_ACCEPTS.items():
            self.assertEqual(FA._ms(text), expected, text)

    def test_strings_the_store_would_save_but_the_adapter_rejects(self):
        gap = [s for s, js in JS_ACCEPTS.items() if js and s not in PY_ACCEPTS]
        self.assertEqual(sorted(gap), sorted([
            "2026-10-11", "2026-10-11T19:00:00", "2026-10-11T19:00:00+00:00",
            "2026-10-11T19:00:00.316+00:00", "Sat, 11 Oct 2026 19:00:00 GMT"]))
        for text in gap:
            with self.assertRaises(ValueError) as caught:
                FA._ms(text)
            self.assertEqual(str(caught.exception), "timestamp_not_utc", text)

    def test_a_whole_response_with_such_a_server_time_is_rejected_as_server_time_invalid(self):
        for text in ("2026-10-11T19:00:00+00:00", "2026-10-11T19:00:00", "Sat, 11 Oct 2026 19:00:00 GMT"):
            raw = '{"result":"success","serverTime":"%s","rates":[]}' % text
            with self.assertRaises(FA.FundingAdapterError) as caught:
                FA.parse_response(raw, "PF_XBTUSD", 1791745200000, strict=False)
            self.assertEqual(caught.exception.reason, "server_time_invalid", text)

    def test_the_inner_cause_is_only_in_the_exception_message(self):
        raw = '{"result":"success","serverTime":"2026-10-11T19:00:00+00:00","rates":[]}'
        with self.assertRaises(FA.FundingAdapterError) as caught:
            FA.parse_response(raw, "PF_XBTUSD", 1791745200000, strict=False)
        self.assertEqual(caught.exception.reason, "server_time_invalid")
        self.assertEqual(str(caught.exception), "server_time_invalid: timestamp_not_utc")   # detail only in the message


if __name__ == "__main__":
    unittest.main()
