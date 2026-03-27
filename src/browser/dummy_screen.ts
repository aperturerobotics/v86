import { dbg_assert } from '../log.js'
import { get_charmap } from '../lib.js'

interface DummyScreenOptions {
    encoding?: string
}

export class DummyScreenAdapter {
    FLAG_BLINKING = 0x01
    FLAG_FONT_PAGE_B = 0x02

    private cursor_row = 0
    private cursor_col = 0
    private graphical_mode_width = 0
    private graphical_mode_height = 0
    private is_graphical = false
    private text_mode_data: Uint8Array
    private text_mode_width = 0
    private text_mode_height = 0
    private charmap: string

    constructor(options?: DummyScreenOptions) {
        this.charmap = get_charmap(options?.encoding || '')
        this.text_mode_data = new Uint8Array(0)
        this.set_size_text(80, 25)
    }

    put_char(
        row: number,
        col: number,
        chr: number,
        _blinking: number,
        _bg_color: number,
        _fg_color: number,
    ): void {
        dbg_assert(row >= 0 && row < this.text_mode_height)
        dbg_assert(col >= 0 && col < this.text_mode_width)
        this.text_mode_data[row * this.text_mode_width + col] = chr
    }

    destroy(): void {}
    pause(): void {}
    continue(): void {}

    set_mode(graphical: boolean): void {
        this.is_graphical = graphical
    }

    set_font_bitmap(
        _height: number,
        _width_9px: boolean,
        _width_dbl: boolean,
        _copy_8th_col: boolean,
        _bitmap: Uint8Array,
        _bitmap_changed: boolean,
    ): void {}

    set_font_page(_page_a: number, _page_b: number): void {}

    clear_screen(): void {}

    set_size_text(cols: number, rows: number): void {
        if (cols === this.text_mode_width && rows === this.text_mode_height) {
            return
        }

        this.text_mode_data = new Uint8Array(cols * rows)
        this.text_mode_width = cols
        this.text_mode_height = rows
    }

    set_size_graphical(width: number, height: number): void {
        this.graphical_mode_width = width
        this.graphical_mode_height = height
    }

    set_scale(_s_x: number, _s_y: number): void {}

    update_cursor_scanline(_start: number, _end: number, _max: number): void {}

    update_cursor(row: number, col: number): void {
        this.cursor_row = row
        this.cursor_col = col
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update_buffer(_layers: any[]): void {}

    get_text_screen(): string[] {
        var screen: string[] = []

        for (var i = 0; i < this.text_mode_height; i++) {
            screen.push(this.get_text_row(i))
        }

        return screen
    }

    get_text_row(y: number): string {
        const begin = y * this.text_mode_width
        const end = begin + this.text_mode_width
        return Array.from(
            this.text_mode_data.subarray(begin, end),
            (chr) => this.charmap[chr],
        ).join('')
    }
}
