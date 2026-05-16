#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# EtthusHUB - Bluetooth Configuration for Matter BLE Commissioning
# ──────────────────────────────────────────────────────────────────────────────
# Run this on the Raspberry Pi to enable BLE for Matter device pairing.
# Matter devices often use BLE for initial commissioning before switching
# to IP-based communication.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

log_info()  { echo -e "\033[0;32m[INFO]\033[0m  $1"; }
log_warn()  { echo -e "\033[1;33m[WARN]\033[0m  $1"; }
log_check() { echo -e "\033[0;34m[CHECK]\033[0m $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (use sudo)."
    exit 1
fi

log_info "Configuring Bluetooth for Matter BLE commissioning..."

# Install Bluetooth packages
apt-get update -qq
apt-get install -y -qq bluetooth bluez bluez-tools libbluetooth-dev

# Unblock Bluetooth
if command -v rfkill &>/dev/null; then
    rfkill unblock bluetooth 2>/dev/null || true
    log_info "Bluetooth rfkill unblocked."
fi

# Enable and start bluetooth service
systemctl enable bluetooth 2>/dev/null || true
systemctl restart bluetooth 2>/dev/null || true

sleep 2

# Verify Bluetooth is working
log_check "Checking Bluetooth status..."
if systemctl is-active --quiet bluetooth; then
    log_info "Bluetooth service is running."
else
    log_warn "Bluetooth service failed to start. Check: systemctl status bluetooth"
fi

if command -v hciconfig &>/dev/null; then
    log_check "Bluetooth adapters:"
    hciconfig -a 2>/dev/null || log_warn "No Bluetooth adapter found via hciconfig."
elif command -v bluetoothctl &>/dev/null; then
    log_check "Bluetooth devices (via bluetoothctl):"
    echo "power on" | bluetoothctl 2>/dev/null || true
    bluetoothctl devices 2>/dev/null || log_warn "bluetoothctl command failed."
fi

# Configure Bluetooth for Matter (advertising enabled)
if command -v btmgmt &>/dev/null; then
    btmgmt power on 2>/dev/null || true
    btmgmt le on 2>/dev/null || true
    btmgmt bredr on 2>/dev/null || true
    log_info "Bluetooth LE and BR/EDR enabled."
fi

# Allow non-root access to Bluetooth (for Node.js BLE libraries)
if command -v setcap &>/dev/null; then
    log_info "Setting capabilities for Node.js Bluetooth access..."
    # Find node binary
    NODE_BIN=$(which node)
    if [[ -n "$NODE_BIN" ]]; then
        setcap cap_net_raw+eip "$NODE_BIN" 2>/dev/null || log_warn "setcap on node failed (may need to install libcap2-bin)"
    fi
fi

log_info "Bluetooth configuration complete."
log_info "You may need to reboot for all changes to take effect."
echo ""
echo "To test:    sudo bluetoothctl scan on"
echo "To verify:  sudo hciconfig -a"
