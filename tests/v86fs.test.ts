import { describe, it, expect } from 'vitest'
import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const PROTO_DIR = path.resolve(__dirname, '../../wasivm/prototypes/debian-v86')

const { V86 } = await import('../src/main.js')
const { INODE_MAP, FS_ENTRIES } = await import('../src/virtio_v86fs.js')

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
    // Strip the echoed command and prompt from output
    const lines = buf.split('\n')
    // Find command echo line, take everything after it until the prompt
    const cmdIdx = lines.findIndex((l: string) => l.includes(cmd))
    const promptIdx = lines.findLastIndex((l: string) => l.includes(prompt))
    if (cmdIdx >= 0 && promptIdx > cmdIdx) {
        return lines
            .slice(cmdIdx + 1, promptIdx)
            .join('\n')
            .trim()
    }
    return buf
}

// Load handle9p from prototype
async function loadHandle9p(): Promise<any> {
    const mod = await import(path.join(PROTO_DIR, 'handle9p-server.mjs'))
    const fsJsonUrl = url.pathToFileURL(path.join(PROTO_DIR, 'fs.json')).href
    const flatUrl = url.pathToFileURL(path.join(PROTO_DIR, 'flat')).href + '/'
    return mod.createHandle9p(fsJsonUrl, flatUrl)
}

function createBootEmulator(handle9p: any): any {
    const bzImagePath = path.join(PROTO_DIR, 'bzImage')
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

describe(
    'v86fs',
    () => {
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
                const cat1 = await runCommand(
                    emulator,
                    'cat /mnt/hello.txt 2>&1',
                )
                expect(cat1).toContain('hello world')

                // Modify the file content on the host side directly
                const v86fs = emulator.v86.cpu.devices.virtio_v86fs as any
                const helloEntry = INODE_MAP.get(2) // hello.txt inode=2
                expect(helloEntry).toBeDefined()
                const newContent = new TextEncoder().encode(
                    'modified content\n',
                )
                helloEntry!.content = newContent
                helloEntry!.size = newContent.length

                // Send INVALIDATE to evict page cache
                const sent = v86fs.invalidate_inode(2)
                expect(sent).toBe(true)

                // Small delay for interrupt processing
                await new Promise((r) => setTimeout(r, 200))

                // Drop the dentry cache too so the inode re-reads attrs
                await runCommand(
                    emulator,
                    'echo 2 > /proc/sys/vm/drop_caches 2>&1',
                )

                // Re-read the file - should show new content
                const cat2 = await runCommand(
                    emulator,
                    'cat /mnt/hello.txt 2>&1',
                )
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
                        (e) => e.name === 'injected.txt',
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

        it('sends MOUNT message with root name to host', async () => {
            const handle9p = await loadHandle9p()
            const emulator = createBootEmulator(handle9p)

            let mountName: string | undefined
            emulator.add_listener('virtio-v86fs-mount', (name: string) => {
                mountName = name
            })

            try {
                await waitForSerial(emulator, ':/#', 120_000)

                // Mount with -o root=workspace
                const result = await runCommand(
                    emulator,
                    'mount -t v86fs none /mnt -o root=workspace 2>&1; echo "EXIT:$?"',
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
    },
    { timeout: 180_000 },
)
