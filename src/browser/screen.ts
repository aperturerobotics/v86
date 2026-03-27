declare var DEBUG: boolean

import { dbg_assert } from '../log.js'
import { get_charmap } from '../lib.js'

// Draws entire buffer and visualizes the layers that would be drawn
export const DEBUG_SCREEN_LAYERS = DEBUG && false

interface ScreenOptions {
    container: HTMLElement
    scale?: number
    use_graphical_text?: boolean
    encoding?: string
}

interface ScreenLayer {
    image_data: ImageData
    screen_x: number
    screen_y: number
    buffer_x: number
    buffer_y: number
    buffer_width: number
    buffer_height: number
}

const MODE_TEXT = 0
const MODE_GRAPHICAL = 1
const MODE_GRAPHICAL_TEXT = 2

const CHARACTER_INDEX = 0
const FLAGS_INDEX = 1
const BG_COLOR_INDEX = 2
const FG_COLOR_INDEX = 3
const TEXT_BUF_COMPONENT_SIZE = 4

const FLAG_BLINKING = 0x01
const FLAG_FONT_PAGE_B = 0x02

export class ScreenAdapter {
    FLAG_BLINKING = FLAG_BLINKING
    FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B

    screen_fill_buffer: () => void

    private graphic_screen: HTMLCanvasElement
    private graphic_context: CanvasRenderingContext2D
    private text_screen: HTMLDivElement
    private cursor_element: HTMLDivElement

    private cursor_row = 0
    private cursor_col = 0
    private scale_x: number
    private scale_y: number
    private base_scale = 1
    private changed_rows: Int8Array | undefined
    private mode = MODE_TEXT
    private text_mode_data: Int32Array | undefined
    private text_mode_width = 0
    private text_mode_height = 0
    private offscreen_context: OffscreenCanvasRenderingContext2D | null = null
    private offscreen_extra_context: OffscreenCanvasRenderingContext2D | null =
        null
    private font_context: OffscreenCanvasRenderingContext2D | null = null
    private font_image_data: ImageData | null = null
    private font_is_visible = new Int8Array(8 * 256)
    private font_height = 0
    private font_width = 0
    private font_width_9px = false
    private font_width_dbl = false
    private font_copy_8th_col = false
    private font_page_a = 0
    private font_page_b = 0
    private blink_visible = false
    private tm_last_update = 0
    private cursor_start = 0
    private cursor_end = 0
    private cursor_enabled = false
    private charmap: string
    private timer_id = 0
    private paused = false
    private options: ScreenOptions

    constructor(options: ScreenOptions, screen_fill_buffer: () => void) {
        const screen_container = options.container
        this.screen_fill_buffer = screen_fill_buffer
        this.options = options

        console.assert(!!screen_container, 'options.container must be provided')

        this.scale_x = options.scale !== undefined ? options.scale : 1
        this.scale_y = options.scale !== undefined ? options.scale : 1
        this.charmap = get_charmap(options.encoding || '')

        var graphic_screen = screen_container.getElementsByTagName('canvas')[0]
        if (!graphic_screen) {
            graphic_screen = document.createElement('canvas')
            screen_container.appendChild(graphic_screen)
        }
        this.graphic_screen = graphic_screen
        this.graphic_context = graphic_screen.getContext('2d', {
            alpha: false,
        })!

        var text_screen = screen_container.getElementsByTagName('div')[0] as
            | HTMLDivElement
            | undefined
        if (!text_screen) {
            text_screen = document.createElement('div')
            screen_container.appendChild(text_screen)
        }
        this.text_screen = text_screen

        this.cursor_element = document.createElement('div')

        this.init()
    }

    private number_as_color(n: number): string {
        var s = n.toString(16)
        return '#' + '0'.repeat(6 - s.length) + s
    }

    private render_font_bitmap(vga_bitmap: Uint8Array): void {
        const bitmap_width = this.font_width * 256
        const bitmap_height = this.font_height * 8

        var font_canvas = this.font_context ? this.font_context.canvas : null
        if (
            !font_canvas ||
            font_canvas.width !== bitmap_width ||
            font_canvas.height !== bitmap_height
        ) {
            if (!font_canvas) {
                font_canvas = new OffscreenCanvas(bitmap_width, bitmap_height)
                this.font_context = font_canvas.getContext('2d')!
            } else {
                font_canvas.width = bitmap_width
                font_canvas.height = bitmap_height
            }
            this.font_image_data = this.font_context!.createImageData(
                bitmap_width,
                bitmap_height,
            )
        }

        const font_bitmap = this.font_image_data!.data
        var i_dst = 0
        var is_visible = false
        const font_width_dbl = this.font_width_dbl
        const font_width = this.font_width
        const font_height = this.font_height
        const font_width_9px = this.font_width_9px
        const font_copy_8th_col = this.font_copy_8th_col

        const put_bit = font_width_dbl
            ? (value: number) => {
                  is_visible = is_visible || !!value
                  font_bitmap[i_dst + 3] = value
                  font_bitmap[i_dst + 7] = value
                  i_dst += 8
              }
            : (value: number) => {
                  is_visible = is_visible || !!value
                  font_bitmap[i_dst + 3] = value
                  i_dst += 4
              }

        const vga_inc_chr = 32 - font_height
        const dst_inc_row = bitmap_width * (font_height - 1) * 4
        const dst_inc_col = (font_width - bitmap_width * font_height) * 4
        const dst_inc_line = font_width * 255 * 4

        for (
            var i_chr_all = 0, i_vga = 0;
            i_chr_all < 2048;
            ++i_chr_all, i_vga += vga_inc_chr, i_dst += dst_inc_col
        ) {
            const i_chr = i_chr_all % 256
            if (i_chr_all && !i_chr) {
                i_dst += dst_inc_row
            }
            is_visible = false
            for (
                var i_line = 0;
                i_line < font_height;
                ++i_line, ++i_vga, i_dst += dst_inc_line
            ) {
                const line_bits = vga_bitmap[i_vga]
                for (var i_bit = 0x80; i_bit > 0; i_bit >>= 1) {
                    put_bit(line_bits & i_bit ? 255 : 0)
                }
                if (font_width_9px) {
                    put_bit(
                        font_copy_8th_col &&
                            i_chr >= 0xc0 &&
                            i_chr <= 0xdf &&
                            line_bits & 1
                            ? 255
                            : 0,
                    )
                }
            }
            this.font_is_visible[i_chr_all] = is_visible ? 1 : 0
        }

        this.font_context!.putImageData(this.font_image_data!, 0, 0)
    }

    private render_changed_rows(): number {
        const font_context = this.font_context!
        const offscreen_context = this.offscreen_context!
        const offscreen_extra_context = this.offscreen_extra_context!
        const font_canvas = font_context.canvas
        const offscreen_extra_canvas = offscreen_extra_context.canvas
        const text_mode_width = this.text_mode_width
        const font_width = this.font_width
        const font_height = this.font_height
        const text_mode_data = this.text_mode_data!
        const changed_rows = this.changed_rows!
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE
        const gfx_width = text_mode_width * font_width
        const row_extra_1_y = 0
        const row_extra_2_y = font_height

        var n_rows_rendered = 0
        for (
            var row_i = 0, row_y = 0, txt_i = 0;
            row_i < this.text_mode_height;
            ++row_i, row_y += font_height
        ) {
            if (!changed_rows[row_i]) {
                txt_i += txt_row_size
                continue
            }
            ++n_rows_rendered

            offscreen_extra_context.clearRect(
                0,
                row_extra_2_y,
                gfx_width,
                font_height,
            )

            var fg_rgba: number | undefined
            var fg_x = 0
            var bg_rgba: number | undefined
            var bg_x = 0
            for (
                var col_x = 0;
                col_x < gfx_width;
                col_x += font_width, txt_i += TEXT_BUF_COMPONENT_SIZE
            ) {
                const chr = text_mode_data[txt_i + CHARACTER_INDEX]
                const chr_flags = text_mode_data[txt_i + FLAGS_INDEX]
                const chr_bg_rgba = text_mode_data[txt_i + BG_COLOR_INDEX]
                const chr_fg_rgba = text_mode_data[txt_i + FG_COLOR_INDEX]
                const chr_font_page =
                    chr_flags & FLAG_FONT_PAGE_B
                        ? this.font_page_b
                        : this.font_page_a
                const chr_visible =
                    (!(chr_flags & FLAG_BLINKING) || this.blink_visible) &&
                    !!this.font_is_visible[(chr_font_page << 8) + chr]

                if (bg_rgba !== chr_bg_rgba) {
                    if (bg_rgba !== undefined) {
                        offscreen_context.fillStyle =
                            this.number_as_color(bg_rgba)
                        offscreen_context.fillRect(
                            bg_x,
                            row_y,
                            col_x - bg_x,
                            font_height,
                        )
                    }
                    bg_rgba = chr_bg_rgba
                    bg_x = col_x
                }

                if (fg_rgba !== chr_fg_rgba) {
                    if (fg_rgba !== undefined) {
                        offscreen_extra_context.fillStyle =
                            this.number_as_color(fg_rgba)
                        offscreen_extra_context.fillRect(
                            fg_x,
                            row_extra_1_y,
                            col_x - fg_x,
                            font_height,
                        )
                    }
                    fg_rgba = chr_fg_rgba
                    fg_x = col_x
                }

                if (chr_visible) {
                    offscreen_extra_context.drawImage(
                        font_canvas,
                        chr * font_width,
                        chr_font_page * font_height,
                        font_width,
                        font_height,
                        col_x,
                        row_extra_2_y,
                        font_width,
                        font_height,
                    )
                }
            }

            offscreen_extra_context.fillStyle = this.number_as_color(fg_rgba!)
            offscreen_extra_context.fillRect(
                fg_x,
                row_extra_1_y,
                gfx_width - fg_x,
                font_height,
            )

            offscreen_extra_context.globalCompositeOperation = 'destination-in'
            offscreen_extra_context.drawImage(
                offscreen_extra_canvas,
                0,
                row_extra_2_y,
                gfx_width,
                font_height,
                0,
                row_extra_1_y,
                gfx_width,
                font_height,
            )
            offscreen_extra_context.globalCompositeOperation = 'source-over'

            offscreen_context.fillStyle = this.number_as_color(bg_rgba!)
            offscreen_context.fillRect(
                bg_x,
                row_y,
                gfx_width - bg_x,
                font_height,
            )

            offscreen_context.drawImage(
                offscreen_extra_canvas,
                0,
                row_extra_1_y,
                gfx_width,
                font_height,
                0,
                row_y,
                gfx_width,
                font_height,
            )
        }

        if (n_rows_rendered) {
            if (
                this.blink_visible &&
                this.cursor_enabled &&
                changed_rows[this.cursor_row]
            ) {
                const cursor_txt_i =
                    (this.cursor_row * text_mode_width + this.cursor_col) *
                    TEXT_BUF_COMPONENT_SIZE
                const cursor_rgba =
                    text_mode_data[cursor_txt_i + FG_COLOR_INDEX]
                offscreen_context.fillStyle = this.number_as_color(cursor_rgba)
                offscreen_context.fillRect(
                    this.cursor_col * font_width,
                    this.cursor_row * font_height + this.cursor_start,
                    font_width,
                    this.cursor_end - this.cursor_start + 1,
                )
            }
            changed_rows.fill(0)
        }

        return n_rows_rendered
    }

    private mark_blinking_rows_dirty(): void {
        const txt_row_size = this.text_mode_width * TEXT_BUF_COMPONENT_SIZE
        const text_mode_data = this.text_mode_data!
        const changed_rows = this.changed_rows!
        for (var row_i = 0, txt_i = 0; row_i < this.text_mode_height; ++row_i) {
            if (changed_rows[row_i]) {
                txt_i += txt_row_size
                continue
            }
            for (
                var col_i = 0;
                col_i < this.text_mode_width;
                ++col_i, txt_i += TEXT_BUF_COMPONENT_SIZE
            ) {
                if (text_mode_data[txt_i + FLAGS_INDEX] & FLAG_BLINKING) {
                    changed_rows[row_i] = 1
                    txt_i += txt_row_size - col_i * TEXT_BUF_COMPONENT_SIZE
                    break
                }
            }
        }
    }

    init(): void {
        this.cursor_element.classList.add('cursor')
        this.cursor_element.style.position = 'absolute'
        this.cursor_element.style.backgroundColor = '#ccc'
        this.cursor_element.style.width = '7px'
        this.cursor_element.style.display = 'inline-block'

        this.set_mode(false)
        this.set_size_text(80, 25)
        if (this.mode === MODE_GRAPHICAL_TEXT) {
            this.set_size_graphical(720, 400, 720, 400)
        }

        this.set_scale(this.scale_x, this.scale_y)

        this.timer()
    }

    make_screenshot(): HTMLImageElement {
        const image = new Image()

        if (this.mode === MODE_GRAPHICAL || this.mode === MODE_GRAPHICAL_TEXT) {
            image.src = this.graphic_screen.toDataURL('image/png')
        } else {
            const char_size = [9, 16]

            const canvas = document.createElement('canvas')
            canvas.width = this.text_mode_width * char_size[0]
            canvas.height = this.text_mode_height * char_size[1]
            const context = canvas.getContext('2d')!
            context.imageSmoothingEnabled = false
            context.font = window.getComputedStyle(this.text_screen).font
            context.textBaseline = 'top'

            for (var y = 0; y < this.text_mode_height; y++) {
                for (var x = 0; x < this.text_mode_width; x++) {
                    const index =
                        (y * this.text_mode_width + x) * TEXT_BUF_COMPONENT_SIZE
                    const character =
                        this.text_mode_data![index + CHARACTER_INDEX]
                    const bg_color =
                        this.text_mode_data![index + BG_COLOR_INDEX]
                    const fg_color =
                        this.text_mode_data![index + FG_COLOR_INDEX]

                    context.fillStyle = this.number_as_color(bg_color)
                    context.fillRect(
                        x * char_size[0],
                        y * char_size[1],
                        char_size[0],
                        char_size[1],
                    )
                    context.fillStyle = this.number_as_color(fg_color)
                    context.fillText(
                        this.charmap[character],
                        x * char_size[0],
                        y * char_size[1],
                    )
                }
            }

            if (
                this.cursor_element.style.display !== 'none' &&
                this.cursor_row < this.text_mode_height &&
                this.cursor_col < this.text_mode_width
            ) {
                context.fillStyle = this.cursor_element.style.backgroundColor
                context.fillRect(
                    this.cursor_col * char_size[0],
                    this.cursor_row * char_size[1] +
                        parseInt(this.cursor_element.style.marginTop, 10),
                    parseInt(this.cursor_element.style.width, 10),
                    parseInt(this.cursor_element.style.height, 10),
                )
            }

            image.src = canvas.toDataURL('image/png')
        }
        return image
    }

    put_char(
        row: number,
        col: number,
        chr: number,
        flags: number,
        bg_color: number,
        fg_color: number,
    ): void {
        dbg_assert(row >= 0 && row < this.text_mode_height)
        dbg_assert(col >= 0 && col < this.text_mode_width)
        dbg_assert(chr >= 0 && chr < 0x100)

        const p = TEXT_BUF_COMPONENT_SIZE * (row * this.text_mode_width + col)

        this.text_mode_data![p + CHARACTER_INDEX] = chr
        this.text_mode_data![p + FLAGS_INDEX] = flags
        this.text_mode_data![p + BG_COLOR_INDEX] = bg_color
        this.text_mode_data![p + FG_COLOR_INDEX] = fg_color

        this.changed_rows![row] = 1
    }

    timer(): void {
        this.timer_id = requestAnimationFrame(() => this.update_screen())
    }

    update_screen(): void {
        if (!this.paused) {
            if (this.mode === MODE_TEXT) {
                this.update_text()
            } else if (this.mode === MODE_GRAPHICAL) {
                this.update_graphical()
            } else {
                this.update_graphical_text()
            }
        }
        this.timer()
    }

    update_text(): void {
        for (var i = 0; i < this.text_mode_height; i++) {
            if (this.changed_rows![i]) {
                this.text_update_row(i)
                this.changed_rows![i] = 0
            }
        }
    }

    update_graphical(): void {
        this.screen_fill_buffer()
    }

    update_graphical_text(): void {
        if (this.offscreen_context) {
            const tm_now = performance.now()
            if (tm_now - this.tm_last_update > 266) {
                this.blink_visible = !this.blink_visible
                if (this.cursor_enabled) {
                    this.changed_rows![this.cursor_row] = 1
                }
                this.mark_blinking_rows_dirty()
                this.tm_last_update = tm_now
            }
            if (this.render_changed_rows()) {
                this.graphic_context.drawImage(
                    this.offscreen_context.canvas,
                    0,
                    0,
                )
            }
        }
    }

    destroy(): void {
        if (this.timer_id) {
            cancelAnimationFrame(this.timer_id)
            this.timer_id = 0
        }
    }

    pause(): void {
        this.paused = true
        this.cursor_element.classList.remove('blinking-cursor')
    }

    continue(): void {
        this.paused = false
        this.cursor_element.classList.add('blinking-cursor')
    }

    set_mode(graphical: boolean): void {
        this.mode = graphical
            ? MODE_GRAPHICAL
            : this.options.use_graphical_text
              ? MODE_GRAPHICAL_TEXT
              : MODE_TEXT

        if (this.mode === MODE_TEXT) {
            this.text_screen.style.display = 'block'
            this.graphic_screen.style.display = 'none'
        } else {
            this.text_screen.style.display = 'none'
            this.graphic_screen.style.display = 'block'

            if (this.mode === MODE_GRAPHICAL_TEXT && this.changed_rows) {
                this.changed_rows.fill(1)
            }
        }
    }

    set_font_bitmap(
        height: number,
        width_9px: boolean,
        width_dbl: boolean,
        copy_8th_col: boolean,
        vga_bitmap: Uint8Array,
        vga_bitmap_changed: boolean,
    ): void {
        const width = width_dbl ? 16 : width_9px ? 9 : 8
        if (
            this.font_height !== height ||
            this.font_width !== width ||
            this.font_width_9px !== width_9px ||
            this.font_width_dbl !== width_dbl ||
            this.font_copy_8th_col !== copy_8th_col ||
            vga_bitmap_changed
        ) {
            const size_changed =
                this.font_width !== width || this.font_height !== height
            this.font_height = height
            this.font_width = width
            this.font_width_9px = width_9px
            this.font_width_dbl = width_dbl
            this.font_copy_8th_col = copy_8th_col
            if (this.mode === MODE_GRAPHICAL_TEXT) {
                this.render_font_bitmap(vga_bitmap)
                this.changed_rows!.fill(1)
                if (size_changed) {
                    this.set_size_graphical_text()
                }
            }
        }
    }

    set_font_page(page_a: number, page_b: number): void {
        if (this.font_page_a !== page_a || this.font_page_b !== page_b) {
            this.font_page_a = page_a
            this.font_page_b = page_b
            this.changed_rows!.fill(1)
        }
    }

    clear_screen(): void {
        this.graphic_context.fillStyle = '#000'
        this.graphic_context.fillRect(
            0,
            0,
            this.graphic_screen.width,
            this.graphic_screen.height,
        )
    }

    set_size_graphical_text(): void {
        if (!this.font_context) {
            return
        }

        const gfx_width = this.font_width * this.text_mode_width
        const gfx_height = this.font_height * this.text_mode_height
        const offscreen_extra_height = this.font_height * 2

        if (
            !this.offscreen_context ||
            this.offscreen_context.canvas.width !== gfx_width ||
            this.offscreen_context.canvas.height !== gfx_height ||
            this.offscreen_extra_context!.canvas.height !==
                offscreen_extra_height
        ) {
            if (!this.offscreen_context) {
                const offscreen_canvas = new OffscreenCanvas(
                    gfx_width,
                    gfx_height,
                )
                this.offscreen_context = offscreen_canvas.getContext('2d', {
                    alpha: false,
                })!
                const offscreen_extra_canvas = new OffscreenCanvas(
                    gfx_width,
                    offscreen_extra_height,
                )
                this.offscreen_extra_context =
                    offscreen_extra_canvas.getContext('2d')!
            } else {
                this.offscreen_context.canvas.width = gfx_width
                this.offscreen_context.canvas.height = gfx_height
                this.offscreen_extra_context!.canvas.width = gfx_width
                this.offscreen_extra_context!.canvas.height =
                    offscreen_extra_height
            }

            this.set_size_graphical(
                gfx_width,
                gfx_height,
                gfx_width,
                gfx_height,
            )

            this.changed_rows!.fill(1)
        }
    }

    set_size_text(cols: number, rows: number): void {
        if (cols === this.text_mode_width && rows === this.text_mode_height) {
            return
        }

        this.changed_rows = new Int8Array(rows)
        this.text_mode_data = new Int32Array(
            cols * rows * TEXT_BUF_COMPONENT_SIZE,
        )

        this.text_mode_width = cols
        this.text_mode_height = rows

        if (this.mode === MODE_TEXT) {
            while (this.text_screen.childNodes.length > rows) {
                this.text_screen.removeChild(this.text_screen.firstChild!)
            }

            while (this.text_screen.childNodes.length < rows) {
                this.text_screen.appendChild(document.createElement('div'))
            }

            for (var i = 0; i < rows; i++) {
                this.text_update_row(i)
            }

            this.update_scale_text()
        } else if (this.mode === MODE_GRAPHICAL_TEXT) {
            this.set_size_graphical_text()
        }
    }

    set_size_graphical(
        width: number,
        height: number,
        buffer_width: number,
        buffer_height: number,
    ): void {
        if (DEBUG_SCREEN_LAYERS) {
            width = buffer_width
            height = buffer_height
        }

        this.graphic_screen.style.display = 'block'

        this.graphic_screen.width = width
        this.graphic_screen.height = height

        this.graphic_context.imageSmoothingEnabled = false

        if (
            width <= 640 &&
            width * 2 < window.innerWidth * window.devicePixelRatio &&
            height * 2 < window.innerHeight * window.devicePixelRatio
        ) {
            this.base_scale = 2
        } else {
            this.base_scale = 1
        }

        this.update_scale_graphic()
    }

    set_scale(s_x: number, s_y: number): void {
        this.scale_x = s_x
        this.scale_y = s_y

        this.update_scale_text()
        this.update_scale_graphic()
    }

    private update_scale_text(): void {
        this.elem_set_scale(this.text_screen, this.scale_x, this.scale_y, true)
    }

    private update_scale_graphic(): void {
        this.elem_set_scale(
            this.graphic_screen,
            this.scale_x * this.base_scale,
            this.scale_y * this.base_scale,
            false,
        )
    }

    private elem_set_scale(
        elem: HTMLElement,
        sx: number,
        sy: number,
        use_scale: boolean,
    ): void {
        if (!sx || !sy) {
            return
        }

        elem.style.width = ''
        elem.style.height = ''

        if (use_scale) {
            elem.style.transform = ''
        }

        var rectangle = elem.getBoundingClientRect()

        if (use_scale) {
            var scale_str = ''

            scale_str += sx === 1 ? '' : ' scaleX(' + sx + ')'
            scale_str += sy === 1 ? '' : ' scaleY(' + sy + ')'

            elem.style.transform = scale_str
        } else {
            if (sx % 1 === 0 && sy % 1 === 0) {
                this.graphic_screen.style.imageRendering = 'crisp-edges' // firefox
                this.graphic_screen.style.imageRendering = 'pixelated'
            } else {
                this.graphic_screen.style.imageRendering = ''
            }

            var device_pixel_ratio = window.devicePixelRatio || 1
            if (device_pixel_ratio % 1 !== 0) {
                sx /= device_pixel_ratio
                sy /= device_pixel_ratio
            }
        }

        if (sx !== 1) {
            elem.style.width = rectangle.width * sx + 'px'
        }
        if (sy !== 1) {
            elem.style.height = rectangle.height * sy + 'px'
        }
    }

    update_cursor_scanline(start: number, end: number, enabled: boolean): void {
        if (
            start !== this.cursor_start ||
            end !== this.cursor_end ||
            enabled !== this.cursor_enabled
        ) {
            if (this.mode === MODE_TEXT) {
                if (enabled) {
                    this.cursor_element.style.display = 'inline'
                    this.cursor_element.style.height = end - start + 'px'
                    this.cursor_element.style.marginTop = start + 'px'
                } else {
                    this.cursor_element.style.display = 'none'
                }
            } else if (this.mode === MODE_GRAPHICAL_TEXT) {
                if (this.cursor_row < this.text_mode_height) {
                    this.changed_rows![this.cursor_row] = 1
                }
            }

            this.cursor_start = start
            this.cursor_end = end
            this.cursor_enabled = enabled
        }
    }

    update_cursor(row: number, col: number): void {
        if (row !== this.cursor_row || col !== this.cursor_col) {
            if (row < this.text_mode_height) {
                this.changed_rows![row] = 1
            }
            if (this.cursor_row < this.text_mode_height) {
                this.changed_rows![this.cursor_row] = 1
            }

            this.cursor_row = row
            this.cursor_col = col
        }
    }

    text_update_row(row: number): void {
        var offset = TEXT_BUF_COMPONENT_SIZE * row * this.text_mode_width

        var blinking: number
        var bg_color: number
        var fg_color: number
        var text: string

        var row_element = this.text_screen.childNodes[row]
        var fragment = document.createElement('div')

        for (var i = 0; i < this.text_mode_width; ) {
            var color_element = document.createElement('span')

            blinking =
                this.text_mode_data![offset + FLAGS_INDEX] & FLAG_BLINKING
            bg_color = this.text_mode_data![offset + BG_COLOR_INDEX]
            fg_color = this.text_mode_data![offset + FG_COLOR_INDEX]

            if (blinking) {
                color_element.classList.add('blink')
            }

            color_element.style.backgroundColor = this.number_as_color(bg_color)
            color_element.style.color = this.number_as_color(fg_color)

            text = ''

            while (
                i < this.text_mode_width &&
                (this.text_mode_data![offset + FLAGS_INDEX] & FLAG_BLINKING) ===
                    blinking &&
                this.text_mode_data![offset + BG_COLOR_INDEX] === bg_color &&
                this.text_mode_data![offset + FG_COLOR_INDEX] === fg_color
            ) {
                const chr =
                    this.charmap[this.text_mode_data![offset + CHARACTER_INDEX]]

                text += chr
                dbg_assert(!!chr)

                i++
                offset += TEXT_BUF_COMPONENT_SIZE

                if (row === this.cursor_row) {
                    if (i === this.cursor_col) {
                        break
                    } else if (i === this.cursor_col + 1) {
                        this.cursor_element.style.backgroundColor =
                            color_element.style.color
                        fragment.appendChild(this.cursor_element)
                        break
                    }
                }
            }

            color_element.textContent = text
            fragment.appendChild(color_element)
        }

        row_element.parentNode!.replaceChild(fragment, row_element)
    }

    update_buffer(layers: ScreenLayer[]): void {
        if (DEBUG_SCREEN_LAYERS) {
            this.graphic_context.strokeStyle = '#0F0'
            this.graphic_context.lineWidth = 4
            for (const layer of layers) {
                this.graphic_context.strokeRect(
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height,
                )
            }
            this.graphic_context.lineWidth = 1
            return
        }

        for (const layer of layers) {
            this.graphic_context.putImageData(
                layer.image_data,
                layer.screen_x - layer.buffer_x,
                layer.screen_y - layer.buffer_y,
                layer.buffer_x,
                layer.buffer_y,
                layer.buffer_width,
                layer.buffer_height,
            )
        }
    }

    get_text_screen(): string[] {
        var screen: string[] = []

        for (var i = 0; i < this.text_mode_height; i++) {
            screen.push(this.get_text_row(i))
        }

        return screen
    }

    get_text_row(y: number): string {
        const begin =
            y * this.text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX
        const end = begin + this.text_mode_width * TEXT_BUF_COMPONENT_SIZE
        var row = ''
        for (var i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE) {
            row += this.charmap[this.text_mode_data![i]]
        }
        return row
    }
}
