import { describe, it, expect } from 'vitest'
import { save_state, restore_state, StateLoadError } from '../src/state.js'

// Minimal mock CPU that implements the StateCpu interface.
// Must be a class instance (not plain object) to pass save_object's constructor check.
class MockCpu {
    wasm_memory = new WebAssembly.Memory({ initial: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stored_state: any[]

    constructor(memory_size: number) {
        this.stored_state = [
            memory_size,
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
            new Int32Array([42, -1, 0x7fffffff]),
            new Float64Array([3.14, 2.718, -0.5]),
            new Map<number, number>([
                [0, 100],
                [1, 200],
            ]),
            'hello',
            null,
            true,
            123,
        ]
    }

    get_state() {
        return this.stored_state
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set_state(state: any[]) {
        this.stored_state = state
    }
    zstd_create_ctx(_len: number) {
        return 0
    }
    zstd_get_src_ptr(_ctx: number) {
        return 0
    }
    zstd_read(_ctx: number, _len: number) {
        return 0
    }
    zstd_read_free(_ptr: number, _len: number) {}
    zstd_free_ctx(_ctx: number) {}
}

function create_mock_cpu(memory_size: number) {
    return new MockCpu(memory_size)
}

describe('state round-trip', () => {
    it('saves and restores state with primitives and typed arrays', () => {
        const cpu = create_mock_cpu(1024)
        const original_state = cpu.get_state()

        const saved = save_state(cpu)
        expect(saved).toBeInstanceOf(ArrayBuffer)
        expect(saved.byteLength).toBeGreaterThan(0)

        // Create a fresh CPU and restore into it
        const cpu2 = create_mock_cpu(1024)
        restore_state(cpu2, saved)

        const restored = cpu2.get_state()

        // Primitives
        expect(restored[0]).toBe(original_state[0]) // memory_size number
        expect(restored[5]).toBe('hello')
        expect(restored[6]).toBe(null)
        expect(restored[7]).toBe(true)
        expect(restored[8]).toBe(123)

        // Uint8Array
        expect(restored[1]).toBeInstanceOf(Uint8Array)
        expect(Array.from(restored[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

        // Int32Array
        expect(restored[2]).toBeInstanceOf(Int32Array)
        expect(Array.from(restored[2])).toEqual([42, -1, 0x7fffffff])

        // Float64Array
        expect(restored[3]).toBeInstanceOf(Float64Array)
        expect(Array.from(restored[3])).toEqual([3.14, 2.718, -0.5])

        // Map (number keys become strings through JSON round-trip)
        expect(restored[4]).toBeInstanceOf(Map)
        const map = restored[4]
        expect(map.size).toBe(2)
        expect(map.get(0) ?? map.get('0')).toBe(100)
        expect(map.get(1) ?? map.get('1')).toBe(200)
    })

    it('rejects truncated state data', () => {
        expect(() => {
            const cpu = create_mock_cpu(1024)
            restore_state(cpu, new ArrayBuffer(4))
        }).toThrow(StateLoadError)
    })

    it('rejects invalid magic', () => {
        expect(() => {
            const cpu = create_mock_cpu(1024)
            restore_state(cpu, new ArrayBuffer(32))
        }).toThrow(StateLoadError)
    })

    it('produces deterministic output for the same input', () => {
        const cpu = create_mock_cpu(1024)
        const saved1 = save_state(cpu)
        const saved2 = save_state(cpu)

        expect(new Uint8Array(saved1)).toEqual(new Uint8Array(saved2))
    })
})
