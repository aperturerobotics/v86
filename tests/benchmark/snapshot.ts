#!/usr/bin/env node

import url from 'node:url'

const BENCH_COLLECT_STATS = +process.env.BENCH_COLLECT_STATS!
const { V86 } = await import(
    BENCH_COLLECT_STATS ? '../../src/main.js' : '../../dist/v86.js'
)

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const LOG_SERIAL = true

const emulator = new V86({
    bios: { url: __dirname + '/../../bios/seabios.bin' },
    vga_bios: { url: __dirname + '/../../bios/vgabios.bin' },
    cdrom: { url: __dirname + '/../../images/linux3.iso' },
    autostart: true,
    memory_size: 1024 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT!,
    log_level: 0,
})

emulator.bus.register('emulator-started', function () {
    console.log('Booting now, please stand by')
})

let serial_text = ''

emulator.add_listener('serial0-output-byte', function (byte: number) {
    const chr = String.fromCharCode(byte)
    if ((chr < ' ' && chr !== '\n' && chr !== '\t') || chr > '~') {
        return
    }

    if (LOG_SERIAL) process.stdout.write(chr)

    serial_text += chr

    if (
        serial_text.endsWith('~% ') ||
        serial_text.endsWith('root@localhost:~# ')
    ) {
        console.log('Creating snapshots')
        const snap_start_time = Date.now()
        for (let i = 0; i < 10; ++i) emulator.save_state()
        const end_time = Date.now()
        const elapsed = end_time - snap_start_time
        console.log('Done in %dms', elapsed)
        emulator.destroy()

        if (BENCH_COLLECT_STATS) {
            console.log(emulator.get_instruction_stats())
        }
    }
})
