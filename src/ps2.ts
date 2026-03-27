import { LOG_PS2 } from './const.js'
import { h, ByteQueue } from './lib.js'
import { dbg_log } from './log.js'
import { IO } from './io.js'
import { BusConnector } from './bus.js'

const PS2_LOG_VERBOSE = false

// Minimal interface for CPU fields PS2 uses
interface PS2Cpu {
    io: IO
    device_raise_irq(irq: number): void
    device_lower_irq(irq: number): void
    reboot(): void
}

type PS2State = [
    boolean, // 0: enable_mouse_stream
    boolean, // 1: use_mouse
    boolean, // 2: have_mouse
    number, // 3: mouse_delta_x
    number, // 4: mouse_delta_y
    number, // 5: mouse_clicks
    boolean, // 6: have_keyboard
    boolean, // 7: enable_keyboard_stream
    boolean, // 8: next_is_mouse_command
    boolean, // 9: next_read_sample
    boolean, // 10: next_read_led
    boolean, // 11: next_handle_scan_code_set
    boolean, // 12: next_read_rate
    boolean, // 13: next_read_resolution
    undefined, // 14: kbd_buffer (unused)
    number, // 15: last_port60_byte
    number, // 16: sample_rate
    number, // 17: resolution
    boolean, // 18: scaling2
    undefined, // 19: mouse_buffer (unused)
    number, // 20: command_register
    boolean, // 21: read_output_register
    boolean, // 22: read_command_register
    number, // 23: controller_output_port
    boolean, // 24: read_controller_output_port
    number, // 25: mouse_id
    number, // 26: mouse_detect_state
    boolean, // 27: mouse_reset_workaround
]

/**
 * PS2 controller for keyboard and mouse.
 */
export class PS2 {
    name: string
    cpu: PS2Cpu
    bus: BusConnector

    enable_mouse_stream: boolean = false
    use_mouse: boolean = false
    have_mouse: boolean = true
    mouse_delta_x: number = 0
    mouse_delta_y: number = 0
    mouse_clicks: number = 0
    have_keyboard: boolean = true
    enable_keyboard_stream: boolean = false
    next_is_mouse_command: boolean = false
    next_read_sample: boolean = false
    next_read_led: boolean = false
    next_handle_scan_code_set: boolean = false
    next_read_rate: boolean = false
    next_read_resolution: boolean = false
    kbd_buffer: ByteQueue
    last_port60_byte: number = 0
    sample_rate: number = 100
    mouse_detect_state: number = 0
    mouse_id: number = 0x00
    mouse_reset_workaround: boolean = false
    wheel_movement: number = 0
    resolution: number = 4
    scaling2: boolean = false
    last_mouse_packet: number = -1
    mouse_buffer: ByteQueue
    next_byte_is_ready: boolean = false
    next_byte_is_aux: boolean = false
    command_register: number = 0
    controller_output_port: number = 0
    read_output_register: boolean = false
    read_command_register: boolean = false
    read_controller_output_port: boolean = false

    constructor(cpu: PS2Cpu, bus: BusConnector) {
        this.name = 'ps2'
        this.cpu = cpu
        this.bus = bus

        this.kbd_buffer = new ByteQueue(1024)
        this.mouse_buffer = new ByteQueue(1024)

        this.reset()

        this.bus.register(
            'keyboard-code',
            (code: number): void => {
                this.kbd_send_code(code)
            },
            this,
        )

        this.bus.register(
            'mouse-click',
            (data: [number, number, number]): void => {
                this.mouse_send_click(data[0], data[1], data[2])
            },
            this,
        )

        this.bus.register(
            'mouse-delta',
            (data: [number, number]): void => {
                this.mouse_send_delta(data[0], data[1])
            },
            this,
        )

        this.bus.register(
            'mouse-wheel',
            (data: [number, number]): void => {
                this.wheel_movement -= data[0]
                this.wheel_movement -= data[1] * 2 // X Wheel Movement
                this.wheel_movement = Math.min(
                    7,
                    Math.max(-8, this.wheel_movement),
                )
                this.send_mouse_packet(0, 0)
            },
            this,
        )

        cpu.io.register_read(0x60, this, this.port60_read.bind(this))
        cpu.io.register_read(0x64, this, this.port64_read.bind(this))

        cpu.io.register_write(0x60, this, this.port60_write.bind(this))
        cpu.io.register_write(0x64, this, this.port64_write.bind(this))
    }

    reset(): void {
        this.enable_mouse_stream = false
        this.use_mouse = false
        this.have_mouse = true
        this.mouse_delta_x = 0
        this.mouse_delta_y = 0
        this.mouse_clicks = 0
        this.have_keyboard = true
        this.enable_keyboard_stream = false
        this.next_is_mouse_command = false
        this.next_read_sample = false
        this.next_read_led = false
        this.next_handle_scan_code_set = false
        this.next_read_rate = false
        this.next_read_resolution = false

        this.kbd_buffer = new ByteQueue(1024)

        this.last_port60_byte = 0

        this.sample_rate = 100
        this.mouse_detect_state = 0
        this.mouse_id = 0x00
        this.mouse_reset_workaround = false
        this.wheel_movement = 0
        this.resolution = 4
        this.scaling2 = false
        this.last_mouse_packet = -1

        this.mouse_buffer = new ByteQueue(1024)

        // Also known as DBBOUT OBF - Output Buffer Full flag
        this.next_byte_is_ready = false
        this.next_byte_is_aux = false

        this.command_register = 1 | 4
        // TODO: What should be the initial value?
        this.controller_output_port = 0
        this.read_output_register = false
        this.read_command_register = false
        this.read_controller_output_port = false
    }

    get_state(): PS2State {
        const state: PS2State = [
            this.enable_mouse_stream,
            this.use_mouse,
            this.have_mouse,
            this.mouse_delta_x,
            this.mouse_delta_y,
            this.mouse_clicks,
            this.have_keyboard,
            this.enable_keyboard_stream,
            this.next_is_mouse_command,
            this.next_read_sample,
            this.next_read_led,
            this.next_handle_scan_code_set,
            this.next_read_rate,
            this.next_read_resolution,
            undefined, //this.kbd_buffer;
            this.last_port60_byte,
            this.sample_rate,
            this.resolution,
            this.scaling2,
            undefined, //this.mouse_buffer;
            this.command_register,
            this.read_output_register,
            this.read_command_register,
            this.controller_output_port,
            this.read_controller_output_port,
            this.mouse_id,
            this.mouse_detect_state,
            this.mouse_reset_workaround,
        ]

        return state
    }

    set_state(state: PS2State): void {
        this.enable_mouse_stream = state[0]
        this.use_mouse = state[1]
        this.have_mouse = state[2]
        this.mouse_delta_x = state[3]
        this.mouse_delta_y = state[4]
        this.mouse_clicks = state[5]
        this.have_keyboard = state[6]
        this.enable_keyboard_stream = state[7]
        this.next_is_mouse_command = state[8]
        this.next_read_sample = state[9]
        this.next_read_led = state[10]
        this.next_handle_scan_code_set = state[11]
        this.next_read_rate = state[12]
        this.next_read_resolution = state[13]
        //this.kbd_buffer = state[14];
        this.last_port60_byte = state[15]
        this.sample_rate = state[16]
        this.resolution = state[17]
        this.scaling2 = state[18]
        //this.mouse_buffer = state[19];
        this.command_register = state[20]
        this.read_output_register = state[21]
        this.read_command_register = state[22]
        this.controller_output_port = state[23]
        this.read_controller_output_port = state[24]
        this.mouse_id = state[25] || 0
        this.mouse_detect_state = state[26] || 0
        this.mouse_reset_workaround = state[27] || false

        this.next_byte_is_ready = false
        this.next_byte_is_aux = false
        this.kbd_buffer.clear()
        this.mouse_buffer.clear()

        this.bus.send('mouse-enable', this.use_mouse)
    }

    raise_irq(): void {
        if (this.next_byte_is_ready) {
            // Wait until previous byte is read
            // http://halicery.com/Hardware/8042/8042_1503033_TXT.htm
            return
        }

        // Kbd has priority over aux
        if (this.kbd_buffer.length) {
            this.kbd_irq()
        } else if (this.mouse_buffer.length) {
            this.mouse_irq()
        }
    }

    mouse_irq(): void {
        this.next_byte_is_ready = true
        this.next_byte_is_aux = true

        if (this.command_register & 2) {
            dbg_log('Mouse irq', LOG_PS2)

            // Pulse the irq line
            // Note: can't lower immediately after rising, so lower before rising
            // http://www.os2museum.com/wp/ibm-ps2-model-50-keyboard-controller/
            this.cpu.device_lower_irq(12)
            this.cpu.device_raise_irq(12)
        }
    }

    kbd_irq(): void {
        this.next_byte_is_ready = true
        this.next_byte_is_aux = false

        if (this.command_register & 1) {
            dbg_log('Keyboard irq', LOG_PS2)

            // Pulse the irq line
            // Note: can't lower immediately after rising, so lower before rising
            // http://www.os2museum.com/wp/ibm-ps2-model-50-keyboard-controller/
            this.cpu.device_lower_irq(1)
            this.cpu.device_raise_irq(1)
        }
    }

    kbd_send_code(code: number): void {
        if (this.enable_keyboard_stream) {
            dbg_log('adding kbd code: ' + h(code), LOG_PS2)
            this.kbd_buffer.push(code)
            this.raise_irq()
        }
    }

    mouse_send_delta(delta_x: number, delta_y: number): void {
        if (!this.have_mouse || !this.use_mouse) {
            return
        }

        // note: delta_x or delta_y can be floating point numbers

        //const factor = this.resolution * this.sample_rate / 80;
        const factor = 1

        this.mouse_delta_x += delta_x * factor
        this.mouse_delta_y += delta_y * factor

        if (this.enable_mouse_stream) {
            const change_x = this.mouse_delta_x | 0,
                change_y = this.mouse_delta_y | 0

            if (change_x || change_y) {
                //var now = Date.now();
                //if(now - this.last_mouse_packet < 1000 / this.sample_rate)
                //{
                //    // TODO: set timeout
                //    return;
                //}

                this.mouse_delta_x -= change_x
                this.mouse_delta_y -= change_y

                this.send_mouse_packet(change_x, change_y)
            }
        }
    }

    mouse_send_click(left: number, middle: number, right: number): void {
        if (!this.have_mouse || !this.use_mouse) {
            return
        }

        this.mouse_clicks = left | (right << 1) | (middle << 2)

        if (this.enable_mouse_stream) {
            this.send_mouse_packet(0, 0)
        }
    }

    send_mouse_packet(dx: number, dy: number): void {
        const info_byte =
                ((dy < 0 ? 1 : 0) << 5) |
                ((dx < 0 ? 1 : 0) << 4) |
                (1 << 3) |
                this.mouse_clicks,
            delta_x = dx,
            delta_y = dy

        this.last_mouse_packet = Date.now()

        //if(this.scaling2)
        //{
        //    // only in automatic packets, not 0xEB requests
        //    delta_x = this.apply_scaling2(delta_x);
        //    delta_y = this.apply_scaling2(delta_y);
        //}

        this.mouse_buffer.push(info_byte)
        this.mouse_buffer.push(delta_x)
        this.mouse_buffer.push(delta_y)

        if (this.mouse_id === 0x04) {
            this.mouse_buffer.push(
                (0 << 5) | // TODO: 5th button
                    (0 << 4) | // TODO: 4th button
                    (this.wheel_movement & 0x0f),
            )
            this.wheel_movement = 0
        } else if (this.mouse_id === 0x03) {
            this.mouse_buffer.push(this.wheel_movement & 0xff) // Byte 4 - Z Movement
            this.wheel_movement = 0
        }

        if (PS2_LOG_VERBOSE) {
            dbg_log('adding mouse packets: ' + [info_byte, dx, dy], LOG_PS2)
        }

        this.raise_irq()
    }

    apply_scaling2(n: number): number {
        // http://www.computer-engineering.org/ps2mouse/#Inputs.2C_Resolution.2C_and_Scaling
        const abs = Math.abs(n),
            sign = n >> 31

        switch (abs) {
            case 0:
            case 1:
            case 3:
                return n
            case 2:
                return sign
            case 4:
                return 6 * sign
            case 5:
                return 9 * sign
            default:
                return n << 1
        }
    }

    port60_read(): number {
        //dbg_log("port 60 read: " + (buffer[0] || "(none)"));

        this.next_byte_is_ready = false

        if (!this.kbd_buffer.length && !this.mouse_buffer.length) {
            // should not happen
            dbg_log('Port 60 read: Empty', LOG_PS2)
            return this.last_port60_byte
        }

        if (this.next_byte_is_aux) {
            this.cpu.device_lower_irq(12)
            this.last_port60_byte = this.mouse_buffer.shift()
            dbg_log(
                'Port 60 read (mouse): ' + h(this.last_port60_byte),
                LOG_PS2,
            )
        } else {
            this.cpu.device_lower_irq(1)
            this.last_port60_byte = this.kbd_buffer.shift()
            dbg_log(
                'Port 60 read (kbd)  : ' + h(this.last_port60_byte),
                LOG_PS2,
            )
        }

        if (this.kbd_buffer.length || this.mouse_buffer.length) {
            this.raise_irq()
        }

        return this.last_port60_byte
    }

    port64_read(): number {
        // status port

        let status_byte = 0x10

        if (this.next_byte_is_ready) {
            status_byte |= 0x1
        }
        if (this.next_byte_is_aux) {
            status_byte |= 0x20
        }

        dbg_log('port 64 read: ' + h(status_byte), LOG_PS2)

        return status_byte
    }

    port60_write(write_byte: number): void {
        dbg_log('port 60 write: ' + h(write_byte), LOG_PS2)

        if (this.read_command_register) {
            this.command_register = write_byte
            this.read_command_register = false

            // not sure, causes "spurious ack" in Linux
            //this.kbd_buffer.push(0xFA);
            //this.kbd_irq();

            dbg_log(
                'Keyboard command register = ' + h(this.command_register),
                LOG_PS2,
            )
        } else if (this.read_output_register) {
            this.read_output_register = false

            this.mouse_buffer.clear()
            this.mouse_buffer.push(write_byte)
            this.mouse_irq()
        } else if (this.next_read_sample) {
            this.next_read_sample = false
            this.mouse_buffer.clear()
            this.mouse_buffer.push(0xfa)

            this.sample_rate = write_byte

            switch (this.mouse_detect_state) {
                case -1:
                    if (write_byte === 60) {
                        // Detect Windows NT and turn on workaround the bug
                        // 200->100->80->60
                        this.mouse_reset_workaround = true
                        this.mouse_detect_state = 0
                    } else {
                        this.mouse_reset_workaround = false
                        this.mouse_detect_state = write_byte === 200 ? 1 : 0
                    }
                    break
                case 0:
                    if (write_byte === 200) this.mouse_detect_state = 1
                    break
                case 1:
                    if (write_byte === 100) this.mouse_detect_state = 2
                    else if (write_byte === 200) this.mouse_detect_state = 3
                    else this.mouse_detect_state = 0
                    break
                case 2:
                    // Host sends sample rate 200->100->80 to activate Intellimouse wheel
                    if (write_byte === 80) this.mouse_id = 0x03
                    this.mouse_detect_state = -1
                    break
                case 3:
                    // Host sends sample rate 200->200->80 to activate Intellimouse 4th, 5th buttons
                    if (write_byte === 80) this.mouse_id = 0x04
                    this.mouse_detect_state = -1
                    break
            }

            dbg_log(
                'mouse sample rate: ' +
                    h(write_byte) +
                    ', mouse id: ' +
                    h(this.mouse_id),
                LOG_PS2,
            )

            if (!this.sample_rate) {
                dbg_log('invalid sample rate, reset to 100', LOG_PS2)
                this.sample_rate = 100
            }

            this.mouse_irq()
        } else if (this.next_read_resolution) {
            this.next_read_resolution = false
            this.mouse_buffer.clear()
            this.mouse_buffer.push(0xfa)

            if (write_byte > 3) {
                this.resolution = 4
                dbg_log('invalid resolution, resetting to 4', LOG_PS2)
            } else {
                this.resolution = 1 << write_byte
                dbg_log('resolution: ' + this.resolution, LOG_PS2)
            }
            this.mouse_irq()
        } else if (this.next_read_led) {
            // nope
            this.next_read_led = false
            this.kbd_buffer.push(0xfa)
            this.kbd_irq()
        } else if (this.next_handle_scan_code_set) {
            this.next_handle_scan_code_set = false

            this.kbd_buffer.push(0xfa)
            this.kbd_irq()

            if (write_byte) {
                // set scan code set
            } else {
                this.kbd_buffer.push(1)
            }
        } else if (this.next_read_rate) {
            // nope
            this.next_read_rate = false
            this.kbd_buffer.push(0xfa)
            this.kbd_irq()
        } else if (this.next_is_mouse_command) {
            this.next_is_mouse_command = false
            dbg_log('Port 60 data register write: ' + h(write_byte), LOG_PS2)

            if (!this.have_mouse) {
                return
            }

            // send ack
            this.kbd_buffer.clear()
            this.mouse_buffer.clear()
            this.mouse_buffer.push(0xfa)

            switch (write_byte) {
                case 0xe6:
                    // set scaling to 1:1
                    dbg_log('Scaling 1:1', LOG_PS2)
                    this.scaling2 = false
                    break
                case 0xe7:
                    // set scaling to 2:1
                    dbg_log('Scaling 2:1', LOG_PS2)
                    this.scaling2 = true
                    break
                case 0xe8:
                    // set mouse resolution
                    this.next_read_resolution = true
                    break
                case 0xe9:
                    // status request - send one packet
                    this.send_mouse_packet(0, 0)
                    break
                case 0xeb:
                    // request single packet
                    dbg_log('unimplemented request single packet', LOG_PS2)
                    this.send_mouse_packet(0, 0)
                    break
                case 0xf2:
                    //  MouseID Byte
                    dbg_log('required id: ' + h(this.mouse_id), LOG_PS2)
                    this.mouse_buffer.push(this.mouse_id)

                    this.mouse_clicks =
                        this.mouse_delta_x =
                        this.mouse_delta_y =
                            0
                    // this.send_mouse_packet(0, 0);
                    this.raise_irq()
                    break
                case 0xf3:
                    // sample rate
                    this.next_read_sample = true
                    break
                case 0xf4:
                    // enable streaming
                    this.enable_mouse_stream = true
                    this.use_mouse = true
                    this.bus.send('mouse-enable', true)

                    this.mouse_clicks =
                        this.mouse_delta_x =
                        this.mouse_delta_y =
                            0
                    break
                case 0xf5:
                    // disable streaming
                    this.enable_mouse_stream = false
                    break
                case 0xf6:
                    // set defaults
                    this.enable_mouse_stream = false
                    this.sample_rate = 100
                    this.scaling2 = false
                    this.resolution = 4
                    break
                case 0xff:
                    // reset, send completion code
                    dbg_log('Mouse reset', LOG_PS2)
                    this.mouse_buffer.push(0xaa)
                    this.mouse_buffer.push(0)

                    this.use_mouse = true
                    this.bus.send('mouse-enable', true)

                    this.enable_mouse_stream = false
                    this.sample_rate = 100
                    this.scaling2 = false
                    this.resolution = 4

                    if (!this.mouse_reset_workaround) {
                        this.mouse_id = 0x00
                    }

                    this.mouse_clicks =
                        this.mouse_delta_x =
                        this.mouse_delta_y =
                            0
                    break

                default:
                    dbg_log(
                        'Unimplemented mouse command: ' + h(write_byte),
                        LOG_PS2,
                    )
            }

            this.mouse_irq()
        } else if (this.read_controller_output_port) {
            this.read_controller_output_port = false
            this.controller_output_port = write_byte
            // If we ever want to implement A20 masking, here is where
            // we should turn the masking off if the second bit is on
        } else {
            dbg_log('Port 60 data register write: ' + h(write_byte), LOG_PS2)

            // send ack
            this.mouse_buffer.clear()
            this.kbd_buffer.clear()
            this.kbd_buffer.push(0xfa)

            switch (write_byte) {
                case 0xed:
                    this.next_read_led = true
                    break
                case 0xf0:
                    // get/set scan code set
                    this.next_handle_scan_code_set = true
                    break
                case 0xf2:
                    // identify
                    this.kbd_buffer.push(0xab)
                    this.kbd_buffer.push(0x83)
                    break
                case 0xf3:
                    //  Set typematic rate and delay
                    this.next_read_rate = true
                    break
                case 0xf4:
                    // enable scanning
                    dbg_log('kbd enable scanning', LOG_PS2)
                    this.enable_keyboard_stream = true
                    break
                case 0xf5:
                    // disable scanning
                    dbg_log('kbd disable scanning', LOG_PS2)
                    this.enable_keyboard_stream = false
                    break
                case 0xf6:
                    // reset defaults
                    //this.enable_keyboard_stream = false;
                    break
                case 0xff:
                    this.kbd_buffer.clear()
                    this.kbd_buffer.push(0xfa)
                    this.kbd_buffer.push(0xaa)
                    this.kbd_buffer.push(0)
                    break
                default:
                    dbg_log(
                        'Unimplemented keyboard command: ' + h(write_byte),
                        LOG_PS2,
                    )
            }

            this.kbd_irq()
        }
    }

    port64_write(write_byte: number): void {
        dbg_log('port 64 write: ' + h(write_byte), LOG_PS2)

        switch (write_byte) {
            case 0x20:
                this.kbd_buffer.clear()
                this.mouse_buffer.clear()
                this.kbd_buffer.push(this.command_register)
                this.kbd_irq()
                break
            case 0x60:
                this.read_command_register = true
                break
            case 0xd1:
                this.read_controller_output_port = true
                break
            case 0xd3:
                this.read_output_register = true
                break
            case 0xd4:
                this.next_is_mouse_command = true
                break
            case 0xa7:
                // Disable second port
                dbg_log('Disable second port', LOG_PS2)
                this.command_register |= 0x20
                break
            case 0xa8:
                // Enable second port
                dbg_log('Enable second port', LOG_PS2)
                this.command_register &= ~0x20
                break
            case 0xa9:
                // test second ps/2 port
                this.kbd_buffer.clear()
                this.mouse_buffer.clear()
                this.kbd_buffer.push(0)
                this.kbd_irq()
                break
            case 0xaa:
                this.kbd_buffer.clear()
                this.mouse_buffer.clear()
                this.kbd_buffer.push(0x55)
                this.kbd_irq()
                break
            case 0xab:
                // Test first PS/2 port
                this.kbd_buffer.clear()
                this.mouse_buffer.clear()
                this.kbd_buffer.push(0)
                this.kbd_irq()
                break
            case 0xad:
                // Disable Keyboard
                dbg_log('Disable Keyboard', LOG_PS2)
                this.command_register |= 0x10
                break
            case 0xae:
                // Enable Keyboard
                dbg_log('Enable Keyboard', LOG_PS2)
                this.command_register &= ~0x10
                break
            case 0xfe:
                dbg_log('CPU reboot via PS2')
                this.cpu.reboot()
                break
            default:
                dbg_log(
                    'port 64: Unimplemented command byte: ' + h(write_byte),
                    LOG_PS2,
                )
        }
    }
}
