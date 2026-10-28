"""Pure PGN metadata shared by study collections and reference archives.

Identity serialization is a storage contract: changing it would invalidate
deduplication against already imported archives. Comments and result corrections
deliberately do not change a game's identity.
"""
import json
import re

IDENTITY_HEADERS = ('White', 'Black', 'Date', 'Event', 'Site', 'Round',
                    'UTCDate', 'UTCTime', 'Time', 'Link')
RESULTS = {'1-0': 'white', '1/2-1/2': 'draws', '0-1': 'black', '*': 'unknown'}
SPEEDS = ('ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown')


def rating(value):
    return int(value) if isinstance(value, str) and value.isdecimal() and 0 < int(value) <= 9999 else None


def speed(headers):
    # Event names are not cadence metadata. Multi-stage/absent controls remain
    # unknown, so they cannot silently enter a rapid-only population.
    control = headers.get('TimeControl', '')
    match = re.fullmatch(r'(\d+)(?:\+(\d+))?', control)
    if not match:
        return 'correspondence' if control.startswith('1/') else None
    duration = int(match[1]) + 40 * int(match[2] or 0)
    for maximum, name in ((30, 'ultraBullet'), (180, 'bullet'), (480, 'blitz'), (1500, 'rapid')):
        if duration < maximum:
            return name
    return 'classical'


def identity_payload(root, moves, headers):
    return json.dumps([
        root, moves, [headers.get(tag, '?').strip() for tag in IDENTITY_HEADERS],
    ], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
