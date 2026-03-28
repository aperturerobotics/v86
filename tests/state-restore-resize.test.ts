import { describe, it, expect } from 'vitest'

const { V86 } = await import('../src/main.js')

const MB = 1024 * 1024

function createEmulator(
    memory_size: number,
    memory_max?: number,
): Promise<any> {
    return new Promise((resolve) => {
        const opts: any = { memory_size, autostart: false }
        if (memory_max) opts.memory_max = memory_max
        const emulator = new V86(opts)
        emulator.bus.register('emulator-loaded', () => resolve(emulator))
    })
}

describe('state restore resize', () => {
    it('restores larger state into smaller emulator', async () => {
        // Create emulator with 256MB and save its state
        const big = await createEmulator(256 * MB)
        const big_cpu = big.v86.cpu
        expect(big_cpu.memory_size[0]).toBe(256 * MB)

        // Write pattern in high memory that only exists in the 256MB state
        const high_offset = 128 * MB + 4096
        for (let i = 0; i < 16; i++) {
            big_cpu.mem8[high_offset + i] = (i * 41) & 0xff
        }

        const saved = await big.save_state()
        await big.destroy()

        // Create smaller emulator with 64MB (max 1GB to accommodate restore)
        const small = await createEmulator(64 * MB, 1024 * MB)
        const small_cpu = small.v86.cpu
        expect(small_cpu.memory_size[0]).toBe(64 * MB)

        await small.restore_state(saved)

        // Memory should now be 256MB
        expect(small_cpu.memory_size[0]).toBe(256 * MB)

        // Data written in high memory should survive the restore
        for (let i = 0; i < 16; i++) {
            expect(small_cpu.mem8[high_offset + i]).toBe((i * 41) & 0xff)
        }

        // CMOS memory_above_16m should reflect 256MB (from saved state)
        const CMOS_MEM_EXTMEM2_LOW = 0x34
        const CMOS_MEM_EXTMEM2_HIGH = 0x35
        const rtc = small_cpu.devices.rtc
        const cmos_low = rtc.cmos_read(CMOS_MEM_EXTMEM2_LOW)
        const cmos_high = rtc.cmos_read(CMOS_MEM_EXTMEM2_HIGH)
        const memory_above_16m = cmos_low | (cmos_high << 8) // in 64k blocks
        const expected = (256 * MB - 16 * MB) >> 16
        expect(memory_above_16m).toBe(expected)

        await small.destroy()
    })

    it('restores same-size state without growing', async () => {
        const em = await createEmulator(64 * MB)
        const cpu = em.v86.cpu

        // Write a pattern
        const offset = 32 * MB
        for (let i = 0; i < 16; i++) {
            cpu.mem8[offset + i] = (i * 29) & 0xff
        }

        const saved = await em.save_state()

        // Restore into same emulator
        await em.restore_state(saved)

        expect(cpu.memory_size[0]).toBe(64 * MB)
        for (let i = 0; i < 16; i++) {
            expect(cpu.mem8[offset + i]).toBe((i * 29) & 0xff)
        }

        await em.destroy()
    })
})
