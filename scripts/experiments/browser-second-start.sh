set -euo pipefail

chrome_dir=$(dirname "$(readlink -f /usr/bin/google-chrome)")
root=$(mktemp -d /tmp/massion-b1.XXXXXX)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/home" "$root/cert" "$root/tmp"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/cert/key.pem" -out "$root/cert/cert.pem" \
  -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 >"$root/openssl.log" 2>&1
for nss_path in .pki/nssdb .local/share/pki/nssdb; do
  mkdir -p "$root/home/$nss_path"
  certutil -N -d "sql:$root/home/$nss_path" --empty-password
  certutil -A -d "sql:$root/home/$nss_path" -n flake260-fixture -t 'C,,' -i "$root/cert/cert.pem"
done
HOME="$root/home" agent-browser --version
findmnt -n -o SOURCE,MAJ:MIN -T "$chrome_dir/chrome"
sync
python3 - "$chrome_dir" <<'PY'
import os
from pathlib import Path
import sys

for path in Path(sys.argv[1]).rglob('*'):
    if path.is_file():
        with path.open('rb') as browser_file:
            os.posix_fadvise(browser_file.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
PY
sudo -n systemd-run --quiet --wait --pipe --collect --uid="$(id -u)" --gid="$(id -g)" \
  --working-directory="$PWD" --setenv="PATH=$PATH" --setenv="HOME=$root/home" \
  --setenv="TMPDIR=$root/tmp" --setenv="B1_CERT=$root/cert" \
  --setenv="B1_CHROME=$chrome_dir/chrome" --setenv="B1_CONDITION=$B1_CONDITION" \
  --property="IOReadBandwidthMax=$chrome_dir/chrome 2M" \
  "$(command -v node)" scripts/experiments/browser-second-start.mjs
