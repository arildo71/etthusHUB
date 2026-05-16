import asyncio
from bleak import BleakScanner
from pyplejd import PlejdManager, get_site_data

async def main():
    creds = {'username': 'arildjunk@gmail.com', 'password': 'Pae0911!!!D', 'siteId': 'f89186a8-0b28-4f09-9a3e-51bc0c505733'}
    
    site_data = await get_site_data(**creds)
    pm = site_data.get('plejdMesh', {})
    ck = pm.get('cryptoKey', '').replace('-', '').replace(' ', '').upper()
    print('Crypto key set:', ck[:8] + '...')
    
    m = PlejdManager(creds)
    await m.get_devices()
    m.mesh.set_crypto_key(ck)
    print('Cloud devices:', {addr: dev.name for addr, dev in m.devices.items()})
    
    async def on_state(device_state):
        print('STATE:', device_state)
    
    m.mesh.statecallback = on_state
    
    # Scan for mesh gateway
    print('Scanning for Plejd mesh devices...')
    found_devices = []
    def on_device(device, adv):
        addr = device.address.replace(':', '').replace('-', '').upper()
        name = device.name or ''
        if addr in ['CDDEEBA6C0A6', 'E425BBC73860'] or 'P mesh' in name:
            print(f'  Adding: {addr} ({name}) RSSI={adv.rssi}')
            m.add_mesh_device(device, adv.rssi or 0)
            found_devices.append(addr)
    
    scanner = BleakScanner(on_device)
    await scanner.start()
    await asyncio.sleep(8)
    await scanner.stop()
    
    print(f'Found {len(found_devices)} mesh devices. mesh_nodes={len(m.mesh.mesh_nodes)}')
    
    if m.mesh.mesh_nodes:
        print('Connecting to mesh...')
        result = await m.mesh.connect()
        print('Connect result:', result, 'Connected:', m.connected)
        
        if m.connected:
            await asyncio.sleep(2)
            await m.mesh.poll()
            print('Devices after connect:')
            for addr, dev in m.devices.items():
                state = getattr(dev, 'state', '?')
                level = getattr(dev, 'level', '?')
                print(f'  {addr}: {dev.name} state={state} level={level}')
    
    print('Done')

asyncio.run(main())
