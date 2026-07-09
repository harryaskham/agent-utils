// pi-wasm S14 (bd-c6ffc3) 4b — a minimal 9p2000.L server bridging a guest's
// virtio-9p mount to our IndexedDB `Vfs` (the S2 LightningFsVfs), so a microVM
// guest and the in-browser file tools share ONE filesystem tree.
//
// Wire into v86 as `filesystem: { handle9p: (reqBuf, reply) => reply(await
// server.handle(reqBuf)) }`; the guest then mounts it:
//   mount -t 9p -o trans=virtio,version=9p2000.L host9p /work
// After that, a tool-written `/work/hello.txt` is visible to the guest as
// `cat /work/hello.txt`, and vice-versa.
//
// Message layouts + reply framing are ported 1:1 from copy/v86's lib/9p.js so
// they interop exactly with v86's guest device. Every request/response frame is
//   size[4] type[1] tag[2] <body…>      (size counts the whole frame)
// and a reply's type is the request type + 1 (Rlerror = 7 carries just an errno).
//
// Scope: the message set a Linux guest needs to mount + stat + read + write +
// create + list + unlink over this tree. Unknown ops return Rlerror(ENOSYS).

import { Marshall, Unmarshall, type Qid, type MarshallValue } from "./marshall";
import { join } from "../../vfs/posix-path";
import type { Vfs, VfsStat } from "../../vfs/vfs";

// 9p2000.L message types (T = request; reply is T+1).
const Tstatfs = 8;
const Tlopen = 12;
const Tlcreate = 14;
const Treadlink = 22;
const Tgetattr = 24;
const Tsetattr = 26;
const Treaddir = 40;
const Tfsync = 50;
const Tmkdir = 72;
const Tunlinkat = 76;
const Tversion = 100;
const Tattach = 104;
const Tflush = 108;
const Twalk = 110;
const Tread = 116;
const Twrite = 118;
const Tclunk = 120;
const Rlerror = 7;

// qid.type
const QTDIR = 0x80;
const QTSYMLINK = 0x02;
const QTFILE = 0x00;
// st_mode format bits
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
// d_type (readdir)
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;
// errno
const ENOENT = 2;
const EIO = 5;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const EINVAL = 22;
const ENOTEMPTY = 39;
const ENOSYS = 38;
// Tsetattr valid mask bit for size (truncate).
const P9_SETATTR_SIZE = 0x00000008;

const BLOCKSIZE = 8192;
const DEFAULT_MSIZE = 8192;
const MAX_MSIZE = 512 * 1024;
const VERSION = "9P2000.L";

export interface Vfs9pServerOptions {
  vfs: Vfs;
  /** VFS path the 9p root (attach) maps to. Guest sees this at its mount point. Default "/work". */
  root?: string;
  /** Optional debug logger for unhandled/erroring messages. */
  log?: (msg: string) => void;
}

function errnoOf(e: unknown): number {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case "ENOENT":
      return ENOENT;
    case "EEXIST":
      return EEXIST;
    case "ENOTDIR":
      return ENOTDIR;
    case "EISDIR":
      return EISDIR;
    case "ENOTEMPTY":
      return ENOTEMPTY;
    case "EINVAL":
      return EINVAL;
    default:
      return EIO;
  }
}

/** A minimal, VFS-backed 9p2000.L server. One instance per mounted guest FS. */
export class Vfs9pServer {
  private readonly vfs: Vfs;
  private readonly root: string;
  private readonly log?: (msg: string) => void;
  private readonly fids = new Map<number, string>();
  private readonly inodes = new Map<string, number>();
  private nextInode = 1;
  private msize = DEFAULT_MSIZE;
  private rootEnsured = false;

  constructor(options: Vfs9pServerOptions) {
    this.vfs = options.vfs;
    this.root = options.root ?? "/work";
    this.log = options.log;
  }

  /** Handle one full 9p request frame; resolve with the full reply frame. */
  async handle(req: Uint8Array): Promise<Uint8Array> {
    const state = { offset: 0 };
    const [, id, tag] = Unmarshall(["w", "b", "h"], req, state) as number[];
    try {
      return await this.dispatch(id, tag, req, state);
    } catch (e) {
      this.log?.(`9p op ${id} failed: ${String(e)}`);
      return this.rlerror(tag, errnoOf(e));
    }
  }

  private inodeFor(path: string): number {
    let n = this.inodes.get(path);
    if (n === undefined) {
      n = this.nextInode++;
      this.inodes.set(path, n);
    }
    return n;
  }

  private qidFor(path: string, st: VfsStat): Qid {
    const type = st.type === "dir" ? QTDIR : st.type === "symlink" ? QTSYMLINK : QTFILE;
    return { type, version: (st.mtimeMs & 0xffffffff) >>> 0, path: this.inodeFor(path) };
  }

  /** Build a reply frame: header (size,type=id+1,tag) at 0, payload from offset 7. */
  private frame(id: number, tag: number, build: (buf: Uint8Array) => number): Uint8Array {
    const buf = new Uint8Array(this.msize + 64);
    const payloadSize = build(buf);
    Marshall(["w", "b", "h"], [payloadSize + 7, id + 1, tag], buf, 0);
    return buf.slice(0, payloadSize + 7);
  }

  private rlerror(tag: number, errno: number): Uint8Array {
    const buf = new Uint8Array(11);
    Marshall(["w"], [errno], buf, 7);
    Marshall(["w", "b", "h"], [11, Rlerror, tag], buf, 0);
    return buf;
  }

  private empty(id: number, tag: number): Uint8Array {
    return this.frame(id, tag, () => 0);
  }

  private async ensureRoot(): Promise<void> {
    if (this.rootEnsured) return;
    try {
      await this.vfs.lstat(this.root);
    } catch {
      try {
        await this.vfs.mkdir(this.root);
      } catch {
        /* best-effort; a parent may be missing — attach will surface it */
      }
    }
    this.rootEnsured = true;
  }

  private async dispatch(id: number, tag: number, req: Uint8Array, state: { offset: number }): Promise<Uint8Array> {
    switch (id) {
      case Tversion: {
        const [clientMsize, version] = Unmarshall(["w", "s"], req, state) as [number, string];
        this.msize = Math.min(clientMsize || DEFAULT_MSIZE, MAX_MSIZE);
        this.fids.clear();
        const ver = version.startsWith("9P2000.L") ? VERSION : "unknown";
        return this.frame(id, tag, (buf) => Marshall(["w", "s"], [this.msize, ver], buf, 7));
      }

      case Tattach: {
        // fid, afid, uname, aname, uid
        const [fid] = Unmarshall(["w", "w", "s", "s", "w"], req, state) as number[];
        await this.ensureRoot();
        const st = await this.vfs.lstat(this.root);
        this.fids.set(fid, this.root);
        const qid = this.qidFor(this.root, st);
        return this.frame(id, tag, (buf) => Marshall(["Q"], [qid], buf, 7));
      }

      case Tstatfs: {
        Unmarshall(["w"], req, state);
        // type, bsize, blocks, bfree, bavail, files, ffree, fsid, namelen
        return this.frame(id, tag, (buf) =>
          Marshall(
            ["w", "w", "d", "d", "d", "d", "d", "d", "w"],
            [0x01021997, BLOCKSIZE, 1 << 20, 1 << 20, 1 << 20, 1 << 16, 1 << 16, 0, 255],
            buf,
            7,
          ),
        );
      }

      case Twalk: {
        const [fid, newfid, nwname] = Unmarshall(["w", "w", "h"], req, state) as number[];
        const base = this.fids.get(fid);
        if (base === undefined) return this.rlerror(tag, ENOENT);
        if (nwname === 0) {
          this.fids.set(newfid, base);
          return this.frame(id, tag, (buf) => Marshall(["h"], [0], buf, 7));
        }
        const names = Unmarshall(new Array(nwname).fill("s"), req, state) as string[];
        let cur = base;
        const qids: Qid[] = [];
        for (const name of names) {
          const next = join(cur, name);
          try {
            const st = await this.vfs.lstat(next);
            qids.push(this.qidFor(next, st));
            cur = next;
          } catch {
            break; // partial walk: stop at first missing element
          }
        }
        if (qids.length === 0) return this.rlerror(tag, ENOENT);
        if (qids.length === nwname) this.fids.set(newfid, cur);
        return this.frame(id, tag, (buf) => {
          let off = 7 + Marshall(["h"], [qids.length], buf, 7);
          for (const q of qids) off += Marshall(["Q"], [q], buf, off);
          return off - 7;
        });
      }

      case Tgetattr: {
        const [fid, mask] = Unmarshall(["w", "d"], req, state) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        const st = await this.vfs.lstat(path);
        return this.frame(id, tag, (buf) => this.marshallGetattr(buf, mask, path, st));
      }

      case Tlopen: {
        const [fid] = Unmarshall(["w", "w"], req, state) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        const st = await this.vfs.lstat(path);
        const qid = this.qidFor(path, st);
        return this.frame(id, tag, (buf) => Marshall(["Q", "w"], [qid, this.msize - 24], buf, 7));
      }

      case Tread: {
        const [fid, offset, count] = Unmarshall(["w", "d", "w"], req, state) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        const full = await this.vfs.readFile(path);
        const cap = Math.min(count, this.msize - 11);
        const slice = full.subarray(offset, Math.min(full.length, offset + cap));
        return this.frame(id, tag, (buf) => {
          Marshall(["w"], [slice.length], buf, 7);
          buf.set(slice, 11);
          return 4 + slice.length;
        });
      }

      case Treaddir: {
        const [fid, offset, count] = Unmarshall(["w", "d", "w"], req, state) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        const data = await this.buildDirents(path, offset, Math.min(count, this.msize - 11));
        return this.frame(id, tag, (buf) => {
          Marshall(["w"], [data.length], buf, 7);
          buf.set(data, 11);
          return 4 + data.length;
        });
      }

      case Twrite: {
        const [fid, offset, count] = Unmarshall(["w", "d", "w"], req, state) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        const data = req.subarray(state.offset, state.offset + count);
        let cur: Uint8Array;
        try {
          cur = await this.vfs.readFile(path);
        } catch {
          cur = new Uint8Array(0);
        }
        const end = Math.max(cur.length, offset + data.length);
        const merged = new Uint8Array(end);
        merged.set(cur.subarray(0, Math.min(cur.length, end)), 0);
        merged.set(data, offset);
        await this.vfs.writeFile(path, merged);
        return this.frame(id, tag, (buf) => Marshall(["w"], [data.length], buf, 7));
      }

      case Tlcreate: {
        const [fid, name] = Unmarshall(["w", "s", "w", "w", "w"], req, state) as [number, string, number, number, number];
        const dir = this.fids.get(fid);
        if (dir === undefined) return this.rlerror(tag, ENOENT);
        const path = join(dir, name);
        await this.vfs.writeFile(path, new Uint8Array(0));
        this.fids.set(fid, path); // fid now refers to the created file (v86 semantics)
        const st = await this.vfs.lstat(path);
        const qid = this.qidFor(path, st);
        return this.frame(id, tag, (buf) => Marshall(["Q", "w"], [qid, this.msize - 24], buf, 7));
      }

      case Tmkdir: {
        const [fid, name] = Unmarshall(["w", "s", "w", "w"], req, state) as [number, string, number, number];
        const dir = this.fids.get(fid);
        if (dir === undefined) return this.rlerror(tag, ENOENT);
        const path = join(dir, name);
        await this.vfs.mkdir(path);
        const st = await this.vfs.lstat(path);
        const qid = this.qidFor(path, st);
        return this.frame(id, tag, (buf) => Marshall(["Q"], [qid], buf, 7));
      }

      case Tunlinkat: {
        const [fid, name] = Unmarshall(["w", "s", "w"], req, state) as [number, string, number];
        const dir = this.fids.get(fid);
        if (dir === undefined) return this.rlerror(tag, ENOENT);
        const path = join(dir, name);
        const st = await this.vfs.lstat(path);
        if (st.type === "dir") await this.vfs.rmdir(path);
        else await this.vfs.unlink(path);
        return this.empty(id, tag);
      }

      case Tsetattr: {
        // fid, valid, mode, uid, gid, size, atime(2), mtime(2)
        const [fid, valid, , , , size] = Unmarshall(
          ["w", "w", "w", "w", "w", "d", "d", "d", "d", "d"],
          req,
          state,
        ) as number[];
        const path = this.fids.get(fid);
        if (path === undefined) return this.rlerror(tag, ENOENT);
        if (valid & P9_SETATTR_SIZE) {
          // Truncate/extend to `size` (handles shell `>` redirection).
          let cur: Uint8Array;
          try {
            cur = await this.vfs.readFile(path);
          } catch {
            cur = new Uint8Array(0);
          }
          const next = new Uint8Array(size);
          next.set(cur.subarray(0, Math.min(cur.length, size)), 0);
          await this.vfs.writeFile(path, next);
        }
        return this.empty(id, tag);
      }

      case Treadlink: {
        // We don't model symlinks in the VFS; report as not present.
        Unmarshall(["w"], req, state);
        return this.rlerror(tag, EINVAL);
      }

      case Tclunk: {
        const [fid] = Unmarshall(["w"], req, state) as number[];
        this.fids.delete(fid);
        return this.empty(id, tag);
      }

      case Tflush:
      case Tfsync:
        return this.empty(id, tag);

      default:
        this.log?.(`9p: unhandled message type ${id}`);
        return this.rlerror(tag, ENOSYS);
    }
  }

  /** Marshall an Rgetattr payload (mirrors v86 9p.js case 24). Returns byte count. */
  private marshallGetattr(buf: Uint8Array, mask: number, path: string, st: VfsStat): number {
    const mode =
      st.type === "dir" ? S_IFDIR | 0o755 : st.type === "symlink" ? S_IFLNK | 0o777 : S_IFREG | 0o644;
    const size = st.size;
    const mt = Math.floor(st.mtimeMs / 1000);
    const qid = this.qidFor(path, st);
    const values: MarshallValue[] = [
      mask, // valid (echo request mask)
      qid,
      mode,
      0, // uid
      0, // gid
      st.type === "dir" ? 2 : 1, // nlink
      0, // rdev
      size,
      BLOCKSIZE, // blksize
      Math.floor(size / 512) + 1, // blocks
      mt, 0, // atime
      mt, 0, // mtime
      mt, 0, // ctime
      0, 0, // btime
      0, 0, // gen, data_version
    ];
    Marshall(
      ["d", "Q", "w", "w", "w", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d"],
      values,
      buf,
      7,
    );
    return 8 + 13 + 4 + 4 + 4 + 8 * 15;
  }

  /**
   * Build Rreaddir payload bytes for `dirPath` starting at cookie `offset`.
   * Each dirent = qid[13] next_offset[8] type[1] name[s]; the cookie is a 1-based
   * running index the guest feeds back to resume. Includes "." and "..".
   */
  private async buildDirents(dirPath: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const names = await this.vfs.readdir(dirPath).catch(() => [] as string[]);
    const entries: { name: string; path: string; self?: boolean; parent?: boolean }[] = [
      { name: ".", path: dirPath, self: true },
      { name: "..", path: dirPath === this.root ? dirPath : join(dirPath, ".."), parent: true },
      ...names.map((n) => ({ name: n, path: join(dirPath, n) })),
    ];
    const out = new Uint8Array(maxBytes);
    let written = 0;
    for (let i = 0; i < entries.length; i++) {
      const cookie = i + 1;
      if (cookie <= offset) continue; // already delivered in a prior Treaddir
      const e = entries[i];
      let qid: Qid;
      let dtype: number;
      try {
        const st = await this.vfs.lstat(e.path);
        qid = this.qidFor(e.path, st);
        dtype = st.type === "dir" ? DT_DIR : st.type === "symlink" ? DT_LNK : DT_REG;
      } catch {
        qid = { type: QTFILE, version: 0, path: this.inodeFor(e.path) };
        dtype = DT_REG;
      }
      const nameBytes = new TextEncoder().encode(e.name).length;
      const entryLen = 13 + 8 + 1 + 2 + nameBytes;
      if (written + entryLen > maxBytes) break; // whole entries only
      let off = written;
      off += Marshall(["Q"], [qid], out, off);
      off += Marshall(["d"], [cookie], out, off);
      off += Marshall(["b"], [dtype], out, off);
      off += Marshall(["s"], [e.name], out, off);
      written = off;
    }
    return out.subarray(0, written);
  }
}
