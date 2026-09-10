#!/usr/bin/env bash
# Build all TermChat clients:
#   public/chat.cjs            — single-file Node client (zero npm deps)
#   public/dl/tchat-*.gz       — native standalone binaries (bun --compile, zero runtime)
#   public/version.txt         — version stamp used by installers
set -euo pipefail
cd /home/z/my-project

VERSION="3.0.0"
mkdir -p .build public/dl

echo "== 1/3 Node single-file client =="
bun build scripts/chat-client-entry.ts \
  --target=node \
  --format=cjs \
  --external bufferutil \
  --external utf-8-validate \
  --outfile .build/chat.bundle.cjs
{ printf '#!/usr/bin/env node\n'; cat .build/chat.bundle.cjs; } > public/chat.cjs
chmod +x public/chat.cjs

echo "== 2/3 native binaries (bun --compile) =="
build_native () { # $1=target $2=outname
  echo "   -> $2"
  bun build scripts/chat-client-entry.ts \
    --compile --target="$1" \
    --external bufferutil --external utf-8-validate \
    --outfile ".build/$2"
  gzip -9 -c ".build/$2" > "public/dl/$2.gz"
  rm -f ".build/$2" # keep disk tidy; linux-x64 rebuilt below for local tests
}
build_native bun-darwin-arm64  tchat-darwin-arm64
build_native bun-darwin-x64    tchat-darwin-x64
build_native bun-windows-x64   tchat-windows-x64.exe
bun build scripts/chat-client-entry.ts \
  --compile --target=bun-linux-x64 \
  --external bufferutil --external utf-8-validate \
  --outfile .build/tchat-linux-x64
gzip -9 -c .build/tchat-linux-x64 > public/dl/tchat-linux-x64.gz

echo "== 3/3 version stamp =="
printf '%s\n' "$VERSION" > public/version.txt

echo "Done. public/dl contents:"
ls -la public/dl | awk '{print "   " $5 "  " $9}' | tail -n +2
