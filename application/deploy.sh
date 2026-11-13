#!/usr/bin/env bash
# Ships the project to pizito and rebuilds the container. Usage: ./deploy.sh
# DEPLOY_HOST and DEPLOY_DIR (relative to the remote home) change the target.
set -euo pipefail
cd "$(dirname "$0")"
host=${DEPLOY_HOST:-pizito}
dir=${DEPLOY_DIR:-sites/pulse}

# pizito has no rsync: src/ is replaced wholesale through tar over ssh (what was deleted here disappears there)
COPYFILE_DISABLE=1 tar --no-xattrs -cf - Dockerfile docker-compose.yml .dockerignore shard.yml shard.lock src |
  ssh "$host" "mkdir -p $dir && cd $dir && rm -rf src && tar -xf -"

ssh "$host" "cd $dir && docker compose up -d --build --remove-orphans"
ssh "$host" "curl -fsS --retry 15 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:3000/time" &&
  echo "ok: $host answers on 127.0.0.1:3000"
