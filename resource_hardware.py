"""Read host capacity without installing a system-monitoring dependency."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import subprocess
import sys

_MIB = 1024 * 1024


def usable_cpus():
    detected = os.cpu_count()
    known = isinstance(detected, int) and detected > 0
    count = detected if known else 1
    if hasattr(os, 'sched_getaffinity'):
        try:
            affinity = len(os.sched_getaffinity(0))
            if affinity > 0:
                count = min(count, affinity) if known else affinity
                known = True
        except (OSError, ValueError):
            pass
    elif os.name == 'nt':
        try:
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            process_mask, system_mask = ctypes.c_size_t(), ctypes.c_size_t()
            kernel.GetCurrentProcess.restype = ctypes.c_void_p
            kernel.GetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
            if kernel.GetProcessAffinityMask(kernel.GetCurrentProcess(), ctypes.byref(process_mask), ctypes.byref(system_mask)):
                affinity = process_mask.value.bit_count()
                if affinity:
                    count = min(count, affinity) if known else affinity
                    known = True
        except (AttributeError, OSError, ValueError):
            pass
    # Container CPU quotas can be lower than the affinity mask. A fractional
    # CPU still needs one worker, but never justify rounding up extra workers.
    if sys.platform.startswith('linux'):
        try:
            quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().strip().split()
            if quota != 'max' and int(period) > 0:
                count = min(count, max(1, int(quota) // int(period)))
        except (OSError, ValueError):
            # Older containers expose CPU quotas through a cgroup v1 controller.
            for controller in ('cpu', 'cpu,cpuacct'):
                try:
                    base = '/sys/fs/cgroup/' + controller
                    quota = int(Path(base + '/cpu.cfs_quota_us').read_text().strip())
                    period = int(Path(base + '/cpu.cfs_period_us').read_text().strip())
                    if quota > 0 and period > 0:
                        count = min(count, max(1, quota // period))
                    break
                except (OSError, ValueError):
                    pass
    return max(1, count), known


def physical_memory_mb():
    total = None
    try:
        if os.name == 'nt':
            class MemoryStatus(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                            ('total_phys', ctypes.c_ulonglong), ('avail_phys', ctypes.c_ulonglong),
                            ('total_page', ctypes.c_ulonglong), ('avail_page', ctypes.c_ulonglong),
                            ('total_virtual', ctypes.c_ulonglong), ('avail_virtual', ctypes.c_ulonglong),
                            ('avail_extended', ctypes.c_ulonglong)]
            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if ctypes.WinDLL('kernel32', use_last_error=True).GlobalMemoryStatusEx(ctypes.byref(status)):
                total = int(status.total_phys)
        elif hasattr(os, 'sysconf'):
            total = int(os.sysconf('SC_PHYS_PAGES')) * int(os.sysconf('SC_PAGE_SIZE'))
    except (AttributeError, OSError, ValueError):
        total = None
    if total is None and sys.platform == 'darwin':
        try:
            result = subprocess.run(['/usr/sbin/sysctl', '-n', 'hw.memsize'], capture_output=True, text=True, timeout=2, check=True)
            total = int(result.stdout.strip())
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    if sys.platform.startswith('linux'):
        for filename in ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'):
            try:
                limit = int(Path(filename).read_text().strip())
                # cgroup v1 represents unlimited memory with a huge sentinel.
                if 0 < limit < (1 << 60):
                    total = min(total, limit) if total and total > 0 else limit
            except (OSError, ValueError):
                pass
    return total // _MIB if total and total >= _MIB else None


def snapshot():
    cpus, cpu_known = usable_cpus()
    memory = physical_memory_mb()
    return {'cpu_count': cpus, 'cpu_known': cpu_known,
            'memory_mb': memory, 'memory_known': memory is not None}
