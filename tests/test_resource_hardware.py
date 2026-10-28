import pytest
"""Host detection respects affinity, physical RAM and container capacity."""
from types import SimpleNamespace

import resource_hardware as hardware


def test_affinity_limits_logical_cpu_count(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(cpu_count=lambda: 32, sched_getaffinity=lambda _: {0, 1, 2, 3}, name='posix'))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='other'))
    assert hardware.usable_cpus() == (4, True)


def test_unknown_cpu_and_memory_remain_explicit(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(cpu_count=lambda: None, name='other'))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='other'))
    assert hardware.snapshot() == {'cpu_count': 1, 'cpu_known': False, 'memory_mb': None, 'memory_known': False}


def test_posix_physical_memory_uses_bytes_per_page(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(name='posix', sysconf=lambda key: {'SC_PHYS_PAGES': 2097152, 'SC_PAGE_SIZE': 4096}[key]))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='other'))
    assert hardware.physical_memory_mb() == 8192


def test_windows_memory_status_and_failed_detection(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(name='nt'))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='win32'))
    def read(pointer):
        pointer._obj.total_phys = 16 * 1024 ** 3
        return 1
    monkeypatch.setattr(hardware.ctypes, 'WinDLL', lambda *args, **kwargs: SimpleNamespace(GlobalMemoryStatusEx=read), raising=False)
    assert hardware.physical_memory_mb() == 16384
    monkeypatch.setattr(hardware.ctypes, 'WinDLL', lambda *args, **kwargs: SimpleNamespace(GlobalMemoryStatusEx=lambda _: 0))
    assert hardware.physical_memory_mb() is None


def test_container_limits_can_be_lower_than_host_capacity(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(name='posix', cpu_count=lambda: 32, sched_getaffinity=lambda _: set(range(16)), sysconf=lambda key: {'SC_PHYS_PAGES': 2097152, 'SC_PAGE_SIZE': 4096}[key]))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='linux'))
    files = {'/sys/fs/cgroup/cpu.max': '250000 100000', '/sys/fs/cgroup/memory.max': str(1024 ** 3), '/sys/fs/cgroup/memory/memory.limit_in_bytes': 'max'}
    monkeypatch.setattr(hardware, 'Path', lambda name: SimpleNamespace(read_text=lambda: files[name]))
    assert hardware.usable_cpus() == (2, True)
    assert hardware.physical_memory_mb() == 1024


def test_unlimited_container_sentinel_does_not_fake_known_memory(monkeypatch):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(name='posix'))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='linux'))
    files = {'/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/memory/memory.limit_in_bytes': str((1 << 63) - 4096)}
    monkeypatch.setattr(hardware, 'Path', lambda name: SimpleNamespace(read_text=lambda: files[name]))
    assert hardware.physical_memory_mb() is None


@pytest.mark.parametrize('controller', ['cpu', 'cpu,cpuacct'])
def test_cgroup_v1_cpu_quota_limits_usable_cores(monkeypatch, controller):
    monkeypatch.setattr(hardware, 'os', SimpleNamespace(name='posix', cpu_count=lambda: 32, sched_getaffinity=lambda _: set(range(32))))
    monkeypatch.setattr(hardware, 'sys', SimpleNamespace(platform='linux'))
    files = {'/sys/fs/cgroup/' + controller + '/cpu.cfs_quota_us': '100000',
             '/sys/fs/cgroup/' + controller + '/cpu.cfs_period_us': '100000'}
    def read(name):
        if name not in files:
            raise FileNotFoundError(name)
        return files[name]
    monkeypatch.setattr(hardware, 'Path', lambda name: SimpleNamespace(read_text=lambda: read(name)))
    assert hardware.usable_cpus() == (1, True)
