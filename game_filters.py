"""One validated population for in-memory study games and SQL references."""
from dataclasses import dataclass

from game_metadata import SPEEDS


def normalize_speeds(speeds=None, *, speed=None):
    """Empty means every cadence, including records without TimeControl."""
    if speeds is None:
        speeds = []
    if not isinstance(speeds, (list, tuple, set, frozenset)):
        raise ValueError('Les cadences doivent être une liste.')
    if any(not isinstance(item, str) or item not in SPEEDS for item in speeds):
        raise ValueError('Cadence inconnue.')
    selected = set(speeds)
    if speed:
        if not isinstance(speed, str) or speed not in SPEEDS:
            raise ValueError('Cadence inconnue.')
        if selected and selected != {speed}:
            raise ValueError('Choisis speed ou speeds, sans filtres de cadence contradictoires.')
        selected.add(speed)
    return tuple(item for item in SPEEDS if item in selected)


@dataclass(frozen=True, slots=True)
class GameFilter:
    rating_min: int | None = None
    rating_max: int | None = None
    speeds: tuple[str, ...] = ()
    from_year: int | None = None
    to_year: int | None = None

    def __post_init__(self):
        for value in (self.rating_min, self.rating_max):
            if value is not None and (type(value) is not int or not 0 <= value <= 9999):
                raise ValueError('Filtre de classement invalide.')
        if self.rating_min is not None and self.rating_max is not None and self.rating_min > self.rating_max:
            raise ValueError('La plage de classement est inversée.')
        object.__setattr__(self, 'speeds', normalize_speeds(self.speeds))
        for value in (self.from_year, self.to_year):
            if value is not None and (not isinstance(value, int) or not 1 <= value <= 9999):
                raise ValueError('Année invalide.')
        if self.from_year is not None and self.to_year is not None and self.from_year > self.to_year:
            raise ValueError('La plage d’années est inversée.')

    @staticmethod
    def _within(value, minimum, maximum):
        return ((minimum is None or value is not None and value >= minimum)
                and (maximum is None or value is not None and value <= maximum))

    def matches(self, game):
        if self.speeds and (game.speed or 'unknown') not in self.speeds:
            return False
        return (all(self._within(value, self.rating_min, self.rating_max)
                    for value in (game.white_elo, game.black_elo))
                and self._within(getattr(game, 'year', None), self.from_year, self.to_year))

    def sql(self):
        """Parameterized predicates for the fixed internal game-table alias g."""
        clauses, values = [], []
        for value, operation in ((self.rating_min, '>='), (self.rating_max, '<=')):
            if value is not None:
                clauses.extend([f'g.white_elo {operation} ?', f'g.black_elo {operation} ?'])
                values.extend([value, value])
        if self.speeds:
            cadence = 'g.speed IN (' + ','.join('?' for _ in self.speeds) + ')'
            if 'unknown' in self.speeds:
                cadence = '(' + cadence + ' OR g.speed IS NULL)'
            clauses.append(cadence)
            values.extend(self.speeds)
        for value, operation in ((self.from_year, '>='), (self.to_year, '<=')):
            if value is not None:
                clauses.append(f'g.year {operation} ?')
                values.append(value)
        return clauses, values


def sql_filters(*, rating_min=None, rating_max=None, speed=None, speeds=None, from_year=None, to_year=None):
    return GameFilter(rating_min, rating_max, normalize_speeds(speeds, speed=speed), from_year, to_year).sql()
