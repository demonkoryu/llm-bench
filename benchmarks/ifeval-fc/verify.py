#!/usr/bin/env python3
"""Grade IFEval-FC argument values with UPSTREAM's checkers.

Reads one JSON object per line on stdin: {"case_id", "checker", "args", "description", "value"}.
Writes one JSON object per line on stdout: {"case_id", "ok", "error"}.

WHY A PYTHON SUBPROCESS AND NOT A JS REIMPLEMENTATION. Same split as benches/swe_live.mjs, for the
same reason: the grader is not ours. Checkers like SentenceCountChecker and NAllCapitalWordsChecker
carry semantics -- what counts as a word, where a sentence ends, which markdown spans count as
highlighted -- that a reimplementation from their prose descriptions would plausibly get subtly
wrong. A subtly wrong grader is worse than a missing one, because it still produces a number and
nothing about that number looks wrong. Upstream's own test suite runs against the vendored copy, so
a semantics drift shows up as a failing test rather than as a quietly shifted score.

BATCHED over stdin rather than one process per case: 150 cases x 23 passes is 3,450 gradings, and
interpreter startup would dominate a check that takes microseconds.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "vendor"))

from IFEval_FC.checkers import get_all_checkers  # noqa: E402

BY_NAME = {c.__name__: c for c in get_all_checkers()}


def grade(rec):
    name = rec.get("checker")
    cls = BY_NAME.get(name)
    if cls is None:
        return {"case_id": rec.get("case_id"), "ok": False, "error": f"unknown checker {name!r}"}
    value = rec.get("value")
    # Upstream scores a non-string argument as a format failure rather than an error: the parameter
    # was supposed to be a string carrying the format, so a number or an object is simply wrong.
    if not isinstance(value, str):
        return {"case_id": rec.get("case_id"), "ok": False, "error": f"value is {type(value).__name__}, not str"}
    try:
        checker = cls()
        # Mirrors upstream evaluate.py: instantiate, then overwrite the sampled state with this
        # case's pinned arguments and description. The constructor samples random arguments, so
        # skipping this would grade against a different constraint than the model was shown.
        checker.arguments = rec.get("args") or {}
        checker.description = rec.get("description") or ""
        return {"case_id": rec.get("case_id"), "ok": bool(checker.check_following(value)), "error": None}
    except Exception as e:  # a checker that raises is a failed case, not a crashed run
        return {"case_id": rec.get("case_id"), "ok": False, "error": f"{type(e).__name__}: {e}"[:200]}


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            out.write(json.dumps({"case_id": None, "ok": False, "error": f"bad input line: {e}"}) + "\n")
            continue
        out.write(json.dumps(grade(rec)) + "\n")
    out.flush()


if __name__ == "__main__":
    main()
