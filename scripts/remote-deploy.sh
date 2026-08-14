#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 1)) || [[ ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected exactly one release tag in vX.Y.Z format." >&2
  exit 2
fi

release_version="$1"
image_tag="${release_version#v}"
project_dir="/opt/NovaChat"
compose_file="$project_dir/docker-compose.yml"
service_name="novachat"
data_dir="$project_dir/novachat_data"
database_path="$data_dir/novachat.db"
backup_root="$project_dir/backups/releases"
image_repository="docker.yunnet.top/github/yiranxiaohui/novachat"
target_image="$image_repository:$image_tag"
health_url="http://127.0.0.1:4300/api/setup/status"
lock_file="/var/lock/novachat-release-deploy.lock"

for required_command in docker sqlite3 curl flock; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required production command not found: $required_command" >&2
    exit 1
  fi
done

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Another NovaChat deployment is already running." >&2
  exit 1
fi

cd "$project_dir"
container_id="$(docker compose -f "$compose_file" ps -q "$service_name")"
if [[ -z "$container_id" ]]; then
  echo "NovaChat service container was not found." >&2
  exit 1
fi

current_image="$(docker inspect "$container_id" --format '{{.Config.Image}}')"
if [[ "$current_image" != "$image_repository:"* ]]; then
  echo "Refusing to replace unexpected image: $current_image" >&2
  exit 1
fi

current_health="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
if [[ "$current_image" == "$target_image" ]] && [[ "$current_health" == "healthy" ]] &&
  curl -fsS "$health_url" >/dev/null; then
  echo "$release_version is already deployed and healthy."
  exit 0
fi

deploy_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$backup_root/${release_version}-${deploy_stamp}"
backup_compose="$backup_dir/docker-compose.yml"
backup_database="$backup_dir/novachat.db"
mkdir -p "$backup_dir"
cp -a "$compose_file" "$backup_compose"

database_backed_up=false
if [[ -f "$database_path" ]]; then
  sqlite3 "$database_path" ".timeout 5000" ".backup '$backup_database'"
  if [[ "$(sqlite3 "$backup_database" 'PRAGMA quick_check;')" != "ok" ]]; then
    echo "SQLite backup failed its integrity check." >&2
    exit 1
  fi
  chown --reference="$database_path" "$backup_database"
  chmod --reference="$database_path" "$backup_database"
  database_backed_up=true
fi

echo "Backup created: $backup_dir"
docker pull "$target_image"

image_match_count="$(grep -F -c "image: $current_image" "$compose_file" || true)"
if [[ "$image_match_count" != "1" ]]; then
  echo "Expected exactly one current image entry in the Compose file; found $image_match_count." >&2
  exit 1
fi

deployment_started=false

wait_for_healthy() {
  local health_attempt
  local candidate_id
  local runtime_state
  local runtime_health

  for ((health_attempt = 1; health_attempt <= 45; health_attempt++)); do
    candidate_id="$(docker compose -f "$compose_file" ps -q "$service_name")"
    if [[ -n "$candidate_id" ]]; then
      runtime_state="$(docker inspect "$candidate_id" --format '{{.State.Status}}')"
      runtime_health="$(docker inspect "$candidate_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
      if [[ "$runtime_state" == "running" ]] &&
        { [[ "$runtime_health" == "healthy" ]] || [[ "$runtime_health" == "none" ]]; } &&
        curl -fsS "$health_url" >/dev/null; then
        return 0
      fi
      if [[ "$runtime_state" != "running" ]] || [[ "$runtime_health" == "unhealthy" ]]; then
        return 1
      fi
    fi
    sleep 2
  done
  return 1
}

rollback() {
  local failure_code="$1"
  trap - ERR
  set +e
  echo "Deployment failed; restoring the previous release." >&2

  if [[ "$deployment_started" == true ]]; then
    docker compose -f "$compose_file" stop "$service_name"
    cp -a "$backup_compose" "$compose_file"
    if [[ "$database_backed_up" == true ]]; then
      rm -f "$database_path-wal" "$database_path-shm" "$database_path.restore"
      cp -a "$backup_database" "$database_path.restore"
      mv -f "$database_path.restore" "$database_path"
    fi
    docker compose -f "$compose_file" up -d --no-deps "$service_name"
    if wait_for_healthy; then
      echo "Rollback completed and the previous release is healthy." >&2
    else
      echo "Rollback was attempted but production is not healthy; manual intervention is required." >&2
    fi
  fi

  exit "$failure_code"
}

trap 'rollback "$?"' ERR

sed -i "s#image: $current_image#image: $target_image#" "$compose_file"
if ! docker compose -f "$compose_file" config --images | grep -Fxq "$target_image"; then
  echo "Compose validation did not resolve the target image." >&2
  false
fi

deployment_started=true
docker compose -f "$compose_file" up -d --no-deps "$service_name"
wait_for_healthy

deployed_id="$(docker compose -f "$compose_file" ps -q "$service_name")"
deployed_image="$(docker inspect "$deployed_id" --format '{{.Config.Image}}')"
deployed_health="$(docker inspect "$deployed_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
restart_count="$(docker inspect "$deployed_id" --format '{{.RestartCount}}')"

if [[ "$deployed_image" != "$target_image" ]] || [[ "$deployed_health" != "healthy" ]] ||
  [[ "$restart_count" != "0" ]]; then
  echo "Post-deploy container verification failed." >&2
  false
fi

if [[ -f "$database_path" ]]; then
  migration_status="$(sqlite3 "$database_path" 'SELECT max(id) || "/" || count(*) FROM _migrations;')"
  database_status="$(sqlite3 "$database_path" 'PRAGMA quick_check;')"
  if [[ "$database_status" != "ok" ]]; then
    echo "Post-deploy SQLite integrity check failed." >&2
    false
  fi
  echo "Database migrations: $migration_status; integrity: $database_status"
fi

if docker logs --since 10m --tail 200 "$deployed_id" 2>&1 | grep -Eiq 'panic|fatal'; then
  echo "Critical error found in recent container logs." >&2
  false
fi

trap - ERR
echo "Deployment complete: image=$deployed_image health=$deployed_health restarts=$restart_count"
