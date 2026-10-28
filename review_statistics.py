"""Review activity and a forecast of existing deadlines, without simulated grades."""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from statistics import mean, median
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query

from db import get_conn
import training
import review_progress
import review_preferences
import review_maintenance


router = APIRouter(prefix='/api')
DEFAULT_SECONDS = {'moves': 15, 'solve': 45, 'play': 120, 'game': 300}
COUNT_FIELDS = ('total', 'unseen', 'learning', 'learned', 'mastered', 'due_now', 'overdue', 'new_available_today', 'maintenance_due', 'maintenance_scheduled')


def now():
    return datetime.now(timezone.utc)


def _timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


def _summary(events):
    elapsed = [event['elapsed_ms'] for event in events]
    grades = [0, 0, 0, 0]
    for event in events:
        if event['grade'] in range(4):
            grades[event['grade']] += 1
    return {
        'reviewed': len(events), 'elapsed_ms': sum(elapsed), 'grade_counts': grades,
        'assisted': sum(bool(event['assisted']) for event in events),
        'unique_cards': len({event['card_id'] for event in events}),
        'days_studied': len({event['date'] for event in events}),
        'mean_seconds': round(mean(elapsed) / 1000, 2) if elapsed else None,
        'median_seconds': round(median(elapsed) / 1000, 2) if elapsed else None,
    }


def _counts(cards, current, midnight, new_available=0):
    return {
        'total': len(cards),
        'progress_counts': review_progress.progress_counts(cards, current),
        **{state: sum(card['state'] == state for card in cards) for state in ('unseen', 'learning', 'mastered')},
        'learned': sum(card['state'] in ('learned', 'mastered') for card in cards),
        'due_now': sum(card['state'] in ('learning', 'learned') and card['_due'] is not None and card['_due'] <= current for card in cards),
        'overdue': sum(card['state'] in ('learning', 'learned') and card['_due'] is not None and card['_due'] < midnight for card in cards),
        'new_available_today': new_available,
    }


def _new_available(conn, base, settings, cards, current):
    if not settings.get('review_enabled', False):
        return 0
    return sum(card['state'] == 'unseen' for card in cards)


def _streak(activity):
    longest = running = 0
    for item in activity:
        running = running + 1 if item['count'] else 0
        longest = max(longest, running)
    index = len(activity) - 1
    if index >= 0 and not activity[index]['count']:
        index -= 1
    current = 0
    while index >= 0 and activity[index]['count']:
        current += 1
        index -= 1
    return {'current': current, 'longest': longest, 'scope': 'period'}


@router.get('/reviews/statistics')
def review_statistics(
    base_id: Annotated[int | None, Query(ge=1)] = None,
    days: int = 90,
    tz: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
):
    # Validate before synchronizing: an invalid filter must have no side effects.
    if days not in (7, 30, 90, 365):
        raise HTTPException(422, 'La période doit être de 7, 30, 90 ou 365 jours.')
    if base_id is not None and (not isinstance(base_id, int) or isinstance(base_id, bool) or base_id < 1):
        raise HTTPException(422, 'La base doit avoir un identifiant positif.')
    with get_conn() as config_conn:
        day_settings = review_preferences.read(config_conn)['study_day']
        configured_day = review_preferences._stored(config_conn, 'study_day') is not None
    # Legacy explicit timezone filters still work until a shared day is configured.
    if tz is not None and not configured_day:
        day_settings = {**day_settings, 'timezone': tz}
    tz = day_settings['timezone']
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise HTTPException(422, 'Le fuseau horaire est invalide.')
    current = now().astimezone(timezone.utc)
    today, midnight, next_day = review_preferences.day_bounds(current, day_settings)
    start = today - timedelta(days=days - 1)
    period_start = datetime.combine(start, time(day_settings['start_hour']), zone).astimezone(timezone.utc)
    sample_start = current - timedelta(days=90)
    query_start = min(period_start, sample_start)

    with get_conn() as conn:
        bases = conn.execute('''SELECT b.*, EXISTS(
            SELECT 1 FROM review_history h JOIN review_cards c ON c.id=h.card_id WHERE c.base_id=b.id
            ) AS has_history FROM bases b ORDER BY b.name COLLATE NOCASE,b.id''').fetchall()
        if base_id is not None and not any(base['id'] == base_id for base in bases):
            raise HTTPException(404, 'Base introuvable.')
        scoped_bases = [base for base in bases if base_id is None or base['id'] == base_id]
        settings_by_base = {base['id']: training.settings_of(base) for base in bases}
        for base in scoped_bases:
            if settings_by_base[base['id']].get('review_enabled', False):
                training._sync_base(conn, base)
                conn.commit()
        training.apply_auto_mastery(conn)
        conn.commit()
        conn.execute('BEGIN')
        cards = []
        by_base = []
        maintenance_ids = review_maintenance.due_card_ids(conn, current, base_ids=[base['id'] for base in scoped_bases])
        for base in scoped_bases:
            settings = settings_by_base[base['id']]
            base_cards = []
            if settings.get('review_enabled', False):
                base_cards = [dict(row) for row in conn.execute(
                    'SELECT id,state,due,interval_days,type FROM review_cards WHERE base_id=? AND active=1', (base['id'],))]
                for card in base_cards:
                    card['_due'] = _timestamp(card['due'])
            available = _new_available(conn, base, settings, base_cards, current)
            cards.extend(base_cards)
            if settings.get('review_enabled', False) or base['has_history'] or base['id'] == base_id:
                by_base.append({
                    'base_id': base['id'], 'name': base['name'], 'type': settings.get('type', 'solve'),
                    'review_enabled': bool(settings.get('review_enabled', False)),
                    'current': {**_counts(base_cards, current, midnight, available),
                        **(review_maintenance.counts_for_base(conn, base['id'], current, maintenance_ids)
                           if settings.get('review_enabled', False) else {'maintenance_due': 0, 'maintenance_scheduled': 0})},
                })
        sql = '''SELECT h.card_id,h.reviewed_at,h.grade,h.elapsed_ms,h.assisted,c.base_id,c.type FROM review_history h
                 JOIN review_cards c ON c.id=h.card_id
                 WHERE julianday(h.reviewed_at)>=julianday(?) AND julianday(h.reviewed_at)<=julianday(?)'''
        params = [query_start.isoformat(), current.isoformat()]
        if base_id is not None:
            sql += ' AND c.base_id=?'
            params.append(base_id)
        events = []
        for row in conn.execute(sql, params):
            event = dict(row)
            event['_at'] = _timestamp(event['reviewed_at'])
            if event['_at'] is None:
                continue
            event['date'] = review_preferences.study_date(event['_at'], day_settings).isoformat()
            event['elapsed_ms'] = max(0, event['elapsed_ms'])
            events.append(event)

    period_events = [event for event in events if event['_at'] >= period_start]
    daily_events = {}
    base_events = {}
    for event in period_events:
        daily_events.setdefault(event['date'], []).append(event)
        base_events.setdefault(event['base_id'], []).append(event)
    activity = []
    for offset in range(days):
        date = (start + timedelta(days=offset)).isoformat()
        summary = _summary(daily_events.get(date, []))
        activity.append({'date': date, 'count': summary['reviewed'], 'elapsed_ms': summary['elapsed_ms'],
                         'grade_counts': summary['grade_counts'], 'assisted': summary['assisted']})
    for item in by_base:
        item['period'] = _summary(base_events.get(item['base_id'], []))
    counts = {key: sum(item['current'][key] for item in by_base) for key in COUNT_FIELDS}
    counts['progress_counts'] = review_progress.sum_counts(item['current']['progress_counts'] for item in by_base)
    with get_conn() as conn:
        quota_settings = review_preferences.read(conn)['study_day']
    counts['quota_resets_at'] = review_preferences.day_bounds(current, quota_settings)[2].isoformat(timespec='seconds')
    counts['quota_timezone'] = quota_settings['timezone']
    counts['quota_start_hour'] = quota_settings['start_hour']

    estimates = []
    for card_type, fallback in DEFAULT_SECONDS.items():
        samples = [event['elapsed_ms'] / 1000 for event in events
                   if event['type'] == card_type and event['_at'] >= sample_start and event['elapsed_ms'] > 0]
        estimates.append({'type': card_type, 'seconds': median(samples) if samples else fallback,
                          'sample_count': len(samples), 'assumed': not samples})
    estimates_by_type = {item['type']: item for item in estimates}
    scheduled = [card for card in cards if card['state'] in ('learning', 'learned') and card['_due'] is not None]
    planner = []
    for key, hours in (('now', 0), ('1h', 1), ('4h', 4), ('1d', 24), ('3d', 72), ('7d', 168)):
        at = current + timedelta(hours=hours)
        due_cards = [card for card in scheduled if card['_due'] <= at]
        estimated_minutes = sum(estimates_by_type[card['type']]['seconds'] for card in due_cards) / 60
        planner.append({
            'key': key, 'at': at.isoformat(timespec='seconds'), 'due': len(due_cards),
            'estimated_minutes': max(0.01, round(estimated_minutes, 2)) if due_cards else 0,
            'assumed_cards': sum(estimates_by_type[card['type']]['assumed'] for card in due_cards),
        })
    forecast_counts = {}
    for card in scheduled:
        date = review_preferences.study_date(card['_due'], day_settings)
        forecast_counts[date] = forecast_counts.get(date, 0) + 1
    forecast = [{'date': (today + timedelta(days=offset)).isoformat(),
                 'count': forecast_counts.get(today + timedelta(days=offset), 0)} for offset in range(30)]
    intervals = [{'key': key, 'count': 0} for key in ('lt1', '1to7', '7to30', '30to90', '90plus')]
    for card in cards:
        if card['state'] in ('learning', 'learned'):
            index = next((i for i, limit in enumerate((1, 7, 30, 90)) if card['interval_days'] < limit), 4)
            intervals[index]['count'] += 1
    return {
        'generated_at': current.isoformat(timespec='seconds'), 'time_zone': tz, 'today': today.isoformat(), 'study_day': day_settings,
        'filters': {'base_id': base_id, 'days': days, 'bases': [
            {'id': base['id'], 'name': base['name'], 'type': settings_by_base[base['id']].get('type', 'solve'),
             'review_enabled': bool(settings_by_base[base['id']].get('review_enabled', False)),
             'has_history': bool(base['has_history'])}
            for base in bases if settings_by_base[base['id']].get('review_enabled', False) or base['has_history'] or base['id'] == base_id]},
        'period': {'start': start.isoformat(), 'end': today.isoformat(), 'days': days},
        'summary': {'today': _summary(daily_events.get(today.isoformat(), [])), 'period': _summary(period_events)},
        'current': counts, 'planner': planner, 'estimates': {'window_days': 90, 'by_type': estimates},
        'forecast': {'days': 30, 'overdue': counts['overdue'], 'items': forecast, 'note': 'deadlines_only'},
        'activity': activity, 'streak': _streak(activity), 'intervals': intervals, 'by_base': by_base,
        'scope': {'workload': 'active_enabled', 'history': 'existing_bases_including_inactive', 'deleted_bases_retained': False},
    }
