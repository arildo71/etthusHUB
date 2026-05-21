import "@project-chip/matter-node.js";
import { NodeJsEnvironment } from "@matter/nodejs";
import { Network } from "@matter/general";
import { Environment } from "@matter/general";

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

dotenv.config();

NodeJsEnvironment();
console.log('[Matter] Environment initialized. Default:', Environment.default.name);

try {
  console.log('[Matter] Checking Network provider:', Network.get() ? 'Available' : 'Missing');
} catch (e) {
  console.warn('[Matter] Network provider not yet initialized.');
}

import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, setDoc,
  doc, getDoc, serverTimestamp, query, where, getDocs, orderBy, limit as fsLimit
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBD46GyXwLJUHFr-q0GRFbUsWKJsw4omSY",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "etthuscontrol-matter.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "etthuscontrol-matter",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "etthuscontrol-matter.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "267601572566",
  appId: process.env.FIREBASE_APP_ID || "1:267601572566:web:fe2dd2cad25a00c9f78f77",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-M2MCJ3HBXY"
};

const FIREBASE_DB_NAME = process.env.FIREBASE_DB_NAME || "etthuscontrolmatter";

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp, FIREBASE_DB_NAME);
const auth = getAuth(fbApp);

const HUB_NAME = process.env.HUB_NAME || "EtthusHUB";
const HUB_VERSION = "1.1.0";
const PORT = parseInt(process.env.PORT || '3001', 10);
const SETUP_PORT = parseInt(process.env.SETUP_PORT || '3002', 10);

// ─── House Configuration ────────────────────────────────────────────────────
const CONFIG_PATH = path.resolve(__dirname, '..', '.hub-config.json');

function loadHouseConfig(): { houseId: string; houseName: string } | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[Hub] Failed to load hub config:', e);
  }
  return process.env.HUB_HOUSE_ID ? { houseId: process.env.HUB_HOUSE_ID, houseName: '' } : null;
}

function saveHouseConfig(houseId: string, houseName: string) {
  const config = { houseId, houseName, pairedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[Hub] House config saved: ${houseName} (${houseId})`);
}

const houseConfig = loadHouseConfig();
const HOUSE_ID = houseConfig?.houseId || null;

import { CommissioningController, MatterServer } from "@project-chip/matter.js";
import { ManualPairingCodeCodec } from "@project-chip/matter.js/schema";
import { NodeId } from "@project-chip/matter.js/datatype";
import { OnOff, BasicInformation, BridgedDeviceBasicInformation, LevelControl, ColorControl } from "@project-chip/matter.js/cluster";
import { StorageBackendDisk, StorageManager } from "@project-chip/matter-node.js/storage";
import { NodeStates, PairedNode } from "@project-chip/matter.js/device";

let isMatterReady = false;
let matterServer: MatterServer | undefined;
let controller: CommissioningController | undefined;

const STORAGE_PATH = process.env.MATTER_STORAGE_PATH || path.resolve(__dirname, '..', '.matter-storage');
const storage = new StorageBackendDisk(STORAGE_PATH);
const storageManager = new StorageManager(storage);

// ─── Setup Web Server (Auto-Registration) ─────────────────────────────────────
let hubDocId: string | null = null;

function generateHubId(): string {
  try {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (!net.internal && net.mac !== '00:00:00:00:00:00') {
          return net.mac.replace(/:/g, '').toUpperCase();
        }
      }
    }
  } catch (e) {}
  return require('crypto').randomBytes(8).toString('hex').toUpperCase();
}

function startSetupServer() {
  const setupApp = express();
  setupApp.use(express.json());
  setupApp.use(cors());

  const hubId = process.env.HUB_ID || generateHubId();
  let pairedHouse = '';
  let paired = false;

  // Auto-register this hub in Firestore as "pending"
  (async () => {
    try {
      await signInAnonymously(auth);
      hubDocId = hubId;
      const hubDoc = doc(db, 'hubs', hubId);
      const existing = await getDoc(hubDoc);
      
      if (existing.exists() && existing.data()?.status === 'paired') {
        // Already paired — complete setup
        const data = existing.data();
        pairedHouse = data?.houseName || '';
        paired = true;
        await applyPairing(data?.houseId || '', data?.houseName || 'My Home');
        return;
      }

      // Create or update pending hub entry
      const hubData: any = {
        name: HUB_NAME,
        status: 'pending',
        version: HUB_VERSION,
        platform: process.platform,
        arch: process.arch,
        createdAt: serverTimestamp(),
      };
      if (!existing.exists()) {
        await setDoc(hubDoc, hubData);
      } else {
        await updateDoc(hubDoc, { status: 'pending', lastSeen: serverTimestamp() });
      }
      console.log(`[Hub] Registered as pending hub: ${hubId}`);

      // Listen for admin to assign this hub to a house
      onSnapshot(hubDoc, (snap) => {
        const data = snap.data();
        if (data && data.status === 'paired' && data.houseId) {
          console.log(`[Hub] Received pairing from admin: ${data.houseName}`);
          pairedHouse = data.houseName || '';
          paired = true;
          applyPairing(data.houseId, data.houseName || 'My Home');
        }
      });
    } catch (e) {
      console.error('[Hub] Auto-registration failed:', e);
    }
  })();

  // Apply pairing: save config, create user, mark house, restart
  async function applyPairing(houseId: string, houseName: string) {
    try {
      await updateDoc(doc(db, 'houses', houseId), { hubPaired: true });
      
      const hubUid = auth.currentUser?.uid || ('hub-' + houseId);
      await setDoc(doc(db, 'users', hubUid), {
        email: 'hub@' + houseId,
        name: HUB_NAME + ' (' + (houseName || 'Hub') + ')',
        role: 'hub',
        houseId: houseId,
      });

      saveHouseConfig(houseId, houseName || 'My Home');
      console.log(`[Hub] Paired to "${houseName}". Restarting...`);
      setTimeout(() => process.exit(0), 2000);
    } catch (e) {
      console.error('[Hub] Pairing apply failed:', e);
    }
  }

  setupApp.get('/', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EtthusHUB Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #f4f5f7; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px 24px; max-width: 420px;
            width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; }
    h1 { font-size: 1.25rem; font-weight: 700; text-align: center; margin-bottom: 4px; }
    .sub { text-align: center; color: #6b7280; font-size: 0.875rem; margin-bottom: 24px; }
    .status-badge { display: flex; align-items: center; gap: 8px; padding: 12px; border-radius: 12px;
                    margin-bottom: 20px; font-weight: 600; font-size: 0.875rem; }
    .status-badge.pending { background: #fef3c7; color: #92400e; }
    .status-badge.paired { background: #d1fae5; color: #065f46; }
    .pulse { width: 10px; height: 10px; border-radius: 50%; animation: pulse 2s infinite; }
    .pending .pulse { background: #f59e0b; }
    .paired .pulse { background: #10b981; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .info { background: #f9fafb; border: 1px solid #f3f4f6; border-radius: 12px;
            padding: 16px; margin-bottom: 12px; }
    .info-row { display: flex; justify-content: space-between; padding: 4px 0;
                font-size: 0.8125rem; color: #6b7280; }
    .info-row span:first-child { font-weight: 500; }
    .code { font-family: monospace; font-size: 1.25rem; text-align: center; padding: 12px;
            background: #f3f4f6; border-radius: 8px; margin: 12px 0; letter-spacing: 0.1em; }
    .footer { font-size: 0.75rem; color: #9ca3af; text-align: center; margin-top: 20px;
              padding-top: 16px; border-top: 1px solid #f3f4f6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>EtthusHUB Setup</h1>
    <p class="sub">Auto-registration active</p>

    <div class="status-badge ${paired ? 'paired' : 'pending'}" id="statusBadge">
      <div class="pulse"></div>
      <span>${paired ? 'Paired to ' + pairedHouse : 'Waiting for admin approval...'}</span>
    </div>

    ${paired ? '' : `
    <div class="info">
      <div class="info-row"><span>Hub ID</span><span>${hubId}</span></div>
      <div class="info-row"><span>Name</span><span>${HUB_NAME}</span></div>
      <div class="info-row"><span>Version</span><span>v${HUB_VERSION}</span></div>
    </div>
    <p style="font-size:0.8125rem;color:#6b7280;text-align:center;margin-top:8px;">
      Open the EtthusControl admin page to assign this hub to a house.
    </p>`}

    <div class="info">
      <div class="info-row"><span>Platform</span><span>${process.platform} ${process.arch}</span></div>
      <div class="info-row"><span>Node.js</span><span>${process.version}</span></div>
    </div>

    <div class="footer">${HUB_NAME} v${HUB_VERSION}</div>
  </div>
</body>
</html>`);
  });

  // Legacy pairing endpoint (kept for backwards compat)
  setupApp.post('/setup/pair', async (req, res) => {
    const { pairingCode } = req.body;
    if (!pairingCode || !/^\d{6}$/.test(pairingCode)) {
      res.json({ success: false, message: 'Invalid pairing code format.' });
      return;
    }
    try {
      await signInAnonymously(auth);
      const housesSnap = await getDocs(
        query(collection(db, 'houses'), where('pairingCode', '==', pairingCode), fsLimit(1))
      );
      if (housesSnap.empty) {
        res.json({ success: false, message: 'Invalid pairing code.' });
        return;
      }
      const houseDoc = housesSnap.docs[0];
      const houseData = houseDoc.data();
      await applyPairing(houseDoc.id, houseData.name || 'My Home');
      res.json({ success: true, message: 'Hub paired! Restarting...' });
    } catch (err: any) {
      res.json({ success: false, message: 'Pairing failed: ' + (err.message || 'Unknown error') });
    }
  });

  setupApp.get('/api/status', (_req, res) => {
    res.json({
      status: paired ? 'paired' : 'setup',
      hubId,
      hubName: HUB_NAME,
      version: HUB_VERSION,
      paired,
      houseName: pairedHouse,
      platform: process.platform,
      arch: process.arch,
    });
  });

  setupApp.listen(SETUP_PORT, () => {
    console.log(`[Hub] Setup server on http://localhost:${SETUP_PORT}`);
    console.log(`[Hub] Waiting for admin to approve this hub (ID: ${hubId})`);
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[EtthusHUB] Received ${signal}. Shutting down gracefully...`);
  if (matterServer) {
    try { await matterServer.close(); console.log('[EtthusHUB] Matter server closed.'); } catch (e) {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGQUIT', () => shutdown('SIGQUIT'));
process.on('uncaughtException', (err) => { console.error('[Global] Uncaught Exception:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('[Global] Unhandled Rejection:', reason); });

// ─── Matter Controller Setup ────────────────────────────────────────────────
async function initMatterController() {
  console.log(`[Matter] Initializing storage at: ${STORAGE_PATH}`);
  await storageManager.initialize();

  matterServer = new MatterServer(storageManager);
  controller = new CommissioningController({
    autoConnect: true,
    adminFabricLabel: "EtthusControl",
  });

  await matterServer.addCommissioningController(controller);
  await matterServer.start();

  isMatterReady = true;
  console.log('[Matter] Controller started. Ready to commission devices.');
  await syncCommissionedDevicesToFirestore();
}

// ─── Sync Commissioned Devices ──────────────────────────────────────────────
async function syncCommissionedDevicesToFirestore() {
  if (!controller || !HOUSE_ID) return;

  const nodeIds = controller.getCommissionedNodes();
  console.log(`[Matter] Found ${nodeIds.length} previously commissioned node(s).`);

  for (const nodeId of nodeIds) {
    try {
      console.log(`[Matter] Connecting to node ${nodeId}...`);
      const node = await controller.connectNode(nodeId, { autoSubscribe: true });
      await Promise.race([node.events.initialized, new Promise(resolve => setTimeout(resolve, 5000))]);
      console.log(`[Matter] Connected to node ${nodeId}. Syncing sub-devices...`);
      await syncNodeToFirestore(nodeId, node);
      subscribeToNodeChanges(nodeId, node);
    } catch (err) {
      console.error(`[Matter] Failed to reconnect to node ${nodeId}:`, err);
    }
  }
}

async function syncNodeToFirestore(nodeId: NodeId, node: PairedNode) {
  const root = (node as any).getRootEndpoint();
  if (!root) { console.warn(`[Matter] Node ${nodeId} has no root endpoint.`); return; }

  const allEndpoints: any[] = [];
  function collect(endpoint: any) {
    allEndpoints.push(endpoint);
    const children = endpoint.getChildEndpoints ? endpoint.getChildEndpoints() : [];
    for (const child of children) collect(child);
  }
  collect(root);

  for (const device of allEndpoints) {
    const endpointId = (device as any).number ?? (device as any).id;
    if (endpointId === undefined || endpointId === 0) continue;

    const deviceTypesList = (device as any).getDeviceTypes ? (device as any).getDeviceTypes() : (device as any).deviceTypes;
    const deviceTypes = Array.isArray(deviceTypesList) ? deviceTypesList.map((dt: any) => dt.name).join(', ') : 'Unknown';

    let deviceName = `Device ${nodeId}-${endpointId}`;
    const bridgedInfo = (device as any).getClusterClient(BridgedDeviceBasicInformation.Cluster);
    if (bridgedInfo) {
      try {
        const nodeLabel = await bridgedInfo.getNodeLabelAttribute();
        const productName = await bridgedInfo.getProductNameAttribute();
        if (nodeLabel) deviceName = nodeLabel; else if (productName) deviceName = productName;
      } catch (e) {}
    }
    if (deviceName.startsWith('Device ')) {
      const basicInfo = (device as any).getClusterClient(BasicInformation.Cluster);
      if (basicInfo) {
        try {
          const nodeLabel = await basicInfo.getNodeLabelAttribute();
          const productName = await basicInfo.getProductNameAttribute();
          if (nodeLabel) deviceName = nodeLabel; else if (productName) deviceName = productName;
        } catch (e) {}
      }
    }

    let onOffState: any = undefined;
    const onOffCluster = (device as any).getClusterClient(OnOff.Cluster);
    if (onOffCluster) { try { onOffState = await onOffCluster.getOnOffAttribute(); } catch (e) {} }

    let currentLevel: number | undefined = undefined;
    const levelCluster = (device as any).getClusterClient(LevelControl.Cluster);
    if (levelCluster) { try { currentLevel = await levelCluster.getCurrentLevelAttribute(); } catch (e) {} }

    // Convert Matter level (0-254) to percentage (0-100)
    const levelPercent = currentLevel !== undefined ? Math.round((currentLevel / 254) * 100) : 100;
    const hasLevelControl = deviceTypes.toLowerCase().includes('dimmable') || currentLevel !== undefined;

    let colorTemp: number | undefined = undefined;
    let hasColorControl = false;
    const colorCluster = (device as any).getClusterClient(ColorControl.Cluster);
    if (colorCluster) {
      try {
        const caps = await colorCluster.getColorCapabilitiesAttribute();
        if (caps && (caps.colorTemperature || caps.hueSaturation || caps.xy)) {
          hasColorControl = true;
        }
      } catch (e) {}
      try { colorTemp = await colorCluster.getColorTemperatureMiredsAttribute(); } catch (e) {}
    }
    hasColorControl = hasColorControl || deviceTypes.toLowerCase().includes('color') || deviceTypes.toLowerCase().includes('extended color');

    const docId = `${nodeId}-${endpointId}`;
    const deviceDocRef = doc(db, 'devices', docId);
    const existingDoc = await getDoc(deviceDocRef);
    const baseData: any = {
      name: deviceName,
      nodeId: String(nodeId),
      endpointId: Number(endpointId),
      types: deviceTypes,
      state: onOffState === undefined ? 'Unknown' : (onOffState ? 'On' : 'Off'),
      level: levelPercent,
      hasLevelControl: hasLevelControl || (existingDoc.exists() && existingDoc.data().hasLevelControl === true),
      hasColorControl: hasColorControl || (existingDoc.exists() && existingDoc.data().hasColorControl === true),
      houseId: HOUSE_ID,
      lastSeen: serverTimestamp(),
    };
    if (!existingDoc.exists()) { baseData.showOnHome = true; }
    if (colorTemp !== undefined) { baseData.colorTemp = colorTemp; }
    await setDoc(deviceDocRef, baseData, { merge: true });
  }
}

function subscribeToNodeChanges(nodeId: NodeId, node: PairedNode) {
  node.events.attributeChanged.on((data) => {
    const { path: attrPath, value } = data;
    const endpointId = attrPath.endpointId;
    const docId = `${nodeId}-${endpointId}`;
    const docRef = doc(db, 'devices', docId);

    if (attrPath.clusterId === OnOff.Cluster.id && attrPath.attributeName === 'onOff') {
      const newState = value ? 'On' : 'Off';
      updateDoc(docRef, { state: newState, lastSeen: serverTimestamp() })
        .catch((e: any) => console.error('[Firestore] Failed to update device state:', e));
    }

    if (attrPath.clusterId === LevelControl.Cluster.id && attrPath.attributeName === 'currentLevel') {
      const levelPercent = Math.round((Number(value) / 254) * 100);
      updateDoc(docRef, { level: levelPercent, lastSeen: serverTimestamp() })
        .catch((e: any) => console.error('[Firestore] Failed to update device level:', e));
    }

    if (attrPath.clusterId === ColorControl.Cluster.id && attrPath.attributeName === 'colorTemperatureMireds') {
      updateDoc(docRef, { colorTemp: value, lastSeen: serverTimestamp() })
        .catch((e: any) => console.error('[Firestore] Failed to update color temp:', e));
    }
  });
  node.events.stateChanged.on((state) => {
    console.log(`[Matter] Node ${nodeId} connection state: ${NodeStates[state]}`);
  });
}

// ─── Firestore Listeners (House-Aware) ─────────────────────────────────────
function listenForPairingRequests() {
  if (!HOUSE_ID) return;
  const q = query(
    collection(db, 'pairing_requests'),
    where('houseId', '==', HOUSE_ID),
    where('status', '==', 'pending')
  );
  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const data = change.doc.data();
        const pairingCode = data.code as string;
        const docRef = change.doc.ref;
        await updateDoc(docRef, { status: 'processing', message: 'Starting pairing process...' });
        try {
          await commissionDevice(pairingCode, docRef);
          await updateDoc(docRef, { status: 'success', message: 'Device paired successfully!' });
        } catch (err: any) {
          console.error('[Matter] Commission failed:', err);
          await updateDoc(docRef, { status: 'failed', message: 'Pairing failed: ' + (err.message || String(err)), error: err.message || String(err) });
        }
      }
    }
  });
}

async function commissionDevice(pairingCode: string, pairingDocRef?: any) {
  if (!controller) throw new Error('Matter controller not initialized');
  const update = async (msg: string) => {
    console.log(`[Matter] ${msg}`);
    if (pairingDocRef) try { await updateDoc(pairingDocRef, { message: msg }); } catch (e) {}
  };
  await update('Decoding pairing code...');
  const pairingData = ManualPairingCodeCodec.decode(pairingCode);
  await update('Searching for device on network. Press the pairing button on your device now.');

  const nodeId = await controller.commissionNode({
    discovery: { identifierData: {}, discoveryCapabilities: { onIpNetwork: true } },
    passcode: pairingData.passcode,
    commissioning: {},
  });

  console.log(`[Matter] Successfully commissioned node ${nodeId}!`);
  await update('Device commissioned! Syncing device data...');
  const node = controller.getPairedNode(nodeId);
  if (node) {
    await syncNodeToFirestore(nodeId, node);
    subscribeToNodeChanges(nodeId, node);
  } else {
    await update('Connecting to device...');
    const reconnected = await controller.connectNode(nodeId, { autoSubscribe: true });
    await reconnected.events.initialized;
    await syncNodeToFirestore(nodeId, reconnected);
    subscribeToNodeChanges(nodeId, reconnected);
  }
}

function listenForCommands() {
  if (!HOUSE_ID) return;
  const q = query(
    collection(db, 'commands'),
    where('houseId', '==', HOUSE_ID),
    where('status', '==', 'pending')
  );
  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const data = change.doc.data();
        const docRef = change.doc.ref;
        await updateDoc(docRef, { status: 'processing' });
        try {
          if (data.type === 'level' && data.deviceName && typeof data.level === 'number') {
            await setDeviceLevel(data.deviceName, data.level);
          } else if (data.type === 'color_temp' && data.deviceName && typeof data.temp === 'number') {
            await setDeviceColorTemp(data.deviceName, data.temp);
          } else if (data.type === 'color_hs' && data.deviceName && typeof data.hue === 'number' && typeof data.saturation === 'number') {
            await setDeviceColor(data.deviceName, data.hue, data.saturation);
          } else if (data.type === 'sync_devices') {
            await syncCommissionedDevicesToFirestore();
          } else if (data.text) {
            await processVoiceCommand(data.text as string, data.lang || 'en');
          }
          await updateDoc(docRef, { status: 'done' });
        } catch (err: any) {
          await updateDoc(docRef, { status: 'failed', error: err.message || String(err) });
        }
      }
    }
  });
}

async function processVoiceCommand(command: string, lang: string = 'en') {
  if (!controller) throw new Error('Matter controller not initialized');
  const lowerCmd = command.toLowerCase();
  const isNo = lang === 'no';

  const automationsSnap = await getDocs(query(collection(db, 'automations'), where('houseId', '==', HOUSE_ID)));
  const automations = automationsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const targetAutomation = automations.find(a => (a as any).name && lowerCmd.includes((a as any).name.toLowerCase()));
  if (targetAutomation) {
    await addDoc(collection(db, 'automation_runs'), {
      automationId: targetAutomation.id,
      steps: (targetAutomation as any).steps,
      houseId: HOUSE_ID,
      status: 'pending',
      timestamp: serverTimestamp(),
    });
    console.log(`[Command] Triggered automation: ${(targetAutomation as any).name}`);
    return;
  }

  let targetAction: boolean | null = null;

  // Check for level command in both languages
  const levelMatch = lowerCmd.match(isNo
    ? /(?:sett|dim|lysstyrke)\s+(.+?)\s+(?:til|på|ved)\s+(\d+)\s*(?:%|prosent)?/
    : /(?:set|dim|brightness)\s+(.+?)\s+(?:to|at)\s+(\d+)\s*(?:%|percent)?/);
  if (levelMatch) {
    const deviceNamePart = levelMatch[1].trim();
    let level = parseInt(levelMatch[2]);
    level = Math.max(0, Math.min(100, level));
    console.log(`[Command] Level command detected: ${deviceNamePart} -> ${level}%`);
    
    const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
    const allDevices = devicesSnap.docs.map(d => d.data());
    const targetDevice = allDevices.find(d => d.name && deviceNamePart.toLowerCase().includes(d.name.toLowerCase()) || d.name && d.name.toLowerCase().includes(deviceNamePart));
    if (targetDevice) {
      await setDeviceLevel(targetDevice.name, level);
      return;
    }
  }

  // Determine on/off intent based on language
  if (isNo) {
    if (lowerCmd.includes('på') && !lowerCmd.includes('av')) targetAction = true;
    else if (lowerCmd.includes('av')) targetAction = false;
  } else {
    if (lowerCmd.includes('on') && !lowerCmd.includes('off')) targetAction = true;
    else if (lowerCmd.includes('off')) targetAction = false;
  }
  if (targetAction === null) { console.log(`[Command] Could not determine intent`); return; }

  const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
  const allDevices = devicesSnap.docs.map(d => d.data());
  const targetDevice = allDevices.find(d => d.name && lowerCmd.includes(d.name.toLowerCase()));

  if (targetDevice) {
    const nodeId = BigInt(targetDevice.nodeId);
    const node = await Promise.race([
      controller.connectNode(nodeId as any, { autoSubscribe: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    const findEp = (cur: any, id: number): any => {
      if (Number(cur.number) === id) return cur;
      for (const c of cur.getChildEndpoints()) { const f = findEp(c, id); if (f) return f; }
      return null;
    };
    const ep = findEp(node.getRootEndpoint(), targetDevice.endpointId);
    if (ep) {
      const cluster = ep.getClusterClient(OnOff.Cluster);
      if (cluster) {
        if (targetAction) await cluster.commands.on(); else await cluster.commands.off();
      }
    }
  } else {
    for (const nid of controller.getCommissionedNodes()) {
      try {
        const node = await controller.connectNode(nid, { autoSubscribe: true });
        for (const device of node.getDevices()) {
          const c = device.getClusterClient(OnOff.Cluster);
          if (c) { if (targetAction) await c.commands.on(); else await c.commands.off(); }
        }
      } catch (e) {}
    }
  }
}

async function controlDevice(deviceName: string, turnOn: boolean) {
  if (!controller) return;
  const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
  const target = devicesSnap.docs.find(d => d.data().name === deviceName);
  if (!target) return;
  const data = target.data();
  const node = await Promise.race([
    controller.connectNode(BigInt(data.nodeId) as any, { autoSubscribe: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
  ]);
  const findEp = (cur: any, id: number): any => {
    if (Number(cur.number) === id) return cur;
    for (const c of cur.getChildEndpoints()) { const f = findEp(c, id); if (f) return f; }
    return null;
  };
  const ep = findEp(node.getRootEndpoint(), data.endpointId);
  if (ep) {
    const cluster = ep.getClusterClient(OnOff.Cluster);
    if (cluster) { if (turnOn) await cluster.commands.on(); else await cluster.commands.off(); }
  }
}

async function setDeviceLevel(deviceName: string, level: number) {
  if (!controller) throw new Error('Matter controller not initialized');
  const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
  const target = devicesSnap.docs.find(d => d.data().name === deviceName);
  if (!target) { console.error(`[Level] Device not found: ${deviceName}`); return; }
  const data = target.data();
  console.log(`[Level] Setting ${deviceName} to ${level}%`);

  const node = await Promise.race([
    controller.connectNode(BigInt(data.nodeId) as any, { autoSubscribe: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
  ]);
  const findEp = (cur: any, id: number): any => {
    if (Number(cur.number) === id) return cur;
    for (const c of cur.getChildEndpoints()) { const f = findEp(c, id); if (f) return f; }
    return null;
  };
  const ep = findEp(node.getRootEndpoint(), data.endpointId);
  if (!ep) { console.error(`[Level] Endpoint not found for ${deviceName}`); return; }

  const levelCluster = ep.getClusterClient(LevelControl.Cluster);
  if (!levelCluster) { console.error(`[Level] No LevelControl cluster for ${deviceName}`); return; }

  // Matter uses 1-254 for brightness (1 is min, 254 is max). 0 = off.
  const matterLevel = level === 0 ? 0 : Math.max(1, Math.min(254, Math.round((level / 100) * 254)));
  // moveToLevelWithOnOff handles both setting level and turning on/off
  await levelCluster.commands.moveToLevelWithOnOff({
    level: matterLevel,
    transitionTime: 0,
    optionsMask: 0,
    optionsOverride: 0
  });
  console.log(`[Level] ${deviceName} set to ${level}% (matter: ${matterLevel})`);
}

async function setDeviceColorTemp(deviceName: string, tempMireds: number) {
  if (!controller) throw new Error('Matter controller not initialized');
  const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
  const target = devicesSnap.docs.find(d => d.data().name === deviceName);
  if (!target) { console.error(`[Color] Device not found: ${deviceName}`); return; }
  const data = target.data();
  console.log(`[Color] Setting ${deviceName} to ${tempMireds} mireds`);

  const node = await Promise.race([
    controller.connectNode(BigInt(data.nodeId) as any, { autoSubscribe: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
  ]);
  const findEp = (cur: any, id: number): any => {
    if (Number(cur.number) === id) return cur;
    for (const c of cur.getChildEndpoints()) { const f = findEp(c, id); if (f) return f; }
    return null;
  };
  const ep = findEp(node.getRootEndpoint(), data.endpointId);
  if (!ep) { console.error(`[Color] Endpoint not found`); return; }

  const cc = ep.getClusterClient(ColorControl.Cluster);
  if (!cc) { console.error(`[Color] No ColorControl cluster`); return; }

  await cc.commands.moveToColorTemperature({
    colorTemperatureMireds: tempMireds,
    transitionTime: 0,
    optionsMask: 0,
    optionsOverride: 0,
  });
  console.log(`[Color] ${deviceName} color temp set to ${tempMireds} mireds`);
}

async function setDeviceColor(deviceName: string, hue: number, saturation: number) {
  if (!controller) throw new Error('Matter controller not initialized');
  const devicesSnap = await getDocs(query(collection(db, 'devices'), where('houseId', '==', HOUSE_ID)));
  const target = devicesSnap.docs.find(d => d.data().name === deviceName);
  if (!target) { console.error(`[Color] Device not found: ${deviceName}`); return; }
  const data = target.data();
  console.log(`[Color] Setting ${deviceName} to hue=${hue} sat=${saturation}`);

  const node = await Promise.race([
    controller.connectNode(BigInt(data.nodeId) as any, { autoSubscribe: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
  ]);
  const findEp = (cur: any, id: number): any => {
    if (Number(cur.number) === id) return cur;
    for (const c of cur.getChildEndpoints()) { const f = findEp(c, id); if (f) return f; }
    return null;
  };
  const ep = findEp(node.getRootEndpoint(), data.endpointId);
  if (!ep) { console.error(`[Color] Endpoint not found`); return; }

  const cc = ep.getClusterClient(ColorControl.Cluster);
  if (!cc) { console.error(`[Color] No ColorControl cluster`); return; }

  await cc.commands.moveToHueAndSaturation({
    hue,
    saturation,
    transitionTime: 0,
    optionsMask: 0,
    optionsOverride: 0,
  });
  console.log(`[Color] ${deviceName} set to hue=${hue} sat=${saturation}`);
}

function listenForAutomationRuns() {
  if (!HOUSE_ID) return;
  const q = query(
    collection(db, 'automation_runs'),
    where('houseId', '==', HOUSE_ID),
    where('status', '==', 'pending')
  );
  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const docRef = change.doc.ref;
        const data = change.doc.data();
        const steps = data.steps as any[];
        await updateDoc(docRef, { status: 'running' });
        try {
          for (const step of steps) {
            if (step.type === 'wait') await new Promise(r => setTimeout(r, step.duration));
            else if (step.type === 'device_on' || step.type === 'device_off') {
              await controlDevice(step.deviceName, step.type === 'device_on');
            }
          }
          await updateDoc(docRef, { status: 'done' });
        } catch (err: any) {
          await updateDoc(docRef, { status: 'failed', error: err.message || String(err) });
        }
      }
    }
  });
}

// ─── Remote Hub Commands (Admin Terminal) ────────────────────────────────────
function listenForHubCommands() {
  if (!HOUSE_ID) return;
  const q = query(
    collection(db, 'hub_commands'),
    where('houseId', '==', HOUSE_ID),
    where('status', '==', 'pending')
  );
  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const data = change.doc.data();
        const docRef = change.doc.ref;
        const command = (data.command as string || '').trim();

        if (!command) {
          await updateDoc(docRef, { status: 'done', output: '(empty command)', exitCode: 0, completedAt: serverTimestamp() });
          continue;
        }

        console.log(`[HubCMD] Executing: ${command}`);
        await updateDoc(docRef, { status: 'running', output: 'Running...', startedAt: serverTimestamp() });

        let finalCommand = command;
        if (process.getuid && process.getuid() === 0) {
          if (finalCommand.startsWith('sudo ')) {
            console.log('[HubCMD] Running as root, stripping "sudo " prefix');
            finalCommand = finalCommand.substring(5);
          }
        }

        exec(finalCommand, { timeout: 30000, maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
          const output = (stdout || '') + (stderr ? '\n' + stderr : '') + (error ? '\nError: ' + error.message : '');
          console.log(`[HubCMD] Done (exit: ${error?.code || 0}): ${output.slice(0, 100)}`);

          try {
            await updateDoc(docRef, {
              status: 'done',
              output: output.slice(0, 50000),
              exitCode: error?.code || 0,
              completedAt: serverTimestamp(),
            });
          } catch (e) {
            console.error('[HubCMD] Failed to update:', e);
          }
        });
      }
    }
  });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
const mainApp = express();
mainApp.use(cors());
mainApp.use(express.json());

mainApp.get('/api/status', (_req, res) => {
  res.json({
    status: 'Online',
    matters: isMatterReady,
    hubName: HUB_NAME,
    version: HUB_VERSION,
    houseId: HOUSE_ID,
    houseName: houseConfig?.houseName || null,
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
});

async function bootstrapMain() {
  console.log(`[EtthusHUB] Starting ${HUB_NAME} v${HUB_VERSION}`);
  console.log(`[EtthusHUB] Platform: ${process.platform} ${process.arch}, Node.js ${process.version}`);
  console.log(`[EtthusHUB] House ID: ${HOUSE_ID || 'NOT CONFIGURED'}`);

  if (!HOUSE_ID) {
    console.log('[EtthusHUB] No house configured. Starting setup server...');
    startSetupServer();
    return;
  }

  try {
    const cred = await signInAnonymously(auth);
    console.log(`[Firebase] Signed in anonymously as ${cred.user.uid}`);
  } catch (e) {
    console.error('[Firebase] Anonymous sign-in failed:', e);
  }

  try {
    await initMatterController();
  } catch (e) {
    console.error('[Matter] Controller init failed:', e);
  }

  listenForPairingRequests();
  listenForCommands();
  listenForAutomationRuns();
  listenForHubCommands();
  
  // Heartbeat: update hub doc every 30s so admin knows hub is online
  const hubId = process.env.HUB_ID || hubDocId || HOUSE_ID;
  if (hubId) {
    setInterval(async () => {
      try {
        await updateDoc(doc(db, 'hubs', hubId), {
          lastSeen: serverTimestamp(),
          status: 'paired',
          houseId: HOUSE_ID,
          houseName: houseConfig?.houseName || '',
        });
      } catch (e) {}
    }, 30000);
    console.log(`[Hub] Heartbeat started for hub: ${hubId}`);
  }
  
  console.log('[EtthusHUB] Backend fully initialized. Listening for Firebase events.');
}

mainApp.listen(PORT, async () => {
  console.log(`Backend API listening on port ${PORT}`);
  await bootstrapMain();
});
