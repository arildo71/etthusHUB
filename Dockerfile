# ──────────────────────────────────────────────────────────────────────────────
# EtthusHUB Dockerfile
# ──────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t etthus-hub .
# Run:    docker run -d --network host --privileged \
#           -v etthus-storage:/opt/etthus-hub/.matter-storage \
#           --name etthus-hub etthus-hub
#
# Note: --network host and --privileged are needed for Matter mDNS and BLE.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libbluetooth-dev \
    libavahi-compat-libdnssd-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/etthus-hub

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ src/

# ─── Runtime Stage ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    avahi-daemon \
    avahi-utils \
    libavahi-compat-libdnssd0 \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libbluetooth3 \
    bluez \
    usbutils \
    udev \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages pyplejd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/etthus-hub

COPY --from=builder /opt/etthus-hub/node_modules node_modules
COPY --from=builder /opt/etthus-hub/src src
COPY package.json tsconfig.json ./

# Start avahi-daemon then the hub
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001 5540
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/status || exit 1

ENV NODE_ENV=production
ENV PORT=3001
ENV MATTER_STORAGE_PATH=/opt/etthus-hub/.matter-storage

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npx", "ts-node", "src/server.ts"]
