from pathlib import Path
import shutil
import subprocess


def test_computer_workspace_recovery():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
    result = subprocess.run([node, str(root / 'tests/computer_workspace.mjs')], cwd=root,
                            capture_output=True, text=True, encoding='utf-8', timeout=20,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
