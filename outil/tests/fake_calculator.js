'use strict';
// Simulates the DFU interface of Epsilon's userland as written in
// shared/ion/src/device/shared/usb/dfu_interface.cpp, on top of an 8 MiB NOR
// external flash (bits can only be cleared by a write; erase sets 0xFF).

const BASE = 0x90000000;
const SIZE = 0x800000;
const ST = { IDLE: 2, DNLOADSYNC: 3, DNBUSY: 4, DNLOADIDLE: 5, MANIFESTSYNC: 6, UPLOADIDLE: 9, ERROR: 10 };

// External flash sectors: 8 * 4K + 32K + 127 * 64K (board.h comment).
function sectorBounds(address) {
  const off = address - BASE;
  if (off < 0 || off >= SIZE) return null;
  if (off < 0x8000) { const s = Math.floor(off / 0x1000) * 0x1000; return [s, s + 0x1000]; }
  if (off < 0x10000) return [0x8000, 0x10000];
  const s = Math.floor(off / 0x10000) * 0x10000;
  return [s, s + 0x10000];
}

class FakeCalculator {
  constructor({ writable = [[0x90030000, 0x90800000]], fill = null } = {}) {
    this.flash = new Uint8Array(SIZE).fill(0xFF);
    if (fill) fill(this.flash);
    this.writable = writable;          // kernel-enforced writable ranges
    this.state = ST.IDLE; this.status = 0;
    this.pointer = 0; this.pending = null; this.erasePage = null;
    this.buffer = null; this.writeAddress = 0;
    this.stats = { erases: 0, writes: 0, uploads: 0, massErase: 0, leave: 0 };
  }
  allowed(a, len) { return this.writable.some(([s, e]) => a >= s && a + len <= e); }

  async controlTransferOut(setup, data) {
    const d = data ? new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data) : new Uint8Array(0);
    switch (setup.request) {
      case 1: { // DNLOAD
        if (d.length === 0) {
          if (this.state !== ST.IDLE && this.state !== ST.DNLOADIDLE) { this.state = ST.ERROR; return { status: 'stall' }; }
          this.state = ST.MANIFESTSYNC; this.stats.leave++;  // would reset the calculator
          return { status: 'ok', bytesWritten: 0 };
        }
        if (setup.value === 0) {
          const addr = d.length === 5 ? (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0 : 0;
          if (d[0] === 0x21) { this.pending = addr; this.state = ST.DNLOADSYNC; }
          else if (d[0] === 0x41) {
            this.state = ST.DNLOADSYNC;
            if (d.length === 1) { this.erasePage = 'mass'; this.stats.massErase++; }
            else {
              const b = sectorBounds(addr);
              if (!b) { this.state = ST.ERROR; this.status = 1; } else this.erasePage = b;
            }
          } else { this.state = ST.ERROR; this.status = 0x0F; }
          return { status: 'ok', bytesWritten: d.length };
        }
        if (setup.value === 1) return { status: 'stall' };
        this.writeAddress = (setup.value - 2) * 2048 + this.pointer;
        this.buffer = d; this.state = ST.DNLOADSYNC;
        return { status: 'ok', bytesWritten: d.length };
      }
      case 4: this.status = 0; this.state = ST.IDLE; return { status: 'ok', bytesWritten: 0 };  // CLRSTATUS
      case 6: this.status = 0; this.state = ST.IDLE; return { status: 'ok', bytesWritten: 0 };  // ABORT
      default: return { status: 'stall' };
    }
  }

  async controlTransferIn(setup, length) {
    if (setup.request === 3) { // GETSTATUS
      if (this.state === ST.MANIFESTSYNC) this.state = 7;
      else if (this.state === ST.DNLOADSYNC) this.state = ST.DNBUSY;
      const out = new DataView(new ArrayBuffer(6));
      out.setUint8(0, this.status); out.setUint8(1, 1); out.setUint8(4, this.state);
      // wholeDataSentCallback
      if (this.state === ST.DNBUSY) {
        if (this.buffer) this.write();
        if (this.pending !== null) { this.pointer = this.pending; this.pending = null; this.state = ST.DNLOADIDLE; this.status = 0; }
        if (this.erasePage) this.erase();
        this.state = ST.DNLOADIDLE;
      }
      return { status: 'ok', data: out };
    }
    if (setup.request === 2) { // UPLOAD
      if (this.state !== ST.IDLE && this.state !== ST.UPLOADIDLE) return { status: 'stall' };
      if (setup.value < 2) return { status: 'stall' };
      const a = (setup.value - 2) * 2048 + this.pointer;
      const n = Math.min(2048, length);
      this.stats.uploads++;
      const off = a - BASE;
      const chunk = this.flash.slice(off, off + n);
      this.state = ST.UPLOADIDLE;
      return { status: 'ok', data: new DataView(chunk.buffer) };
    }
    if (setup.request === 5) { const o = new DataView(new ArrayBuffer(1)); o.setUint8(0, this.state); return { status: 'ok', data: o }; }
    return { status: 'stall' };
  }

  write() {
    const a = this.writeAddress, d = this.buffer;
    this.buffer = null;
    if (!this.allowed(a, d.length)) { this.state = ST.ERROR; this.status = 1; return; }
    const off = a - BASE;
    for (let i = 0; i < d.length; i++) this.flash[off + i] &= d[i];  // NOR: program clears bits only
    this.stats.writes++; this.state = ST.DNLOADIDLE; this.status = 0;
  }

  erase() {
    const p = this.erasePage;
    if (p === 'mass') { this.status = 1; return; }  // never expected from the tool
    const [s, e] = p;
    if (!this.allowed(BASE + s, e - s)) { this.state = ST.ERROR; this.status = 1; return; }
    this.flash.fill(0xFF, s, e);
    this.stats.erases++; this.erasePage = null; this.state = ST.DNLOADIDLE; this.status = 0;
  }
}

module.exports = { FakeCalculator, BASE };
