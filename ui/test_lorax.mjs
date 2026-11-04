/* Protocol + integration tests. No browser, no hardware:
 *   ~/.local/opt/node/bin/node ui/test_lorax.mjs
 *
 * These run the real Lorax client and the real Device facade against the
 * simulated Peak Pro. What they prove: framing, the auth gate, typed reads and
 * writes, session control, and that the curve runner's deltas actually reach
 * /p/app/tmpo. What they cannot prove: anything about real firmware.
 */
import assert from 'node:assert/strict';
import { Lorax, TYPE, OP, enc, dec, revisionString, revisionIndex, authToken, KEYS } from './proto/lorax.js';
import { Device, P, MODE, STATE } from './device.js';
import { createFakeLorax } from './fake_lorax.js';
import { buildPlan, template, fToC, DELTA_LIMITS_C } from './curve.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + e.message); } };
const at = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + e.message); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------ codecs */

t('float round-trips little-endian', () => {
  const b = enc(TYPE.FLOAT, 249.5);
  assert.equal(b.length, 4);
  assert.ok(Math.abs(dec(TYPE.FLOAT, b) - 249.5) < 1e-4);
  assert.equal(b[0], new DataView(b.buffer).getUint8(0));
});

t('u8 / u16 / u32 encode little-endian', () => {
  assert.deepEqual([...enc(TYPE.U8, 0xAB)], [0xAB]);
  assert.deepEqual([...enc(TYPE.U16, 0x1234)], [0x34, 0x12]);
  assert.deepEqual([...enc(TYPE.U32, 0x12345678)], [0x78, 0x56, 0x34, 0x12]);
});

t('string trims trailing NULs and spaces', () => {
  assert.equal(dec(TYPE.STRING, new Uint8Array([65, 66, 0, 0])), 'AB');
  assert.equal(dec(TYPE.STRING, enc(TYPE.STRING, 'Peak Pro')), 'Peak Pro');
});

t('firmware revision decodes to letters', () => {
  /* 21-letter alphabet: A B C D E F G H J K M N P R T U V W X Y Z */
  assert.equal(revisionString(0), 'X*');
  assert.equal(revisionString(1), 'A');
  /* 21 letters (I, L, O, Q, S skipped), so X is 19 and AA follows Z. */
  assert.equal(revisionString(19), 'X');
  assert.equal(revisionString(21), 'Z');
  assert.equal(revisionString(22), 'AA');
  assert.equal(revisionString(26), 'AE');
  assert.ok(revisionIndex('AG') > revisionIndex('X'));
  assert.ok(revisionIndex('AW') > revisionIndex('AG'));
});

t('auth token is 16 bytes and depends on the seed', async () => {
  const s1 = new Uint8Array(16).fill(1), s2 = new Uint8Array(16).fill(2);
  const a = await authToken(s1, KEYS.lorax, 'key');
  const b = await authToken(s2, KEYS.lorax, 'key');
  assert.equal(a.length, 16);
  assert.notDeepEqual([...a], [...b]);
});

/* -------------------------------------------------------------- auth */

await at('a locked device refuses reads', async () => {
  const fake = createFakeLorax();
  const l = new Lorax(fake.transport, { timeout: 800 });
  await assert.rejects(() => l.readRaw('/p/bat/soc'), /device error/);
  fake.stop();
});

await at('handshake unlocks the device', async () => {
  const fake = createFakeLorax({ firmware: 'AG' });
  const l = new Lorax(fake.transport, { timeout: 800 });
  const mode = await l.authenticate();
  assert.ok(mode, 'expected an auth mode');
  assert.equal(fake.unlocked, true);
  const soc = await l.read('/p/bat/soc', TYPE.FLOAT);
  assert.equal(soc, 72);
  fake.stop();
});

await at('a wrong seed produces no token match', async () => {
  const fake = createFakeLorax();
  const other = createFakeLorax();
  const seed = fake.seed;
  const wrong = await authToken(other.seed, KEYS.lorax, 'key');
  /* sanity: the token for a different seed is not the token for this one */
  const right = await authToken(seed, KEYS.lorax, 'key');
  assert.notDeepEqual([...wrong], [...right]);
  fake.stop(); other.stop();
});

await at('start() brings up identity', async () => {
  const fake = createFakeLorax({ firmware: 'AW', name: 'Peak Pro 3DXL', serial: 'S25KW0001' });
  const l = new Lorax(fake.transport, { timeout: 800 });
  const info = await l.start();
  assert.equal(info.firmware, 'AW');
  assert.equal(info.serial, 'S25KW0001');
  assert.equal(info.chamber, 4);
  assert.equal(l.ready, true);
  fake.stop();
});

/* ------------------------------------------------------------ device */

await at('status reads typed values', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });
  const st = await dev.status();
  assert.equal(st.stateName, 'idle');
  assert.equal(st.soc, 72);
  assert.ok(st.tempC > 20 && st.tempC < 30);
  fake.stop();
});

await at('profile write then read back', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });
  await dev.writeProfile(1, { name: 'Test slot', tempC: 260, timeS: 75 });
  const p = await dev.readProfile(1);
  assert.equal(p.name, 'Test slot');
  assert.ok(Math.abs(p.tempC - 260) < 1e-3);
  assert.ok(Math.abs(p.timeS - 75) < 1e-3);
  fake.stop();
});

await at('starting a session moves the device out of idle', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });
  await dev.startSession();
  await sleep(120);
  const st = await dev.status();
  assert.ok(st.inSession, 'expected a session state, got ' + st.stateName);
  fake.stop();
});

await at('abort returns the device to idle', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });
  await dev.startSession();
  await sleep(80);
  await dev.abortSession();
  await sleep(80);
  const st = await dev.status();
  assert.ok(!st.inSession, 'expected idle, got ' + st.stateName);
  assert.equal(fake.state.override, 0);
  fake.stop();
});

await at('heater telemetry is readable', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });
  const h = await dev.heater();
  assert.ok(Math.abs(h.resistance - 4.1) < 1e-4, 'resistance ' + h.resistance);
  assert.ok(Math.abs(h.volts - 18.9) < 1e-4, 'volts ' + h.volts);
  fake.stop();
});

/* ------------------------------------------------------------- curve */

/* Deltas reach the device as Celsius on `/p/app/tmpo` and read back exactly.
 * The executor is now the host-side governor, which is exercised in e2e; this
 * keeps the transport half of the contract pinned without it. */
await at('curve deltas reach /p/app/tmpo', async () => {
  const fake = createFakeLorax();
  const dev = await Device.open(fake.transport, { timeout: 800 });

  const plan = buildPlan(template('ascent', { base: 480, span: 20, hold: 10 }),
    { profileC: fToC(480), unit: 'F', tickSec: 1, maxSlewCPerSec: 3 });
  assert.ok(plan.steps.length >= 3, 'need several steps, got ' + plan.steps.length);

  await dev.startSession();
  await sleep(60);

  const seen = [];
  for (const step of plan.steps.slice(0, 4)) {
    await dev.setOverride(step.deltaC);
    seen.push(step.deltaC);
  }

  assert.ok(seen.length >= 3, 'wrote ' + seen.length + ' deltas');
  assert.ok(Math.abs(fake.state.override - seen[seen.length - 1]) < 0.01,
    `device override ${fake.state.override} should equal last write ${seen[seen.length - 1]}`);
  assert.ok(seen.every(d => d >= DELTA_LIMITS_C.min && d <= DELTA_LIMITS_C.max),
    'a delta outside the offset envelope means the wrong quantity is on the wire: ' + seen.join(', '));

  await dev.abortSession();
  fake.stop();
});

/* --------------------------------------------------------- sequencing */

await at('concurrent reads do not cross replies', async () => {
  const fake = createFakeLorax();
  const l = new Lorax(fake.transport, { timeout: 800 });
  await l.authenticate();
  const results = await Promise.all([
    l.read('/p/bat/soc', TYPE.FLOAT),
    l.read('/p/htr/res', TYPE.FLOAT),
    l.read('/p/sys/hw/ser', TYPE.STRING),
    l.read('/p/htr/chmt', TYPE.U8),
  ]);
  assert.equal(results[0], 72);
  assert.ok(Math.abs(results[1] - 4.1) < 1e-4, 'resistance ' + results[1]);
  assert.equal(results[2], 'FAKE0001');
  assert.equal(results[3], 4);
  fake.stop();
});

await at('a missing path returns an error, not a hang', async () => {
  const fake = createFakeLorax();
  const l = new Lorax(fake.transport, { timeout: 400 });
  await l.authenticate();
  await assert.rejects(() => l.readRaw('/p/nope/nothing'), /device error/);
  fake.stop();
});

console.log(`\nlorax: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
