#!/usr/bin/env python3
"""
Standalone Plejd bridge for etthusHUB.
Uses pyplejd v0.20.6 with cloud auth + BLE.
Reads credentials from Firestore house doc, syncs devices to Firestore,
listens for commands.
"""
import os, sys, json, time, logging, asyncio
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s [Plejd] %(message)s')
log = logging.getLogger()

# ─── Firebase REST client (no SDK needed) ────────────────────────────────────
import requests

POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL', '5'))
HOUSE_ID = os.environ.get('HUB_HOUSE_ID', '')
FIREBASE_API_KEY = os.environ.get('FIREBASE_API_KEY', 'AIzaSyBD46GyXwLJUHFr-q0GRFbUsWKJsw4omSY')
FIREBASE_PROJECT = os.environ.get('FIREBASE_PROJECT_ID', 'etthuscontrol-matter')
FIREBASE_DB = os.environ.get('FIREBASE_DB_NAME', 'etthuscontrolmatter')
FIRESTORE_URL = f'https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/{FIREBASE_DB}/documents'

if not HOUSE_ID:
    try:
        cfg = json.loads(Path('/opt/etthus-hub/.hub-config.json').read_text())
        HOUSE_ID = cfg.get('houseId', '')
    except:
        pass

_fb_token = None
_fb_token_expiry = 0

def get_firebase_token():
    global _fb_token, _fb_token_expiry
    if _fb_token and time.time() < _fb_token_expiry - 60:
        return _fb_token
    url = f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={FIREBASE_API_KEY}'
    resp = requests.post(url, json={'returnSecureToken': True}).json()
    _fb_token = resp.get('idToken', '')
    _fb_token_expiry = time.time() + 3600
    return _fb_token

def firestore_get(path):
    token = get_firebase_token()
    resp = requests.get(f'{FIRESTORE_URL}/{path}', headers={'Authorization': f'Bearer {token}'})
    return resp.json() if resp.status_code == 200 else None

def firestore_patch(path, data):
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
        json={'fields': fields}
    )
    if resp.status_code not in (200, 201, 404):
        log.error(f'Firestore error {resp.status_code}')

def firestore_doc_fields(doc):
    fields = {}
    for k, v in (doc.get('fields', {}) or {}).items():
        for vtype, val in v.items():
            if vtype == 'stringValue': fields[k] = val
            elif vtype == 'integerValue': fields[k] = int(val)
            elif vtype == 'doubleValue': fields[k] = float(val)
            elif vtype == 'booleanValue': fields[k] = val
    return fields

# ─── Plejd Manager ───────────────────────────────────────────────────────────
from pyplejd import PlejdManager

manager: PlejdManager = None
device_cache = {}
shutdown = False
loop = None

def sync_device(device):
    """Sync a single device to Firestore."""
    pid = getattr(device, 'plejd_id', None)
    if pid is None:
        return
    info = device_cache.get(pid, {})
    name = info.get('name', getattr(device, 'name', f'Plejd {pid}'))
    dev_type = info.get('type', getattr(device, 'type', 'Plejd') or 'Plejd')
    dimmable = info.get('dimmable', any(x in dev_type.lower() for x in ('dim', 'led', 'light')))
    state = 'On' if getattr(device, 'state', 0) == 1 else 'Off'
    level = max(0, min(100, round((getattr(device, 'level', 254) / 254) * 100)))
    
    data = {
        'name': str(name),
        'nodeId': 'plejd',
        'endpointId': pid,
        'types': ('Dimmable Light, ' if dimmable else '') + str(dev_type),
        'state': state,
        'level': level,
        'hasLevelControl': dimmable,
        'houseId': HOUSE_ID,
        'source': 'plejd',
    }
    firestore_patch(f'devices/plejd-{pid}', data)

async def poll_devices():
    """Periodically sync all devices."""
    global manager, device_cache
    while not shutdown:
        await asyncio.sleep(POLL_INTERVAL)
        if not manager:
            continue
        try:
            for d in manager.devices:
                sync_device(d)
            log.debug(f'Synced {len(manager.devices)} device(s)')
        except Exception as e:
            log.error(f'Poll error: {e}')

async def poll_commands():
    """Poll Firestore commands collection for pending commands."""
    global manager, device_cache
    last_cmd_id = ''
    while not shutdown:
        await asyncio.sleep(POLL_INTERVAL)
        if not manager or not HOUSE_ID:
            continue
        try:
            token = get_firebase_token()
            url = f'{FIRESTORE_URL}/commands?pageSize=10&orderBy=status'
            resp = requests.get(url, headers={'Authorization': f'Bearer {token}'})
            if resp.status_code != 200:
                continue
            docs = resp.json().get('documents', [])
            for doc_entry in docs:
                fields = firestore_doc_fields(doc_entry)
                if fields.get('status') != 'pending':
                    continue
                if fields.get('houseId') != HOUSE_ID:
                    continue
                doc_name = doc_entry['name'].split('/')[-1]
                if doc_name == last_cmd_id:
                    continue
                last_cmd_id = doc_name

                name = fields.get('deviceName', '') or ''
                target_id = None
                for pid, info in device_cache.items():
                    if name.lower() in info.get('name', '').lower():
                        target_id = pid
                        break
                if not target_id:
                    continue

                try:
                    ct = fields.get('type')
                    text = fields.get('text', '')
                    if ct == 'level' and fields.get('level'):
                        lvl = max(1, min(254, round((int(fields['level']) / 100) * 254)))
                        manager.set_level(target_id, lvl)
                        log.info(f'Set level {target_id} -> {lvl}')
                    elif text:
                        t = text.lower()
                        if 'on' in t and 'off' not in t:
                            manager.turn_on(target_id)
                            log.info(f'Turn ON {target_id}')
                        elif 'off' in t:
                            manager.turn_off(target_id)
                            log.info(f'Turn OFF {target_id}')
                    firestore_patch(f'commands/{doc_name}', {'status': 'done'})
                    await asyncio.sleep(0.5)
                    for d in manager.devices:
                        sync_device(d)
                except Exception as e:
                    log.error(f'Command error: {e}')
        except Exception as e:
            log.error(f'Command poll error: {e}')

def build_device_cache():
    """Build device cache from manager.devices list."""
    global device_cache
    new_cache = {}
    for device in manager.devices:
        pid = getattr(device, 'plejd_id', None)
        if pid is None:
            continue
        dev_type = getattr(device, 'type', '') or 'Plejd'
        name = getattr(device, 'name', '') or f'Plejd {pid}'
        new_cache[pid] = {
            'name': str(name),
            'type': str(dev_type),
            'dimmable': any(x in dev_type.lower() for x in ('dim', 'led', 'light')),
        }
    device_cache = new_cache

async def main_async():
    global manager, loop
    loop = asyncio.get_running_loop()

    log.info('EtthusHUB Plejd Bridge starting (pyplejd v0.20.6)')

    if not HOUSE_ID:
        log.error('No house ID configured')
        return

    # Read Plejd config from Firestore house doc
    house = firestore_get(f'houses/{HOUSE_ID}')
    house_fields = firestore_doc_fields(house) if house else {}
    
    email = os.environ.get('PLEJD_EMAIL') or house_fields.get('plejdEmail', '')
    password = os.environ.get('PLEJD_PASSWORD') or house_fields.get('plejdPassword', '')
    site_id = os.environ.get('PLEJD_SITE_ID') or house_fields.get('plejdSiteId', '')
    
    if not email or not password:
        log.error('Plejd credentials not configured. Set plejdEmail/plejdPassword in admin dashboard.')
        return

    # First, find the correct site ID if it's a UUID
    if not site_id or site_id == '1':
        try:
            from pyplejd import get_sites
            sites = await get_sites(email, password)
            if sites:
                site_id = sites[0]['siteId']
                log.info(f'Auto-detected site: {sites[0]["title"]} ({site_id})')
        except Exception as e:
            log.error(f'Failed to get sites: {e}')
            return

    try:
        manager = PlejdManager(username=email, password=password, siteId=site_id)
        await manager.cloud.load_site_details()
        log.info(f'Cloud data loaded. Crypto key: {manager.cloud.cryptokey[:8]}...')
        
        # Set crypto key on mesh
        key = manager.cloud.cryptokey.replace('-', '')
        manager.mesh.set_key(key)
        
        # Register expected mesh devices from cloud data
        for addr in manager.cloud.mesh_devices:
            log.info(f'Registering mesh device: {addr}')
        
        # Set up state change callback
        old_on_state_changed = manager.on_state_changed
        def on_state(device):
            sync_device(device)
            if old_on_state_changed:
                old_on_state_changed(device)
        manager.on_state_changed = on_state
        
        log.info('Connecting to Plejd mesh...')
        
        # Connection loop - retry until connected
        while not shutdown and not manager.mesh.connected:
            try:
                await manager.mesh.connect()
                await asyncio.sleep(3)
            except Exception as e:
                log.warning(f'Connect attempt failed: {e}')
                await asyncio.sleep(5)
        
        if manager.mesh.connected:
            log.info('Connected to Plejd mesh!')
            
            # Wait for devices to be discovered
            await asyncio.sleep(5)
            build_device_cache()
            log.info(f'Found {len(device_cache)} device(s)')
            
            # Initial sync
            for d in manager.devices:
                sync_device(d)
        
    except Exception as e:
        log.error(f'Setup failed: {e}')
        import traceback
        traceback.print_exc()
        return

    # Start background tasks
    asyncio.create_task(poll_devices())
    asyncio.create_task(poll_commands())
    
    log.info(f'Bridge running. Polling every {POLL_INTERVAL}s')
    
    # Keep running
    while not shutdown:
        await asyncio.sleep(1)

def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        log.info('Shutting down')
    except Exception as e:
        log.error(f'Fatal: {e}')

if __name__ == '__main__':
    main()
