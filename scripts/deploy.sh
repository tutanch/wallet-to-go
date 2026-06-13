#!/usr/bin/env bash
set -euo pipefail

# ─── One-command cross-origin deploy for wallet + keyguard ────────────────
#
# The wallet and keyguard MUST live on separate origins (different domains)
# so keys never leak across the postMessage boundary. GitHub Pages gives
# each org its own subdomain, so we deploy the keyguard to a separate org.
#
# First run:  ./scripts/deploy.sh <keyguard-org-name>
# After that: ./scripts/deploy.sh            (reads saved org name)
#
# Prerequisites:
#   1. gh CLI installed and authenticated    (brew install gh && gh auth login)
#   2. A free GitHub org for the keyguard    (takes 30 seconds)
#      → https://github.com/account/organizations/new
# ──────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ORG_FILE="$ROOT/.keyguard-org"

# ── Parse org name ────────────────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
    ORG="$1"
    echo "$ORG" > "$ORG_FILE"
elif [[ -f "$ORG_FILE" ]]; then
    ORG="$(< "$ORG_FILE")"
else
    echo "Usage: $0 <keyguard-org-name>"
    echo ""
    echo "One-time setup:"
    echo "  1. Create a free GitHub org: https://github.com/account/organizations/new"
    echo "  2. Run: $0 <the-org-name-you-just-created>"
    echo ""
    echo "The keyguard deploys to https://<org>.github.io (separate origin)."
    exit 1
fi

# ── Check prerequisites ──────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
    echo "✗ gh CLI not found. Install: brew install gh"
    exit 1
fi
if ! gh auth status &>/dev/null 2>&1; then
    echo "✗ gh not authenticated. Run: gh auth login"
    exit 1
fi

# ── Detect wallet repo info from git remote ───────────────────────────────
REMOTE_URL="$(cd "$ROOT" && git remote get-url origin)"
OWNER="$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]([^/]+)/.*|\1|')"
REPO="$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/][^/]+/([^/.]+).*|\1|')"

WALLET_ORIGIN="https://${OWNER}.github.io"
if [[ "$REPO" == "${OWNER}.github.io" ]]; then
    WALLET_APP_URL="${WALLET_ORIGIN}/"
else
    WALLET_APP_URL="${WALLET_ORIGIN}/${REPO}/"
fi
KEYGUARD_ORIGIN="https://${ORG}.github.io"
KEYGUARD_REPO="${ORG}.github.io"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       Nimiq Cross-Origin Deploy      ║"
echo "╠══════════════════════════════════════╣"
echo "║  Wallet:   ${WALLET_APP_URL}"
echo "║  Keyguard: ${KEYGUARD_ORIGIN}"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Deploy keyguard ───────────────────────────────────────────────────────
echo "--- Keyguard ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Create org repo if it doesn't exist yet
if ! gh repo view "${ORG}/${KEYGUARD_REPO}" &>/dev/null 2>&1; then
    echo "Creating repo ${ORG}/${KEYGUARD_REPO}..."
    gh repo create "${ORG}/${KEYGUARD_REPO}" --public \
        --description "Nimiq Keyguard – cross-origin key management"
    sleep 3  # let GitHub settle
fi

# Clone the org repo (handle empty repos gracefully)
echo "Syncing keyguard files..."
if ! gh repo clone "${ORG}/${KEYGUARD_REPO}" "$WORK/kg" 2>/dev/null; then
    git init "$WORK/kg"
    git -C "$WORK/kg" remote add origin "https://github.com/${ORG}/${KEYGUARD_REPO}.git"
fi

# Clean old files (keep .git)
find "$WORK/kg" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# Copy keyguard source
cp -R "$ROOT/keyguard/"* "$WORK/kg/"

# Replace [WALLET_ORIGIN] / [WALLET_APP_URL] in the keyguard source (branch
# model: push finished, substituted files; Pages serves them as-is).
sed -i.bak "s|\[WALLET_ORIGIN\]|${WALLET_ORIGIN}|g" "$WORK/kg/index.html"
sed -i.bak "s|\[WALLET_ORIGIN\]|${WALLET_ORIGIN}|g" "$WORK/kg/src/keyguard-app.js"
sed -i.bak "s|\[WALLET_APP_URL\]|${WALLET_APP_URL}|g" "$WORK/kg/src/keyguard-app.js"
rm -f "$WORK/kg/index.html.bak" "$WORK/kg/src/keyguard-app.js.bak"

# .nojekyll so GitHub Pages serves everything as-is
touch "$WORK/kg/.nojekyll"

# ── Wallet-side keyguard integrity manifest ───────────────────────────────
# Hash the EXACT substituted bytes we are about to push, so the wallet can
# cross-verify the live keyguard against them (src/modules/keyguard-verify.js).
# Written into the WALLET repo; it is committed + pushed with the wallet and
# then hash-pinned by the wallet's own service worker.
echo "Generating keyguard integrity manifest..."
MANIFEST="$ROOT/src/keyguard-manifest.js"
( cd "$WORK/kg" && find . -type f -not -path './.git/*' -not -name '.nojekyll' \
    | sed 's|^\./||' | LC_ALL=C sort ) > "$WORK/kg-files.txt"
{
    echo "// AUTO-GENERATED at deploy time by scripts/deploy.sh — do not edit by hand."
    echo "// SHA-256 of every served keyguard file + an overall fingerprint digest."
    echo "// Hash-pinned by the wallet service worker. See src/modules/keyguard-verify.js."
    echo "export const KEYGUARD_MANIFEST = {"
    echo "    files: {"
} > "$MANIFEST"
: > "$WORK/kg-digest.txt"
while IFS= read -r rel; do
    h="sha256-$(openssl dgst -sha256 -binary "$WORK/kg/$rel" | openssl base64)"
    printf '        "%s": "%s",\n' "$rel" "$h" >> "$MANIFEST"
    printf '%s %s\n' "$rel" "$h" >> "$WORK/kg-digest.txt"
done < "$WORK/kg-files.txt"
DIGEST="sha256-$(openssl dgst -sha256 -binary "$WORK/kg-digest.txt" | openssl base64)"
{
    echo "    },"
    printf '    digest: "%s",\n' "$DIGEST"
    echo "};"
} >> "$MANIFEST"
echo "Keyguard manifest: $(wc -l < "$WORK/kg-files.txt" | tr -d ' ') files, digest ${DIGEST}"

# Commit and push the finished keyguard files (branch model)
cd "$WORK/kg"
git add -A
if git diff --cached --quiet 2>/dev/null; then
    echo "Keyguard: no changes to deploy."
else
    git commit -m "Deploy keyguard"
    git branch -M main
    git push -u origin main --force
    echo "Keyguard pushed to ${ORG}/${KEYGUARD_REPO}!"
fi
cd "$ROOT"

# Serve the keyguard repo from the main branch (revert any Actions-mode Pages
# config from earlier deploys; harmless if already branch-served).
gh api "repos/${ORG}/${KEYGUARD_REPO}/pages" -X PUT -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api "repos/${ORG}/${KEYGUARD_REPO}/pages" -X POST -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || true

echo "Keyguard live at ${KEYGUARD_ORIGIN}"
echo "Wallet src/keyguard-manifest.js updated — commit + push the wallet to apply."
echo ""

# ── Update wallet workflow ────────────────────────────────────────────────
echo "--- Wallet ---"

mkdir -p "$ROOT/.github/workflows"
# NOTE: the `uses: actions/...@vN` pins in the heredoc below are the SOURCE OF
# TRUTH for the deploy workflow. Dependabot (.github/dependabot.yml) opens PRs
# that bump these in the generated .github/workflows/deploy.yml, but the next
# run of this script REGENERATES that file and reverts the bump — so when you
# merge a Dependabot action update, mirror the new version into the heredoc here.
cat > "$ROOT/.github/workflows/deploy.yml" << WORKFLOW_EOF
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Replace origin placeholders
        run: |
          sed -i "s|\[KEYGUARD_ORIGIN\]|${KEYGUARD_ORIGIN}|g" index.html
          sed -i "s|\[KEYGUARD_ORIGIN\]|${KEYGUARD_ORIGIN}|g" src/modules/keyguard-api.js
          sed -i "s|\[KEYGUARD_ORIGIN\]|${KEYGUARD_ORIGIN}|g" src/modules/webauthn.js

      - name: Generate service worker with integrity hashes
        run: node scripts/generate-sw.js

      - run: touch .nojekyll

      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - uses: actions/deploy-pages@v4
        id: deployment
WORKFLOW_EOF

echo "Wallet workflow written to .github/workflows/deploy.yml"
echo ""

# ── Done ──────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════╗"
echo "║            All done!                 ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Commit and push the updated workflow:"
echo "     git add .github/workflows/deploy.yml .keyguard-org && git commit -m 'Update deploy workflow for ${ORG}' && git push"
echo ""
echo "  2. Enable Pages on the wallet repo (one-time):"
echo "     https://github.com/${OWNER}/${REPO}/settings/pages"
echo "     → Source: GitHub Actions"
echo ""
echo "After that, every push to main auto-deploys the wallet."
echo "To update the keyguard, run: ./scripts/deploy.sh"
