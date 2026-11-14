#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup_vm.sh [source-dir]" >&2
  exit 1
fi
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "arm64" ]]; then
  echo "Expected an aarch64 VM" >&2
  exit 1
fi

if command -v apt-get >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv python3-pip ffmpeg rsync curl
elif command -v dnf >/dev/null; then
  dnf install -y python3 python3-pip ffmpeg rsync curl
else
  echo "Unsupported Linux distribution (need apt-get or dnf)" >&2
  exit 1
fi

if ! swapon --show=NAME | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -qE '^/swapfile\s' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

id sisic-embed >/dev/null 2>&1 || useradd --system --home-dir /var/lib/sisic-embed --shell /usr/sbin/nologin sisic-embed
install -d -m 0750 -o sisic-embed -g sisic-embed /opt/sisic-embed
install -d -m 0700 -o sisic-embed -g sisic-embed /var/lib/sisic-embed /var/lib/sisic-embed/spool /var/lib/sisic-embed/hf
rsync -a --delete --exclude='.venv' "$SRC/" /opt/sisic-embed/
python3 -m venv /opt/sisic-embed/.venv
/opt/sisic-embed/.venv/bin/pip install --upgrade pip
# CPU-only torch wheel first so pip does not pull CUDA builds onto a 6 GB VM
/opt/sisic-embed/.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/opt/sisic-embed/.venv/bin/pip install -r /opt/sisic-embed/requirements.txt
chown -R sisic-embed:sisic-embed /opt/sisic-embed /var/lib/sisic-embed
chmod 0700 /var/lib/sisic-embed /var/lib/sisic-embed/spool /var/lib/sisic-embed/hf
find /var/lib/sisic-embed -maxdepth 2 -type f \( -name "*.sqlite*" -o -name "*.db*" -o -name "*.f32" \) -exec chmod 0600 {} +
install -m 0644 /opt/sisic-embed/deploy/sisic-embed.service /etc/systemd/system/sisic-embed.service
if [[ ! -e /etc/sisic-embed.env ]]; then
  umask 077
  EMBED_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  printf 'SISIC_EMBED_TOKEN=%s\nSISIC_EMBED_DB=/var/lib/sisic-embed/clips.sqlite\nSISIC_EMBED_SPOOL=/var/lib/sisic-embed/spool\nSISIC_EMBED_MODEL_DIR=/opt/models/embeddinggemma-2\n' "$EMBED_TOKEN" > /etc/sisic-embed.env
  chmod 600 /etc/sisic-embed.env
  unset EMBED_TOKEN
fi
systemctl daemon-reload
echo "Setup complete. Review /etc/sisic-embed.env, copy the model to /opt/models/embeddinggemma-2, then run: systemctl enable --now sisic-embed"
