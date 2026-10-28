"""HTTP test client using the same loopback origin as the desktop launcher.

Explicit remote clients/hosts remain available for access-control tests.
"""
from fastapi.testclient import TestClient as _TestClient


class TestClient(_TestClient):
    __test__ = False

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('base_url', 'http://localhost')
        kwargs.setdefault('client', ('127.0.0.1', 50000))
        super().__init__(*args, **kwargs)
