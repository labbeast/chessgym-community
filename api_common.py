"""Small HTTP primitives shared without importing application or domain services."""
from datetime import datetime, timezone

from fastapi import HTTPException


def now():
    return datetime.now(timezone.utc).isoformat()



def fail(message, status=400):
    raise HTTPException(status_code=status, detail=message)

