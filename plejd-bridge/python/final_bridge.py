#!/usr/bin/env python3
"""
Plejd Bridge for etthusHUB v3.0
Uses pyplejd v0.1 (BLE direct with crypto key) + Firebase REST API.
Stays connected to Plejd mesh, syncs devices to Firestore, handles commands.
"""
import os, sys, json, time, logging, asyncio
from pathlib import Path
from threading import Event

import requests
from bleak import BleakScanner
from pyplejd import PlejdManager, get_site_data

logging.basicConfig(level=logging.INFO, format='%(asctime)s [Plejd] %(message)s')
log = logging.getLogger()

# ─── Config ──────────────────────────────────────────────────────────────────
POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL', '10'))
HOUSE_ID = os.environ.get('HUB_HOUSE_ID', '')
PLEJD_EMAIL = os.environ.get('PLEJD_EMAIL', '')
PLEJD_PASSWORD = os.environ.get('PLEJD_PASSWORD', '')
PLEJD_SITE_ID = os.environ.get('PLEJD_SITE_ID', '')
FIREBASE_API_KEY = os.environ.get('FIREBASE_API_KEY', 'AIzaSyBD46GyXwLJUHFr-q0GRFbUsWKJsw4omSY')
FIREBASE_PROJECT = os.environ.get('FIREBASE_PROJECT_ID', 'etthuscontrol-matter')
FIREBASE_DB = os.environ.get('FIREBASE_DB_NAME', 'etthuscontrolmatter')
FIRESTORE_URL = f'https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/{FIREBASE_DB}/documents'

if not HOUSE_ID:
    try:
        cfg = json.loads(Path('/opt/etthus-hub/.hub-config.json').read_text())
        HOUSE_ID = cfg.get('houseId', '')
    except: pass

# ─── Firebase REST Helpers ───────────────────────────────────────────────────
_fb_token = None
_fb_token_expiry = 0

def get_firebase_token():
    global _fb_token, _fb_token_expiry
    if _fb_token and time.time() < _fb_token_expiry - 120:
        return _fb_token
    url = f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={FIREBASE_API_KEY}'
    resp = requests.post(url, json={'returnSecureToken': True}).json()
    _fb_token = resp.get('idToken', '')
    _fb_token_expiry = time.time() + 3600
    return _fb_token

def firestore_get(path):
    try:
        token = get_firebase_token()
        resp = requests.get(f'{FIRESTORE_URL}/{path}', headers={'Authorization': f'Bearer {token}'}, timeout=10)
        return resp.json() if resp.status_code == 200 else None
    except Exception:
        return None

def firestore_patch(path, data):
    try:
        token = get_firebase_token()
        fields = {}
        for k, v in data.items():
            if v is None: fields[k] = {'nullValue': None}
            elif isinstance(v, bool): fields[k] = {'booleanValue': v}
            elif isinstance(v, int): fields[k] = {'integerValue': str(v)}
            elif isinstance(v, float): fields[k] = {'doubleValue': v}
            elif isinstance(v, str): fields[k] = {'stringValue': v}
            else: fields[k] = {'stringValue': str(v)}
        resp = requests.patch(
            f'{FIRESTORE_URL}/{path}',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json={'fields': fields},
            timeout=10
        )
        if resp.status_code not in (200, 201, 404):
            log.debug(f'Firestore error {resp.status_code}')
    except Exception as e:
        log.debug(f'Firestore patch failed: {e}')

def firestore_doc_fields(doc):
    fields = {}
    for k, v in (doc.get('fields', {}) or {}).items():
        for vtype, val in v.items():
            if vtype == 'stringValue': fields[k] = val
            elif vtype == 'integerValue': fields[k] = int(val)
            elif vtype == 'doubleValue': fields[k] = float(val)
            elif vtype == 'booleanValue': fields[k] = val
    return fields

# ─── Plejd Bridge ────────────────────────────────────────────────────────────
manager: PlejdManager = None
device_map = {}   # address -> {name, type, dimmable}
shutdown_flag = False

_last_states = {}

def sync_device_to_firestore(address, name, dev_type, dimmable, state, level):
    global _last_states
    last = _last_states.get(address, {})
    if last.get('state') == state and last.get('level') == level:
        return  # no change
    _last_states[address] = {'state': state, 'level': level}
    
    doc_id = f'plejd-{address}'
    data = {
        'name': name,
        'nodeId': 'plejd',
        'endpointId': address,
        'types': ('Dimmable Light, ' if dimmable else '') + dev_type,
        'state': 'On' if state else 'Off',
        'level': level,
        'hasLevelControl': dimmable,
        'houseId': HOUSE_ID,
        'source': 'plejd',
    }
    firestore_patch(f'devices/{doc_id}', data)
    log.info(f'Synced: {name} -> {"On" if state else "Off"} ({level}%)')

async def on_state_changed(device_state):
    address = device_state.get('address')
    if address is None: return
    info = device_map.get(address, {})
    if not info: return
    
    state = device_state.get('state', False)
    dim = device_state.get('dim', 254)
    if dim > 254:
        dim = 254  # max brightness when state is True
    level_pct = max(0, min(100, round((dim / 254) * 100)))
    sync_device_to_firestore(address, info['name'], info['type'], info['dimmable'], state, level_pct)

async def handle_commands():
    log.info(f'Command handler started. HOUSE_ID={HOUSE_ID}')
    processed_ids = set()
    while not shutdown_flag:
        await asyncio.sleep(1)
        if not manager or not HOUSE_ID:
            continue
        try:
            token = get_firebase_token()
            # Query RECENT commands of any status (hub processes them instantly)
            url = f'{FIRESTORE_URL}/commands?pageSize=10&orderBy=timestamp desc'
            resp = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=10)
            if resp.status_code != 200:
                continue
            
            docs = resp.json().get('documents', [])
            for doc_entry in docs:
                fields = firestore_doc_fields(doc_entry)
                if fields.get('houseId') != HOUSE_ID:
                    continue
                doc_name = doc_entry['name'].split('/')[-1]
                # Skip if already processed in this session or by hub (done/failed)
                if doc_name in processed_ids or fields.get('status') == 'done':
                    continue
                processed_ids.add(doc_name)
                
                target_name = (fields.get('deviceName') or '').lower()
                raw_text = (fields.get('text') or '').lower()
                
                if not target_name:
                    for prefix in ['turn on ', 'turn off ', 'set ', 'dim ']:
                        if prefix in raw_text:
                            target_name = raw_text.split(prefix, 1)[1].strip()
                            break
                
                if not target_name:
                    continue
                
                target_addr = None
                for addr, info in device_map.items():
                    if target_name in info['name'].lower() or info['name'].lower() in target_name:
                        target_addr = addr
                        break
                
                if not target_addr:
                    continue
                
                log.info(f'Cmd: {raw_text} -> device={target_name} addr={target_addr}')
                
                if not manager.connected:
                    log.warning(f'Not connected to mesh, cannot process command')
                    continue
                
                try:
                    dev = manager.devices.get(target_addr)
                    if not dev:
                        log.warning(f'Device {target_addr} not found')
                        continue
                    
                    cmd_type = fields.get('type')
                    if cmd_type == 'level' and fields.get('level') is not None:
                        lvl_pct = int(fields['level'])
                        lvl = max(0, min(254, round((lvl_pct / 100) * 254)))
                        state = lvl > 0
                        await manager.mesh.set_state(target_addr, state, lvl)
                        log.info(f'Set {target_addr} state={state} level={lvl}')
                    elif raw_text:
                        if 'on' in raw_text and 'off' not in raw_text:
                            await dev.turn_on(dim=254)
                            log.info(f'Turned ON {target_addr}')
                        elif 'off' in raw_text:
                            await dev.turn_off()
                            log.info(f'Turned OFF {target_addr}')
                    
                    firestore_patch(f'commands/{doc_name}', {'status': 'done'})
                    await asyncio.sleep(0.3)
                except Exception as e:
                    log.error(f'Cmd error: {e}')
        except Exception as e:
            log.debug(f'Cmd poll error: {e}')

async def maintain_connection():
    while not shutdown_flag:
        if manager and not manager.connected:
            log.warning('Connection lost. Reconnecting...')
            try:
                # Try direct connect
                from bleak.backends.device import BLEDevice
                mesh_device = BLEDevice('CD:DE:EB:A6:C0:A6', 'P mesh', [], 0)
                manager.add_mesh_device(mesh_device, -50)
                await manager.mesh.connect()
            except Exception as e:
                log.error(f'Reconnect failed: {e}')
        await asyncio.sleep(20)

async def main():
    global manager, device_map
    
    log.info('EtthusHUB Plejd Bridge v3.0 starting')
    
    if not HOUSE_ID:
        log.error('No house ID configured')
        return
    
    # Get credentials from env or Firestore
    if not PLEJD_EMAIL or not PLEJD_PASSWORD:
        house = firestore_get(f'houses/{HOUSE_ID}')
        hf = firestore_doc_fields(house) if house else {}
        email = hf.get('plejdEmail', '') or hf.get('plejdCryptoKey', '')
        password = hf.get('plejdPassword', '')
        site_id = hf.get('plejdSiteId', '')
        if not email:
            log.error('Plejd credentials not configured in admin dashboard')
            return
    else:
        email = PLEJD_EMAIL
        password = PLEJD_PASSWORD
        site_id = PLEJD_SITE_ID
    
    if not site_id or site_id == '1':
        # Auto-detect site ID using Plejd cloud API
        log.info('No site ID configured, auto-detecting...')
        try:
            # Login
            login_resp = requests.post(
                'https://cloud.plejd.com/parse/login',
                json={'username': email, 'password': password},
                headers={
                    'X-Parse-Application-Id': 'zHvvOHTxLkHZZRRVIftxqS0iHEITjPvNnBUlMPUb',
                    'X-Parse-Revocable-Session': '1',
                    'Content-Type': 'application/json',
                },
                timeout=15
            )
            if login_resp.status_code != 200:
                log.error(f'Plejd login failed ({login_resp.status_code})')
                return
            login_data = login_resp.json()
            token = login_data.get('sessionToken')
            if not token:
                log.error(f'Plejd login failed: {login_data.get("error", "unknown")}')
                return
            
            # Get sites
            sites_resp = requests.post(
                'https://cloud.plejd.com/parse/functions/getSites',
                headers={
                    'X-Parse-Application-Id': 'zHvvOHTxLkHZZRRVIftxqS0iHEITjPvNnBUlMPUb',
                    'X-Parse-Session-Token': token,
                },
                timeout=15
            )
            sites_data = sites_resp.json()
            sites = sites_data.get('result', [])
            if not sites:
                log.error('No Plejd sites found for this account')
                return
            
            site_id = sites[0]['siteId']
            name = sites[0].get('title', 'Unknown')
            log.info(f'Auto-detected site: {name} ({site_id})')
        except Exception as e:
            log.error(f'Site auto-detection failed: {e}')
            return
    
    creds = {'username': email, 'password': password, 'siteId': site_id}
    
    try:
        # Get site data (includes crypto key)
        sd = await get_site_data(**creds)
        pm = sd.get('plejdMesh', {})
        ck = pm.get('cryptoKey', '').replace('-', '').replace(' ', '').upper()
        log.info(f'Crypto key: {ck[:8]}...')
        
        # Create manager and get devices
        m = PlejdManager(creds)
        await m.get_devices()
        m.mesh.set_crypto_key(ck)
        m.mesh.statecallback = on_state_changed
        
        # Clean up any stale BLE connections
        try:
            import subprocess
            subprocess.run(['bluetoothctl', 'disconnect', 'CD:DE:EB:A6:C0:A6'], capture_output=True, timeout=5)
            log.info('Cleaned up stale BLE connections')
        except Exception:
            pass
        
        # Build device map
        device_map = {}
        for addr, dev in m.devices.items():
            dtype = getattr(dev, 'type', 'Plejd') or 'Plejd'
            dname = getattr(dev, 'name', f'Plejd {addr}') or f'Plejd {addr}'
            dimmable = any(x in dtype.lower() for x in ('dim', 'led', 'light'))
            device_map[addr] = {'name': dname, 'type': dtype, 'dimmable': dimmable}
            log.info(f'Device {addr}: {dname} ({dtype}){" dimmable" if dimmable else ""}')
        
        # Add mesh gateway directly by known BLE address
        log.info('Connecting to Plejd mesh gateway CD:DE:EB:A6:C0:A6...')
        try:
            from bleak.backends.device import BLEDevice
            mesh_device = BLEDevice('CD:DE:EB:A6:C0:A6', 'P mesh', [], 0)
            m.add_mesh_device(mesh_device, -50)
        except Exception:
            pass
        
        # Try direct connect first, then fall back to scanner
        await m.mesh.connect()
        
        if not m.connected:
            log.warning('Direct connect failed, scanning instead...')
            found_mesh = False
            while not shutdown_flag and not found_mesh:
                def on_ble_device(device, adv):
                    nonlocal found_mesh
                    addr = device.address.replace(':', '').replace('-', '').upper()
                    name = device.name or ''
                    if 'P mesh' in name or addr in ['CDDEEBA6C0A6', 'E425BBC73860']:
                        log.info(f'Found: {device.address} ({name})')
                        found_mesh = True
                        m.add_mesh_device(device, adv.rssi or 0)
                scanner = BleakScanner(on_ble_device)
                await scanner.start()
                await asyncio.sleep(8)
                await scanner.stop()
                if found_mesh:
                    await m.mesh.connect()
                else:
                    log.warning('Not found. Retrying in 10s...')
                    await asyncio.sleep(10)
        
        if not m.connected:
            log.error('Failed to connect to mesh')
            return
        
        log.info('Connected to Plejd mesh!')
        
        manager = m

        # Initial sync via poll triggers state callbacks
        await m.mesh.poll()
        
        # Start background tasks
        asyncio.create_task(handle_commands())
        asyncio.create_task(maintain_connection())
        
        log.info(f'Bridge running. {len(device_map)} device(s)')
        
        while not shutdown_flag:
            await asyncio.sleep(5)
            
    except Exception as e:
        log.error(f'Fatal: {e}')
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info('Shutting down')
    except Exception as e:
        log.error(f'Fatal: {e}')
