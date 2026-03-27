import { LOG_FETCH } from '../const.js'
import { dbg_log } from '../log.js'

import {
    create_eth_encoder_buf,
    handle_fake_networking,
    TCPConnection,
    fake_tcp_connect,
    fake_tcp_probe,
} from './fake_network.js'

import type { EthEncoderBuf, NetworkAdapterLike } from './fake_network.js'

import { BusConnector } from '../bus.js'

interface FetchNetworkConfig {
    id?: number
    router_mac?: string
    router_ip?: string
    vm_ip?: string
    masquerade?: boolean
    dns_method?: string
    doh_server?: string
    mtu?: number
    cors_proxy?: string
}

export class FetchNetworkAdapter implements NetworkAdapterLike {
    bus: BusConnector
    id: number
    router_mac: Uint8Array
    router_ip: Uint8Array
    vm_ip: Uint8Array
    masquerade: boolean
    vm_mac: Uint8Array
    dns_method: string
    doh_server: string | undefined
    tcp_conn: Record<string, TCPConnection>
    mtu: number | undefined
    eth_encoder_buf: EthEncoderBuf
    cors_proxy: string | undefined

    constructor(bus: BusConnector, config?: FetchNetworkConfig) {
        config = config || {}
        this.bus = bus
        this.id = config.id || 0
        this.router_mac = new Uint8Array(
            (config.router_mac || '52:54:0:1:2:3').split(':').map(function (x) {
                return parseInt(x, 16)
            }),
        )
        this.router_ip = new Uint8Array(
            (config.router_ip || '192.168.86.1').split('.').map(function (x) {
                return parseInt(x, 10)
            }),
        )
        this.vm_ip = new Uint8Array(
            (config.vm_ip || '192.168.86.100').split('.').map(function (x) {
                return parseInt(x, 10)
            }),
        )
        this.masquerade = config.masquerade === undefined || !!config.masquerade
        this.vm_mac = new Uint8Array(6)
        this.dns_method = config.dns_method || 'static'
        this.doh_server = config.doh_server
        this.tcp_conn = {}
        this.mtu = config.mtu
        this.eth_encoder_buf = create_eth_encoder_buf(this.mtu)

        // Ex: 'https://corsproxy.io/?'
        this.cors_proxy = config.cors_proxy

        this.bus.register(
            'net' + this.id + '-mac',
            function (this: FetchNetworkAdapter, mac: string) {
                this.vm_mac = new Uint8Array(
                    mac.split(':').map(function (x) {
                        return parseInt(x, 16)
                    }),
                )
            },
            this,
        )
        this.bus.register(
            'net' + this.id + '-send',
            function (this: FetchNetworkAdapter, data: Uint8Array) {
                this.send(data)
            },
            this,
        )
        this.bus.register(
            'tcp-connection',
            (conn: TCPConnection) => {
                if (conn.sport === 80) {
                    conn.on('data', on_data_http.bind(conn))
                    conn.accept()
                }
            },
            this,
        )
    }

    destroy(): void {}

    connect(port: number): TCPConnection {
        return fake_tcp_connect(port, this)
    }

    tcp_probe(port: number): Promise<boolean> {
        return fake_tcp_probe(port, this)
    }

    async fetch_resource(
        url: string,
        options?: RequestInit,
    ): Promise<
        [
            Response | { status: number; statusText: string; headers: Headers },
            ArrayBuffer,
        ]
    > {
        if (this.cors_proxy) url = this.cors_proxy + encodeURIComponent(url)

        try {
            const resp = await fetch(url, options)
            const ab = await resp.arrayBuffer()
            return [resp, ab]
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e))
            console.warn('Fetch Failed: ' + url + '\n' + e)
            return [
                {
                    status: 502,
                    statusText: 'Fetch Error',
                    headers: new Headers({ 'Content-Type': 'text/plain' }),
                },
                new TextEncoder().encode(`Fetch ${url} failed:\n\n${err.stack}`)
                    .buffer,
            ]
        }
    }

    form_response_head(
        status_code: number,
        status_text: string,
        headers: Headers,
    ): Uint8Array {
        const lines = [`HTTP/1.1 ${status_code} ${status_text}`]

        for (const [key, value] of headers.entries()) {
            lines.push(`${key}: ${value}`)
        }

        return new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n')
    }

    respond_text_and_close(
        conn: TCPConnection,
        status_code: number,
        status_text: string,
        body: string,
    ): void {
        const headers = new Headers({
            'content-type': 'text/plain',
            'content-length': body.length.toString(10),
            connection: 'close',
        })
        conn.writev([
            this.form_response_head(status_code, status_text, headers),
            new TextEncoder().encode(body),
        ])
        conn.close()
    }

    parse_http_header(
        header: string,
    ): { key: string; value: string } | undefined {
        const parts = header.match(/^([^:]*):(.*)$/)
        if (!parts) {
            dbg_log('Unable to parse HTTP header', LOG_FETCH)
            return
        }

        const key = parts[1]
        const value = parts[2].trim()

        if (key.length === 0) {
            dbg_log('Header key is empty, raw header', LOG_FETCH)
            return
        }
        if (value.length === 0) {
            dbg_log('Header value is empty', LOG_FETCH)
            return
        }
        if (!/^[\w-]+$/.test(key)) {
            dbg_log('Header key contains forbidden characters', LOG_FETCH)
            return
        }
        if (!/^[\x20-\x7E]+$/.test(value)) {
            dbg_log('Header value contains forbidden characters', LOG_FETCH)
            return
        }

        return { key, value }
    }

    send(data: Uint8Array): void {
        handle_fake_networking(data, this)
    }

    receive(data: Uint8Array): void {
        this.bus.send('net' + this.id + '-receive', new Uint8Array(data))
    }
}

/**
 * HTTP data handler bound to a TCPConnection context.
 */
async function on_data_http(
    this: TCPConnection,
    data: ArrayBuffer,
): Promise<void> {
    this.read = this.read || ''
    this.read += new TextDecoder().decode(data)
    if (this.read && this.read.indexOf('\r\n\r\n') !== -1) {
        const offset = this.read.indexOf('\r\n\r\n')
        const headers = this.read.substring(0, offset).split(/\r\n/)
        const body = this.read.substring(offset + 4)
        this.read = ''

        const first_line = headers[0].split(' ')
        let target: URL
        if (/^https?:/.test(first_line[1])) {
            // HTTP proxy
            target = new URL(first_line[1])
        } else {
            target = new URL('http://host' + first_line[1])
        }
        if (
            typeof window !== 'undefined' &&
            target.protocol === 'http:' &&
            window.location.protocol === 'https:'
        ) {
            // fix "Mixed Content" errors
            target.protocol = 'https:'
        }

        const net = this.net as FetchNetworkAdapter

        const req_headers = new Headers()
        for (let i = 1; i < headers.length; ++i) {
            const header = net.parse_http_header(headers[i])
            if (!header) {
                console.warn(
                    'The request contains an invalid header: "%s"',
                    headers[i],
                )
                net.respond_text_and_close(
                    this,
                    400,
                    'Bad Request',
                    `Invalid header in request: ${headers[i]}`,
                )
                return
            }
            if (header.key.toLowerCase() === 'host') target.host = header.value
            else req_headers.append(header.key, header.value)
        }

        if (!net.cors_proxy && /^\d+\.external$/.test(target.hostname)) {
            dbg_log('Request to localhost: ' + target.href, LOG_FETCH)
            const localport = parseInt(target.hostname.split('.')[0], 10)
            if (!isNaN(localport) && localport > 0 && localport < 65536) {
                target.protocol = 'http:'
                target.hostname = 'localhost'
                target.port = localport.toString(10)
            } else {
                console.warn('Unknown port for localhost: "%s"', target.href)
                net.respond_text_and_close(
                    this,
                    400,
                    'Bad Request',
                    `Unknown port for localhost: ${target.href}`,
                )
                return
            }
        }

        dbg_log('HTTP Dispatch: ' + target.href, LOG_FETCH)
        this.name = target.href
        const opts: RequestInit = {
            method: first_line[0],
            headers: req_headers,
        }
        if (['put', 'post'].indexOf(opts.method!.toLowerCase()) !== -1) {
            opts.body = body
        }

        const fetch_url = net.cors_proxy
            ? net.cors_proxy + encodeURIComponent(target.href)
            : target.href
        let response_started = false
        const handler = (resp: Response) => {
            const resp_headers = new Headers(resp.headers)
            resp_headers.delete('content-encoding')
            resp_headers.delete('keep-alive')
            resp_headers.delete('content-length')
            resp_headers.delete('transfer-encoding')
            resp_headers.set('x-was-fetch-redirected', `${!!resp.redirected}`)
            resp_headers.set('x-fetch-resp-url', resp.url)
            resp_headers.set('connection', 'close')

            this.write(
                net.form_response_head(
                    resp.status,
                    resp.statusText,
                    resp_headers,
                ),
            )
            response_started = true

            if (resp.body && resp.body.getReader) {
                const resp_reader = resp.body.getReader()
                const pump = ({
                    value,
                    done,
                }: ReadableStreamReadResult<Uint8Array>): void | Promise<void> => {
                    if (value) {
                        this.write(value)
                    }
                    if (done) {
                        this.close()
                    } else {
                        return resp_reader.read().then(pump)
                    }
                }
                resp_reader.read().then(pump)
            } else {
                resp.arrayBuffer().then((buffer) => {
                    this.write(new Uint8Array(buffer))
                    this.close()
                })
            }
        }

        fetch(fetch_url, opts)
            .then(handler)
            .catch((e) => {
                console.warn('Fetch Failed: ' + fetch_url + '\n' + e)
                if (!response_started) {
                    net.respond_text_and_close(
                        this,
                        502,
                        'Fetch Error',
                        `Fetch ${fetch_url} failed:\n\n${e.stack || e.message}`,
                    )
                }
                this.close()
            })
    }
}
