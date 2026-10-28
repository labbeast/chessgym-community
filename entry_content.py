"""Canonical saved-content identity shared by history and catalog summaries."""
import hashlib
import json


def content_snapshot(row):
    return {key: row[key] for key in ('title', 'pgn', 'start_path')}



def entry_revision(row):
    """Detect PGN changes from every writer, including repertoire extension."""
    return hashlib.sha256(json.dumps(content_snapshot(row), ensure_ascii=False,
                                    sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()

