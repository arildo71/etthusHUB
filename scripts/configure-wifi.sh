#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# EtthusHUB - WiFi Configuration Tool
# ──────────────────────────────────────────────────────────────────────────────
# Interactive WiFi setup for headless Raspberry Pi.
# Run: sudo bash configure-wifi.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

log_info()  { echo -e "\033[0;32m[INFO]\033[0m  $1"; }
log_warn()  { echo -e "\033[1;33m[WARN]\033[0m  $1"; }

WPA_FILE="/etc/wpa_supplicant/wpa_supplicant.conf"

if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (use sudo)."
    exit 1
fi

echo ""
echo "═════════════════════════════════════════"
echo "  EtthusHUB - WiFi Configuration"
echo "═════════════════════════════════════════"
echo ""

# Scan for networks
if command -v iwlist &>/dev/null; then
    log_info "Scanning for WiFi networks..."
    IFACE=$(iw dev | awk '/Interface/ {print $2}' | head -1)
    if [[ -n "$IFACE" ]]; then
        iwlist "$IFACE" scan 2>/dev/null | grep -E "ESSID:" | sed 's/.*ESSID:"\(.*\)"/  • \1/' | sort -u || true
        echo ""
    fi
fi

read -rp "WiFi SSID: " SSID
read -rsp "WiFi Password: " PASSWORD
echo ""

if [[ -z "$SSID" ]]; then
    log_warn "No SSID provided. Skipping WiFi setup."
    exit 0
fi

# Generate WPA passphrase
WPA_PASSPHRASE=$(wpa_passphrase "$SSID" "$PASSWORD" 2>/dev/null | grep -v "^#" | grep "psk=" || true)

if [[ -z "$WPA_PASSPHRASE" ]]; then
    log_warn "Could not generate passphrase. Trying raw password."
    WPA_PASSPHRASE="psk=\"$PASSWORD\""
fi

# Backup existing config
if [[ -f "$WPA_FILE" ]]; then
    cp "$WPA_FILE" "${WPA_FILE}.bak.$(date +%s)"
    log_info "Backed up existing config."
fi

# Write new network block
cat >> "$WPA_FILE" << WPAEOF

# Added by EtthusHUB WiFi Configurator
network={
    ssid="$SSID"
    $WPA_PASSPHRASE
    key_mgmt=WPA-PSK
}
WPAEOF

log_info "WiFi configuration written to $WPA_FILE"

# Apply changes
wpa_cli -i wlan0 reconfigure 2>/dev/null || log_warn "Could not reconfigure WiFi. Run: sudo systemctl restart wpa_supplicant"

echo ""
log_info "WiFi configured. The Raspberry Pi will auto-connect to '$SSID'."
log_info "Reboot to apply: sudo reboot"
