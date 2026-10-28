"""Validated global preferences and explicit application to selected bases."""
import json
from fastapi import APIRouter,Depends
import db
import review_preferences
import sound_preferences
from accounts_api import require_user
from api_common import fail
from language_preferences import LANGUAGES

router=APIRouter()
DEFAULT_FONT_SCALE = 100
FONT_SCALES = (100, 110, 125, 150)

@router.get('/api/preferences')
def preferences(user=Depends(require_user)):
    with db.get_conn() as conn:
        prefs = {}
        for row in conn.execute('SELECT * FROM preferences'):
            try:
                prefs[row['key']] = json.loads(row['value'])
            except (ValueError, TypeError):
                pass
        if prefs.get('language', 'fr') not in LANGUAGES:
            prefs['language'] = 'fr'
        font_scale = prefs.get('font_scale', DEFAULT_FONT_SCALE)
        if type(font_scale) is not int or font_scale not in FONT_SCALES:
            font_scale = DEFAULT_FONT_SCALE
        prefs['font_scale'] = font_scale
        review_prefs = review_preferences.read(conn)
        sound = sound_preferences.read(conn)
    return {'theme': 'copper', 'piece_set': 'cburnett', 'board_theme': 'brown', 'language': 'fr', **prefs, **review_prefs, 'sound': sound}


@router.patch('/api/preferences')
def update_preferences(payload: dict, user=Depends(require_user)):
    options = {
        'theme': ('copper', 'sage', 'midnight', 'plum', 'forest', 'pearl', 'sand', 'contrast'),
        'piece_set': ('cburnett', 'merida', 'chessnut', 'celtic', 'fantasy', 'shapes', 'pirouetti', 'spatial'),
        'board_theme': ('brown', 'blue', 'green', 'slate', 'walnut', 'sand', 'olive', 'ocean', 'lavender', 'rose', 'ice', 'graphite'),
        'language': LANGUAGES,
        'font_scale': FONT_SCALES,
    }
    if set(payload) - (set(options) | {'auto_mastery_days', 'review_defaults', 'review_multipliers', 'review_session_defaults', 'study_day', 'review_maintenance', 'sound'}):
        fail('Réglage inconnu.')
    for key, value in payload.items():
        if key == 'font_scale' and type(value) is not int:
            fail('Valeur inconnue : ' + key)
        if key in options and value not in options[key]:
            fail('Valeur inconnue : ' + key)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        current = review_preferences.read(conn)
        values = dict(payload)
        values.update(review_preferences.validate_patch({key:value for key,value in payload.items() if key not in options and key != 'sound'}, current))
        if 'sound' in payload:
            values['sound'] = sound_preferences.validate(payload['sound'], sound_preferences.read(conn))
        for key, value in values.items():
            conn.execute('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value)))
        if 'auto_mastery_days' in values or 'review_maintenance' in values:
            import training
            training.apply_auto_mastery(conn)
    return preferences(user)




@router.post('/api/preferences/review-defaults/apply')
def apply_review_defaults(payload: dict, user=Depends(require_user)):
    import review_defaults_apply
    return review_defaults_apply.apply(payload)
