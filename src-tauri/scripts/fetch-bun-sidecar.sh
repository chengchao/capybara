#!/usr/bin/env bash
set -euo pipefail

BUN_VERSION="1.3.0"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binaries_dir="${script_dir}/../binaries"

target_triple="$(rustc --print host-tuple)"
if [[ -z "${target_triple}" ]]; then
  echo "fetch-bun-sidecar: failed to determine Rust host tuple" >&2
  exit 1
fi

case "${target_triple}" in
  aarch64-apple-darwin)
    archive_arch="aarch64"
    ;;
  x86_64-apple-darwin)
    archive_arch="x64"
    ;;
  *)
    echo "fetch-bun-sidecar: unsupported target '${target_triple}' (only macOS x64/arm64 are supported)" >&2
    exit 1
    ;;
esac

binary_path="${binaries_dir}/bun-${target_triple}"
if [[ -x "${binary_path}" ]]; then
  echo "bun sidecar already fetched at ${binary_path}; skipping"
  exit 0
fi

archive="bun-darwin-${archive_arch}.zip"
url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${archive}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

echo "fetch-bun-sidecar: downloading ${url}"
# TODO(PR-Runtime-Manifest): replace with sha256-verified fetch via runtime-manifest.json.
curl --fail --location --proto '=https' --tlsv1.2 --output "${tmpdir}/${archive}" "${url}"

echo "fetch-bun-sidecar: extracting ${archive}"
unzip -q "${tmpdir}/${archive}" -d "${tmpdir}"

mkdir -p "${binaries_dir}"
install -m 0755 "${tmpdir}/bun-darwin-${archive_arch}/bun" "${binary_path}"

if [[ ! -x "${binary_path}" ]]; then
  echo "fetch-bun-sidecar: install succeeded but ${binary_path} is missing or not executable" >&2
  exit 1
fi

echo "fetch-bun-sidecar: ok — ${binary_path}"
