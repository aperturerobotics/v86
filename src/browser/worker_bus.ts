import { dbg_assert } from '../log.js'

interface WorkerBusListener {
    fn: (...args: any[]) => any
    this_value: unknown
}

/**
 * Connector bridges postMessage to BusConnector.
 */
export class Connector {
    listeners: Record<string, WorkerBusListener[]>
    pair: Worker | MessagePort

    constructor(pair: Worker | MessagePort) {
        this.listeners = {}
        this.pair = pair

        pair.addEventListener(
            'message',
            ((e: Event) => {
                const data = (e as MessageEvent).data
                const listeners = this.listeners[data[0]]

                for (let i = 0; i < listeners.length; i++) {
                    const listener = listeners[i]
                    listener.fn.call(listener.this_value, data[1])
                }
            }) satisfies EventListener,
            false,
        )
    }

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

    send(name: string, value?: unknown, transfer_list?: Transferable[]): void {
        dbg_assert(arguments.length >= 1)

        if (!this.pair) {
            return
        }

        this.pair.postMessage([name, value], transfer_list || [])
    }
}

export const init = function (worker: Worker | MessagePort): Connector {
    return new Connector(worker)
}
