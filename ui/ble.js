/* Web Bluetooth transport for Lorax.
 *
 * Interface every transport in this app exposes — the fake device implements
 * exactly the same four members, which is what makes the whole app testable
 * without hardware:
 *
 *   write(bytes) → Promise<void>
 *   onReply(cb)          cb(Uint8Array)   replies to commands, seq-matched
 *   onEvent(cb)          cb(Uint8Array)   unsolicited device events
 *   disconnect() → Promise<void>
 */

export const LORAX = Object.freeze({
  SERVICE: 'e276967f-ea8a-478a-a92e-d78f5dd15dd5',
  VERSION: '05434bca-cc7f-4ef6-bbb3-b1c520b9800c',
  COMMAND: '60133d5c-5727-4f2c-9697-d842c5292a3c',
  REPLY: '8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c',
  EVENT: '43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8',
});

/* Reading the Silabs OTA app-version characteristic is what makes the OS create
 * the BLE bond on some stacks. It is a read, never a write, and failure is
 * ignored — some units are already bonded. */
export const SILABS = Object.freeze({
  SERVICE: '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0',
  APP_VERSION: '0d77cc11-4ac1-49f2-bfa9-cd96ac7a92f8',
});

export const DEVICE_INFO = '0000180a-0000-1000-8000-00805f9b34fb';

export class BluetoothUnavailable extends Error {
  constructor(msg) { super(msg); this.name = 'BluetoothUnavailable'; }
}

export function supported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/* The OS picker.
 *
 * `filters: [{services:[…]}]` only matches a device whose ADVERTISEMENT contains
 * that service UUID. Puffco is not known to advertise the Lorax UUID — the
 * community libraries find Peaks by MAC prefix and manufacturer data instead —
 * so a service filter can hide the device entirely.
 *
 * `acceptAllDevices` lists everything in range, which always works. The cost is
 * a longer list; the benefit is that the device cannot be filtered away.
 * `optionalServices` must still name every service we intend to touch, or
 * getPrimaryService() is refused after connecting.
 */
export async function pickDevice({ all = true } = {}) {
  if (!supported()) {
    throw new BluetoothUnavailable(
      'This browser has no Web Bluetooth. Use Chrome, Edge or Bluefy on iOS — Safari cannot.'
    );
  }
  const optionalServices = [LORAX.SERVICE, DEVICE_INFO, SILABS.SERVICE];
  if (all) {
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  }
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [LORAX.SERVICE] }],
    optionalServices,
  });
}

/* Everything the device exposes, for diagnosing a protocol mismatch. */
export async function listServices(device) {
  const out = [];
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const services = await server.getPrimaryServices();
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    out.push({
      uuid: svc.uuid,
      characteristics: chars.map(c => ({
        uuid: c.uuid,
        properties: c.properties,
      })),
    });
  }
  return out;
}

export class BleTransport {
  constructor(device) {
    this.device = device;
    this.replyCbs = [];
    this.eventCbs = [];
    this.chars = {};
    this.lost = null;
  }

  onReply(cb) { this.replyCbs.push(cb); }
  onEvent(cb) { this.eventCbs.push(cb); }

  _emit(list, bytes) {
    for (const cb of list) { try { cb(bytes); } catch (e) { console.error(e); } }
  }

  async connect() {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error('this browser cannot connect to that device');

    this.device.addEventListener('gattserverdisconnected', () => {
      if (this.lost) this.lost();
    });

    const server = await gatt.connect();

    /* Best-effort bond trigger. A failure here is normal on already-bonded units. */
    try {
      const ota = await server.getPrimaryService(SILABS.SERVICE);
      const c = await ota.getCharacteristic(SILABS.APP_VERSION);
      await c.readValue();
    } catch { /* optional */ }

    const svc = await server.getPrimaryService(LORAX.SERVICE);
    const [cmd, reply, event] = await Promise.all([
      svc.getCharacteristic(LORAX.COMMAND),
      svc.getCharacteristic(LORAX.REPLY),
      svc.getCharacteristic(LORAX.EVENT),
    ]);

    reply.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      this._emit(this.replyCbs, new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });
    event.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      this._emit(this.eventCbs, new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });

    await reply.startNotifications();
    await event.startNotifications();

    this.chars = { cmd, reply, event };
    return this;
  }

  async write(bytes) {
    const c = this.chars.cmd;
    if (!c) throw new Error('not connected');
    /* The command characteristic is write-without-response on this hardware.
     * Falling back to an acknowledged write keeps older stacks working. */
    if (c.properties && c.properties.writeWithoutResponse === false && c.properties.write) {
      await c.writeValue(bytes);
    } else {
      try {
        await c.writeValueWithoutResponse(bytes);
      } catch {
        await c.writeValue(bytes);
      }
    }
  }

  async disconnect() {
    try { this.device.gatt.disconnect(); } catch { /* already gone */ }
  }

  onLost(cb) { this.lost = cb; }
}


/* ---------------------------------------------------------------- bridge */

/* Transport over the local Python bridge (tools/bridge.py).
 *
 * Chromium on Linux has no working Web Bluetooth chooser, so the same bytes are
 * moved over a WebSocket instead. Everything above this line is unchanged: the
 * Lorax client, the auth, the sequencing and the UI all speak to this exactly
 * as they speak to BleTransport.
 */
/* Same origin by default so a tunnel can serve the page and the bridge together;
 * ?port= still overrides for a local bridge on a different port.
 *
 * ?t= is the tunnel's access token. It has to be carried into the WebSocket
 * URL as well: the tunnel gates the upgrade, so a page that opens fine would
 * still be unable to reach the device without it. */
const _bp = new URLSearchParams(location.search);
const _bport = _bp.get('port') || 8792;
/* The bridge runs on the machine with the Bluetooth radio, which is the page's
 * own host only when the page is served from that machine. A page loaded from
 * somewhere else (Pages, a tunnel on another host) has to be told. */
const _bhost = _bp.get('bhost') || (location.hostname || '127.0.0.1');
const _btoken = _bp.get('t');
export const BRIDGE_URL = `ws://${_bhost}:${_bport}${_btoken ? '/?t=' + encodeURIComponent(_btoken) : ''}`;

/* An HTTPS page cannot open a ws:// socket: the browser blocks it as mixed
 * content before a byte is sent. This is not a device or bridge problem, so say
 * so plainly instead of letting the connect hang. */
export function bridgeMixedContent() {
  return location.protocol === 'https:' && BRIDGE_URL.startsWith('ws://');
}

export function bridgeAvailable() {
  return new URLSearchParams(location.search).has('bridge');
}

export class BridgeTransport {
  constructor(url = BRIDGE_URL) {
    this.url = url;
    this.ws = null;
    this.replyCbs = [];
    this.eventCbs = [];
    this.lost = null;
    this.ready = null;
  }

  onReply(cb) { this.replyCbs.push(cb); }
  onEvent(cb) { this.eventCbs.push(cb); }
  onLost(cb) { this.lost = cb; }

  _emit(list, bytes) {
    for (const cb of list) { try { cb(bytes); } catch (e) { console.error(e); } }
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error(
        'The bridge did not answer on ' + this.url + '. Start it with: .venv/bin/python tools/bridge.py'
      )), 5000);

      ws.onopen = () => {
        clearTimeout(timer);
        /* The socket is not the link: the bridge has to open the BLE connection
         * too. Ask without 'auth' so the app's own Device layer owns the
         * handshake, and wait for the bridge to confirm. */
        const addr = new URLSearchParams(location.search).get('addr') || '';
        ws.send(addr ? 'connect ' + addr : 'connect');
      };

      ws.onmessage = ev => {
        if (typeof ev.data === 'string') {
          /* Control frames: "connected <addr>" / "error …" / "pong". */
          if (ev.data.startsWith('connected')) { clearTimeout(timer); resolve(this); }
          else if (ev.data.startsWith('error')) {
            clearTimeout(timer);
            reject(new Error('bridge: ' + ev.data.slice(6)));
          }
          return;
        }
        const buf = new Uint8Array(ev.data);
        if (buf.length < 2) return;
        const kind = buf[0];
        const body = buf.subarray(1);
        if (kind === 0x01) this._emit(this.replyCbs, body);
        else if (kind === 0x02) this._emit(this.eventCbs, body);
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(
          'Cannot reach the bridge on ' + this.url + '. Is tools/bridge.py running?'
        ));
      };

      ws.onclose = () => {
        this.ws = null;
        this.ready = null;
        if (this.lost) this.lost();
      };
    });
    return this.ready;
  }

  async write(bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect();
    this.ws.send(bytes);
  }

  async disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
    }
    this.ws = null;
    this.ready = null;
  }
}
