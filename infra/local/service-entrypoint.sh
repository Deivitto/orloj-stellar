#!/bin/sh
set -eu
# Local Compose file-backed secrets preserve host UIDs; copy only this service's
# granted secrets into a private directory, then drop privileges before startup.
install -d -m 700 -o 1000 -g 1000 /run/orloj-secrets
for name in control signer runtime master; do
  if [ -f "/run/secrets/$name" ]; then
    install -m 600 -o 1000 -g 1000 "/run/secrets/$name" "/run/orloj-secrets/$name"
  fi
done
exec runuser -u node -- "$@"
