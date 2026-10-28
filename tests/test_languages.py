"""Interface locale persistence and compatibility with blindfold requests."""
import json
import subprocess

import chess
from fastapi import FastAPI
from local_test_client import TestClient
import pytest
from pydantic import ValidationError

import db
from language_preferences import LANGUAGES
import preferences_api
from training_skills import BlindfoldConfig, BlindfoldAnswer, parse_answer
from test_board_interactions import node_binary, ROOT


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'languages.sqlite3')
    db.init_db()
    application = FastAPI()
    application.include_router(preferences_api.router)
    application.dependency_overrides[preferences_api.require_user] = lambda: {'id': 1}
    with TestClient(application) as result:
        yield result


@pytest.mark.parametrize('language', LANGUAGES)
def test_language_survives_preference_reload_and_does_not_change_other_settings(client, language):
    original = client.get('/api/preferences').json()
    response = client.patch('/api/preferences', json={'language': language})
    assert response.status_code == 200, response.text
    assert response.json() == {**original, 'language': language}
    with db.get_conn() as conn:
        assert json.loads(conn.execute("SELECT value FROM preferences WHERE key='language'").fetchone()[0]) == language
    db.init_db()
    assert client.get('/api/preferences').json()['language'] == language


@pytest.mark.parametrize('language', LANGUAGES)
def test_blindfold_requests_accept_all_interface_languages_without_changing_san(language):
    assert BlindfoldConfig(language=language).language == language
    assert BlindfoldAnswer(move='g1f3', index=0, language=language).language == language
    notation = 'Cf3' if language == 'fr' else 'Nf3'
    assert parse_answer(chess.Board(), notation, language).uci() == 'g1f3'


@pytest.mark.parametrize('invalid', ['unsupported', 'zh', 'ar<script>', None, True, [], {}])
def test_unknown_language_rejects_entire_preferences_patch(client, invalid):
    before = client.get('/api/preferences').json()
    reply = client.patch('/api/preferences', json={'language': invalid, 'theme': 'sage'})
    assert reply.status_code == 400
    assert client.get('/api/preferences').json() == before
    with pytest.raises(ValidationError):
        BlindfoldConfig(language=invalid)


def test_all_locale_modules_and_layout_contracts():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/languages.mjs')],
                            capture_output=True, text=True, encoding='utf-8', timeout=30,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
