#!/bin/sh
set -e

# When /data is a bind mount, its owner is inherited from the host and the
# baked-in chown from the Dockerfile is lost. Fix it up on startup, then drop
# privileges to the novachat user.
if [ "$(id -u)" = "0" ]; then
    chown -R novachat:novachat /data || true
    exec /usr/bin/tini -- /usr/local/bin/su-exec novachat:novachat /usr/local/bin/novachat "$@"
fi

exec /usr/bin/tini -- /usr/local/bin/novachat "$@"
