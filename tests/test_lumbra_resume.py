"""Large Lumbra imports resume committed work without publishing partial bases."""
import pytest

import db
import reference_store
from test_lumbra_resources import ELITE, PGN, isolated, source


def test_interrupted_import_resumes_checkpoint_without_reparsing_first_game(isolated, tmp_path, monkeypatch):
    second = PGN.replace('Fixture', 'Second').replace('1. e4 e5 2. Nf3 Nc6', '1. d4 d5 2. c4 e6')
    original = source(tmp_path, PGN + '\n' + second)
    real_import = reference_store.import_file
    monkeypatch.setattr(reference_store, 'import_file',
                        lambda *args, **kwargs: real_import(*args, **kwargs, max_games=1))
    with pytest.raises(ValueError, match='pas terminé'):
        isolated.install(ELITE, source_path=original)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 0
    checkpoint, = isolated.root.glob('*/**/import.sqlite3')
    assert reference_store.status(checkpoint)['game_count'] == 1
    assert not list(isolated.root.glob('.staging-*'))

    monkeypatch.setattr(reference_store, 'import_file', real_import)
    real_parse = reference_store._parse_record
    parsed = []

    def parse(*args, **kwargs):
        parsed.append(args[0])
        return real_parse(*args, **kwargs)

    monkeypatch.setattr(reference_store, '_parse_record', parse)
    installed = isolated.install(ELITE, source_path=original)
    assert installed['count'] == 2
    assert len(parsed) == 1
    assert not checkpoint.exists()
