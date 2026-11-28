#!/usr/bin/env python3
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


CRATE = Path(__file__).resolve().parent
TARGET = Path.home() / 'orca/workspaces/massion/.rust-spike-target'


def check_space():
    available = shutil.disk_usage('/').free
    if available < 12 * 1024 ** 3:
        subprocess.run(['df', '-g', '/'], stdout=sys.stderr, check=True)
        raise SystemExit(f'Stopped: free disk is {available / 1024 ** 3:.2f} GiB (minimum 12 GiB)')
    return available


if __name__ == '__main__':
    if TARGET.is_symlink() or len(sys.argv) != 1:
        raise SystemExit('Use the fixed spike target and run build.py without arguments')
    subprocess.run(['df', '-g', '/'], check=True)
    minimum = check_space()
    start = time.monotonic()
    build = subprocess.Popen(['cargo', 'build', '--release', '--locked', '--jobs', '6'],
                             cwd=CRATE, env={**os.environ, 'CARGO_TARGET_DIR': str(TARGET)},
                             start_new_session=True)
    try:
        while build.poll() is None:
            time.sleep(0.25)
            minimum = min(minimum, check_space())
    finally:
        if build.poll() is None:
            os.killpg(build.pid, signal.SIGKILL)
            build.wait()
    minimum = min(minimum, check_space())
    print(f'Minimum free disk: {minimum / 1024 ** 3:.2f} GiB')
    print(f'Wall time: {time.monotonic() - start:.2f} s', flush=True)
    raise SystemExit(build.returncode)
