'use strict';
// Runs the pure + protocol code of verificateur-slot-b.html against the fake
// calculator. Usage: node run_tests.js <tool.html> <release.dfu>
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { FakeCalculator, BASE } = require('./fake_calculator');

const [, , htmlPath, dfuPath] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ctx = { module: { exports: {} }, setTimeout, console, Promise, Uint8Array, Uint32Array, DataView, ArrayBuffer, Math, Number, String, Set, Error };
vm.createContext(ctx);
vm.runInContext(script, ctx);
const T = ctx.module.exports;

const buf = fs.readFileSync(dfuPath);
const dfu = T.parseDfuSe(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

function dfuseRaw(fake, el) { return fake.flash.subarray(el.address - BASE, el.address - BASE + el.data.length); }

(async () => {
  let n = 0;
  const ok = (name) => console.log('ok', ++n, name);

  // Parsing
  assert.strictEqual(dfu.crcOk, true); assert.strictEqual(dfu.elements.length, 2);
  assert.strictEqual(dfu.elements[0].address, 0x90410000);
  const h = T.decodeUserlandHeader(dfu.elements[0].data.subarray(0, 64));
  assert.strictEqual(h.magic, 0xDEC0EDFE); assert.strictEqual(h.version, '26.3.0'); assert.strictEqual(h.stackPointer, 0x2403eff8);
  ok('parse release dfu + header');
  const bad = new Uint8Array(buf); bad[100] ^= 1;
  assert.strictEqual(T.parseDfuSe(bad.buffer).crcOk, false); ok('crc detects corruption');

  // Memory maps (strings from shared/ion/src/device/include/n0120/config/usb_userland.h)
  const authA = '@Flash/0x90030000/61*064Kg,64*064Kg';
  const authB = '@Flash/0x90000000/08*004Kg,01*032Kg,63*064Kg/0x90430000/61*064Kg';
  const thirdA = '@Flash/0x90030000/61*064Kg';
  assert.strictEqual(T.runningSlotFromMap(authA), 'A'); assert.strictEqual(T.runningSlotFromMap(authB), 'B'); assert.strictEqual(T.runningSlotFromMap(thirdA), 'A');
  assert.strictEqual(T.rangeWritable(T.parseMemoryMap(authA), 0x90410000, 0x90800000), true);
  assert.strictEqual(T.rangeWritable(T.parseMemoryMap(thirdA), 0x90410000, 0x90800000), false);
  assert.strictEqual(T.rangeWritable(T.parseMemoryMap(authB), 0x90410000, 0x90420000), false);
  assert.strictEqual(T.parseMemoryMap(authA)[1].end, 0x90800000);
  ok('memory map parsing / running slot / writability');

  // Installability guards
  const userlandOnly = T.selectElements(dfu, true);
  assert.strictEqual(userlandOnly.length, 1);
  T.checkInstallable(userlandOnly, 'n0120', T.parseMemoryMap(authA));
  assert.throws(() => T.checkInstallable(userlandOnly, 'n0115', T.parseMemoryMap(authA)), /N0115/);
  assert.throws(() => T.checkInstallable(userlandOnly, 'n0120', T.parseMemoryMap(thirdA)), /autorise pas/);
  assert.throws(() => T.checkInstallable([{ address: 0x90020000, data: new Uint8Array(16) }], 'n0120', null), /hors du slot B/);
  ok('install guards (model, writability, slot A protection)');

  // 1. Empty slot B: header read shows 0xFF, compare reports erased
  let fake = new FakeCalculator();
  const head = await T.readRange(fake, 0x90410000, 64, null);
  assert.ok(head.every((b) => b === 0xFF));
  let res = await T.compareElements(fake, userlandOnly, null);
  assert.ok(res[0].firstMismatch === 0 && res[0].erasedRatio > 0.9);
  ok('read-only checks on empty slot B');

  // 2. Install userland only, then verify
  const slotABefore = fake.flash.slice(0, 0x400000);
  const logs = [];
  res = await T.install(fake, userlandOnly, (m) => logs.push(m), () => {});
  assert.strictEqual(res[0].firstMismatch, -1);
  assert.deepStrictEqual(Buffer.from(dfuseRaw(fake, userlandOnly[0])), Buffer.from(userlandOnly[0].data));
  assert.deepStrictEqual(Buffer.from(fake.flash.slice(0, 0x400000)), Buffer.from(slotABefore));
  const sectors = Math.ceil((0x90410000 + userlandOnly[0].data.length - 0x90410000) / 0x10000);
  assert.strictEqual(fake.stats.erases, sectors); assert.strictEqual(fake.stats.massErase, 0); assert.strictEqual(fake.stats.leave, 0);
  assert.ok(fake.flash.slice(0x400000, 0x410000).every((b) => b === 0xFF), 'slot B kernel area untouched');
  ok('install userland only: exact content, ' + sectors + ' erases (one per sector), slot A untouched, no reset');

  // 3. Install both blocks
  fake = new FakeCalculator();
  res = await T.install(fake, T.selectElements(dfu, false), () => {}, () => {});
  assert.ok(res.every((r) => r.firstMismatch === -1)); ok('install with persisting bytes block');

  // 4. Kernel refusing the persisting bytes sector: error must be detected
  fake = new FakeCalculator({ writable: [[0x90030000, 0x907F0000]] });
  await assert.rejects(T.install(fake, T.selectElements(dfu, false), () => {}, () => {}), /refusé/);
  ok('refused erase is detected (bStatus), not silently ignored');

  // 5. Reinstall over existing different content (old official firmware in slot B)
  fake = new FakeCalculator({ fill: (f) => { for (let i = 0x400000; i < 0x800000; i++) f[i] = (i * 7) & 0xFF; } });
  res = await T.install(fake, userlandOnly, () => {}, () => {});
  assert.strictEqual(res[0].firstMismatch, -1); ok('install over previous content');

  // 6. Partial install (simulates an interrupted transfer) is reported as mismatch
  fake = new FakeCalculator();
  await T.install(fake, userlandOnly, () => {}, () => {});
  fake.flash.fill(0xFF, 0x500000, 0x510000);
  res = await T.compareElements(fake, userlandOnly, null);
  assert.ok(res[0].firstMismatch === 0x500000 - 0x410000 && res[0].differing > 0);
  ok('partial content detected at ' + T.hex(0x90500000));

  console.log('ALL ' + n + ' TESTS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
