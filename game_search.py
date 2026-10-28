"""Validated game metadata filters shared by studies and reference archives.

Searches use derived metadata only. Partial PGN dates describe an interval;
date filters retain intersecting intervals and exclude completely unknown dates.
Names are token matches on one player's header, without guessing name order.
"""
from __future__ import annotations

import calendar
import json
import re
import unicodedata
from datetime import date
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from game_metadata import SPEEDS, speed as game_speed


def fold(value):
    return ''.join(c for c in unicodedata.normalize('NFD', str(value or ''))
                   if not unicodedata.combining(c)).casefold()


def date_bounds(value, fallback=None):
    """Return inclusive ordinals for a valid full/partial PGN Date, then UTCDate."""
    for candidate in (value, fallback):
        match = re.fullmatch(r'([0-9]{4})[.-]([0-9]{2}|\?\?)[.-]([0-9]{2}|\?\?)', str(candidate or '').strip())
        if not match:
            continue
        year = int(match[1])
        if not 1 <= year <= 9999:
            continue
        month = None if match[2] == '??' else int(match[2])
        day = None if match[3] == '??' else int(match[3])
        if month is None and day is not None:
            continue  # An unknown month with a concrete day is not a valid interval.
        try:
            start_month, end_month = (month, month) if month is not None else (1, 12)
            first = date(year, start_month, day or 1)
            last = date(year, end_month, day if day is not None else calendar.monthrange(year, end_month)[1])
            return first.toordinal(), last.toordinal()
        except (ValueError, calendar.IllegalMonthError):
            continue
    return None, None


def normalize_eco_header(value):
    value = str(value or '').strip().upper()
    return value if re.fullmatch(r'[A-E][0-9]{2}', value) else None


def player_key(name):
    """Exact metadata identity, without inventing FIDE identities or initials."""
    return ' '.join(fold(name).split())


def event_key(headers):
    event_date = str(headers.get('EventDate', '') or '').strip()
    if date_bounds(event_date)[0] is not None:
        edition = event_date.replace('-', '.')
    else:
        start, _ = date_bounds(headers.get('Date'), headers.get('UTCDate'))
        edition = str(date.fromordinal(start).year) if start is not None else ''
    return json.dumps([player_key(headers.get('Event')), player_key(headers.get('Site')), edition],
                      ensure_ascii=False, separators=(',', ':'))


def project_headers(headers):
    """Small normalized search projection; callers retain the original headers."""
    def text(tag):
        value = str(headers.get(tag, '') or '').strip()
        return fold(value) if value not in ('', '?', '*') else None

    def elo(tag):
        value = str(headers.get(tag, '') or '').strip()
        return int(value) if value.isascii() and value.isdecimal() else None

    start, end = date_bounds(headers.get('Date'), headers.get('UTCDate'))
    return dict(white=text('White'), black=text('Black'), event=text('Event'),
                site=text('Site'), round=text('Round'), opening=text('Opening'),
                date_start=start, date_end=end, white_elo=elo('WhiteElo'), black_elo=elo('BlackElo'),
                result=headers.get('Result', '*'), eco=normalize_eco_header(headers.get('ECO')),
                speed=game_speed(headers) or 'unknown',
                player_key_white=player_key(headers.get('White')),
                player_key_black=player_key(headers.get('Black')), event_key=event_key(headers))


class AdvancedGameSearch(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)

    player: str = Field('', max_length=200)
    first_name: str = Field('', max_length=200)
    last_name: str = Field('', max_length=200)
    player_color: Literal['any', 'white', 'black'] = 'any'
    player_key: str = Field('', max_length=2000)
    event_key: str = Field('', max_length=6000)
    white: str = Field('', max_length=200)
    black: str = Field('', max_length=200)
    event: str = Field('', max_length=200)
    site: str = Field('', max_length=200)
    round: str = Field('', max_length=200)
    date_from: str = Field('', max_length=10)
    date_to: str = Field('', max_length=10)
    rating_min: int | None = Field(None, ge=0, le=4000)
    rating_max: int | None = Field(None, ge=0, le=4000)
    rating_side: Literal['both', 'either', 'white', 'black'] = 'both'
    result: Literal['', '1-0', '0-1', '1/2-1/2', '*'] = ''
    eco: str = Field('', max_length=7)
    opening: str = Field('', max_length=200)
    speed: str = Field('', max_length=20)

    @field_validator('player', 'first_name', 'last_name', 'white', 'black', 'event', 'site', 'round', 'opening', mode='before')
    @classmethod
    def normalized_text(cls, value):
        if not isinstance(value, str):
            raise ValueError('Le filtre textuel doit être du texte.')
        return ' '.join(fold(value).split())

    @field_validator('date_from', 'date_to')
    @classmethod
    def valid_date(cls, value):
        if value:
            if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
                raise ValueError('Utilise une date au format AAAA-MM-JJ.')
            date.fromisoformat(value)
        return value

    @field_validator('rating_min', 'rating_max', mode='before')
    @classmethod
    def valid_rating(cls, value):
        if value is None or value == '':
            return None
        if type(value) is int or isinstance(value, str) and re.fullmatch(r'[0-9]+', value):
            return value
        raise ValueError('Le classement Elo doit être un entier de 0 à 4 000.')

    @field_validator('eco', mode='before')
    @classmethod
    def valid_eco(cls, value):
        if not isinstance(value, str):
            raise ValueError('Le code ECO doit être du texte.')
        value = value.strip().upper()
        if not value or re.fullmatch(r'[A-E][0-9]{0,2}', value):
            return value
        if re.fullmatch(r'[A-E][0-9]{2}-[A-E][0-9]{2}', value) and value[:3] <= value[4:]:
            return value
        raise ValueError('Indique un code ECO (B90), un préfixe (B9) ou une plage (B90-B99).')

    @field_validator('speed')
    @classmethod
    def valid_speed(cls, value):
        if value and value not in SPEEDS:
            raise ValueError('Cadence inconnue.')
        return value

    @model_validator(mode='after')
    def ordered_ranges(self):
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError('La date de début doit précéder la date de fin.')
        if self.rating_min is not None and self.rating_max is not None and self.rating_min > self.rating_max:
            raise ValueError('Le classement Elo minimum doit être inférieur au maximum.')
        return self

    @property
    def active(self):
        return any(value not in ('', None) for key, value in self.model_dump().items()
                   if key not in ('player_color', 'rating_side'))

    def sql(self, columns):
        """Compile against trusted, normalized SQL column expressions.

        Every user value is a bound parameter. Text tokens are literal substrings
        (%, _ and quotes never become LIKE wildcards or SQL instructions).
        """
        clauses, params = [], []

        def words(column, text):
            tokens = text.split()
            return ' AND '.join(f'instr(coalesce({column},\'\'),?)>0' for _ in tokens), tokens

        player = ' '.join(filter(None, (self.player, self.first_name, self.last_name)))
        if self.event_key:
            clauses.append(columns['event_key'] + '=?')
            params.append(self.event_key)
        if player or self.player_key:
            sides = ('white', 'black') if self.player_color == 'any' else (self.player_color,)
            alternatives = []
            for side in sides:
                expression, values = words(columns[side], player)
                if self.player_key:
                    expression = (expression + ' AND ' if expression else '') + columns['player_key_' + side] + '=?'
                    values.append(self.player_key)
                alternatives.append('(' + expression + ')')
                params.extend(values)
            clauses.append('(' + ' OR '.join(alternatives) + ')')
        for key in ('white', 'black', 'event', 'site', 'round', 'opening'):
            if value := getattr(self, key):
                expression, values = words(columns[key], value)
                clauses.append('(' + expression + ')')
                params.extend(values)
        if self.date_from:
            clauses.append(columns['date_end'] + '>=?')
            params.append(date.fromisoformat(self.date_from).toordinal())
        if self.date_to:
            clauses.append(columns['date_start'] + '<=?')
            params.append(date.fromisoformat(self.date_to).toordinal())
        if self.rating_min is not None or self.rating_max is not None:
            sides = ('white', 'black') if self.rating_side in ('both', 'either') else (self.rating_side,)
            alternatives = []
            for side in sides:
                comparisons = []
                if self.rating_min is not None:
                    comparisons.append(columns[side + '_elo'] + '>=?')
                    params.append(self.rating_min)
                if self.rating_max is not None:
                    comparisons.append(columns[side + '_elo'] + '<=?')
                    params.append(self.rating_max)
                alternatives.append('(' + ' AND '.join(comparisons) + ')')
            clauses.append('(' + (' OR ' if self.rating_side == 'either' else ' AND ').join(alternatives) + ')')
        if self.result:
            clauses.append(columns['result'] + '=?')
            params.append(self.result)
        if self.eco:
            if '-' in self.eco:
                clauses.append(columns['eco'] + ' BETWEEN ? AND ?')
                params.extend(self.eco.split('-'))
            else:
                clauses.append('substr(' + columns['eco'] + ',1,?)=?')
                params.extend((len(self.eco), self.eco))
        if self.speed:
            clauses.append('coalesce(' + columns['speed'] + ",'unknown')=?")
            params.append(self.speed)
        return clauses, params


def parse_query(request: Request):
    values = {}
    for field in AdvancedGameSearch.model_fields:
        supplied = request.query_params.getlist(field)
        if len(supplied) > 1:
            raise HTTPException(422, 'Un filtre ne peut être indiqué qu’une fois : ' + field)
        if supplied:
            values[field] = supplied[0]
    try:
        return AdvancedGameSearch(**values)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_url=False, include_context=False)[0]['msg']) from exc
