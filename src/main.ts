import { CPU } from './cpu.js'
import { save_state, restore_state } from './state.js'
export { V86 } from './browser/starter.js'

import { BusConnector } from './bus.js'

// CPU is a constructor function (not a TS class), so it lacks a construct
// signature. We alias it through an untyped binding to call with `new`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CPUConstructor: any = CPU

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CPUInstance = any

function the_worker() {
    let timeout: ReturnType<typeof setTimeout> | undefined
    globalThis.onmessage = function (e: MessageEvent) {
        const t = e.data.t
        if (timeout) {
            clearTimeout(timeout)
            timeout = undefined
        }
        if (t < 1) postMessage(e.data.tick)
        else timeout = setTimeout(() => postMessage(e.data.tick), t)
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class v86 {
    running: boolean = false
    stopping: boolean = false
    idle: boolean = true
    tick_counter: number = 0
    worker: Worker | null = null
    cpu: CPUInstance
    bus: BusConnector

    static microtick: () => number

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(bus: BusConnector, wasm: any) {
        this.cpu = new CPUConstructor(bus, wasm, () => {
            this.idle && this.next_tick(0)
        })
        this.bus = bus
        this.register_yield()
    }

    run(): void {
        this.stopping = false

        if (!this.running) {
            this.running = true
            this.bus.send('emulator-started')
        }

        this.next_tick(0)
    }

    do_tick(): void {
        if (this.stopping || !this.running) {
            this.stopping = this.running = false
            this.bus.send('emulator-stopped')
            return
        }

        this.idle = false
        const t = this.cpu.main_loop()

        this.next_tick(t)
    }

    next_tick(t: number): void {
        const tick = ++this.tick_counter
        this.idle = true
        this.yield(t, tick)
    }

    yield_callback(tick: number): void {
        if (tick === this.tick_counter) {
            this.do_tick()
        }
    }

    stop(): void {
        if (this.running) {
            this.stopping = true
        }
    }

    destroy(): void {
        this.unregister_yield()
    }

    restart(): void {
        this.cpu.reset_cpu()
        this.cpu.load_bios()
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    init(settings: any): void {
        this.cpu.init(settings, this.bus)
        this.bus.send('emulator-ready')
    }

    save_state(): ArrayBuffer {
        return save_state(this.cpu)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    restore_state(state: any): void {
        return restore_state(this.cpu, state)
    }

    yield(t: number, tick: number): void {
        // Default fallback: setTimeout
        setTimeout(() => {
            this.do_tick()
        }, t)
    }

    register_yield(): void {
        // no-op by default
    }

    unregister_yield(): void {
        // no-op by default
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _global: any = globalThis

// Environment-specific yield strategy overrides
if (typeof process !== 'undefined') {
    v86.prototype.yield = function (t: number, tick: number): void {
        if (t < 1) {
            _global.setImmediate(
                (tick: number) => this.yield_callback(tick),
                tick,
            )
        } else {
            setTimeout((tick: number) => this.yield_callback(tick), t, tick)
        }
    }

    v86.prototype.register_yield = function (): void {}
    v86.prototype.unregister_yield = function (): void {}
} else if (
    _global['scheduler'] &&
    typeof _global['scheduler']['postTask'] === 'function' &&
    location.href.includes('use-scheduling-api')
) {
    v86.prototype.yield = function (t: number, tick: number): void {
        t = Math.max(0, t)
        _global['scheduler']['postTask'](() => this.yield_callback(tick), {
            delay: t,
        })
    }

    v86.prototype.register_yield = function (): void {}
    v86.prototype.unregister_yield = function (): void {}
} else if (typeof Worker !== 'undefined') {
    // XXX: This has a slightly lower throughput compared to window.postMessage

    v86.prototype.register_yield = function (): void {
        const url = URL.createObjectURL(
            new Blob(['(' + the_worker.toString() + ')()'], {
                type: 'text/javascript',
            }),
        )
        this.worker = new Worker(url)
        this.worker.onmessage = (e: MessageEvent) => this.yield_callback(e.data)
        URL.revokeObjectURL(url)
    }

    v86.prototype.yield = function (t: number, tick: number): void {
        this.worker!.postMessage({ t, tick })
    }

    v86.prototype.unregister_yield = function (): void {
        this.worker && this.worker.terminate()
        this.worker = null
    }
}

// Static microtick initialization
if (typeof performance === 'object' && performance.now) {
    v86.microtick = performance.now.bind(performance)
} else if (typeof require === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
    const { performance } = require('perf_hooks')
    v86.microtick = performance.now.bind(performance)
} else if (typeof process === 'object' && process.hrtime) {
    v86.microtick = function () {
        const t = process.hrtime()
        return t[0] * 1000 + t[1] / 1e6
    }
} else {
    v86.microtick = Date.now
}
