"""Saved training blocks pass a durable Review/Learn choice to their sessions."""
from uuid import uuid4

import pytest
from fastapi import HTTPException

import db
import training
import training_native_options
import review_sessions as sessions
from test_training_programs import client, block, program, activate, run, request


@pytest.mark.parametrize('selection', ['review', 'learn', 'both'])
def test_program_choice_survives_save_launch_and_resume(client, selection):
    week = activate(client, program(client, [block(options={'selection': selection})]))
    execution = run(client, week)
    assert execution['launch']['options']['selection'] == selection
    if selection == 'review':
        training.queue(1)
        with db.get_conn() as conn:
            conn.execute("UPDATE review_cards SET state='learning',due='2000-01-01T00:00:00+00:00',repetitions=1")
    session = sessions.create_daily(sessions.CreateDailySession(base_ids=[1], selection=selection,
        request_id=uuid4(), training_run_id=execution['id']))
    assert session['selection'] == selection and session['total'] == 1
    saved = request(client, 'GET', '/runs/' + execution['id'])
    assert saved['native_ref']['id'] == session['session_id']


def test_legacy_block_without_options_defaults_to_both(client):
    execution = run(client, activate(client, program(client)))
    session = sessions.create_daily(sessions.CreateDailySession(base_ids=[1], request_id=uuid4(), training_run_id=execution['id']))
    assert session['selection'] == 'both' and session['total'] == 1


def test_client_cannot_override_a_saved_block_selection(client):
    execution = run(client, activate(client, program(client, [block(options={'selection':'learn'})])))
    with pytest.raises(HTTPException) as error:
        sessions.create_daily(sessions.CreateDailySession(base_ids=[1], selection='both', request_id=uuid4(), training_run_id=execution['id']))
    assert error.value.status_code == 409
    assert request(client, 'GET', '/runs/' + execution['id'])['native_ref'] is None


@pytest.mark.parametrize('value', [{'selection':'free'}, {'all':True}, {'selection':False}])
def test_program_rejects_invalid_review_options(value):
    with pytest.raises(HTTPException) as error:
        training_native_options.checked('review', value)
    assert error.value.status_code == 422
