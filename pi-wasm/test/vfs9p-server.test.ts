import { describe, it, expect } from "vitest";
import { Marshall, Unmarshall, type MarshallValue, type Qid } from "../src/exec/ninep/marshall";
import { Vfs9pServer } from "../src/exec/ninep/server";
import { LightningFsVfs } from "../src/vfs/vfs";

// pi-wasm S14 (bd-c6ffc3) 4b — codec + 9p2000.L server unit tests.
//
// Validates the wire codec and drives the server through the exact message
// sequence a Linux guest issues for `cat /work/hello.txt` (version → attach →
// walk → getattr → lopen → read → clunk), plus write-back and readdir, all
// against a real LightningFsVfs over fake-indexeddb. This gives fast feedback on
// the 9p logic without booting v86; e2e/microvm.spec.ts then proves it against
// the real guest.

const uniqueVfs = () => new LightningFsVfs(`pi-wasm-9p-${Math.random().toString(36).slice(2)}`, { wipe: true });

// Message type ids (T = request).
const T = {
  version: 100,
  attach: 104,
  statfs: 8,
  walk: 110,
  getattr: 24,
  lopen: 12,
  read: 116,
  readdir: 40,
  write: 118,
  lcreate: 14,
  clunk: 120,
} as const;

/** Build a full request frame: size[4] type[1] tag[2] + marshalled body. */
function buildReq(type: number, tag: number, bodyTypes: string[], bodyValues: MarshallValue[]): Uint8Array {
  const buf = new Uint8Array(16384);
  const bodySize = Marshall(bodyTypes, bodyValues, buf, 7);
  Marshall(["w", "b", "h"], [bodySize + 7, type, tag], buf, 0);
  return buf.slice(0, bodySize + 7);
}

/** Parse a reply frame header; return {size, type, tag} and a body-cursor state. */
function replyHeader(frame: Uint8Array): { size: number; type: number; tag: number; state: { offset: number } } {
  const state = { offset: 0 };
  const [size, type, tag] = Unmarshall(["w", "b", "h"], frame, state) as number[];
  return { size, type, tag, state };
}

describe("9p marshall codec", () => {
  it("round-trips w/h/b/d/s/Q", () => {
    const qid: Qid = { type: 0x80, version: 42, path: 7 };
    const buf = new Uint8Array(256);
    const size = Marshall(
      ["w", "h", "b", "d", "s", "Q"],
      [0x11223344, 0xabcd, 0x5a, 123456, "héllo", qid],
      buf,
      0,
    );
    const state = { offset: 0 };
    const [w, h, b, d, s, q] = Unmarshall(["w", "h", "b", "d", "s", "Q"], buf, state);
    expect(w).toBe(0x11223344);
    expect(h).toBe(0xabcd);
    expect(b).toBe(0x5a);
    expect(d).toBe(123456);
    expect(s).toBe("héllo");
    expect(q).toEqual(qid);
    expect(state.offset).toBe(size);
  });

  it("marshalls d as low-32 + 4 zero bytes (little-endian)", () => {
    const buf = new Uint8Array(8);
    Marshall(["d"], [0x04030201], buf, 0);
    expect([...buf]).toEqual([0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0]);
  });
});

describe("Vfs9pServer — cat /work/hello.txt path", () => {
  it("serves version→attach→walk→getattr→lopen→read for a seeded file", async () => {
    const vfs = uniqueVfs();
    await vfs.mkdir("/work");
    const content = "hello from the host VFS via 9p\n";
    await vfs.writeFile("/work/hello.txt", content);
    const server = new Vfs9pServer({ vfs, root: "/work" });

    // Tversion
    const versionFrame = await server.handle(buildReq(T.version, 0xffff, ["w", "s"], [8192, "9P2000.L"]));
    let r = replyHeader(versionFrame);
    expect(r.type).toBe(T.version + 1);
    const [, ver] = Unmarshall(["w", "s"], versionFrame, r.state) as [number, string];
    expect(ver).toBe("9P2000.L");

    // Tattach: root fid = 0
    const attachFrame = await server.handle(buildReq(T.attach, 1, ["w", "w", "s", "s", "w"], [0, 0xffffffff, "root", "", 0]));
    r = replyHeader(attachFrame);
    expect(r.type).toBe(T.attach + 1);
    const [rootQid] = Unmarshall(["Q"], attachFrame, r.state) as [Qid];
    expect(rootQid.type).toBe(0x80); // QTDIR

    // Twalk 0 -> 1 : ["hello.txt"]
    const walkFrame = await server.handle(buildReq(T.walk, 2, ["w", "w", "h", "s"], [0, 1, 1, "hello.txt"]));
    r = replyHeader(walkFrame);
    expect(r.type).toBe(T.walk + 1);
    const [nwqid] = Unmarshall(["h"], walkFrame, r.state) as [number];
    expect(nwqid).toBe(1);
    const [fileQid] = Unmarshall(["Q"], walkFrame, r.state) as [Qid];
    expect(fileQid.type).toBe(0x00); // QTFILE

    // Tgetattr fid 1
    const gaFrame = await server.handle(buildReq(T.getattr, 3, ["w", "d"], [1, 0x3fff]));
    r = replyHeader(gaFrame);
    expect(r.type).toBe(T.getattr + 1);
    const ga = Unmarshall(["d", "Q", "w", "w", "w", "d", "d", "d"], gaFrame, r.state) as number[];
    const gaQid = ga[1] as unknown as Qid;
    const mode = ga[2] as number;
    const sizeField = ga[7] as number;
    expect(gaQid.type).toBe(0x00);
    expect(mode & 0o170000).toBe(0o100000); // S_IFREG
    expect(sizeField).toBe(content.length);

    // Tlopen fid 1
    r = replyHeader(await server.handle(buildReq(T.lopen, 4, ["w", "w"], [1, 0])));
    expect(r.type).toBe(T.lopen + 1);

    // Tread fid 1, offset 0, count 8192
    const readFrame = await server.handle(buildReq(T.read, 5, ["w", "d", "w"], [1, 0, 8192]));
    r = replyHeader(readFrame);
    expect(r.type).toBe(T.read + 1);
    const [count] = Unmarshall(["w"], readFrame, r.state) as [number];
    expect(count).toBe(content.length);
    const data = readFrame.subarray(r.state.offset, r.state.offset + count);
    expect(new TextDecoder().decode(data)).toBe(content);

    // Tclunk fid 1
    r = replyHeader(await server.handle(buildReq(T.clunk, 6, ["w"], [1])));
    expect(r.type).toBe(T.clunk + 1);
  });

  it("returns Rlerror(ENOENT) walking a missing file", async () => {
    const vfs = uniqueVfs();
    await vfs.mkdir("/work");
    const server = new Vfs9pServer({ vfs, root: "/work" });
    await server.handle(buildReq(T.attach, 1, ["w", "w", "s", "s", "w"], [0, 0xffffffff, "root", "", 0]));
    const frame = await server.handle(buildReq(T.walk, 2, ["w", "w", "h", "s"], [0, 1, 1, "nope.txt"]));
    const r = replyHeader(frame);
    expect(r.type).toBe(7); // Rlerror
    const [errno] = Unmarshall(["w"], frame, r.state) as [number];
    expect(errno).toBe(2); // ENOENT
  });

  it("write-back: guest write is visible in the shared VFS", async () => {
    const vfs = uniqueVfs();
    await vfs.mkdir("/work");
    await vfs.writeFile("/work/out.txt", "");
    const server = new Vfs9pServer({ vfs, root: "/work" });
    await server.handle(buildReq(T.attach, 1, ["w", "w", "s", "s", "w"], [0, 0xffffffff, "root", "", 0]));
    await server.handle(buildReq(T.walk, 2, ["w", "w", "h", "s"], [0, 1, 1, "out.txt"]));
    await server.handle(buildReq(T.lopen, 3, ["w", "w"], [1, 0]));
    // Twrite fid 1, offset 0, count N, then raw data bytes.
    const payload = new TextEncoder().encode("written-by-guest");
    const buf = new Uint8Array(64 + payload.length);
    let bodySize = Marshall(["w", "d", "w"], [1, 0, payload.length], buf, 7);
    buf.set(payload, 7 + bodySize);
    bodySize += payload.length;
    Marshall(["w", "b", "h"], [bodySize + 7, T.write, 4], buf, 0);
    const wframe = await server.handle(buf.slice(0, bodySize + 7));
    const r = replyHeader(wframe);
    expect(r.type).toBe(T.write + 1);
    const [count] = Unmarshall(["w"], wframe, r.state) as [number];
    expect(count).toBe(payload.length);
    expect(await vfs.readFileText("/work/out.txt")).toBe("written-by-guest");
  });

  it("readdir lists directory children (incl. . and ..)", async () => {
    const vfs = uniqueVfs();
    await vfs.mkdir("/work");
    await vfs.writeFile("/work/a.txt", "a");
    await vfs.writeFile("/work/b.txt", "b");
    const server = new Vfs9pServer({ vfs, root: "/work" });
    await server.handle(buildReq(T.attach, 1, ["w", "w", "s", "s", "w"], [0, 0xffffffff, "root", "", 0]));
    await server.handle(buildReq(T.lopen, 2, ["w", "w"], [0, 0]));
    const frame = await server.handle(buildReq(T.readdir, 3, ["w", "d", "w"], [0, 0, 8192]));
    const r = replyHeader(frame);
    expect(r.type).toBe(T.readdir + 1);
    const [count] = Unmarshall(["w"], frame, r.state) as [number];
    // Decode dirents: qid[13] offset[8] type[1] name[s]
    const names: string[] = [];
    const s = { offset: r.state.offset };
    const end = r.state.offset + count;
    while (s.offset < end) {
      Unmarshall(["Q", "d", "b"], frame, s); // qid, cookie, dtype
      const [name] = Unmarshall(["s"], frame, s) as [string];
      names.push(name);
    }
    expect(names).toContain(".");
    expect(names).toContain("..");
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });
});
