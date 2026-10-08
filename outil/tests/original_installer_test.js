'use strict';
// Runs the original installer's DFU functions (copied verbatim from
// docs/index.js by text extraction) against the fake calculator.
const fs = require('fs'); const vm = require('vm');
const { FakeCalculator } = require('./fake_calculator');
const src = fs.readFileSync(process.argv[2], 'utf8');
const pick = (name) => { const i = src.indexOf('async function ' + name + '('); let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); } };
const consts = src.split('\n').filter((l) => /^const (DFU_|PAGE_SIZE)/.test(l)).join('\n');
const code = consts + '\nfunction sleep(ms){return new Promise(r=>setTimeout(r,ms));}\n' +
  ['controlTransferOut', 'controlTransferIn', 'getDfuStatus', 'setAddress', 'pageErase', 'writeMemory'].map(pick).join('\n') +
  '\nmodule.exports={pageErase,writeMemory};';
const ctx = { module: {}, setTimeout, Uint8Array, DataView, ArrayBuffer, Error, Math };
vm.createContext(ctx); vm.runInContext(code, ctx);
const { pageErase, writeMemory } = ctx.module.exports;
(async () => {
  // Kernel refuses everything above 0x907F0000 (persisting bytes protected).
  const fake = new FakeCalculator({ writable: [[0x90030000, 0x907F0000]] });
  let threw = false;
  try {
    await pageErase(fake, 0x907F0000);
    await writeMemory(fake, 0x907F0000, new Uint8Array(1024).fill(0x00));
  } catch (e) { threw = e.message; }
  const written = fake.flash[0x7F0000] === 0x00;
  console.log('original installer threw:', threw || 'NO', '| data actually written:', written);
})();
