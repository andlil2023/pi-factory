#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
node --experimental-strip-types "$ROOT/src/init.ts" "${1:-.}" "${@:2}"
