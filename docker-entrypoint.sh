#!/bin/bash
# Docker entrypoint - starts avahi-daemon then the hub process
set -e

echo "[docker-entrypoint] Starting avahi-daemon..."
avahi-daemon --daemonize --no-rlimits 2>/dev/null || true

echo "[docker-entrypoint] Starting EtthusHUB..."
exec "$@"
