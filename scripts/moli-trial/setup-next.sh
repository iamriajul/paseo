#!/usr/bin/env bash
# Builds the Next.js fixture: a fresh create-next-app with the overlay pages (cookie login,
# client routing, canvas). Usage: scripts/moli-trial/setup-next.sh /tmp/moli-next
set -euo pipefail
DIR="${1:-/tmp/moli-next}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"
[ -d "$DIR/app" ] || (cd "$DIR" && npx -y create-next-app@latest app --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm --yes)
cp -r "$HERE/next-overlay/app/." "$DIR/app/app/"
# Next 16 prerenders by default; the dashboard reads cookies at request time.
printf 'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n' > "$DIR/app/next.config.ts"
cd "$DIR/app" && npx next build
echo "start with: (cd $DIR/app && npx next start -H 127.0.0.1 -p 3791)"
