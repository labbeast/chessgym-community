"""Validation for saved native launch settings; no native activity is created."""
from __future__ import annotations
import copy
from pydantic import ValidationError
import training_programs as p


def checked(activity, value):
    if not isinstance(value, dict):
        p.error('Les réglages du bloc doivent être un objet.')
    try:
        if len(p.encode(value)) > 20000:
            p.error('Les réglages du bloc sont trop volumineux.')
    except (ValueError, TypeError):
        p.error('Les réglages du bloc doivent être des valeurs JSON finies.')
    if not value:
        return {}
    option = copy.deepcopy(value)
    def allowed(keys):
        if set(option) - set(keys):
            p.error('Réglage inconnu pour cette activité.')
    def enum(key, choices):
        if key in option and option[key] not in choices:
            p.error('Valeur invalide pour le réglage ' + key + '.')
    def boolean(key):
        if key in option and type(option[key]) is not bool:
            p.error('Le réglage ' + key + ' doit être oui ou non.')
    try:
        if activity == 'review':
            allowed(('selection',))
            enum('selection', ('review', 'learn', 'both'))
        elif activity == 'puzzles':
            import puzzle_training
            allowed(('mode', 'rated', 'selection', 'filters'))
            enum('mode', ('classic', 'storm')); enum('selection', ('standard', 'custom')); boolean('rated')
            if option.get('mode') == 'storm' and 'rated' in option:
                option['rated'] = False
            if 'filters' in option:
                option['filters'] = puzzle_training.Filters.model_validate(option['filters']).checked()
        elif activity == 'guess':
            allowed(('side',))
            enum('side', ('white', 'black', 'both'))
        elif activity == 'computer':
            allowed(('provider', 'skill', 'level', 'time_ms', 'side', 'start', 'time_control', 'clock_minutes', 'clock_increment'))
            enum('provider', ('stockfish', 'maia')); enum('side', ('white', 'black', 'random'))
            enum('start', ('initial',)); enum('time_control', ('unlimited', 'custom'))
            for key, low, high in [('skill', 0, 20), ('level', 600, 2600), ('time_ms', 100, 2000), ('clock_increment', 0, 180)]:
                if key in option:
                    p.number(option[key], key, low=low, high=high, integer=True)
            if 'clock_minutes' in option:
                p.number(option['clock_minutes'], 'minutes par joueur', low=1, high=1440)
        elif activity in ('blindfold', 'coordinates', 'color'):
            if activity == 'blindfold':
                import training_skills
                model = training_skills.BlindfoldConfig
            elif activity == 'coordinates':
                import training_skills
                model = training_skills.CoordinateConfig
            else:
                import color_training
                model = color_training.ColorConfig
            allowed(set(model.model_fields) - {'training_run_id', 'request_id', 'entry_id', 'language'})
            normalized = model.model_validate(option).model_dump()
            option = {key: normalized[key] for key in option}
            if activity == 'blindfold' and option.get('rating_min', 0) > option.get('rating_max', 4000):
                p.error('La cote minimale doit être inférieure à la cote maximale.')
        else:
            p.error('Cette activité ne possède pas de réglages de lancement.')
    except ValidationError:
        p.error('Un réglage de lancement est invalide pour cet outil.')
    return option
