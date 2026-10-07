"""Kronos wrapper. torch/pandas and the Kronos repo are imported lazily, only when a real model is built."""

import os
import sys

CONTEXT = 400  # candles of history shown to the model (small/base accept at most 512)


class KronosSmall:
    """``expected_log_return(candles, horizon)`` -> mean over ``samples`` sampled paths of ln(close[h] / close[last])."""

    def __init__(self, repo=None, samples=8, device=None, temperature=1.0, top_p=0.9):
        repo = repo or os.environ.get("KRONOS_REPO")
        if not repo or not os.path.isdir(repo):
            raise SystemExit("Set KRONOS_REPO (or --kronos-repo) to a clone of github.com/shiyu-coder/Kronos")
        sys.path.insert(0, repo)
        import pandas  # noqa: F401
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer  # the Kronos repo's own package

        device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
        self._predictor = KronosPredictor(model, tokenizer, device=device, max_context=512)
        self.samples, self.temperature, self.top_p = samples, temperature, top_p
        self.name = "Kronos-small/Tokenizer-base"

    def expected_log_return(self, candles, horizon):
        import math

        import pandas as pd

        window = candles[-CONTEXT:]
        step = window[1]["bucket_start"] - window[0]["bucket_start"]
        frame = pd.DataFrame({
            "open": [float(c["open"]) for c in window], "high": [float(c["high"]) for c in window],
            "low": [float(c["low"]) for c in window], "close": [float(c["close"]) for c in window],
            "volume": [float(c["volume_btc"]) for c in window],
        })
        frame["amount"] = frame["volume"] * frame["close"]
        x_ts = pd.Series(pd.to_datetime([c["bucket_start"] for c in window], unit="ms"))
        last = window[-1]["bucket_start"]
        y_ts = pd.Series(pd.to_datetime([last + step * (i + 1) for i in range(horizon)], unit="ms"))
        prediction = self._predictor.predict(
            df=frame, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=horizon, T=self.temperature,
            top_p=self.top_p, sample_count=self.samples, verbose=False)
        return math.log(float(prediction["close"].iloc[-1]) / float(window[-1]["close"]))
