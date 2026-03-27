import { BusConnector } from '../bus.js'

const SHIFT_SCAN_CODE = 0x2a
const SCAN_CODE_RELEASE = 0x80

const PLATFORM_WINDOWS =
    typeof window !== 'undefined' &&
    window.navigator.platform.toString().toLowerCase().search('win') >= 0

export class KeyboardAdapter {
    emu_enabled = true
    bus: BusConnector

    private keys_pressed: Record<number, boolean> = {}
    private deferred_event: KeyboardEvent | null = null
    private deferred_keydown = false
    private deferred_timeout_id: ReturnType<typeof setTimeout> | 0 = 0

    // Format:
    // Javascript event.keyCode -> make code
    private charmap = new Uint16Array([
        0, 0, 0, 0, 0, 0, 0, 0,
        // 0x08: backspace, tab, enter
        0x0e, 0x0f, 0, 0, 0, 0x1c, 0, 0,

        // 0x10: shift, ctrl, alt, pause, caps lock
        0x2a, 0x1d, 0x38, 0, 0x3a, 0, 0, 0,

        // 0x18: escape
        0, 0, 0, 0x01, 0, 0, 0, 0,

        // 0x20: spacebar, page down/up, end, home, arrow keys, ins, del
        0x39, 0xe049, 0xe051, 0xe04f, 0xe047, 0xe04b, 0xe048, 0xe04d, 0x50, 0,
        0, 0, 0, 0x52, 0x53, 0,

        // 0x30: numbers
        0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,

        // 0x3B: ;= (firefox only)
        0, 0x27, 0, 0x0d, 0, 0,

        // 0x40
        0,

        // 0x41: letters
        0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26,
        0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d,
        0x15, 0x2c,

        // 0x5B: Left Win, Right Win, Menu
        0xe05b, 0xe05c, 0xe05d, 0, 0,

        // 0x60: keypad
        0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49, 0, 0, 0, 0,
        0, 0,

        // 0x70: F1 to F12
        0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58,

        0, 0, 0, 0,

        // 0x80
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

        // 0x90: Numlock
        0x45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

        // 0xA0: - (firefox only)
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0c, 0, 0,

        // 0xB0
        // ,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x27, 0x0d, 0x33, 0x0c, 0x34, 0x35,

        // 0xC0
        // `
        0x29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

        // 0xD0
        // [']\
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0x2b, 0x1b, 0x28, 0,

        // 0xE0
        // Apple key on Gecko, Right alt
        0xe05b, 0xe038, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])

    // ascii -> javascript event code (US layout)
    private asciimap: Record<number, number> = {
        8: 8,
        10: 13,
        32: 32,
        39: 222,
        44: 188,
        45: 189,
        46: 190,
        47: 191,
        48: 48,
        49: 49,
        50: 50,
        51: 51,
        52: 52,
        53: 53,
        54: 54,
        55: 55,
        56: 56,
        57: 57,
        59: 186,
        61: 187,
        91: 219,
        92: 220,
        93: 221,
        96: 192,
        97: 65,
        98: 66,
        99: 67,
        100: 68,
        101: 69,
        102: 70,
        103: 71,
        104: 72,
        105: 73,
        106: 74,
        107: 75,
        108: 76,
        109: 77,
        110: 78,
        111: 79,
        112: 80,
        113: 81,
        114: 82,
        115: 83,
        116: 84,
        117: 85,
        118: 86,
        119: 87,
        120: 88,
        121: 89,
        122: 90,
    }
    private asciimap_shift: Record<number, number> = {
        33: 49,
        34: 222,
        35: 51,
        36: 52,
        37: 53,
        38: 55,
        40: 57,
        41: 48,
        42: 56,
        43: 187,
        58: 186,
        60: 188,
        62: 190,
        63: 191,
        64: 50,
        65: 65,
        66: 66,
        67: 67,
        68: 68,
        69: 69,
        70: 70,
        71: 71,
        72: 72,
        73: 73,
        74: 74,
        75: 75,
        76: 76,
        77: 77,
        78: 78,
        79: 79,
        80: 80,
        81: 81,
        82: 82,
        83: 83,
        84: 84,
        85: 85,
        86: 86,
        87: 87,
        88: 88,
        89: 89,
        90: 90,
        94: 54,
        95: 189,
        123: 219,
        124: 220,
        125: 221,
        126: 192,
    }

    // Mapping from event.code to scancode
    private codemap: Record<string, number> = {
        Escape: 0x0001,
        Digit1: 0x0002,
        Digit2: 0x0003,
        Digit3: 0x0004,
        Digit4: 0x0005,
        Digit5: 0x0006,
        Digit6: 0x0007,
        Digit7: 0x0008,
        Digit8: 0x0009,
        Digit9: 0x000a,
        Digit0: 0x000b,
        Minus: 0x000c,
        Equal: 0x000d,
        Backspace: 0x000e,
        Tab: 0x000f,
        KeyQ: 0x0010,
        KeyW: 0x0011,
        KeyE: 0x0012,
        KeyR: 0x0013,
        KeyT: 0x0014,
        KeyY: 0x0015,
        KeyU: 0x0016,
        KeyI: 0x0017,
        KeyO: 0x0018,
        KeyP: 0x0019,
        BracketLeft: 0x001a,
        BracketRight: 0x001b,
        Enter: 0x001c,
        ControlLeft: 0x001d,
        KeyA: 0x001e,
        KeyS: 0x001f,
        KeyD: 0x0020,
        KeyF: 0x0021,
        KeyG: 0x0022,
        KeyH: 0x0023,
        KeyJ: 0x0024,
        KeyK: 0x0025,
        KeyL: 0x0026,
        Semicolon: 0x0027,
        Quote: 0x0028,
        Backquote: 0x0029,
        ShiftLeft: 0x002a,
        Backslash: 0x002b,
        KeyZ: 0x002c,
        KeyX: 0x002d,
        KeyC: 0x002e,
        KeyV: 0x002f,
        KeyB: 0x0030,
        KeyN: 0x0031,
        KeyM: 0x0032,
        Comma: 0x0033,
        Period: 0x0034,
        Slash: 0x0035,
        IntlRo: 0x0035,
        ShiftRight: 0x0036,
        NumpadMultiply: 0x0037,
        AltLeft: 0x0038,
        Space: 0x0039,
        CapsLock: 0x003a,
        F1: 0x003b,
        F2: 0x003c,
        F3: 0x003d,
        F4: 0x003e,
        F5: 0x003f,
        F6: 0x0040,
        F7: 0x0041,
        F8: 0x0042,
        F9: 0x0043,
        F10: 0x0044,
        NumLock: 0x0045,
        ScrollLock: 0x0046,
        Numpad7: 0x0047,
        Numpad8: 0x0048,
        Numpad9: 0x0049,
        NumpadSubtract: 0x004a,
        Numpad4: 0x004b,
        Numpad5: 0x004c,
        Numpad6: 0x004d,
        NumpadAdd: 0x004e,
        Numpad1: 0x004f,
        Numpad2: 0x0050,
        Numpad3: 0x0051,
        Numpad0: 0x0052,
        NumpadDecimal: 0x0053,
        IntlBackslash: 0x0056,
        F11: 0x0057,
        F12: 0x0058,

        NumpadEnter: 0xe01c,
        ControlRight: 0xe01d,
        NumpadDivide: 0xe035,
        AltRight: 0xe038,
        Home: 0xe047,
        ArrowUp: 0xe048,
        PageUp: 0xe049,
        ArrowLeft: 0xe04b,
        ArrowRight: 0xe04d,
        End: 0xe04f,
        ArrowDown: 0xe050,
        PageDown: 0xe051,
        Insert: 0xe052,
        Delete: 0xe053,

        MetaLeft: 0xe05b,
        OSLeft: 0xe05b,
        MetaRight: 0xe05c,
        OSRight: 0xe05c,
        ContextMenu: 0xe05d,
    }

    private keyup_handler: (e: KeyboardEvent) => void
    private keydown_handler: (e: KeyboardEvent) => void
    private blur_handler: (e: FocusEvent) => void
    private input_handler: (e: InputEvent) => void

    constructor(bus: BusConnector) {
        this.bus = bus

        this.keyup_handler = (e: KeyboardEvent) => {
            if (!e.altKey && this.keys_pressed[0x38]) {
                this.handle_code(0x38, false)
            }
            return this.handler(e, false)
        }

        this.keydown_handler = (e: KeyboardEvent) => {
            if (!e.altKey && this.keys_pressed[0x38]) {
                this.handle_code(0x38, false)
            }
            return this.handler(e, true)
        }

        this.blur_handler = (_e: FocusEvent) => {
            var keys = Object.keys(this.keys_pressed)

            for (var i = 0; i < keys.length; i++) {
                var key = +keys[i]

                if (this.keys_pressed[key]) {
                    this.handle_code(key, false)
                }
            }

            this.keys_pressed = {}
        }

        this.input_handler = (e: InputEvent) => {
            if (!this.bus) {
                return
            }

            if (!this.may_handle(e)) {
                return
            }

            switch (e.inputType) {
                case 'insertText':
                    if (e.data) {
                        for (var i = 0; i < e.data.length; i++) {
                            this.simulate_char(e.data[i])
                        }
                    }
                    break

                case 'insertLineBreak':
                    this.simulate_press(13) // enter
                    break

                case 'deleteContentBackward':
                    this.simulate_press(8) // backspace
                    break
            }
        }

        this.init()
    }

    destroy(): void {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keyup', this.keyup_handler, false)
            window.removeEventListener('keydown', this.keydown_handler, false)
            window.removeEventListener('blur', this.blur_handler, false)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            window.removeEventListener(
                'input',
                this.input_handler as any,
                false,
            )
        }
    }

    init(): void {
        if (typeof window === 'undefined') {
            return
        }
        this.destroy()

        window.addEventListener('keyup', this.keyup_handler, false)
        window.addEventListener('keydown', this.keydown_handler, false)
        window.addEventListener('blur', this.blur_handler, false)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window.addEventListener('input', this.input_handler as any, false)
    }

    simulate_press(code: number): void {
        var ev = { keyCode: code } as KeyboardEvent
        this.handler(ev, true)
        this.handler(ev, false)
    }

    simulate_char(chr: string): void {
        var code = chr.charCodeAt(0)

        if (code in this.asciimap) {
            this.simulate_press(this.asciimap[code])
        } else if (code in this.asciimap_shift) {
            this.send_to_controller(SHIFT_SCAN_CODE)
            this.simulate_press(this.asciimap_shift[code])
            this.send_to_controller(SHIFT_SCAN_CODE | SCAN_CODE_RELEASE)
        } else {
            console.log('ascii -> keyCode not found: ', code, chr)
        }
    }

    private may_handle(e: Event): boolean {
        var ke = e as KeyboardEvent
        if (
            ke.shiftKey &&
            ke.ctrlKey &&
            (ke.keyCode === 73 || ke.keyCode === 74 || ke.keyCode === 75)
        ) {
            return false
        }

        if (!this.emu_enabled) {
            return false
        }

        if (e.target) {
            var target = e.target as HTMLElement
            return (
                target.classList.contains('phone_keyboard') ||
                (target.nodeName !== 'INPUT' && target.nodeName !== 'TEXTAREA')
            )
        }

        return true
    }

    private translate(e: KeyboardEvent): number {
        if (e.code !== undefined) {
            var code = this.codemap[e.code]

            if (code !== undefined) {
                return code
            }
        }

        return this.charmap[e.keyCode]
    }

    private handler(e: KeyboardEvent, keydown: boolean): false | undefined {
        if (!this.bus) {
            return
        }

        if (!this.may_handle(e)) {
            return
        }

        if (
            e.code === '' ||
            e.key === 'Process' ||
            e.key === 'Unidentified' ||
            e.keyCode === 229
        ) {
            return
        }

        e.preventDefault && e.preventDefault()

        if (PLATFORM_WINDOWS) {
            if (this.deferred_event) {
                clearTimeout(this.deferred_timeout_id)
                if (
                    !(
                        e.getModifierState &&
                        e.getModifierState('AltGraph') &&
                        this.deferred_keydown === keydown &&
                        this.deferred_event.code === 'ControlLeft' &&
                        e.code === 'AltRight'
                    )
                ) {
                    this.handle_event(
                        this.deferred_event,
                        this.deferred_keydown,
                    )
                }
                this.deferred_event = null
            }

            if (e.code === 'ControlLeft') {
                this.deferred_event = e
                this.deferred_keydown = keydown
                this.deferred_timeout_id = setTimeout(() => {
                    if (this.deferred_event) {
                        this.handle_event(
                            this.deferred_event,
                            this.deferred_keydown,
                        )
                        this.deferred_event = null
                    }
                }, 10)
                return false
            }
        }

        this.handle_event(e, keydown)
        return false
    }

    private handle_event(e: KeyboardEvent, keydown: boolean): void {
        var code = this.translate(e)

        if (!code) {
            console.log(
                'Missing char in map: keyCode=' +
                    (e.keyCode || -1).toString(16) +
                    ' code=' +
                    e.code,
            )
            return
        }

        this.handle_code(code, keydown, e.repeat)
    }

    private handle_code(
        code: number,
        keydown: boolean,
        is_repeat?: boolean,
    ): void {
        if (keydown) {
            if (this.keys_pressed[code] && !is_repeat) {
                this.handle_code(code, false)
            }
        } else {
            if (!this.keys_pressed[code]) {
                return
            }
        }

        this.keys_pressed[code] = keydown

        if (!keydown) {
            code |= 0x80
        }

        if (code > 0xff) {
            this.send_to_controller(code >> 8)
            this.send_to_controller(code & 0xff)
        } else {
            this.send_to_controller(code)
        }
    }

    private send_to_controller(code: number): void {
        this.bus.send('keyboard-code', code)
    }
}
