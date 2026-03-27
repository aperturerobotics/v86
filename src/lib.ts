declare let DEBUG: boolean

import { dbg_assert } from './log.js'

// pad string with spaces on the right
export function pads(
    str: string | number | undefined | null,
    len: number,
): string {
    const s = str || str === 0 ? str + '' : ''
    return s.padEnd(len, ' ')
}

// pad string with zeros on the left
export function pad0(
    str: string | number | undefined | null,
    len: number,
): string {
    const s = str || str === 0 ? str + '' : ''
    return s.padStart(len, '0')
}

export const view = function (
    constructor: any,
    memory: { buffer: ArrayBuffer },
    offset: number,
    length: number,
): any {
    dbg_assert(offset >= 0)
    return new Proxy(
        {},
        {
            get: function (_target, property) {
                const b = new constructor(memory.buffer, offset, length)
                const x = b[property]
                if (typeof x === 'function') {
                    return x.bind(b)
                }
                dbg_assert(
                    /^\d+$/.test(String(property)) ||
                        property === 'buffer' ||
                        property === 'length' ||
                        property === 'BYTES_PER_ELEMENT' ||
                        property === 'byteOffset',
                )
                return x
            },
            set: function (_target, property, value) {
                dbg_assert(/^\d+$/.test(String(property)))
                new constructor(memory.buffer, offset, length)[property] = value
                return true
            },
        },
    )
}

export function h(n: number, len?: number): string {
    let str: string
    if (!n) {
        str = ''
    } else {
        str = n.toString(16)
    }

    return '0x' + pad0(str.toUpperCase(), len || 1)
}

export function hex_dump(buffer: Uint8Array | number[]): string {
    function hex(n: number, len: number): string {
        return pad0(n.toString(16).toUpperCase(), len)
    }

    const result: string[] = []
    let offset = 0

    for (; offset + 15 < buffer.length; offset += 16) {
        let line = hex(offset, 5) + '   '

        for (let j = 0; j < 0x10; j++) {
            line += hex(buffer[offset + j], 2) + ' '
        }

        line += '  '

        for (let j = 0; j < 0x10; j++) {
            const x = buffer[offset + j]
            line +=
                x >= 33 && x !== 34 && x !== 92 && x <= 126
                    ? String.fromCharCode(x)
                    : '.'
        }

        result.push(line)
    }

    let line = hex(offset, 5) + '   '

    for (; offset < buffer.length; offset++) {
        line += hex(buffer[offset], 2) + ' '
    }

    const remainder = offset & 0xf
    line += '   '.repeat(0x10 - remainder)
    line += '  '

    for (let j = 0; j < remainder; j++) {
        const x = buffer[offset + j]
        line +=
            x >= 33 && x !== 34 && x !== 92 && x <= 126
                ? String.fromCharCode(x)
                : '.'
    }

    result.push(line)

    return '\n' + result.join('\n') + '\n'
}

/* global require */
export let get_rand_int: () => number
if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const rand_data = new Int32Array(1)

    get_rand_int = function () {
        crypto.getRandomValues(rand_data)
        return rand_data[0]
    }
} else if (typeof require !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto')

    get_rand_int = function () {
        return nodeCrypto.randomBytes(4).readInt32LE(0)
    }
} else if (typeof process !== 'undefined') {
    import('node:' + 'crypto').then((nodeCrypto) => {
        get_rand_int = function () {
            return nodeCrypto['randomBytes'](4).readInt32LE(0)
        }
    })
} else {
    dbg_assert(false, 'Unsupported platform: No cryptographic random values')
}

export let int_log2: (x: number) => number

if (
    typeof Math.clz32 === 'function' &&
    Math.clz32(0) === 32 &&
    Math.clz32(0x12345) === 15 &&
    Math.clz32(-1) === 0
) {
    int_log2 = function (x: number): number {
        dbg_assert(x > 0)

        return 31 - Math.clz32(x)
    }
} else {
    const int_log2_table = new Int8Array(256)

    for (let i = 0, b = -2; i < 256; i++) {
        if (!(i & (i - 1))) b++

        int_log2_table[i] = b
    }

    int_log2 = function (x: number): number {
        x >>>= 0
        dbg_assert(x > 0)

        // http://jsperf.com/integer-log2/6
        const tt = x >>> 16

        if (tt) {
            const t = tt >>> 8
            if (t) {
                return 24 + int_log2_table[t]
            } else {
                return 16 + int_log2_table[tt]
            }
        } else {
            const t = x >>> 8
            if (t) {
                return 8 + int_log2_table[t]
            } else {
                return int_log2_table[x]
            }
        }
    }
}

export const round_up_to_next_power_of_2 = function (x: number): number {
    dbg_assert(x >= 0)
    return x <= 1 ? 1 : 1 << (1 + int_log2(x - 1))
}

if (typeof DEBUG !== 'undefined' && DEBUG) {
    dbg_assert(int_log2(1) === 0)
    dbg_assert(int_log2(2) === 1)
    dbg_assert(int_log2(7) === 2)
    dbg_assert(int_log2(8) === 3)
    dbg_assert(int_log2(123456789) === 26)

    dbg_assert(round_up_to_next_power_of_2(0) === 1)
    dbg_assert(round_up_to_next_power_of_2(1) === 1)
    dbg_assert(round_up_to_next_power_of_2(2) === 2)
    dbg_assert(round_up_to_next_power_of_2(7) === 8)
    dbg_assert(round_up_to_next_power_of_2(8) === 8)
    dbg_assert(round_up_to_next_power_of_2(123456789) === 134217728)
}

export class ByteQueue {
    length: number = 0
    private data: Uint8Array
    private start: number = 0
    private end: number = 0
    private size: number

    constructor(size: number) {
        this.size = size
        this.data = new Uint8Array(size)

        dbg_assert((size & (size - 1)) === 0)
    }

    push(item: number): void {
        if (this.length === this.size) {
            // intentional overwrite
        } else {
            this.length++
        }

        this.data[this.end] = item
        this.end = (this.end + 1) & (this.size - 1)
    }

    shift(): number {
        if (!this.length) {
            return -1
        } else {
            const item = this.data[this.start]

            this.start = (this.start + 1) & (this.size - 1)
            this.length--

            return item
        }
    }

    peek(): number {
        if (!this.length) {
            return -1
        } else {
            return this.data[this.start]
        }
    }

    clear(): void {
        this.start = 0
        this.end = 0
        this.length = 0
    }
}

export class FloatQueue {
    size: number
    data: Float32Array
    start: number = 0
    end: number = 0
    length: number = 0

    constructor(size: number) {
        this.size = size
        this.data = new Float32Array(size)

        dbg_assert((size & (size - 1)) === 0)
    }

    push(item: number): void {
        if (this.length === this.size) {
            // intentional overwrite
            this.start = (this.start + 1) & (this.size - 1)
        } else {
            this.length++
        }

        this.data[this.end] = item
        this.end = (this.end + 1) & (this.size - 1)
    }

    shift(): number | undefined {
        if (!this.length) {
            return undefined
        } else {
            const item = this.data[this.start]

            this.start = (this.start + 1) & (this.size - 1)
            this.length--

            return item
        }
    }

    shift_block(count: number): Float32Array {
        const slice = new Float32Array(count)

        if (count > this.length) {
            count = this.length
        }
        let slice_end = this.start + count

        const partial = this.data.subarray(this.start, slice_end)

        slice.set(partial)
        if (slice_end >= this.size) {
            slice_end -= this.size
            slice.set(this.data.subarray(0, slice_end), partial.length)
        }
        this.start = slice_end

        this.length -= count

        return slice
    }

    peek(): number | undefined {
        if (!this.length) {
            return undefined
        } else {
            return this.data[this.start]
        }
    }

    clear(): void {
        this.start = 0
        this.end = 0
        this.length = 0
    }
}

export function dump_file(ab: BlobPart | BlobPart[], name: string): void {
    if (!Array.isArray(ab)) {
        ab = [ab]
    }

    const blob = new Blob(ab)
    download(blob, name)
}

export function download(file_or_blob: Blob | File, name: string): void {
    const a = document.createElement('a')
    a['download'] = name
    a.href = window.URL.createObjectURL(file_or_blob)
    a.dataset['downloadurl'] = [
        'application/octet-stream',
        a['download'],
        a.href,
    ].join(':')

    if (document.createEvent) {
        const ev = document.createEvent('MouseEvent')
        ev.initMouseEvent(
            'click',
            true,
            true,
            window,
            0,
            0,
            0,
            0,
            0,
            false,
            false,
            false,
            false,
            0,
            null,
        )
        a.dispatchEvent(ev)
    } else {
        a.click()
    }

    window.URL.revokeObjectURL(a.href)
}

export class Bitmap {
    view: Uint8Array

    constructor(length_or_buffer: number | ArrayBuffer) {
        if (typeof length_or_buffer === 'number') {
            this.view = new Uint8Array((length_or_buffer + 7) >> 3)
        } else if (length_or_buffer instanceof ArrayBuffer) {
            this.view = new Uint8Array(length_or_buffer)
        } else {
            dbg_assert(false, 'Bitmap: Invalid argument')
            this.view = new Uint8Array(0)
        }
    }

    set(index: number, value: number): void {
        const bit_index = index & 7
        const byte_index = index >> 3
        const bit_mask = 1 << bit_index

        this.view[byte_index] = value
            ? this.view[byte_index] | bit_mask
            : this.view[byte_index] & ~bit_mask
    }

    get(index: number): number {
        const bit_index = index & 7
        const byte_index = index >> 3

        return (this.view[byte_index] >> bit_index) & 1
    }

    get_buffer(): ArrayBufferLike {
        return this.view.buffer
    }
}

export interface LoadFileOptions {
    done?: (result: any, http?: XMLHttpRequest) => void
    progress?: (e: ProgressEvent) => void
    as_json?: boolean
    method?: string
    headers?: Record<string, string>
    range?: { start: number; length: number }
}

export let load_file: (
    filename: string,
    options: LoadFileOptions,
    n_tries?: number,
) => Promise<void>
export let get_file_size: (path: string) => Promise<number>

if (
    typeof XMLHttpRequest === 'undefined' ||
    (typeof process !== 'undefined' &&
        process.versions &&
        process.versions.node)
) {
    let fs: any

    load_file = async function (
        filename: string,
        options: LoadFileOptions,
        _n_tries?: number,
    ) {
        if (!fs) {
            // string concat to work around closure compiler 'Invalid module path "node:fs/promises" for resolution mode'
            fs = await import('node:' + 'fs/promises')
        }

        if (options.range) {
            dbg_assert(!options.as_json)

            const fd = await fs['open'](filename, 'r')

            const length = options.range.length
            const buffer = Buffer.allocUnsafe(length)

            try {
                const result = await fd['read']({
                    buffer,
                    position: options.range.start,
                })
                dbg_assert(result.bytesRead === length)
            } finally {
                await fd['close']()
            }

            if (options.done) {
                options.done(new Uint8Array(buffer))
            }
        } else {
            const o = {
                encoding: options.as_json ? 'utf-8' : null,
            }

            const data = await fs['readFile'](filename, o)
            if (options.as_json) {
                options.done!(JSON.parse(data))
            } else {
                options.done!(new Uint8Array(data).buffer)
            }
        }
    }

    get_file_size = async function (path: string) {
        if (!fs) {
            // string concat to work around closure compiler 'Invalid module path "node:fs/promises" for resolution mode'
            fs = await import('node:' + 'fs/promises')
        }
        const stat = await fs['stat'](path)
        return stat.size
    }
} else {
    load_file = async function (
        filename: string,
        options: LoadFileOptions,
        n_tries?: number,
    ) {
        const http = new XMLHttpRequest()

        http.open(options.method || 'get', filename, true)

        if (options.as_json) {
            http.responseType = 'json'
        } else {
            http.responseType = 'arraybuffer'
        }

        if (options.headers) {
            const header_names = Object.keys(options.headers)

            for (let i = 0; i < header_names.length; i++) {
                const name = header_names[i]
                http.setRequestHeader(name, options.headers[name])
            }
        }

        if (options.range) {
            const start = options.range.start
            const end = start + options.range.length - 1
            http.setRequestHeader('Range', 'bytes=' + start + '-' + end)
            http.setRequestHeader('X-Accept-Encoding', 'identity')

            // Abort if server responds with complete file in response to range
            // request, to prevent downloading large files from broken http servers
            http.onreadystatechange = function () {
                if (http.status === 200) {
                    console.error(
                        'Server sent full file in response to ranged request, aborting',
                        { filename },
                    )
                    http.abort()
                }
            }
        }

        http.onload = function (_e) {
            if (http.readyState === 4) {
                if (http.status !== 200 && http.status !== 206) {
                    console.error(
                        'Loading the image ' + filename + ' failed (status %d)',
                        http.status,
                    )
                    if (http.status >= 500 && http.status < 600) {
                        retry()
                    }
                } else if (http.response) {
                    if (options.range) {
                        const enc = http.getResponseHeader('Content-Encoding')
                        if (enc && enc !== 'identity') {
                            console.error(
                                'Server sent Content-Encoding in response to ranged request',
                                { filename, enc },
                            )
                        }
                    }
                    if (options.done) {
                        options.done(http.response, http)
                    }
                }
            }
        }

        http.onerror = function (e) {
            console.error('Loading the image ' + filename + ' failed', e)
            retry()
        }

        if (options.progress) {
            http.onprogress = function (e) {
                options.progress!(e)
            }
        }

        http.send(null)

        function retry() {
            const number_of_tries = n_tries || 0
            const timeout = [1, 1, 2, 3, 5, 8, 13, 21][number_of_tries] || 34
            setTimeout(() => {
                load_file(filename, options, number_of_tries + 1)
            }, 1000 * timeout)
        }
    }

    get_file_size = async function (url: string) {
        return new Promise((resolve, reject) => {
            load_file(url, {
                done: (_buffer, http) => {
                    const header =
                        http!.getResponseHeader('Content-Range') || ''
                    const match = header.match(/\/(\d+)\s*$/)

                    if (match) {
                        resolve(+match[1])
                    } else {
                        const error = new Error(
                            '`Range: bytes=...` header not supported (Got `' +
                                header +
                                '`)',
                        )
                        reject(error)
                    }
                },
                headers: {
                    Range: 'bytes=0-0',
                    'X-Accept-Encoding': 'identity',
                },
            })
        })
    }
}

// Reads len characters at offset from Memory object mem as a JS string
export function read_sized_string_from_mem(
    mem: { buffer: ArrayBuffer },
    offset: number,
    len: number,
): string {
    offset >>>= 0
    len >>>= 0
    return String.fromCharCode(...new Uint8Array(mem.buffer, offset, len))
}

const CHARMAPS: Record<string, string> = {
    cp437: ' \u263A\u263B\u2665\u2666\u2663\u2660\u2022\u25D8\u25CB\u25D9\u2642\u2640\u266A\u266B\u263C\u25BA\u25C4\u2195\u203C\u00B6\u00A7\u25AC\u21A8\u2191\u2193\u2192\u2190\u221F\u2194\u25B2\u25BC !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u2302\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9\u00FF\u00D6\u00DC\u00A2\u00A3\u00A5\u20A7\u0192\u00E1\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA\u00BF\u2310\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580\u03B1\u00DF\u0393\u03C0\u03A3\u03C3\u00B5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229\u2261\u00B1\u2265\u2264\u2320\u2321\u00F7\u2248\u00B0\u2219\u00B7\u221A\u207F\u00B2\u25A0 ',
    cp858: '\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9\u00FF\u00D6\u00DC\u00F8\u00A3\u00D8\u00D7\u0192\u00E1\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA\u00BF\u00AE\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB\u2591\u2592\u2593\u2502\u2524\u00C1\u00C2\u00C0\u00A9\u2563\u2551\u2557\u255D\u00A2\u00A5\u2510\u2514\u2534\u252C\u251C\u2500\u253C\u00E3\u00C3\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u00A4\u00F0\u00D0\u00CA\u00CB\u00C8\u20AC\u00CD\u00CE\u00CF\u2518\u250C\u2588\u2584\u00A6\u00CC\u2580\u00D3\u00DF\u00D4\u00D2\u00F5\u00D5\u00B5\u00FE\u00DE\u00DA\u00DB\u00D9\u00FD\u00DD\u00AF\u00B4\u00AD\u00B1\u2017\u00BE\u00B6\u00A7\u00F7\u00B8\u00B0\u00A8\u00B7\u00B9\u00B3\u00B2\u25A0 ',
}

CHARMAPS.cp858 = CHARMAPS.cp437.slice(0, 128) + CHARMAPS.cp858
CHARMAPS.ascii = CHARMAPS.cp437
    .split('')
    .map((c, i) => (i > 31 && i < 128 ? c : '.'))
    .join('')

export function get_charmap(encoding: string): string {
    return encoding && CHARMAPS[encoding] ? CHARMAPS[encoding] : CHARMAPS.cp437
}
