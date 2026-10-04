"""JSON stdin/stdout adapter for the existing deterministic replay function."""

import json
import sys

from balancita_replay import run_replay


def main(input_stream=None, output_stream=None):
    input_stream = input_stream or sys.stdin
    output_stream = output_stream or sys.stdout
    options = json.load(input_stream)
    result = run_replay(options)
    json.dump(result, output_stream, allow_nan=False, separators=(",", ":"))
    output_stream.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write("{}: {}\n".format(type(error).__name__, error))
        sys.exit(1)
