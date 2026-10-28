"""Run learning regressions with all data and temporary files inside a fresh sandbox."""
from pathlib import Path
import argparse
import os
import sys
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--full', action='store_true')
    parser.add_argument('tests', nargs='*')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = root / 'output' / ('learning-validation-' + uuid4().hex)
    output.mkdir(parents=True, exist_ok=False)
    temporary = output / 'temp'
    temporary.mkdir()
    os.environ['CHESSGYM_DATA_DIR'] = str(output / 'application-data')
    os.environ.pop('CHESSGYM_PUZZLE_BANK', None)
    os.environ['TMP'] = os.environ['TEMP'] = str(temporary)
    sys.path.insert(0, str(root))
    os.chdir(root)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    import pytest
    selected = args.tests or (['tests'] if args.full else [
        'tests/test_review_learning.py', 'tests/test_review_learning_programs.py',
        'tests/test_review_learning_ui.py',
        'tests/test_daily_sessions.py', 'tests/test_daily_session_quotas.py',
        'tests/test_daily_session_retirement.py', 'tests/test_review_sessions.py',
        'tests/test_review_maintenance.py', 'tests/test_learning_foundations.py',
        'tests/test_analysis_provenance.py',
    ])
    print('Isolated validation directory: ' + str(output), flush=True)
    return pytest.main(['-q', '--tb=short', '--basetemp', str(output / 'pytest'),
                       '-o', 'faulthandler_timeout=30', *selected])


if __name__ == '__main__':
    raise SystemExit(main())
