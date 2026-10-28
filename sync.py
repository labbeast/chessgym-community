"""Account connections and lossless import of finished public games."""
from datetime import datetime, timezone
import io
import json
import sqlite3
import time

import chess
import chess.pgn
from fastapi import APIRouter, HTTPException

import db
import pgnlib
import sync_remote

router = APIRouter(prefix='/api/sync')
DEFAULTS = {'enabled': True, 'auto_sync': False, 'auto_analyse': True,
            'max_games': 100, 'lookback_days': 90, 'interval_minutes': 15}
FIELDS = {'site', 'username', 'base_id', *DEFAULTS}


def _now():
    return datetime.now(timezone.utc).isoformat()


def init_sync():
    with db.get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS sync_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site TEXT NOT NULL, username TEXT NOT NULL,
            base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 1, auto_sync INTEGER NOT NULL DEFAULT 0,
            auto_analyse INTEGER NOT NULL DEFAULT 1,
            max_games INTEGER NOT NULL DEFAULT 100, lookback_days INTEGER NOT NULL DEFAULT 90,
            interval_minutes INTEGER NOT NULL DEFAULT 15,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            last_sync_at TEXT, last_attempt_at TEXT, last_error TEXT,
            last_result TEXT, UNIQUE(site,username,base_id)
        );
        CREATE TABLE IF NOT EXISTS sync_imports (
            base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
            site TEXT NOT NULL, remote_id TEXT NOT NULL,
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            imported_at TEXT NOT NULL,
            needs_analysis INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(base_id,site,remote_id)
        );
        CREATE INDEX IF NOT EXISTS sync_imports_by_entry ON sync_imports(entry_id);
        ''')
        if 'needs_analysis' not in {row['name'] for row in conn.execute('PRAGMA table_info(sync_imports)')}:
            conn.execute('ALTER TABLE sync_imports ADD COLUMN needs_analysis INTEGER NOT NULL DEFAULT 0')


def _account(row):
    result = dict(row)
    for key in ('enabled', 'auto_sync', 'auto_analyse'):
        result[key] = bool(result[key])
    result['last_result'] = json.loads(result['last_result']) if result.get('last_result') else None
    return result


def _get(conn, identifier):
    row = conn.execute('SELECT sync_accounts.*,bases.name AS base_name FROM sync_accounts JOIN bases ON bases.id=base_id WHERE sync_accounts.id=?', (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Cette connexion n’existe plus.')
    return _account(row)


def _validate(payload, old=None):
    if not isinstance(payload, dict) or set(payload) - FIELDS:
        raise ValueError('Paramètres de synchronisation inconnus.')
    values = {**DEFAULTS, **({key: old[key] for key in FIELDS} if old else {}), **payload}
    values['username'] = sync_remote.validate_identity(values.get('site'), values.get('username'))
    if type(values.get('base_id')) is not int or values['base_id'] < 1:
        raise ValueError('Choisis une base de destination.')
    for key in ('enabled', 'auto_sync', 'auto_analyse'):
        if type(values[key]) is not bool:
            raise ValueError('Les options de synchronisation doivent être activées ou désactivées.')
    for key, low, high in (('max_games', 1, 500), ('lookback_days', 1, 365), ('interval_minutes', 15, 1440)):
        if type(values[key]) is not int or not low <= values[key] <= high:
            raise ValueError(f'{key} doit être compris entre {low} et {high}.')
    return values


def _mark_played(conn, base_id):
    import reference_library
    reference_library.require_study_base(conn, base_id)
    row = conn.execute('SELECT settings FROM bases WHERE id=?', (base_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Cette base n’existe plus.')
    settings = json.loads(row['settings'])
    settings['played'] = True
    conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps(settings, ensure_ascii=False), base_id))


@router.get('')
def list_accounts():
    with db.get_conn() as conn:
        rows = conn.execute('SELECT sync_accounts.*,bases.name AS base_name FROM sync_accounts JOIN bases ON bases.id=base_id ORDER BY sync_accounts.id').fetchall()
    return {'accounts': [_account(row) for row in rows]}


@router.post('/accounts')
def create_account(payload: dict):
    values = _validate(payload)
    stamp = _now()
    try:
        with db.get_conn() as conn:
            if conn.execute('SELECT count(*) FROM sync_accounts').fetchone()[0] >= 20:
                raise ValueError('Limite de 20 connexions atteinte.')
            _mark_played(conn, values['base_id'])
            names = list(values)
            cur = conn.execute(f'INSERT INTO sync_accounts({",".join(names)},created_at,updated_at) VALUES({",".join("?" for _ in names)},?,?)', [values[name] for name in names] + [stamp, stamp])
            return _get(conn, cur.lastrowid)
    except sqlite3.IntegrityError as exc:
        raise ValueError('Ce compte est déjà connecté à cette base.') from exc


@router.patch('/accounts/{account_id}')
def update_account(account_id: int, payload: dict):
    try:
        with db.get_conn() as conn:
            old = _get(conn, account_id)
            values = _validate(payload, old)
            _mark_played(conn, values['base_id'])
            changed = any(values[key] != old[key] for key in ('site', 'username', 'base_id'))
            names = list(values)
            conn.execute(f'UPDATE sync_accounts SET {",".join(name+"=?" for name in names)},updated_at=? WHERE id=?', [values[name] for name in names] + [_now(), account_id])
            if changed:
                conn.execute('UPDATE sync_accounts SET last_sync_at=NULL,last_attempt_at=NULL,last_error=NULL,last_result=NULL WHERE id=?', (account_id,))
            return _get(conn, account_id)
    except sqlite3.IntegrityError as exc:
        raise ValueError('Ce compte est déjà connecté à cette base.') from exc


@router.delete('/accounts/{account_id}')
def delete_account(account_id: int):
    with db.get_conn() as conn:
        _get(conn, account_id)
        conn.execute('DELETE FROM sync_accounts WHERE id=?', (account_id,))
    return {'deleted': True}


def _queue(account):
    import jobs
    if not account['enabled']:
        raise ValueError('Active cette connexion avant de synchroniser.')
    return jobs.enqueue('sync', {'account_id': account['id']}, dedupe_key=f"sync:{account['id']}")


@router.post('/accounts/{account_id}/run')
def run_account(account_id: int, payload: dict):
    if payload:
        raise ValueError('Cette action ne nécessite aucun paramètre.')
    with db.get_conn() as conn:
        account = _get(conn, account_id)
    return {'job': _queue(account)}


@router.post('/run')
def run_all(payload: dict):
    if payload:
        raise ValueError('Cette action ne nécessite aucun paramètre.')
    return {'jobs': [_queue(account) for account in list_accounts()['accounts'] if account['enabled']]}


def schedule_due():
    """Called by the worker; only queue opted-in connections, never download here."""
    queued = []
    for account in list_accounts()['accounts']:
        if not account['enabled'] or not account['auto_sync']:
            continue
        attempt = account['last_attempt_at']
        try:
            recent = datetime.fromisoformat(attempt).timestamp() if attempt else 0
        except (ValueError, TypeError):
            recent = 0
        if time.time() - recent >= account['interval_minutes'] * 60:
            queued.append(_queue(account))
    return queued


def _identity(account):
    return tuple(account[key] for key in ('site', 'username', 'base_id', 'updated_at'))


def _check_current(conn, account):
    import jobs
    try:
        current = _get(conn, account['id'])
    except HTTPException as exc:
        raise jobs.JobCancelled('La connexion a été supprimée.') from exc
    if not current['enabled'] or _identity(current) != _identity(account):
        raise jobs.JobCancelled('La connexion a été modifiée. Relance la synchronisation.')


def _existing_links(conn, base_id, site):
    """Recognize prior manual imports without reparsing their complete move tree."""
    found = {}
    for row in conn.execute('SELECT id,pgn FROM entries WHERE base_id=? ORDER BY id', (base_id,)):
        try:
            headers = chess.pgn.read_headers(io.StringIO(row['pgn']))
        except (ValueError, TypeError):
            continue
        # Exercises retain the source Site/Link for attribution, but they are
        # separate positions and must never replace the complete played game.
        if headers and ('SourceEntry' in headers or 'SourcePly' in headers):
            continue
        for key in ('Site', 'Link'):
            remote_id = sync_remote.game_id(site, headers.get(key)) if headers else None
            if remote_id:
                found.setdefault(remote_id, row['id'])
    return found


def _valid_game(record, account):
    if not isinstance(record, dict) or not record.get('standard') or not record.get('finished'):
        return None
    remote_id = record.get('remote_id')
    if not isinstance(remote_id, str) or not remote_id:
        return None
    try:
        if sync_remote.game_id(account['site'], sync_remote.canonical_url(account['site'], remote_id)) != remote_id:
            return None
    except (ValueError, TypeError):
        return None
    text = record.get('pgn')
    if not isinstance(text, str) or len(text.encode('utf-8')) > 1024 * 1024:
        return None
    try:
        game = pgnlib.load_game(text)
    except (ValueError, TypeError, RecursionError):
        return None
    if game.headers.get('Result') not in ('1-0', '0-1', '1/2-1/2') or not game.variations:
        return None
    if account['username'] not in (game.headers.get('White', '').lower(), game.headers.get('Black', '').lower()):
        return None
    # Preserve all upstream tags and comments; add a stable link only if absent.
    if not any(sync_remote.game_id(account['site'], game.headers.get(key)) == remote_id for key in ('Site', 'Link')):
        game.headers['Link'] = sync_remote.canonical_url(account['site'], remote_id)
    return game


def _drain_analysis(ctx, account, summary, attempted):
    """Durable outbox: retry interrupted/failed enqueue after any server restart.

    Only new automatically imported games are marked. Linking manual PGNs never
    triggers analysis. Queue deduplication makes replay after a crash harmless.
    """
    if not account['auto_analyse']:
        return
    import game_analysis
    with db.get_conn() as conn:
        _check_current(conn, account)
        pending = conn.execute('SELECT entry_id FROM sync_imports WHERE base_id=? AND site=? AND needs_analysis=1', (account['base_id'], account['site'])).fetchall()
    for row in pending:
        entry_id = row['entry_id']
        if entry_id in attempted:
            continue
        attempted.add(entry_id)
        ctx.check_cancelled()
        with db.get_conn() as conn:
            _check_current(conn, account)
        try:
            game_analysis.queue_analysis(entry_id)
        except (HTTPException, ValueError):
            summary['analysis_skipped'] += 1
            continue
        with db.get_conn() as conn:
            conn.execute('UPDATE sync_imports SET needs_analysis=0 WHERE base_id=? AND site=? AND entry_id=?', (account['base_id'], account['site'], entry_id))
        summary['analysis_queued'] += 1


def sync_account(ctx, payload):
    """Background handler. Each imported game commits atomically with its identity."""
    if not isinstance(payload, dict) or type(payload.get('account_id')) is not int:
        raise ValueError('Connexion de synchronisation invalide.')
    with db.get_conn() as conn:
        account = _get(conn, payload['account_id'])
        _check_current(conn, account)
        conn.execute('UPDATE sync_accounts SET last_attempt_at=?,last_error=NULL WHERE id=?', (_now(), account['id']))
    summary = {'downloaded': 0, 'imported': 0, 'duplicates': 0, 'linked': 0, 'skipped': 0, 'analysis_queued': 0, 'analysis_skipped': 0, 'entry_ids': [], 'limit_reached': False}
    attempted = set()
    try:
        ctx.check_cancelled()
        _drain_analysis(ctx, account, summary, attempted)
        ctx.progress(0, 0, 'Téléchargement des parties publiques…')
        downloaded = sync_remote.download_games(account['site'], account['username'], since=time.time() - account['lookback_days'] * 86400, max_games=account['max_games'], check_cancelled=ctx.check_cancelled)
        records = downloaded['games']
        summary.update(downloaded=len(records), limit_reached=bool(downloaded.get('limit_reached')),
                       partial=bool(downloaded.get('partial')),
                       unavailable_months=list(downloaded.get('unavailable_months', [])))
        with db.get_conn() as conn:
            _check_current(conn, account)
            existing = _existing_links(conn, account['base_id'], account['site'])
        for index, record in enumerate(records):
            ctx.check_cancelled()
            game = _valid_game(record, account)
            entry_id = None
            if game is None:
                summary['skipped'] += 1
            else:
                remote_id = record['remote_id']
                with db.get_conn() as conn:
                    # Obtain the SQLite write reservation before deduplication.
                    conn.execute('BEGIN IMMEDIATE')
                    _check_current(conn, account)
                    prior = conn.execute('SELECT entry_id FROM sync_imports WHERE base_id=? AND site=? AND remote_id=?', (account['base_id'], account['site'], remote_id)).fetchone()
                    if prior:
                        summary['duplicates'] += 1
                    else:
                        linked = existing.get(remote_id)
                        if linked and not conn.execute('SELECT 1 FROM entries WHERE id=? AND base_id=?', (linked, account['base_id'])).fetchone():
                            linked = None
                        stamp = _now()
                        if linked:
                            target = linked
                            summary['linked'] += 1
                        else:
                            title = f"{game.headers.get('White', '?')} – {game.headers.get('Black', '?')}"
                            cur = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', (account['base_id'], title, pgnlib.export_game(game), stamp, stamp))
                            target = cur.lastrowid
                            entry_id = target
                        conn.execute('INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at,needs_analysis) VALUES(?,?,?,?,?,?)', (account['base_id'], account['site'], remote_id, target, stamp, int(bool(entry_id) and account['auto_analyse'])))
                if entry_id:
                    summary['imported'] += 1
                    summary['entry_ids'].append(entry_id)
                    existing[remote_id] = entry_id
            ctx.progress(index + 1, len(records), f"{summary['imported']} partie(s) ajoutée(s), {summary['duplicates'] + summary['linked']} déjà présente(s).")
        ctx.check_cancelled()
        _drain_analysis(ctx, account, summary, attempted)
        message = 'Synchronisation terminée.'
        if summary['partial']:
            message = ('Synchronisation partielle. Les archives Chess.com suivantes sont temporairement indisponibles : '
                       + ', '.join(summary['unavailable_months'])
                       + '. Les autres mois ont été traités; les archives manquantes seront réessayées à la prochaine synchronisation.')
        if summary['limit_reached']:
            message += ' Limite atteinte : augmente le nombre de parties pour couvrir davantage de cette période.'
        if summary['analysis_skipped']:
            message += f" {summary['analysis_skipped']} analyse(s) en attente : vérifie Stockfish. Elles seront réessayées à la prochaine synchronisation."
        summary['message'] = message
        with db.get_conn() as conn:
            _check_current(conn, account)
            conn.execute('UPDATE sync_accounts SET last_sync_at=?,last_error=NULL,last_result=? WHERE id=?',
                         (account['last_sync_at'] if summary['partial'] else _now(), json.dumps(summary, ensure_ascii=False), account['id']))
        return summary
    except Exception as exc:
        import jobs
        message = ('Synchronisation interrompue. Les parties déjà ajoutées sont conservées.' if isinstance(exc, jobs.JobCancelled) else str(exc) if isinstance(exc, sync_remote.RemoteError) else 'Synchronisation incomplète. Les parties déjà ajoutées sont conservées.')
        summary['message'] = message
        with db.get_conn() as conn:
            conn.execute('UPDATE sync_accounts SET last_error=?,last_result=? WHERE id=? AND updated_at=?', (message, json.dumps(summary, ensure_ascii=False), account['id'], account['updated_at']))
        raise
