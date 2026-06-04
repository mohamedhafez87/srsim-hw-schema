#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CLI_SCRIPT="$ROOT_DIR/srsim_hw_schema.py"
CATALOG_PATH="$ROOT_DIR/releases.yaml"

usage() {
  cat <<'EOF'
Usage: scripts/fetch-release-json.sh

Generate the hardware JSON for every release listed in releases.yaml and
refresh the root srsim-supported-hardware.json copy for the default release.
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$CATALOG_PATH" ]]; then
  echo "missing releases catalog: $CATALOG_PATH" >&2
  exit 1
fi

cd "$ROOT_DIR"
"$PYTHON_BIN" "$CLI_SCRIPT" generate-all --catalog "$CATALOG_PATH" --sync-root
