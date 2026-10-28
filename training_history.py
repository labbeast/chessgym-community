"""Read-only, paginated projection of durable training activity.

The source tables remain authoritative. Review rows are individual answers, not
invented sessions; unknown active time remains unknown. Shared legacy tables
belong to the installation owner while newer tables are explicitly user-scoped.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import json
import math
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query

import db
from accounts_api import require_user

router = APIRouter(prefix='/api/training/history', tags=['Training history'])
TOOLS = ('review', 'puzzles', 'storm', 'guess', 'coordinates', 'blindfold', 'color', 'computer', 'reading')
STATUSES = ('completed', 'active', 'interrupted')
OUTCOMES = ('success', 'failure', 'mixed', 'draw', 'unknown')
EVENT_LIMIT = 500


def _json(value, fallback=None):
    if value is None:
        return {} if fallback is None else fallback
    try:
        return json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return {} if fallback is None else fallback


def _ms(column):
    return f"CAST(ROUND((julianday({column})-2440587.5)*86400000) AS INTEGER)"


def _j(column, key):
    return f"json_extract(CASE WHEN json_valid({column}) THEN {column} ELSE '{{}}' END,'$.{key}')"


def _iso(milliseconds):
    if milliseconds is None:
        return None
    try:
        return datetime.fromtimestamp(float(milliseconds) / 1000, timezone.utc).isoformat(timespec='milliseconds')
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _number(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


def _source(tool, table, *, ident='s.id', unit='session', title, started, finished='NULL',
            duration='NULL', duration_kind="'unknown'", status="'active'", outcome="'unknown'",
            completed='NULL', total='NULL', score='NULL', maximum='NULL', metrics="'{}'", where='1'):
    return f"""SELECT CAST({ident} AS TEXT) id,'{tool}' tool,'{unit}' unit,{title} title,
        {started} started_ms,{finished} finished_ms,{duration} duration_ms,{duration_kind} duration_kind,
        {status} status,{outcome} outcome,{completed} completed_count,{total} total_count,
        {score} score,{maximum} maximum,{metrics} metrics
        FROM {table} WHERE {where}"""


def _sources(conn, user_id, selected):
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    sources, args = [], []

    def add(tool, required, sql, scoped=False):
        if selected in ('all', tool) and set(required) <= tables and (scoped or user_id == 1):
            sources.append(sql)
            if scoped:
                args.append(user_id)

    add('review', ['review_history', 'review_cards', 'bases'], _source('review',
        'review_history s JOIN review_cards c ON c.id=s.card_id LEFT JOIN bases b ON b.id=c.base_id',
        unit='answer', title='c.title', started=f"{_ms('s.reviewed_at')}-MAX(0,s.elapsed_ms)", finished=_ms('s.reviewed_at'),
        duration='MAX(0,s.elapsed_ms)', duration_kind="'elapsed'", status="'completed'",
        outcome="CASE WHEN s.grade=0 THEN 'failure' WHEN s.errors>0 OR s.hints>0 OR s.assisted>0 THEN 'mixed' ELSE 'success' END",
        completed='1', total='1', score='s.grade', maximum='3',
        metrics="json_object('base_id',c.base_id,'base_name',b.name,'entry_id',c.entry_id,'path',c.path,'type',c.type,'grade',s.grade,'errors',s.errors,'hints',s.hints,'assisted',s.assisted,'interval_days',s.interval_days)"))

    add('puzzles', ['puzzle_attempts'], _source('puzzles', 'puzzle_attempts s', unit='attempt',
        title="'#'||s.puzzle_id", started='s.started_ms', finished=_ms('s.finished_at'),
        duration='MAX(0,s.elapsed_ms)', duration_kind="'elapsed'",
        status="CASE WHEN s.status='active' THEN 'active' WHEN s.status='expired' THEN 'interrupted' ELSE 'completed' END",
        outcome="CASE WHEN s.failed>0 OR s.status='revealed' THEN 'failure' WHEN s.status='completed' AND s.hints>0 THEN 'mixed' WHEN s.status='completed' THEN 'success' ELSE 'unknown' END",
        completed="CASE WHEN s.status='completed' THEN 1 ELSE 0 END", total='1',
        metrics=f"json_object('puzzle_id',s.puzzle_id,'rating',{_j('s.snapshot','rating')},'rating_before',s.rating_before,'rating_after',s.rating_after,'hints',s.hints,'failed',s.failed,'mode',s.mode)",
        where="s.mode='classic'"))

    storm_end = f"MIN(s.deadline_ms,COALESCE({_ms('s.finished_at')},s.deadline_ms))"
    storm_duration = f"CASE WHEN s.clock_started=0 THEN 0 WHEN s.finished_at IS NOT NULL THEN MAX(0,{storm_end}-s.started_ms) ELSE NULL END"
    storm_attempts = "COALESCE(a.total,0)"
    storm_source = "puzzle_storm s LEFT JOIN (SELECT session_id,COUNT(*) total FROM puzzle_attempts WHERE mode='storm' GROUP BY session_id) a ON a.session_id=s.id"
    add('storm', ['puzzle_storm', 'puzzle_attempts'], _source('storm', storm_source,
        title='s.configuration_name', started='s.started_ms', finished=_ms('s.finished_at'),
        duration=storm_duration, duration_kind="'elapsed'", status="CASE WHEN s.status='active' THEN 'active' ELSE 'completed' END",
        outcome="CASE WHEN s.status='active' THEN 'unknown' WHEN s.score=0 AND s.mistakes>0 THEN 'failure' WHEN s.score>0 AND s.mistakes>0 THEN 'mixed' WHEN s.score>0 THEN 'success' ELSE 'unknown' END",
        completed='s.score', total=storm_attempts, score='s.score',
        metrics="json_object('mode','storm','best_combo',s.best_combo,'errors',s.mistakes,'solved_rating',s.solved_rating,'configuration',s.configuration_name,'clock_started',s.clock_started)"))

    guess_attempts = "(SELECT COUNT(a.score) FROM guess_attempts a WHERE a.session_id=s.id)"
    guess_score = "(SELECT COALESCE(SUM(a.score),0) FROM guess_attempts a WHERE a.session_id=s.id)"
    guess_exact = "(SELECT COALESCE(SUM(a.exact),0) FROM guess_attempts a WHERE a.session_id=s.id AND a.score IS NOT NULL)"
    add('guess', ['guess_sessions', 'guess_attempts'], _source('guess', 'guess_sessions s',
        title='s.title', started=_ms('s.created_at'), finished=f"CASE WHEN s.current_path IS NULL THEN {_ms('s.updated_at')} END",
        duration="(SELECT SUM(MAX(0,a.elapsed_ms)) FROM guess_attempts a WHERE a.session_id=s.id)", duration_kind="'elapsed'",
        status="CASE WHEN s.current_path IS NULL THEN 'completed' ELSE 'active' END",
        outcome=f"CASE WHEN s.current_path IS NOT NULL OR {guess_attempts}=0 THEN 'unknown' WHEN {guess_score}={guess_attempts}*10 THEN 'success' WHEN {guess_score}=0 THEN 'failure' ELSE 'mixed' END",
        completed=guess_attempts, score=guess_score, maximum=f'{guess_attempts}*10',
        metrics=f"json_object('side',s.side,'entry_id',s.entry_id,'exact_count',{guess_exact})", where='s.user_id=?'), True)

    # Read-only compatibility with the retired Mix prototype. Fresh databases
    # do not create this table. Keep past time/results out of classic accuracy.
    mix = lambda key: _j('s.data', key)
    mix_done = f"{mix('status')}='completed'"
    mix_answered = "(SELECT COUNT(*) FROM json_each(s.data,'$.attempts') a WHERE json_extract(a.value,'$.delta_cp') IS NOT NULL)"
    mix_exact = "(SELECT COALESCE(SUM(json_extract(a.value,'$.exact')),0) FROM json_each(s.data,'$.attempts') a WHERE json_extract(a.value,'$.delta_cp') IS NOT NULL)"
    add('guess', ['guess_mix_sessions'], _source('guess', 'guess_mix_sessions s',
        title="'Guess the Move Mix'", started=_ms('s.created_at'),
        finished=f"CASE WHEN {mix_done} THEN {_ms('s.updated_at')} END",
        duration=f"COALESCE({mix('total_elapsed_ms')},0)+COALESCE({mix('total_observation_ms')},0)", duration_kind="'elapsed'",
        status=f"CASE WHEN {mix_done} THEN 'completed' ELSE 'active' END",
        outcome=f"CASE WHEN NOT ({mix_done}) THEN 'unknown' WHEN {mix('outcome')}='win' THEN 'success' WHEN {mix('outcome')}='loss' THEN 'failure' WHEN {mix('outcome')}='draw' THEN 'draw' ELSE 'unknown' END",
        completed=mix_answered, total=mix('position_count'),
        metrics=f"json_object('mode','mix','side',{mix('side')},'base_id',{mix('base_id')},'delta_cp',{mix('cumulative_cp')},'threshold_cp',{mix('threshold_cp')},'exact_count',{mix_exact},'thinking_ms',{mix('total_elapsed_ms')},'historical_ms',{mix('total_historical_ms')},'preparation_ms',{mix('total_observation_ms')},'reason',{mix('completion_reason')},'minimum_time_seconds',COALESCE({mix('minimum_time_seconds')},0),'total_topup_ms',COALESCE({mix('total_topup_ms')},0))",
        where='s.user_id=?'), True)

    for tool in ('coordinates', 'blindfold'):
        started = 'CAST(COALESCE(s.started_at,s.created_at)*1000 AS INTEGER)'
        abandoned = f"COALESCE({_j('s.result','abandoned')},0)"
        state_correct, state_errors = _j('s.state', 'correct'), _j('s.state', 'errors')
        success = _j('s.result', 'success')
        status = f"CASE WHEN {abandoned}=1 THEN 'interrupted' WHEN s.finished_at IS NOT NULL THEN 'completed' ELSE 'active' END"
        if tool == 'coordinates':
            score = f"COALESCE({_j('s.result','score')},{state_correct},0)"
            errors = f"COALESCE({_j('s.result','errors')},{state_errors},0)"
            total = f'({score}+{errors})'
            duration = f"CASE WHEN {abandoned}=0 AND s.finished_at IS NOT NULL THEN {_j('s.config','duration')}*1000 ELSE NULL END"
            outcome = f"CASE WHEN s.finished_at IS NULL OR {abandoned}=1 OR {total}=0 THEN 'unknown' WHEN {errors}=0 THEN 'success' WHEN {score}=0 THEN 'failure' ELSE 'mixed' END"
            metrics = f"json_object('mode',{_j('s.config','mode')},'side',{_j('s.config','orientation')},'errors',{errors},'accuracy',CASE WHEN {total}>0 THEN ROUND(100.0*{score}/{total},1) ELSE NULL END,'duration',{_j('s.config','duration')},'coordinates',{_j('s.config','coordinates')})"
            title, completed, maximum = "'Coordonnées'", total, total
        else:
            preparation, elapsed = _j('s.result', 'preparation_ms'), _j('s.result', 'elapsed_ms')
            # Legacy results already recorded both phases, except that a reveal
            # before Ready recorded the same preparation interval in elapsed_ms.
            # Keep older unknown preparation times unknown instead of inferring
            # them from a wall-clock difference in historical rows.
            duration = (f"COALESCE({_j('s.result', 'total_elapsed_ms')},"
                        f"CASE WHEN {preparation} IS NOT NULL AND {elapsed} IS NOT NULL THEN "
                        f"{preparation}+CASE WHEN s.started_at IS NULL THEN 0 ELSE {elapsed} END "
                        f"ELSE {elapsed} END)")
            started = 'CAST(s.created_at*1000 AS INTEGER)'
            outcome = f"CASE WHEN {abandoned}=1 OR s.result IS NULL THEN 'unknown' WHEN {success}=1 THEN 'success' ELSE 'failure' END"
            title = f"COALESCE({_j('s.state','title')},'#'||{_j('s.state','puzzle_id')},'À l’aveugle')"
            completed = f"CASE WHEN s.finished_at IS NOT NULL AND {abandoned}=0 THEN 1 ELSE 0 END"
            total, score, maximum = '1', 'NULL', 'NULL'
            metrics = f"json_object('mode',{_j('s.config','mode')},'errors',COALESCE({_j('s.result','errors')},{state_errors},0),'rating',{_j('s.state','rating')},'solve_success',{_j('s.result','solve_success')},'reconstruction_success',{_j('s.result','reconstruction_success')},'accuracy',{_j('s.result','accuracy')},'rating_before',{_j('s.result','rating_before')},'rating_after',{_j('s.result','rating_after')},'rating_delta',{_j('s.result','rating_delta')},'exercise_rating',{_j('s.result','exercise_rating')},'points',{_j('s.result','points')},'preparation_ms',{preparation},'elapsed_ms',{elapsed})"
        add(tool, ['skill_sessions'], _source(tool, 'skill_sessions s', title=title,
            started=started, finished='CAST(s.finished_at*1000 AS INTEGER)',
            duration=duration, duration_kind="'elapsed'", status=status, outcome=outcome,
            completed=completed, total=total, score=score, maximum=maximum, metrics=metrics,
            where=f"s.user_id=? AND s.kind='{tool}'"), True)

    color_score = f"COALESCE({_j('s.result','score')},{_j('s.state','correct')},0)"
    color_errors = f"COALESCE({_j('s.result','errors')},{_j('s.state','errors')},0)"
    color_total = f'({color_score}+{color_errors})'
    add('color', ['color_sessions'], _source('color', 'color_sessions s', title="'Color'",
        started='CAST(COALESCE(s.started_at,s.created_at)*1000 AS INTEGER)', finished='CAST(s.finished_at*1000 AS INTEGER)',
        duration="CASE WHEN s.started_at IS NOT NULL AND s.finished_at IS NOT NULL THEN MAX(0,CAST(ROUND((s.finished_at-s.started_at)*1000) AS INTEGER)) ELSE NULL END",
        duration_kind="'elapsed'", status=f"CASE WHEN {_j('s.result','abandoned')}=1 THEN 'interrupted' WHEN s.finished_at IS NOT NULL THEN 'completed' ELSE 'active' END",
        outcome=f"CASE WHEN s.finished_at IS NULL OR COALESCE({_j('s.result','abandoned')},0)=1 OR {color_total}=0 THEN 'unknown' WHEN {color_errors}=0 THEN 'success' WHEN {color_score}=0 THEN 'failure' ELSE 'mixed' END",
        completed=color_total, total=color_total, score=color_score, maximum=color_total,
        metrics=f"json_object('errors',{color_errors},'accuracy',CASE WHEN {color_total}>0 THEN ROUND(100.0*{color_score}/{color_total},1) ELSE NULL END,'record_eligible',{_j('s.result','record_eligible')},'duration',s.duration)" ,where='s.user_id=?'), True)

    clock = lambda key: _j('s.snapshot', 'session.clock.' + key)
    played = f"MAX(0,s.ply_count-COALESCE({_j('s.snapshot','session.baseline')},0))"
    clock_duration = f"CASE WHEN {clock('initial_ms')} IS NOT NULL THEN MAX(0,2*{clock('initial_ms')}+{clock('increment_ms')}*{played}-{clock('remaining.white')}-{clock('remaining.black')}) ELSE NULL END"
    active_duration = _j('s.snapshot', 'session.activity.elapsed_ms')
    add('computer', ['computer_games'], _source('computer', 'computer_games s', unit='game',
        title="s.white||' — '||s.black", started=f"COALESCE({_ms(_j('s.snapshot','session.started_at'))},{_ms('s.created_at')})", finished=_ms('s.finished_at'),
        duration=f"COALESCE({active_duration},{clock_duration})", duration_kind=f"CASE WHEN {active_duration} IS NOT NULL THEN 'active' WHEN {clock('initial_ms')} IS NOT NULL THEN 'clock' ELSE 'unknown' END",
        status="CASE WHEN s.result='*' THEN 'active' ELSE 'completed' END",
        outcome="CASE WHEN s.result='*' THEN 'unknown' WHEN s.result='1/2-1/2' THEN 'draw' WHEN (s.side='white' AND s.result='1-0') OR (s.side='black' AND s.result='0-1') THEN 'success' ELSE 'failure' END",
        completed=played, metrics="json_object('white',s.white,'black',s.black,'side',s.side,'result',s.result,'reason',s.reason,'provider',s.provider,'plies',s.ply_count,'time_control',s.time_control)",
        where='s.user_id=?'), True)

    add('reading', ['reading_visits'], _source('reading', 'reading_visits s', unit='visit',
        title='s.title', started=_ms('s.started_at'), finished=_ms('s.finished_at'),
        duration='MAX(0,ROUND(s.active_seconds*1000))', duration_kind="'active'",
        status="CASE WHEN s.finished_at IS NULL THEN 'active' ELSE 'completed' END",
        metrics="json_object('base_id',s.base_id,'base_name',s.base_name,'entry_id',s.entry_id,'first_path',s.first_path,'last_path',s.last_path,'read_moves',s.read_moves,'total_moves',s.total_moves,'progress',CASE WHEN s.total_moves>0 THEN ROUND(100.0*s.read_moves/s.total_moves,1) ELSE NULL END)", where='s.user_id=?'), True)
    return sources, args


def _item(row):
    value = dict(row)
    value['key'] = value['tool'] + ':' + value['id']
    value['started_at'] = _iso(value.pop('started_ms'))
    value['finished_at'] = _iso(value.pop('finished_ms'))
    value['metrics'] = _json(value['metrics'])
    if value['duration_ms'] is not None:
        value['duration_ms'] = round(max(0, value['duration_ms']))
    if value['tool'] == 'reading':
        for key in ('first', 'last'):
            path = value['metrics'].get(key + '_path') or ''
            value['metrics'][key + '_ply'] = len(path.split('.')) if path else 0
    value['detail_available'] = True
    value['open_available'] = not (value['tool'] == 'guess' and value['metrics'].get('mode') == 'mix')
    return value


def _bound(value, zone, *, end=False):
    if not value:
        return None
    try:
        day = date.fromisoformat(value)
        if end:
            day += timedelta(days=1)
        return round(datetime.combine(day, time(), zone).timestamp() * 1000)
    except (ValueError, OverflowError):
        raise HTTPException(422, 'La date doit utiliser le format AAAA-MM-JJ.') from None


def _query(conn, user_id, *, tool='all', status='all', outcome='all', date_from=None, date_to=None,
           q='', offset=0, limit=25, time_zone='UTC', identity=None, sort='date', descending=True):
    order_columns = {'date': 'started_ms', 'duration': 'duration_ms', 'activity': 'title COLLATE NOCASE'}
    if sort not in order_columns:
        raise HTTPException(422, 'Ce tri d’historique est inconnu.')
    if tool not in ('all', *TOOLS) or status not in ('all', *STATUSES) or outcome not in ('all', *OUTCOMES):
        raise HTTPException(422, 'Ce filtre d’historique est inconnu.')
    try:
        zone = ZoneInfo(time_zone)
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(422, 'Ce fuseau horaire est inconnu.') from None
    lower, upper = _bound(date_from, zone), _bound(date_to, zone, end=True)
    if lower is not None and upper is not None and lower >= upper:
        raise HTTPException(422, 'La date de début doit précéder la date de fin.')
    sources, params = _sources(conn, user_id, tool)
    if not sources:
        return {'items': [], 'total': 0, 'offset': offset, 'limit': limit}
    conditions = []
    for field, value in (('status', status), ('outcome', outcome)):
        if value != 'all':
            conditions.append(field + '=?')
            params.append(value)
    if lower is not None:
        conditions.append('started_ms>=?')
        params.append(lower)
    if upper is not None:
        conditions.append('started_ms<?')
        params.append(upper)
    if q.strip():
        from game_search import fold
        conn.create_function('cg_fold', 1, fold, deterministic=True)
        for term in fold(q).split():
            conditions.append("instr(cg_fold(COALESCE(title,'')||' '||COALESCE(metrics,'')),?)>0")
            params.append(term)
    if identity is not None:
        conditions.append('id=?')
        params.append(identity)
    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    cte = 'WITH activity AS (' + ' UNION ALL '.join(sources) + '), filtered AS (SELECT * FROM activity' + where + ') '
    total = conn.execute(cte + 'SELECT COUNT(*) FROM filtered', params).fetchone()[0]
    direction = 'DESC' if descending else 'ASC'
    column = order_columns[sort]
    # Sort the complete filtered population, with unknown values last and stable
    # tie breakers so equal dates/durations never jump between result pages.
    order = f'{column} IS NULL, {column} {direction}, started_ms DESC,tool,id DESC'
    rows = conn.execute(cte + f'SELECT * FROM filtered ORDER BY {order} LIMIT ? OFFSET ?', (*params, limit, offset)).fetchall()
    return {'items': [_item(row) for row in rows], 'total': total, 'offset': offset, 'limit': limit}


@router.get('')
def history(tool: str = Query('all'), status: str = Query('all'), outcome: str = Query('all'),
            date_from: str | None = Query(None), date_to: str | None = Query(None),
            q: str = Query('', max_length=200), offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
            time_zone: str = Query('UTC', max_length=100), sort: Literal['date', 'duration', 'activity'] = 'date',
            descending: bool = True, user=Depends(require_user)):
    with db.read_conn() as conn:
        return _query(conn, user['id'], tool=tool, status=status, outcome=outcome, date_from=date_from,
                      date_to=date_to, q=q, offset=offset, limit=limit, time_zone=time_zone, sort=sort, descending=descending)


STATISTICS_TOOLS = ('computer', 'guess', 'blindfold', 'coordinates', 'color')


def _statistics(conn, user_id, tool):
    """Aggregate the full scoped history, never a page or mutable session state.

    Performance and duration deliberately concern completed records only. An
    active or interrupted attempt must not appear as a finished win or record.
    Unknown durations and unavailable measurements remain null, not zero.
    """
    if tool not in STATISTICS_TOOLS:
        raise HTTPException(422, 'Cet outil de statistiques est inconnu.')
    sources, params = _sources(conn, user_id, tool)
    source = ' UNION ALL '.join(sources) if sources else _source(tool, '(SELECT 1) s',
        ident="''", title="''", started='NULL', where='0')
    complete = "status='completed'"
    numeric = lambda value: f"typeof({value}) IN ('integer','real')"
    metric = lambda key: _j('metrics', key)
    def total(value):
        return f'SUM(CASE WHEN {complete} AND {numeric(value)} THEN {value} END)'
    def samples(value):
        return f'SUM(CASE WHEN {complete} AND {numeric(value)} THEN 1 ELSE 0 END)'
    columns = [
        'COUNT(*) total',
        *[f"COALESCE(SUM(status='{status}'),0) {status}" for status in STATUSES],
        *[f"COALESCE(SUM({complete} AND outcome='{outcome}'),0) {outcome}" for outcome in OUTCOMES],
        f'{total("duration_ms")} duration_ms',
        f'{samples("duration_ms")} duration_count',
    ]
    if tool in ('guess', 'coordinates', 'color'):
        columns += [f'{total("score")} score', f'{total("maximum")} maximum',
                    f"MAX(CASE WHEN {complete} THEN score END) best_score"]
    if tool == 'guess':
        columns += [f'{total("completed_count")} attempts', f'{total(metric("exact_count"))} exact_count']
    if tool in ('blindfold', 'coordinates', 'color'):
        columns += [f'{total(metric("errors"))} errors']
    if tool == 'blindfold':
        columns += [f'AVG(CASE WHEN {complete} AND {numeric(metric("accuracy"))} '
                    f'AND {metric("accuracy")} BETWEEN 0 AND 100 THEN {metric("accuracy")} END) accuracy']
        columns += [f'{samples(metric("accuracy"))} accuracy_count']
        for key in ('solve_success', 'reconstruction_success'):
            columns += [f'{total(metric(key))} {key}', f'{samples(metric(key))} {key}_count']
    sql = 'WITH activity AS (' + source + ') SELECT ' + ','.join(columns) + ' FROM activity'
    values = dict(conn.execute(sql, params).fetchone())
    counts = {key: int(values.pop(key) or 0) for key in ('total', *STATUSES)}
    outcomes = {key: int(values.pop(key) or 0) for key in OUTCOMES}
    duration_count = int(values.pop('duration_count') or 0)
    duration_ms = values.pop('duration_ms')
    duration = {'total_ms': round(duration_ms) if duration_ms is not None else None,
                'known_count': duration_count, 'unknown_count': counts['completed'] - duration_count}
    metrics = {key: round(value, 2) if isinstance(value, float) else value for key, value in values.items()}
    if tool in ('guess', 'coordinates', 'color'):
        metrics['accuracy'] = round(100 * metrics['score'] / metrics['maximum'], 1) if metrics.get('maximum') else None
    result = {'tool': tool, 'counts': counts, 'outcomes': outcomes, 'duration': duration,
              'metrics': metrics, 'performance_scope': 'completed'}
    if tool == 'blindfold' and conn.execute("SELECT 1 FROM sqlite_master WHERE name='blindfold_profiles'").fetchone():
        import blindfold_rating
        result['profiles'] = blindfold_rating.profiles(conn, user_id)
    return result


@router.get('/statistics')
def statistics(tool: str = Query(...), user=Depends(require_user)):
    with db.read_conn() as conn:
        return _statistics(conn, user['id'], tool)


def _event(action, result='unknown', *, at=None, elapsed_ms=None, duration_ms=None, details=None):
    return {'at': at, 'action': action, 'result': result, 'duration_ms': duration_ms,
            'elapsed_ms': elapsed_ms, 'details': details or {}}


def _result(correct):
    return 'unknown' if correct is None else 'success' if correct else 'failure'


def _timed_events(events, started_ms, *, kind, previous=0):
    result = []
    for index, event in enumerate(events):
        elapsed = _number(event.get('elapsed_ms'))
        duration = max(0, elapsed - previous) if elapsed is not None else None
        if elapsed is not None:
            previous = elapsed
        target = event.get('target') or {}
        if kind == 'color':
            action = event.get('square', '')
            details = {'answer': event.get('color')}
        elif kind == 'coordinates':
            action = (target.get('piece', '') + target.get('square', ''))
            details = {'answer': event.get('square'), 'expected': target.get('square')}
        else:
            action = event.get('move') or event.get('san') or event.get('uci') or ''
            details = {'uci': event.get('uci'), 'solution_index': event.get('solution_index')}
        result.append(_event(action, _result(event.get('correct')), elapsed_ms=elapsed,
            duration_ms=duration, at=_iso(started_ms + elapsed) if started_ms is not None and elapsed is not None else None,
            details=details))
    return result


def _details(conn, tool, identity, user_id, item, *, events_offset=0, events_limit=100):
    details, events, event_count = dict(item['metrics']), [], 0
    if tool == 'review':
        row = conn.execute('SELECT * FROM review_history WHERE id=?', (identity,)).fetchone()
        details.update(mode=row['mode'], proposed_grade=row['proposed_grade'], requested_grade=row['requested_grade'])
        event_count = 1
        if events_offset == 0:
            events = [_event(item['title'], item['outcome'], at=item['finished_at'], duration_ms=item['duration_ms'], details=dict(item['metrics']))]
    elif tool == 'puzzles':
        rows = conn.execute('SELECT ordinal,move,san,correct,hint,elapsed_ms,LAG(elapsed_ms,1,0) OVER (ORDER BY ordinal) previous_ms FROM puzzle_events WHERE attempt_id=? ORDER BY ordinal LIMIT ? OFFSET ?', (identity, events_limit, events_offset)).fetchall()
        start = conn.execute('SELECT started_ms FROM puzzle_attempts WHERE id=?', (identity,)).fetchone()[0]
        for row in rows:
            elapsed = row['elapsed_ms']
            events.append(_event(row['san'] or row['move'] or ('Indice' if row['hint'] else 'Réponse'), _result(row['correct']),
                at=_iso(start + elapsed), elapsed_ms=elapsed, duration_ms=max(0, elapsed-row['previous_ms']), details={'hint': bool(row['hint'])}))
        event_count = conn.execute('SELECT COUNT(*) FROM puzzle_events WHERE attempt_id=?', (identity,)).fetchone()[0]
    elif tool == 'storm':
        rows = conn.execute("SELECT id,puzzle_id,snapshot,status,failed,hints,started_at,elapsed_ms FROM puzzle_attempts WHERE session_id=? AND mode='storm' ORDER BY started_ms,rowid LIMIT ? OFFSET ?", (identity, events_limit, events_offset)).fetchall()
        for row in rows:
            puzzle = _json(row['snapshot'])
            outcome = 'failure' if row['failed'] else 'success' if row['status']=='completed' and not row['hints'] else 'unknown'
            events.append(_event('#' + row['puzzle_id'], outcome, at=row['started_at'], duration_ms=row['elapsed_ms'], details={
                'attempt_id': row['id'], 'puzzle_id': row['puzzle_id'], 'rating': puzzle.get('rating'), 'hints': row['hints']}))
        event_count = conn.execute("SELECT COUNT(*) FROM puzzle_attempts WHERE session_id=? AND mode='storm'", (identity,)).fetchone()[0]
    elif tool == 'guess' and item['metrics'].get('mode') == 'mix':
        row = conn.execute('SELECT data FROM guess_mix_sessions WHERE id=? AND user_id=?', (identity, user_id)).fetchone()
        session = _json(row['data'])
        attempts = session.get('attempts', [])
        event_count = len(attempts)
        for attempt in attempts[events_offset:events_offset + events_limit]:
            result = attempt.get('result') or {}
            delta = attempt.get('delta_cp')
            outcome = 'unknown' if delta is None else 'success' if delta > 0 else 'failure' if delta < 0 else 'draw'
            events.append(_event(result.get('proposal_san') or attempt.get('uci') or 'Temps écoulé', outcome,
                duration_ms=attempt.get('elapsed_ms'), details={'delta_cp': delta,
                'exact': bool(attempt.get('exact')), 'expected': result.get('original_san')}))
    elif tool == 'guess':
        rows = conn.execute('SELECT path,uci,elapsed_ms,score,exact,result,created_at FROM guess_attempts WHERE session_id=? ORDER BY id LIMIT ? OFFSET ?', (identity, events_limit, events_offset)).fetchall()
        for row in rows:
            result = _json(row['result'])
            outcome = 'unknown' if row['score'] is None else 'success' if row['score']==10 else 'failure' if row['score']==0 else 'mixed'
            events.append(_event(result.get('proposal_san') or result.get('san') or result.get('played_san') or row['uci'], outcome,
                at=row['created_at'], duration_ms=row['elapsed_ms'], details={'path': row['path'], 'score': row['score'], 'maximum': 10, 'exact': bool(row['exact']), 'expected': result.get('original_san')}))
        event_count = conn.execute('SELECT COUNT(*) FROM guess_attempts WHERE session_id=?', (identity,)).fetchone()[0]
    elif tool in ('coordinates', 'blindfold', 'color'):
        table = 'color_sessions' if tool=='color' else 'skill_sessions'
        raw = conn.execute(f'SELECT * FROM {table} WHERE id=? AND user_id=?', (identity, user_id)).fetchone()
        state, result = _json(raw['state']), _json(raw['result'])
        details.update({key: value for key, value in result.items() if key not in ('expected', 'proposed', 'correct', 'missing', 'misplaced')})
        if tool != 'color':
            config = _json(raw['config'])
            details.update({key: config[key] for key in ('mode', 'orientation', 'input', 'hide_prompt', 'max_moves', 'max_pieces', 'whole_game') if key in config})
        started_ms = int(raw['started_at']*1000) if raw['started_at'] is not None else None
        source = state.get('attempts' if tool=='blindfold' else 'events', [])
        previous = source[events_offset-1].get('elapsed_ms', 0) if 0 < events_offset <= len(source) else 0
        events = _timed_events(source[events_offset:events_offset+events_limit], started_ms, kind=tool, previous=previous)
        event_count = len(source)
        if tool=='blindfold' and ('expected' in result or 'reconstruction_success' in result):
            # Both answers are retained: move solving and exact reconstruction.
            comparison = {key: result[key] for key in ('expected', 'proposed', 'missing', 'misplaced', 'accuracy') if key in result}
            reconstruction = result.get('reconstruction_success', result.get('success'))
            if events_offset <= len(source) < events_offset + events_limit:
                events.append(_event('Reconstitution finale', _result(reconstruction), at=item['finished_at'],
                    duration_ms=result.get('reconstruction_elapsed_ms', result.get('elapsed_ms')), details=comparison))
            event_count += 1
    elif tool == 'computer':
        row = conn.execute('SELECT snapshot FROM computer_games WHERE user_id=? AND id=?', (user_id, identity)).fetchone()
        session = _json(row['snapshot']).get('session', {})
        position, clock = session.get('position', {}), session.get('clock') or {}
        baseline = session.get('baseline', 0)
        nodes = position.get('doc', {}).get('nodes', [])
        by_ply = {entry.get('ply'): entry.get('remaining', {}) for entry in clock.get('history', [])}
        first = baseline + 1 + events_offset
        previous = by_ply.get(first - 1)
        for index, node in enumerate(nodes[first:first + events_limit], first):
            remaining = by_ply.get(index)
            duration = None
            if previous and remaining:
                duration = max(0, sum(previous.values()) + clock.get('increment_ms', 0) - sum(remaining.values()))
            events.append(_event(node.get('san') or node.get('uci', ''), details={'ply': index}, duration_ms=duration))
            previous = remaining
        event_count = max(0, len(position.get('history', []))-baseline)
    elif tool == 'reading':
        row = conn.execute('SELECT * FROM reading_visits WHERE id=? AND user_id=?', (identity,user_id)).fetchone()
        details.update(first_path=row['first_path'], last_path=row['last_path'], read_moves=row['read_moves'], total_moves=row['total_moves'])
    event_count = max(event_count, len(events))
    end = events_offset + len(events)
    return {'item': item, 'details': details, 'events': events, 'event_count': event_count,
            'events_offset': events_offset, 'events_limit': events_limit,
            'events_truncated': end < event_count, 'next_events_offset': end if end < event_count else None}


@router.get('/{tool}/{identity}')
def detail(tool: str, identity: str, events_offset: int = Query(0, ge=0),
           events_limit: int = Query(100, ge=1, le=500), user=Depends(require_user)):
    if tool not in TOOLS or len(identity) > 200:
        raise HTTPException(404, 'Cette activité est introuvable.')
    with db.read_conn() as conn:
        found = _query(conn, user['id'], tool=tool, identity=identity, limit=1)
        if not found['items']:
            raise HTTPException(404, 'Cette activité est introuvable.')
        return _details(conn, tool, identity, user['id'], found['items'][0], events_offset=events_offset, events_limit=events_limit)
