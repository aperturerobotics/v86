import { dbg_assert } from './log.js'

interface BusListener {
    fn: (...args: any[]) => any
    this_value: unknown
}

export class BusConnector {
    listeners: Record<string, BusListener[]> = {}
    pair: BusConnector | undefined = undefined

    register(
        name: string,
        fn: (...args: any[]) => any,
        this_value: unknown,
    ): void {
        let listeners = this.listeners[name]

        if (listeners === undefined) {
            listeners = this.listeners[name] = []
        }

        listeners.push({
            fn: fn,
            this_value: this_value,
        })
    }

    unregister(name: string, fn: (...args: any[]) => any): void {
        const listeners = this.listeners[name]

        if (listeners === undefined) {
            return
        }

        this.listeners[name] = listeners.filter(function (l) {
            return l.fn !== fn
        })
    }

    send(name: string, value?: unknown, _unused_transfer?: unknown): void {
        if (!this.pair) {
            return
        }

        const listeners = this.pair.listeners[name]

        if (listeners === undefined) {
            return
        }

        for (let i = 0; i < listeners.length; i++) {
            const listener = listeners[i]
            listener.fn.call(listener.this_value, value)
        }
    }

    send_async(name: string, value?: unknown): void {
        dbg_assert(arguments.length === 1 || arguments.length === 2)

        setTimeout(this.send.bind(this, name, value), 0)
    }
}

export function create_bus(): [BusConnector, BusConnector] {
    const c0 = new BusConnector()
    const c1 = new BusConnector()

    c0.pair = c1
    c1.pair = c0

    return [c0, c1]
}

// Backwards compatibility: Bus namespace
export const Bus = {
    create: create_bus,
}
