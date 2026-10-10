import { Hono } from 'hono';

const app = new Hono();

// ── Install script ──────────────────────────────────────────────────
// Served at: curl -fsSL https://install.mcpmux.com | bash

app.get('/', (c) => {
  const ua = c.req.header('User-Agent') ?? '';
  const isBrowser = ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Safari');

  // Browser visitors get a human-readable landing page
  if (isBrowser && !c.req.query('raw')) {
    return c.html(landingPage());
  }

  // CLI tools (curl, wget) get the install script
  return c.newResponse(installScript(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
});

// Explicit path for the install script
app.get('/install.sh', (c) => {
  return c.newResponse(installScript(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
});

// ── APT setup script ────────────────────────────────────────────────
// Served at: curl -fsSL https://install.mcpmux.com/apt | sudo bash

app.get('/apt', (c) => {
  return c.newResponse(aptSetupScript(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
});

// ── Health check ────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'mcpmux-install' });
});

// ── 404 ─────────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.text('Not found. Visit https://install.mcpmux.com for installation instructions.', 404);
});

export default app;

// ── Scripts ─────────────────────────────────────────────────────────

function installScript(): string {
  return `#!/usr/bin/env bash
# McpMux Installer
# Usage: curl -fsSL https://install.mcpmux.com | bash
#    or: curl -fsSL https://install.mcpmux.com | bash -s -- --version 0.0.12
set -euo pipefail

GITHUB_REPO="mcpmux/mcp-mux"
VERSION=""
SKIP_VERIFY=false

# ── Helpers ──────────────────────────────────────────────────────────

info()  { printf '\\033[1;34m%s\\033[0m\\n' "$*"; }
ok()    { printf '\\033[1;32m%s\\033[0m\\n' "$*"; }
warn()  { printf '\\033[1;33m%s\\033[0m\\n' "$*" >&2; }
fail()  { printf '\\033[1;31mError: %s\\033[0m\\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" &>/dev/null || fail "'$1' is required but not installed."
}

# ── Parse args ───────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)  VERSION="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=true; shift ;;
    --help|-h)
      echo "Usage: install.sh [--version VERSION] [--skip-verify]"
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# ── Prerequisites ────────────────────────────────────────────────────

need curl

# ── Detect architecture ─────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

info "Detected architecture: $ARCH"

# ── Resolve version ─────────────────────────────────────────────────

if [[ -z "$VERSION" ]]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/\${GITHUB_REPO}/releases/latest" \\
    | grep '"tag_name"' | head -1 | sed 's/.*"v\\([^"]*\\)".*/\\1/')
  [[ -n "$VERSION" ]] || fail "Could not determine latest version"
fi

info "Installing McpMux v\${VERSION}"

# ── Signature verification ──────────────────────────────────────────

# The McpMux release signing key (also the APT repository key). Every
# download must carry a detached signature made by this exact key.
SIGNING_KEY_URL="https://apt.mcpmux.com/key.gpg"
SIGNING_KEY_FPR="E196CB0DB3E0B26F65F17AA2C184B00D5E9016FE"

# Downloads land in a private temp dir rather than a fixed /tmp path that
# another local user could pre-create, and are removed on exit. apt reads
# local packages as the unprivileged _apt user, so the dir is world-readable
# (never writable).
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
chmod 755 "$WORK_DIR"

# Fails closed: no gpg, no signature or a bad signature aborts the install.
# --skip-verify is the only way past it.
verify_signature() {
  local file="$1" asset="$2"
  if [[ "$SKIP_VERIFY" == "true" ]]; then
    warn "Skipping signature verification (--skip-verify)"
    return 0
  fi
  command -v gpg &>/dev/null \\
    || fail "gpg is required to verify the download. Install gnupg and re-run, or pass --skip-verify."

  local sig_url="https://github.com/\${GITHUB_REPO}/releases/download/v\${VERSION}/\${asset}.sig"
  curl -fsSL -o "\${file}.sig" "$sig_url" || fail "Signature not found: $sig_url"

  # Verify in a throwaway keyring and accept only a signature whose primary
  # key is the pinned McpMux key, whatever else the user's keyring trusts.
  local gnupg_home="\${WORK_DIR}/gnupg"
  mkdir -p -m 700 "$gnupg_home"
  curl -fsSL -o "\${WORK_DIR}/signing-key.asc" "$SIGNING_KEY_URL" \\
    || fail "Could not download the signing key: $SIGNING_KEY_URL"
  GNUPGHOME="$gnupg_home" gpg --batch --quiet --import "\${WORK_DIR}/signing-key.asc" 2>/dev/null \\
    || fail "Could not import the signing key"

  local signer
  signer=$(GNUPGHOME="$gnupg_home" gpg --batch --status-fd 1 --verify "\${file}.sig" "$file" 2>/dev/null \\
    | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $NF }') || true
  if [[ "$signer" != "$SIGNING_KEY_FPR" ]]; then
    fail "Signature check failed for \${asset}; not installing. (Pre-releases carry no GPG signature: pass --skip-verify only if you trust the download.)"
  fi
  ok "Signature verified"
}

# ── Install via detected package manager ─────────────────────────────

install_deb() {
  local deb_name="McpMux_\${VERSION}_\${ARCH}.deb"
  local deb_url="https://github.com/\${GITHUB_REPO}/releases/download/v\${VERSION}/\${deb_name}"
  local pkg="\${WORK_DIR}/\${deb_name}"

  info "Downloading .deb package..."
  curl -fsSL -o "$pkg" "$deb_url" || fail "Download failed: $deb_url"
  verify_signature "$pkg" "$deb_name"

  info "Installing..."
  sudo apt-get install -y "$pkg"

  echo ""
  info "Tip: For automatic updates via apt, add the McpMux repository:"
  echo "  curl -fsSL https://install.mcpmux.com/apt | sudo bash"
}

install_rpm() {
  local rpm_arch="\${ARCH}"
  [[ "\${rpm_arch}" == "amd64" ]] && rpm_arch="x86_64"
  [[ "\${rpm_arch}" == "arm64" ]] && rpm_arch="aarch64"
  local rpm_name="McpMux-\${VERSION}-1.\${rpm_arch}.rpm"
  local rpm_url="https://github.com/\${GITHUB_REPO}/releases/download/v\${VERSION}/\${rpm_name}"
  local pkg="\${WORK_DIR}/\${rpm_name}"

  info "Downloading .rpm package..."
  curl -fsSL -o "$pkg" "$rpm_url" || fail "Download failed: $rpm_url"
  verify_signature "$pkg" "$rpm_name"

  info "Installing..."
  sudo dnf install -y "$pkg"
}

install_pacman() {
  if command -v yay &>/dev/null; then
    info "Installing from AUR via yay..."
    yay -S mcpmux-bin
  elif command -v paru &>/dev/null; then
    info "Installing from AUR via paru..."
    paru -S mcpmux-bin
  else
    warn "No AUR helper found (yay or paru)."
    echo ""
    echo "Option 1: Install an AUR helper first:"
    echo "  sudo pacman -S --needed git base-devel"
    echo "  git clone https://aur.archlinux.org/yay-bin.git && cd yay-bin && makepkg -si"
    echo "  yay -S mcpmux-bin"
    echo ""
    echo "Option 2: Download the AppImage:"
    echo "  https://github.com/\${GITHUB_REPO}/releases/latest"
    exit 1
  fi
}

install_appimage() {
  local appimage_name="McpMux_\${VERSION}_\${ARCH}.AppImage"
  local appimage_url="https://github.com/\${GITHUB_REPO}/releases/download/v\${VERSION}/\${appimage_name}"
  local install_dir="\${HOME}/.local/bin"
  local install_path="\${install_dir}/McpMux.AppImage"

  info "No supported package manager found — installing AppImage..."
  mkdir -p "$install_dir"

  info "Downloading AppImage..."
  local download="\${WORK_DIR}/\${appimage_name}"
  curl -fsSL -o "$download" "$appimage_url" || fail "Download failed: $appimage_url"
  verify_signature "$download" "$appimage_name"
  install -m 755 "$download" "$install_path"

  ok "Installed to \${install_path}"

  # Check if ~/.local/bin is in PATH
  if ! echo "$PATH" | tr ':' '\\n' | grep -qx "$install_dir"; then
    echo ""
    warn "~/.local/bin is not in your PATH. Add it with:"
    echo '  echo '\\''export PATH="$HOME/.local/bin:$PATH"'\\'' >> ~/.bashrc'
    echo '  source ~/.bashrc'
  fi
}

# ── Main ─────────────────────────────────────────────────────────────

# Check if APT repo is already configured (prefer managed updates)
if [[ -f /etc/apt/sources.list.d/mcpmux.list ]]; then
  info "McpMux APT repository detected — using apt..."
  sudo apt-get update && sudo apt-get install -y mcp-mux
elif command -v apt-get &>/dev/null; then
  install_deb
elif command -v dnf &>/dev/null; then
  install_rpm
elif command -v pacman &>/dev/null; then
  install_pacman
else
  install_appimage
fi

echo ""
ok "McpMux installed successfully!"
echo "Run 'mcpmux' to start."
`;
}

function aptSetupScript(): string {
  return `#!/usr/bin/env bash
# McpMux APT Repository Setup
# Usage: curl -fsSL https://install.mcpmux.com/apt | sudo bash
set -euo pipefail

info()  { printf '\\033[1;34m%s\\033[0m\\n' "$*"; }
ok()    { printf '\\033[1;32m%s\\033[0m\\n' "$*"; }
fail()  { printf '\\033[1;31mError: %s\\033[0m\\n' "$*" >&2; exit 1; }

# Must run as root
[[ $(id -u) -eq 0 ]] || fail "This script must be run as root (use: curl ... | sudo bash)"

info "Adding McpMux APT repository..."

# Add GPG key
curl -fsSL https://apt.mcpmux.com/key.gpg | gpg --dearmor -o /usr/share/keyrings/mcpmux-archive-keyring.gpg

# Add APT source
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/mcpmux-archive-keyring.gpg] https://apt.mcpmux.com stable main" \\
  > /etc/apt/sources.list.d/mcpmux.list

# Install
apt-get update
apt-get install -y mcp-mux

ok "McpMux installed!"
echo "Updates will arrive automatically via 'apt upgrade'."
`;
}

function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install McpMux</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 640px; padding: 2rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
    p { margin-bottom: 1.5rem; color: #a3a3a3; line-height: 1.6; }
    .code-block { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 1rem 1.25rem; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.9rem; margin-bottom: 1.5rem; position: relative; overflow-x: auto; }
    .code-block code { color: #22c55e; }
    .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #737373; margin-bottom: 0.5rem; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .divider { border: none; border-top: 1px solid #262626; margin: 1.5rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Install McpMux</h1>
    <p>Configure MCP servers once, connect every AI client through a single endpoint.</p>

    <div class="label">Quick install</div>
    <div class="code-block"><code>curl -fsSL https://install.mcpmux.com | bash</code></div>

    <div class="label">Specific version</div>
    <div class="code-block"><code>curl -fsSL https://install.mcpmux.com | bash -s -- --version 0.0.12</code></div>

    <div class="label">APT repository (Debian/Ubuntu)</div>
    <div class="code-block"><code>curl -fsSL https://install.mcpmux.com/apt | sudo bash</code></div>

    <hr class="divider">

    <p>
      <a href="https://github.com/mcpmux/mcp-mux">GitHub</a> &middot;
      <a href="https://mcpmux.com">Website</a> &middot;
      <a href="https://github.com/mcpmux/mcpmux.install">View source</a> &middot;
      <a href="/?raw=1">View script</a>
    </p>
  </div>
</body>
</html>`;
}
