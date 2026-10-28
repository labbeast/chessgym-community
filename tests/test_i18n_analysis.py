"""Analysis labels change language without translating chess content or names."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    'moves_and_pgn_data_are_never_translated',
    'explorer_filters_and_user_database_names_are_separate',
    'numeric_displays_follow_the_language',
    'position_results_preserve_players_and_titles',
    'repertoire_status_and_validation_translate',
    'menu_labels_change_without_reloading_modules',
])
def test_analysis_languages(scenario):
    result=subprocess.run([node_binary(),str(ROOT/'tests/i18n_analysis.mjs'),scenario],
                          capture_output=True,text=True,encoding='utf-8',timeout=15,
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0,result.stdout+result.stderr

