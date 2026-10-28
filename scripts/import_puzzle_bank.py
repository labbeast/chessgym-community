"""Import the public Lichess puzzle CSV into the separate ChessGym bank."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import puzzle_store

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--batch-size', type=int, default=5000)
    parser.add_argument('--max-puzzles', type=int)
    parser.add_argument('--cache-mb', type=int, default=256, help='Importer SQLite cache in MiB (16–1024; default 256)')
    options = parser.parse_args()
    print(json.dumps(puzzle_store.import_bank(options.source,options.batch_size,options.max_puzzles,
        progress=lambda state: print(json.dumps(state),flush=True),cache_mb=options.cache_mb)),flush=True)
