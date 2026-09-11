#!/bin/sh
# ============================================================================
#  TermChat installer — https://tchat.space-z.ai
#
#  Usage:   curl -fsSL https://tchat.space-z.ai/i.sh | sh
#           (also: /install.sh)
#  Result:  the `tchat` native CLI installed locally, no runtime needed.
#
#  Env overrides (useful for testing / custom hosts):
#    TCHAT_INSTALL_DIR    where to put the binary (default ~/.local/bin)
#    TCHAT_DOWNLOAD_BASE  where to download from  (default https://tchat.space-z.ai)
# ============================================================================
set -eu

BASE="${TCHAT_DOWNLOAD_BASE:-https://tchat.space-z.ai}"
DEST="${TCHAT_INSTALL_DIR:-$HOME/.local/bin}"

c_green() { printf '\033[32m%s\033[0m\n' "$1"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$1"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$1"; }

# ---- 1. detect platform ----------------------------------------------------
OS=$(uname -s 2>/dev/null || echo unknown)
ARCH=$(uname -m 2>/dev/null || echo unknown)

case "$OS" in
  Linux)  os=linux  ;;
  Darwin) os=darwin ;;
  *)
    c_red "Unsupported OS: $OS"
    echo "TermChat for Windows:  irm https://tchat.space-z.ai/i.ps1 | iex"
    echo "TermChat in browser:   https://tchat.space-z.ai"
    exit 1
    ;;
esac
case "$ARCH" in
  x86_64|amd64)          arch=x64   ;;
  arm64|aarch64)         arch=arm64 ;;
  *)
    c_red "Unsupported architecture: $ARCH (supported: x86_64, arm64)"
    exit 1
    ;;
esac

NAME="tchat-${os}-${arch}"
URL="$BASE/dl/$NAME.gz"

# ---- 2. download -----------------------------------------------------------
TMP="$(mktemp "${TMPDIR:-/tmp}/tchat-download.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

echo "Downloading TermChat CLI ($NAME) ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL"
else
  c_red "Neither curl nor wget found. Install one and re-run."
  exit 1
fi
[ -s "$TMP" ] || { c_red "Download failed or empty: $URL"; exit 1; }

# ---- 3. install ------------------------------------------------------------
mkdir -p "$DEST"
if ! gunzip -c "$TMP" > "$DEST/tchat" 2>/dev/null; then
  c_red "Could not decompress the download (is it a valid .gz?)"
  exit 1
fi
chmod +x "$DEST/tchat"

# sanity check: the binary must run
if ! "$DEST/tchat" --version >/dev/null 2>&1; then
  c_red "Installed binary failed to run on this platform."
  rm -f "$DEST/tchat"
  exit 1
fi
VER="$("$DEST/tchat" --version 2>/dev/null | head -1 || echo 'tchat')"

# ---- 4. PATH check ---------------------------------------------------------
PATH_NOTE=""
case ":$PATH:" in
  *":$DEST:"*) : ;;
  *)
    # try a standard bin dir that is already on PATH and writable
    if [ "$DEST" != "/usr/local/bin" ] && [ -w /usr/local/bin ] && [ -d /usr/local/bin ]; then
      mv "$DEST/tchat" /usr/local/bin/tchat 2>/dev/null && DEST="/usr/local/bin" || true
    fi
    case ":$PATH:" in
      *":$DEST:"*) : ;;
      *)
        PATH_NOTE=yes
        ;;
    esac
    ;;
esac

# ---- 5. success banner -----------------------------------------------------
echo ""
c_green "  Installed:  $VER"
echo "             at $DEST/tchat"
echo ""
if [ -n "$PATH_NOTE" ]; then
  c_dim "  One more step — add the install dir to your PATH:"
  echo ""
  echo "      export PATH=\"$DEST:\$PATH\"      # add to ~/.bashrc or ~/.zshrc"
  echo ""
  echo "  Or just run it directly:"
  echo "      $DEST/tchat join lobby"
else
  echo "  Join a room right now:"
  echo ""
  echo "      tchat join lobby              # public lobby"
  echo "      tchat join 7XK92              # any room code you like"
  echo "      tchat join 7XK92 -n Sam       # with a guest name"
fi
echo ""
c_dim "  Web (no install): https://tchat.space-z.ai/r/lobby"
c_dim "  Uninstall:        rm $DEST/tchat"
echo ""
