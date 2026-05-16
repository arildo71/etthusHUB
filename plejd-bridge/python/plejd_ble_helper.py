#!/usr/bin/env python3
"""Plejd BLE helper for etthusHUB - uses Plejd cloud credentials + BLE."""
import sys, json, logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s [PlejdBLE] %(message)s', stream=sys.stderr)
log = logging.getLogger()

manager = None
device_cache = {}

def send_response(data):
    sys.stdout.write(json.dumps(data) + '\n')
    sys.stdout.flush()

def on_state_change(device):
    pid = getattr(device, 'plejd_id', None)
    if pid is None:
        return
    state = 1 if getattr(device, 'state', 0) == 1 else 0
    level = getattr(device, 'level', 254)
    info = device_cache.get(pid, {})
    send_response({'event': 'state_change', 'device_id': pid, 'name': info.get('name', ''), 'state': state, 'level': level})

def handle_connect(cmd):
    global manager
    username = cmd.get('username', '')
    password = cmd.get('password', '')
    site_id = str(cmd.get('site_id', '1'))

    if not username or not password:
        send_response({'error': 'Missing credentials'})
        return

    try:
        from pyplejd import PlejdManager
    except ImportError:
        send_response({'error': 'pyplejd not installed'})
        sys.exit(1)

    try:
        log.info('Creating PlejdManager...')
        manager = PlejdManager(username=username, password=password, siteId=site_id)
        manager.on_state_changed = on_state_change
        log.info('Manager created. devices type=%s len=%d', type(manager.devices).__name__, len(list(manager.devices)))
        send_response({'ok': True, 'message': 'Manager created'})
    except Exception as e:
        send_response({'error': 'Connection failed: ' + str(e)})

def handle_list(cmd=None):
    global device_cache
    if not manager:
        send_response({'error': 'Not connected'})
        return
    new_cache = {}
    devices = []

    device_list = manager.devices
    if isinstance(device_list, dict):
        iterator = device_list.items()
    else:
        iterator = enumerate(device_list)

    for key, device in iterator:
        device_id = key if isinstance(key, int) or isinstance(key, str) else getattr(device, 'plejd_id', key)
        dev_type = str(getattr(device, 'type', '') or getattr(device, 'deviceType', '') or 'Plejd')
        name = str(getattr(device, 'name', '') or 'Plejd ' + str(device_id))
        info = {
            'id': device_id,
            'name': name,
            'type': dev_type,
            'dimmable': any(x in dev_type.lower() for x in ('dim', 'led', 'light')),
            'state': 1 if getattr(device, 'state', 0) == 1 else 0,
            'level': getattr(device, 'level', 254),
        }
        new_cache[device_id] = info
        devices.append(info)
    device_cache = new_cache
    log.info('Found %d device(s)', len(devices))
    send_response({'ok': True, 'devices': devices})

def handle_status(cmd):
    device_id = int(cmd.get('device_id', 0))
    if not manager:
        send_response({'error': 'Not connected'})
        return
    device_list = manager.devices
    device = None
    if isinstance(device_list, dict):
        device = device_list.get(device_id)
    else:
        for d in device_list:
            if getattr(d, 'plejd_id', None) == device_id:
                device = d
                break
    if not device:
        send_response({'error': 'Device not found'})
        return
    state = 1 if getattr(device, 'state', 0) == 1 else 0
    level = getattr(device, 'level', 254)
    send_response({'ok': True, 'device_id': device_id, 'state': state, 'level': level})

def handle_on(cmd):
    device_id = int(cmd.get('device_id', 0))
    if not manager:
        send_response({'error': 'Not connected'})
        return
    try:
        manager.turn_on(device_id)
        send_response({'ok': True})
    except Exception as e:
        send_response({'error': str(e)})

def handle_off(cmd):
    device_id = int(cmd.get('device_id', 0))
    if not manager:
        send_response({'error': 'Not connected'})
        return
    try:
        manager.turn_off(device_id)
        send_response({'ok': True})
    except Exception as e:
        send_response({'error': str(e)})

def handle_dim(cmd):
    device_id = int(cmd.get('device_id', 0))
    level = int(cmd.get('level', 254))
    if not manager:
        send_response({'error': 'Not connected'})
        return
    try:
        manager.set_level(device_id, level)
        send_response({'ok': True})
    except Exception as e:
        send_response({'error': str(e)})

def handle_subscribe(cmd=None):
    if not manager:
        send_response({'error': 'Not connected'})
        return
    send_response({'ok': True, 'message': 'Subscribed'})

COMMANDS = {
    'connect': handle_connect, 'list': handle_list, 'status': handle_status,
    'on': handle_on, 'off': handle_off, 'dim': handle_dim,
    'subscribe': handle_subscribe, 'poll': handle_list,
}

def main():
    log.info('Plejd BLE helper starting')
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            send_response({'error': 'Invalid JSON'})
            continue
        command = cmd.get('cmd', '')
        if command == 'quit':
            log.info('Shutting down')
            send_response({'ok': True, 'message': 'Goodbye'})
            break
        handler = COMMANDS.get(command)
        if handler:
            try:
                handler(cmd)
            except Exception as e:
                log.error('Error: %s', e)
                send_response({'error': str(e)})
        else:
            send_response({'error': 'Unknown command: ' + command})

if __name__ == '__main__':
    main()
