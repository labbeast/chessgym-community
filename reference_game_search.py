"""Read-only metadata expressions for advanced reference searches.

Old reference stores work without a reimport or schema change. Only metadata is
read; game blobs and position indexes are never decompressed for these filters.
"""
import json

import game_search


def install(conn):
    conn.create_function('cg_fold', 1, game_search.fold, deterministic=True)
    conn.create_function('cg_player_key', 1, game_search.player_key, deterministic=True)
    conn.create_function('cg_event_key', 1, lambda value: game_search.event_key(json.loads(value)), deterministic=True)
    conn.create_function('cg_date_start', 2, lambda value, fallback: game_search.date_bounds(value, fallback)[0], deterministic=True)
    conn.create_function('cg_date_end', 2, lambda value, fallback: game_search.date_bounds(value, fallback)[1], deterministic=True)
    conn.create_function('cg_eco', 1, game_search.normalize_eco_header, deterministic=True)


def columns():
    header = lambda tag: "json_extract(g.headers,'$." + tag + "')"
    result = {key: 'cg_fold(g.' + key + ')' for key in ('white', 'black', 'event')}
    result.update({key: 'cg_fold(' + header(tag) + ')' for key, tag in
                   (('site', 'Site'), ('round', 'Round'), ('opening', 'Opening'))})
    result.update(date_start='cg_date_start(' + header('Date') + ',' + header('UTCDate') + ')',
                  date_end='cg_date_end(' + header('Date') + ',' + header('UTCDate') + ')',
                  white_elo='g.white_elo', black_elo='g.black_elo', speed='g.speed',
                  result="coalesce(" + header('Result') + ",'*')", eco='cg_eco(' + header('ECO') + ')',
                  player_key_white='cg_player_key(g.white)', player_key_black='cg_player_key(g.black)',
                  event_key='cg_event_key(g.headers)')
    return result
