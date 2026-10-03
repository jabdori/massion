#!/usr/bin/env python3
"""Run one command with a new loopback-only disposable SurrealDB instance.

Server and child command intentionally run in one exec invocation, since the
managed executor isolates loopback and PIDs between invocations.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

BINARY = Path(os.environ.get('MASSION_SURREAL_BINARY', 'surreal')).expanduser()
ROOT = Path(tempfile.gettempdir())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18080)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        parser.error('provide a test command after --')
    binary = shutil.which(str(BINARY)) if not BINARY.is_absolute() else str(BINARY)
    if not binary or not Path(binary).is_file():
        parser.error('Set MASSION_SURREAL_BINARY to an installed official SurrealDB 3.3.0 binary')
    runtime = Path(tempfile.mkdtemp(prefix='disposable-', dir=ROOT))
    (runtime / 'tmp').mkdir()
    url = f'http://127.0.0.1:{args.port}'
    server_args = [str(binary), 'start', f'surrealkv://{runtime}/data',
                   '--bind', f'127.0.0.1:{args.port}', '--unauthenticated',
                   '--no-banner', '--log', 'info', '--temporary-directory',
                   str(runtime / 'tmp'), '--default-namespace', 'massion_storage_tests',
                   '--default-database', 'massion_storage_tests',
                   '--deny-net', '--deny-scripting']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with (runtime / 'server.log').open('w') as log:
        server = subprocess.Popen(server_args, stdout=log, stderr=subprocess.STDOUT,
                                  env={'PATH': '/usr/bin:/bin'})
        metadata = {'pid_in_this_exec_namespace': server.pid, 'url': url,
                    'runtime': str(runtime), 'binary': str(binary),
                    'version': '3.3.0', 'server_args': server_args}
        (runtime / 'server.json').write_text(json.dumps(metadata, indent=2) + '\n')
        try:
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise RuntimeError('SurrealDB exited: ' + (runtime / 'server.log').read_text())
                try:
                    with opener.open(url + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            for key, value in {
                'SURREAL_TEST_URL': url,
                'SURREAL_TEST_BINARY': str(binary),
                'SURREAL_TEST_PID': str(server.pid),
                'SURREAL_TEST_RUNTIME': str(runtime),
                'SURREAL_TEST_DATA_PATH': str(runtime / 'data'),
                'MASSION_TEST_SURREAL_RPC': url + '/rpc',
                'MASSION_TEST_SURREAL_BINARY': str(binary),
                'MASSION_TEST_SURREAL_DATA': str(runtime / 'data'),
                'MASSION_TEST_SURREAL_PID': str(server.pid),
                'MASSION_TEST_SURREAL_NAMESPACE': 'massion_storage_tests',
                'MASSION_TEST_SURREAL_DATABASE': 'massion_storage_tests',
            }.items():
                os.environ[key] = value
            print('Disposable SurrealDB ready: ' + json.dumps(metadata), flush=True)
            return subprocess.run(command).returncode
        finally:
            if server.poll() is None:
                server.send_signal(signal.SIGTERM)
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
            shutil.rmtree(runtime)


if __name__ == '__main__':
    sys.exit(main())
