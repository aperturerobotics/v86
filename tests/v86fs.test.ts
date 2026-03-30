import { describe, it, expect } from 'vitest'
import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

// V86FS_DIR: directory containing bzImage, fs.json, flat/
// Set via env var or defaults to the wasivm prototype path for local dev.
const V86FS_DIR =
    process.env.V86FS_DIR ??
    path.resolve(__dirname, '../../wasivm/prototypes/debian-v86')
const HAS_PROTO = fs.existsSync(path.join(V86FS_DIR, 'bzImage'))
// V86FS_KERNEL: set to "1" when the bzImage includes CONFIG_V86_FS=y.
// Tests requiring v86fs root mount are skipped without this.
const HAS_V86FS_KERNEL = process.env.V86FS_KERNEL === '1'

const { V86 } = HAS_PROTO
    ? await import('../src/main.js')
    : ({ V86: undefined } as any)
const { INODE_MAP, FS_ENTRIES } = HAS_PROTO
    ? await import('../src/virtio_v86fs.js')
    : ({ INODE_MAP: undefined, FS_ENTRIES: undefined } as any)

import type { V86FSAdapter, V86FSDirEntry } from '../src/virtio_v86fs.js'

// Patch fetch to support file:// URLs and local paths for Node.js
const _origFetch = globalThis.fetch
globalThis.fetch = async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input.url
    if (u.startsWith('file://')) {
        const filePath = url.fileURLToPath(u)
        const data = fs.readFileSync(filePath)
        return new Response(data)
    }
    if (u.startsWith('/')) {
        const data = fs.readFileSync(u)
        return new Response(data)
    }
    return _origFetch(input, init)
}

// Helper: collect serial output into a string, resolve when marker appears
function waitForSerial(
    emulator: any,
    marker: string,
    timeout_ms = 120_000,
): Promise<string> {
    return new Promise((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `Timed out waiting for "${marker}" in serial output. Got so far:\n${buf.slice(-500)}`,
                ),
            )
        }, timeout_ms)

        function onByte(byte: number): void {
            buf += String.fromCharCode(byte)
            if (buf.includes(marker)) {
                clearTimeout(timer)
                emulator.remove_listener('serial0-output-byte', onByte)
                resolve(buf)
            }
        }
        emulator.add_listener('serial0-output-byte', onByte)
    })
}

// Strip ANSI escape codes and control sequences from serial output
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g
function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, '').replace(/\r/g, '')
}

// Helper: send a command and wait for the next shell prompt, return output
async function runCommand(
    emulator: any,
    cmd: string,
    prompt = ':/#',
    timeout_ms = 30_000,
): Promise<string> {
    const p = waitForSerial(emulator, prompt, timeout_ms)
    emulator.serial0_send(cmd + '\n')
    const buf = await p
    const clean = stripAnsi(buf)
    // Strip the echoed command and prompt from output
    const lines = clean.split('\n')
    // Find command echo line, take everything after it until the prompt
    const cmdIdx = lines.findIndex((l: string) => l.includes(cmd))
    const promptIdx = lines.findLastIndex((l: string) => l.includes(prompt))
    if (cmdIdx >= 0 && promptIdx > cmdIdx) {
        return lines
            .slice(cmdIdx + 1, promptIdx)
            .join('\n')
            .trim()
    }
    return clean
}

// Load handle9p from local tests/v86fs/ directory
async function loadHandle9p(): Promise<any> {
    const mod = await import(path.join(__dirname, 'v86fs/handle9p-server.mjs'))
    const fsJsonUrl = url.pathToFileURL(path.join(V86FS_DIR, 'fs.json')).href
    const flatUrl = url.pathToFileURL(path.join(V86FS_DIR, 'flat')).href + '/'
    return mod.createHandle9p(fsJsonUrl, flatUrl)
}

function createBootEmulator(handle9p: any): any {
    const bzImagePath = path.join(V86FS_DIR, 'bzImage')
    if (!fs.existsSync(bzImagePath)) {
        throw new Error(`bzImage not found at ${bzImagePath}`)
    }

    return new V86({
        wasm_path: path.resolve(__dirname, '../build/v86-debug.wasm'),
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: {
            url: path.resolve(__dirname, '../bios/seabios.bin'),
        },
        vga_bios: {
            url: path.resolve(__dirname, '../bios/vgabios.bin'),
        },
        bzimage: {
            url: bzImagePath,
        },
        cmdline:
            'rw init=/usr/bin/bash root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose console=ttyS0',
        filesystem: { handle9p },
        virtio_v86fs: true,
        autostart: true,
    })
}

// S_IF* mode bits for adapter tests
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const _S_IFLNK = 0o120000
const DT_DIR_C = 4
const DT_REG_C = 8

interface AdapterFsEntry {
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

/** Create a V86FSAdapter backed by in-memory Maps. */
function createMapAdapter(): {
    adapter: V86FSAdapter
    inodeMap: Map<number, AdapterFsEntry>
    fsEntries: Map<number, AdapterFsEntry[]>
    nextInodeId: { value: number }
    nextHandleId: { value: number }
    openHandles: Map<number, number>
} {
    const inodeMap = new Map<number, AdapterFsEntry>()
    const fsEntries = new Map<number, AdapterFsEntry[]>()
    const nextInodeId = { value: 100 }
    const nextHandleId = { value: 1 }
    const openHandles = new Map<number, number>()

    // Seed root dir (inode 1) with one file
    const rootEntry: AdapterFsEntry = {
        inode_id: 1,
        name: '',
        mode: S_IFDIR | 0o755,
        size: 0,
        dt_type: DT_DIR_C,
        mtime_sec: 1711500000,
        mtime_nsec: 0,
    }
    inodeMap.set(1, rootEntry)

    const fileEntry: AdapterFsEntry = {
        inode_id: 2,
        name: 'adapter-file.txt',
        mode: S_IFREG | 0o644,
        size: 20,
        dt_type: DT_REG_C,
        mtime_sec: 1711500000,
        mtime_nsec: 0,
        content: new TextEncoder().encode('adapter hello world\n'),
    }
    inodeMap.set(2, fileEntry)
    fsEntries.set(1, [fileEntry])

    const adapter: V86FSAdapter = {
        onMount(name, reply) {
            reply(0, 1, rootEntry.mode)
        },
        onLookup(parent_id, name, reply) {
            const children = fsEntries.get(parent_id)
            const entry = children?.find((e) => e.name === name)
            if (!entry) {
                reply(2, 0, 0, 0) // ENOENT
                return
            }
            reply(0, entry.inode_id, entry.mode, entry.size)
        },
        onGetattr(inode_id, reply) {
            const entry = inodeMap.get(inode_id)
            if (!entry) {
                reply(2, 0, 0, 0, 0)
                return
            }
            reply(0, entry.mode, entry.size, entry.mtime_sec, entry.mtime_nsec)
        },
        onReaddir(dir_id, reply) {
            const entries = fsEntries.get(dir_id) || []
            const result: V86FSDirEntry[] = entries.map((e) => ({
                inode_id: e.inode_id,
                dt_type: e.dt_type,
                name: e.name,
            }))
            reply(0, result)
        },
        onOpen(inode_id, _flags, reply) {
            const hid = nextHandleId.value++
            openHandles.set(hid, inode_id)
            reply(0, hid)
        },
        onClose(handle_id, reply) {
            openHandles.delete(handle_id)
            reply(0)
        },
        onRead(handle_id, offset, size, reply) {
            const iid = openHandles.get(handle_id) ?? handle_id
            const entry = inodeMap.get(iid)
            const content = entry?.content
            if (!content || offset >= content.length) {
                reply(0, new Uint8Array(0))
                return
            }
            const start = Math.min(offset, content.length)
            const end = Math.min(start + size, content.length)
            reply(0, content.subarray(start, end))
        },
        onCreate(parent_id, name, mode, reply) {
            const iid = nextInodeId.value++
            const entry: AdapterFsEntry = {
                inode_id: iid,
                name,
                mode: mode | S_IFREG,
                size: 0,
                dt_type: DT_REG_C,
                mtime_sec: Math.floor(Date.now() / 1000),
                mtime_nsec: 0,
                content: new Uint8Array(0),
            }
            let children = fsEntries.get(parent_id)
            if (!children) {
                children = []
                fsEntries.set(parent_id, children)
            }
            children.push(entry)
            inodeMap.set(iid, entry)
            reply(0, iid, entry.mode)
        },
        onWrite(inode_id, offset, data, reply) {
            const entry = inodeMap.get(inode_id)
            if (entry) {
                const needed = offset + data.length
                if (!entry.content || entry.content.length < needed) {
                    const nc = new Uint8Array(needed)
                    if (entry.content) nc.set(entry.content)
                    entry.content = nc
                }
                entry.content.set(data, offset)
                if (needed > entry.size) entry.size = needed
            }
            reply(0, data.length)
        },
        onMkdir(parent_id, name, mode, reply) {
            const iid = nextInodeId.value++
            const entry: AdapterFsEntry = {
                inode_id: iid,
                name,
                mode: mode | S_IFDIR,
                size: 0,
                dt_type: DT_DIR_C,
                mtime_sec: Math.floor(Date.now() / 1000),
                mtime_nsec: 0,
            }
            let children = fsEntries.get(parent_id)
            if (!children) {
                children = []
                fsEntries.set(parent_id, children)
            }
            children.push(entry)
            inodeMap.set(iid, entry)
            fsEntries.set(iid, [])
            reply(0, iid, entry.mode)
        },
        onSetattr(inode_id, valid, mode, size, reply) {
            const entry = inodeMap.get(inode_id)
            if (entry) {
                if (valid & 1)
                    entry.mode = (entry.mode & 0o170000) | (mode & 0o7777)
                if (valid & 8) {
                    entry.size = size
                    if (entry.content) {
                        if (size === 0) entry.content = new Uint8Array(0)
                        else if (size < entry.content.length)
                            entry.content = entry.content.subarray(0, size)
                    }
                }
            }
            reply(0)
        },
        onFsync(_inode_id, reply) {
            reply(0)
        },
        onUnlink(parent_id, name, reply) {
            const children = fsEntries.get(parent_id)
            if (children) {
                const idx = children.findIndex((e) => e.name === name)
                if (idx >= 0) {
                    const e = children[idx]
                    inodeMap.delete(e.inode_id)
                    fsEntries.delete(e.inode_id)
                    children.splice(idx, 1)
                    reply(0)
                    return
                }
            }
            reply(2)
        },
        onRename(old_parent_id, old_name, new_parent_id, new_name, reply) {
            const oldChildren = fsEntries.get(old_parent_id)
            if (!oldChildren) {
                reply(2)
                return
            }
            const idx = oldChildren.findIndex((e) => e.name === old_name)
            if (idx < 0) {
                reply(2)
                return
            }
            const entry = oldChildren[idx]
            oldChildren.splice(idx, 1)
            entry.name = new_name
            let newChildren = fsEntries.get(new_parent_id)
            if (!newChildren) {
                newChildren = []
                fsEntries.set(new_parent_id, newChildren)
            }
            newChildren.push(entry)
            reply(0)
        },
        onStatfs(reply) {
            reply(
                0,
                1024 * 1024,
                512 * 1024,
                512 * 1024,
                1024 * 1024,
                512 * 1024,
                4096,
            )
        },
    }

    return {
        adapter,
        inodeMap,
        fsEntries,
        nextInodeId,
        nextHandleId,
        openHandles,
    }
}

function createAdapterEmulator(handle9p: any, adapter: V86FSAdapter): any {
    const bzImagePath = path.join(V86FS_DIR, 'bzImage')
    return new V86({
        wasm_path: path.resolve(__dirname, '../build/v86-debug.wasm'),
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: {
            url: path.resolve(__dirname, '../bios/seabios.bin'),
        },
        vga_bios: {
            url: path.resolve(__dirname, '../bios/vgabios.bin'),
        },
        bzimage: {
            url: bzImagePath,
        },
        cmdline:
            'rw init=/usr/bin/bash root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose console=ttyS0',
        filesystem: { handle9p },
        virtio_v86fs: true,
        virtio_v86fs_adapter: adapter,
        autostart: true,
    })
}

describe.skipIf(!HAS_V86FS_KERNEL)('v86fs', { timeout: 180_000 }, () => {
    it('kernel driver probes and filesystem registers', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            // Wait for shell prompt
            await waitForSerial(emulator, ':/#', 120_000)

            // Check dmesg for v86fs driver probe
            const dmesg = await runCommand(emulator, 'dmesg | grep v86fs')
            expect(dmesg).toContain('v86fs: probed')
            expect(dmesg).toContain('3 virtqueues ready')
            expect(dmesg).toContain('v86fs: registered')

            // Verify /mnt exists and mount v86fs
            const mkdirResult = await runCommand(
                emulator,
                'mkdir -p /mnt && stat -c "%F" /mnt',
            )
            expect(mkdirResult).toContain('directory')

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // ls /mnt should show hardcoded entries from host
            const lsResult = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsResult).toContain('hello.txt')
            expect(lsResult).toContain('subdir')

            // stat should show correct size from GETATTR
            const statResult = await runCommand(
                emulator,
                'stat -c "%s %F" /mnt/hello.txt 2>&1',
            )
            expect(statResult).toContain('12 regular')

            // cat should show file content via OPEN + READ + CLOSE
            let openCount = 0
            let closeCount = 0
            emulator.add_listener('virtio-v86fs-open', () => openCount++)
            emulator.add_listener('virtio-v86fs-close', () => closeCount++)

            const catResult = await runCommand(
                emulator,
                'cat /mnt/hello.txt 2>&1',
            )
            expect(catResult).toContain('hello world')
            expect(openCount).toBeGreaterThanOrEqual(1)
            expect(closeCount).toBeGreaterThanOrEqual(1)

            // CREATE: touch creates new file
            const touchResult = await runCommand(
                emulator,
                'touch /mnt/newfile 2>&1; echo "EXIT:$?"',
            )
            expect(touchResult).toContain('EXIT:0')

            // WRITE: echo writes content to file
            const writeResult = await runCommand(
                emulator,
                'echo hello > /mnt/test.txt 2>&1; echo "EXIT:$?"',
            )
            expect(writeResult).toContain('EXIT:0')

            // Verify written content
            const readBack = await runCommand(
                emulator,
                'cat /mnt/test.txt 2>&1',
            )
            expect(readBack).toContain('hello')

            // MKDIR: create subdirectory
            const mkdirResult2 = await runCommand(
                emulator,
                'mkdir /mnt/newdir 2>&1; echo "EXIT:$?"',
            )
            expect(mkdirResult2).toContain('EXIT:0')

            // Verify new dir appears
            const lsResult2 = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsResult2).toContain('newdir')

            // SETATTR: chmod
            const chmodResult = await runCommand(
                emulator,
                'chmod 755 /mnt/test.txt 2>&1; echo "EXIT:$?"',
            )
            expect(chmodResult).toContain('EXIT:0')

            // SETATTR: truncate
            const truncResult = await runCommand(
                emulator,
                'truncate -s 0 /mnt/test.txt 2>&1; echo "EXIT:$?"',
            )
            expect(truncResult).toContain('EXIT:0')

            // FSYNC: sync completes
            const syncResult = await runCommand(
                emulator,
                'sync 2>&1; echo "EXIT:$?"',
            )
            expect(syncResult).toContain('EXIT:0')

            // UNLINK: rm removes a file
            const rmResult = await runCommand(
                emulator,
                'rm /mnt/newfile 2>&1; echo "EXIT:$?"',
            )
            expect(rmResult).toContain('EXIT:0')
            const lsAfterRm = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsAfterRm).not.toContain('newfile')

            // RENAME: mv renames a file
            const mvResult = await runCommand(
                emulator,
                'mv /mnt/test.txt /mnt/renamed.txt 2>&1; echo "EXIT:$?"',
            )
            expect(mvResult).toContain('EXIT:0')
            const lsAfterMv = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsAfterMv).toContain('renamed.txt')
            expect(lsAfterMv).not.toContain('test.txt')

            // SYMLINK + READLINK
            const lnResult = await runCommand(
                emulator,
                'ln -s target /mnt/link 2>&1; echo "EXIT:$?"',
            )
            expect(lnResult).toContain('EXIT:0')
            const readlinkResult = await runCommand(
                emulator,
                'readlink /mnt/link 2>&1',
            )
            expect(readlinkResult).toContain('target')

            // STATFS: df shows filesystem info
            const dfResult = await runCommand(emulator, 'df /mnt 2>&1')
            expect(dfResult).toContain('/mnt')

            // Unmount
            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('push invalidation updates cached file content', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Read hello.txt to cache it in page cache
            const cat1 = await runCommand(emulator, 'cat /mnt/hello.txt 2>&1')
            expect(cat1).toContain('hello world')

            // Modify the file content on the host side directly
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const helloEntry = INODE_MAP.get(2) // hello.txt inode=2
            expect(helloEntry).toBeDefined()
            const newContent = new TextEncoder().encode('modified content\n')
            helloEntry!.content = newContent
            helloEntry!.size = newContent.length

            // Send INVALIDATE to evict page cache
            const sent = v86fs.invalidate_inode(2)
            expect(sent).toBe(true)

            // Small delay for interrupt processing
            await new Promise((r) => setTimeout(r, 200))

            // Drop the dentry cache too so the inode re-reads attrs
            await runCommand(emulator, 'echo 2 > /proc/sys/vm/drop_caches 2>&1')

            // Re-read the file - should show new content
            const cat2 = await runCommand(emulator, 'cat /mnt/hello.txt 2>&1')
            expect(cat2).toContain('modified content')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            // Restore original content for other tests
            const helloEntry = INODE_MAP.get(2)
            if (helloEntry) {
                const orig = new TextEncoder().encode('hello world\n')
                helloEntry.content = orig
                helloEntry.size = orig.length
            }
            await emulator.destroy()
        }
    })

    it('push invalidation updates directory listing', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // ls to populate dcache
            const ls1 = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(ls1).toContain('hello.txt')
            expect(ls1).not.toContain('injected.txt')

            // Host adds a new file entry directly
            const entry = {
                inode_id: 200,
                name: 'injected.txt',
                mode: 0o100644,
                size: 5,
                dt_type: 8,
                mtime_sec: Math.floor(Date.now() / 1000),
                mtime_nsec: 0,
                content: new TextEncoder().encode('hello'),
            }
            const rootChildren = FS_ENTRIES.get(1)!
            rootChildren.push(entry)
            INODE_MAP.set(200, entry)

            // Send INVALIDATE_DIR for root dir (inode 1)
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const sent = v86fs.invalidate_dir(1)
            expect(sent).toBe(true)

            // Small delay for interrupt processing
            await new Promise((r) => setTimeout(r, 200))

            // ls should now show the new file
            const ls2 = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(ls2).toContain('injected.txt')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            // Clean up injected entry
            const rootChildren = FS_ENTRIES.get(1)
            if (rootChildren) {
                const idx = rootChildren.findIndex(
                    (e: any) => e.name === 'injected.txt',
                )
                if (idx >= 0) rootChildren.splice(idx, 1)
            }
            INODE_MAP.delete(200)
            await emulator.destroy()
        }
    })

    it('nested directory operations and cross-dir rename', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Create nested directories
            const mkdirNested = await runCommand(
                emulator,
                'mkdir -p /mnt/a/b 2>&1; echo "EXIT:$?"',
            )
            expect(mkdirNested).toContain('EXIT:0')

            // Write a file inside nested dir
            const writeNested = await runCommand(
                emulator,
                'echo nested > /mnt/a/b/file.txt 2>&1; echo "EXIT:$?"',
            )
            expect(writeNested).toContain('EXIT:0')

            // Read it back
            const catNested = await runCommand(
                emulator,
                'cat /mnt/a/b/file.txt 2>&1',
            )
            expect(catNested).toContain('nested')

            // Rename across directories
            const mvCross = await runCommand(
                emulator,
                'mv /mnt/a/b/file.txt /mnt/a/moved.txt 2>&1; echo "EXIT:$?"',
            )
            expect(mvCross).toContain('EXIT:0')

            // Verify moved
            const lsA = await runCommand(emulator, 'ls /mnt/a 2>&1')
            expect(lsA).toContain('moved.txt')
            const lsB = await runCommand(emulator, 'ls /mnt/a/b 2>&1')
            expect(lsB).not.toContain('file.txt')

            // rmdir on empty dir
            const rmdirResult = await runCommand(
                emulator,
                'rmdir /mnt/a/b 2>&1; echo "EXIT:$?"',
            )
            expect(rmdirResult).toContain('EXIT:0')

            // Write larger content and read back
            const writeLarge = await runCommand(
                emulator,
                'seq 1 100 > /mnt/numbers.txt 2>&1; echo "EXIT:$?"',
            )
            expect(writeLarge).toContain('EXIT:0')

            const wcResult = await runCommand(
                emulator,
                'wc -l /mnt/numbers.txt 2>&1',
            )
            expect(wcResult).toContain('100')

            // Verify content integrity
            const headResult = await runCommand(
                emulator,
                'head -3 /mnt/numbers.txt 2>&1',
            )
            expect(headResult).toContain('1')
            expect(headResult).toContain('2')
            expect(headResult).toContain('3')

            const tailResult = await runCommand(
                emulator,
                'tail -1 /mnt/numbers.txt 2>&1',
            )
            expect(tailResult).toContain('100')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('large file write and read back across multiple pages', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Write a 16KB file (4 pages) with known pattern
            const writeResult = await runCommand(
                emulator,
                'dd if=/dev/zero bs=1024 count=16 2>/dev/null | tr "\\0" "A" > /mnt/large.bin 2>&1; echo "EXIT:$?"',
            )
            expect(writeResult).toContain('EXIT:0')

            // Verify size
            const statResult = await runCommand(
                emulator,
                'stat -c "%s" /mnt/large.bin 2>&1',
            )
            expect(parseInt(statResult.trim())).toBe(16384)

            // Read back and verify content integrity
            const md5Write = await runCommand(
                emulator,
                'md5sum /mnt/large.bin 2>&1',
            )

            // Write again with different content and verify it changed
            const writeResult2 = await runCommand(
                emulator,
                'dd if=/dev/zero bs=1024 count=16 2>/dev/null | tr "\\0" "B" > /mnt/large.bin 2>&1; echo "EXIT:$?"',
            )
            expect(writeResult2).toContain('EXIT:0')

            const md5Write2 = await runCommand(
                emulator,
                'md5sum /mnt/large.bin 2>&1',
            )
            // Hashes should differ since content changed
            expect(md5Write2).not.toBe(md5Write)

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('symlink traversal reads target file content', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Create a file and a symlink to it
            await runCommand(
                emulator,
                'echo "symlink target content" > /mnt/real.txt',
            )
            const lnResult = await runCommand(
                emulator,
                'ln -s real.txt /mnt/sym.txt 2>&1; echo "EXIT:$?"',
            )
            expect(lnResult).toContain('EXIT:0')

            // Read through symlink
            const catResult = await runCommand(
                emulator,
                'cat /mnt/sym.txt 2>&1',
            )
            expect(catResult).toContain('symlink target content')

            // stat -L follows symlink and shows regular file
            const statResult = await runCommand(
                emulator,
                'stat -L -c "%F %s" /mnt/sym.txt 2>&1',
            )
            expect(statResult).toContain('regular file')

            // ls -l shows symlink type
            const lsResult = await runCommand(
                emulator,
                'ls -l /mnt/sym.txt 2>&1',
            )
            expect(lsResult).toContain('->')
            expect(lsResult).toContain('real.txt')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('file permissions are preserved across chmod and stat', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Create file with default perms
            await runCommand(emulator, 'touch /mnt/perms.txt')

            // chmod to various modes and verify each
            for (const mode of ['644', '755', '600', '777', '444']) {
                const chmodResult = await runCommand(
                    emulator,
                    `chmod ${mode} /mnt/perms.txt 2>&1; echo "EXIT:$?"`,
                )
                expect(chmodResult).toContain('EXIT:0')

                const statResult = await runCommand(
                    emulator,
                    'stat -c "%a" /mnt/perms.txt 2>&1',
                )
                expect(statResult).toContain(mode)
            }

            // Verify directory chmod too
            await runCommand(emulator, 'mkdir /mnt/permdir')
            await runCommand(emulator, 'chmod 700 /mnt/permdir')
            const dirStat = await runCommand(
                emulator,
                'stat -c "%a %F" /mnt/permdir 2>&1',
            )
            expect(dirStat).toContain('700')
            expect(dirStat).toContain('directory')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('overwrite existing file replaces content', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Write initial content
            await runCommand(
                emulator,
                'echo "first version" > /mnt/overwrite.txt',
            )
            const cat1 = await runCommand(
                emulator,
                'cat /mnt/overwrite.txt 2>&1',
            )
            expect(cat1).toContain('first version')

            // Overwrite with shorter content
            await runCommand(emulator, 'echo "v2" > /mnt/overwrite.txt')
            const cat2 = await runCommand(
                emulator,
                'cat /mnt/overwrite.txt 2>&1',
            )
            expect(cat2).toContain('v2')
            expect(cat2).not.toContain('first version')

            // Verify size matches new content (v2 + newline = 3 bytes)
            const statResult = await runCommand(
                emulator,
                'stat -c "%s" /mnt/overwrite.txt 2>&1',
            )
            expect(parseInt(statResult.trim())).toBe(3)

            // Append mode
            await runCommand(emulator, 'echo "appended" >> /mnt/overwrite.txt')
            const cat3 = await runCommand(
                emulator,
                'cat /mnt/overwrite.txt 2>&1',
            )
            expect(cat3).toContain('v2')
            expect(cat3).toContain('appended')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('mount unmount remount cycle preserves no stale state', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            // First mount: create files
            const mountResult = await runCommand(
                emulator,
                'mkdir -p /mnt && mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Verify mount is working
            const lsCheck = await runCommand(
                emulator,
                'ls /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(lsCheck).toContain('hello.txt')

            await runCommand(emulator, 'echo "persist" > /mnt/cycle.txt')
            const cat1 = await runCommand(emulator, 'cat /mnt/cycle.txt 2>&1')
            expect(cat1).toContain('persist')

            // Ensure /proc is mounted for umount to work
            await runCommand(
                emulator,
                'mount -t proc proc /proc 2>/dev/null; true',
            )

            // Unmount
            const umountResult = await runCommand(
                emulator,
                'sync && umount /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(umountResult).toContain('EXIT:0')

            // Verify /mnt is now empty (no v86fs content)
            const lsAfterUmount = await runCommand(
                emulator,
                'ls /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(lsAfterUmount).not.toContain('cycle.txt')

            // Remount
            const remountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(remountResult).toContain('EXIT:0')

            // File should still exist (host-side state persists)
            const cat2 = await runCommand(emulator, 'cat /mnt/cycle.txt 2>&1')
            expect(cat2).toContain('persist')

            // Can create new files after remount
            await runCommand(
                emulator,
                'echo "after remount" > /mnt/new_after.txt',
            )
            const cat3 = await runCommand(
                emulator,
                'cat /mnt/new_after.txt 2>&1',
            )
            expect(cat3).toContain('after remount')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('page cache serves repeated reads without host requests', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )

            // Track READ requests from host
            let readCount = 0
            emulator.add_listener('virtio-v86fs-read', () => readCount++)

            // First read populates page cache
            const cat1 = await runCommand(emulator, 'cat /mnt/hello.txt 2>&1')
            expect(cat1).toContain('hello world')
            const firstReadCount = readCount

            // Second read should come from page cache (no new READ)
            const cat2 = await runCommand(emulator, 'cat /mnt/hello.txt 2>&1')
            expect(cat2).toContain('hello world')
            expect(readCount).toBe(firstReadCount)

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('git init, add, and commit on v86fs mount', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Disable pager for all git commands
            await runCommand(
                emulator,
                'export GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0',
            )

            // Check git is available
            const gitVersion = await runCommand(
                emulator,
                'git --version 2>&1; echo "EXIT:$?"',
            )
            expect(gitVersion).toContain('git version')
            expect(gitVersion).toContain('EXIT:0')

            // git init
            const initResult = await runCommand(
                emulator,
                'git init /mnt 2>&1; echo "EXIT:$?"',
                ':/#',
                60_000,
            )
            expect(initResult).toContain('EXIT:0')

            // Configure git identity (required for commit)
            await runCommand(
                emulator,
                'git -C /mnt config user.email "test@test" 2>&1',
            )
            await runCommand(
                emulator,
                'git -C /mnt config user.name "Test" 2>&1',
            )
            // Suppress detached HEAD advice
            await runCommand(
                emulator,
                'git -C /mnt config advice.detachedHead false 2>&1',
            )

            // Create a file and commit
            await runCommand(
                emulator,
                'echo "hello v86fs" > /mnt/file.txt 2>&1',
            )
            const addResult = await runCommand(
                emulator,
                'git -C /mnt add file.txt 2>&1; echo "EXIT:$?"',
            )
            expect(addResult).toContain('EXIT:0')

            const commitResult = await runCommand(
                emulator,
                'git -C /mnt commit -m "initial commit" 2>&1; echo "EXIT:$?"',
                ':/#',
                60_000,
            )
            expect(commitResult).toContain('EXIT:0')

            // Verify commit exists in log
            const logResult = await runCommand(
                emulator,
                'git -C /mnt log --oneline 2>&1',
            )
            expect(logResult).toContain('initial commit')

            // Verify file.txt is committed (not in porcelain output)
            const statusResult = await runCommand(
                emulator,
                'git -C /mnt status --porcelain 2>&1; echo "EXIT:$?"',
            )
            expect(statusResult).toContain('EXIT:0')
            expect(statusResult).not.toContain('file.txt')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('sends MOUNT message with root name to host', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        let mountName: string | undefined
        emulator.add_listener('virtio-v86fs-mount', (name: string) => {
            mountName = name
        })

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            // Mount with -o name=workspace
            const result = await runCommand(
                emulator,
                'mount -t v86fs none /mnt -o name=workspace 2>&1; echo "EXIT:$?"',
            )
            expect(result).toContain('EXIT:0')

            // Verify host received the mount name
            expect(mountName).toBe('workspace')

            // ls should still work (empty dir from hardcoded root)
            const lsResult = await runCommand(emulator, 'ls -la /mnt 2>&1')
            expect(lsResult).toContain('total')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('partial page cache invalidation refreshes only the targeted range', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Create a large file spanning multiple pages (3 x 4096 = 12288 bytes)
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const inode_id = 300
            const pageSize = 4096
            const pageCount = 3
            const totalSize = pageSize * pageCount

            // Build content: page 0 = 'A' repeated, page 1 = 'B' repeated, page 2 = 'C' repeated
            const content = new Uint8Array(totalSize)
            for (let p = 0; p < pageCount; p++) {
                const ch = 0x41 + p // A, B, C
                for (let i = 0; i < pageSize; i++) {
                    content[p * pageSize + i] = ch
                }
            }

            const entry = {
                inode_id,
                name: 'partial.bin',
                mode: 0o100644,
                size: totalSize,
                dt_type: 8,
                mtime_sec: Math.floor(Date.now() / 1000),
                mtime_nsec: 0,
                content: new Uint8Array(content),
            }
            const rootChildren = FS_ENTRIES.get(1)!
            rootChildren.push(entry)
            INODE_MAP.set(inode_id, entry)

            // Invalidate dir so the new file is visible
            v86fs.invalidate_dir(1)
            await new Promise((r) => setTimeout(r, 200))

            // Read the file to populate page cache
            const md5Before = await runCommand(
                emulator,
                'md5sum /mnt/partial.bin 2>&1',
            )
            expect(md5Before).toContain('partial.bin')

            // Track READ requests to verify only partial re-read happens
            let readCount = 0
            emulator.add_listener('virtio-v86fs-read', () => readCount++)

            // Modify only page 1 (offset 4096, size 4096) on the host side
            const modifiedEntry = INODE_MAP.get(inode_id)!
            for (let i = pageSize; i < pageSize * 2; i++) {
                modifiedEntry.content![i] = 0x58 // 'X'
            }

            // Send partial invalidation for page 1 only
            const sent = v86fs.invalidate_inode_range(
                inode_id,
                pageSize,
                pageSize,
            )
            expect(sent).toBe(true)

            await new Promise((r) => setTimeout(r, 200))

            // Drop dentry cache to force re-stat
            await runCommand(emulator, 'echo 2 > /proc/sys/vm/drop_caches 2>&1')

            // Reset read counter before re-reading
            readCount = 0

            // Re-read the file, md5 should change
            const md5After = await runCommand(
                emulator,
                'md5sum /mnt/partial.bin 2>&1',
            )
            expect(md5After).not.toBe(md5Before)

            // Verify the middle page was re-read (at least 1 READ for the invalidated page)
            expect(readCount).toBeGreaterThanOrEqual(1)

            // Verify content: read byte from each page region using od
            const odPage0 = await runCommand(
                emulator,
                'dd if=/mnt/partial.bin bs=1 skip=0 count=1 2>/dev/null | od -A n -t x1 2>&1',
            )
            expect(odPage0.trim()).toContain('41') // 'A' still cached

            const odPage1 = await runCommand(
                emulator,
                'dd if=/mnt/partial.bin bs=1 skip=4096 count=1 2>/dev/null | od -A n -t x1 2>&1',
            )
            expect(odPage1.trim()).toContain('58') // 'X' from modification

            const odPage2 = await runCommand(
                emulator,
                'dd if=/mnt/partial.bin bs=1 skip=8192 count=1 2>/dev/null | od -A n -t x1 2>&1',
            )
            expect(odPage2.trim()).toContain('43') // 'C' still cached

            await runCommand(emulator, 'umount /mnt')
        } finally {
            // Clean up injected entry
            const rootChildren = FS_ENTRIES.get(1)
            if (rootChildren) {
                const idx = rootChildren.findIndex(
                    (e: any) => e.name === 'partial.bin',
                )
                if (idx >= 0) rootChildren.splice(idx, 1)
            }
            INODE_MAP.delete(300)
            await emulator.destroy()
        }
    })

    it('external adapter serves files from JS Map', async () => {
        const handle9p = await loadHandle9p()
        const { adapter } = createMapAdapter()
        const emulator = createAdapterEmulator(handle9p, adapter)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            // Mount v86fs backed by adapter
            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // ls shows file from adapter's in-memory filesystem
            const lsResult = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsResult).toContain('adapter-file.txt')

            // cat reads content through adapter onRead callback
            const catResult = await runCommand(
                emulator,
                'cat /mnt/adapter-file.txt 2>&1',
            )
            expect(catResult).toContain('adapter hello world')

            // Create a new file through adapter onCreate + onWrite
            const writeResult = await runCommand(
                emulator,
                'echo "created via adapter" > /mnt/new.txt 2>&1; echo "EXIT:$?"',
            )
            expect(writeResult).toContain('EXIT:0')

            // Read it back through adapter
            const catNew = await runCommand(emulator, 'cat /mnt/new.txt 2>&1')
            expect(catNew).toContain('created via adapter')

            // mkdir through adapter
            const mkdirResult = await runCommand(
                emulator,
                'mkdir /mnt/adir 2>&1; echo "EXIT:$?"',
            )
            expect(mkdirResult).toContain('EXIT:0')

            const lsResult2 = await runCommand(emulator, 'ls /mnt 2>&1')
            expect(lsResult2).toContain('adir')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('adapter push invalidation updates cached content', async () => {
        const handle9p = await loadHandle9p()
        const { adapter, inodeMap } = createMapAdapter()
        const emulator = createAdapterEmulator(handle9p, adapter)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Read adapter-file.txt to populate page cache
            const cat1 = await runCommand(
                emulator,
                'cat /mnt/adapter-file.txt 2>&1',
            )
            expect(cat1).toContain('adapter hello world')

            // Modify file content in adapter's backing map
            const entry = inodeMap.get(2)!
            const newContent = new TextEncoder().encode('adapter UPDATED\n')
            entry.content = newContent
            entry.size = newContent.length

            // Push invalidation via VirtioV86FS instance
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const sent = v86fs.invalidate_inode(2)
            expect(sent).toBe(true)

            // Wait for invalidation to propagate
            await new Promise((r) => setTimeout(r, 300))

            // Re-read: guest should refetch from adapter and see updated content
            const cat2 = await runCommand(
                emulator,
                'cat /mnt/adapter-file.txt 2>&1',
            )
            expect(cat2).toContain('adapter UPDATED')
            expect(cat2).not.toContain('hello world')

            await runCommand(emulator, 'umount /mnt')
        } finally {
            await emulator.destroy()
        }
    })

    it('onStateRestored callback invalidates all inodes after simulated restore', async () => {
        const handle9p = await loadHandle9p()
        const { adapter, inodeMap } = createMapAdapter()

        // Wire onStateRestored to push invalidation for all inodes
        let restoreCount = 0
        const v86fsRef: { instance: any } = { instance: null }
        adapter.onStateRestored = () => {
            restoreCount++
            if (!v86fsRef.instance) return
            for (const iid of inodeMap.keys()) {
                v86fsRef.instance.invalidate_inode(iid)
            }
        }

        const emulator = createAdapterEmulator(handle9p, adapter)

        try {
            await waitForSerial(emulator, ':/#', 120_000)
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            v86fsRef.instance = v86fs

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Read file to populate page cache
            const cat1 = await runCommand(
                emulator,
                'cat /mnt/adapter-file.txt 2>&1',
            )
            expect(cat1).toContain('adapter hello world')

            // Modify adapter backing data
            const entry = inodeMap.get(2)!
            const newContent = new TextEncoder().encode('RESTORED content\n')
            entry.content = newContent
            entry.size = newContent.length

            // Simulate state restore: call onStateRestored directly
            // In real usage, set_state() calls this after restoring virtio state
            expect(restoreCount).toBe(0)
            adapter.onStateRestored!()
            expect(restoreCount).toBe(1)

            // Wait for invalidation to propagate
            await new Promise((r) => setTimeout(r, 300))

            // Read file: should see RESTORED content (cache was invalidated)
            const cat2 = await runCommand(
                emulator,
                'cat /mnt/adapter-file.txt 2>&1',
            )
            expect(cat2).toContain('RESTORED content')

            await runCommand(emulator, 'umount /mnt 2>/dev/null; true')
        } finally {
            await emulator.destroy()
        }
    })

    it('v86fs root mount boots to init', async () => {
        // Build an adapter from fs.json + flat/ that serves a complete Debian rootfs.
        // Boot with rootfstype=v86fs (no 9p root) to verify v86fs can serve as rootfs.
        const fsJsonPath = path.join(V86FS_DIR, 'fs.json')
        const flatDir = path.join(V86FS_DIR, 'flat')
        const fsJson = JSON.parse(fs.readFileSync(fsJsonPath, 'utf8'))
        const fsRoot = fsJson.fsroot || fsJson

        // Build inode table from basefs entries (same format as handle9p-server)
        let nextIno = 1
        const inodes = new Map<
            number,
            {
                name: string
                mode: number
                size: number
                mtime: number
                sha256: string | null
                symlink: string | null
                children: Map<string, number> | null
                ino: number
            }
        >()

        function buildTree(
            entries: any[],
            _parentIno: number,
        ): Map<string, number> {
            const children = new Map<string, number>()
            for (const entry of entries) {
                const name = entry[0]
                const size = entry[1] || 0
                const mtime = entry[2] || 0
                const mode = entry[3] || 0
                const data = entry[6]
                const ino = nextIno++
                if (Array.isArray(data)) {
                    const node = {
                        name,
                        mode,
                        size: 0,
                        mtime,
                        sha256: null,
                        symlink: null,
                        children: null as Map<string, number> | null,
                        ino,
                    }
                    inodes.set(ino, node)
                    node.children = buildTree(data, ino)
                    children.set(name, ino)
                } else if (typeof data === 'string' && data.endsWith('.bin')) {
                    inodes.set(ino, {
                        name,
                        mode,
                        size,
                        mtime,
                        sha256: data,
                        symlink: null,
                        children: null,
                        ino,
                    })
                    children.set(name, ino)
                } else if (typeof data === 'string') {
                    inodes.set(ino, {
                        name,
                        mode: mode || 0o120777,
                        size: data.length,
                        mtime,
                        sha256: null,
                        symlink: data,
                        children: null,
                        ino,
                    })
                    children.set(name, ino)
                } else {
                    inodes.set(ino, {
                        name,
                        mode,
                        size: 0,
                        mtime,
                        sha256: null,
                        symlink: null,
                        children: null,
                        ino,
                    })
                    children.set(name, ino)
                }
            }
            return children
        }

        const rootChildren = buildTree(fsRoot, 0)
        inodes.set(0, {
            name: '/',
            mode: S_IFDIR | 0o755,
            size: 0,
            mtime: 0,
            sha256: null,
            symlink: null,
            children: rootChildren,
            ino: 0,
        })

        // Content cache for flat/ files
        const contentCache = new Map<string, Uint8Array>()
        function fetchContent(sha256: string | null): Uint8Array {
            if (!sha256) return new Uint8Array(0)
            let data = contentCache.get(sha256)
            if (data) return data
            const filePath = path.join(flatDir, sha256)
            data = new Uint8Array(fs.readFileSync(filePath))
            contentCache.set(sha256, data)
            return data
        }

        // Open file handles
        const openHandles = new Map<number, number>()
        let nextHandleId = 1

        // Build adapter using inode table
        const rootfsAdapter: V86FSAdapter = {
            onMount(_name, reply) {
                // Root mount: return root inode (0)
                const root = inodes.get(0)!
                reply(0, root.ino, root.mode)
            },
            onLookup(parent_id, name, reply) {
                const parent = inodes.get(parent_id)
                if (!parent?.children) {
                    reply(2, 0, 0, 0)
                    return
                }
                const childIno = parent.children.get(name)
                if (childIno === undefined) {
                    reply(2, 0, 0, 0)
                    return
                }
                const child = inodes.get(childIno)!
                reply(0, child.ino, child.mode, child.size)
            },
            onGetattr(inode_id, reply) {
                const node = inodes.get(inode_id)
                if (!node) {
                    reply(2, 0, 0, 0, 0)
                    return
                }
                reply(0, node.mode, node.size, node.mtime, 0)
            },
            onReaddir(dir_id, reply) {
                const node = inodes.get(dir_id)
                if (!node?.children) {
                    reply(0, [])
                    return
                }
                const entries: V86FSDirEntry[] = []
                for (const [name, childIno] of node.children) {
                    const child = inodes.get(childIno)!
                    const fmt = child.mode & 0o170000
                    let dt = DT_REG_C
                    if (fmt === S_IFDIR) dt = DT_DIR_C
                    else if (fmt === 0o120000) dt = 10 // DT_LNK
                    entries.push({ inode_id: child.ino, dt_type: dt, name })
                }
                reply(0, entries)
            },
            onOpen(inode_id, _flags, reply) {
                const hid = nextHandleId++
                openHandles.set(hid, inode_id)
                reply(0, hid)
            },
            onClose(handle_id, reply) {
                openHandles.delete(handle_id)
                reply(0)
            },
            onRead(handle_id, offset, size, reply) {
                const iid = openHandles.get(handle_id) ?? handle_id
                const node = inodes.get(iid)
                if (!node) {
                    reply(0, new Uint8Array(0))
                    return
                }
                const content = fetchContent(node.sha256)
                if (offset >= content.length) {
                    reply(0, new Uint8Array(0))
                    return
                }
                const end = Math.min(offset + size, content.length)
                reply(0, content.subarray(offset, end))
            },
            onReadlink(inode_id, reply) {
                const node = inodes.get(inode_id)
                if (!node?.symlink) {
                    reply(2, '')
                    return
                }
                reply(0, node.symlink)
            },
            onStatfs(reply) {
                reply(
                    0,
                    1024 * 1024,
                    512 * 1024,
                    512 * 1024,
                    inodes.size,
                    512 * 1024,
                    4096,
                )
            },
        }

        const bzImagePath = path.join(V86FS_DIR, 'bzImage')
        const emulator = new V86({
            wasm_path: path.resolve(__dirname, '../build/v86-debug.wasm'),
            memory_size: 512 * 1024 * 1024,
            vga_memory_size: 2 * 1024 * 1024,
            bios: {
                url: path.resolve(__dirname, '../bios/seabios.bin'),
            },
            vga_bios: {
                url: path.resolve(__dirname, '../bios/vgabios.bin'),
            },
            bzimage: {
                url: bzImagePath,
            },
            cmdline:
                'rw init=/usr/bin/bash root=v86fs rootfstype=v86fs console=ttyS0',
            virtio_v86fs: true,
            virtio_v86fs_adapter: rootfsAdapter,
            autostart: true,
        })

        try {
            // Boot to shell prompt via v86fs root mount
            await waitForSerial(emulator, ':/#', 120_000)

            // Verify rootfs is v86fs via /proc/mounts
            await runCommand(
                emulator,
                'mount -t proc proc /proc 2>/dev/null; true',
            )
            const mountInfo = await runCommand(
                emulator,
                'cat /proc/mounts 2>&1',
            )
            expect(mountInfo).toContain('v86fs')

            // Verify we can read files from the rootfs
            const lsResult = await runCommand(emulator, 'ls /usr/bin/bash 2>&1')
            expect(lsResult).toContain('bash')

            // Verify basic commands work
            const echoResult = await runCommand(
                emulator,
                'echo "v86fs root works" 2>&1',
            )
            expect(echoResult).toContain('v86fs root works')
        } finally {
            await emulator.destroy()
        }
    })

    it('host-controlled MOUNT_NOTIFY creates mount in guest', async () => {
        // Boot with 9p root, then send MOUNT_NOTIFY to mount v86fs at a tmpfs path.
        // The 9p root is read-only, so we create the mountpoint under a tmpfs first.
        const handle9p = await loadHandle9p()
        const { adapter } = createMapAdapter()
        const emulator = createAdapterEmulator(handle9p, adapter)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            // Set up writable tmpfs at /tmp and create workspace mountpoint
            await runCommand(
                emulator,
                'mount -t tmpfs tmpfs /tmp 2>&1; mkdir -p /tmp/ws 2>&1',
            )
            await runCommand(
                emulator,
                'mount -t proc proc /proc 2>/dev/null; true',
            )

            // Send MOUNT_NOTIFY from host: mount "workspace" at /tmp/ws
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const sent = v86fs.mount_notify('workspace', '/tmp/ws')
            expect(sent).toBe(true)

            // Wait for kernel workqueue to process the mount
            // call_usermodehelper runs mkdir + mount inside the VM
            await new Promise((r) => setTimeout(r, 5000))

            // Verify mount is visible
            const mounts = await runCommand(emulator, 'cat /proc/mounts 2>&1')
            expect(mounts).toContain('/tmp/ws')
            expect(mounts).toContain('v86fs')

            // Verify we can use the mount
            const lsResult = await runCommand(emulator, 'ls /tmp/ws 2>&1')
            // adapter's root has adapter-file.txt
            expect(lsResult).toContain('adapter-file.txt')

            await runCommand(emulator, 'umount /tmp/ws 2>/dev/null; true')
        } finally {
            await emulator.destroy()
        }
    })

    it('readahead issues multiple READ requests for sequential read', async () => {
        const handle9p = await loadHandle9p()
        const emulator = createBootEmulator(handle9p)

        try {
            await waitForSerial(emulator, ':/#', 120_000)

            const mountResult = await runCommand(
                emulator,
                'mount -t v86fs none /mnt 2>&1; echo "EXIT:$?"',
            )
            expect(mountResult).toContain('EXIT:0')

            // Create a large file (64KB = 16 pages) to trigger readahead
            const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
            const inode_id = 301
            const totalSize = 64 * 1024
            const content = new Uint8Array(totalSize)
            for (let i = 0; i < totalSize; i++) {
                content[i] = i & 0xff
            }

            const entry = {
                inode_id,
                name: 'readahead.bin',
                mode: 0o100644,
                size: totalSize,
                dt_type: 8,
                mtime_sec: Math.floor(Date.now() / 1000),
                mtime_nsec: 0,
                content,
            }
            const rootChildren = FS_ENTRIES.get(1)!
            rootChildren.push(entry)
            INODE_MAP.set(inode_id, entry)

            // Invalidate dir so the new file is visible
            v86fs.invalidate_dir(1)
            await new Promise((r) => setTimeout(r, 200))

            // Track READ requests
            let readCount = 0
            const readOffsets: number[] = []
            emulator.add_listener(
                'virtio-v86fs-read',
                (info: { offset: number; size: number }) => {
                    readCount++
                    readOffsets.push(info.offset)
                },
            )

            // Sequential read of the large file via cat
            const catResult = await runCommand(
                emulator,
                'cat /mnt/readahead.bin | wc -c 2>&1',
            )
            expect(catResult.trim()).toBe('65536')

            // With readahead, the kernel should have issued multiple READ
            // requests. For 16 pages, we expect at least several READs
            // (not necessarily 16, as the kernel may batch).
            expect(readCount).toBeGreaterThanOrEqual(2)

            // Verify second read from page cache (no new READs)
            const prevReadCount = readCount
            const catResult2 = await runCommand(
                emulator,
                'cat /mnt/readahead.bin | wc -c 2>&1',
            )
            expect(catResult2.trim()).toBe('65536')
            expect(readCount).toBe(prevReadCount)

            await runCommand(emulator, 'umount /mnt')
        } finally {
            const rootChildren = FS_ENTRIES.get(1)
            if (rootChildren) {
                const idx = rootChildren.findIndex(
                    (e: any) => e.name === 'readahead.bin',
                )
                if (idx >= 0) rootChildren.splice(idx, 1)
            }
            INODE_MAP.delete(301)
            await emulator.destroy()
        }
    })
})
