declare var DEBUG: boolean

import { LOG_SERIAL } from './const.js'
import { h } from './lib.js'
import { dbg_log } from './log.js'
import { IO } from './io.js'
import { BusConnector } from './bus.js'

/*
 * Serial ports
 * http://wiki.osdev.org/UART
 * https://github.com/s-macke/jor1k/blob/master/js/worker/dev/uart.js
 * https://www.freebsd.org/doc/en/articles/serial-uart/
 */

const DLAB = 0x80

const UART_IER_MSI = 0x08 /* Modem Status Changed int. */
const UART_IER_THRI = 0x02 /* Enable Transmitter holding register int. */
const UART_IER_RDI = 0x01 /* Enable receiver data interrupt */

const UART_IIR_MSI = 0x00 /* Modem status interrupt (Low priority) */
const UART_IIR_NO_INT = 0x01
const UART_IIR_THRI = 0x02 /* Transmitter holding register empty */
const UART_IIR_RDI = 0x04 /* Receiver data interrupt */
const UART_IIR_RLSI = 0x06 /* Receiver line status interrupt (High p.) */
const UART_IIR_CTI = 0x0c /* Character timeout */

// Modem control register
const UART_MCR_LOOPBACK = 0x10

const UART_LSR_DATA_READY = 0x1 // data available
const UART_LSR_TX_EMPTY = 0x20 // TX (THR) buffer is empty
const UART_LSR_TRANSMITTER_EMPTY = 0x40 // TX empty and line is idle

// Modem status register
const UART_MSR_DCD = 0x7 // Data Carrier Detect
const UART_MSR_RI = 0x6 // Ring Indicator
const UART_MSR_DSR = 0x5 // Data Set Ready
const UART_MSR_CTS = 0x4 // Clear To Send
// Delta bits
const UART_MSR_DDCD = 0x3 // Delta DCD
const UART_MSR_TERI = 0x2 // Trailing Edge RI
const UART_MSR_DDSR = 0x1 // Delta DSR
const UART_MSR_DCTS = 0x0 // Delta CTS

// Minimal interface for CPU fields UART uses
interface UARTCpu {
    io: IO
    device_raise_irq(irq: number): void
    device_lower_irq(irq: number): void
}

type UARTState = [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
]

/**
 * UART serial port controller.
 */
export class UART {
    name: string
    bus: BusConnector
    cpu: UARTCpu
    ints: number
    baud_rate: number
    line_control: number
    lsr: number
    fifo_control: number
    ier: number
    iir: number
    modem_control: number
    modem_status: number
    scratch_register: number
    irq: number
    input: number[]
    current_line: string
    com: number

    constructor(cpu: UARTCpu, port: number, bus: BusConnector) {
        this.name = 'uart'
        this.bus = bus
        this.cpu = cpu

        this.ints = 1 << UART_IIR_THRI

        this.baud_rate = 0

        this.line_control = 0

        // line status register
        this.lsr = UART_LSR_TRANSMITTER_EMPTY | UART_LSR_TX_EMPTY

        this.fifo_control = 0

        // interrupts enable
        this.ier = 0

        // interrupt identification register
        this.iir = UART_IIR_NO_INT

        this.modem_control = 0
        this.modem_status = 0

        this.scratch_register = 0

        this.irq = 0

        this.input = []

        this.current_line = ''

        switch (port) {
            case 0x3f8:
                this.com = 0
                this.irq = 4
                break
            case 0x2f8:
                this.com = 1
                this.irq = 3
                break
            case 0x3e8:
                this.com = 2
                this.irq = 4
                break
            case 0x2e8:
                this.com = 3
                this.irq = 3
                break
            default:
                dbg_log('Invalid serial port: ' + h(port), LOG_SERIAL)
                this.com = 0
                this.irq = 4
        }

        this.bus.register(
            'serial' + this.com + '-input',
            (data: number): void => {
                this.data_received(data)
            },
            this,
        )

        this.bus.register(
            'serial' + this.com + '-modem-status-input',
            (data: number): void => {
                this.set_modem_status(data)
            },
            this,
        )

        // Set individual modem status bits

        this.bus.register(
            'serial' + this.com + '-carrier-detect-input',
            (data: number): void => {
                const status = data
                    ? this.modem_status |
                      (1 << UART_MSR_DCD) |
                      (1 << UART_MSR_DDCD)
                    : this.modem_status &
                      ~(1 << UART_MSR_DCD) &
                      ~(1 << UART_MSR_DDCD)
                this.set_modem_status(status)
            },
            this,
        )

        this.bus.register(
            'serial' + this.com + '-ring-indicator-input',
            (data: number): void => {
                const status = data
                    ? this.modem_status |
                      (1 << UART_MSR_RI) |
                      (1 << UART_MSR_TERI)
                    : this.modem_status &
                      ~(1 << UART_MSR_RI) &
                      ~(1 << UART_MSR_TERI)
                this.set_modem_status(status)
            },
            this,
        )

        this.bus.register(
            'serial' + this.com + '-data-set-ready-input',
            (data: number): void => {
                const status = data
                    ? this.modem_status |
                      (1 << UART_MSR_DSR) |
                      (1 << UART_MSR_DDSR)
                    : this.modem_status &
                      ~(1 << UART_MSR_DSR) &
                      ~(1 << UART_MSR_DDSR)
                this.set_modem_status(status)
            },
            this,
        )

        this.bus.register(
            'serial' + this.com + '-clear-to-send-input',
            (data: number): void => {
                const status = data
                    ? this.modem_status |
                      (1 << UART_MSR_CTS) |
                      (1 << UART_MSR_DCTS)
                    : this.modem_status &
                      ~(1 << UART_MSR_CTS) &
                      ~(1 << UART_MSR_DCTS)
                this.set_modem_status(status)
            },
            this,
        )

        var io = cpu.io

        io.register_write(
            port,
            this,
            (out_byte: number): void => {
                this.write_data(out_byte)
            },
            (out_word: number): void => {
                this.write_data(out_word & 0xff)
                this.write_data(out_word >> 8)
            },
        )

        io.register_write(port | 1, this, (out_byte: number): void => {
            if (this.line_control & DLAB) {
                this.baud_rate = (this.baud_rate & 0xff) | (out_byte << 8)
                dbg_log('baud rate: ' + h(this.baud_rate), LOG_SERIAL)
            } else {
                if (
                    (this.ier & UART_IIR_THRI) === 0 &&
                    out_byte & UART_IIR_THRI
                ) {
                    // re-throw THRI if it was masked
                    this.ThrowInterrupt(UART_IIR_THRI)
                }

                this.ier = out_byte & 0xf
                dbg_log('interrupt enable: ' + h(out_byte), LOG_SERIAL)
                this.CheckInterrupt()
            }
        })

        io.register_read(port, this, (): number => {
            if (this.line_control & DLAB) {
                return this.baud_rate & 0xff
            } else {
                let data = 0

                if (this.input.length === 0) {
                    dbg_log('Read input empty', LOG_SERIAL)
                } else {
                    data = this.input.shift()!
                    dbg_log('Read input: ' + h(data), LOG_SERIAL)
                }

                if (this.input.length === 0) {
                    this.lsr &= ~UART_LSR_DATA_READY
                    this.ClearInterrupt(UART_IIR_CTI)
                    this.ClearInterrupt(UART_IIR_RDI)
                }

                return data
            }
        })

        io.register_read(port | 1, this, (): number => {
            if (this.line_control & DLAB) {
                return this.baud_rate >> 8
            } else {
                return this.ier & 0xf
            }
        })

        io.register_read(port | 2, this, (): number => {
            var ret = this.iir & 0xf
            dbg_log('read interrupt identification: ' + h(this.iir), LOG_SERIAL)

            if (this.iir === UART_IIR_THRI) {
                this.ClearInterrupt(UART_IIR_THRI)
            }

            if (this.fifo_control & 1) ret |= 0xc0

            return ret
        })
        io.register_write(port | 2, this, (out_byte: number): void => {
            dbg_log('fifo control: ' + h(out_byte), LOG_SERIAL)
            this.fifo_control = out_byte
        })

        io.register_read(port | 3, this, (): number => {
            dbg_log('read line control: ' + h(this.line_control), LOG_SERIAL)
            return this.line_control
        })
        io.register_write(port | 3, this, (out_byte: number): void => {
            dbg_log('line control: ' + h(out_byte), LOG_SERIAL)
            this.line_control = out_byte
        })

        io.register_read(port | 4, this, (): number => {
            return this.modem_control
        })
        io.register_write(port | 4, this, (out_byte: number): void => {
            dbg_log('modem control: ' + h(out_byte), LOG_SERIAL)
            this.modem_control = out_byte
        })

        io.register_read(port | 5, this, (): number => {
            dbg_log('read line status: ' + h(this.lsr), LOG_SERIAL)
            return this.lsr
        })
        io.register_write(port | 5, this, (_out_byte: number): void => {
            dbg_log('Factory test write', LOG_SERIAL)
        })

        io.register_read(port | 6, this, (): number => {
            dbg_log('read modem status: ' + h(this.modem_status), LOG_SERIAL)
            // Clear delta bits
            this.modem_status &= 0xf0
            return this.modem_status
        })
        io.register_write(port | 6, this, (out_byte: number): void => {
            dbg_log('write modem status: ' + h(out_byte), LOG_SERIAL)
            this.set_modem_status(out_byte)
        })

        io.register_read(port | 7, this, (): number => {
            return this.scratch_register
        })
        io.register_write(port | 7, this, (out_byte: number): void => {
            this.scratch_register = out_byte
        })
    }

    get_state(): UARTState {
        var state: UARTState = [
            this.ints,
            this.baud_rate,
            this.line_control,
            this.lsr,
            this.fifo_control,
            this.ier,
            this.iir,
            this.modem_control,
            this.modem_status,
            this.scratch_register,
            this.irq,
        ]

        return state
    }

    set_state(state: UARTState): void {
        this.ints = state[0]
        this.baud_rate = state[1]
        this.line_control = state[2]
        this.lsr = state[3]
        this.fifo_control = state[4]
        this.ier = state[5]
        this.iir = state[6]
        this.modem_control = state[7]
        this.modem_status = state[8]
        this.scratch_register = state[9]
        this.irq = state[10]
    }

    CheckInterrupt(): void {
        if (this.ints & (1 << UART_IIR_CTI) && this.ier & UART_IER_RDI) {
            this.iir = UART_IIR_CTI
            this.cpu.device_raise_irq(this.irq)
        } else if (this.ints & (1 << UART_IIR_RDI) && this.ier & UART_IER_RDI) {
            this.iir = UART_IIR_RDI
            this.cpu.device_raise_irq(this.irq)
        } else if (
            this.ints & (1 << UART_IIR_THRI) &&
            this.ier & UART_IER_THRI
        ) {
            this.iir = UART_IIR_THRI
            this.cpu.device_raise_irq(this.irq)
        } else if (this.ints & (1 << UART_IIR_MSI) && this.ier & UART_IER_MSI) {
            this.iir = UART_IIR_MSI
            this.cpu.device_raise_irq(this.irq)
        } else {
            this.iir = UART_IIR_NO_INT
            this.cpu.device_lower_irq(this.irq)
        }
    }

    ThrowInterrupt(line: number): void {
        this.ints |= 1 << line
        this.CheckInterrupt()
    }

    ClearInterrupt(line: number): void {
        this.ints &= ~(1 << line)
        this.CheckInterrupt()
    }

    data_received(data: number): void {
        dbg_log('input: ' + h(data), LOG_SERIAL)
        this.input.push(data)

        this.lsr |= UART_LSR_DATA_READY

        if (this.fifo_control & 1) {
            this.ThrowInterrupt(UART_IIR_CTI)
        } else {
            this.ThrowInterrupt(UART_IIR_RDI)
        }
    }

    write_data(out_byte: number): void {
        if (this.line_control & DLAB) {
            this.baud_rate = (this.baud_rate & ~0xff) | out_byte
            return
        }

        dbg_log('data: ' + h(out_byte), LOG_SERIAL)

        this.ThrowInterrupt(UART_IIR_THRI)

        if (this.modem_control & UART_MCR_LOOPBACK) {
            this.data_received(out_byte)
        } else {
            this.bus.send('serial' + this.com + '-output-byte', out_byte)
        }

        if (DEBUG) {
            var char = String.fromCharCode(out_byte)
            this.current_line += char

            if (char === '\n') {
                const line = this.current_line
                    .trimRight()
                    .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\xff]/g, '')
                dbg_log('SERIAL: ' + line)
                this.current_line = ''
            }
        }
    }

    set_modem_status(status: number): void {
        dbg_log('modem status: ' + h(status), LOG_SERIAL)
        const prev_delta_bits = this.modem_status & 0x0f
        // compare the bits that have changed and shift them into the delta bits
        let delta = (this.modem_status ^ status) >> 4
        // The delta should stay set if they were previously set
        delta |= prev_delta_bits

        // update the current modem status
        this.modem_status = status
        // update the delta bits based on the changes and previous
        // values, but also leave the delta bits set if they were
        // passed in as part of the status
        this.modem_status |= delta
    }
}
