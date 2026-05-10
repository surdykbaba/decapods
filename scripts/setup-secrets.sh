#!/usr/bin/env bash
# Interactive one-shot for the GitHub secrets this repo uses.
#
# Usage:
#   ./scripts/setup-secrets.sh                       # set every secret
#   ./scripts/setup-secrets.sh ssh                   # only SSH-deploy secrets
#   ./scripts/setup-secrets.sh mailgun               # only Mailgun
#   ./scripts/setup-secrets.sh crypto                # only MASTER_KEY
#
# Each value is read silently from stdin so nothing leaks into shell
# history. MASTER_KEY can be auto-generated.

set -euo pipefail

REPO="${REPO:-surdykbaba/decapods}"
WHICH="${1:-all}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing $1 — install it first"; exit 1; }
}
require gh
require openssl

# Prompt for a value; never echoes characters. Pipes the value to gh secret set.
ask_set() {
  local name="$1" hint="${2:-}"
  printf "  %-22s " "$name"
  [ -n "$hint" ] && printf "(%s) " "$hint"
  printf "→ "
  read -rs value
  echo
  if [ -z "$value" ]; then
    echo "    skipped (empty)"
    return
  fi
  printf '%s' "$value" | gh secret set "$name" -R "$REPO" --body -
}

# Set a secret from a literal value (no prompt).
set_literal() {
  local name="$1" value="$2"
  printf '%s' "$value" | gh secret set "$name" -R "$REPO" --body -
  echo "  $name set."
}

setup_ssh() {
  echo "→ SSH deployment"
  ask_set SSH_HOST     "deploy host, e.g. deploy.example.com"
  ask_set SSH_USER     "ssh username, e.g. ubuntu"
  ask_set SSH_PORT     "22 unless non-standard"
  ask_set SSH_PASSWORD "the SSH password"
}

setup_mailgun() {
  echo "→ Mailgun SMTP"
  ask_set MAILGUN_SMTP_HOST "smtp.mailgun.org"
  ask_set MAILGUN_SMTP_PORT "587"
  ask_set MAILGUN_SMTP_USER "postmaster@mg.your-domain.com"
  ask_set MAILGUN_SMTP_PASS "the SMTP password"
  ask_set MAILGUN_FROM      "PGDP <no-reply@your-domain.com>"
}

setup_crypto() {
  echo "→ Application-side encryption"
  printf "  Generate a fresh MASTER_KEY now? [Y/n] "
  read -r yn
  if [ "$yn" = "n" ] || [ "$yn" = "N" ]; then
    ask_set MASTER_KEY "32-byte key, base64-encoded"
  else
    local key
    key="$(openssl rand -base64 32)"
    set_literal MASTER_KEY "$key"
    echo "  ⚠  This key was just generated. Store it somewhere safe (1Password, Vault)"
    echo "     — if you lose it, every Tier-2 column becomes unrecoverable."
    echo "     ${key}"
  fi
  ask_set BLIND_INDEX_SALT "any random string; leave blank to derive from MASTER_KEY"
}

case "$WHICH" in
  all)     setup_ssh; setup_mailgun; setup_crypto ;;
  ssh)     setup_ssh ;;
  mailgun) setup_mailgun ;;
  crypto)  setup_crypto ;;
  *) echo "unknown subset: $WHICH"; exit 2 ;;
esac

echo
echo "✓ done. inspect with:  gh secret list -R $REPO"
