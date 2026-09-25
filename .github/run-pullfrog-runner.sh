#!/usr/bin/env bash
set -euo pipefail

# Usage: bash .github/run-pullfrog-runner.sh
# Requires Docker Desktop and an authenticated gh CLI with runner-admin access.
# /runner uses a named volume; the container runs as runner with passwordless sudo
# and CAP_SYS_ADMIN for Pullfrog's PID/mount namespaces, without --privileged.
# Chromium is installed in the image for Pullfrog's agent-browser tools.
# After Dockerfile changes, recreate the idle container, preserving the volume,
# then rerun this script; starting an existing container does not update its image.
# Leave enough free memory in the Docker VM for npm, OpenCode, and browser jobs.
# A successful server bind followed by silence can mean the VM OOM-killed OpenCode;
# inspect /sys/fs/cgroup/memory.events inside this container before changing timeouts.
# Stop unneeded workloads or increase VM capacity; do not disable OOM protection.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_dir="${RUNNER_DIR:-${repo_root}/.github/actions-runner-linux}"
runner_volume="${RUNNER_VOLUME:-git-stacks-pullfrog-runner}"
container_name="${RUNNER_CONTAINER_NAME:-git-stacks-pullfrog-runner}"
image_name="${RUNNER_IMAGE_NAME:-git-stacks-pullfrog-runner:latest}"
runner_name="${RUNNER_NAME:-git-stacks-linux-runner}"
runner_labels="${RUNNER_LABELS:-pullfrog}"
repository="${GITHUB_REPOSITORY:-howarewoo/git-stacks}"
runner_url="${RUNNER_URL:-https://github.com/${repository}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required" >&2
  exit 1
fi

if [[ ! -x "${runner_dir}/run.sh" ]]; then
  mkdir -p "${runner_dir}"
  runner_version="${RUNNER_VERSION:-$(gh api repos/actions/runner/releases/latest --jq .tag_name)}"
  archive="$(mktemp)"
  trap 'rm -f "${archive}"' EXIT
  curl --fail --location --retry 3 \
    --output "${archive}" \
    "https://github.com/actions/runner/releases/download/${runner_version}/actions-runner-linux-arm64-${runner_version#v}.tar.gz"
  tar -xzf "${archive}" -C "${runner_dir}"
  rm -f "${archive}"
  trap - EXIT
fi

echo "Building ${image_name}..."
build_context="$(mktemp -d)"
trap 'rm -rf "${build_context}"' EXIT
docker build \
  --build-arg "RUNNER_UID=$(id -u)" \
  --build-arg "RUNNER_GID=$(id -g)" \
  --file "${repo_root}/.github/actions-runner-linux.Dockerfile" \
  --tag "${image_name}" \
  "${build_context}"
rm -rf "${build_context}"
trap - EXIT

# the runner's own state lives on a docker volume, not a host bind mount: docker
# desktop serves host mounts over virtiofs, which is far slower than the VM's own
# filesystem, and every job pays for it twice — `npm ci` across tens of thousands
# of files, then exec'ing the 184MB opencode binary — against pullfrog's fixed 30s
# server-bind budget. the host directory keeps only the downloaded payload, which
# seeds the volume once.
runner_mount_name() {
  docker inspect \
    --format '{{range .Mounts}}{{if eq .Destination "/runner"}}{{.Name}}{{end}}{{end}}' \
    "${container_name}" 2>/dev/null || true
}

runner_volume_has() {
  docker run --rm \
    --volume "${runner_volume}:/runner" \
    --entrypoint test \
    "${image_name}" \
    -f "$1"
}

runner_upstream_id() {
  gh api "repos/${repository}/actions/runners" --jq \
    ".runners[] | select(.name == \"${runner_name}\") | .id" 2>/dev/null || true
}

seed_runner_volume() {
  # strips registration and per-job state so a seeded volume is always a
  # pristine install that config.sh re-registers from scratch.
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "${runner_volume}:/runner" \
    --volume "${runner_dir}:/runner-payload:ro" \
    --entrypoint bash \
    "${image_name}" \
    -c 'cp -a /runner-payload/. /runner/ \
        && rm -rf /runner/_work /runner/_actions /runner/_diag /runner/_temp /runner/_tool \
        && rm -f /runner/.runner /runner/.credentials /runner/.credentials_rsaparams'
}

reprovision=0
if [[ "${RUNNER_RESET:-0}" != "0" ]]; then
  echo "Resetting ${runner_name} on request (RUNNER_RESET)."
  reprovision=1
elif docker container inspect "${container_name}" >/dev/null 2>&1 \
  && [[ "$(runner_mount_name)" != "${runner_volume}" ]]; then
  echo "Replacing ${container_name}: /runner is not backed by volume ${runner_volume}."
  reprovision=1
fi

if (( reprovision )); then
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  docker volume rm "${runner_volume}" >/dev/null 2>&1 || true
  # a container recreated under its old agent id collides with the broker
  # session the previous one left behind ("A session for this runner already
  # exists") and never connects, so retire the upstream registration and let
  # the replacement claim a fresh id.
  stale_id="$(runner_upstream_id)"
  if [[ -n "${stale_id}" ]]; then
    echo "Removing upstream runner registration ${stale_id}."
    gh api --method DELETE "repos/${repository}/actions/runners/${stale_id}" >/dev/null
  fi
fi

docker volume inspect "${runner_volume}" >/dev/null 2>&1 \
  || docker volume create "${runner_volume}" >/dev/null

if ! runner_volume_has /runner/run.sh; then
  echo "Seeding ${runner_volume} with the runner payload..."
  seed_runner_volume
fi

if ! runner_volume_has /runner/.runner || [[ -z "$(runner_upstream_id)" ]]; then
  registration_token="$(gh api --method POST "repos/${repository}/actions/runners/registration-token" --jq .token)"
  echo "Registering ${runner_name}..."
  docker run --rm \
    --cap-add SYS_ADMIN \
    --name "${container_name}-configure" \
    --volume "${runner_volume}:/runner" \
    --entrypoint /runner/config.sh \
    "${image_name}" \
    --url "${runner_url}" \
    --token "${registration_token}" \
    --name "${runner_name}" \
    --labels "${runner_labels}" \
    --unattended \
    --replace
fi

if docker container inspect "${container_name}" >/dev/null 2>&1; then
  docker start "${container_name}" >/dev/null
else
  echo "Starting ${container_name}..."
  docker run --detach \
    --cap-add SYS_ADMIN \
    --restart unless-stopped \
    --name "${container_name}" \
    --volume "${runner_volume}:/runner" \
    "${image_name}"
fi

echo "Runner ${runner_name} is configured in ${container_name}."
