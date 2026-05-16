import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, onSnapshot, setDoc, doc, getDoc, serverTimestamp, query, where, updateDoc } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

const BRIDGE_VERSION = '2.0.0';

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
let HOUSE_ID = process.env.HUB_HOUSE_ID || '';
let PLEJD_EMAIL = process.env.PLEJD_EMAIL || '';
let PLEJD_PASSWORD = process.env.PLEJD_PASSWORD || '';
let PLEJD_SITE_ID = process.env.PLEJD_SITE_ID || '1';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10);

function loadHouseIdFromHubConfig(): string {
  try {
    const configPath = path.resolve(__dirname, '..', '..', '.hub-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')).houseId || '';
    }
  } catch (e) {}
  return '';
}
if (!HOUSE_ID) HOUSE_ID = loadHouseIdFromHubConfig();

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp, FIREBASE_DB_NAME);
const auth = getAuth(fbApp);

interface PlejdDevice {
  id: number;
  name: string;
  type: string;
  dimmable: boolean;
}

let plejdDevices: PlejdDevice[] = [];
let bleProcess: ChildProcess | null = null;
let bleBuffer = '';
let blePendingResolve: ((data: any) => void) | null = null;
let bleConnected = false;
let bleEventCallback: ((event: any) => void) | null = null;

function bleSend(cmd: any, timeoutMs: number = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!bleProcess || !bleProcess.stdin) {
      reject(new Error('BLE process not running'));
      return;
    }
    const timer = setTimeout(() => {
      if (blePendingResolve === resolve) blePendingResolve = null;
      reject(new Error('BLE command timed out'));
    }, timeoutMs);

    blePendingResolve = (data: any) => {
      clearTimeout(timer);
      blePendingResolve = null;
      resolve(data);
    };

    bleProcess.stdin.write(JSON.stringify(cmd) + '\n');
  });
}

function bleProcessLine(line: string) {
  try {
    const data = JSON.parse(line);
    if (data.event && bleEventCallback) {
      bleEventCallback(data);
      return;
    }
    if (blePendingResolve) {
      const resolve = blePendingResolve;
      blePendingResolve = null;
      resolve(data);
    }
  } catch {}
}

function startBleProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, '..', 'python', 'plejd_ble_helper.py');
    console.log('[Plejd] Starting BLE helper:', scriptPath);

    bleProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    bleProcess.stdout?.on('data', (chunk: Buffer) => {
      bleBuffer += chunk.toString();
      const lines = bleBuffer.split('\n');
      bleBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) bleProcessLine(trimmed);
      }
    });

    bleProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log('[Plejd BLE]', text);
    });

    bleProcess.on('error', (err) => {
      console.error('[Plejd] BLE process error:', err.message);
      reject(err);
    });

    bleProcess.on('exit', (code) => {
      console.error(`[Plejd] BLE process exited with code ${code}`);
      bleConnected = false;
      bleProcess = null;
    });

    setTimeout(() => resolve(), 500);
  });
}

async function plejdConnect(email: string, password: string, siteId: number): Promise<void> {
  console.log('[Plejd] Authenticating with Plejd cloud...');
  const result = await bleSend({ cmd: 'connect', username: email, password, site_id: String(siteId) }, 30000);
  if (result.error) throw new Error(result.error);
  bleConnected = true;
  console.log('[Plejd] Connected to Plejd mesh');
}

async function discoverDevices(): Promise<PlejdDevice[]> {
  const result = await bleSend({ cmd: 'list' }, 30000);
  if (result.error) throw new Error(result.error);
  if (!result.devices) return [];

  const devices: PlejdDevice[] = result.devices.map((d: any) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    dimmable: d.dimmable,
  }));

  plejdDevices = devices;
  console.log(`[Plejd] Found ${devices.length} device(s)`);
  return devices;
}

async function getDeviceState(deviceId: number): Promise<{ on: boolean; level: number }> {
  try {
    const result = await bleSend({ cmd: 'status', device_id: deviceId });
    if (result.error) return { on: false, level: 100 };
    const on = result.state === 1;
    const level = Math.round((result.level / 254) * 100);
    return { on, level };
  } catch {
    return { on: false, level: 100 };
  }
}

async function turnOnPlejd(deviceId: number) {
  const result = await bleSend({ cmd: 'on', device_id: deviceId });
  if (result.error) throw new Error(result.error);
}

async function turnOffPlejd(deviceId: number) {
  const result = await bleSend({ cmd: 'off', device_id: deviceId });
  if (result.error) throw new Error(result.error);
}

async function dimPlejd(deviceId: number, levelPercent: number) {
  const level = Math.max(0, Math.min(254, Math.round((levelPercent / 100) * 254)));
  const result = await bleSend({ cmd: 'dim', device_id: deviceId, level });
  if (result.error) throw new Error(result.error);
}

// ─── BLE Event Handler ───────────────────────────────────────────────────────
function onBleEvent(event: any) {
  if (event.event !== 'state_change') return;
  const dev = plejdDevices.find(d => d.id === event.device_id);
  if (!dev) return;

  const state = event.state === 1 ? 'On' : 'Off';
  const level = Math.round((event.level / 254) * 100);
  console.log(`[Plejd] State change: ${dev.name} -> ${state} (${level}%)`);

  const docId = `plejd-${event.device_id}`;
  setDoc(doc(db, 'devices', docId), {
    name: dev.name,
    nodeId: 'plejd',
    endpointId: event.device_id,
    types: (dev.dimmable ? 'Dimmable Light, ' : '') + (dev.type || 'Plejd'),
    state,
    level,
    hasLevelControl: dev.dimmable,
    houseId: HOUSE_ID,
    source: 'plejd',
    lastSeen: serverTimestamp(),
  }, { merge: true }).catch((e: any) => console.error('[Plejd] Firestore update error:', e.message));
}

// ─── Sync to Firestore ──────────────────────────────────────────────────────
async function syncDevices() {
  for (const dev of plejdDevices) {
    try {
      const state = await getDeviceState(dev.id);
      const docId = `plejd-${dev.id}`;
      const docRef = doc(db, 'devices', docId);
      const existing = await getDoc(docRef);

      const data: any = {
        name: dev.name,
        nodeId: 'plejd',
        endpointId: dev.id,
        types: (dev.dimmable ? 'Dimmable Light, ' : '') + (dev.type || 'Plejd'),
        state: state.on ? 'On' : 'Off',
        level: state.level,
        hasLevelControl: dev.dimmable,
        houseId: HOUSE_ID,
        source: 'plejd',
        lastSeen: serverTimestamp(),
      };
      if (!existing.exists()) data.showOnHome = true;

      await setDoc(docRef, data, { merge: true });
    } catch (e: any) {
      if (!e.message?.includes('timed out')) console.error(`[Plejd] Sync error for device:`, e.message);
    }
  }
}

// ─── Command Handler ────────────────────────────────────────────────────────
function listenForCommands() {
  if (!HOUSE_ID) return;
  const q = query(collection(db, 'commands'), where('houseId', '==', HOUSE_ID), where('status', '==', 'pending'));
  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const data = change.doc.data();
      const docRef = change.doc.ref;

      const deviceName = (data.deviceName as string) || '';
      if (!deviceName) continue;

      const dev = plejdDevices.find(d => deviceName.toLowerCase().includes(d.name.toLowerCase()));
      if (!dev) continue;

      try {
        if (data.type === 'level' && typeof data.level === 'number') {
          await dimPlejd(dev.id, data.level);
          await updateDoc(docRef, { status: 'done' });
        } else if (data.text) {
          const lower = (data.text as string).toLowerCase();
          if (lower.includes('on') && !lower.includes('off')) {
            await turnOnPlejd(dev.id);
          } else if (lower.includes('off')) {
            await turnOffPlejd(dev.id);
          }
          await updateDoc(docRef, { status: 'done' });
        }
        setTimeout(() => syncDevices(), 1500);
      } catch (e: any) {
        console.error(`[Plejd] Command error:`, e.message);
      }
    }
  });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`[Plejd Bridge] Starting v${BRIDGE_VERSION}`);

  if (!HOUSE_ID) { console.error('[Plejd Bridge] No house ID configured'); process.exit(1); }

  try {
    await signInAnonymously(auth);
    console.log('[Plejd Bridge] Firebase signed in');
  } catch (e) { console.error('[Plejd Bridge] Firebase auth failed:', e); process.exit(1); }

  const houseDoc = await getDoc(doc(db, 'houses', HOUSE_ID));
  const houseData = houseDoc.data();

  const email = PLEJD_EMAIL || houseData?.plejdEmail || '';
  const password = PLEJD_PASSWORD || houseData?.plejdPassword || '';
  const siteId = parseInt(PLEJD_SITE_ID || houseData?.plejdSiteId || '1', 10);

  if (!email || !password) {
    console.error('[Plejd Bridge] Plejd email/password not configured in admin dashboard');
    process.exit(1);
  }

  PLEJD_EMAIL = email;
  PLEJD_PASSWORD = password;
  PLEJD_SITE_ID = String(siteId);

  try {
    await startBleProcess();
    bleEventCallback = onBleEvent;
    await plejdConnect(email, password, siteId);
    await discoverDevices();
  } catch (e: any) {
    console.error('[Plejd Bridge] BLE setup failed:', e.message);
    process.exit(1);
  }

  // Subscribe to real-time state changes
  bleSend({ cmd: 'subscribe' }).catch(() => {});

  await syncDevices();
  listenForCommands();
  setInterval(() => syncDevices().catch(e => console.error('[Plejd Bridge] Poll error:', e)), POLL_INTERVAL * 1000);

  console.log(`[Plejd Bridge] Running. ${plejdDevices.length} device(s), polling every ${POLL_INTERVAL}s`);
}

process.on('SIGTERM', () => {
  if (bleProcess) { bleProcess.kill(); }
  process.exit(0);
});
process.on('SIGINT', () => {
  if (bleProcess) { bleProcess.kill(); }
  process.exit(0);
});

main().catch(err => { console.error('[Plejd Bridge] Fatal:', err); process.exit(1); });
