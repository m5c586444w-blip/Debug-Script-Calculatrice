"""Rewrite a DfuSe file keeping only the elements at the given addresses."""
import struct, sys, zlib

src, dst = sys.argv[1], sys.argv[2]
keep = {int(a, 16) for a in sys.argv[3:]}
b = open(src, 'rb').read()
assert b[:5] == b'DfuSe' and b[-16:][8:11] == b'UFD'
suffix = b[-16:]
off = 11
target_prefix = bytearray(b[off:off + 274])
assert b[10] == 1, 'single target expected'
nel = struct.unpack('<I', target_prefix[270:274])[0]
off += 274
elements = []
for _ in range(nel):
    addr, size = struct.unpack('<II', b[off:off + 8])
    elements.append((addr, b[off + 8:off + 8 + size]))
    off += 8 + size
kept = [(a, d) for a, d in elements if a in keep]
assert kept, 'nothing kept'
body = b''.join(struct.pack('<II', a, len(d)) + d for a, d in kept)
struct.pack_into('<II', target_prefix, 266, len(body), len(kept))
image = bytes(target_prefix) + body
prefix = b'DfuSe' + bytes([1]) + struct.pack('<I', 11 + len(image)) + bytes([1])
out = prefix + image + suffix[:12]
out += struct.pack('<I', (~zlib.crc32(out)) & 0xffffffff)
open(dst, 'wb').write(out)
