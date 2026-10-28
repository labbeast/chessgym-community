"""Stable local-profile identity and application status; no login or sessions."""
import json

from fastapi import APIRouter, Request

import db
from local_access import require_local_request
from version import VERSION

router = APIRouter()


def require_user(request: Request):
    """Retain the internal owner contract without asking the person to log in."""
    require_local_request(request)
    return db.ensure_local_owner()


@router.get('/api/status')
def status(request: Request):
    import engine
    import resource_setup
    user = require_user(request)
    with db.get_conn() as conn:
        saved_epoch = conn.execute("SELECT value FROM preferences WHERE key='workspace_epoch'").fetchone()
        workspace_epoch = json.loads(saved_epoch[0]) if saved_epoch else 'initial'
    return {
        'setup_required': False, 'authenticated': True, 'local_mode': True,
        'username': user['username'], 'engine': engine.status(), 'version': VERSION,
        'workspace_epoch': workspace_epoch, 'resources_setup_required': resource_setup.setup_required(),
        'capabilities': {
            'workspace_persistence': True, 'entry_revisions': True, 'personal_backup': True,
            'backup_automation': True, 'review_receipts': True, 'review_preferences': True,
            'entry_pagination': True, 'review_sessions': True, 'daily_review_sessions': True,
            'review_maintenance': True, 'learning_context': True, 'resource_settings': True,
            'engine_management': True, 'setup_resources': True, 'app_updates': True,
            'computer_history': True, 'color_training': True, 'training_history': True,
        },
    }
