import subprocess
from test_board_interactions import ROOT, node_binary


def test_storm_results():
    result=subprocess.run(
        [node_binary(),str(ROOT/'tests/storm_results.mjs')],
        capture_output=True,text=True,encoding='utf-8',timeout=20,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),
    )
    assert result.returncode==0,result.stderr+result.stdout
