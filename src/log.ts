declare let DEBUG: boolean

if (typeof DEBUG === 'undefined') {
    Object.defineProperty(globalThis, 'DEBUG', {
        value: true,
        writable: true,
        configurable: true,
    })
}

import { LOG_NAMES } from './const.js'
import { pad0, pads } from './lib.js'
import {
    LOG_ALL,
    LOG_PS2,
    LOG_PIT,
    LOG_9P,
    LOG_PIC,
    LOG_DMA,
    LOG_NET,
    LOG_FLOPPY,
    LOG_DISK,
    LOG_SERIAL,
    LOG_VGA,
    LOG_SB16,
    LOG_VIRTIO,
} from './const.js'

export const LOG_TO_FILE = false

export let LOG_LEVEL: number =
    LOG_ALL &
    ~LOG_PS2 &
    ~LOG_PIT &
    ~LOG_VIRTIO &
    ~LOG_9P &
    ~LOG_PIC &
    ~LOG_DMA &
    ~LOG_SERIAL &
    ~LOG_NET &
    ~LOG_FLOPPY &
    ~LOG_DISK &
    ~LOG_VGA &
    ~LOG_SB16

export function set_log_level(level: number): void {
    LOG_LEVEL = level
}

export const log_data: string[] = []

function do_the_log(message: string): void {
    if (LOG_TO_FILE) {
        log_data.push(message, '\n')
    } else {
        console.log(message)
    }
}

export const dbg_log: (stuff: string | number, level?: number) => void =
    (function () {
        if (!DEBUG) {
            return function () {}
        }

        const init: Record<number, string> = {}
        const dbg_names = LOG_NAMES.reduce(function (a, x) {
            a[x[0]] = x[1]
            return a
        }, init)

        let log_last_message = ''
        let log_message_repetitions = 0

        function dbg_log_(stuff: string | number, level?: number): void {
            if (!DEBUG) return

            level = level || 1

            if (level & LOG_LEVEL) {
                const level_name = dbg_names[level] || '',
                    message = '[' + pads(level_name, 4) + '] ' + stuff

                if (message === log_last_message) {
                    log_message_repetitions++

                    if (log_message_repetitions < 2048) {
                        return
                    }
                }

                const now = new Date()
                const time_str =
                    pad0(now.getHours(), 2) +
                    ':' +
                    pad0(now.getMinutes(), 2) +
                    ':' +
                    pad0(now.getSeconds(), 2) +
                    '+' +
                    pad0(now.getMilliseconds(), 3) +
                    ' '

                if (log_message_repetitions) {
                    if (log_message_repetitions === 1) {
                        do_the_log(time_str + log_last_message)
                    } else {
                        do_the_log(
                            'Previous message repeated ' +
                                log_message_repetitions +
                                ' times',
                        )
                    }

                    log_message_repetitions = 0
                }

                do_the_log(time_str + message)
                log_last_message = message
            }
        }

        return dbg_log_
    })()

export function dbg_trace(level?: number): void {
    if (!DEBUG) return

    dbg_log(Error().stack!, level)
}

export function dbg_assert(cond: boolean, msg?: string, _level?: number): void {
    if (!DEBUG) return

    if (!cond) {
        dbg_assert_failed(msg)
    }
}

export function dbg_assert_failed(msg?: string): never {
    // eslint-disable-next-line no-debugger
    debugger
    console.trace()

    if (msg) {
        throw 'Assert failed: ' + msg
    } else {
        throw 'Assert failed'
    }
}
