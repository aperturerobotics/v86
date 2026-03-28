import { dbg_log } from '../log.js'
import { BusConnector } from '../bus.js'

export class MouseAdapter {
    enabled = false
    emu_enabled = true
    bus: BusConnector
    is_running = false

    private left_down = false
    private right_down = false
    private middle_down = false
    private last_x = 0
    private last_y = 0
    private screen_container: HTMLElement | undefined

    private SPEED_FACTOR = 1

    private touch_start_handler: (e: TouchEvent) => void
    private touch_end_handler: (e: TouchEvent) => void
    private mousemove_handler: (e: MouseEvent | TouchEvent) => void
    private mousedown_handler: (e: MouseEvent) => void
    private mouseup_handler: (e: MouseEvent) => void
    private mousewheel_handler: (e: WheelEvent) => void

    constructor(bus: BusConnector, screen_container?: HTMLElement) {
        this.bus = bus
        this.screen_container = screen_container

        this.touch_start_handler = (e: TouchEvent) => {
            if (this.may_handle(e)) {
                const touches = e.changedTouches

                if (touches && touches.length) {
                    const touch = touches[touches.length - 1]
                    this.last_x = touch.clientX
                    this.last_y = touch.clientY
                }
            }
        }

        this.touch_end_handler = (_e: TouchEvent) => {
            if (this.left_down || this.middle_down || this.right_down) {
                this.bus.send('mouse-click', [false, false, false])
                this.left_down = this.middle_down = this.right_down = false
            }
        }

        this.mousemove_handler = (e: MouseEvent | TouchEvent) => {
            if (!this.bus) {
                return
            }

            if (!this.may_handle(e)) {
                return
            }

            if (!this.is_running) {
                return
            }

            let delta_x = 0
            let delta_y = 0

            if ('changedTouches' in e) {
                const touches = e.changedTouches
                if (touches.length) {
                    const touch = touches[touches.length - 1]
                    delta_x = touch.clientX - this.last_x
                    delta_y = touch.clientY - this.last_y

                    this.last_x = touch.clientX
                    this.last_y = touch.clientY

                    e.preventDefault()
                }
            } else {
                if (typeof e.movementX === 'number') {
                    delta_x = e.movementX
                    delta_y = e.movementY
                } else {
                    delta_x = e.clientX - this.last_x
                    delta_y = e.clientY - this.last_y

                    this.last_x = e.clientX
                    this.last_y = e.clientY
                }
            }

            delta_x *= this.SPEED_FACTOR
            delta_y *= this.SPEED_FACTOR

            delta_y = -delta_y

            this.bus.send('mouse-delta', [delta_x, delta_y])

            if (this.screen_container) {
                const me = e instanceof MouseEvent ? e : e.changedTouches[0]
                const absolute_x = me.pageX - this.screen_container.offsetLeft
                const absolute_y = me.pageY - this.screen_container.offsetTop
                this.bus.send('mouse-absolute', [
                    absolute_x,
                    absolute_y,
                    this.screen_container.offsetWidth,
                    this.screen_container.offsetHeight,
                ])
            }
        }

        this.mousedown_handler = (e: MouseEvent) => {
            if (this.may_handle(e)) {
                this.click_event(e, true)
            }
        }

        this.mouseup_handler = (e: MouseEvent) => {
            if (this.may_handle(e)) {
                this.click_event(e, false)
            }
        }

        this.mousewheel_handler = (e: WheelEvent) => {
            if (!this.may_handle(e)) {
                return
            }

            let delta_x = -e.deltaY
            const delta_y = 0

            if (delta_x < 0) {
                delta_x = -1
            } else if (delta_x > 0) {
                delta_x = 1
            }

            this.bus.send('mouse-wheel', [delta_x, delta_y])
            e.preventDefault()
        }

        this.bus.register(
            'mouse-enable',
            function (this: MouseAdapter, enabled: boolean) {
                this.enabled = enabled
            },
            this,
        )

        this.bus.register(
            'emulator-stopped',
            function (this: MouseAdapter) {
                this.is_running = false
            },
            this,
        )
        this.bus.register(
            'emulator-started',
            function (this: MouseAdapter) {
                this.is_running = true
            },
            this,
        )

        this.init()
    }

    destroy(): void {
        if (typeof window === 'undefined') {
            return
        }
        window.removeEventListener(
            'touchstart',
            this.touch_start_handler,
            false,
        )
        window.removeEventListener('touchend', this.touch_end_handler, false)
        window.removeEventListener('touchmove', this.mousemove_handler, false)
        window.removeEventListener('mousemove', this.mousemove_handler, false)
        window.removeEventListener('mousedown', this.mousedown_handler, false)
        window.removeEventListener('mouseup', this.mouseup_handler, false)
        window.removeEventListener('wheel', this.mousewheel_handler)
    }

    init(): void {
        if (typeof window === 'undefined') {
            return
        }
        this.destroy()

        window.addEventListener('touchstart', this.touch_start_handler, false)
        window.addEventListener('touchend', this.touch_end_handler, false)
        window.addEventListener('touchmove', this.mousemove_handler, false)
        window.addEventListener('mousemove', this.mousemove_handler, false)
        window.addEventListener('mousedown', this.mousedown_handler, false)
        window.addEventListener('mouseup', this.mouseup_handler, false)
        window.addEventListener('wheel', this.mousewheel_handler, {
            passive: false,
        })
    }

    private is_child(child: Node, parent: Node): boolean {
        let node: Node | null = child
        while (node && node.parentNode) {
            if (node === parent) {
                return true
            }
            node = node.parentNode
        }

        return false
    }

    private may_handle(e: Event): boolean {
        if (!this.enabled || !this.emu_enabled) {
            return false
        }

        const MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY = true

        if (MOVE_MOUSE_WHEN_OVER_SCREEN_ONLY) {
            const parent = this.screen_container || document.body
            const target = e.target
            if (!target) {
                return false
            }
            return (
                !!document.pointerLockElement ||
                this.is_child(target as Node, parent)
            )
        }

        return true
    }

    private click_event(e: MouseEvent, down: boolean): void {
        if (!this.bus) {
            return
        }

        if (e.button === 0) {
            this.left_down = down
        } else if (e.button === 1) {
            this.middle_down = down
        } else if (e.button === 2) {
            this.right_down = down
        } else {
            dbg_log('Unknown event.button: ' + e.button)
        }
        this.bus.send('mouse-click', [
            this.left_down,
            this.middle_down,
            this.right_down,
        ])
        e.preventDefault()
    }
}
