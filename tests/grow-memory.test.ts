import { describe, it, expect } from 'vitest'

const { V86 } = await import('../src/main.js')

describe('growMemory', () => {
    it('grows memory from 64MB to 128MB', async () => {
        const MB = 1024 * 1024
        const emulator = new V86({
            memory_size: 64 * MB,
            autostart: false,
        })
        await new Promise<void>((r) =>
            emulator.bus.register('emulator-loaded', r),
        )

        const cpu = emulator.v86.cpu
        expect(cpu.memory_size[0]).toBe(64 * MB)

        await emulator.growMemory(128 * MB)
        expect(cpu.memory_size[0]).toBe(128 * MB)

        await emulator.destroy()
    })

    it('preserves data after grow', async () => {
        const MB = 1024 * 1024
        const emulator = new V86({
            memory_size: 64 * MB,
            autostart: false,
        })
        await new Promise<void>((r) =>
            emulator.bus.register('emulator-loaded', r),
        )

        const cpu = emulator.v86.cpu

        // Write pattern near boundary
        const offset = 64 * MB - 16
        for (let i = 0; i < 16; i++) {
            cpu.mem8[offset + i] = (i * 37) & 0xff
        }

        await emulator.growMemory(128 * MB)

        // Verify pattern survived
        for (let i = 0; i < 16; i++) {
            expect(cpu.mem8[offset + i]).toBe((i * 37) & 0xff)
        }

        await emulator.destroy()
    })
})
