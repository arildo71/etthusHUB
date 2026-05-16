#!/usr/bin/env python3
"""Plejd BLE bridge for etthusHUB - uses Firebase REST API."""
import os, sys, json, time, logging, uuid
from pathlib import Path
from threading import Event

import requests
from pyplejd import PlejdManager

logging.basicConfig(level=logging.INFO, format='%(asctime)s [Plejd] %(message)s')
log = logging.getLogger()

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
    except: pass

# Firebase anonymous auth token (cached)
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

def firestore_set(path, data):
    token = get_firebase_token()
    resp = requests.patch(f'{FIRESTORE_URL}/{path}',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        json={'fields': {k: firestore_value(v) for k, v in data.items()}}
    )
    if resp.status_code not in (200, 201, 404):
        log.error(f'Firestore set error {resp.status_code}: {resp.text[:200]}')

def firestore_value(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, dict) and '__serverTimestamp__' in v:
        return {'nullValue': None}  # Cannot send server timestamp via REST easily
    if isinstance(v, str): return {'stringValue': v}
    return {'stringValue': str(v)}

def firestore_doc_fields(doc):
    fields = {}
    for k, v in (doc.get('fields', {}) or {}).items():
        for vtype, val in v.items():
            if vtype == 'stringValue': fields[k] = val
            elif vtype == 'integerValue': fields[k] = int(val)
            elif vtype == 'doubleValue': fields[k] = float(val)
            elif vtype == 'booleanValue': fields[k] = val
    return fields

manager = None
device_cache = {}
shutdown = Event()

def on_state_change(device):
    if device.plejd_id not in device_cache: return
    info = device_cache[device.plejd_id]
    state = 'On' if getattr(device, 'state', 0) == 1 else 'Off'
    level = max(0, min(100, round((getattr(device, 'level', 254) / 254) * 100)))
    log.info(f'Update: {info["name"]} -> {state} ({level}%)')
    data = {
        'name': info['name'], 'nodeId': 'plejd', 'endpointId': device.plejd_id,
        'types': ('Dimmable Light, ' if info['dimmable'] else '') + info.get('type', 'Plejd'),
        'state': state, 'level': level, 'hasLevelControl': info['dimmable'],
        'houseId': HOUSE_ID, 'source': 'plejd',
    }
    firestore_set(f'devices/plejd-{device.plejd_id}', data)

def discover_and_sync():
    if not manager: return
    global device_cache
    new_cache = {}
    for device in manager.devices.values():
        info = {
            'name': device.name or f'Plejd {device.plejd_id}',
            'type': device.type or 'Plejd',
            'dimmable': any(x in (device.type or '').lower() for x in ('dim', 'led', 'light')),
        }
        new_cache[device.plejd_id] = info
        state = 'On' if getattr(device, 'state', 0) == 1 else 'Off'
        level = max(0, min(100, round((getattr(device, 'level', 254) / 254) * 100)))
        doc_id = f'plejd-{device.plejd_id}'
        existing = firestore_get(f'devices/{doc_id}')
        data = {
            'name': info['name'], 'nodeId': 'plejd', 'endpointId': device.plejd_id,
            'types': ('Dimmable Light, ' if info['dimmable'] else '') + info.get('type', 'Plejd'),
            'state': state, 'level': level, 'hasLevelControl': info['dimmable'],
            'houseId': HOUSE_ID, 'source': 'plejd',
        }
        if not existing or not existing.get('fields'):
            data['showOnHome'] = True
        firestore_set(f'devices/{doc_id}', data)
    device_cache = new_cache
    log.info(f'{len(device_cache)} device(s) synced')

def listen_commands():
    if not HOUSE_ID: return
    last_cmd = {'id': ''}
    while not shutdown.is_set():
        try:
            token = get_firebase_token()
            url = f'{FIRESTORE_URL}/commands?pageSize=10&orderBy=status'
            resp = requests.get(url, headers={'Authorization': f'Bearer {token}'})
            if resp.status_code != 200: time.sleep(POLL_INTERVAL); continue
            docs = resp.json().get('documents', [])
            for doc in docs:
                fields = firestore_doc_fields(doc)
                if fields.get('status') != 'pending': continue
                if fields.get('houseId') != HOUSE_ID: continue
                doc_name = doc['name'].split('/')[-1]
                if doc_name == last_cmd['id']: continue
                last_cmd = {'id': doc_name}

                name = fields.get('deviceName', '') or ''
                tid = None
                for pid, info in device_cache.items():
                    if name.lower() in info['name'].lower():
                        tid = pid; break
                if not tid: continue

                try:
                    ct = fields.get('type')
                    text = fields.get('text', '')
                    if ct == 'level' and fields.get('level'):
                        lvl = max(1, min(254, round((int(fields['level']) / 100) * 254)))
                        manager.set_level(tid, lvl)
                    elif text:
                        t = text.lower()
                        if 'on' in t and 'off' not in t: manager.turn_on(tid)
                        elif 'off' in t: manager.turn_off(tid)
                    firestore_set(f'commands/{doc_name}', {'status': 'done'})
                    time.sleep(0.5); discover_and_sync()
                except Exception as e: log.error(f'Cmd: {e}')
        except Exception as e:
            log.error(f'Command poll: {e}')
        shutdown.wait(POLL_INTERVAL)

def main():
    global manager
    log.info('EtthusHUB Plejd Bridge starting')
    if not HOUSE_ID: log.error('No house ID'); sys.exit(1)

    # Get crypto key from house doc
    house = firestore_get(f'houses/{HOUSE_ID}')
    house_fields = firestore_doc_fields(house) if house else {}
    crypto_key = os.environ.get('PLEJD_CRYPTO_KEY') or house_fields.get('plejdCryptoKey', '')
    site_id = int(os.environ.get('PLEJD_SITE_ID') or house_fields.get('plejdSiteId', '') or '1')

    if not crypto_key:
        log.error('Plejd crypto key not configured')
        sys.exit(1)

    # Clean key (remove dashes, spaces)
    crypto_key = crypto_key.replace('-', '').replace(' ', '').upper()
    log.info(f'Crypto key: {crypto_key[:8]}... Site: {site_id}')

    log.info('Connecting to Plejd mesh...')
    manager = PlejdManager(crypto_key=crypto_key, site_id=site_id)
    manager.on_state_changed = on_state_change
    try:
        manager.connect()
        log.info('Connected to Plejd')
    except Exception as e:
        log.error(f'Connection failed: {e}')
        sys.exit(1)

    time.sleep(3)
    discover_and_sync()
    listen_commands()

    log.info(f'Running. Polling every {POLL_INTERVAL}s')
    while not shutdown.is_set():
        shutdown.wait(POLL_INTERVAL)
        try: discover_and_sync()
        except Exception as e: log.error(f'Poll: {e}')

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: log.info('Shutdown')
    except Exception as e: log.error(f'Fatal: {e}'); sys.exit(1)
