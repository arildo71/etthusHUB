#!/bin/bash
# EtthusHUB Bootstrap - runs on first boot
# Save this file to the SD card's boot partition (shows as a drive in Windows)

echo "[EtthusHUB] Bootstrap starting..." > /boot/bootstrap.log

# Update and install git
apt-get update -y
apt-get install -y git curl

# Clone and install
git clone https://github.com/arildo71/etthusHUB.git /opt/etthus-hub
cd /opt/etthus-hub
bash install.sh --git

# Install pyplejd for Plejd bridge
pip3 install --break-system-packages pyplejd==0.1

# Enable services
systemctl enable plejd-bridge

echo "[EtthusHUB] Bootstrap complete" >> /boot/bootstrap.log
