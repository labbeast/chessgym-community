"""Supported interface locales; chess notation and user content stay unchanged."""
from typing import Literal, get_args

Language = Literal['fr', 'en', 'es', 'de', 'pt', 'it', 'ru', 'zh-CN', 'ja', 'ko', 'ar', 'hi']
LANGUAGES = get_args(Language)
