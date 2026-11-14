#!/usr/bin/env bash
# Deploys what is on origin/main: pizito pulls its clone and rebuilds the container. Usage: ./deploy.sh
# Push first; uncommitted or unpushed changes are not deployed.
# DEPLOY_HOST and DEPLOY_DIR (the clone, relative to the remote home) change the target.
set -euo pipefail
host=${DEPLOY_HOST:-pizito}
dir=${DEPLOY_DIR:-sites/pulse}

# -p pulse: the project name owns the pulse_pulse-data volume (the rooms), whatever the folder is called
ssh "$host" "cd $dir && git pull --ff-only && git log --oneline -1 && cd application && docker compose -p pulse up -d --build --remove-orphans"
ssh "$host" "curl -fsS --retry 15 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:3000/time" &&
  echo "ok: $host answers on 127.0.0.1:3000"
