# EtthusHUB - Smart Home Hub for Raspberry Pi

Turns any Raspberry Pi into a Matter smart home hub. Runs the EtthusControl backend, pairs with Matter-compatible smart home devices, and communicates with the EtthusControl Matter app via Firebase.

## How It Works

```
┌─────────────────────┐       Firestore        ┌──────────────────────┐
│  EtthusControl App  │ ◄──────────────────────► │     EtthusHUB        │
│  (Web PWA on phone) │   commands / devices    │  (Raspberry Pi)      │
└─────────────────────┘                         └──────┬───────────────┘
                                                        │
                                        ┌───────────────┼───────────────┐
                                   Matter Protocol   BLE (Plejd)     Matter
                                                        │               │
                                           ┌────────────┼────────────┐   │
                                           ▼            ▼            ▼   ▼
                                       ┌──────┐    ┌──────┐    ┌──────┐
                                       │ Hue  │    │Plug  │    │ Lock │
                                       │Bridge│    │      │    │      │
                                       └──────┘    └──────┘    └──────┘
                                                        ┌──────┐    ┌──────┐
                                                        │Plejd │    │Plejd │
                                                        │ Dim  │    │Switch│
                                                        └──────┘    └──────┘
```

- **App** sends commands by writing to Firestore (Firebase)
- **EtthusHUB** listens to Firestore, translates commands to Matter protocol or Plejd BLE
- **Matter devices** receive commands over local IPv6 network
- **Plejd devices** receive commands via BLE mesh gateway
- Device state is synced back to Firestore in real time

## Requirements

- Raspberry Pi 3B+, 4, or 5 (2GB+ RAM recommended)
- Raspberry Pi OS (Bookworm, Lite or Desktop) — 64-bit recommended
- Stable internet connection (for Firebase sync)
- The Raspberry Pi and your Matter devices must be on the same local network

## Quick Install (Raspberry Pi)

From a fresh Raspberry Pi OS installation:

```bash
# Clone or copy the etthusHUB folder to your Pi, then:
cd etthusHUB
sudo bash install.sh
```

The install script handles:
1. System update
2. Node.js 20.x LTS installation
3. Bluetooth, Avahi, and system dependencies
4. npm dependency installation
5. systemd service setup (auto-start on boot)
6. Bluetooth configuration for BLE commissioning

After installation:

```bash
# Check status
sudo systemctl status etthus-hub

# View logs
sudo journalctl -u etthus-hub -f

# Health check
curl http://localhost:3001/api/status
```

## Manual Setup

If you prefer to set up manually:

```bash
# Install prerequisites
sudo apt-get update
sudo apt-get install -y curl git build-essential bluetooth bluez libbluetooth-dev \
    avahi-daemon libavahi-compat-libdnssd-dev libcairo2-dev libpango1.0-dev

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Clone and install
cd /opt
sudo mkdir etthus-hub
sudo cp -r /path/to/etthusHUB/* .
sudo npm install
sudo npm install ts-node typescript  # dev deps needed for ts-node runtime

# Run
sudo npx ts-node src/server.ts
```

## Docker

```bash
docker compose up -d
```

Note: Docker requires `--network host` and `--privileged` for Matter's mDNS discovery and BLE commissioning to work correctly.

## Configuration

Edit `.env` or set environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_NAME` | `EtthusHUB` | Human-readable hub name |
| `PORT` | `3001` | Health-check API port |
| `MATTER_STORAGE_PATH` | `./.matter-storage` | Persistent Matter fabric storage |
| `FIREBASE_API_KEY` | *(project default)* | Firebase API key |
| `FIREBASE_PROJECT_ID` | `etthuscontrol-matter` | Firebase project ID |
| `FIREBASE_DB_NAME` | `etthuscontrolmatter` | Firestore database name |

## Pairing a Device

1. Open the **EtthusControl Matter** app on your phone
2. Go to **Settings**
3. Enter the Matter pairing code from your device
4. Tap **Submit**

The hub automatically detects the pairing request in Firestore, commissions the device on your local Matter network, and syncs it to the app.

## WiFi Setup (Headless)

```bash
sudo bash scripts/configure-wifi.sh
```

## Bluetooth Setup

```bash
sudo bash scripts/configure-bluetooth.sh
```

BLE is used during initial pairing of some Matter devices. After pairing, devices communicate over IP (WiFi/Ethernet).

## Troubleshooting

**Hub won't start:**
```bash
sudo journalctl -u etthus-hub -n 50 --no-pager
```

**Matter commissioning fails:**
- Ensure the Raspberry Pi and device are on the same network
- Check the device supports Matter over IP (not BLE-only)
- Verify the pairing code is correct

**Firebase connection fails:**
- Check internet connectivity on the Pi
- Verify firewall allows outbound HTTPS (port 443)

**Devices not appearing in the app:**
```bash
curl http://localhost:3001/api/status
```
Check that `matter: true` is returned, meaning the Matter controller is running.

## Plejd Bridge (BLE Lighting Control)

The Plejd bridge connects to Plejd BLE mesh lighting devices. For full documentation, see [docs/plejd-integration.md](../docs/plejd-integration.md).

### Quick Setup

```bash
# Install pyplejd (must be v0.1)
sudo pip3 install --break-system-packages pyplejd==0.1

# Deploy the bridge
sudo cp plejd-bridge/python/final_bridge.py /opt/etthus-hub/plejd-bridge/python/
sudo systemctl enable --now plejd-bridge
```

### Requirements
- Bluetooth adapter (built-in on Pi 3/4/5)
- Plejd mesh gateway within BLE range (~15m)
- Plejd account credentials configured in admin dashboard
- **Plejd app must be CLOSED on your phone** (BLE allows only one connection)
