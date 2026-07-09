// pi-wasm S14 (bd-c6ffc3) 4b — 9p2000.L byte codec.
//
// A faithful TypeScript port of copy/v86's lib/marshall.js so our JS-side 9p
// server marshals/unmarshals exactly the byte layout v86's guest-side virtio-9p
// device expects (the surest way to interop without hand-guessing the wire
// format). Field type codes:
//   "b" 1-byte     "h" 2-byte LE    "w" 4-byte LE
//   "d" 8-byte LE, but only the low 32 bits carry a value (high 4 bytes are
//       always zero) — matches v86; fine for our small VFS (sizes/offsets < 4GB)
//   "s" 2-byte LE length prefix + UTF-8 bytes
//   "Q" qid = b(type) w(version) d(path) = 13 bytes

export interface Qid {
  /** QTDIR 0x80 | QTFILE 0x00 | QTSYMLINK 0x02. */
  type: number;
  version: number;
  /** Unique inode number (marshalled as the low 32 bits of the "d" path). */
  path: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export type MarshallValue = number | string | Qid;

/** Marshall `input` (per `typelist`) into `struct` at `offset`; returns bytes written. */
export function Marshall(typelist: string[], input: MarshallValue[], struct: Uint8Array, offset: number): number {
  let size = 0;
  for (let i = 0; i < typelist.length; i++) {
    const item = input[i];
    switch (typelist[i]) {
      case "w": {
        const v = item as number;
        struct[offset++] = v & 0xff;
        struct[offset++] = (v >> 8) & 0xff;
        struct[offset++] = (v >> 16) & 0xff;
        struct[offset++] = (v >> 24) & 0xff;
        size += 4;
        break;
      }
      case "d": {
        const v = item as number;
        struct[offset++] = v & 0xff;
        struct[offset++] = (v >> 8) & 0xff;
        struct[offset++] = (v >> 16) & 0xff;
        struct[offset++] = (v >> 24) & 0xff;
        struct[offset++] = 0;
        struct[offset++] = 0;
        struct[offset++] = 0;
        struct[offset++] = 0;
        size += 8;
        break;
      }
      case "h": {
        const v = item as number;
        struct[offset++] = v & 0xff;
        struct[offset++] = (v >> 8) & 0xff;
        size += 2;
        break;
      }
      case "b":
        struct[offset++] = item as number;
        size += 1;
        break;
      case "s": {
        const lengthOffset = offset;
        struct[offset++] = 0;
        struct[offset++] = 0;
        size += 2;
        const bytes = enc.encode(item as string);
        struct.set(bytes, offset);
        offset += bytes.byteLength;
        size += bytes.byteLength;
        struct[lengthOffset] = bytes.byteLength & 0xff;
        struct[lengthOffset + 1] = (bytes.byteLength >> 8) & 0xff;
        break;
      }
      case "Q": {
        const q = item as Qid;
        Marshall(["b", "w", "d"], [q.type, q.version, q.path], struct, offset);
        offset += 13;
        size += 13;
        break;
      }
      default:
        throw new Error(`Marshall: unknown type ${typelist[i]}`);
    }
  }
  return size;
}

export interface UnmarshallState {
  offset: number;
}

/** Unmarshall values (per `typelist`) from `struct`, advancing `state.offset`. */
export function Unmarshall(typelist: string[], struct: Uint8Array, state: UnmarshallState): MarshallValue[] {
  let offset = state.offset;
  const output: MarshallValue[] = [];
  for (let i = 0; i < typelist.length; i++) {
    switch (typelist[i]) {
      case "w": {
        let val = struct[offset++];
        val += struct[offset++] << 8;
        val += struct[offset++] << 16;
        val += (struct[offset++] << 24) >>> 0;
        output.push(val >>> 0);
        break;
      }
      case "d": {
        let val = struct[offset++];
        val += struct[offset++] << 8;
        val += struct[offset++] << 16;
        val += (struct[offset++] << 24) >>> 0;
        offset += 4; // high 32 bits ignored
        output.push(val >>> 0);
        break;
      }
      case "h": {
        let val = struct[offset++];
        val += struct[offset++] << 8;
        output.push(val);
        break;
      }
      case "b":
        output.push(struct[offset++]);
        break;
      case "s": {
        let len = struct[offset++];
        len += struct[offset++] << 8;
        const bytes = struct.slice(offset, offset + len);
        offset += len;
        output.push(dec.decode(bytes));
        break;
      }
      case "Q": {
        state.offset = offset;
        const [type, version, path] = Unmarshall(["b", "w", "d"], struct, state) as number[];
        offset = state.offset;
        output.push({ type, version, path });
        break;
      }
      default:
        throw new Error(`Unmarshall: unknown type ${typelist[i]}`);
    }
  }
  state.offset = offset;
  return output;
}
