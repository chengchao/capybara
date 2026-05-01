#!/usr/bin/env bash
set -euo pipefail

LIMA_VERSION="2.1.1"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vendor_dir="${script_dir}/../vendor/lima"
limactl_path="${vendor_dir}/bin/limactl"

if [[ -x "${limactl_path}" ]]; then
  echo "lima already fetched at ${limactl_path}; skipping"
  exit 0
fi

os="$(uname -s)"
if [[ "${os}" != "Darwin" ]]; then
  echo "fetch-lima: unsupported OS '${os}' (only Darwin is supported)" >&2
  exit 1
fi

raw_arch="$(uname -m)"
case "${raw_arch}" in
  arm64)   arch="arm64" ;;
  x86_64)  arch="x86_64" ;;
  *)
    echo "fetch-lima: unsupported arch '${raw_arch}' (expected arm64 or x86_64)" >&2
    exit 1
    ;;
esac

tarball="lima-${LIMA_VERSION}-Darwin-${arch}.tar.gz"
url="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/${tarball}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

echo "fetch-lima: downloading ${url}"
curl --fail --location --proto '=https' --tlsv1.2 --output "${tmpdir}/${tarball}" "${url}"

mkdir -p "${vendor_dir}"
echo "fetch-lima: extracting to ${vendor_dir}"
tar -xzf "${tmpdir}/${tarball}" -C "${vendor_dir}"

if [[ ! -x "${limactl_path}" ]]; then
  echo "fetch-lima: extraction succeeded but ${limactl_path} is missing or not executable" >&2
  exit 1
fi

echo "fetch-lima: ok — ${limactl_path}"
