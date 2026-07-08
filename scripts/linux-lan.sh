#!/usr/bin/env bash
set -euo pipefail

ACTION="status"
PORT="12778"
FIREWALL="auto"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/linux-lan.sh [status|install|remove] [--port PORT] [--firewall auto|ufw|firewalld] [--dry-run]

Manages narrow inbound LAN firewall rules for muxpilot on native Linux.

Commands:
  status      Show LAN addresses, listeners, firewall state, and connection checks.
  install     Allow inbound TCP traffic for the selected muxpilot Web UI/trust port.
  remove      Remove the muxpilot-owned firewall rule/profile for the selected port.

Options:
  -p, --port PORT                 TCP port to inspect or expose. Default: 12778.
      --firewall auto|ufw|firewalld
                                   Firewall manager to use for install/remove. Default: auto.
      --dry-run                   Print the commands/files that would be changed.
  -h, --help                      Show this help.
EOF
}

while (($#)); do
  case "$1" in
    status|install|remove)
      ACTION="$1"
      shift
      ;;
    -p|--port)
      PORT="${2:-}"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    --firewall)
      FIREWALL="${2:-}"
      shift 2
      ;;
    --firewall=*)
      FIREWALL="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

if [[ "$FIREWALL" != "auto" && "$FIREWALL" != "ufw" && "$FIREWALL" != "firewalld" ]]; then
  echo "Invalid firewall: $FIREWALL" >&2
  exit 2
fi

RULE_SLUG="muxpilot-web-${PORT}"
RULE_LABEL="muxpilot Web ${PORT}"
UFW_PROFILE_PATH="/etc/ufw/applications.d/${RULE_SLUG}"
FIREWALLD_SERVICE_PATH="/etc/firewalld/services/${RULE_SLUG}.xml"

have() {
  command -v "$1" >/dev/null 2>&1
}

run_root() {
  if ((DRY_RUN)); then
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    echo "Root privileges are required. Re-run as root or install sudo." >&2
    exit 1
  fi
}

write_root_file() {
  local path="$1"
  local content="$2"

  if ((DRY_RUN)); then
    echo "DRY RUN: write $path"
    printf '%s\n' "$content"
    return 0
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    printf '%s\n' "$content" >"$path"
  elif have sudo; then
    printf '%s\n' "$content" | sudo tee "$path" >/dev/null
  else
    echo "Root privileges are required. Re-run as root or install sudo." >&2
    exit 1
  fi
}

detect_firewall() {
  if [[ "$FIREWALL" != "auto" ]]; then
    echo "$FIREWALL"
    return
  fi
  if have ufw; then
    echo "ufw"
    return
  fi
  if have firewall-cmd; then
    echo "firewalld"
    return
  fi
  echo "none"
}

lan_addresses() {
  if have ip; then
    local output
    output="$(ip -o -4 addr show scope global 2>/dev/null || true)"
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output" |
      awk '{ split($4, addr, "/"); if (addr[1] !~ /^169\.254\./ && addr[1] !~ /^127\./) print addr[1] }' |
      sort -u
      return 0
    fi
  fi

  if have hostname; then
    hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ && $0 !~ /^169\.254\./'
  fi
}

show_status() {
  echo "muxpilot Linux LAN status"
  echo
  echo "System"
  if [[ -r /etc/os-release ]]; then
    awk -F= '/^(PRETTY_NAME|ID|VERSION_ID)=/ { gsub(/^"|"$/, "", $2); print "  " $1 ": " $2 }' /etc/os-release
  fi
  echo "  Kernel: $(uname -srmo 2>/dev/null || uname -a)"

  echo
  echo "LAN IPv4 addresses"
  local addresses
  addresses="$(lan_addresses || true)"
  if [[ -n "$addresses" ]]; then
    printf '%s\n' "$addresses" | sed 's/^/  /'
  else
    echo "  (none detected)"
  fi

  echo
  echo "Listeners for TCP $PORT"
  if have ss; then
    ss -ltnp "sport = :$PORT" 2>/dev/null || true
  elif have netstat; then
    netstat -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port { print }'
  else
    echo "  ss/netstat not found"
  fi

  echo
  echo "Firewall manager"
  local manager
  manager="$(detect_firewall)"
  echo "  Detected: $manager"

  if have ufw; then
    echo
    echo "ufw"
    ufw status verbose 2>/dev/null || true
    if [[ -r "$UFW_PROFILE_PATH" ]]; then
      echo
      echo "ufw muxpilot profile"
      sed 's/^/  /' "$UFW_PROFILE_PATH"
    fi
  fi

  if have firewall-cmd; then
    echo
    echo "firewalld"
    firewall-cmd --state 2>/dev/null || true
    firewall-cmd --get-default-zone 2>/dev/null | sed 's/^/  Default zone: /' || true
    firewall-cmd --list-services 2>/dev/null | sed 's/^/  Services: /' || true
    firewall-cmd --list-ports 2>/dev/null | sed 's/^/  Ports: /' || true
    if firewall-cmd --permanent --info-service="$RULE_SLUG" >/dev/null 2>&1; then
      firewall-cmd --permanent --info-service="$RULE_SLUG" 2>/dev/null | sed 's/^/  /'
    fi
  fi

  if have nft; then
    echo
    echo "nftables diagnostic"
    nft list ruleset 2>/dev/null | grep -E "dport[[:space:]]+$PORT|dport[[:space:]]+\\{[^}]*\\b$PORT\\b" || echo "  no explicit TCP dport $PORT rule found"
  fi

  if have iptables; then
    echo
    echo "iptables diagnostic"
    iptables -S 2>/dev/null | grep -E -- "--dport $PORT\\b|dpt:$PORT\\b" || echo "  no explicit TCP dport $PORT rule found"
  fi

  echo
  echo "Connection checks"
  check_connect "127.0.0.1"
  while IFS= read -r address; do
    [[ -n "$address" ]] && check_connect "$address"
  done <<<"$addresses"

  return 0
}

check_connect() {
  local host="$1"
  if have nc; then
    if nc -z -w 2 "$host" "$PORT" >/dev/null 2>&1; then
      echo "  $host:$PORT reachable"
    else
      echo "  $host:$PORT not reachable"
    fi
  else
    echo "  $host:$PORT skipped (nc not found)"
  fi
}

install_ufw() {
  if ! have ufw && ((DRY_RUN == 0)); then
    echo "ufw was selected but the ufw command was not found." >&2
    exit 1
  fi

  local profile
  profile="[$RULE_LABEL]
title=$RULE_LABEL
description=muxpilot LAN Web UI or trust server port
ports=$PORT/tcp"

  write_root_file "$UFW_PROFILE_PATH" "$profile"
  run_root ufw app update "$RULE_LABEL"
  run_root ufw allow "$RULE_LABEL"
  echo "Installed muxpilot ufw profile for TCP $PORT."
}

remove_ufw() {
  if ! have ufw && ((DRY_RUN == 0)); then
    echo "ufw was selected but the ufw command was not found." >&2
    exit 1
  fi

  run_root ufw --force delete allow "$RULE_LABEL" || true
  run_root rm -f "$UFW_PROFILE_PATH"
  echo "Removed muxpilot ufw profile for TCP $PORT."
}

install_firewalld() {
  if ! have firewall-cmd && ((DRY_RUN == 0)); then
    echo "firewalld was selected but the firewall-cmd command was not found." >&2
    exit 1
  fi

  local service
  service="<?xml version=\"1.0\" encoding=\"utf-8\"?>
<service>
  <short>$RULE_LABEL</short>
  <description>muxpilot LAN Web UI or trust server port</description>
  <port protocol=\"tcp\" port=\"$PORT\"/>
</service>"

  write_root_file "$FIREWALLD_SERVICE_PATH" "$service"
  run_root firewall-cmd --reload
  run_root firewall-cmd --permanent --add-service="$RULE_SLUG"
  run_root firewall-cmd --reload
  echo "Installed muxpilot firewalld service for TCP $PORT."
}

remove_firewalld() {
  if ! have firewall-cmd && ((DRY_RUN == 0)); then
    echo "firewalld was selected but the firewall-cmd command was not found." >&2
    exit 1
  fi

  run_root firewall-cmd --permanent --remove-service="$RULE_SLUG" || true
  run_root rm -f "$FIREWALLD_SERVICE_PATH"
  run_root firewall-cmd --reload
  echo "Removed muxpilot firewalld service for TCP $PORT."
}

manager="$(detect_firewall)"

case "$ACTION" in
  status)
    show_status
    ;;
  install)
    case "$manager" in
      ufw) install_ufw ;;
      firewalld) install_firewalld ;;
      none)
        echo "No supported Linux firewall manager found." >&2
        echo "Install ufw or firewalld, or manually allow inbound TCP $PORT from your trusted LAN." >&2
        exit 1
        ;;
    esac
    ;;
  remove)
    case "$manager" in
      ufw) remove_ufw ;;
      firewalld) remove_firewalld ;;
      none)
        echo "No supported Linux firewall manager found." >&2
        echo "If you added manual rules, remove the inbound TCP $PORT rule from your firewall." >&2
        exit 1
        ;;
    esac
    ;;
esac
