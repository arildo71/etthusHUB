// Plejd Cloud API client - requires axios dependency
// Uncomment and use when email/password login is needed
// import axios from 'axios';

export async function login(_email: string, _password: string): Promise<string> {
  throw new Error('Plejd Cloud API not enabled. Use crypto key (plejdCryptoKey) for direct BLE connection.');
}

export async function getSites(): Promise<{ id: number; name: string }[]> {
  throw new Error('Not implemented');
}

export async function getDevices(_siteId: number) {
  throw new Error('Not implemented');
}

export async function getDeviceState(_siteId: number, _deviceId: number) {
  throw new Error('Not implemented');
}

export async function turnOn(_siteId: number, _deviceId: number) {
  throw new Error('Not implemented');
}

export async function turnOff(_siteId: number, _deviceId: number) {
  throw new Error('Not implemented');
}

export async function setDimLevel(_siteId: number, _deviceId: number, _level: number) {
  throw new Error('Not implemented');
}
