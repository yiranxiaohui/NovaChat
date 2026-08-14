#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 1)) || [[ ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/deploy-production.sh vX.Y.Z" >&2
  exit 2
fi

release_version="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
deploy_config="${NOVACHAT_DEPLOY_CONFIG:-${HOME}/.config/novachat/deploy.env}"

if [[ ! -f "$deploy_config" ]]; then
  echo "Deployment config not found: $deploy_config" >&2
  echo "See docs/release-and-deploy.md for the required NOVACHAT_DEPLOY_TARGET value." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$deploy_config"
: "${NOVACHAT_DEPLOY_TARGET:?NOVACHAT_DEPLOY_TARGET is required in $deploy_config}"

echo "==> Deploying $release_version to production"
ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "$NOVACHAT_DEPLOY_TARGET" \
  "bash -s -- '$release_version'" \
  < "$script_dir/remote-deploy.sh"
