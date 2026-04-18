import { dbg_assert } from '../log.js'
import { get_charmap } from '../lib.js'

interface ANSIScreenOptions {
    encoding?: string
}

const CHARACTER_INDEX = 0
const BG_COLOR_INDEX = 1
const FG_COLOR_INDEX = 2
const TEXT_BUF_COMPONENT_SIZE = 3

const ANSI_RESET = '\x1B[0m'

function hex_to_ansi_truecolor(color: number): string {
    const RED = (color & 0xff0000) >> 16
    const GREEN = (color & 0x00ff00) >> 8
    const BLUE = color & 0x0000ff
    return `2;${RED};${GREEN};${BLUE}`
}

export class ANSIScreenAdapter {
    private cursor_row = 0
    private cursor_col = 0
    private graphical_mode_width = 0
    private graphical_mode_height = 0
    private is_graphical = false
    private text_mode_data: Int32Array
    private text_mode_width = 0
    private text_mode_height = 0
    private charmap: string

    constructor(options?: ANSIScreenOptions) {
        this.charmap = get_charmap(options?.encoding || '')
        this.text_mode_data = new Int32Array(0)
        this.set_size_text(80, 25)
    }

    put_char(
        row: number,
        col: number,
        chr: number,
        _blinking: number,
        bg_color: number,
        fg_color: number,
    ): void {
        dbg_assert(row >= 0 && row < this.text_mode_height)
        dbg_assert(col >= 0 && col < this.text_mode_width)
        dbg_assert(chr >= 0 && chr < 0x100)

        const p = TEXT_BUF_COMPONENT_SIZE * (row * this.text_mode_width + col)

        this.text_mode_data[p + CHARACTER_INDEX] = chr
        this.text_mode_data[p + BG_COLOR_INDEX] = bg_color
        this.text_mode_data[p + FG_COLOR_INDEX] = fg_color
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

        this.text_mode_data = new Int32Array(
            cols * rows * TEXT_BUF_COMPONENT_SIZE,
        )
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

    update_buffer(_layers: any[]): void {}

    get_text_screen(): string[] {
        const screen: string[] = []

        for (let i = 0; i < this.text_mode_height; i++) {
            screen.push(this.get_text_row(i))
        }

        return screen
    }

    get_text_row(y: number): string {
        const begin =
            y * this.text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX
        const end = begin + this.text_mode_width * TEXT_BUF_COMPONENT_SIZE

        let previous_bg: number | null = null
        let previous_fg: number | null = null
        let row = ''
        for (let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE) {
            const chr = this.charmap[this.text_mode_data[i]]
            const bg_color = this.text_mode_data[i + BG_COLOR_INDEX]
            const fg_color = this.text_mode_data[i + FG_COLOR_INDEX]

            let ansi_code = ''
            if (previous_bg !== bg_color) {
                ansi_code += `\x1B[48;${hex_to_ansi_truecolor(bg_color)}m`
                previous_bg = bg_color
            }
            if (previous_fg !== fg_color) {
                ansi_code += `\x1B[38;${hex_to_ansi_truecolor(fg_color)}m`
                previous_fg = fg_color
            }
            row += ansi_code + chr
        }
        return row + ANSI_RESET
    }
}
