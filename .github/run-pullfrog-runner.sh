#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_dir="${RUNNER_DIR:-${repo_root}/.github/actions-runner-linux}"
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


if [[ ! -f "${runner_dir}/.runner" ]]; then
  registration_token="$(gh api --method POST "repos/${repository}/actions/runners/registration-token" --jq .token)"
  echo "Registering ${runner_name}..."
  docker run --rm \
    --cap-add SYS_ADMIN \
    --name "${container_name}-configure" \
    --volume "${runner_dir}:/runner" \
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
    --volume "${runner_dir}:/runner" \
    "${image_name}"
fi

echo "Runner ${runner_name} is configured in ${container_name}."
