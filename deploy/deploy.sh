#!/usr/bin/env bash
# Ship the compose file to bf.nottseter.no, pull the latest image from ghcr.io
# and recreate the container. Run after the GitHub Action has finished.
set -euo pipefail
cd "$(dirname "$0")"

HOST=${DEPLOY_HOST:-bf.nottseter.no}
DIR=${DEPLOY_DIR:-docker/facing}

# shellcheck disable=SC2029
ssh "$HOST" "mkdir -p $DIR"
scp -q docker-compose.yml "$HOST:$DIR/docker-compose.yml"
# shellcheck disable=SC2029
ssh "$HOST" "cd $DIR && docker compose pull && docker compose up -d"
