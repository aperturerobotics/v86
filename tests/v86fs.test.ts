import { describe, it, expect } from 'vitest'
import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const PROTO_DIR = path.resolve(__dirname, '../../wasivm/prototypes/debian-v86')

const { V86 } = await import('../src/main.js')

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

                // Unmount
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
