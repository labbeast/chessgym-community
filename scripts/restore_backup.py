"""Verify and restore personal data only while ChessGym is stopped."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backup_service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('--confirm', action='store_true')
    args = parser.parse_args()
    result = backup_service.restore_offline(args.archive, confirm=True) if args.confirm else backup_service.verify_archive(args.archive)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
