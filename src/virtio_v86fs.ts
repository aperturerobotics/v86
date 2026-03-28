// VirtioV86FS: custom virtio device for v86fs guest filesystem
// PCI device ID 0x107F (virtio type 63, last slot in modern range)
// Three virtqueues: hipriq (metadata), requestq (data), notifyq (push invalidation)

import { LOG_PCI } from './const.js'
import { dbg_log } from './log.js'
import { VirtIO, VIRTIO_F_VERSION_1 } from './virtio.js'
import { BusConnector } from './bus.js'

interface VirtioV86FSCPU {
    io: {
        register_read(
            port: number,
            device: object,
            r8?: ((port: number) => number) | undefined,
            r16?: ((port: number) => number) | undefined,
            r32?: ((port: number) => number) | undefined,
        ): void
        register_write(
            port: number,
            device: object,
            w8?: ((port: number) => void) | undefined,
            w16?: ((port: number) => void) | undefined,
            w32?: ((port: number) => void) | undefined,
        ): void
    }
    devices: {
        pci: {
            register_device(device: VirtIO): void
            raise_irq(pci_id: number): void
            lower_irq(pci_id: number): void
        }
    }
    read16(addr: number): number
    read32s(addr: number): number
    write16(addr: number, value: number): void
    write32(addr: number, value: number): void
    read_blob(addr: number, length: number): Uint8Array
    write_blob(blob: Uint8Array, addr: number): void
    zero_memory(addr: number, length: number): void
    memory_size: Int32Array
}

// Protocol message types
const V86FS_MSG_MOUNT = 0x00
const V86FS_MSG_LOOKUP = 0x01
const V86FS_MSG_GETATTR = 0x02
const V86FS_MSG_READDIR = 0x03
const V86FS_MSG_OPEN = 0x04
const V86FS_MSG_CLOSE = 0x05
const V86FS_MSG_READ = 0x06
const V86FS_MSG_CREATE = 0x07
const V86FS_MSG_WRITE = 0x08
const V86FS_MSG_MKDIR = 0x09
const V86FS_MSG_SETATTR = 0x0a
const V86FS_MSG_FSYNC = 0x0b
const V86FS_MSG_UNLINK = 0x0c
const V86FS_MSG_RENAME = 0x0d
const V86FS_MSG_SYMLINK = 0x0e
const V86FS_MSG_READLINK = 0x0f
const V86FS_MSG_STATFS = 0x10
const V86FS_MSG_INVALIDATE = 0x20
const V86FS_MSG_INVALIDATE_DIR = 0x21

// Response types
const V86FS_MSG_MOUNT_R = 0x80
const V86FS_MSG_LOOKUP_R = 0x81
const V86FS_MSG_GETATTR_R = 0x82
const V86FS_MSG_READDIR_R = 0x83
const V86FS_MSG_OPEN_R = 0x84
const V86FS_MSG_CLOSE_R = 0x85
const V86FS_MSG_READ_R = 0x86
const V86FS_MSG_CREATE_R = 0x87
const V86FS_MSG_WRITE_R = 0x88
const V86FS_MSG_MKDIR_R = 0x89
const V86FS_MSG_SETATTR_R = 0x8a
const V86FS_MSG_FSYNC_R = 0x8b
const V86FS_MSG_UNLINK_R = 0x8c
const V86FS_MSG_RENAME_R = 0x8d
const V86FS_MSG_SYMLINK_R = 0x8e
const V86FS_MSG_READLINK_R = 0x8f
const V86FS_MSG_STATFS_R = 0x90
const _V86FS_MSG_ERROR_R = 0xff

// ATTR_* valid mask bits (matching Linux)
const ATTR_MODE = 1
const ATTR_SIZE = 8

// Status codes
const V86FS_STATUS_OK = 0
const V86FS_STATUS_ENOENT = 2

// DT_* types (matching Linux dirent.h)
const DT_DIR = 4
const DT_REG = 8
const DT_LNK = 10

// S_IF* mode bits
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

interface FsEntry {
    inode_id: number
    name: string
    mode: number
    size: number
    dt_type: number
    mtime_sec: number
    mtime_nsec: number
    content?: Uint8Array
    symlink_target?: string
}

// Hardcoded test filesystem: root dir (inode 1) with two entries
export const FS_ENTRIES: Map<number, FsEntry[]> = new Map([
    [
        1,
        [
            {
                inode_id: 2,
                name: 'hello.txt',
                mode: S_IFREG | 0o644,
                size: 12,
                dt_type: DT_REG,
                mtime_sec: 1711500000,
                mtime_nsec: 0,
                content: textEncoder.encode('hello world\n'),
            },
            {
                inode_id: 3,
                name: 'subdir',
                mode: S_IFDIR | 0o755,
                size: 0,
                dt_type: DT_DIR,
                mtime_sec: 1711500000,
                mtime_nsec: 0,
            },
        ],
    ],
])

// Inode lookup map built from FS_ENTRIES (includes root dir)
export const INODE_MAP: Map<number, FsEntry> = new Map([
    [
        1,
        {
            inode_id: 1,
            name: '',
            mode: S_IFDIR | 0o755,
            size: 0,
            dt_type: DT_DIR,
            mtime_sec: 1711500000,
            mtime_nsec: 0,
        },
    ],
])
for (const entries of FS_ENTRIES.values()) {
    for (const e of entries) {
        INODE_MAP.set(e.inode_id, e)
    }
}

// Header size: 4B length + 1B type + 2B tag
const V86FS_HDR_SIZE = 7

const _VIRTIO_V86FS_QUEUE_HIPRIQ = 0
const _VIRTIO_V86FS_QUEUE_REQUESTQ = 1
const _VIRTIO_V86FS_QUEUE_NOTIFYQ = 2

function packU32(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff
    buf[offset + 1] = (val >>> 8) & 0xff
    buf[offset + 2] = (val >>> 16) & 0xff
    buf[offset + 3] = (val >>> 24) & 0xff
}

function packU64(buf: Uint8Array, offset: number, val: number): void {
    packU32(buf, offset, val)
    packU32(buf, offset + 4, 0)
}

function packU16(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff
    buf[offset + 1] = (val >>> 8) & 0xff
}

function makeResp(size: number, type: number, tag: number): Uint8Array {
    const resp = new Uint8Array(size)
    packU32(resp, 0, size)
    resp[4] = type
    resp[5] = tag & 0xff
    resp[6] = (tag >> 8) & 0xff
    return resp
}

function readU32(buf: Uint8Array, offset: number): number {
    return (
        buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        ((buf[offset + 3] << 24) >>> 0)
    )
}

function readU16(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8)
}

function readU64(buf: Uint8Array, offset: number): number {
    return (
        buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (((buf[offset + 3] << 24) >>> 0) +
            (buf[offset + 4] |
                (buf[offset + 5] << 8) |
                (buf[offset + 6] << 16) |
                ((buf[offset + 7] << 24) >>> 0)) *
                0x100000000)
    )
}

export class VirtioV86FS {
    bus: BusConnector
    virtio: VirtIO
    next_handle_id: number
    next_inode_id: number
    open_handles: Map<number, number> // handle_id -> inode_id
    read_count: number

    constructor(cpu: VirtioV86FSCPU, bus: BusConnector) {
        this.bus = bus
        this.next_handle_id = 1
        this.next_inode_id = 100
        this.open_handles = new Map()
        this.read_count = 0

        const queues = [
            // Queue 0: hipriq - high-priority metadata (LOOKUP, GETATTR)
            { size_supported: 128, notify_offset: 0 },
            // Queue 1: requestq - data requests (READ, WRITE, READDIR)
            { size_supported: 128, notify_offset: 1 },
            // Queue 2: notifyq - host-to-guest push invalidation
            { size_supported: 128, notify_offset: 2 },
        ]

        this.virtio = new VirtIO(cpu, {
            name: 'virtio-v86fs',
            pci_id: 0x0e << 3,
            device_id: 0x107f,
            subsystem_device_id: 63,
            common: {
                initial_port: 0xf800,
                queues: queues,
                features: [VIRTIO_F_VERSION_1],
                on_driver_ok: () => {
                    console.log('v86fs: driver ok')
                    this.bus.send('virtio-v86fs-driver-ok')
                },
            },
            notification: {
                initial_port: 0xf900,
                single_handler: false,
                handlers: [
                    // Queue 0: hipriq
                    (queue_id: number) => {
                        this.handle_queue(queue_id)
                    },
                    // Queue 1: requestq
                    (queue_id: number) => {
                        this.handle_queue(queue_id)
                    },
                    // Queue 2: notifyq
                    (_queue_id: number) => {
                        dbg_log('v86fs: notifyq notification', LOG_PCI)
                    },
                ],
            },
            isr_status: {
                initial_port: 0xf700,
            },
        })
    }

    handle_queue(queue_id: number): void {
        const queue = this.virtio.queues[queue_id]
        while (queue.has_request()) {
            const bufchain = queue.pop_request()
            const req = new Uint8Array(bufchain.length_readable)
            bufchain.get_next_blob(req)

            const resp = this.handle_message(req)
            if (resp && bufchain.length_writable > 0) {
                bufchain.set_next_blob(resp)
            }

            queue.push_reply(bufchain)
        }
        queue.flush_replies()
    }

    handle_message(req: Uint8Array): Uint8Array | null {
        if (req.length < V86FS_HDR_SIZE) {
            console.warn('v86fs: message too short:', req.length)
            return null
        }

        const type = req[4]
        const tag = readU16(req, 5)

        switch (type) {
            case V86FS_MSG_MOUNT:
                return this.handle_mount(req, tag)
            case V86FS_MSG_LOOKUP:
                return this.handle_lookup(req, tag)
            case V86FS_MSG_GETATTR:
                return this.handle_getattr(req, tag)
            case V86FS_MSG_READDIR:
                return this.handle_readdir(req, tag)
            case V86FS_MSG_OPEN:
                return this.handle_open(req, tag)
            case V86FS_MSG_CLOSE:
                return this.handle_close(req, tag)
            case V86FS_MSG_READ:
                return this.handle_read(req, tag)
            case V86FS_MSG_CREATE:
                return this.handle_create(req, tag)
            case V86FS_MSG_WRITE:
                return this.handle_write(req, tag)
            case V86FS_MSG_MKDIR:
                return this.handle_mkdir(req, tag)
            case V86FS_MSG_SETATTR:
                return this.handle_setattr(req, tag)
            case V86FS_MSG_FSYNC:
                return this.handle_fsync(req, tag)
            case V86FS_MSG_UNLINK:
                return this.handle_unlink(req, tag)
            case V86FS_MSG_RENAME:
                return this.handle_rename(req, tag)
            case V86FS_MSG_SYMLINK:
                return this.handle_symlink(req, tag)
            case V86FS_MSG_READLINK:
                return this.handle_readlink(req, tag)
            case V86FS_MSG_STATFS:
                return this.handle_statfs(tag)
            default:
                console.warn('v86fs: unknown message type:', type)
                return null
        }
    }

    handle_mount(req: Uint8Array, tag: number): Uint8Array {
        // Parse MOUNT: [7B hdr] [2B name_len] [name...]
        const name_len = readU16(req, 7)
        const name =
            name_len > 0
                ? textDecoder.decode(req.subarray(9, 9 + name_len))
                : ''

        console.log('v86fs: mount:', name || '(default)')

        // Emit bus event so host adapter can resolve the name
        this.bus.send('virtio-v86fs-mount', name)

        // Build MOUNT_R: [7B hdr] [4B status=0] [8B root_id=1] [4B mode=0x41ED]
        // 0x41ED = S_IFDIR | 0755
        const resp = new Uint8Array(23)
        packU32(resp, 0, 23) // length
        resp[4] = V86FS_MSG_MOUNT_R // type
        resp[5] = tag & 0xff // tag low
        resp[6] = (tag >> 8) & 0xff // tag high
        packU32(resp, 7, 0) // status = 0 (success)
        packU64(resp, 11, 1) // root_inode_id = 1
        packU32(resp, 19, 0x41ed) // mode = S_IFDIR | 0755

        return resp
    }

    handle_getattr(req: Uint8Array, tag: number): Uint8Array {
        // Parse GETATTR: [7B hdr] [8B inode_id]
        const inode_id = readU64(req, 7)
        const entry = INODE_MAP.get(inode_id)

        // GETATTR_R: [7B hdr] [4B status] [4B mode] [8B size] [8B mtime_sec] [4B mtime_nsec]
        const resp = makeResp(35, V86FS_MSG_GETATTR_R, tag)

        if (!entry) {
            packU32(resp, 7, V86FS_STATUS_ENOENT)
            return resp
        }

        packU32(resp, 7, V86FS_STATUS_OK)
        packU32(resp, 11, entry.mode)
        packU64(resp, 15, entry.size)
        packU64(resp, 23, entry.mtime_sec)
        packU32(resp, 31, entry.mtime_nsec)
        return resp
    }

    handle_lookup(req: Uint8Array, tag: number): Uint8Array {
        // Parse LOOKUP: [7B hdr] [8B parent_id] [2B name_len] [name...]
        const parent_id = readU64(req, 7)
        const name_len = readU16(req, 15)
        const name = textDecoder.decode(req.subarray(17, 17 + name_len))

        const entries = FS_ENTRIES.get(parent_id)
        const entry = entries?.find((e) => e.name === name)

        // LOOKUP_R: [7B hdr] [4B status] [8B inode_id] [4B mode] [8B size]
        const resp = new Uint8Array(31)
        packU32(resp, 0, 31) // length
        resp[4] = V86FS_MSG_LOOKUP_R
        resp[5] = tag & 0xff
        resp[6] = (tag >> 8) & 0xff

        if (!entry) {
            packU32(resp, 7, V86FS_STATUS_ENOENT)
            return resp
        }

        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, entry.inode_id)
        packU32(resp, 19, entry.mode)
        packU64(resp, 23, entry.size)
        return resp
    }

    handle_readdir(req: Uint8Array, tag: number): Uint8Array {
        // Parse READDIR: [7B hdr] [8B dir_id]
        const dir_id = readU64(req, 7)
        const entries = FS_ENTRIES.get(dir_id) || []

        // Pre-encode names to avoid double encoding
        const encodedNames = entries.map((e) => textEncoder.encode(e.name))

        // READDIR_R: [7B hdr] [4B status] [4B count] [entries...]
        // Each entry: [8B inode_id] [1B type] [2B name_len] [name...]
        let size = 7 + 4 + 4
        for (const nameBytes of encodedNames) {
            size += 8 + 1 + 2 + nameBytes.length
        }

        const resp = makeResp(size, V86FS_MSG_READDIR_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU32(resp, 11, entries.length)

        let off = 15
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            const nameBytes = encodedNames[i]
            packU64(resp, off, e.inode_id)
            resp[off + 8] = e.dt_type
            packU16(resp, off + 9, nameBytes.length)
            resp.set(nameBytes, off + 11)
            off += 11 + nameBytes.length
        }

        return resp
    }

    handle_open(req: Uint8Array, tag: number): Uint8Array {
        // Parse OPEN: [7B hdr] [8B inode_id] [4B flags]
        const inode_id = readU64(req, 7)
        const handle_id = this.next_handle_id++
        this.open_handles.set(handle_id, inode_id)

        this.bus.send('virtio-v86fs-open', inode_id)

        // OPEN_R: [7B hdr] [4B status] [8B handle_id]
        const resp = makeResp(19, V86FS_MSG_OPEN_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, handle_id)
        return resp
    }

    handle_close(req: Uint8Array, tag: number): Uint8Array {
        // Parse CLOSE: [7B hdr] [8B handle_id]
        const handle_id = readU64(req, 7)
        this.open_handles.delete(handle_id)

        this.bus.send('virtio-v86fs-close', handle_id)

        // CLOSE_R: [7B hdr] [4B status]
        const resp = makeResp(11, V86FS_MSG_CLOSE_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        return resp
    }

    handle_read(req: Uint8Array, tag: number): Uint8Array {
        // Parse READ: [7B hdr] [8B handle_id] [8B offset] [4B size]
        const handle_id = readU64(req, 7)
        const offset = readU64(req, 15)
        const size = readU32(req, 23)

        const inode_id = this.open_handles.get(handle_id) ?? handle_id
        const entry = INODE_MAP.get(inode_id)
        const content = entry?.content

        this.read_count++
        this.bus.send('virtio-v86fs-read', {
            handle_id,
            inode_id,
            offset,
            size,
        })

        if (!content || offset >= content.length) {
            // EOF or no content
            const resp = makeResp(15, V86FS_MSG_READ_R, tag)
            packU32(resp, 7, V86FS_STATUS_OK)
            packU32(resp, 11, 0) // 0 bytes read
            return resp
        }

        const start = Math.min(offset, content.length)
        const end = Math.min(start + size, content.length)
        const data = content.subarray(start, end)

        // READ_R: [7B hdr] [4B status] [4B bytes_read] [data...]
        const resp = new Uint8Array(15 + data.length)
        packU32(resp, 0, 15 + data.length)
        resp[4] = V86FS_MSG_READ_R
        resp[5] = tag & 0xff
        resp[6] = (tag >> 8) & 0xff
        packU32(resp, 7, V86FS_STATUS_OK)
        packU32(resp, 11, data.length)
        resp.set(data, 15)
        return resp
    }

    handle_create(req: Uint8Array, tag: number): Uint8Array {
        // Parse CREATE: [7B hdr] [8B parent_id] [2B name_len] [name...] [4B mode]
        const parent_id = readU64(req, 7)
        const name_len = readU16(req, 15)
        const name = textDecoder.decode(req.subarray(17, 17 + name_len))
        const mode = readU32(req, 17 + name_len)

        const inode_id = this.next_inode_id++
        const entry: FsEntry = {
            inode_id,
            name,
            mode: mode | S_IFREG,
            size: 0,
            dt_type: DT_REG,
            mtime_sec: Math.floor(Date.now() / 1000),
            mtime_nsec: 0,
            content: new Uint8Array(0),
        }

        // Add to parent's entry list
        let children = FS_ENTRIES.get(parent_id)
        if (!children) {
            children = []
            FS_ENTRIES.set(parent_id, children)
        }
        children.push(entry)
        INODE_MAP.set(inode_id, entry)

        // CREATE_R: [7B hdr] [4B status] [8B inode_id] [4B mode]
        const resp = makeResp(23, V86FS_MSG_CREATE_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, inode_id)
        packU32(resp, 19, entry.mode)
        return resp
    }

    handle_write(req: Uint8Array, tag: number): Uint8Array {
        // Parse WRITE: [7B hdr] [8B inode_id] [8B offset] [4B size] [data...]
        const inode_id = readU64(req, 7)
        const offset = readU64(req, 15)
        const size = readU32(req, 23)
        const data = req.subarray(27, 27 + size)

        const entry = INODE_MAP.get(inode_id)
        if (entry) {
            // Grow content buffer if needed
            const needed = offset + size
            if (!entry.content || entry.content.length < needed) {
                const newContent = new Uint8Array(needed)
                if (entry.content) {
                    newContent.set(entry.content)
                }
                entry.content = newContent
            }
            entry.content.set(data, offset)
            if (needed > entry.size) {
                entry.size = needed
            }
        }

        // WRITE_R: [7B hdr] [4B status] [4B bytes_written]
        const resp = makeResp(15, V86FS_MSG_WRITE_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU32(resp, 11, size)
        return resp
    }

    handle_mkdir(req: Uint8Array, tag: number): Uint8Array {
        // Parse MKDIR: [7B hdr] [8B parent_id] [2B name_len] [name...] [4B mode]
        const parent_id = readU64(req, 7)
        const name_len = readU16(req, 15)
        const name = textDecoder.decode(req.subarray(17, 17 + name_len))
        const mode = readU32(req, 17 + name_len)

        const inode_id = this.next_inode_id++
        const entry: FsEntry = {
            inode_id,
            name,
            mode: mode | S_IFDIR,
            size: 0,
            dt_type: DT_DIR,
            mtime_sec: Math.floor(Date.now() / 1000),
            mtime_nsec: 0,
        }

        let children = FS_ENTRIES.get(parent_id)
        if (!children) {
            children = []
            FS_ENTRIES.set(parent_id, children)
        }
        children.push(entry)
        INODE_MAP.set(inode_id, entry)
        FS_ENTRIES.set(inode_id, []) // empty dir

        // MKDIR_R: [7B hdr] [4B status] [8B inode_id] [4B mode]
        const resp = makeResp(23, V86FS_MSG_MKDIR_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, inode_id)
        packU32(resp, 19, entry.mode)
        return resp
    }

    handle_setattr(req: Uint8Array, tag: number): Uint8Array {
        // Parse SETATTR: [7B hdr] [8B inode_id] [4B valid] [4B mode] [8B size]
        const inode_id = readU64(req, 7)
        const valid = readU32(req, 15)
        const mode = readU32(req, 19)
        const size = readU64(req, 23)

        const entry = INODE_MAP.get(inode_id)
        if (entry) {
            if (valid & ATTR_MODE) {
                entry.mode = (entry.mode & 0o170000) | (mode & 0o7777)
            }
            if (valid & ATTR_SIZE) {
                entry.size = size
                if (entry.content) {
                    if (size === 0) {
                        entry.content = new Uint8Array(0)
                    } else if (size < entry.content.length) {
                        entry.content = entry.content.subarray(0, size)
                    }
                }
            }
        }

        // SETATTR_R: [7B hdr] [4B status]
        const resp = makeResp(11, V86FS_MSG_SETATTR_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        return resp
    }

    handle_fsync(req: Uint8Array, tag: number): Uint8Array {
        // FSYNC is a no-op for the in-memory test FS
        const resp = makeResp(11, V86FS_MSG_FSYNC_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        return resp
    }

    handle_unlink(req: Uint8Array, tag: number): Uint8Array {
        // Parse UNLINK: [7B hdr] [8B parent_id] [2B name_len] [name...]
        const parent_id = readU64(req, 7)
        const name_len = readU16(req, 15)
        const name = textDecoder.decode(req.subarray(17, 17 + name_len))

        const children = FS_ENTRIES.get(parent_id)
        let status = V86FS_STATUS_ENOENT
        if (children) {
            const idx = children.findIndex((e) => e.name === name)
            if (idx >= 0) {
                const entry = children[idx]
                INODE_MAP.delete(entry.inode_id)
                FS_ENTRIES.delete(entry.inode_id)
                children.splice(idx, 1)
                status = V86FS_STATUS_OK
            }
        }

        const resp = makeResp(11, V86FS_MSG_UNLINK_R, tag)
        packU32(resp, 7, status)
        return resp
    }

    handle_rename(req: Uint8Array, tag: number): Uint8Array {
        // Parse RENAME: [7B hdr] [8B old_parent_id] [2B old_name_len] [old_name...]
        //               [8B new_parent_id] [2B new_name_len] [new_name...]
        let off = 7
        const old_parent_id = readU64(req, off)
        off += 8
        const old_name_len = readU16(req, off)
        off += 2
        const old_name = textDecoder.decode(
            req.subarray(off, off + old_name_len),
        )
        off += old_name_len
        const new_parent_id = readU64(req, off)
        off += 8
        const new_name_len = readU16(req, off)
        off += 2
        const new_name = textDecoder.decode(
            req.subarray(off, off + new_name_len),
        )

        let status = V86FS_STATUS_ENOENT
        const old_children = FS_ENTRIES.get(old_parent_id)
        if (old_children) {
            const idx = old_children.findIndex((e) => e.name === old_name)
            if (idx >= 0) {
                const entry = old_children[idx]
                old_children.splice(idx, 1)
                entry.name = new_name
                let new_children = FS_ENTRIES.get(new_parent_id)
                if (!new_children) {
                    new_children = []
                    FS_ENTRIES.set(new_parent_id, new_children)
                }
                // Remove any existing entry with new_name in target dir
                const existing = new_children.findIndex(
                    (e) => e.name === new_name,
                )
                if (existing >= 0) {
                    const old_entry = new_children[existing]
                    INODE_MAP.delete(old_entry.inode_id)
                    new_children.splice(existing, 1)
                }
                new_children.push(entry)
                status = V86FS_STATUS_OK
            }
        }

        const resp = makeResp(11, V86FS_MSG_RENAME_R, tag)
        packU32(resp, 7, status)
        return resp
    }

    handle_symlink(req: Uint8Array, tag: number): Uint8Array {
        // Parse SYMLINK: [7B hdr] [8B parent_id] [2B name_len] [name...]
        //                [2B target_len] [target...]
        let off = 7
        const parent_id = readU64(req, off)
        off += 8
        const name_len = readU16(req, off)
        off += 2
        const name = textDecoder.decode(req.subarray(off, off + name_len))
        off += name_len
        const target_len = readU16(req, off)
        off += 2
        const target = textDecoder.decode(req.subarray(off, off + target_len))

        const inode_id = this.next_inode_id++
        const entry: FsEntry = {
            inode_id,
            name,
            mode: S_IFLNK | 0o777,
            size: target.length,
            dt_type: DT_LNK,
            mtime_sec: Math.floor(Date.now() / 1000),
            mtime_nsec: 0,
            symlink_target: target,
        }

        let children = FS_ENTRIES.get(parent_id)
        if (!children) {
            children = []
            FS_ENTRIES.set(parent_id, children)
        }
        children.push(entry)
        INODE_MAP.set(inode_id, entry)

        // SYMLINK_R: [7B hdr] [4B status] [8B inode_id] [4B mode]
        const resp = makeResp(23, V86FS_MSG_SYMLINK_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, inode_id)
        packU32(resp, 19, entry.mode)
        return resp
    }

    handle_readlink(req: Uint8Array, tag: number): Uint8Array {
        // Parse READLINK: [7B hdr] [8B inode_id]
        const inode_id = readU64(req, 7)
        const entry = INODE_MAP.get(inode_id)

        if (!entry || !entry.symlink_target) {
            const resp = makeResp(11, V86FS_MSG_READLINK_R, tag)
            packU32(resp, 7, V86FS_STATUS_ENOENT)
            return resp
        }

        const target_bytes = textEncoder.encode(entry.symlink_target)
        const resp_len = 11 + 2 + target_bytes.length
        const resp = makeResp(resp_len, V86FS_MSG_READLINK_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU16(resp, 11, target_bytes.length)
        resp.set(target_bytes, 13)
        return resp
    }

    handle_statfs(tag: number): Uint8Array {
        // STATFS_R: [7B hdr] [4B status] [8B blocks] [8B bfree] [8B bavail]
        //           [8B files] [8B ffree] [4B bsize] [4B namelen]
        const resp = makeResp(55, V86FS_MSG_STATFS_R, tag)
        packU32(resp, 7, V86FS_STATUS_OK)
        packU64(resp, 11, 1024 * 1024) // blocks
        packU64(resp, 19, 512 * 1024) // bfree
        packU64(resp, 27, 512 * 1024) // bavail
        packU64(resp, 35, 1024 * 1024) // files
        packU64(resp, 43, 512 * 1024) // ffree
        packU32(resp, 51, 4096) // bsize
        return resp
    }

    /** Push an INVALIDATE notification to the guest via notifyq.
     *  Guest kernel will invalidate page cache for the given inode. */
    invalidate_inode(inode_id: number): boolean {
        const queue = this.virtio.queues[2] // notifyq
        if (!queue.has_request()) return false

        const bufchain = queue.pop_request()
        // INVALIDATE: [7B hdr] [8B inode_id]
        const msg = new Uint8Array(15)
        packU32(msg, 0, 15)
        msg[4] = V86FS_MSG_INVALIDATE
        packU16(msg, 5, 0)
        packU64(msg, 7, inode_id)
        bufchain.set_next_blob(msg)
        queue.push_reply(bufchain)
        queue.flush_replies()
        return true
    }

    /** Push an INVALIDATE_DIR notification to the guest via notifyq.
     *  Guest kernel will invalidate dcache for the given directory inode. */
    invalidate_dir(inode_id: number): boolean {
        const queue = this.virtio.queues[2] // notifyq
        if (!queue.has_request()) return false

        const bufchain = queue.pop_request()
        // INVALIDATE_DIR: [7B hdr] [8B inode_id]
        const msg = new Uint8Array(15)
        packU32(msg, 0, 15)
        msg[4] = V86FS_MSG_INVALIDATE_DIR
        packU16(msg, 5, 0)
        packU64(msg, 7, inode_id)
        bufchain.set_next_blob(msg)
        queue.push_reply(bufchain)
        queue.flush_replies()
        return true
    }

    get_state(): any[] {
        const state: any[] = []
        state[0] = this.virtio
        return state
    }

    set_state(state: any[]): void {
        this.virtio.set_state(state[0])
    }
}
