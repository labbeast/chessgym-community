"""Lossless chess content helpers: full PGN trees, NAGs and machine comments."""
import io
import re
import chess
import chess.pgn

MAX_PGN_BYTES = 20 * 1024 * 1024
MACHINE_TAG = re.compile(r"\[%[^\]]*\]")
NULL_TOKENS = {'--', 'Z0', '0000', '@@@@'}
TOKEN = re.compile(r"(?:\d+\.(?:\.\.)?|\$\d+|1/2-1/2|1-0|0-1|\*|\(|\)|!!|\?\?|!\?|\?!|!|\?|--|Z0|0000|@@@@|(?:O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?[x-]?[a-h][1-8](?:=?[QRBNqrbn])?)[+#]?|e\.p\.)")
HEADER = re.compile(r'\[\s*[A-Za-z0-9][A-Za-z0-9_+#=:-]*\s+"(?:[^"\\\r\n]|\\[^\r\n])*"\s*\]')


def validate_board(fen):
    try:
        board = chess.Board(fen)
    except (ValueError, TypeError) as exc:
        raise ValueError("Position FEN invalide.") from exc
    if not board.is_valid():
        raise ValueError("Position impossible : vérifie les rois, les pions et le trait.")
    return board


def _validate_lexical(text):
    """python-chess ignores unknown text; reject it so imports never silently truncate."""
    i, depth, move_count = 0, 0, 0
    while i < len(text):
        c = text[i]
        if c.isspace() or c == '\ufeff':
            i += 1
            continue
        if c == '%' and (i == 0 or text[i-1] in '\r\n'):
            end = text.find('\n', i)
            i = len(text) if end < 0 else end + 1
            continue
        if c == ';':
            end = text.find('\n', i)
            i = len(text) if end < 0 else end + 1
            continue
        if c == '{':
            end = text.find('}', i + 1)
            if end < 0:
                raise ValueError("Commentaire PGN non fermé.")
            i = end + 1
            continue
        if c == '[':
            match = HEADER.match(text, i)
            if not match or depth:
                raise ValueError("En-tête PGN invalide ou placé dans une variante.")
            i = match.end()
            continue
        match = TOKEN.match(text, i)
        if not match:
            raise ValueError("Texte PGN non reconnu près de : " + repr(text[i:i+35]))
        token = match.group()
        if token in NULL_TOKENS or (re.match(r'^(?:[KQRBNa-hO]|0-0)', token) and token != 'e.p.'):
            move_count += 1
        if token == '(':
            depth += 1
        elif token == ')':
            depth -= 1
            if depth < 0:
                raise ValueError("Parenthèse de variante PGN inattendue.")
        i = match.end()
    if depth:
        raise ValueError("Variante PGN non fermée.")
    return move_count


def _validate_game_moves(game):
    """Validate all branches in linear time, including explicit study passes."""
    board = validate_board(game.board().fen())
    count = 0
    # A first child remains hypothetical when an earlier ancestor branched.
    stack = [(iter(enumerate(game.variations)), True)]
    while stack:
        children, on_mainline = stack[-1]
        try:
            index, node = next(children)
        except StopIteration:
            stack.pop()
            if stack:
                board.pop()
            continue
        child_mainline = on_mainline and index == 0
        if node.move == chess.Move.null():
            if child_mainline:
                raise ValueError("Un coup nul pédagogique doit rester dans une variante, pas dans la ligne principale.")
            if board.is_check():
                raise ValueError("Un coup nul pédagogique ne peut pas ignorer un échec.")
        elif node.move is None or node.move not in board.legal_moves:
            raise ValueError("Le PGN contient un coup illégal.")
        board.push(node.move)
        count += 1
        stack.append((iter(enumerate(node.variations)), child_mainline))
    return count


def _normalize_comment_chapter(game):
    """Treat a lone annotated pass as a course text chapter, not a played move.

    Some course exports attach their introduction to ``1. Z0``. Keep its text
    at the initial position so it remains editable without changing the turn
    or introducing an illegal training answer. Do not discard move annotations
    or accept a pass in any actual line of play.
    """
    if len(game.variations) != 1 or game.headers.get('Result', '*') != '*':
        return 0
    node = game.variations[0]
    comments = [game.comment, node.starting_comment, node.comment]
    if (node.move != chess.Move.null() or node.variations or node.nags
            or not any(comment.strip() for comment in comments)
            or game.board().is_check()):
        return 0
    game.comment = '\n\n'.join(comment for comment in comments if comment.strip())
    game.variations.clear()
    if 'PlyCount' in game.headers:
        game.headers['PlyCount'] = '0'
    return 1


def parse_games(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Le PGN est vide.")
    if len(text.encode('utf-8')) > MAX_PGN_BYTES:
        raise ValueError("Ce PGN dépasse la limite de 20 Mo par import.")
    expected_moves = _validate_lexical(text)
    stream = io.StringIO(text.lstrip('\ufeff'))
    games = []
    actual_moves = 0
    while True:
        try:
            game = chess.pgn.read_game(stream, Visitor=DecodedHeadersBuilder)
        except Exception as exc:
            raise ValueError("Lecture PGN impossible : " + str(exc)) from exc
        if game is None:
            break
        if game.errors:
            raise ValueError("Coups PGN invalides : " + str(game.errors[0]))
        if game.headers.get('Variant', 'Standard').lower() not in ('standard', 'chess', 'normal'):
            raise ValueError("Cette première version prend en charge les échecs classiques.")
        # Count the recognized chapter marker too: the strict lexical check
        # must still catch any other tokens silently ignored by the PGN reader.
        actual_moves += _normalize_comment_chapter(game)
        actual_moves += _validate_game_moves(game)
        games.append(game)
        if len(games) > 10000:
            raise ValueError("Import limité à 10 000 parties à la fois.")
    if not games:
        raise ValueError("Aucune partie ou position PGN reconnue.")
    if actual_moves != expected_moves:
        raise ValueError("Le PGN contient des coups hors d’une partie ou ignorés par le lecteur.")
    return games


def load_game(text):
    games = parse_games(text)
    if len(games) != 1:
        raise ValueError("Cette action attend une seule partie PGN.")
    return games[0]


def walk_nodes(game):
    stack = [game]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node.variations))


def node_at(game, path=''):
    if path is None:
        path = ''
    if not isinstance(path, str) or (path and not re.fullmatch(r'\d+(?:\.\d+)*', path)):
        raise ValueError("Chemin de variante invalide.")
    node = game
    if path:
        for part in path.split('.'):
            index = int(part)
            if index >= len(node.variations):
                raise ValueError("Ce coup n’existe pas dans la partie.")
            node = node.variations[index]
    return node


class DecodedHeadersBuilder(chess.pgn.GameBuilder):
    def visit_header(self, tagname, tagvalue):
        # python-chess keeps PGN escape sequences verbatim. Decode exactly the
        # two escapes defined by PGN; unknown sequences keep their backslash.
        value = re.sub(r'\\(["\\])', lambda match: match[1], tagvalue)
        return super().visit_header(tagname, value)


class EscapedHeadersExporter(chess.pgn.StringExporter):
    def visit_header(self, tagname, tagvalue):
        escaped = str(tagvalue).replace('\\', '\\\\').replace('"', '\\"')
        return super().visit_header(tagname, escaped)


def export_game(game):
    return game.accept(EscapedHeadersExporter(headers=True, variations=True, comments=True))


STRUCTURAL_HEADERS = {'FEN', 'SetUp', 'Variant'}
REQUIRED_HEADERS = {'Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'}
HEADER_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_+#=:-]*')


def patch_headers(game, patch):
    """Validate the complete patch before applying it to the existing tree."""
    if not isinstance(patch, dict) or len(patch) > 150:
        raise ValueError('Les informations PGN doivent être un objet de 150 champs au maximum.')
    updates = {}
    for key, value in patch.items():
        if not isinstance(key, str) or len(key) > 80 or not HEADER_NAME.fullmatch(key):
            raise ValueError('Nom de champ PGN invalide.')
        if key.casefold() in {x.casefold() for x in STRUCTURAL_HEADERS}:
            raise ValueError('FEN, SetUp et Variant se modifient avec l’éditeur de position.')
        if value is not None and (not isinstance(value, str) or len(value) > 2000 or any(ord(c) < 32 or ord(c) == 127 for c in value)):
            raise ValueError('La valeur de ' + key + ' doit être un texte sur une seule ligne (2 000 caractères maximum).')
        if value is None or value == '':
            updates[key] = ('*' if key == 'Result' else '?') if key in REQUIRED_HEADERS else None
            continue
        if key == 'Result' and value not in ('*', '1-0', '0-1', '1/2-1/2'):
            raise ValueError('Résultat PGN invalide.')
        if key in ('WhiteElo', 'BlackElo') and not re.fullmatch(r'(?:\?|\-|\d{1,4})', value):
            raise ValueError('Le classement Elo doit être un nombre, ? ou -.')
        if key in ('Date', 'EventDate'):
            if not re.fullmatch(r'(?:\d{4}|\?{4})\.(?:\d{2}|\?{2})\.(?:\d{2}|\?{2})', value) and value != '?':
                raise ValueError('La date doit suivre AAAA.MM.JJ ; les éléments inconnus peuvent être remplacés par des ?.')
            if value != '?':
                year, month, day = value.split('.')
                if month != '??' and not 1 <= int(month) <= 12 or day != '??' and not 1 <= int(day) <= 31:
                    raise ValueError('Le mois ou le jour de la date est invalide.')
        if key == 'ECO' and not re.fullmatch(r'[A-E]\d{2}|\?', value):
            raise ValueError('Le code ECO doit aller de A00 à E99.')
        if key == 'TimeControl' and value not in ('-', '?') and not all(re.fullmatch(r'(?:(?:[1-9]\d*/)?\d+(?:\+\d+)?|\*\d+)', segment) for segment in value.split(':')):
            raise ValueError('Cadence PGN invalide. Exemple : 600+5 ou 40/7200:3600.')
        updates[key] = value
    for key, value in updates.items():
        if value is None:
            game.headers.pop(key, None)
        else:
            game.headers[key] = value
    return game


def line_positions(board, moves):
    if not isinstance(moves, list) or not 1 <= len(moves) <= 200:
        raise ValueError('La ligne doit contenir entre 1 et 200 coups UCI.')
    working = board.copy()
    positions = []
    for token in moves:
        try:
            move = chess.Move.from_uci(token) if isinstance(token, str) else None
        except ValueError:
            move = None
        if move is None or move not in working.legal_moves:
            raise ValueError('La ligne contient un coup illégal : ' + str(token)[:20])
        san = working.san(move)
        working.push(move)
        positions.append({'uci': move.uci(), 'san': san, 'fen': working.fen(), 'game_over': working.is_game_over(), 'result': working.result()})
    return positions


def human_comment(comment):
    return MACHINE_TAG.sub('', comment or '').strip()


def merge_comment(existing, human):
    tags = MACHINE_TAG.findall(existing or '')
    clean = human_comment(human)
    return ' '.join([x for x in [clean, *tags] if x])


def _elapsed_from_clocks(node, clock, previous_clock, increment):
    explicit = node.emt()
    if explicit is not None:
        return explicit
    if clock is None or previous_clock is None or increment is None:
        return None
    value = previous_clock + increment - clock
    return round(value, 3) if value >= 0 else None


def _elapsed(node, game):
    """Move time for report callers, without replaying parent positions."""
    if node.parent is None:
        return node.emt()
    control = re.fullmatch(r'(\d+)(?:\+(\d+))?', game.headers.get('TimeControl', ''))
    increment = float(control[2] or 0) if control else None
    # In a standard PGN each move (including a study pass) changes the turn.
    # The preceding move by this side is therefore exactly two plies earlier.
    previous = node.parent.parent
    if previous is not None and previous.parent is not None:
        previous_clock = previous.clock()
    else:
        previous_clock = float(control[1]) if control and game.board().fen() == chess.STARTING_FEN else None
    return _elapsed_from_clocks(node, node.clock(), previous_clock, increment)


def game_payload(game):
    """Serialize every branch in one board walk instead of replaying ancestors.

    Board and clock state are restored together when leaving a variation, so
    sibling annotations cannot affect its positions or elapsed-move estimates.
    """
    board = game.board()
    control = re.fullmatch(r'(\d+)(?:\+(\d+))?', game.headers.get('TimeControl', ''))
    increment = float(control[2] or 0) if control else None
    initial_clock = float(control[1]) if control and board.fen() == chess.STARTING_FEN else None
    clocks = {chess.WHITE: initial_clock, chess.BLACK: initial_clock}
    nodes = []

    def append(node, path, parent, san=None, clock=None, elapsed=None):
        nodes.append({
            'path': path, 'parent': parent, 'fen': board.fen(),
            'san': san,
            'uci': node.move.uci() if node.parent else None,
            'comment': node.comment,
            'starting_comment': getattr(node, 'starting_comment', ''),
            'nags': sorted(node.nags), 'clock': clock, 'elapsed': elapsed,
            'children': [path + '.' + str(i) if path else str(i) for i in range(len(node.variations))],
        })

    append(game, '', None, clock=game.clock())
    stack = [(iter(enumerate(game.variations)), '', None, None)]
    while stack:
        children, parent_path, restore_color, restore_clock = stack[-1]
        try:
            index, node = next(children)
        except StopIteration:
            stack.pop()
            if restore_color is not None:
                board.pop()
                clocks[restore_color] = restore_clock
            continue
        path = parent_path + '.' + str(index) if parent_path else str(index)
        color, previous_clock = board.turn, clocks[board.turn]
        san, clock = board.san(node.move), node.clock()
        elapsed = _elapsed_from_clocks(node, clock, previous_clock, increment)
        board.push(node.move)
        # A missing clock must remain unknown rather than skipping a move.
        clocks[color] = clock
        append(node, path, parent_path, san, clock, elapsed)
        stack.append((iter(enumerate(node.variations)), path, color, previous_clock))
    return {'headers': dict(game.headers), 'pgn': export_game(game), 'nodes': nodes}


def path_of(node):
    """Return an attached node's path by object identity, never by its position."""
    parts = []
    while node.parent is not None:
        parent = node.parent
        index = next((i for i, child in enumerate(parent.variations) if child is node), None)
        if index is None:
            raise ValueError('Ce coup a été supprimé de la partie.')
        parts.append(str(index))
        node = parent
    return '.'.join(reversed(parts))


def edit_tree(game, path, action, start_path=''):
    """Transform a PGN in place, retaining selected/review nodes across reordering."""
    if action not in ('delete', 'up', 'down', 'promote', 'main'):
        raise ValueError('Action de variante inconnue.')
    selected = node_at(game, path)
    start = node_at(game, start_path)
    changed = False
    original_branches = []
    if action == 'delete':
        if selected.parent is None:
            raise ValueError('La position de départ ne peut pas être supprimée.')
        removed = selected
        selected = removed.parent
        ancestor = start
        while ancestor is not None:
            if ancestor is removed:
                start = selected
                break
            ancestor = ancestor.parent
        original_branches.append((selected, list(selected.variations)))
        selected.variations.remove(removed)
        changed = True
    elif action == 'main':
        branch = selected
        while branch.parent is not None:
            parent = branch.parent
            index = parent.variations.index(branch)
            if index:
                original_branches.append((parent, list(parent.variations)))
                parent.variations.insert(0, parent.variations.pop(index))
                changed = True
            branch = parent
    else:
        branch = selected
        while branch.parent is not None and len(branch.parent.variations) < 2:
            branch = branch.parent
        if branch.parent is not None:
            siblings = branch.parent.variations
            index = siblings.index(branch)
            target = max(0, index-1) if action == 'up' else min(len(siblings)-1, index+1) if action == 'down' else 0
            if index != target:
                original_branches.append((branch.parent, list(siblings)))
                siblings.insert(target, siblings.pop(index))
                changed = True
    if changed and any(node.move == chess.Move.null() for node in game.mainline()):
        for parent, children in reversed(original_branches):
            parent.variations[:] = children
        raise ValueError("Cette action placerait un coup nul pédagogique dans la ligne principale. Garde cette analyse dans une variante.")
    return {'path': path_of(selected), 'start_path': path_of(start), 'changed': changed}
