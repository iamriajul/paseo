#!/bin/bash
R=$(cd "$(dirname "$0")/../../.." && pwd); T=$R/node_modules/.bin/tsx
CHR=$(ls ~/.cache/ms-playwright/chromium-1208/*/chrome); GC=/usr/bin/google-chrome
export SBV_DISPLAY=:117
run() { timeout 150 $T "$(dirname "$0")/bench.mjs" "$@" 2>&1 | grep '^{' || echo "FAILED $*"; }
for rep in 1 2; do
 for wl in anim long; do
  run jpeg $wl $GC new 10
  run tabcap $wl $GC new 10 avc1.42E028
  run tabcap $wl $GC new 10 vp8
  run reencode $wl $GC new 10
  run jpeg $wl $CHR new 10
  run tabcap $wl $CHR new 10 avc1.42E028
  run jpeg $wl $GC headed 10
  run tabcap $wl $GC headed 10 avc1.42E028
 done
done
echo MATRIX-DONE
