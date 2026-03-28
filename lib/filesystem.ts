// -------------------------------------------------
// ----------------- FILESYSTEM---------------------
// -------------------------------------------------
// Implementation of a unix filesystem in memory.

import { LOG_9P } from '../src/const.js'
import { h } from '../src/lib.js'
import { dbg_assert, dbg_log } from '../src/log.js'
import * as marshall from '../lib/marshall.js'
import { EEXIST, ENOTEMPTY, ENOENT, EPERM } from './9p.js'
import {
    P9_LOCK_SUCCESS,
    P9_LOCK_BLOCKED,
    P9_LOCK_TYPE_UNLCK,
    P9_LOCK_TYPE_WRLCK,
    P9_LOCK_TYPE_RDLCK,
} from './9p.js'

import type { QID } from '../lib/marshall.js'

// FileStorageInterface describes a backend for reading/writing file data.
export interface FileStorageInterface {
    read(
        sha256sum: string,
        offset: number,
        count: number,
        file_size: number,
    ): Promise<Uint8Array | null>
    cache(sha256sum: string, data: Uint8Array): Promise<void>
    uncache(sha256sum: string): void
}

export const S_IRWXUGO = 0x1ff
export const S_IFMT = 0xf000
export const S_IFSOCK = 0xc000
export const S_IFLNK = 0xa000
export const S_IFREG = 0x8000
export const S_IFBLK = 0x6000
export const S_IFDIR = 0x4000
export const S_IFCHR = 0x2000

//var S_IFIFO  0010000
//var S_ISUID  0004000
//var S_ISGID  0002000
//var S_ISVTX  0001000

const _O_RDONLY = 0x0000 // open for reading only
const _O_WRONLY = 0x0001 // open for writing only
const _O_RDWR = 0x0002 // open for reading and writing
const _O_ACCMODE = 0x0003 // mask for above modes

export const STATUS_INVALID = -0x1
export const STATUS_OK = 0x0
export const STATUS_ON_STORAGE = 0x2
export const STATUS_UNLINKED = 0x4
export const STATUS_FORWARDING = 0x5

const texten = new TextEncoder()

const JSONFS_VERSION = 3

const JSONFS_IDX_NAME = 0
const JSONFS_IDX_SIZE = 1
const JSONFS_IDX_MTIME = 2
const JSONFS_IDX_MODE = 3
const JSONFS_IDX_UID = 4
const JSONFS_IDX_GID = 5
const JSONFS_IDX_TARGET = 6
const JSONFS_IDX_SHA256 = 6

export interface QIDCounter {
    last_qidnumber: number
}

export interface SearchPathResult {
    id: number
    parentid: number
    name: string
    forward_path: string | null
}

export class FSLockRegion {
    type: number = P9_LOCK_TYPE_UNLCK
    start: number = 0
    length: number = Infinity
    proc_id: number = -1
    client_id: string = ''

    get_state(): any[] {
        const state: (number | string)[] = []

        state[0] = this.type
        state[1] = this.start
        // Infinity is not JSON.stringify-able
        state[2] = this.length === Infinity ? 0 : this.length
        state[3] = this.proc_id
        state[4] = this.client_id

        return state
    }

    set_state(state: any[]): void {
        this.type = state[0]
        this.start = state[1]
        this.length = state[2] === 0 ? Infinity : state[2]
        this.proc_id = state[3]
        this.client_id = state[4]
    }

    clone(): FSLockRegion {
        const new_region = new FSLockRegion()
        new_region.set_state(this.get_state())
        return new_region
    }

    conflicts_with(region: FSLockRegion): boolean {
        if (
            this.proc_id === region.proc_id &&
            this.client_id === region.client_id
        )
            return false
        if (
            this.type === P9_LOCK_TYPE_UNLCK ||
            region.type === P9_LOCK_TYPE_UNLCK
        )
            return false
        if (
            this.type !== P9_LOCK_TYPE_WRLCK &&
            region.type !== P9_LOCK_TYPE_WRLCK
        )
            return false
        if (this.start + this.length <= region.start) return false
        if (region.start + region.length <= this.start) return false
        return true
    }

    is_alike(region: FSLockRegion): boolean {
        return (
            region.proc_id === this.proc_id &&
            region.client_id === this.client_id &&
            region.type === this.type
        )
    }

    may_merge_after(region: FSLockRegion): boolean {
        return (
            this.is_alike(region) && region.start + region.length === this.start
        )
    }
}

export class Inode {
    direntries: Map<string, number> = new Map()
    status: number = 0
    size: number = 0x0
    uid: number = 0x0
    gid: number = 0x0
    fid: number = 0
    ctime: number = 0
    atime: number = 0
    mtime: number = 0
    major: number = 0x0
    minor: number = 0x0
    symlink: string = ''
    mode: number = 0x01ed
    qid: QID
    caps: Uint8Array | undefined = undefined
    nlinks: number = 0
    sha256sum: string = ''
    locks: FSLockRegion[] = []

    // For forwarders:
    mount_id: number = -1
    foreign_id: number = -1

    constructor(qidnumber: number) {
        this.qid = {
            type: 0,
            version: 0,
            path: qidnumber,
        }
    }

    get_state(): any[] {
        const state: any[] = []
        state[0] = this.mode

        if ((this.mode & S_IFMT) === S_IFDIR) {
            state[1] = [...this.direntries]
        } else if ((this.mode & S_IFMT) === S_IFREG) {
            state[1] = this.sha256sum
        } else if ((this.mode & S_IFMT) === S_IFLNK) {
            state[1] = this.symlink
        } else if ((this.mode & S_IFMT) === S_IFSOCK) {
            state[1] = [this.minor, this.major]
        } else {
            state[1] = null
        }

        state[2] = this.locks
        state[3] = this.status
        state[4] = this.size
        state[5] = this.uid
        state[6] = this.gid
        state[7] = this.fid
        state[8] = this.ctime
        state[9] = this.atime
        state[10] = this.mtime
        state[11] = this.qid.version
        state[12] = this.qid.path
        state[13] = this.nlinks

        //state[23] = this.mount_id;
        //state[24] = this.foreign_id;
        //state[25] = this.caps; // currently not writable
        return state
    }

    set_state(state: any[]): void {
        this.mode = state[0]

        if ((this.mode & S_IFMT) === S_IFDIR) {
            this.direntries = new Map()
            for (const [name, entry] of state[1]) {
                this.direntries.set(name, entry)
            }
        } else if ((this.mode & S_IFMT) === S_IFREG) {
            this.sha256sum = state[1]
        } else if ((this.mode & S_IFMT) === S_IFLNK) {
            this.symlink = state[1]
        } else if ((this.mode & S_IFMT) === S_IFSOCK) {
            ;[this.minor, this.major] = state[1]
        } else {
            // Nothing
        }

        this.locks = []
        for (const lock_state of state[2]) {
            const lock = new FSLockRegion()
            lock.set_state(lock_state)
            this.locks.push(lock)
        }
        this.status = state[3]
        this.size = state[4]
        this.uid = state[5]
        this.gid = state[6]
        this.fid = state[7]
        this.ctime = state[8]
        this.atime = state[9]
        this.mtime = state[10]
        this.qid.type = (this.mode & S_IFMT) >> 8
        this.qid.version = state[11]
        this.qid.path = state[12]
        this.nlinks = state[13]

        //this.mount_id = state[23];
        //this.foreign_id = state[24];
        //this.caps = state[20];
    }
}

class FSMountInfo {
    fs: FS
    backtrack: Map<number, number>

    constructor(filesystem: FS) {
        this.fs = filesystem
        this.backtrack = new Map()
    }

    get_state(): any[] {
        const state: any[] = []

        state[0] = this.fs
        state[1] = [...this.backtrack]

        return state
    }

    set_state(state: any[]): void {
        this.fs = state[0]
        this.backtrack = new Map(state[1])
    }
}

interface JsonFS {
    version: number

    fsroot: any[]
    size: number
}

export class FS {
    inodes: Inode[]
    storage: FileStorageInterface
    qidcounter: QIDCounter
    inodedata: Record<number, Uint8Array>
    total_size: number
    used_size: number
    mounts: FSMountInfo[]

    constructor(storage: FileStorageInterface, qidcounter?: QIDCounter) {
        this.inodes = []
        this.storage = storage
        this.qidcounter = qidcounter || { last_qidnumber: 0 }
        this.inodedata = {}
        this.total_size = 256 * 1024 * 1024 * 1024
        this.used_size = 0
        this.mounts = []

        // root entry
        this.CreateDirectory('', -1)
    }

    get_state(): any[] {
        let state: any[] = []

        state[0] = this.inodes
        state[1] = this.qidcounter.last_qidnumber
        state[2] = []
        for (const [id, data] of Object.entries(this.inodedata)) {
            if ((this.inodes[Number(id)].mode & S_IFDIR) === 0) {
                state[2].push([id, data])
            }
        }
        state[3] = this.total_size
        state[4] = this.used_size
        state = state.concat(this.mounts)

        return state
    }

    set_state(state: any[]): void {
        this.inodes = state[0].map((s: any) => {
            const inode = new Inode(0)
            inode.set_state(s)
            return inode
        })
        this.qidcounter.last_qidnumber = state[1]
        this.inodedata = {}
        for (const [key, rawValue] of state[2]) {
            let value = rawValue
            if (value.buffer.byteLength !== value.byteLength) {
                // make a copy if we didn't get one
                value = value.slice()
            }

            this.inodedata[key] = value
        }
        this.total_size = state[3]
        this.used_size = state[4]
        this.mounts = state.slice(5)
    }

    // -----------------------------------------------------

    load_from_json(fs: JsonFS): void {
        dbg_assert(!!fs, 'Invalid fs passed to load_from_json')

        if (fs['version'] !== JSONFS_VERSION) {
            throw 'The filesystem JSON format has changed. Please recreate the filesystem JSON.'
        }

        const fsroot = fs['fsroot']
        this.used_size = fs['size']

        for (let i = 0; i < fsroot.length; i++) {
            this.LoadRecursive(fsroot[i], 0)
        }
    }

    private LoadRecursive(data: any[], parentid: number): void {
        const inode = this.CreateInode()

        const name = data[JSONFS_IDX_NAME]
        inode.size = data[JSONFS_IDX_SIZE]
        inode.mtime = data[JSONFS_IDX_MTIME]
        inode.ctime = inode.mtime
        inode.atime = inode.mtime
        inode.mode = data[JSONFS_IDX_MODE]
        inode.uid = data[JSONFS_IDX_UID]
        inode.gid = data[JSONFS_IDX_GID]

        const ifmt = inode.mode & S_IFMT

        if (ifmt === S_IFDIR) {
            this.PushInode(inode, parentid, name)
            this.LoadDir(this.inodes.length - 1, data[JSONFS_IDX_TARGET])
        } else if (ifmt === S_IFREG) {
            inode.status = STATUS_ON_STORAGE
            inode.sha256sum = data[JSONFS_IDX_SHA256]
            dbg_assert(!!inode.sha256sum)
            this.PushInode(inode, parentid, name)
        } else if (ifmt === S_IFLNK) {
            inode.symlink = data[JSONFS_IDX_TARGET]
            this.PushInode(inode, parentid, name)
        } else if (ifmt === S_IFSOCK) {
            // socket: ignore
        } else {
            dbg_log('Unexpected ifmt: ' + h(ifmt) + ' (' + name + ')', LOG_9P)
        }
    }

    private LoadDir(parentid: number, children: any[]): void {
        for (let i = 0; i < children.length; i++) {
            this.LoadRecursive(children[i], parentid)
        }
    }

    // -----------------------------------------------------

    private should_be_linked(inode: Inode): boolean {
        // Note: Non-root forwarder inode could still have a non-forwarder parent, so don't use
        // parent inode to check.
        return !this.is_forwarder(inode) || inode.foreign_id === 0
    }

    private link_under_dir(parentid: number, idx: number, name: string): void {
        const inode = this.inodes[idx]
        const parent_inode = this.inodes[parentid]

        dbg_assert(
            !this.is_forwarder(parent_inode),
            "Filesystem: Shouldn't link under fowarder parents",
        )
        dbg_assert(
            this.IsDirectory(parentid),
            "Filesystem: Can't link under non-directories",
        )
        dbg_assert(
            this.should_be_linked(inode),
            "Filesystem: Can't link across filesystems apart from their root",
        )
        dbg_assert(
            inode.nlinks >= 0,
            'Filesystem: Found negative nlinks value of ' + inode.nlinks,
        )
        dbg_assert(
            !parent_inode.direntries.has(name),
            "Filesystem: Name '" + name + "' is already taken",
        )

        parent_inode.direntries.set(name, idx)
        inode.nlinks++

        if (this.IsDirectory(idx)) {
            dbg_assert(
                !inode.direntries.has('..'),
                'Filesystem: Cannot link a directory twice',
            )

            if (!inode.direntries.has('.')) inode.nlinks++
            inode.direntries.set('.', idx)

            inode.direntries.set('..', parentid)
            parent_inode.nlinks++
        }
    }

    private unlink_from_dir(parentid: number, name: string): void {
        const idx = this.Search(parentid, name)
        const inode = this.inodes[idx]
        const parent_inode = this.inodes[parentid]

        dbg_assert(
            !this.is_forwarder(parent_inode),
            "Filesystem: Can't unlink from forwarders",
        )
        dbg_assert(
            this.IsDirectory(parentid),
            "Filesystem: Can't unlink from non-directories",
        )

        const exists = parent_inode.direntries.delete(name)
        if (!exists) {
            dbg_assert(
                false,
                "Filesystem: Can't unlink non-existent file: " + name,
            )
            return
        }

        inode.nlinks--

        if (this.IsDirectory(idx)) {
            dbg_assert(
                inode.direntries.get('..') === parentid,
                'Filesystem: Found directory with bad parent id',
            )

            inode.direntries.delete('..')
            parent_inode.nlinks--
        }

        dbg_assert(
            inode.nlinks >= 0,
            'Filesystem: Found negative nlinks value of ' + inode.nlinks,
        )
    }

    PushInode(inode: Inode, parentid: number, name: string): void {
        if (parentid !== -1) {
            this.inodes.push(inode)
            inode.fid = this.inodes.length - 1
            this.link_under_dir(parentid, inode.fid, name)
            return
        } else {
            if (this.inodes.length === 0) {
                // if root directory
                this.inodes.push(inode)
                inode.direntries.set('.', 0)
                inode.direntries.set('..', 0)
                inode.nlinks = 2
                return
            }
        }

        dbg_assert(
            false,
            'Error in Filesystem: Pushed inode with name = ' +
                name +
                ' has no parent',
        )
    }

    private divert(parentid: number, filename: string): number {
        const old_idx = this.Search(parentid, filename)
        const old_inode = this.inodes[old_idx]
        const new_inode = new Inode(-1)

        dbg_assert(
            !!old_inode,
            'Filesystem divert: name (' + filename + ') not found',
        )
        dbg_assert(
            this.IsDirectory(old_idx) || old_inode.nlinks <= 1,
            "Filesystem: can't divert hardlinked file '" +
                filename +
                "' with nlinks=" +
                old_inode.nlinks,
        )

        // Shallow copy is alright.
        Object.assign(new_inode, old_inode)

        const idx = this.inodes.length
        this.inodes.push(new_inode)
        new_inode.fid = idx

        // Relink references
        if (this.is_forwarder(old_inode)) {
            this.mounts[old_inode.mount_id].backtrack.set(
                old_inode.foreign_id,
                idx,
            )
        }
        if (this.should_be_linked(old_inode)) {
            this.unlink_from_dir(parentid, filename)
            this.link_under_dir(parentid, idx, filename)
        }

        // Update children
        if (this.IsDirectory(old_idx) && !this.is_forwarder(old_inode)) {
            for (const [name, child_id] of new_inode.direntries) {
                if (name === '.' || name === '..') continue
                if (this.IsDirectory(child_id)) {
                    this.inodes[child_id].direntries.set('..', idx)
                }
            }
        }

        // Relocate local data if any.
        this.inodedata[idx] = this.inodedata[old_idx]
        delete this.inodedata[old_idx]

        // Retire old reference information.
        old_inode.direntries = new Map()
        old_inode.nlinks = 0

        return idx
    }

    private copy_inode(src_inode: Inode, dest_inode: Inode): void {
        Object.assign(dest_inode, src_inode, {
            fid: dest_inode.fid,
            direntries: dest_inode.direntries,
            nlinks: dest_inode.nlinks,
        })
    }

    CreateInode(): Inode {
        const now = Math.round(Date.now() / 1000)
        const inode = new Inode(++this.qidcounter.last_qidnumber)
        inode.atime = inode.ctime = inode.mtime = now
        return inode
    }

    // Note: parentid = -1 for initial root directory.
    CreateDirectory(name: string, parentid: number): number {
        const parent_inode = this.inodes[parentid]
        if (parentid >= 0 && this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = this.follow_fs(parent_inode).CreateDirectory(
                name,
                foreign_parentid,
            )
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const x = this.CreateInode()
        x.mode = 0x01ff | S_IFDIR
        if (parentid >= 0) {
            x.uid = this.inodes[parentid].uid
            x.gid = this.inodes[parentid].gid
            x.mode = (this.inodes[parentid].mode & 0x1ff) | S_IFDIR
        }
        x.qid.type = S_IFDIR >> 8
        this.PushInode(x, parentid, name)
        this.NotifyListeners(this.inodes.length - 1, 'newdir')
        return this.inodes.length - 1
    }

    CreateFile(filename: string, parentid: number): number {
        const parent_inode = this.inodes[parentid]
        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = this.follow_fs(parent_inode).CreateFile(
                filename,
                foreign_parentid,
            )
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const x = this.CreateInode()
        x.uid = this.inodes[parentid].uid
        x.gid = this.inodes[parentid].gid
        x.qid.type = S_IFREG >> 8
        x.mode = (this.inodes[parentid].mode & 0x1b6) | S_IFREG
        this.PushInode(x, parentid, filename)
        this.NotifyListeners(this.inodes.length - 1, 'newfile')
        return this.inodes.length - 1
    }

    CreateNode(
        filename: string,
        parentid: number,
        major: number,
        minor: number,
    ): number {
        const parent_inode = this.inodes[parentid]
        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = this.follow_fs(parent_inode).CreateNode(
                filename,
                foreign_parentid,
                major,
                minor,
            )
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const x = this.CreateInode()
        x.major = major
        x.minor = minor
        x.uid = this.inodes[parentid].uid
        x.gid = this.inodes[parentid].gid
        x.qid.type = S_IFSOCK >> 8
        x.mode = this.inodes[parentid].mode & 0x1b6
        this.PushInode(x, parentid, filename)
        return this.inodes.length - 1
    }

    CreateSymlink(filename: string, parentid: number, symlink: string): number {
        const parent_inode = this.inodes[parentid]
        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = this.follow_fs(parent_inode).CreateSymlink(
                filename,
                foreign_parentid,
                symlink,
            )
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const x = this.CreateInode()
        x.uid = this.inodes[parentid].uid
        x.gid = this.inodes[parentid].gid
        x.qid.type = S_IFLNK >> 8
        x.symlink = symlink
        x.mode = S_IFLNK
        this.PushInode(x, parentid, filename)
        return this.inodes.length - 1
    }

    async CreateTextFile(
        filename: string,
        parentid: number,
        str: string,
    ): Promise<number> {
        const parent_inode = this.inodes[parentid]
        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = await this.follow_fs(
                parent_inode,
            ).CreateTextFile(filename, foreign_parentid, str)
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const id = this.CreateFile(filename, parentid)
        const x = this.inodes[id]
        const data = new Uint8Array(str.length)
        x.size = str.length
        for (let j = 0; j < str.length; j++) {
            data[j] = str.charCodeAt(j)
        }
        await this.set_data(id, data)
        return id
    }

    async CreateBinaryFile(
        filename: string,
        parentid: number,
        buffer: Uint8Array,
    ): Promise<number> {
        const parent_inode = this.inodes[parentid]
        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = await this.follow_fs(
                parent_inode,
            ).CreateBinaryFile(filename, foreign_parentid, buffer)
            return this.create_forwarder(parent_inode.mount_id, foreign_id)
        }
        const id = this.CreateFile(filename, parentid)
        const x = this.inodes[id]
        const data = new Uint8Array(buffer.length)
        data.set(buffer)
        await this.set_data(id, data)
        x.size = buffer.length
        return id
    }

    async OpenInode(id: number, mode: number | undefined): Promise<void> {
        const inode = this.inodes[id]
        if (this.is_forwarder(inode)) {
            return await this.follow_fs(inode).OpenInode(inode.foreign_id, mode)
        }
        if ((inode.mode & S_IFMT) === S_IFDIR) {
            this.FillDirectory(id)
        }
    }

    async CloseInode(id: number): Promise<void> {
        const inode = this.inodes[id]
        if (this.is_forwarder(inode)) {
            return await this.follow_fs(inode).CloseInode(inode.foreign_id)
        }
        if (inode.status === STATUS_ON_STORAGE) {
            this.storage.uncache(inode.sha256sum)
        }
        if (inode.status === STATUS_UNLINKED) {
            inode.status = STATUS_INVALID
            await this.DeleteData(id)
        }
    }

    async Rename(
        olddirid: number,
        oldname: string,
        newdirid: number,
        newname: string,
    ): Promise<number> {
        if (olddirid === newdirid && oldname === newname) {
            return 0
        }
        const oldid = this.Search(olddirid, oldname)
        if (oldid === -1) {
            return -ENOENT
        }

        // For event notification near end of method.
        const oldpath = this.GetFullPath(olddirid) + '/' + oldname

        const newid = this.Search(newdirid, newname)
        if (newid !== -1) {
            const ret = this.Unlink(newdirid, newname)
            if (ret < 0) return ret
        }

        const idx = oldid // idx contains the id which we want to rename
        const inode = this.inodes[idx]
        const olddir = this.inodes[olddirid]
        const newdir = this.inodes[newdirid]

        if (!this.is_forwarder(olddir) && !this.is_forwarder(newdir)) {
            // Move inode within current filesystem.

            this.unlink_from_dir(olddirid, oldname)
            this.link_under_dir(newdirid, idx, newname)

            inode.qid.version++
        } else if (
            this.is_forwarder(olddir) &&
            olddir.mount_id === newdir.mount_id
        ) {
            // Move inode within the same child filesystem.

            const ret = await this.follow_fs(olddir).Rename(
                olddir.foreign_id,
                oldname,
                newdir.foreign_id,
                newname,
            )

            if (ret < 0) return ret
        } else if (this.is_a_root(idx)) {
            // The actual inode is a root of some descendant filesystem.
            // Moving mountpoint across fs not supported - needs to update all corresponding forwarders.
            dbg_log(
                'XXX: Attempted to move mountpoint (' + oldname + ') - skipped',
                LOG_9P,
            )
            return -EPERM
        } else if (!this.IsDirectory(idx) && this.GetInode(idx).nlinks > 1) {
            // Move hardlinked inode vertically in mount tree.
            dbg_log(
                'XXX: Attempted to move hardlinked file (' +
                    oldname +
                    ') ' +
                    'across filesystems - skipped',
                LOG_9P,
            )
            return -EPERM
        } else {
            // Jump between filesystems.

            // Can't work with both old and new inode information without first diverting the old
            // information into a new idx value.
            const diverted_old_idx = this.divert(olddirid, oldname)
            const old_real_inode = this.GetInode(idx)

            const data = await this.Read(
                diverted_old_idx,
                0,
                old_real_inode.size,
            )

            if (this.is_forwarder(newdir)) {
                // Create new inode.
                const foreign_fs = this.follow_fs(newdir)
                const foreign_id = this.IsDirectory(diverted_old_idx)
                    ? foreign_fs.CreateDirectory(newname, newdir.foreign_id)
                    : foreign_fs.CreateFile(newname, newdir.foreign_id)

                const new_real_inode = foreign_fs.GetInode(foreign_id)
                this.copy_inode(old_real_inode, new_real_inode)

                // Point to this new location.
                this.set_forwarder(idx, newdir.mount_id, foreign_id)
            } else {
                // Replace current forwarder with real inode.
                this.delete_forwarder(inode)
                this.copy_inode(old_real_inode, inode)

                // Link into new location in this filesystem.
                this.link_under_dir(newdirid, idx, newname)
            }

            // Rewrite data to newly created destination.
            await this.ChangeSize(idx, old_real_inode.size)
            if (data && data.length) {
                await this.Write(idx, 0, data.length, data)
            }

            // Move children to newly created destination.
            if (this.IsDirectory(idx)) {
                for (const child_filename of this.GetChildren(
                    diverted_old_idx,
                )) {
                    const ret = await this.Rename(
                        diverted_old_idx,
                        child_filename,
                        idx,
                        child_filename,
                    )
                    if (ret < 0) return ret
                }
            }

            // Perform destructive changes only after migration succeeded.
            await this.DeleteData(diverted_old_idx)
            const ret = this.Unlink(olddirid, oldname)
            if (ret < 0) return ret
        }

        this.NotifyListeners(idx, 'rename', { oldpath: oldpath })

        return 0
    }

    async Write(
        id: number,
        offset: number,
        count: number,
        buffer: Uint8Array | null,
    ): Promise<void> {
        this.NotifyListeners(id, 'write')
        const inode = this.inodes[id]

        if (this.is_forwarder(inode)) {
            const foreign_id = inode.foreign_id
            await this.follow_fs(inode).Write(foreign_id, offset, count, buffer)
            return
        }

        let data = await this.get_buffer(id)

        if (!data || data.length < offset + count) {
            await this.ChangeSize(id, Math.floor(((offset + count) * 3) / 2))
            inode.size = offset + count
            data = await this.get_buffer(id)
        } else if (inode.size < offset + count) {
            inode.size = offset + count
        }
        if (buffer && data) {
            data.set(buffer.subarray(0, count), offset)
        }
        if (data) {
            await this.set_data(id, data)
        }
    }

    async Read(
        inodeid: number,
        offset: number,
        count: number,
    ): Promise<Uint8Array | null> {
        const inode = this.inodes[inodeid]
        if (this.is_forwarder(inode)) {
            const foreign_id = inode.foreign_id
            return await this.follow_fs(inode).Read(foreign_id, offset, count)
        }

        return await this.get_data(inodeid, offset, count)
    }

    Search(parentid: number, name: string): number {
        const parent_inode = this.inodes[parentid]

        if (this.is_forwarder(parent_inode)) {
            const foreign_parentid = parent_inode.foreign_id
            const foreign_id = this.follow_fs(parent_inode).Search(
                foreign_parentid,
                name,
            )
            if (foreign_id === -1) return -1
            return this.get_forwarder(parent_inode.mount_id, foreign_id)
        }

        const childid = parent_inode.direntries.get(name)
        return childid === undefined ? -1 : childid
    }

    CountUsedInodes(): number {
        let count = this.inodes.length
        for (const { fs, backtrack } of this.mounts) {
            count += fs.CountUsedInodes()

            // Forwarder inodes don't count.
            count -= backtrack.size
        }
        return count
    }

    CountFreeInodes(): number {
        let count = 1024 * 1024
        for (const { fs } of this.mounts) {
            count += fs.CountFreeInodes()
        }
        return count
    }

    GetTotalSize(): number {
        let size = this.used_size
        for (const { fs } of this.mounts) {
            size += fs.GetTotalSize()
        }
        return size
    }

    GetSpace(): number {
        let size = this.total_size
        for (const { fs } of this.mounts) {
            size += fs.GetSpace()
        }
        return size
    }

    GetDirectoryName(idx: number): string {
        const parent_inode = this.inodes[this.GetParent(idx)]

        if (this.is_forwarder(parent_inode)) {
            return this.follow_fs(parent_inode).GetDirectoryName(
                this.inodes[idx].foreign_id,
            )
        }

        // Root directory.
        if (!parent_inode) return ''

        for (const [name, childid] of parent_inode.direntries) {
            if (childid === idx) return name
        }

        dbg_assert(
            false,
            "Filesystem: Found directory inode whose parent doesn't link to it",
        )
        return ''
    }

    GetFullPath(idx: number): string {
        dbg_assert(
            this.IsDirectory(idx),
            'Filesystem: Cannot get full path of non-directory inode',
        )

        let path = ''

        while (idx !== 0) {
            path = '/' + this.GetDirectoryName(idx) + path
            idx = this.GetParent(idx)
        }
        return path.substring(1)
    }

    Link(parentid: number, targetid: number, name: string): number {
        if (this.IsDirectory(targetid)) {
            return -EPERM
        }

        const parent_inode = this.inodes[parentid]
        const inode = this.inodes[targetid]

        if (this.is_forwarder(parent_inode)) {
            if (
                !this.is_forwarder(inode) ||
                inode.mount_id !== parent_inode.mount_id
            ) {
                dbg_log(
                    'XXX: Attempted to hardlink a file into a child filesystem - skipped',
                    LOG_9P,
                )
                return -EPERM
            }
            return this.follow_fs(parent_inode).Link(
                parent_inode.foreign_id,
                inode.foreign_id,
                name,
            )
        }

        if (this.is_forwarder(inode)) {
            dbg_log(
                'XXX: Attempted to hardlink file across filesystems - skipped',
                LOG_9P,
            )
            return -EPERM
        }

        this.link_under_dir(parentid, targetid, name)
        return 0
    }

    Unlink(parentid: number, name: string): number {
        if (name === '.' || name === '..') {
            // Also guarantees that root cannot be deleted.
            return -EPERM
        }
        const idx = this.Search(parentid, name)
        const inode = this.inodes[idx]
        const parent_inode = this.inodes[parentid]

        // forward if necessary
        if (this.is_forwarder(parent_inode)) {
            dbg_assert(
                this.is_forwarder(inode),
                'Children of forwarders should be forwarders',
            )

            const foreign_parentid = parent_inode.foreign_id
            return this.follow_fs(parent_inode).Unlink(foreign_parentid, name)

            // Keep the forwarder dangling - file is still accessible.
        }

        if (this.IsDirectory(idx) && !this.IsEmpty(idx)) {
            return -ENOTEMPTY
        }

        this.unlink_from_dir(parentid, name)

        if (inode.nlinks === 0) {
            // don't delete the content. The file is still accessible
            inode.status = STATUS_UNLINKED
            this.NotifyListeners(idx, 'delete')
        }
        return 0
    }

    async DeleteData(idx: number): Promise<void> {
        const inode = this.inodes[idx]
        if (this.is_forwarder(inode)) {
            await this.follow_fs(inode).DeleteData(inode.foreign_id)
            return
        }
        inode.size = 0
        delete this.inodedata[idx]
    }

    private async get_buffer(idx: number): Promise<Uint8Array | null> {
        const inode = this.inodes[idx]
        dbg_assert(
            !!inode,
            `Filesystem get_buffer: idx ${idx} does not point to an inode`,
        )

        if (this.inodedata[idx]) {
            return this.inodedata[idx]
        } else if (inode.status === STATUS_ON_STORAGE) {
            dbg_assert(
                !!inode.sha256sum,
                'Filesystem get_data: found inode on server without sha256sum',
            )
            return await this.storage.read(
                inode.sha256sum,
                0,
                inode.size,
                inode.size,
            )
        } else {
            return null
        }
    }

    private async get_data(
        idx: number,
        offset: number,
        count: number,
    ): Promise<Uint8Array | null> {
        const inode = this.inodes[idx]
        dbg_assert(
            !!inode,
            `Filesystem get_data: idx ${idx} does not point to an inode`,
        )

        if (this.inodedata[idx]) {
            return this.inodedata[idx].subarray(offset, offset + count)
        } else if (inode.status === STATUS_ON_STORAGE) {
            dbg_assert(
                !!inode.sha256sum,
                'Filesystem get_data: found inode on server without sha256sum',
            )
            return await this.storage.read(
                inode.sha256sum,
                offset,
                count,
                inode.size,
            )
        } else {
            return null
        }
    }

    private async set_data(idx: number, buffer: Uint8Array): Promise<void> {
        // Current scheme: Save all modified buffers into local inodedata.
        this.inodedata[idx] = buffer
        if (this.inodes[idx].status === STATUS_ON_STORAGE) {
            this.inodes[idx].status = STATUS_OK
            this.storage.uncache(this.inodes[idx].sha256sum)
        }
    }

    GetInode(idx: number): Inode {
        dbg_assert(!isNaN(idx), 'Filesystem GetInode: NaN idx')
        dbg_assert(
            idx >= 0 && idx < this.inodes.length,
            'Filesystem GetInode: out of range idx:' + idx,
        )

        const inode = this.inodes[idx]
        if (this.is_forwarder(inode)) {
            return this.follow_fs(inode).GetInode(inode.foreign_id)
        }

        return inode
    }

    async ChangeSize(idx: number, newsize: number): Promise<void> {
        const inode = this.GetInode(idx)
        const temp = await this.get_data(idx, 0, inode.size)
        if (newsize === inode.size) return
        const data = new Uint8Array(newsize)
        inode.size = newsize
        if (temp) {
            const size = Math.min(temp.length, inode.size)
            data.set(temp.subarray(0, size), 0)
        }
        await this.set_data(idx, data)
    }

    SearchPath(path: string): SearchPathResult {
        path = path.replace('//', '/')
        const walk = path.split('/')
        if (walk.length > 0 && walk[walk.length - 1].length === 0) walk.pop()
        if (walk.length > 0 && walk[0].length === 0) walk.shift()
        const n = walk.length

        let parentid = -1
        let id = 0
        let forward_path: string | null = null
        let i
        for (i = 0; i < n; i++) {
            parentid = id
            id = this.Search(parentid, walk[i])
            if (!forward_path && this.is_forwarder(this.inodes[parentid])) {
                forward_path = '/' + walk.slice(i).join('/')
            }
            if (id === -1) {
                if (i < n - 1)
                    return {
                        id: -1,
                        parentid: -1,
                        name: walk[i],
                        forward_path,
                    }
                return {
                    id: -1,
                    parentid: parentid,
                    name: walk[i],
                    forward_path,
                }
            }
        }
        return { id: id, parentid: parentid, name: walk[i], forward_path }
    }

    // -----------------------------------------------------

    GetRecursiveList(
        dirid: number,
        list: { parentid: number; name: string }[],
    ): void {
        if (this.is_forwarder(this.inodes[dirid])) {
            const foreign_fs = this.follow_fs(this.inodes[dirid])
            const foreign_dirid = this.inodes[dirid].foreign_id
            const mount_id = this.inodes[dirid].mount_id

            const foreign_start = list.length
            foreign_fs.GetRecursiveList(foreign_dirid, list)
            for (let i = foreign_start; i < list.length; i++) {
                list[i].parentid = this.get_forwarder(
                    mount_id,
                    list[i].parentid,
                )
            }
            return
        }
        for (const [name, id] of this.inodes[dirid].direntries) {
            if (name !== '.' && name !== '..') {
                list.push({ parentid: dirid, name })
                if (this.IsDirectory(id)) {
                    this.GetRecursiveList(id, list)
                }
            }
        }
    }

    RecursiveDelete(path: string): void {
        const toDelete: { parentid: number; name: string }[] = []
        const ids = this.SearchPath(path)
        if (ids.id === -1) return

        this.GetRecursiveList(ids.id, toDelete)

        for (let i = toDelete.length - 1; i >= 0; i--) {
            const ret = this.Unlink(toDelete[i].parentid, toDelete[i].name)
            dbg_assert(
                ret === 0,
                'Filesystem RecursiveDelete failed at parent=' +
                    toDelete[i].parentid +
                    ", name='" +
                    toDelete[i].name +
                    "' with error code: " +
                    -ret,
            )
        }
    }

    DeleteNode(path: string): void {
        const ids = this.SearchPath(path)
        if (ids.id === -1) return

        if ((this.inodes[ids.id].mode & S_IFMT) === S_IFREG) {
            const ret = this.Unlink(ids.parentid, ids.name)
            dbg_assert(
                ret === 0,
                'Filesystem DeleteNode failed with error code: ' + -ret,
            )
        } else if ((this.inodes[ids.id].mode & S_IFMT) === S_IFDIR) {
            this.RecursiveDelete(path)
            const ret = this.Unlink(ids.parentid, ids.name)
            dbg_assert(
                ret === 0,
                'Filesystem DeleteNode failed with error code: ' + -ret,
            )
        }
    }

    NotifyListeners(_id: number, _action: string, _info?: any): void {
        //if(info==undefined)
        //    info = {};
        //var path = this.GetFullPath(id);
        //if (this.watchFiles[path] === true && action=='write') {
        //  message.Send("WatchFileEvent", path);
        //}
        //for (var directory of this.watchDirectories) {
        //    if (this.watchDirectories.hasOwnProperty(directory)) {
        //        var indexOf = path.indexOf(directory)
        //        if(indexOf === 0 || indexOf === 1)
        //            message.Send("WatchDirectoryEvent", {path: path, event: action, info: info});
        //    }
        //}
    }

    Check(): void {
        for (let i = 1; i < this.inodes.length; i++) {
            if (this.inodes[i].status === STATUS_INVALID) continue

            const inode = this.GetInode(i)
            if (inode.nlinks < 0) {
                dbg_log(
                    'Error in filesystem: negative nlinks=' +
                        inode.nlinks +
                        ' at id =' +
                        i,
                    LOG_9P,
                )
            }

            if (this.IsDirectory(i)) {
                const inode = this.GetInode(i)
                if (this.IsDirectory(i) && this.GetParent(i) < 0) {
                    dbg_log(
                        'Error in filesystem: negative parent id ' + i,
                        LOG_9P,
                    )
                }
                for (const [name, id] of inode.direntries) {
                    if (name.length === 0) {
                        dbg_log(
                            'Error in filesystem: inode with no name and id ' +
                                id,
                            LOG_9P,
                        )
                    }

                    for (const c of name) {
                        if (c < ' ') {
                            dbg_log(
                                'Error in filesystem: Unallowed char in filename',
                                LOG_9P,
                            )
                        }
                    }
                }
            }
        }
    }

    FillDirectory(dirid: number): void {
        const inode = this.inodes[dirid]
        if (this.is_forwarder(inode)) {
            // XXX: The ".." of a mountpoint should point back to an inode in this fs.
            // Otherwise, ".." gets the wrong qid and mode.
            this.follow_fs(inode).FillDirectory(inode.foreign_id)
            return
        }

        let size = 0
        for (const name of inode.direntries.keys()) {
            size += 13 + 8 + 1 + 2 + texten.encode(name).length
        }
        const data = (this.inodedata[dirid] = new Uint8Array(size))
        inode.size = size

        let offset = 0x0
        for (const [name, id] of inode.direntries) {
            const child = this.GetInode(id)
            offset += marshall.Marshall(
                ['Q', 'd', 'b', 's'],
                [
                    child.qid,
                    offset + 13 + 8 + 1 + 2 + texten.encode(name).length,
                    child.mode >> 12,
                    name,
                ],
                data,
                offset,
            )
        }
    }

    RoundToDirentry(dirid: number, offset_target: number): number {
        const data = this.inodedata[dirid]
        dbg_assert(
            !!data,
            `FS directory data for dirid=${dirid} should be generated`,
        )
        dbg_assert(
            data.length > 0,
            'FS directory should have at least an entry',
        )

        if (offset_target >= data.length) {
            return data.length
        }

        let offset = 0
        while (true) {
            const next_offset = marshall.Unmarshall(['Q', 'd'], data, {
                offset,
            })[1]
            if (next_offset > offset_target) break
            offset = next_offset
        }

        return offset
    }

    IsDirectory(idx: number): boolean {
        const inode = this.inodes[idx]
        if (this.is_forwarder(inode)) {
            return this.follow_fs(inode).IsDirectory(inode.foreign_id)
        }
        return (inode.mode & S_IFMT) === S_IFDIR
    }

    IsEmpty(idx: number): boolean {
        const inode = this.inodes[idx]
        if (this.is_forwarder(inode)) {
            return this.follow_fs(inode).IsDirectory(inode.foreign_id)
        }
        for (const name of inode.direntries.keys()) {
            if (name !== '.' && name !== '..') return false
        }
        return true
    }

    GetChildren(idx: number): string[] {
        dbg_assert(
            this.IsDirectory(idx),
            'Filesystem: cannot get children of non-directory inode',
        )
        const inode = this.inodes[idx]
        if (this.is_forwarder(inode)) {
            return this.follow_fs(inode).GetChildren(inode.foreign_id)
        }
        const children: string[] = []
        for (const name of inode.direntries.keys()) {
            if (name !== '.' && name !== '..') {
                children.push(name)
            }
        }
        return children
    }

    GetParent(idx: number): number {
        dbg_assert(
            this.IsDirectory(idx),
            'Filesystem: cannot get parent of non-directory inode',
        )

        const inode = this.inodes[idx]

        if (this.should_be_linked(inode)) {
            return inode.direntries.get('..') ?? -1
        } else {
            const foreign_dirid = this.follow_fs(inode).GetParent(
                inode.foreign_id,
            )
            dbg_assert(
                foreign_dirid !== -1,
                'Filesystem: should not have invalid parent ids',
            )
            return this.get_forwarder(inode.mount_id, foreign_dirid)
        }
    }

    // -----------------------------------------------------

    // only support for security.capabilities
    PrepareCAPs(id: number): number {
        const inode = this.GetInode(id)
        if (inode.caps) return inode.caps.length
        inode.caps = new Uint8Array(20)
        // format is little endian
        // note: getxattr returns -EINVAL if using revision 1 format.
        // note: getxattr presents revision 3 as revision 2 when revision 3 is not needed.
        // magic_etc (revision=0x02: 20 bytes)
        inode.caps[0] = 0x00
        inode.caps[1] = 0x00
        inode.caps[2] = 0x00
        inode.caps[3] = 0x02

        // lower
        // permitted (first 32 capabilities)
        inode.caps[4] = 0xff
        inode.caps[5] = 0xff
        inode.caps[6] = 0xff
        inode.caps[7] = 0xff
        // inheritable (first 32 capabilities)
        inode.caps[8] = 0xff
        inode.caps[9] = 0xff
        inode.caps[10] = 0xff
        inode.caps[11] = 0xff

        // higher
        // permitted (last 6 capabilities)
        inode.caps[12] = 0x3f
        inode.caps[13] = 0x00
        inode.caps[14] = 0x00
        inode.caps[15] = 0x00
        // inheritable (last 6 capabilities)
        inode.caps[16] = 0x3f
        inode.caps[17] = 0x00
        inode.caps[18] = 0x00
        inode.caps[19] = 0x00

        return inode.caps.length
    }

    // -----------------------------------------------------

    private set_forwarder(
        idx: number,
        mount_id: number,
        foreign_id: number,
    ): void {
        const inode = this.inodes[idx]

        dbg_assert(
            inode.nlinks === 0,
            'Filesystem: attempted to convert an inode into forwarder before unlinking the inode',
        )

        if (this.is_forwarder(inode)) {
            this.mounts[inode.mount_id].backtrack.delete(inode.foreign_id)
        }

        inode.status = STATUS_FORWARDING
        inode.mount_id = mount_id
        inode.foreign_id = foreign_id

        this.mounts[mount_id].backtrack.set(foreign_id, idx)
    }

    private create_forwarder(mount_id: number, foreign_id: number): number {
        const inode = this.CreateInode()

        const idx = this.inodes.length
        this.inodes.push(inode)
        inode.fid = idx

        this.set_forwarder(idx, mount_id, foreign_id)
        return idx
    }

    private is_forwarder(inode: Inode): boolean {
        return inode.status === STATUS_FORWARDING
    }

    private is_a_root(idx: number): boolean {
        return this.GetInode(idx).fid === 0
    }

    private get_forwarder(mount_id: number, foreign_id: number): number {
        const mount = this.mounts[mount_id]

        dbg_assert(
            foreign_id >= 0,
            'Filesystem get_forwarder: invalid foreign_id: ' + foreign_id,
        )
        dbg_assert(
            !!mount,
            'Filesystem get_forwarder: invalid mount number: ' + mount_id,
        )

        const result = mount.backtrack.get(foreign_id)

        if (result === undefined) {
            // Create if not already exists.
            return this.create_forwarder(mount_id, foreign_id)
        }

        return result
    }

    private delete_forwarder(inode: Inode): void {
        dbg_assert(
            this.is_forwarder(inode),
            'Filesystem delete_forwarder: expected forwarder',
        )

        inode.status = STATUS_INVALID
        this.mounts[inode.mount_id].backtrack.delete(inode.foreign_id)
    }

    private follow_fs(inode: Inode): FS {
        const mount = this.mounts[inode.mount_id]

        dbg_assert(
            this.is_forwarder(inode),
            'Filesystem follow_fs: inode should be a forwarding inode',
        )
        dbg_assert(
            !!mount,
            'Filesystem follow_fs: inode<id=' +
                inode.fid +
                '> should point to valid mounted FS',
        )

        return mount.fs
    }

    Mount(path: string, fs: FS): number {
        dbg_assert(
            fs.qidcounter === this.qidcounter,
            "Cannot mount filesystem whose qid numbers aren't synchronised with current filesystem.",
        )

        const path_infos = this.SearchPath(path)

        if (path_infos.parentid === -1) {
            dbg_log('Mount failed: parent for path not found: ' + path, LOG_9P)
            return -ENOENT
        }
        if (path_infos.id !== -1) {
            dbg_log(
                'Mount failed: file already exists at path: ' + path,
                LOG_9P,
            )
            return -EEXIST
        }
        if (path_infos.forward_path) {
            const parent = this.inodes[path_infos.parentid]
            const ret = this.follow_fs(parent).Mount(
                path_infos.forward_path,
                fs,
            )
            if (ret < 0) return ret
            return this.get_forwarder(parent.mount_id, ret)
        }

        const mount_id = this.mounts.length
        this.mounts.push(new FSMountInfo(fs))

        const idx = this.create_forwarder(mount_id, 0)
        this.link_under_dir(path_infos.parentid, idx, path_infos.name)

        return idx
    }

    DescribeLock(
        type: number,
        start: number,
        length: number,
        proc_id: number,
        client_id: string,
    ): FSLockRegion {
        dbg_assert(
            type === P9_LOCK_TYPE_RDLCK ||
                type === P9_LOCK_TYPE_WRLCK ||
                type === P9_LOCK_TYPE_UNLCK,
            'Filesystem: Invalid lock type: ' + type,
        )
        dbg_assert(
            start >= 0,
            'Filesystem: Invalid negative lock starting offset: ' + start,
        )
        dbg_assert(
            length > 0,
            'Filesystem: Invalid non-positive lock length: ' + length,
        )

        const lock = new FSLockRegion()
        lock.type = type
        lock.start = start
        lock.length = length
        lock.proc_id = proc_id
        lock.client_id = client_id

        return lock
    }

    GetLock(id: number, request: FSLockRegion): FSLockRegion | null {
        const inode = this.inodes[id]

        if (this.is_forwarder(inode)) {
            const foreign_id = inode.foreign_id
            return this.follow_fs(inode).GetLock(foreign_id, request)
        }

        for (const region of inode.locks) {
            if (request.conflicts_with(region)) {
                return region.clone()
            }
        }
        return null
    }

    Lock(id: number, request: FSLockRegion, flags: number): number {
        const inode = this.inodes[id]

        if (this.is_forwarder(inode)) {
            const foreign_id = inode.foreign_id
            return this.follow_fs(inode).Lock(foreign_id, request, flags)
        }

        request = request.clone()

        // (1) Check whether lock is possible before any modification.
        if (request.type !== P9_LOCK_TYPE_UNLCK && this.GetLock(id, request)) {
            return P9_LOCK_BLOCKED
        }

        // (2) Subtract requested region from locks of the same owner.
        for (let i = 0; i < inode.locks.length; i++) {
            const region = inode.locks[i]

            dbg_assert(
                region.length > 0,
                'Filesystem: Found non-positive lock region length: ' +
                    region.length,
            )
            dbg_assert(
                region.type === P9_LOCK_TYPE_RDLCK ||
                    region.type === P9_LOCK_TYPE_WRLCK,
                'Filesystem: Found invalid lock type: ' + region.type,
            )
            dbg_assert(
                !inode.locks[i - 1] || inode.locks[i - 1].start <= region.start,
                'Filesystem: Locks should be sorted by starting offset',
            )

            // Skip to requested region.
            if (region.start + region.length <= request.start) continue

            // Check whether we've skipped past the requested region.
            if (request.start + request.length <= region.start) break

            // Skip over locks of different owners.
            if (
                region.proc_id !== request.proc_id ||
                region.client_id !== request.client_id
            ) {
                dbg_assert(
                    !region.conflicts_with(request),
                    'Filesytem: Found conflicting lock region, despite already checked for conflicts',
                )
                continue
            }

            // Pretend region would be split into parts 1 and 2.
            const start1 = region.start
            const start2 = request.start + request.length
            const length1 = request.start - start1
            const length2 = region.start + region.length - start2

            if (length1 > 0 && length2 > 0 && region.type === request.type) {
                // Requested region is already locked with the required type.
                // Return early - no need to modify anything.
                return P9_LOCK_SUCCESS
            }

            if (length1 > 0) {
                // Shrink from right / first half of the split.
                region.length = length1
            }

            if (length1 <= 0 && length2 > 0) {
                // Shrink from left.
                region.start = start2
                region.length = length2
            } else if (length2 > 0) {
                // Add second half of the split.

                // Fast-forward to correct location.
                while (i < inode.locks.length && inode.locks[i].start < start2)
                    i++

                inode.locks.splice(
                    i,
                    0,
                    this.DescribeLock(
                        region.type,
                        start2,
                        length2,
                        region.proc_id,
                        region.client_id,
                    ),
                )
            } else if (length1 <= 0) {
                // Requested region completely covers this region. Delete.
                inode.locks.splice(i, 1)
                i--
            }
        }

        // (3) Insert requested lock region as a whole.
        // No point in adding the requested lock region as fragmented bits in the above loop
        // and having to merge them all back into one.
        if (request.type !== P9_LOCK_TYPE_UNLCK) {
            let new_region = request
            let has_merged = false
            let i = 0

            // Fast-forward to requested position, and try merging with previous region.
            for (; i < inode.locks.length; i++) {
                if (new_region.may_merge_after(inode.locks[i])) {
                    inode.locks[i].length += request.length
                    new_region = inode.locks[i]
                    has_merged = true
                }
                if (request.start <= inode.locks[i].start) break
            }

            if (!has_merged) {
                inode.locks.splice(i, 0, new_region)
                i++
            }

            // Try merging with the subsequent alike region.
            for (; i < inode.locks.length; i++) {
                if (!inode.locks[i].is_alike(new_region)) continue

                if (inode.locks[i].may_merge_after(new_region)) {
                    new_region.length += inode.locks[i].length
                    inode.locks.splice(i, 1)
                }

                // No more mergable regions after this.
                break
            }
        }

        return P9_LOCK_SUCCESS
    }

    read_dir(path: string): string[] | undefined {
        const p = this.SearchPath(path)

        if (p.id === -1) {
            return undefined
        }

        const dir = this.GetInode(p.id)

        return Array.from(dir.direntries.keys()).filter(
            (path) => path !== '.' && path !== '..',
        )
    }

    read_file(file: string): Promise<Uint8Array | null> {
        const p = this.SearchPath(file)

        if (p.id === -1) {
            return Promise.resolve(null)
        }

        const inode = this.GetInode(p.id)

        return this.Read(p.id, 0, inode.size)
    }
}
