#!/bin/sh
set -e

# Start as root only long enough to make the data folder writable, then drop to
# an unprivileged user. PUID/PGID let you match the owner of a bind mount.
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null ||
    echo "Warning: couldn't change ownership of $DATA_DIR; make sure $PUID:$PGID can write to it."
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
