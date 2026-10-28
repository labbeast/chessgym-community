"""Folders, bases and paginated study-library reads."""
import json
from fastapi import APIRouter,Depends,Query,Response
import db
import entry_catalog
import game_search
import library_organization
import reference_library
import review_preferences
from accounts_api import require_user
from library_service import (now,fail,text_field,checked_tags,checked_settings,get_base,verify_folder,make_primary_exclusive)

router=APIRouter()

@router.get('/api/library')
def library(user=Depends(require_user)):
    with db.get_conn() as conn:
        folders = [dict(x) for x in conn.execute('SELECT * FROM folders ORDER BY name COLLATE NOCASE')]
        bases = [get_base(conn, row['id']) for row in conn.execute('SELECT id FROM bases ORDER BY sort_order,id').fetchall()]
    return {'folders': folders, 'bases': bases}


@router.post('/api/folders')
def create_folder(payload: dict, user=Depends(require_user)):
    name = text_field(payload.get('name'), 'Le nom')
    parent_id = payload.get('parent_id')
    with db.get_conn() as conn:
        verify_folder(conn, parent_id)
        cursor = conn.execute('INSERT INTO folders(name,parent_id) VALUES(?,?)', (name, parent_id))
        return {'id': cursor.lastrowid, 'name': name, 'parent_id': parent_id}


@router.patch('/api/folders/{folder_id}')
def rename_folder(folder_id: int, payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        row = conn.execute('SELECT * FROM folders WHERE id=?', (folder_id,)).fetchone()
        if row is None:
            fail('Ce dossier est introuvable.', 404)
        if set(payload) - {'name'}:
            fail('Seul le nom du dossier peut être modifié.')
        name = text_field(payload.get('name'), 'Le nom')
        conn.execute('UPDATE folders SET name=? WHERE id=?', (name, folder_id))
        return {**dict(row), 'name': name}


@router.delete('/api/folders/{folder_id}')
def delete_folder(folder_id: int, user=Depends(require_user)):
    with db.get_conn() as conn:
        # Lock before checking: a concurrent base move or folder creation must
        # not turn an apparently empty folder into a destructive deletion.
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute('SELECT 1 FROM folders WHERE id=?', (folder_id,)).fetchone() is None:
            fail('Ce dossier est introuvable.', 404)
        if (conn.execute('SELECT 1 FROM bases WHERE folder_id=? LIMIT 1', (folder_id,)).fetchone()
                or conn.execute('SELECT 1 FROM folders WHERE parent_id=? LIMIT 1', (folder_id,)).fetchone()):
            fail('Ce dossier contient une base ou un sous-dossier. Seuls les dossiers vides peuvent être supprimés.', 409)
        conn.execute('DELETE FROM folders WHERE id=?', (folder_id,))
    return {'ok': True}


@router.post('/api/bases')
def create_base(payload: dict, user=Depends(require_user)):
    name = text_field(payload.get('name'), 'Le nom')
    tags = checked_tags(payload.get('tags', []))
    folder_id = payload.get('folder_id')
    logo = library_organization.checked_logo(payload['logo']) if 'logo' in payload else None
    with db.get_conn() as conn:
        settings = checked_settings(payload.get('settings', {}), defaults=review_preferences.read(conn)['review_defaults'])
        verify_folder(conn, folder_id)
        cursor = conn.execute('INSERT INTO bases(name,folder_id,tags,settings,created_at) VALUES(?,?,?,?,?)', (name, folder_id, json.dumps(tags), json.dumps(settings), now()))
        make_primary_exclusive(conn, cursor.lastrowid, settings)
        if logo is not None:
            library_organization.save_logo(conn, cursor.lastrowid, logo)
        return get_base(conn, cursor.lastrowid)


@router.patch('/api/bases/{base_id}')
def update_base(base_id: int, payload: dict, user=Depends(require_user)):
    logo = library_organization.checked_logo(payload['logo']) if 'logo' in payload else None
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        old = get_base(conn, base_id)
        name = text_field(payload.get('name', old['name']), 'Le nom')
        tags = checked_tags(payload.get('tags', old['tags']))
        settings = checked_settings(payload.get('settings', {}), old['settings'])
        if old.get('reference') and any(settings[key] for key in ('review_enabled', 'is_repertoire', 'primary', 'played', 'reading_enabled')):
            fail('Copie les parties souhaitées dans une base d’étude pour les réviser, les modifier ou créer un répertoire.')
        folder_id = payload.get('folder_id', old['folder_id'])
        verify_folder(conn, folder_id)
        conn.execute('UPDATE bases SET name=?,folder_id=?,tags=?,settings=? WHERE id=?', (name, folder_id, json.dumps(tags), json.dumps(settings), base_id))
        make_primary_exclusive(conn, base_id, settings)
        if logo is not None:
            library_organization.save_logo(conn, base_id, logo)
        return get_base(conn, base_id)


@router.post('/api/library/bases/move')
def move_library_base(payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        order = library_organization.move_base(conn, payload)
        return {'base': get_base(conn, payload['base_id']), 'order': order}


@router.get('/api/bases/{base_id}/logo')
def base_logo(base_id: int, user=Depends(require_user)):
    with db.get_conn() as conn:
        get_base(conn, base_id)
        row = conn.execute('SELECT image FROM base_logos WHERE base_id=?', (base_id,)).fetchone()
        if row is None or row['image'] is None:
            fail('Cette base n’a pas d’image personnalisée.', 404)
        return Response(content=row['image'], media_type='image/png')


@router.delete('/api/bases/{base_id}')
def delete_base(base_id: int, user=Depends(require_user)):
    with reference_library.deletion_guard(base_id):
        with db.get_conn() as conn:
            get_base(conn, base_id)
            conn.execute('DELETE FROM bases WHERE id=?', (base_id,))
    return {'ok': True}


@router.get('/api/bases/{base_id}/entries')
def base_entries(base_id: int, offset: int = Query(0, ge=0), limit: int | None = Query(None, ge=1, le=200),
                 search: str = Query('', max_length=200), inclusion: str = 'all', sort: str | None = None,
                 descending: bool | None = None, around_id: int | None = Query(None, ge=1), user=Depends(require_user),
                 advanced: game_search.AdvancedGameSearch = Depends(game_search.parse_query)):
    return entry_catalog.page(base_id=base_id, offset=offset, limit=limit, search=search,
        inclusion=inclusion, sort=sort, descending=descending, around_id=around_id, advanced=advanced)


@router.get('/api/bases/{base_id}/directory')
def base_directory(base_id: int, kind: str = 'players', search: str = Query('', max_length=200),
                   offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                   sort: str = 'name', descending: bool = False,
                   player_key: str = Query('', max_length=2000), event_key: str = Query('', max_length=6000),
                   user=Depends(require_user)):
    import game_directory
    return game_directory.study_directory(base_id=base_id, kind=kind, search=search, offset=offset, limit=limit,
                                          sort=sort, descending=descending, player_key=player_key, event_key=event_key)


