import { BusConnector } from '../bus.js'

/**
 * An ethernet-through-websocket adapter, to be used with
 *     https://github.com/benjamincburns/websockproxy
 *
 * emulated ethernet card <--> this <--> websocket proxy <--> network
 */
export class NetworkAdapter {
    bus: BusConnector
    socket: WebSocket | undefined
    id: number
    send_queue: Uint8Array[]
    url: string
    reconnect_interval: number
    last_connect_attempt: number
    send_queue_limit: number
    destroyed: boolean

    constructor(url: string, bus: BusConnector, id?: number) {
        this.bus = bus
        this.socket = undefined
        this.id = id || 0

        // TODO: circular buffer?
        this.send_queue = []
        this.url = url

        this.reconnect_interval = 10000
        this.last_connect_attempt = Date.now() - this.reconnect_interval
        this.send_queue_limit = 64
        this.destroyed = false

        this.bus.register(
            'net' + this.id + '-send',
            function (this: NetworkAdapter, data: Uint8Array) {
                this.send(data)
            },
            this,
        )
    }

    handle_message(e: MessageEvent): void {
        if (this.bus) {
            this.bus.send('net' + this.id + '-receive', new Uint8Array(e.data))
        }
    }

    handle_close(_e: CloseEvent): void {
        //console.log("onclose", e);

        if (!this.destroyed) {
            this.connect()
            setTimeout(this.connect.bind(this), this.reconnect_interval)
        }
    }

    handle_open(_e: Event): void {
        //console.log("open", e);

        for (var i = 0; i < this.send_queue.length; i++) {
            this.send(this.send_queue[i])
        }

        this.send_queue = []
    }

    handle_error(_e: Event): void {
        //console.log("onerror", e);
    }

    destroy(): void {
        this.destroyed = true
        if (this.socket) {
            this.socket.close()
        }
    }

    connect(): void {
        if (typeof WebSocket === 'undefined') {
            return
        }

        if (this.socket) {
            var state = this.socket.readyState

            if (state === 0 || state === 1) {
                // already or almost there
                return
            }
        }

        var now = Date.now()

        if (this.last_connect_attempt + this.reconnect_interval > now) {
            return
        }

        this.last_connect_attempt = Date.now()

        try {
            this.socket = new WebSocket(this.url)
        } catch (e) {
            console.error(e)
            return
        }

        this.socket.binaryType = 'arraybuffer'

        this.socket.onopen = this.handle_open.bind(this)
        this.socket.onmessage = this.handle_message.bind(this)
        this.socket.onclose = this.handle_close.bind(this)
        this.socket.onerror = this.handle_error.bind(this)
    }

    send(data: Uint8Array): void {
        //console.log("send", data);

        if (!this.socket || this.socket.readyState !== 1) {
            this.send_queue.push(data)

            if (this.send_queue.length > 2 * this.send_queue_limit) {
                this.send_queue = this.send_queue.slice(-this.send_queue_limit)
            }

            this.connect()
        } else {
            this.socket.send(new Uint8Array(data))
        }
    }

    change_proxy(url: string): void {
        this.url = url

        if (this.socket) {
            this.socket.onclose = function () {}
            this.socket.onerror = function () {}
            this.socket.close()
            this.socket = undefined
        }
    }
}
