#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# EtthusHUB - Raspberry Pi Installation Script
# ──────────────────────────────────────────────────────────────────────────────
# Run this on a fresh Raspberry Pi OS (Lite or Desktop) to set up the
# EtthusControl Matter smart home hub.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/.../install.sh | sudo bash
#    or: sudo bash install.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

HUB_DIR="/opt/etthus-hub"
NODE_MAJOR="20"  # Node.js 20.x LTS

# ─── Helper Functions ────────────────────────────────────────────────────────
log_info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${BLUE}==== $1 ====${NC}"; }

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)."
        exit 1
    fi
}

is_raspberry_pi() {
    if grep -qi "raspberry" /proc/cpuinfo 2>/dev/null; then
        return 0
    fi
    if grep -qi "bcm" /proc/cpuinfo 2>/dev/null; then
        return 0
    fi
    return 1
}

# ─── Main Installation ───────────────────────────────────────────────────────
main() {
    log_step "EtthusHUB Installer"
    
    # Check if running as root
    check_root

    # Detect platform
    if is_raspberry_pi; then
        log_info "Raspberry Pi detected."
    else
        log_warn "This does not appear to be a Raspberry Pi. Continuing anyway..."
    fi

    # ── 1. System Update ─────────────────────────────────────────────────────
    log_step "1/7  Updating system packages"
    apt-get update -y
    apt-get upgrade -y

    # ── 2. Install System Dependencies ───────────────────────────────────────
    log_step "2/7  Installing system dependencies"

    # Core build tools
    apt-get install -y curl wget git build-essential

    # Python 3 + pip (for Plejd BLE bridge)
    apt-get install -y python3 python3-pip

    # Bluetooth (for Matter BLE commissioning)
    apt-get install -y bluetooth bluez libbluetooth-dev

    # Avahi/Bonjour (for Matter mDNS discovery)
    apt-get install -y avahi-daemon avahi-utils libavahi-compat-libdnssd-dev

    # Graphics libs needed by matter.js (for QR code generation, etc.)
    apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

    # Install pyplejd for Plejd BLE bridge
    pip3 install pyplejd || log_warn "pyplejd install failed (may need --break-system-packages)"

    log_info "System dependencies installed."

    # ── 3. Install Node.js 20.x LTS ──────────────────────────────────────────
    log_step "3/7  Installing Node.js ${NODE_MAJOR}.x"

    if command -v node &>/dev/null; then
        CURRENT_NODE=$(node -v | cut -d. -f1 | sed 's/v//')
        if [[ "$CURRENT_NODE" -ge "$NODE_MAJOR" ]]; then
            log_info "Node.js $(node -v) already installed. Skipping."
        else
            log_warn "Node.js $(node -v) is too old. Installing ${NODE_MAJOR}.x..."
            install_nodejs
        fi
    else
        install_nodejs
    fi

    log_info "Node.js $(node -v) installed."
    log_info "npm $(npm -v)"

    # ── 4. Create Hub Directory & Copy Files ─────────────────────────────────
    log_step "4/7  Setting up EtthusHUB directory"

    if [[ -d "$HUB_DIR" ]]; then
        log_warn "${HUB_DIR} already exists."
        read -rp "Overwrite? [y/N] " OVERWRITE
        if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
            rm -rf "$HUB_DIR"
        else
            log_error "Installation aborted."
            exit 1
        fi
    fi

    mkdir -p "$HUB_DIR"

    # Copy all files from the source directory (where this script lives)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [[ -f "$SCRIPT_DIR/package.json" ]]; then
        log_info "Copying files from $SCRIPT_DIR ..."
        cp -r "$SCRIPT_DIR"/src "$HUB_DIR/"
        cp "$SCRIPT_DIR"/package.json "$HUB_DIR/"
        cp "$SCRIPT_DIR"/tsconfig.json "$HUB_DIR/"
        
        # Copy Plejd bridge
        if [[ -d "$SCRIPT_DIR/plejd-bridge" ]]; then
            cp -r "$SCRIPT_DIR"/plejd-bridge "$HUB_DIR/"
            log_info "Plejd bridge copied."
        fi

        # Copy .env if it exists in source, otherwise copy example
        if [[ -f "$SCRIPT_DIR/.env" ]]; then
            cp "$SCRIPT_DIR/.env" "$HUB_DIR/"
        else
            cp "$SCRIPT_DIR/.env.example" "$HUB_DIR/.env"
        fi
    else
        log_warn "Source files not found at $SCRIPT_DIR. Creating from embedded templates..."
        # If running via curl pipe, we need to create files manually
        # This case is handled by downloading from GitHub
        log_error "Please run this script from within the etthusHUB directory."
        exit 1
    fi

    # ── 5. Install npm Dependencies ──────────────────────────────────────────
    log_step "5/7  Installing Node.js dependencies"
    cd "$HUB_DIR"
    
    # Set npm config for Pi (avoid memory issues on low-RAM models)
    export NODE_OPTIONS="--max-old-space-size=512"
    
    npm install --production --no-audit --no-fund 2>&1 | tail -20
    
    # Also install devDependencies for ts-node at runtime
    npm install --no-audit --no-fund 2>&1 | tail -20

    # Install plejd-bridge dependencies
    if [[ -d "$HUB_DIR/plejd-bridge" ]]; then
        log_info "Installing Plejd bridge dependencies..."
        cd "$HUB_DIR/plejd-bridge"
        npm install --no-audit --no-fund 2>&1 | tail -10
        cd "$HUB_DIR"
    fi

    log_info "Dependencies installed."

    # ── 6. Set up systemd Service ────────────────────────────────────────────
    log_step "6/7  Installing systemd service"

    SERVICE_FILE="/etc/systemd/system/etthus-hub.service"

    cat > "$SERVICE_FILE" << SERVICE_EOF
[Unit]
Description=EtthusHUB - Matter Smart Home Controller
Documentation=https://github.com/etthuscontrol/etthus-hub
After=network-online.target bluetooth.target avahi-daemon.service
Wants=network-online.target bluetooth.target avahi-daemon.service

[Service]
Type=simple
User=root
WorkingDirectory=$HUB_DIR
ExecStart=$(which node) $(which ts-node) src/server.ts
ExecStop=/bin/kill -SIGTERM \$MAINPID
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=etthus-hub

# Environment
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=MATTER_STORAGE_PATH=$HUB_DIR/.matter-storage

# Security hardening (uncomment once tested)
# NoNewPrivileges=yes
# ProtectSystem=strict
# ProtectHome=yes
# ReadWritePaths=$HUB_DIR/.matter-storage

# Allow Matter to use network features
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_NET_ADMIN

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    systemctl daemon-reload
    systemctl enable etthus-hub.service
    log_info "Hub service installed and enabled."

    # Install Plejd bridge service if available
    if [[ -f "$HUB_DIR/plejd-bridge/plejd-bridge.service" ]]; then
        log_info "Installing Plejd bridge service..."
        cp "$HUB_DIR/plejd-bridge/plejd-bridge.service" /etc/systemd/system/
        systemctl enable plejd-bridge.service
        log_info "Plejd bridge service installed."
    fi

    # ── 7. Enable Bluetooth for Matter ──────────────────────────────────────
    log_step "7/7  Configuring Bluetooth"

    # Unblock Bluetooth if it was soft-blocked
    if command -v rfkill &>/dev/null; then
        rfkill unblock bluetooth 2>/dev/null || true
    fi

    # Enable and start bluetooth service
    systemctl enable bluetooth 2>/dev/null || true
    systemctl restart bluetooth 2>/dev/null || true

    log_info "Bluetooth enabled."

    # ── Done ─────────────────────────────────────────────────────────────────
    log_step "Installation Complete!"
    echo ""
    echo -e "${GREEN}EtthusHUB has been installed successfully!${NC}"
    echo ""
    echo "  Directory:     $HUB_DIR"
    echo "  Service:       systemctl status etthus-hub"
    echo "  Logs:          journalctl -u etthus-hub -f"
    echo "  Health check:  http://localhost:3001/api/status"
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "  1. Edit $HUB_DIR/.env to configure your hub"
    echo "  2. Start:   sudo systemctl start etthus-hub"
    echo "  3. Status:  sudo systemctl status etthus-hub"
    echo "  4. Logs:    sudo journalctl -u etthus-hub -f"
    echo ""
    echo -e "${BLUE}The hub is now ready to pair with your EtthusControl Matter app!${NC}"
    echo ""

    # Ask if user wants to start now
    read -rp "Start the hub now? [Y/n] " START_NOW
    if [[ ! "$START_NOW" =~ ^[Nn]$ ]]; then
        systemctl start etthus-hub
        sleep 3
        echo ""
        systemctl status etthus-hub --no-pager
    fi
}

install_nodejs() {
    log_info "Setting up NodeSource repository for Node.js ${NODE_MAJOR}.x..."
    
    # Detect Debian version
    if command -v lsb_release &>/dev/null; then
        CODENAME=$(lsb_release -cs)
    else
        CODENAME="bookworm"  # Default for latest Raspberry Pi OS
    fi

    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y nodejs
}

# ─── Run ─────────────────────────────────────────────────────────────────────
main "$@"
