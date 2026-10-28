import pytest
import run


@pytest.mark.parametrize('host', ['127.0.0.1', '127.0.0.2', '::1', 'localhost'])
def test_launcher_accepts_only_loopback_bindings(monkeypatch, host):
    monkeypatch.setenv('CHESSGYM_HOST', host)
    assert run.local_host() == host


@pytest.mark.parametrize('host', ['0.0.0.0', '::', '192.168.1.5', 'example.com', ''])
def test_launcher_rejects_network_exposure(monkeypatch, host):
    monkeypatch.setenv('CHESSGYM_HOST', host)
    with pytest.raises(SystemExit, match='uniquement depuis cet ordinateur'):
        run.local_host()


def test_launcher_defaults_to_loopback(monkeypatch):
    monkeypatch.delenv('CHESSGYM_HOST', raising=False)
    assert run.local_host() == '127.0.0.1'
