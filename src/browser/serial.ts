import { dbg_assert, dbg_log } from '../log.js'
import { BusConnector } from '../bus.js'

class TextAreaAdapter {
    enabled = true
    text = ''
    text_new_line = false
    last_update = 0
    update_timer: ReturnType<typeof setTimeout> | undefined = undefined

    protected element: HTMLTextAreaElement

    private keypress_handler: (e: KeyboardEvent) => void
    private keydown_handler: (e: KeyboardEvent) => void
    private paste_handler: (e: ClipboardEvent) => void
    private window_click_handler: (e: MouseEvent) => void

    constructor(element: HTMLTextAreaElement) {
        this.element = element

        this.keypress_handler = (e: KeyboardEvent) => {
            if (!this.may_handle(e)) {
                return
            }

            var chr = e.which
            this.send_char(chr)
            e.preventDefault()
        }

        this.keydown_handler = (e: KeyboardEvent) => {
            var chr = e.which

            if (chr === 8) {
                this.send_char(127)
                e.preventDefault()
            } else if (chr === 9) {
                this.send_char(9)
                e.preventDefault()
            }
        }

        this.paste_handler = (e: ClipboardEvent) => {
            if (!this.may_handle(e)) {
                return
            }

            var data = e.clipboardData?.getData('text/plain') || ''

            for (var i = 0; i < data.length; i++) {
                this.send_char(data.charCodeAt(i))
            }

            e.preventDefault()
        }

        this.window_click_handler = (e: MouseEvent) => {
            if (e.target !== element) {
                element.blur()
            }
        }

        this.init()
    }

    destroy(): void {
        this.enabled = false

        this.element.removeEventListener(
            'keypress',
            this.keypress_handler,
            false,
        )
        this.element.removeEventListener('keydown', this.keydown_handler, false)
        this.element.removeEventListener('paste', this.paste_handler, false)
        window.removeEventListener(
            'mousedown',
            this.window_click_handler,
            false,
        )
    }

    init(): void {
        this.destroy()
        this.enabled = true

        this.element.style.display = 'block'
        this.element.addEventListener('keypress', this.keypress_handler, false)
        this.element.addEventListener('keydown', this.keydown_handler, false)
        this.element.addEventListener('paste', this.paste_handler, false)
        window.addEventListener('mousedown', this.window_click_handler, false)
    }

    show_char(chr: string): void {
        if (chr === '\x08') {
            this.text = this.text.slice(0, -1)
            this.update()
        } else if (chr === '\r') {
            // do nothing
        } else {
            this.text += chr

            if (chr === '\n') {
                this.text_new_line = true
            }

            this.update()
        }
    }

    update(): void {
        var now = Date.now()
        var delta = now - this.last_update

        if (delta < 16) {
            if (this.update_timer === undefined) {
                this.update_timer = setTimeout(() => {
                    this.update_timer = undefined
                    var now = Date.now()
                    dbg_assert(now - this.last_update >= 15)
                    this.last_update = now
                    this.render()
                }, 16 - delta)
            }
        } else {
            if (this.update_timer !== undefined) {
                clearTimeout(this.update_timer)
                this.update_timer = undefined
            }

            this.last_update = now
            this.render()
        }
    }

    render(): void {
        this.element.value = this.text

        if (this.text_new_line) {
            this.text_new_line = false
            this.element.scrollTop = 1e9
        }
    }

    send_char(_chr_code: number): void {
        // placeholder, overridden by subclasses
    }

    private may_handle(_e: Event): boolean {
        if (!this.enabled) {
            return false
        }

        return true
    }
}

export class SerialAdapter extends TextAreaAdapter {
    private bus: BusConnector

    constructor(element: HTMLTextAreaElement, bus: BusConnector) {
        super(element)
        this.bus = bus

        bus.register(
            'serial0-output-byte',
            function (this: SerialAdapter, byte: number) {
                var chr = String.fromCharCode(byte)
                this.show_char(chr)
            },
            this,
        )
    }

    override send_char(chr_code: number): void {
        this.bus.send('serial0-input', chr_code)
    }
}

export class VirtioConsoleAdapter extends TextAreaAdapter {
    private bus: BusConnector

    constructor(element: HTMLTextAreaElement, bus: BusConnector) {
        super(element)
        this.bus = bus

        const decoder = new TextDecoder()
        bus.register(
            'virtio-console0-output-bytes',
            function (this: VirtioConsoleAdapter, bytes: Uint8Array) {
                for (const chr of decoder.decode(bytes)) {
                    this.show_char(chr)
                }
            },
            this,
        )
    }

    override send_char(chr_code: number): void {
        this.bus.send('virtio-console0-input-bytes', new Uint8Array([chr_code]))
    }
}

class SerialRecordingAdapter {
    text = ''

    constructor(bus: BusConnector) {
        bus.register(
            'serial0-output-byte',
            function (this: SerialRecordingAdapter, byte: number) {
                var chr = String.fromCharCode(byte)
                this.text += chr
            },
            this,
        )
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface XtermTerminal {
    open(element: HTMLElement): void
    write(data: Uint8Array): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onData(callback: (data: string) => void): any
    dispose(): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XtermConstructor = new (options: any) => XtermTerminal

class XtermJSAdapter {
    element: HTMLElement
    term: XtermTerminal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on_data_disposable: any

    constructor(element: HTMLElement, xterm_lib: XtermConstructor) {
        this.element = element

        this.term = new xterm_lib({
            logLevel: 'off',
            convertEol: 'true',
        })
    }

    destroy(): void {
        this.on_data_disposable && this.on_data_disposable.dispose()
        this.term.dispose()
    }

    show(): void {
        this.term && this.term.open(this.element)
    }
}

export class SerialAdapterXtermJS extends XtermJSAdapter {
    private bus: BusConnector | undefined

    constructor(
        element: HTMLElement,
        bus: BusConnector,
        xterm_lib: XtermConstructor,
    ) {
        super(element, xterm_lib)
        this.bus = bus

        bus.register(
            'serial0-output-byte',
            function (this: SerialAdapterXtermJS, utf8_byte: number) {
                this.term.write(Uint8Array.of(utf8_byte))
            },
            this,
        )

        const utf8_encoder = new TextEncoder()
        this.on_data_disposable = this.term.onData(function (data_str: string) {
            for (const utf8_byte of utf8_encoder.encode(data_str)) {
                bus.send('serial0-input', utf8_byte)
            }
        })
    }
}

export class VirtioConsoleAdapterXtermJS extends XtermJSAdapter {
    private bus: BusConnector | undefined

    constructor(
        element: HTMLElement,
        bus: BusConnector,
        xterm_lib: XtermConstructor,
    ) {
        super(element, xterm_lib)
        this.bus = bus

        bus.register(
            'virtio-console0-output-bytes',
            function (
                this: VirtioConsoleAdapterXtermJS,
                utf8_bytes: Uint8Array,
            ) {
                this.term.write(utf8_bytes)
            },
            this,
        )

        const utf8_encoder = new TextEncoder()
        this.on_data_disposable = this.term.onData(function (data_str: string) {
            bus.send(
                'virtio-console0-input-bytes',
                utf8_encoder.encode(data_str),
            )
        })
    }
}
