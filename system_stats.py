"""Host CPU and memory snapshots for the Kryx Client owner dashboard."""

from __future__ import annotations

import os
import sys
import threading
from datetime import datetime
from typing import Any, Dict, Optional

_CPU_SAMPLER_LOCK = threading.Lock()
_CPU_SAMPLER_STATE: Optional[Dict[str, int]] = None


def _utc_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def system_memory_snapshot() -> Dict[str, Any]:
    """Host RAM usage (bytes and percent)."""
    total: Optional[int] = None
    used: Optional[int] = None
    percent: Optional[float] = None
    try:
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                total = int(stat.ullTotalPhys)
                used = int(stat.ullTotalPhys - stat.ullAvailPhys)
                percent = float(stat.dwMemoryLoad)
        else:
            meminfo: Dict[str, int] = {}
            with open("/proc/meminfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    key, _, rest = line.partition(":")
                    if not rest:
                        continue
                    parts = rest.split()
                    if parts and parts[0].isdigit():
                        meminfo[key.strip()] = int(parts[0]) * 1024
            total = meminfo.get("MemTotal")
            available = meminfo.get("MemAvailable")
            if available is None and total is not None:
                available = (
                    meminfo.get("MemFree", 0)
                    + meminfo.get("Buffers", 0)
                    + meminfo.get("Cached", 0)
                )
            if total is not None and available is not None:
                used = total - available
                percent = round(used / total * 100, 1) if total else 0.0
    except OSError:
        pass

    if total is None or used is None:
        return {"ok": False, "error": "Memory stats unavailable on this host."}

    if percent is None:
        percent = round(used / total * 100, 1) if total else 0.0

    available_bytes = max(total - used, 0)
    return {
        "ok": True,
        "timestamp": _utc_now(),
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available_bytes,
        "percent": percent,
        "total_gb": round(total / (1024**3), 2),
        "used_gb": round(used / (1024**3), 2),
        "available_gb": round(available_bytes / (1024**3), 2),
    }


def _read_cpu_times() -> Optional[Dict[str, int]]:
    try:
        if sys.platform == "win32":
            import ctypes

            class FILETIME(ctypes.Structure):
                _fields_ = [
                    ("dwLowDateTime", ctypes.c_ulong),
                    ("dwHighDateTime", ctypes.c_ulong),
                ]

            idle_ft = FILETIME()
            kernel_ft = FILETIME()
            user_ft = FILETIME()
            if not ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(idle_ft), ctypes.byref(kernel_ft), ctypes.byref(user_ft)
            ):
                return None

            def _ft_int(ft: FILETIME) -> int:
                return (int(ft.dwHighDateTime) << 32) + int(ft.dwLowDateTime)

            idle = _ft_int(idle_ft)
            total = _ft_int(kernel_ft) + _ft_int(user_ft)
            return {"idle": idle, "total": total}

        with open("/proc/stat", "r", encoding="utf-8") as fh:
            line = fh.readline()
        if not line.startswith("cpu "):
            return None
        parts = line.split()
        values = [int(x) for x in parts[1:] if x.isdigit()]
        if len(values) < 4:
            return None
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        total = sum(values)
        return {"idle": idle, "total": total}
    except OSError:
        return None


def system_cpu_snapshot() -> Dict[str, Any]:
    """Host CPU usage percent since the previous sample."""
    global _CPU_SAMPLER_STATE
    now_times = _read_cpu_times()
    if now_times is None:
        return {"ok": False, "error": "CPU stats unavailable on this host."}

    percent: Optional[float] = None
    with _CPU_SAMPLER_LOCK:
        prev = _CPU_SAMPLER_STATE
        _CPU_SAMPLER_STATE = dict(now_times)
        if prev:
            delta_total = now_times["total"] - prev["total"]
            delta_idle = now_times["idle"] - prev["idle"]
            if delta_total > 0:
                busy = max(delta_total - delta_idle, 0)
                percent = round(busy / delta_total * 100, 1)

    if percent is None:
        percent = 0.0

    logical_cpus: Optional[int] = None
    try:
        logical_cpus = os.cpu_count()
    except (TypeError, ValueError):
        logical_cpus = None

    return {
        "ok": True,
        "timestamp": _utc_now(),
        "percent": percent,
        "logical_cpus": logical_cpus,
    }
