#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release-and-deploy.sh [--yes] [--skip-checks] [--dry-run] [vX.Y.Z]

Without an explicit version, increments only the patch component of the latest
vX.Y.Z tag. The script validates main, runs release checks, pushes the annotated
tag, waits for the container and worker workflows, then deploys production over
SSH from this host.
EOF
}

confirm_release=false
skip_checks=false
dry_run=false
requested_version=""

while (($# > 0)); do
  case "$1" in
    --yes)
      confirm_release=true
      ;;
    --skip-checks)
      skip_checks=true
      ;;
    --dry-run)
      dry_run=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    v[0-9]*.[0-9]*.[0-9]*)
      if [[ -n "$requested_version" ]]; then
        echo "Only one explicit version may be provided." >&2
        exit 2
      fi
      requested_version="$1"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

for required_command in git gh cargo bun ssh sort; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Release must run from main." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release requires a clean worktree." >&2
  exit 1
fi

git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main must exactly match origin/main." >&2
  exit 1
fi

latest_tag="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname | head -n 1)"
if [[ ! "$latest_tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Could not determine the latest semantic version tag." >&2
  exit 1
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
default_version="v${major}.${minor}.$((10#$patch + 1))"
release_version="${requested_version:-$default_version}"

if [[ ! "$release_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Invalid release version: $release_version" >&2
  exit 1
fi
if [[ "$release_version" == "$latest_tag" ]] ||
  [[ "$(printf '%s\n%s\n' "$latest_tag" "$release_version" | sort -V | tail -n 1)" != "$release_version" ]]; then
  echo "Release version must be newer than $latest_tag." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$release_version" >/dev/null; then
  echo "Tag already exists locally: $release_version" >&2
  exit 1
fi
if [[ -n "$(git ls-remote --tags origin "refs/tags/$release_version")" ]]; then
  echo "Tag already exists on origin: $release_version" >&2
  exit 1
fi

echo "Latest release : $latest_tag"
echo "Next release   : $release_version"
echo "Commit         : $(git rev-parse --short HEAD)"

if [[ "$dry_run" == true ]]; then
  echo "Dry run complete; no tag was created and production was not changed."
  exit 0
fi

if [[ "$confirm_release" != true ]]; then
  if [[ ! -t 0 ]]; then
    echo "Non-interactive release requires --yes." >&2
    exit 1
  fi
  read -r -p "Publish $release_version and deploy production? [y/N] " answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Release cancelled."
    exit 0
  fi
fi

if [[ "$skip_checks" != true ]]; then
  echo "==> Running Rust tests"
  cargo test --workspace
  echo "==> Building web application"
  (
    cd web
    bun install --frozen-lockfile
    bun run build
  )
fi

tagger_name="${GIT_AUTHOR_NAME:-$(git log -1 --format=%an)}"
tagger_email="${GIT_AUTHOR_EMAIL:-$(git log -1 --format=%ae)}"
git -c user.name="$tagger_name" -c user.email="$tagger_email" \
  tag -a "$release_version" -m "NovaChat $release_version"
git push origin "$release_version"

wait_for_run() {
  local workflow_file="$1"
  local workflow_label="$2"
  local run_id=""
  local lookup_attempt

  echo "==> Waiting for $workflow_label workflow to appear"
  for ((lookup_attempt = 1; lookup_attempt <= 30; lookup_attempt++)); do
    run_id="$(
      gh run list \
        --workflow "$workflow_file" \
        --branch "$release_version" \
        --event push \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId // empty'
    )"
    if [[ -n "$run_id" ]]; then
      break
    fi
    sleep 2
  done

  if [[ -z "$run_id" ]]; then
    echo "Timed out waiting for $workflow_label workflow." >&2
    return 1
  fi

  echo "==> Watching $workflow_label workflow ($run_id)"
  gh run watch "$run_id" --exit-status --interval 5
}

wait_for_run docker.yml "container image"
wait_for_run worker-release.yml "worker release"

for ((release_attempt = 1; release_attempt <= 20; release_attempt++)); do
  if gh release view "$release_version" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
gh release view "$release_version" >/dev/null
gh release edit "$release_version" \
  --title "NovaChat $release_version" \
  --latest >/dev/null

"$repo_root/scripts/deploy-production.sh" "$release_version"

release_url="$(gh release view "$release_version" --json url --jq .url)"
echo "Release and production deployment completed: $release_url"
