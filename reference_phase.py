"""Small best-effort import diagnostics, never a source of resume checkpoints."""
import json
import os
from pathlib import Path
import time

PHASES = {'preparing', 'replaying', 'processing', 'committing', 'finalizing', 'finished'}
MAX_BYTES = 64 * 1024
FIELDS = {'status', 'imported', 'processed', 'duplicates', 'rejected', 'bytes_read',
          'total_bytes', 'source', 'game_count', 'indexed_positions', 'error',
          'limit_reached', 'encoding', 'workers', 'cache_mib', 'sort_positions',
          'updated_at', 'started_at', 'rejections'}


def phase_path(store):
    return Path(store).with_suffix('.phase.json')


def read(store, run_id, source, started_ns=0):
    if not run_id:
        return None
    path = phase_path(store)
    try:
        with path.open('rb') as handle:
            stat = os.fstat(handle.fileno())
            if stat.st_size > MAX_BYTES or stat.st_mtime_ns + 2_000_000_000 < started_ns:
                return None
            data = json.loads(handle.read(MAX_BYTES + 1))
        if (not isinstance(data, dict) or data.get('version') != 1 or data.get('run_id') != run_id
                or data.get('source') != str(Path(source).resolve())
                or data.get('phase') not in PHASES or not isinstance(data.get('snapshot'), dict)
                or type(data.get('updated_ns')) is not int or data['updated_ns'] < started_ns
                or data['updated_ns'] > time.time_ns() + 60_000_000_000):
            return None
        return data
    except (OSError, ValueError, TypeError, RecursionError):
        return None


class Publisher:
    def __init__(self, store, run_id, source, initial=None):
        self.store, self.run_id, self.source = store, run_id, str(Path(source).resolve())
        previous = read(store, run_id, source)
        self.snapshot = dict(initial if initial is not None else previous['snapshot'] if previous else {})

    def publish(self, phase, snapshot=None):
        if snapshot is not None:
            self.snapshot = {key: value for key, value in snapshot.items() if key in FIELDS}
        # Initial setup has no committed snapshot yet: retain the launcher's
        # baseline. Diagnostics must never fail an otherwise valid transaction.
        payload = {'version': 1, 'run_id': self.run_id, 'source': self.source,
                   'phase': phase, 'updated_ns': time.time_ns(), 'snapshot': self.snapshot}
        path = phase_path(self.store)
        temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
        try:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if len(encoded) > MAX_BYTES:
                return False
            temporary.write_bytes(encoded)
            os.replace(temporary, path)
            return True
        except (OSError, ValueError, TypeError):
            return False
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
