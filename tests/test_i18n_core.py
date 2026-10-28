"""The translation core changes UI literals and leaves dynamic values untouched."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    'static_html_fragments_translate_text_and_preserve_markup',
    'whitelisted_attributes_translate_even_without_angle_brackets',
    'whitespace_and_unknown_text_are_preserved',
    'interpolated_values_are_not_translated_or_interpreted_recursively',
    'french_roundtrip_returns_original_literals',
    'invalid_language_falls_back_to_french_and_updates_preferences',
])
def test_i18n_core(scenario):
    result=subprocess.run([node_binary(),str(ROOT/'tests/i18n_core.mjs'),scenario],
                          capture_output=True,text=True,encoding='utf-8',timeout=15,
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0,result.stdout+result.stderr

