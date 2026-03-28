// Minimal 9P2000.L server for handle9p callback.
// Serves a read-only filesystem from fs.json + flat/ (v86 basefs format).
// This is a prototype to validate the handle9p plumbing before building SRPC.

const textenc = new TextEncoder();
const textdec = new TextDecoder();

// 9P2000.L message types
const TVERSION = 100, RVERSION = 101;
const TATTACH = 104, RATTACH = 105;
const RERROR = 107;
const TWALK = 110, RWALK = 111;
const TLOPEN = 12, RLOPEN = 13;
const TREADLINK = 22, RREADLINK = 23;
const TGETATTR = 24, RGETATTR = 25;
const TREADDIR = 40, RREADDIR = 41;
const TREAD = 116, RREAD = 117;
const TCLUNK = 120, RCLUNK = 121;
const TSTATFS = 8, RSTATFS = 9;

// Error codes
const ENOENT = 2;
const ENOTDIR = 20;
const EOPNOTSUPP = 95;

// QID types
const QID_DIR = 0x80;
const QID_SYMLINK = 0x02;
const QID_FILE = 0x00;

// S_IFMT mask and types
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

// d_type values for readdir
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;
const DT_CHR = 2;

// Simple binary reader/writer
function readU32(buf, off) {
  return buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24);
}
function readU16(buf, off) {
  return buf[off] | (buf[off+1] << 8);
}
function readU8(buf, off) {
  return buf[off];
}
function readStr(buf, off) {
  const len = readU16(buf, off);
  return textdec.decode(buf.subarray(off + 2, off + 2 + len));
}
function strLen(buf, off) {
  return 2 + readU16(buf, off);
}

function writeU32(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off+1] = (v >> 8) & 0xff;
  buf[off+2] = (v >> 16) & 0xff;
  buf[off+3] = (v >> 24) & 0xff;
}
function writeU16(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off+1] = (v >> 8) & 0xff;
}
function writeU64(buf, off, lo, hi) {
  writeU32(buf, off, lo);
  writeU32(buf, off + 4, hi || 0);
}
function writeStr(buf, off, s) {
  const enc = textenc.encode(s);
  writeU16(buf, off, enc.length);
  buf.set(enc, off + 2);
  return 2 + enc.length;
}
function writeQid(buf, off, type, version, pathId) {
  buf[off] = type;
  writeU32(buf, off + 1, version);
  writeU64(buf, off + 5, pathId, 0);
  return 13;
}

function makeReply(id, tag, payload) {
  const size = 4 + 1 + 2 + payload.length;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf[4] = id;
  writeU16(buf, 5, tag);
  buf.set(payload, 7);
  return buf;
}

function makeError(tag, errno) {
  const p = new Uint8Array(4);
  writeU32(p, 0, errno);
  return makeReply(RERROR, tag, p);
}

function modeToQidType(mode) {
  const fmt = mode & S_IFMT;
  if (fmt === S_IFDIR) return QID_DIR;
  if (fmt === S_IFLNK) return QID_SYMLINK;
  return QID_FILE;
}

function modeToDtype(mode) {
  const fmt = mode & S_IFMT;
  if (fmt === S_IFDIR) return DT_DIR;
  if (fmt === S_IFLNK) return DT_LNK;
  if (fmt === S_IFREG) return DT_REG;
  return DT_CHR; // device nodes, etc.
}

// fs.json basefs format: {"fsroot": [[name, size, mtime, mode, uid, gid, data?], ...]}
// data is: array -> dir children, string ending ".bin" -> file ref, string -> symlink, absent -> device
export async function createHandle9p(fsJsonUrl, baseUrl) {
  const resp = await fetch(fsJsonUrl);
  const fsJson = await resp.json();
  const fsRoot = fsJson.fsroot || fsJson;

  // Build inode table from basefs entries
  let nextIno = 1;
  // ino -> { name, mode, size, mtime, uid, gid, sha256, symlink, children: Map<name,ino>, parent, ino }
  const inodes = new Map();

  function buildTree(entries, parentIno) {
    const children = new Map();
    for (const entry of entries) {
      const name = entry[0];
      const size = entry[1] || 0;
      const mtime = entry[2] || 0;
      const mode = entry[3] || 0;
      const uid = entry[4] || 0;
      const gid = entry[5] || 0;
      const data = entry[6];
      const ino = nextIno++;
      if (Array.isArray(data)) {
        // Directory
        const node = { name, mode, size: 0, mtime, uid, gid, sha256: null, symlink: null, children: null, parent: parentIno, ino };
        inodes.set(ino, node);
        node.children = buildTree(data, ino);
        children.set(name, ino);
      } else if (typeof data === "string" && data.endsWith(".bin")) {
        // Regular file with content reference
        inodes.set(ino, { name, mode, size, mtime, uid, gid, sha256: data, symlink: null, children: null, parent: parentIno, ino });
        children.set(name, ino);
      } else if (typeof data === "string") {
        // Symlink
        inodes.set(ino, { name, mode: mode || (S_IFLNK | 0o777), size: data.length, mtime, uid, gid, sha256: null, symlink: data, children: null, parent: parentIno, ino });
        children.set(name, ino);
      } else {
        // Device node or empty file
        inodes.set(ino, { name, mode, size: 0, mtime, uid, gid, sha256: null, symlink: null, children: null, parent: parentIno, ino });
        children.set(name, ino);
      }
    }
    return children;
  }

  const rootIno = 0;
  const rootChildren = buildTree(fsRoot, rootIno);
  inodes.set(rootIno, {
    name: "/", mode: S_IFDIR | 0o755, size: 0, mtime: 0, uid: 0, gid: 0,
    sha256: null, symlink: null, children: rootChildren, parent: rootIno, ino: rootIno
  });

  console.log("handle9p: built " + inodes.size + " inodes");

  // FID tracking
  const fids = new Map(); // fid -> ino

  // File content cache
  const contentCache = new Map(); // sha256 -> Uint8Array

  async function fetchContent(node) {
    if (!node.sha256) return new Uint8Array(0);
    if (contentCache.has(node.sha256)) return contentCache.get(node.sha256);
    const url = baseUrl + node.sha256;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("fetch " + url + ": " + resp.status);
    const data = new Uint8Array(await resp.arrayBuffer());
    contentCache.set(node.sha256, data);
    return data;
  }

  function getNode(ino) {
    return inodes.get(ino);
  }

  function walkPath(startIno, names) {
    let ino = startIno;
    const qids = [];
    for (const name of names) {
      const node = getNode(ino);
      if (!node || modeToQidType(node.mode) !== QID_DIR || !node.children) return null;
      if (name === "..") {
        ino = node.parent;
      } else if (name === ".") {
        // stay
      } else {
        const childIno = node.children.get(name);
        if (childIno === undefined) return null;
        ino = childIno;
      }
      const target = getNode(ino);
      qids.push({ type: modeToQidType(target.mode), version: 0, path: ino });
    }
    return { ino, qids };
  }

  // The handle9p callback
  return function handle9p(reqbuf, reply) {
    const id = readU8(reqbuf, 4);
    const tag = readU16(reqbuf, 5);
    const body = reqbuf.subarray(7);

    switch (id) {
      case TVERSION: {
        const msize = readU32(body, 0);
        const rmsize = Math.min(msize, 65536);
        const rver = textenc.encode("9P2000.L");
        const p = new Uint8Array(4 + 2 + rver.length);
        writeU32(p, 0, rmsize);
        writeU16(p, 4, rver.length);
        p.set(rver, 6);
        reply(makeReply(RVERSION, tag, p));
        break;
      }

      case TATTACH: {
        const fid = readU32(body, 0);
        fids.set(fid, rootIno);
        const p = new Uint8Array(13);
        writeQid(p, 0, QID_DIR, 0, rootIno);
        reply(makeReply(RATTACH, tag, p));
        break;
      }

      case TWALK: {
        const fid = readU32(body, 0);
        const newfid = readU32(body, 4);
        const nwname = readU16(body, 8);
        const names = [];
        let off = 10;
        for (let i = 0; i < nwname; i++) {
          names.push(readStr(body, off));
          off += strLen(body, off);
        }

        const startIno = fids.get(fid);
        if (startIno === undefined) { reply(makeError(tag, ENOENT)); break; }

        if (nwname === 0) {
          fids.set(newfid, startIno);
          const p = new Uint8Array(2);
          writeU16(p, 0, 0);
          reply(makeReply(RWALK, tag, p));
          break;
        }

        const result = walkPath(startIno, names);
        if (!result) { reply(makeError(tag, ENOENT)); break; }

        fids.set(newfid, result.ino);
        const p = new Uint8Array(2 + result.qids.length * 13);
        writeU16(p, 0, result.qids.length);
        for (let i = 0; i < result.qids.length; i++) {
          const q = result.qids[i];
          writeQid(p, 2 + i * 13, q.type, q.version, q.path);
        }
        reply(makeReply(RWALK, tag, p));
        break;
      }

      case TLOPEN: {
        const fid = readU32(body, 0);
        const ino = fids.get(fid);
        if (ino === undefined) { reply(makeError(tag, ENOENT)); break; }
        const node = getNode(ino);
        const p = new Uint8Array(13 + 4);
        writeQid(p, 0, modeToQidType(node.mode), 0, ino);
        writeU32(p, 13, 65536); // iounit
        reply(makeReply(RLOPEN, tag, p));
        break;
      }

      case TREADLINK: {
        const fid = readU32(body, 0);
        const ino = fids.get(fid);
        if (ino === undefined) { reply(makeError(tag, ENOENT)); break; }
        const node = getNode(ino);
        if (!node.symlink) { reply(makeError(tag, ENOENT)); break; }
        const target = textenc.encode(node.symlink);
        const p = new Uint8Array(2 + target.length);
        writeU16(p, 0, target.length);
        p.set(target, 2);
        reply(makeReply(RREADLINK, tag, p));
        break;
      }

      case TGETATTR: {
        const fid = readU32(body, 0);
        const ino = fids.get(fid);
        if (ino === undefined) { reply(makeError(tag, ENOENT)); break; }
        const node = getNode(ino);
        const qtype = modeToQidType(node.mode);
        const isDir = qtype === QID_DIR;
        // rgetattr: valid(8) + qid(13) + mode(4) + uid(4) + gid(4) +
        //   nlink(8) + rdev(8) + size(8) + blksize(8) + blocks(8) +
        //   atime_sec(8) + atime_nsec(8) + mtime_sec(8) + mtime_nsec(8) +
        //   ctime_sec(8) + ctime_nsec(8) + btime_sec(8) + btime_nsec(8) +
        //   gen(8) + data_version(8)
        const p = new Uint8Array(8 + 13 + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8*8 + 8 + 8);
        let o = 0;
        writeU64(p, o, 0x7ff, 0); o += 8; // valid: all fields
        writeQid(p, o, qtype, 0, ino); o += 13;
        writeU32(p, o, node.mode); o += 4; // mode (from fs.json)
        writeU32(p, o, node.uid); o += 4; // uid
        writeU32(p, o, node.gid); o += 4; // gid
        writeU64(p, o, isDir ? 2 : 1); o += 8; // nlink
        writeU64(p, o, 0); o += 8; // rdev
        writeU64(p, o, node.size); o += 8; // size
        writeU64(p, o, 4096); o += 8; // blksize
        writeU64(p, o, Math.ceil(node.size / 512)); o += 8; // blocks
        // atime
        writeU64(p, o, node.mtime); o += 8;
        writeU64(p, o, 0); o += 8;
        // mtime
        writeU64(p, o, node.mtime); o += 8;
        writeU64(p, o, 0); o += 8;
        // ctime
        writeU64(p, o, node.mtime); o += 8;
        writeU64(p, o, 0); o += 8;
        // btime
        writeU64(p, o, 0); o += 8;
        writeU64(p, o, 0); o += 8;
        writeU64(p, o, 0); o += 8; // gen
        writeU64(p, o, 0); o += 8; // data_version
        reply(makeReply(RGETATTR, tag, p));
        break;
      }

      case TREADDIR: {
        const fid = readU32(body, 0);
        const offset_lo = readU32(body, 4);
        const count = readU32(body, 12);
        const ino = fids.get(fid);
        if (ino === undefined) { reply(makeError(tag, ENOENT)); break; }
        const node = getNode(ino);
        if (modeToQidType(node.mode) !== QID_DIR) { reply(makeError(tag, ENOTDIR)); break; }

        // Build directory entries
        const entries = [];
        if (node.children) {
          let idx = 0;
          for (const [name, childIno] of node.children) {
            if (idx >= offset_lo) {
              const child = getNode(childIno);
              entries.push({ name, qid_type: modeToQidType(child.mode), dtype: modeToDtype(child.mode), ino: childIno, offset: idx + 1 });
            }
            idx++;
          }
        }

        // Serialize entries into buffer
        const parts = [];
        let totalSize = 0;
        for (const entry of entries) {
          const nameBytes = textenc.encode(entry.name);
          // qid(13) + offset(8) + type(1) + name_len(2) + name
          const entrySize = 13 + 8 + 1 + 2 + nameBytes.length;
          if (totalSize + entrySize > count) break;
          const ebuf = new Uint8Array(entrySize);
          let eo = 0;
          writeQid(ebuf, eo, entry.qid_type, 0, entry.ino); eo += 13;
          writeU64(ebuf, eo, entry.offset); eo += 8;
          ebuf[eo] = entry.dtype; eo += 1;
          writeU16(ebuf, eo, nameBytes.length); eo += 2;
          ebuf.set(nameBytes, eo);
          parts.push(ebuf);
          totalSize += entrySize;
        }

        const p = new Uint8Array(4 + totalSize);
        writeU32(p, 0, totalSize);
        let poff = 4;
        for (const part of parts) {
          p.set(part, poff);
          poff += part.length;
        }
        reply(makeReply(RREADDIR, tag, p));
        break;
      }

      case TREAD: {
        const fid = readU32(body, 0);
        const offset_lo = readU32(body, 4);
        const count = readU32(body, 12);
        const ino = fids.get(fid);
        if (ino === undefined) { reply(makeError(tag, ENOENT)); break; }
        const node = getNode(ino);

        fetchContent(node).then(data => {
          const offset = offset_lo; // ignore hi for files < 4GB
          const end = Math.min(offset + count, data.length);
          const chunk = data.subarray(offset, end);
          const p = new Uint8Array(4 + chunk.length);
          writeU32(p, 0, chunk.length);
          p.set(chunk, 4);
          reply(makeReply(RREAD, tag, p));
        }).catch(err => {
          console.error("handle9p: TREAD fetch failed:", err);
          reply(makeError(tag, 5)); // EIO
        });
        break;
      }

      case TCLUNK: {
        const fid = readU32(body, 0);
        fids.delete(fid);
        reply(makeReply(RCLUNK, tag, new Uint8Array(0)));
        break;
      }

      case TSTATFS: {
        // Return dummy statfs
        // type(4) + bsize(4) + blocks(8) + bfree(8) + bavail(8) + files(8) + ffree(8) + fsid(8) + namelen(4) = 60
        const p = new Uint8Array(60);
        let o = 0;
        writeU32(p, o, 0x01021997); o += 4; // type: V9FS_MAGIC
        writeU32(p, o, 4096); o += 4; // bsize
        writeU64(p, o, 1000000); o += 8; // blocks
        writeU64(p, o, 500000); o += 8; // bfree
        writeU64(p, o, 500000); o += 8; // bavail
        writeU64(p, o, inodes.size); o += 8; // files
        writeU64(p, o, 100000); o += 8; // ffree
        writeU64(p, o, 0); o += 8; // fsid
        writeU32(p, o, 255); // namelen
        reply(makeReply(RSTATFS, tag, p));
        break;
      }

      case 30: // Txattrwalk
      case 32: // Txattrcreate
      case 26: // Tsetattr
      {
        // xattr and setattr not supported on read-only fs
        reply(makeError(tag, EOPNOTSUPP));
        break;
      }

      case 108: { // Tflush
        // Rflush has empty body
        reply(makeReply(109, tag, new Uint8Array(0)));
        break;
      }

      default: {
        console.warn("handle9p: unhandled message type", id);
        reply(makeError(tag, EOPNOTSUPP));
        break;
      }
    }
  };
}
