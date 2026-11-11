"""Shared teardown for the archived Playwright suites.

Windows `Popen.terminate()` only signals the direct child; the demo provider
spawns nothing today, but the pattern still leaks when a suite times out (the
parent is killed before its `finally` runs). Running a dozen suites back to
back on a 2-vCPU CI runner then piles up dead Python processes and the next
suite's page never reaches `#app:not(.hidden)`.

`kill_proc()` uses `taskkill /T /F` on Windows (whole tree) and SIGKILL
elsewhere. Import it in a suite's `finally`:

    from e2e_teardown import kill_proc
    finally:
        kill_proc(prov)

Keep this dependency-free: the suites must run with a bare Python 3.
"""
import os
import signal
import subprocess
import sys


def kill_proc(proc, timeout=5):
    """Terminate `proc` and every child it spawned (best effort, never raises)."""
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return
    except Exception:
        pass
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/pid', str(proc.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=timeout)
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=timeout)
    except Exception:
        pass


def kill_all(procs):
    for p in (procs or []):
        kill_proc(p)
