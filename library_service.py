"""Study-library validation and metadata services shared by API routes."""
import json
import library_organization
import reference_library
from api_common import fail, now

DEFAULT_SETTINGS = {
    'review_enabled': False, 'type': 'solve', 'is_repertoire': False,
    'color': 'white', 'primary': False, 'mode': 'hybrid', 'spacing': 'adaptive',
    'again': 10, 'hard': 2, 'medium': 5, 'easy': 10, 'max': 720,
    # new_limit is retained only for old backups/clients; it has no scheduling effect.
    'new_limit': None, 'new_order': 'pgn', 'engine': 'stockfish', 'skill': 10, 'side': 'turn', 'goal': 'win',
    'played': False, 'review_priority': 'probability', 'reading_enabled': False, 'guess_enabled': False,
}

def text_field(value, label, maximum=200):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        fail(label + ' doit être un texte non vide de ' + str(maximum) + ' caractères au maximum.')
    return value.strip()


def checked_settings(settings, old=None, *, defaults=None):
    if not isinstance(settings, dict):
        fail('Les réglages de la base doivent être un objet.')
    result = {**DEFAULT_SETTINGS, **(defaults or {}), **(old or {}), **settings}
    enums = {'new_order': ('pgn', 'random'), 'type': ('moves', 'solve', 'play', 'game'), 'color': ('white', 'black'), 'mode': ('manual', 'automatic', 'hybrid'), 'spacing': ('adaptive',), 'review_priority': ('due', 'probability'), 'engine': ('stockfish',), 'side': ('turn', 'white', 'black'), 'goal': ('win', 'convert', 'draw')}
    for key, options in enums.items():
        if result[key] not in options:
            fail('Réglage invalide : ' + key)
    for key in ('review_enabled', 'is_repertoire', 'primary', 'played', 'reading_enabled', 'guess_enabled'):
        if not isinstance(result[key], bool):
            fail('Réglage oui/non invalide : ' + key)
    if result['new_limit'] == '':
        result['new_limit'] = None
    limits = {'again': (1, 1440), 'hard': (0.01, 3650), 'medium': (0.01, 3650), 'easy': (0.01, 3650), 'max': (1, 3650), 'new_limit': (0, 1000), 'skill': (0, 20)}
    for key, (low, high) in limits.items():
        val = result[key]
        if key == 'new_limit' and val is None:
            continue
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not low <= val <= high:
            fail('Valeur hors limites : ' + key)
    for key in ('new_limit', 'skill'):
        if key == 'new_limit' and result[key] is None:
            continue
        if int(result[key]) != result[key]:
            fail('Un nombre entier est requis : ' + key)
    if result['primary'] and not result['is_repertoire']:
        fail('Seul un répertoire peut être principal.')
    return result


def checked_tags(tags):
    if not isinstance(tags, list) or len(tags) > 50 or any(not isinstance(x, str) or not x.strip() or len(x) > 80 for x in tags):
        fail('Les catégories doivent être une liste de noms courts.')
    return list(dict.fromkeys(x.strip() for x in tags))


def get_base(conn, base_id):
    row = conn.execute('SELECT bases.*, (SELECT count(*) FROM entries WHERE base_id=bases.id) AS entry_count FROM bases WHERE id=?', (base_id,)).fetchone()
    if row is None:
        fail('Cette base est introuvable.', 404)
    result = dict(row)
    result['tags'] = json.loads(result['tags'])
    result['settings'] = {**DEFAULT_SETTINGS, **json.loads(result['settings'])}
    result['logo'] = library_organization.logo_payload(conn, base_id)
    return reference_library.enrich_base(conn, result)


def verify_folder(conn, folder_id):
    if folder_id is not None and (not isinstance(folder_id, int) or isinstance(folder_id, bool) or conn.execute('SELECT 1 FROM folders WHERE id=?', (folder_id,)).fetchone() is None):
        fail('Le dossier sélectionné est introuvable.')


def make_primary_exclusive(conn, current_id, settings):
    if not settings.get('primary'):
        return
    for row in conn.execute('SELECT id,settings FROM bases WHERE id<>?', (current_id,)).fetchall():
        other = json.loads(row['settings'])
        if other.get('color', 'white') == settings['color'] and other.get('primary'):
            other['primary'] = False
            conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps(other), row['id']))


