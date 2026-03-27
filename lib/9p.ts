// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem device following the
// 9P2000.L protocol ( https://code.google.com/p/diod/wiki/protocol )

import { LOG_9P } from './../src/const.js'
import {
    VirtIO,
    VirtQueue,
    VirtQueueBufferChain,
    VIRTIO_F_VERSION_1,
    VIRTIO_F_RING_EVENT_IDX,
    VIRTIO_F_RING_INDIRECT_DESC,
} from '../src/virtio.js'
import { S_IFREG, S_IFDIR, STATUS_UNLINKED } from './filesystem.js'
import * as marshall from '../lib/marshall.js'
import { dbg_log, dbg_assert } from '../src/log.js'
import { h } from '../src/lib.js'

import type { CPU } from '../src/cpu.js'
import type { BusConnector } from '../src/bus.js'
import type { FS } from './filesystem.js'

// More accurate filenames in 9p debug messages at the cost of performance.
const TRACK_FILENAMES = false

// Feature bit (bit position) for mount tag.
const VIRTIO_9P_F_MOUNT_TAG = 0
// Assumed max tag length in bytes.
const VIRTIO_9P_MAX_TAGLEN = 254

const MAX_REPLYBUFFER_SIZE = 16 * 1024 * 1024

export const EPERM = 1 /* Operation not permitted */
export const ENOENT = 2 /* No such file or directory */
export const EEXIST = 17 /* File exists */
export const EINVAL = 22 /* Invalid argument */
export const EOPNOTSUPP = 95 /* Operation is not supported */
export const ENOTEMPTY = 39 /* Directory not empty */
export const EPROTO = 71 /* Protocol error */

const P9_SETATTR_MODE = 0x00000001
const P9_SETATTR_UID = 0x00000002
const P9_SETATTR_GID = 0x00000004
const P9_SETATTR_SIZE = 0x00000008
const P9_SETATTR_ATIME = 0x00000010
const P9_SETATTR_MTIME = 0x00000020
const P9_SETATTR_CTIME = 0x00000040
const P9_SETATTR_ATIME_SET = 0x00000080
const P9_SETATTR_MTIME_SET = 0x00000100

const _P9_STAT_MODE_DIR = 0x80000000
const _P9_STAT_MODE_APPEND = 0x40000000
const _P9_STAT_MODE_EXCL = 0x20000000
const _P9_STAT_MODE_MOUNT = 0x10000000
const _P9_STAT_MODE_AUTH = 0x08000000
const _P9_STAT_MODE_TMP = 0x04000000
const _P9_STAT_MODE_SYMLINK = 0x02000000
const _P9_STAT_MODE_LINK = 0x01000000
const _P9_STAT_MODE_DEVICE = 0x00800000
const _P9_STAT_MODE_NAMED_PIPE = 0x00200000
const _P9_STAT_MODE_SOCKET = 0x00100000
const _P9_STAT_MODE_SETUID = 0x00080000
const _P9_STAT_MODE_SETGID = 0x00040000
const _P9_STAT_MODE_SETVTX = 0x00010000

export const P9_LOCK_TYPE_RDLCK = 0
export const P9_LOCK_TYPE_WRLCK = 1
export const P9_LOCK_TYPE_UNLCK = 2
const P9_LOCK_TYPES = ['shared', 'exclusive', 'unlock']

const _P9_LOCK_FLAGS_BLOCK = 1
const _P9_LOCK_FLAGS_RECLAIM = 2

export const P9_LOCK_SUCCESS = 0
export const P9_LOCK_BLOCKED = 1
export const P9_LOCK_ERROR = 2
export const P9_LOCK_GRACE = 3

const FID_NONE = -1
const FID_INODE = 1
const FID_XATTR = 2

interface Fid {
    inodeid: number
    type: number
    uid: number
    dbg_name: string
}

type P9Handler = (
    reqbuf: Uint8Array,
    reply: (replybuf: Uint8Array) => void,
) => void

function range(size: number): number[] {
    return Array.from(Array(size).keys())
}

function init_virtio(
    cpu: CPU,
    configspace_taglen: number,
    configspace_tagname: number[],
    receive: (bufchain: VirtQueueBufferChain) => void,
): VirtIO {
    const virtio = new VirtIO(cpu, {
        name: 'virtio-9p',
        pci_id: 0x06 << 3,
        device_id: 0x1049,
        subsystem_device_id: 9,
        common: {
            initial_port: 0xa800,
            queues: [
                {
                    size_supported: 32,
                    notify_offset: 0,
                },
            ],
            features: [
                VIRTIO_9P_F_MOUNT_TAG,
                VIRTIO_F_VERSION_1,
                VIRTIO_F_RING_EVENT_IDX,
                VIRTIO_F_RING_INDIRECT_DESC,
            ],
            on_driver_ok: () => {},
        },
        notification: {
            initial_port: 0xa900,
            single_handler: false,
            handlers: [
                (queue_id: number) => {
                    if (queue_id !== 0) {
                        dbg_assert(
                            false,
                            'Virtio9P Notified for non-existent queue: ' +
                                queue_id +
                                ' (expected queue_id of 0)',
                        )
                        return
                    }
                    const virtqueue = virtio.queues[0]
                    while (virtqueue.has_request()) {
                        const bufchain = virtqueue.pop_request()
                        receive(bufchain)
                    }
                    virtqueue.notify_me_after(0)
                    // Don't flush replies here: async replies are not completed yet.
                },
            ],
        },
        isr_status: {
            initial_port: 0xa700,
        },
        device_specific: {
            initial_port: 0xa600,
            struct: [
                {
                    bytes: 2,
                    name: 'mount tag length',
                    read: () => configspace_taglen,
                    write: (_data: number) => {
                        /* read only */
                    },
                },
            ].concat(
                range(VIRTIO_9P_MAX_TAGLEN).map((index) => ({
                    bytes: 1,
                    name: 'mount tag name ' + index,
                    // Note: configspace_tagname may have changed after set_state
                    read: () => configspace_tagname[index] || 0,
                    write: (_data: number) => {
                        /* read only */
                    },
                })),
            ),
        },
    })
    return virtio
}

export class Virtio9p {
    fs: FS
    bus: BusConnector
    configspace_tagname: number[]
    configspace_taglen: number
    virtio: VirtIO
    virtqueue: VirtQueue
    VERSION: string
    BLOCKSIZE: number
    msize: number
    replybuffer: Uint8Array
    replybuffersize: number
    fids: Fid[]

    constructor(filesystem: FS, cpu: CPU, bus: BusConnector) {
        this.fs = filesystem
        this.bus = bus

        this.configspace_tagname = [0x68, 0x6f, 0x73, 0x74, 0x39, 0x70] // "host9p" string
        this.configspace_taglen = this.configspace_tagname.length // num bytes

        this.virtio = init_virtio(
            cpu,
            this.configspace_taglen,
            this.configspace_tagname,
            this.ReceiveRequest.bind(this),
        )
        this.virtqueue = this.virtio.queues[0]

        this.VERSION = '9P2000.L'
        this.BLOCKSIZE = 8192 // Let's define one page.
        this.msize = 8192 // maximum message size
        this.replybuffer = new Uint8Array(this.msize * 2) // Twice the msize to stay on the safe site
        this.replybuffersize = 0
        this.fids = []
    }

    get_state(): any[] {
        const state: any[] = []

        state[0] = this.configspace_tagname
        state[1] = this.configspace_taglen
        state[2] = this.virtio
        state[3] = this.VERSION
        state[4] = this.BLOCKSIZE
        state[5] = this.msize
        state[6] = this.replybuffer
        state[7] = this.replybuffersize
        state[8] = this.fids.map(function (f) {
            return [f.inodeid, f.type, f.uid, f.dbg_name]
        })
        state[9] = this.fs

        return state
    }

    set_state(state: any[]): void {
        this.configspace_tagname = state[0]
        this.configspace_taglen = state[1]
        this.virtio.set_state(state[2])
        this.virtqueue = this.virtio.queues[0]
        this.VERSION = state[3]
        this.BLOCKSIZE = state[4]
        this.msize = state[5]
        this.replybuffer = state[6]
        this.replybuffersize = state[7]

        this.fids = state[8].map(function (f: any[]) {
            return { inodeid: f[0], type: f[1], uid: f[2], dbg_name: f[3] }
        })
        this.fs.set_state(state[9])
    }

    // Note: dbg_name is only used for debugging messages and may not be the same as the filename,
    // since it is not synchronised with renames done outside of 9p. Hard-links, linking and unlinking
    // operations also mean that having a single filename no longer makes sense.
    // Set TRACK_FILENAMES = true to sync dbg_name during 9p renames.
    Createfid(
        inodeid: number,
        type: number,
        uid: number,
        dbg_name: string,
    ): Fid {
        return { inodeid, type, uid, dbg_name }
    }

    update_dbg_name(idx: number, newname: string): void {
        for (const fid of this.fids) {
            if (fid.inodeid === idx) fid.dbg_name = newname
        }
    }

    reset(): void {
        this.fids = []
        this.virtio.reset()
    }

    BuildReply(id: number, tag: number, payloadsize: number): void {
        dbg_assert(payloadsize >= 0, '9P: Negative payload size')
        marshall.Marshall(
            ['w', 'b', 'h'],
            [payloadsize + 7, id + 1, tag],
            this.replybuffer,
            0,
        )
        if (payloadsize + 7 >= this.replybuffer.length) {
            dbg_log('Error in 9p: payloadsize exceeds maximum length', LOG_9P)
        }
        this.replybuffersize = payloadsize + 7
    }

    SendError(tag: number, errormsg: string, errorcode: number): void {
        const size = marshall.Marshall(['w'], [errorcode], this.replybuffer, 7)
        this.BuildReply(6, tag, size)
    }

    SendReply(bufchain: VirtQueueBufferChain): void {
        dbg_assert(this.replybuffersize >= 0, '9P: Negative replybuffersize')
        bufchain.set_next_blob(
            this.replybuffer.subarray(0, this.replybuffersize),
        )
        this.virtqueue.push_reply(bufchain)
        this.virtqueue.flush_replies()
    }

    async ReceiveRequest(bufchain: VirtQueueBufferChain): Promise<void> {
        // TODO: split into header + data blobs to avoid unnecessary copying.
        const buffer = new Uint8Array(bufchain.length_readable)
        bufchain.get_next_blob(buffer)

        const state = { offset: 0 }
        const header = marshall.Unmarshall(['w', 'b', 'h'], buffer, state)
        let size = header[0]
        const id = header[1]
        const tag = header[2]

        switch (id) {
            case 8: {
                // statfs
                size = this.fs.GetTotalSize() // size used by all files
                const space = this.fs.GetSpace()

                const req: any[] = []
                req[0] = 0x01021997
                req[1] = this.BLOCKSIZE // optimal transfer block size
                req[2] = Math.floor(space / req[1]) // free blocks
                req[3] = req[2] - Math.floor(size / req[1]) // free blocks in fs
                req[4] = req[2] - Math.floor(size / req[1]) // free blocks avail to non-superuser
                req[5] = this.fs.CountUsedInodes() // total number of inodes
                req[6] = this.fs.CountFreeInodes()
                req[7] = 0 // file system id?
                req[8] = 256 // maximum length of filenames

                size = marshall.Marshall(
                    ['w', 'w', 'd', 'd', 'd', 'd', 'd', 'd', 'w'],
                    req,
                    this.replybuffer,
                    7,
                )
                this.BuildReply(id, tag, size)
                this.SendReply(bufchain)
                break
            }

            case 112: // topen
            case 12: {
                // tlopen
                let req = marshall.Unmarshall(['w', 'w'], buffer, state)
                const fid = req[0]
                const mode = req[1]
                dbg_log('[open] fid=' + fid + ', mode=' + mode, LOG_9P)
                const idx = this.fids[fid].inodeid
                const inode = this.fs.GetInode(idx)
                dbg_log(
                    'file open ' + this.fids[fid].dbg_name + ' tag:' + tag,
                    LOG_9P,
                )
                await this.fs.OpenInode(idx, mode)

                req = []
                req[0] = inode.qid
                req[1] = this.msize - 24
                marshall.Marshall(['Q', 'w'], req, this.replybuffer, 7)
                this.BuildReply(id, tag, 13 + 4)
                this.SendReply(bufchain)
                break
            }

            case 70: {
                // link
                const req = marshall.Unmarshall(['w', 'w', 's'], buffer, state)
                const dfid = req[0]
                const fid = req[1]
                const name = req[2]
                dbg_log('[link] dfid=' + dfid + ', name=' + name, LOG_9P)

                const ret = this.fs.Link(
                    this.fids[dfid].inodeid,
                    this.fids[fid].inodeid,
                    name,
                )

                if (ret < 0) {
                    let error_message = ''
                    if (ret === -EPERM)
                        error_message = 'Operation not permitted'
                    else {
                        error_message = 'Unknown error: ' + -ret
                        dbg_assert(
                            false,
                            '[link]: Unexpected error code: ' + -ret,
                        )
                    }
                    this.SendError(tag, error_message, -ret)
                    this.SendReply(bufchain)
                    break
                }

                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 16: {
                // symlink
                const req = marshall.Unmarshall(
                    ['w', 's', 's', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const name = req[1]
                const symgt = req[2]
                const gid = req[3]
                dbg_log(
                    '[symlink] fid=' +
                        fid +
                        ', name=' +
                        name +
                        ', symgt=' +
                        symgt +
                        ', gid=' +
                        gid,
                    LOG_9P,
                )
                const idx = this.fs.CreateSymlink(
                    name,
                    this.fids[fid].inodeid,
                    symgt,
                )
                const inode = this.fs.GetInode(idx)
                inode.uid = this.fids[fid].uid
                inode.gid = gid
                marshall.Marshall(['Q'], [inode.qid], this.replybuffer, 7)
                this.BuildReply(id, tag, 13)
                this.SendReply(bufchain)
                break
            }

            case 18: {
                // mknod
                const req = marshall.Unmarshall(
                    ['w', 's', 'w', 'w', 'w', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const name = req[1]
                const mode = req[2]
                const major = req[3]
                const minor = req[4]
                const gid = req[5]
                dbg_log(
                    '[mknod] fid=' +
                        fid +
                        ', name=' +
                        name +
                        ', major=' +
                        major +
                        ', minor=' +
                        minor +
                        '',
                    LOG_9P,
                )
                const idx = this.fs.CreateNode(
                    name,
                    this.fids[fid].inodeid,
                    major,
                    minor,
                )
                const inode = this.fs.GetInode(idx)
                inode.mode = mode
                //inode.mode = mode | S_IFCHR; // XXX: fails "Mknod - fifo" test
                inode.uid = this.fids[fid].uid
                inode.gid = gid
                marshall.Marshall(['Q'], [inode.qid], this.replybuffer, 7)
                this.BuildReply(id, tag, 13)
                this.SendReply(bufchain)
                break
            }

            case 22: {
                // TREADLINK
                const req = marshall.Unmarshall(['w'], buffer, state)
                const fid = req[0]
                const inode = this.fs.GetInode(this.fids[fid].inodeid)
                dbg_log(
                    '[readlink] fid=' +
                        fid +
                        ' name=' +
                        this.fids[fid].dbg_name +
                        ' target=' +
                        inode.symlink,
                    LOG_9P,
                )
                size = marshall.Marshall(
                    ['s'],
                    [inode.symlink],
                    this.replybuffer,
                    7,
                )
                this.BuildReply(id, tag, size)
                this.SendReply(bufchain)
                break
            }

            case 72: {
                // tmkdir
                const req = marshall.Unmarshall(
                    ['w', 's', 'w', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const name = req[1]
                const mode = req[2]
                const gid = req[3]
                dbg_log(
                    '[mkdir] fid=' +
                        fid +
                        ', name=' +
                        name +
                        ', mode=' +
                        mode +
                        ', gid=' +
                        gid,
                    LOG_9P,
                )
                const idx = this.fs.CreateDirectory(
                    name,
                    this.fids[fid].inodeid,
                )
                const inode = this.fs.GetInode(idx)
                inode.mode = mode | S_IFDIR
                inode.uid = this.fids[fid].uid
                inode.gid = gid
                marshall.Marshall(['Q'], [inode.qid], this.replybuffer, 7)
                this.BuildReply(id, tag, 13)
                this.SendReply(bufchain)
                break
            }

            case 14: {
                // tlcreate
                const req = marshall.Unmarshall(
                    ['w', 's', 'w', 'w', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const name = req[1]
                const flags = req[2]
                const mode = req[3]
                const gid = req[4]
                this.bus.send('9p-create', [name, this.fids[fid].inodeid])
                dbg_log(
                    '[create] fid=' +
                        fid +
                        ', name=' +
                        name +
                        ', flags=' +
                        flags +
                        ', mode=' +
                        mode +
                        ', gid=' +
                        gid,
                    LOG_9P,
                )
                const idx = this.fs.CreateFile(name, this.fids[fid].inodeid)
                this.fids[fid].inodeid = idx
                this.fids[fid].type = FID_INODE
                this.fids[fid].dbg_name = name
                const inode = this.fs.GetInode(idx)
                inode.uid = this.fids[fid].uid
                inode.gid = gid
                inode.mode = mode | S_IFREG
                marshall.Marshall(
                    ['Q', 'w'],
                    [inode.qid, this.msize - 24],
                    this.replybuffer,
                    7,
                )
                this.BuildReply(id, tag, 13 + 4)
                this.SendReply(bufchain)
                break
            }

            case 52: {
                // lock
                const req = marshall.Unmarshall(
                    ['w', 'b', 'w', 'd', 'd', 'w', 's'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const flags = req[2]
                const lock_length = req[4] === 0 ? Infinity : req[4]
                const lock_request = this.fs.DescribeLock(
                    req[1],
                    req[3],
                    lock_length,
                    req[5],
                    req[6],
                )
                dbg_log(
                    '[lock] fid=' +
                        fid +
                        ', type=' +
                        P9_LOCK_TYPES[lock_request.type] +
                        ', start=' +
                        lock_request.start +
                        ', length=' +
                        lock_request.length +
                        ', proc_id=' +
                        lock_request.proc_id,
                )

                const ret = this.fs.Lock(
                    this.fids[fid].inodeid,
                    lock_request,
                    flags,
                )

                marshall.Marshall(['b'], [ret], this.replybuffer, 7)
                this.BuildReply(id, tag, 1)
                this.SendReply(bufchain)
                break
            }

            case 54: {
                // getlock
                const req = marshall.Unmarshall(
                    ['w', 'b', 'd', 'd', 'w', 's'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const lock_length = req[3] === 0 ? Infinity : req[3]
                const lock_request = this.fs.DescribeLock(
                    req[1],
                    req[2],
                    lock_length,
                    req[4],
                    req[5],
                )
                dbg_log(
                    '[getlock] fid=' +
                        fid +
                        ', type=' +
                        P9_LOCK_TYPES[lock_request.type] +
                        ', start=' +
                        lock_request.start +
                        ', length=' +
                        lock_request.length +
                        ', proc_id=' +
                        lock_request.proc_id,
                )

                let ret_lock = this.fs.GetLock(
                    this.fids[fid].inodeid,
                    lock_request,
                )

                if (!ret_lock) {
                    ret_lock = lock_request
                    ret_lock.type = P9_LOCK_TYPE_UNLCK
                }

                const ret_length =
                    ret_lock.length === Infinity ? 0 : ret_lock.length

                size = marshall.Marshall(
                    ['b', 'd', 'd', 'w', 's'],
                    [
                        ret_lock.type,
                        ret_lock.start,
                        ret_length,
                        ret_lock.proc_id,
                        ret_lock.client_id,
                    ],
                    this.replybuffer,
                    7,
                )

                this.BuildReply(id, tag, size)
                this.SendReply(bufchain)
                break
            }

            case 24: {
                // getattr
                const req = marshall.Unmarshall(['w', 'd'], buffer, state)
                const fid = req[0]
                const inode = this.fs.GetInode(this.fids[fid].inodeid)
                dbg_log(
                    '[getattr]: fid=' +
                        fid +
                        ' name=' +
                        this.fids[fid].dbg_name +
                        ' request mask=' +
                        req[1],
                    LOG_9P,
                )
                if (!inode || inode.status === STATUS_UNLINKED) {
                    dbg_log('getattr: unlinked', LOG_9P)
                    this.SendError(tag, 'No such file or directory', ENOENT)
                    this.SendReply(bufchain)
                    break
                }
                req[0] = req[1] // request mask
                req[1] = inode.qid

                req[2] = inode.mode
                req[3] = inode.uid // user id
                req[4] = inode.gid // group id

                req[5] = inode.nlinks // number of hard links
                req[6] = (inode.major << 8) | inode.minor // device id low
                req[7] = inode.size // size low
                req[8] = this.BLOCKSIZE
                req[9] = Math.floor(inode.size / 512 + 1) // blk size low
                req[10] = inode.atime // atime
                req[11] = 0x0
                req[12] = inode.mtime // mtime
                req[13] = 0x0
                req[14] = inode.ctime // ctime
                req[15] = 0x0
                req[16] = 0x0 // btime
                req[17] = 0x0
                req[18] = 0x0 // st_gen
                req[19] = 0x0 // data_version
                marshall.Marshall(
                    [
                        'd',
                        'Q',
                        'w',
                        'w',
                        'w',
                        'd',
                        'd',
                        'd',
                        'd',
                        'd',
                        'd',
                        'd', // atime
                        'd',
                        'd', // mtime
                        'd',
                        'd', // ctime
                        'd',
                        'd', // btime
                        'd',
                        'd',
                    ],
                    req,
                    this.replybuffer,
                    7,
                )
                this.BuildReply(id, tag, 8 + 13 + 4 + 4 + 4 + 8 * 15)
                this.SendReply(bufchain)
                break
            }

            case 26: {
                // setattr
                const req = marshall.Unmarshall(
                    [
                        'w',
                        'w',
                        'w', // mode
                        'w',
                        'w', // uid, gid
                        'd', // size
                        'd',
                        'd', // atime
                        'd',
                        'd', // mtime
                    ],
                    buffer,
                    state,
                )
                const fid = req[0]
                const inode = this.fs.GetInode(this.fids[fid].inodeid)
                dbg_log(
                    '[setattr]: fid=' +
                        fid +
                        ' request mask=' +
                        req[1] +
                        ' name=' +
                        this.fids[fid].dbg_name,
                    LOG_9P,
                )
                if (req[1] & P9_SETATTR_MODE) {
                    // XXX: check mode (S_IFREG or S_IFDIR or similar should be set)
                    inode.mode = req[2]
                }
                if (req[1] & P9_SETATTR_UID) {
                    inode.uid = req[3]
                }
                if (req[1] & P9_SETATTR_GID) {
                    inode.gid = req[4]
                }
                if (req[1] & P9_SETATTR_ATIME) {
                    inode.atime = Math.floor(new Date().getTime() / 1000)
                }
                if (req[1] & P9_SETATTR_MTIME) {
                    inode.mtime = Math.floor(new Date().getTime() / 1000)
                }
                if (req[1] & P9_SETATTR_CTIME) {
                    inode.ctime = Math.floor(new Date().getTime() / 1000)
                }
                if (req[1] & P9_SETATTR_ATIME_SET) {
                    inode.atime = req[6]
                }
                if (req[1] & P9_SETATTR_MTIME_SET) {
                    inode.mtime = req[8]
                }
                if (req[1] & P9_SETATTR_SIZE) {
                    await this.fs.ChangeSize(this.fids[fid].inodeid, req[5])
                }
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 50: {
                // fsync
                const req = marshall.Unmarshall(['w', 'd'], buffer, state)
                const _fid = req[0]
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 40: // TREADDIR
            case 116: {
                // read
                const req = marshall.Unmarshall(['w', 'd', 'w'], buffer, state)
                const fid = req[0]
                const offset = req[1]
                let count = req[2]
                const inode = this.fs.GetInode(this.fids[fid].inodeid)
                if (id === 40)
                    dbg_log(
                        '[treaddir]: fid=' +
                            fid +
                            ' offset=' +
                            offset +
                            ' count=' +
                            count,
                        LOG_9P,
                    )
                if (id === 116)
                    dbg_log(
                        '[read]: fid=' +
                            fid +
                            ' (' +
                            this.fids[fid].dbg_name +
                            ') offset=' +
                            offset +
                            ' count=' +
                            count +
                            ' fidtype=' +
                            this.fids[fid].type,
                        LOG_9P,
                    )
                if (!inode || inode.status === STATUS_UNLINKED) {
                    dbg_log('read/treaddir: unlinked', LOG_9P)
                    this.SendError(tag, 'No such file or directory', ENOENT)
                    this.SendReply(bufchain)
                    break
                }
                if (this.fids[fid].type === FID_XATTR) {
                    if (inode.caps!.length < offset + count)
                        count = inode.caps!.length - offset
                    for (let i = 0; i < count; i++)
                        this.replybuffer[7 + 4 + i] = inode.caps![offset + i]
                    marshall.Marshall(['w'], [count], this.replybuffer, 7)
                    this.BuildReply(id, tag, 4 + count)
                    this.SendReply(bufchain)
                } else {
                    await this.fs.OpenInode(this.fids[fid].inodeid, undefined)
                    const inodeid = this.fids[fid].inodeid

                    count = Math.min(count, this.replybuffer.length - (7 + 4))

                    if (inode.size < offset + count) count = inode.size - offset
                    else if (id === 40) {
                        // for directories, return whole number of dir-entries.
                        count =
                            this.fs.RoundToDirentry(inodeid, offset + count) -
                            offset
                    }
                    if (offset > inode.size) {
                        // offset can be greater than available - should return count of zero.
                        // See http://ericvh.github.io/9p-rfc/rfc9p2000.html#anchor30
                        count = 0
                    }

                    this.bus.send('9p-read-start', [this.fids[fid].dbg_name])

                    const data = await this.fs.Read(inodeid, offset, count)

                    this.bus.send('9p-read-end', [
                        this.fids[fid].dbg_name,
                        count,
                    ])

                    if (data) {
                        this.replybuffer.set(data, 7 + 4)
                    }
                    marshall.Marshall(['w'], [count], this.replybuffer, 7)
                    this.BuildReply(id, tag, 4 + count)
                    this.SendReply(bufchain)
                }
                break
            }

            case 118: {
                // write
                const req = marshall.Unmarshall(['w', 'd', 'w'], buffer, state)
                const fid = req[0]
                const offset = req[1]
                const count = req[2]

                const filename = this.fids[fid].dbg_name

                dbg_log(
                    '[write]: fid=' +
                        fid +
                        ' (' +
                        filename +
                        ') offset=' +
                        offset +
                        ' count=' +
                        count +
                        ' fidtype=' +
                        this.fids[fid].type,
                    LOG_9P,
                )
                if (this.fids[fid].type === FID_XATTR) {
                    // XXX: xattr not supported yet. Ignore write.
                    this.SendError(tag, 'Setxattr not supported', EOPNOTSUPP)
                    this.SendReply(bufchain)
                    break
                } else {
                    // XXX: Size of the subarray is unchecked
                    await this.fs.Write(
                        this.fids[fid].inodeid,
                        offset,
                        count,
                        buffer.subarray(state.offset),
                    )
                }

                this.bus.send('9p-write-end', [filename, count])

                marshall.Marshall(['w'], [count], this.replybuffer, 7)
                this.BuildReply(id, tag, 4)
                this.SendReply(bufchain)
                break
            }

            case 74: {
                // RENAMEAT
                const req = marshall.Unmarshall(
                    ['w', 's', 'w', 's'],
                    buffer,
                    state,
                )
                const olddirfid = req[0]
                const oldname = req[1]
                const newdirfid = req[2]
                const newname = req[3]
                dbg_log(
                    '[renameat]: oldname=' + oldname + ' newname=' + newname,
                    LOG_9P,
                )
                const ret = await this.fs.Rename(
                    this.fids[olddirfid].inodeid,
                    oldname,
                    this.fids[newdirfid].inodeid,
                    newname,
                )
                if (ret < 0) {
                    let error_message = ''
                    if (ret === -ENOENT)
                        error_message = 'No such file or directory'
                    else if (ret === -EPERM)
                        error_message = 'Operation not permitted'
                    else if (ret === -ENOTEMPTY)
                        error_message = 'Directory not empty'
                    else {
                        error_message = 'Unknown error: ' + -ret
                        dbg_assert(
                            false,
                            '[renameat]: Unexpected error code: ' + -ret,
                        )
                    }
                    this.SendError(tag, error_message, -ret)
                    this.SendReply(bufchain)
                    break
                }
                if (TRACK_FILENAMES) {
                    const newidx = this.fs.Search(
                        this.fids[newdirfid].inodeid,
                        newname,
                    )
                    this.update_dbg_name(newidx, newname)
                }
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 76: {
                // TUNLINKAT
                const req = marshall.Unmarshall(['w', 's', 'w'], buffer, state)
                const dirfd = req[0]
                const name = req[1]
                const flags = req[2]
                dbg_log(
                    '[unlink]: dirfd=' +
                        dirfd +
                        ' name=' +
                        name +
                        ' flags=' +
                        flags,
                    LOG_9P,
                )
                const fid_search = this.fs.Search(
                    this.fids[dirfd].inodeid,
                    name,
                )
                if (fid_search === -1) {
                    this.SendError(tag, 'No such file or directory', ENOENT)
                    this.SendReply(bufchain)
                    break
                }
                const ret = this.fs.Unlink(this.fids[dirfd].inodeid, name)
                if (ret < 0) {
                    let error_message = ''
                    if (ret === -ENOTEMPTY)
                        error_message = 'Directory not empty'
                    else if (ret === -EPERM)
                        error_message = 'Operation not permitted'
                    else {
                        error_message = 'Unknown error: ' + -ret
                        dbg_assert(
                            false,
                            '[unlink]: Unexpected error code: ' + -ret,
                        )
                    }
                    this.SendError(tag, error_message, -ret)
                    this.SendReply(bufchain)
                    break
                }
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 100: {
                // version
                const version = marshall.Unmarshall(['w', 's'], buffer, state)
                dbg_log(
                    '[version]: msize=' + version[0] + ' version=' + version[1],
                    LOG_9P,
                )
                if (this.msize !== version[0]) {
                    this.msize = version[0]
                    this.replybuffer = new Uint8Array(
                        Math.min(MAX_REPLYBUFFER_SIZE, this.msize * 2),
                    )
                }
                size = marshall.Marshall(
                    ['w', 's'],
                    [this.msize, this.VERSION],
                    this.replybuffer,
                    7,
                )
                this.BuildReply(id, tag, size)
                this.SendReply(bufchain)
                break
            }

            case 104: {
                // attach
                // return root directorie's QID
                const req = marshall.Unmarshall(
                    ['w', 'w', 's', 's', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const uid = req[4]
                dbg_log(
                    '[attach]: fid=' +
                        fid +
                        ' afid=' +
                        h(req[1]) +
                        ' uname=' +
                        req[2] +
                        ' aname=' +
                        req[3],
                    LOG_9P,
                )
                this.fids[fid] = this.Createfid(0, FID_INODE, uid, '')
                const inode = this.fs.GetInode(this.fids[fid].inodeid)
                marshall.Marshall(['Q'], [inode.qid], this.replybuffer, 7)
                this.BuildReply(id, tag, 13)
                this.SendReply(bufchain)
                this.bus.send('9p-attach')
                break
            }

            case 108: {
                // tflush
                const req = marshall.Unmarshall(['h'], buffer, state)
                const _oldtag = req[0]
                dbg_log('[flush] ' + tag, LOG_9P)
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 110: {
                // walk
                const req = marshall.Unmarshall(['w', 'w', 'h'], buffer, state)
                const fid = req[0]
                const nwfid = req[1]
                const nwname = req[2]
                dbg_log(
                    '[walk]: fid=' +
                        req[0] +
                        ' nwfid=' +
                        req[1] +
                        ' nwname=' +
                        nwname,
                    LOG_9P,
                )
                if (nwname === 0) {
                    this.fids[nwfid] = this.Createfid(
                        this.fids[fid].inodeid,
                        FID_INODE,
                        this.fids[fid].uid,
                        this.fids[fid].dbg_name,
                    )
                    marshall.Marshall(['h'], [0], this.replybuffer, 7)
                    this.BuildReply(id, tag, 2)
                    this.SendReply(bufchain)
                    break
                }
                const wnames: string[] = []
                for (let i = 0; i < nwname; i++) {
                    wnames.push('s')
                }
                const walk = marshall.Unmarshall(
                    wnames as marshall.MarshallTypeCode[],
                    buffer,
                    state,
                )
                let idx = this.fids[fid].inodeid
                let offset = 7 + 2
                let nwidx = 0
                dbg_log(
                    'walk in dir ' +
                        this.fids[fid].dbg_name +
                        ' to: ' +
                        walk.toString(),
                    LOG_9P,
                )
                for (let i = 0; i < nwname; i++) {
                    idx = this.fs.Search(idx, walk[i])

                    if (idx === -1) {
                        dbg_log('Could not find: ' + walk[i], LOG_9P)
                        break
                    }
                    offset += marshall.Marshall(
                        ['Q'],
                        [this.fs.GetInode(idx).qid],
                        this.replybuffer,
                        offset,
                    )
                    nwidx++
                    this.fids[nwfid] = this.Createfid(
                        idx,
                        FID_INODE,
                        this.fids[fid].uid,
                        walk[i],
                    )
                }
                marshall.Marshall(['h'], [nwidx], this.replybuffer, 7)
                this.BuildReply(id, tag, offset - 7)
                this.SendReply(bufchain)
                break
            }

            case 120: {
                // clunk
                const req = marshall.Unmarshall(['w'], buffer, state)
                dbg_log('[clunk]: fid=' + req[0], LOG_9P)
                if (this.fids[req[0]] && this.fids[req[0]].inodeid >= 0) {
                    await this.fs.CloseInode(this.fids[req[0]].inodeid)
                    this.fids[req[0]].inodeid = -1
                    this.fids[req[0]].type = FID_NONE
                }
                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 32: {
                // txattrcreate
                const req = marshall.Unmarshall(
                    ['w', 's', 'd', 'w'],
                    buffer,
                    state,
                )
                const fid = req[0]
                const name = req[1]
                const attr_size = req[2]
                const flags = req[3]
                dbg_log(
                    '[txattrcreate]: fid=' +
                        fid +
                        ' name=' +
                        name +
                        ' attr_size=' +
                        attr_size +
                        ' flags=' +
                        flags,
                    LOG_9P,
                )

                // XXX: xattr not supported yet. E.g. checks corresponding to the flags needed.
                this.fids[fid].type = FID_XATTR

                this.BuildReply(id, tag, 0)
                this.SendReply(bufchain)
                break
            }

            case 30: {
                // xattrwalk
                const req = marshall.Unmarshall(['w', 'w', 's'], buffer, state)
                const _fid = req[0]
                const _newfid = req[1]
                const _name = req[2]
                dbg_log(
                    '[xattrwalk]: fid=' +
                        req[0] +
                        ' newfid=' +
                        req[1] +
                        ' name=' +
                        req[2],
                    LOG_9P,
                )

                // Workaround for Linux restarts writes until full blocksize
                this.SendError(tag, 'Setxattr not supported', EOPNOTSUPP)
                this.SendReply(bufchain)
                break
            }

            default:
                dbg_log(
                    'Error in Virtio9p: Unknown id ' + id + ' received',
                    LOG_9P,
                )
                dbg_assert(false)
                break
        }
    }
}

export class Virtio9pHandler {
    handle_fn: P9Handler
    tag_bufchain: Map<number, VirtQueueBufferChain>
    configspace_tagname: number[]
    configspace_taglen: number
    virtio: VirtIO
    virtqueue: VirtQueue

    constructor(handle_fn: P9Handler, cpu: CPU) {
        this.handle_fn = handle_fn
        this.tag_bufchain = new Map()

        this.configspace_tagname = [0x68, 0x6f, 0x73, 0x74, 0x39, 0x70] // "host9p" string
        this.configspace_taglen = this.configspace_tagname.length // num bytes

        this.virtio = init_virtio(
            cpu,
            this.configspace_taglen,
            this.configspace_tagname,
            async (bufchain: VirtQueueBufferChain) => {
                // TODO: split into header + data blobs to avoid unnecessary copying.
                const reqbuf = new Uint8Array(bufchain.length_readable)
                bufchain.get_next_blob(reqbuf)

                const reqheader = marshall.Unmarshall(['w', 'b', 'h'], reqbuf, {
                    offset: 0,
                })
                const reqtag = reqheader[2]

                this.tag_bufchain.set(reqtag, bufchain)
                this.handle_fn(reqbuf, (replybuf: Uint8Array) => {
                    const replyheader = marshall.Unmarshall(
                        ['w', 'b', 'h'],
                        replybuf,
                        { offset: 0 },
                    )
                    const replytag = replyheader[2]

                    const bufchain = this.tag_bufchain.get(replytag)
                    if (!bufchain) {
                        console.error('No bufchain found for tag: ' + replytag)
                        return
                    }

                    bufchain.set_next_blob(replybuf)
                    this.virtqueue.push_reply(bufchain)
                    this.virtqueue.flush_replies()

                    this.tag_bufchain.delete(replytag)
                })
            },
        )
        this.virtqueue = this.virtio.queues[0]
    }

    get_state(): any[] {
        const state: any[] = []

        state[0] = this.configspace_tagname
        state[1] = this.configspace_taglen
        state[2] = this.virtio
        state[3] = this.tag_bufchain

        return state
    }

    set_state(state: any[]): void {
        this.configspace_tagname = state[0]
        this.configspace_taglen = state[1]
        this.virtio.set_state(state[2])
        this.virtqueue = this.virtio.queues[0]
        this.tag_bufchain = state[3]
    }

    reset(): void {
        this.virtio.reset()
    }
}

export class Virtio9pProxy {
    socket: WebSocket | undefined
    cpu: CPU
    send_queue: Uint8Array[]
    url: string
    reconnect_interval: number
    last_connect_attempt: number
    send_queue_limit: number
    destroyed: boolean
    tag_bufchain: Map<number, VirtQueueBufferChain>
    configspace_tagname: number[]
    configspace_taglen: number
    virtio: VirtIO
    virtqueue: VirtQueue

    constructor(url: string, cpu: CPU) {
        this.socket = undefined
        this.cpu = cpu

        // TODO: circular buffer?
        this.send_queue = []
        this.url = url

        this.reconnect_interval = 10000
        this.last_connect_attempt = Date.now() - this.reconnect_interval
        this.send_queue_limit = 64
        this.destroyed = false

        this.tag_bufchain = new Map()

        this.configspace_tagname = [0x68, 0x6f, 0x73, 0x74, 0x39, 0x70] // "host9p" string
        this.configspace_taglen = this.configspace_tagname.length // num bytes

        this.virtio = init_virtio(
            cpu,
            this.configspace_taglen,
            this.configspace_tagname,
            async (bufchain: VirtQueueBufferChain) => {
                // TODO: split into header + data blobs to avoid unnecessary copying.
                const reqbuf = new Uint8Array(bufchain.length_readable)
                bufchain.get_next_blob(reqbuf)

                const reqheader = marshall.Unmarshall(['w', 'b', 'h'], reqbuf, {
                    offset: 0,
                })
                const reqtag = reqheader[2]

                this.tag_bufchain.set(reqtag, bufchain)
                this.send(reqbuf)
            },
        )
        this.virtqueue = this.virtio.queues[0]
    }

    get_state(): any[] {
        const state: any[] = []

        state[0] = this.configspace_tagname
        state[1] = this.configspace_taglen
        state[2] = this.virtio
        state[3] = this.tag_bufchain

        return state
    }

    set_state(state: any[]): void {
        this.configspace_tagname = state[0]
        this.configspace_taglen = state[1]
        this.virtio.set_state(state[2])
        this.virtqueue = this.virtio.queues[0]
        this.tag_bufchain = state[3]
    }

    reset(): void {
        this.virtio.reset()
    }

    handle_message(e: MessageEvent): void {
        const replybuf = new Uint8Array(e.data)
        const replyheader = marshall.Unmarshall(['w', 'b', 'h'], replybuf, {
            offset: 0,
        })
        const replytag = replyheader[2]

        const bufchain = this.tag_bufchain.get(replytag)
        if (!bufchain) {
            console.error(
                'Virtio9pProxy: No bufchain found for tag: ' + replytag,
            )
            return
        }

        bufchain.set_next_blob(replybuf)
        this.virtqueue.push_reply(bufchain)
        this.virtqueue.flush_replies()

        this.tag_bufchain.delete(replytag)
    }

    handle_close(_e: CloseEvent): void {
        if (!this.destroyed) {
            this.connect()
            setTimeout(this.connect.bind(this), this.reconnect_interval)
        }
    }

    handle_open(_e: Event): void {
        for (let i = 0; i < this.send_queue.length; i++) {
            this.send(this.send_queue[i])
        }

        this.send_queue = []
    }

    handle_error(_e: Event): void {
        //console.log("onerror", e);
    }

    destroy(): void {
        this.destroyed = true
        if (this.socket) {
            this.socket.close()
        }
    }

    connect(): void {
        if (typeof WebSocket === 'undefined') {
            return
        }

        if (this.socket) {
            const state = this.socket.readyState

            if (state === 0 || state === 1) {
                // already or almost there
                return
            }
        }

        const now = Date.now()

        if (this.last_connect_attempt + this.reconnect_interval > now) {
            return
        }

        this.last_connect_attempt = Date.now()

        try {
            this.socket = new WebSocket(this.url)
        } catch (e) {
            console.error(e)
            return
        }

        this.socket.binaryType = 'arraybuffer'

        this.socket.onopen = this.handle_open.bind(this)
        this.socket.onmessage = this.handle_message.bind(this)
        this.socket.onclose = this.handle_close.bind(this)
        this.socket.onerror = this.handle_error.bind(this)
    }

    send(data: Uint8Array): void {
        if (!this.socket || this.socket.readyState !== 1) {
            this.send_queue.push(data)

            if (this.send_queue.length > 2 * this.send_queue_limit) {
                this.send_queue = this.send_queue.slice(-this.send_queue_limit)
            }

            this.connect()
        } else {
            // Copy into a plain ArrayBuffer for WebSocket.send() compatibility
            const buf = new ArrayBuffer(data.byteLength)
            new Uint8Array(buf).set(data)
            this.socket.send(buf)
        }
    }

    change_proxy(url: string): void {
        this.url = url

        if (this.socket) {
            this.socket.onclose = function () {}
            this.socket.onerror = function () {}
            this.socket.close()
            this.socket = undefined
        }
    }
}
