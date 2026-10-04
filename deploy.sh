#!/usr/bin/env bash
#
# Builds a deployable copy of a .gs file with the real Clearstream API key substituted in, and
# copies it to the clipboard. The real key never lives in the .gs files committed to git — it only
# exists in env/production.env (gitignored) and briefly in your clipboard.
#
# Usage: ./deploy.sh [file.gs]   (defaults to Code.gs; pass Code_phone_only.gs for that variant)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET_FILE="${1:-Code.gs}"
ENV_FILE="env/production.env"
PLACEHOLDER="__CLEARSTREAM_API_KEY__"

if [[ ! -f "$TARGET_FILE" ]]; then
  echo "No such file: $TARGET_FILE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it with: CLEARSTREAM_API_KEY=<your real key>" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [[ -z "${CLEARSTREAM_API_KEY:-}" ]]; then
  echo "CLEARSTREAM_API_KEY is not set in $ENV_FILE" >&2
  exit 1
fi

sed "s/${PLACEHOLDER}/${CLEARSTREAM_API_KEY}/" "$TARGET_FILE" | pbcopy

echo "Done! $TARGET_FILE with your real API key is now on your clipboard."
echo "Paste it into the Apps Script editor (Extensions > Apps Script) and save."
