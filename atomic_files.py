"""Atomic replacement with a short tolerance for Windows reader/file-scan locks."""
from pathlib import Path
import time


def replace_with_retry(source, target, *, retry_seconds=2.0):
    """Keep the old destination intact if a transient lock does not clear.

    Only PermissionError is retried. The caller owns temporary-file cleanup;
    every attempt remains an atomic replacement of the same prepared file.
    """
    source = Path(source)
    deadline = time.monotonic() + retry_seconds
    delay = .025
    while True:
        try:
            return source.replace(target)
        except PermissionError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(delay, remaining))
            delay = min(delay * 2, .25)
