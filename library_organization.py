"""Portable library ordering and small, normalized database logos."""
import base64
import binascii
import hashlib
import io
import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

ICONS = frozenset(('database', 'book', 'puzzle', 'knight', 'pawn', 'rook', 'king',
                   'target', 'trophy', 'star', 'lightning', 'graduation'))
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
FORMATS = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}


def invalid(message, status=400):
    raise HTTPException(status_code=status, detail=message)


def positive_id(value):
    return type(value) is int and 1 <= value <= 9223372036854775807


def logo_payload(conn, base_id):
    row = conn.execute('SELECT icon,digest FROM base_logos WHERE base_id=?', (base_id,)).fetchone()
    if row is None:
        return {'kind': 'icon', 'icon': 'database'}
    if row['digest']:
        return {'kind': 'image', 'icon': row['icon'],
                'image_url': f"/api/bases/{base_id}/logo?v={row['digest']}"}
    return {'kind': 'icon', 'icon': row['icon']}


def checked_logo(value):
    if not isinstance(value, dict):
        invalid('Le logo doit être une icône ou une image.')
    if value.get('kind') == 'icon':
        if set(value) != {'kind', 'icon'} or not isinstance(value.get('icon'), str) or value['icon'] not in ICONS:
            invalid('Choisis une icône proposée pour la base.')
        return {'icon': value['icon'], 'image': None, 'digest': None}
    if value.get('kind') != 'image' or set(value) != {'kind', 'data_url'}:
        invalid('Choisis une icône proposée ou une image PNG, JPEG ou WebP.')
    data_url = value['data_url']
    if not isinstance(data_url, str):
        invalid('Le fichier image est invalide.')
    prefix, separator, encoded = data_url.partition(',')
    mime = prefix[5:-7] if prefix.startswith('data:') and prefix.endswith(';base64') else None
    if not separator or mime not in FORMATS:
        invalid('Les logos acceptent les images PNG, JPEG et WebP.')
    if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        invalid('Le logo est limité à 5 Mo.', 413)
    try:
        original = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        invalid('Le fichier image est invalide.')
    if not original:
        invalid('Le fichier image est vide.')
    if len(original) > MAX_IMAGE_BYTES:
        invalid('Le logo est limité à 5 Mo.', 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(original)) as probe:
                if probe.format != FORMATS[mime]:
                    invalid('Le contenu du fichier ne correspond pas au format de l’image.')
                if probe.width * probe.height > MAX_IMAGE_PIXELS:
                    invalid('Choisis une image de 16 millions de pixels au maximum.')
                probe.verify()
            with Image.open(io.BytesIO(original)) as opened:
                oriented = ImageOps.exif_transpose(opened)
                oriented.thumbnail((512, 512), Image.Resampling.LANCZOS)
                rgba = oriented.convert('RGBA')
                # A new image carries no EXIF, comments, profiles or uploaded metadata.
                clean = Image.new('RGBA', rgba.size)
                clean.paste(rgba)
                output = io.BytesIO()
                clean.save(output, format='PNG')
                normalized = output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        invalid('Ce fichier ne peut pas être lu comme une image valide.')
    return {'icon': 'database', 'image': normalized,
            'digest': hashlib.sha256(normalized).hexdigest()[:24]}


def save_logo(conn, base_id, logo):
    conn.execute('''INSERT INTO base_logos(base_id,icon,image,digest) VALUES(?,?,?,?)
        ON CONFLICT(base_id) DO UPDATE SET icon=excluded.icon,image=excluded.image,digest=excluded.digest''',
                 (base_id, logo['icon'], logo['image'], logo['digest']))


def move_base(conn, payload):
    """Validate the entire move before updating either location or global order."""
    if set(payload) - {'base_id', 'folder_id', 'before_id', 'after_id'}:
        invalid('Ce déplacement contient des options inconnues.')
    base_id = payload.get('base_id')
    if not positive_id(base_id):
        invalid('Choisis une base valide à déplacer.')
    if 'before_id' in payload and 'after_id' in payload:
        invalid('Choisis une seule position pour la base.')
    anchor_key = next((key for key in ('before_id', 'after_id') if key in payload), None)
    anchor_id = payload.get(anchor_key) if anchor_key else None
    if anchor_key and (not positive_id(anchor_id) or anchor_id == base_id):
        invalid('Choisis une autre base comme repère.')
    rows = conn.execute('SELECT id,folder_id FROM bases ORDER BY sort_order,id').fetchall()
    by_id = {row['id']: row for row in rows}
    if base_id not in by_id:
        invalid('Cette base est introuvable.', 404)
    folder_id = payload.get('folder_id', by_id[base_id]['folder_id'])
    if folder_id is not None and (not positive_id(folder_id) or conn.execute('SELECT 1 FROM folders WHERE id=?', (folder_id,)).fetchone() is None):
        invalid('Le dossier de destination est introuvable.', 404)
    if anchor_id is not None:
        if anchor_id not in by_id:
            invalid('La base de référence est introuvable. Actualise la bibliothèque.', 409)
        if 'folder_id' in payload and by_id[anchor_id]['folder_id'] != folder_id:
            invalid('La base de référence ne se trouve plus dans le dossier de destination.', 409)
    order = [row['id'] for row in rows if row['id'] != base_id]
    index = len(order) if anchor_id is None else order.index(anchor_id) + (anchor_key == 'after_id')
    order.insert(index, base_id)
    conn.execute('UPDATE bases SET folder_id=? WHERE id=?', (folder_id, base_id))
    conn.executemany('UPDATE bases SET sort_order=? WHERE id=?', enumerate(order))
    return order
