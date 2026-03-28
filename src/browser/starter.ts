declare let DEBUG: boolean

import { v86 } from '../main.js'
import { LOG_CPU, WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from '../const.js'
import { get_rand_int, load_file, read_sized_string_from_mem } from '../lib.js'
import { dbg_assert, dbg_trace, dbg_log, set_log_level } from '../log.js'
import * as print_stats from './print_stats.js'
import { Bus } from '../bus.js'
import {
    BOOT_ORDER_FD_FIRST,
    BOOT_ORDER_HD_FIRST,
    BOOT_ORDER_CD_FIRST,
} from '../rtc.js'
import { SpeakerAdapter } from './speaker.js'
import { NetworkAdapter } from './network.js'
import { FetchNetworkAdapter } from './fetch_network.js'
import { WispNetworkAdapter } from './wisp_network.js'
import { KeyboardAdapter } from './keyboard.js'
import { MouseAdapter } from './mouse.js'
import { ScreenAdapter } from './screen.js'
import { DummyScreenAdapter } from './dummy_screen.js'
import {
    SerialAdapter,
    VirtioConsoleAdapter,
    SerialAdapterXtermJS,
    VirtioConsoleAdapterXtermJS,
} from './serial.js'
import { InBrowserNetworkAdapter } from './inbrowser_network.js'

import {
    FileStorageInterface,
    MemoryFileStorage,
    ServerFileStorageWrapper,
} from './filestorage.js'
import { SyncBuffer, buffer_from_object } from '../buffer.js'
import { FS } from '../../lib/filesystem.js'

type WasmExports = any

type EmulatorSettings = any

type V86Options = any

type FileDescriptor = any

type AutoStep = any

class FileNotFoundError extends Error {
    constructor(message?: string) {
        super(message || 'File not found')
    }
}

/**
 * Constructor for emulator instances.
 *
 * For API usage, see v86.d.ts in the root of this repository.
 */
export class V86 {
    cpu_is_running = false

    cpu_exception_hook: (n: number) => void = function (_n: number) {}

    bus: any

    emulator_bus: any

    v86: any

    wasm_source: any

    zstd_worker: Worker | null = null
    zstd_worker_request_id = 0

    zstd_context: any = null

    keyboard_adapter: any

    mouse_adapter: any

    screen_adapter: any

    network_adapter: any

    serial_adapter: any

    speaker_adapter: any

    virtio_console_adapter: any

    fs9p: any

    constructor(options: V86Options) {
        if (typeof options.log_level === 'number') {
            // XXX: Shared between all emulator instances
            set_log_level(options.log_level)
        }

        //var worker = new Worker("src/browser/worker.js");
        //var adapter_bus = this.bus = WorkerBus.init(worker);

        const bus = Bus.create()
        this.bus = bus[0]
        this.emulator_bus = bus[1]

        let cpu: any

        let wasm_memory: any

        const wasm_table = new WebAssembly.Table({
            element: 'anyfunc',
            initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET,
        })

        const wasm_shared_funcs: Record<string, any> = {
            cpu_exception_hook: (n: number) => this.cpu_exception_hook(n),

            run_hardware_timers: function (a: any, t: any) {
                return cpu.run_hardware_timers(a, t)
            },
            cpu_event_halt: () => {
                this.emulator_bus.send('cpu-event-halt')
            },
            abort: function () {
                dbg_assert(false)
            },
            microtick: v86.microtick,
            get_rand_int: function () {
                return get_rand_int()
            },
            stop_idling: function () {
                return cpu.stop_idling()
            },

            io_port_read8: function (addr: number) {
                return cpu.io.port_read8(addr)
            },
            io_port_read16: function (addr: number) {
                return cpu.io.port_read16(addr)
            },
            io_port_read32: function (addr: number) {
                return cpu.io.port_read32(addr)
            },
            io_port_write8: function (addr: number, value: number) {
                cpu.io.port_write8(addr, value)
            },
            io_port_write16: function (addr: number, value: number) {
                cpu.io.port_write16(addr, value)
            },
            io_port_write32: function (addr: number, value: number) {
                cpu.io.port_write32(addr, value)
            },

            mmap_read8: function (addr: number) {
                return cpu.mmap_read8(addr)
            },
            mmap_read32: function (addr: number) {
                return cpu.mmap_read32(addr)
            },
            mmap_write8: function (addr: number, value: number) {
                cpu.mmap_write8(addr, value)
            },
            mmap_write16: function (addr: number, value: number) {
                cpu.mmap_write16(addr, value)
            },
            mmap_write32: function (addr: number, value: number) {
                cpu.mmap_write32(addr, value)
            },
            mmap_write64: function (
                addr: number,
                value0: number,
                value1: number,
            ) {
                cpu.mmap_write64(addr, value0, value1)
            },
            mmap_write128: function (
                addr: number,
                value0: number,
                value1: number,
                value2: number,
                value3: number,
            ) {
                cpu.mmap_write128(addr, value0, value1, value2, value3)
            },

            log_from_wasm: function (offset: number, len: number) {
                const str = read_sized_string_from_mem(wasm_memory, offset, len)
                dbg_log(str, LOG_CPU)
            },
            console_log_from_wasm: function (offset: number, len: number) {
                const str = read_sized_string_from_mem(wasm_memory, offset, len)
                console.error(str)
            },
            dbg_trace_from_wasm: function () {
                dbg_trace(LOG_CPU)
            },

            codegen_finalize: (
                wasm_table_index: number,
                start: number,
                state_flags: number,
                ptr: number,
                len: number,
            ) => {
                cpu.codegen_finalize(
                    wasm_table_index,
                    start,
                    state_flags,
                    ptr,
                    len,
                )
            },
            jit_clear_func: (wasm_table_index: number) =>
                cpu.jit_clear_func(wasm_table_index),
            jit_clear_all_funcs: () => cpu.jit_clear_all_funcs(),

            __indirect_function_table: wasm_table,
        }

        let wasm_fn = options.wasm_fn

        if (!wasm_fn) {
            wasm_fn = (env: any) => {
                return new Promise((resolve) => {
                    let v86_bin = DEBUG ? 'v86-debug.wasm' : 'v86.wasm'
                    let v86_bin_fallback = 'v86-fallback.wasm'

                    if (options.wasm_path) {
                        v86_bin = options.wasm_path
                        v86_bin_fallback = v86_bin.replace(
                            'v86.wasm',
                            'v86-fallback.wasm',
                        )
                    } else if (typeof window === 'undefined') {
                        // Node/Bun: resolve WASM relative to project root build/
                        const root = new URL('../../', import.meta.url).pathname
                        v86_bin = root + 'build/' + v86_bin
                        v86_bin_fallback = root + 'build/' + v86_bin_fallback
                    } else {
                        v86_bin = 'build/' + v86_bin
                        v86_bin_fallback = 'build/' + v86_bin_fallback
                    }

                    load_file(v86_bin, {
                        done: async (bytes: any) => {
                            try {
                                const { instance } =
                                    await WebAssembly.instantiate(bytes, env)
                                this.wasm_source = bytes
                                resolve(instance.exports)
                            } catch {
                                load_file(v86_bin_fallback, {
                                    done: async (bytes: any) => {
                                        const { instance } =
                                            await WebAssembly.instantiate(
                                                bytes,
                                                env,
                                            )
                                        this.wasm_source = bytes
                                        resolve(instance.exports)
                                    },
                                })
                            }
                        },

                        progress: (e: any) => {
                            this.emulator_bus.send('download-progress', {
                                file_index: 0,
                                file_count: 1,
                                file_name: v86_bin,

                                lengthComputable: e.lengthComputable,
                                total: e.total,
                                loaded: e.loaded,
                            })
                        },
                    })
                })
            }
        }

        wasm_fn({ env: wasm_shared_funcs }).then((exports: WasmExports) => {
            wasm_memory = exports.memory
            exports['rust_init']()

            const emulator = (this.v86 = new v86(this.emulator_bus, {
                exports,
                wasm_table,
                wasm_memory,
            }))
            cpu = emulator.cpu

            this.continue_init(emulator, options)
        })
    }

    private async continue_init(
        emulator: any,
        options: V86Options,
    ): Promise<void> {
        this.bus.register(
            'emulator-stopped',
            function (this: V86) {
                this.cpu_is_running = false
                this.screen_adapter.pause()
            },
            this,
        )

        this.bus.register(
            'emulator-started',
            function (this: V86) {
                this.cpu_is_running = true
                this.screen_adapter.continue()
            },
            this,
        )

        const settings: EmulatorSettings = {}

        const boot_order = options.boot_order
            ? options.boot_order
            : options.fda
              ? BOOT_ORDER_FD_FIRST
              : options.hda
                ? BOOT_ORDER_HD_FIRST
                : BOOT_ORDER_CD_FIRST

        settings.acpi = options.acpi
        settings.disable_jit = options.disable_jit
        settings.load_devices = true
        settings.memory_size = options.memory_size || 64 * 1024 * 1024
        settings.vga_memory_size = options.vga_memory_size || 8 * 1024 * 1024
        settings.boot_order = boot_order
        settings.fastboot = options.fastboot || false
        settings.fda = undefined
        settings.fdb = undefined
        settings.uart1 = options.uart1
        settings.uart2 = options.uart2
        settings.uart3 = options.uart3
        settings.cmdline = options.cmdline
        settings.preserve_mac_from_state_image =
            options.preserve_mac_from_state_image
        settings.mac_address_translation = options.mac_address_translation
        settings.cpuid_level = options.cpuid_level
        settings.virtio_balloon = options.virtio_balloon
        settings.virtio_mem = options.virtio_mem
        settings.virtio_console = !!options.virtio_console
        settings.virtio_v86fs = !!options.virtio_v86fs

        const relay_url =
            options.network_relay_url ||
            (options.net_device && options.net_device.relay_url)
        if (relay_url) {
            // TODO: remove bus, use direct calls instead
            if (relay_url === 'fetch') {
                this.network_adapter = new FetchNetworkAdapter(
                    this.bus,
                    options.net_device,
                )
            } else if (relay_url === 'inbrowser') {
                // NOTE: experimental, will change when usage of options.net_device gets refactored in favour of emulator.bus
                this.network_adapter = new InBrowserNetworkAdapter(
                    this.bus,
                    options.net_device,
                )
            } else if (
                relay_url.startsWith('wisp://') ||
                relay_url.startsWith('wisps://')
            ) {
                this.network_adapter = new WispNetworkAdapter(
                    relay_url,
                    this.bus,
                    options.net_device,
                )
            } else {
                this.network_adapter = new NetworkAdapter(relay_url, this.bus)
            }
        }

        // Enable unconditionally, so that state images don't miss hardware
        // TODO: Should be properly fixed in restore_state
        settings.net_device = options.net_device || { type: 'ne2k' }

        const screen_options = options.screen || {}
        if (options.screen_container) {
            screen_options.container = options.screen_container
        }

        if (!options.disable_keyboard) {
            this.keyboard_adapter = new KeyboardAdapter(this.bus)
        }
        if (!options.disable_mouse) {
            this.mouse_adapter = new MouseAdapter(
                this.bus,
                screen_options.container,
            )
        }

        if (screen_options.container) {
            this.screen_adapter = new ScreenAdapter(
                screen_options,
                () =>
                    this.v86.cpu.devices.vga &&
                    this.v86.cpu.devices.vga.screen_fill_buffer(),
            )
        } else {
            this.screen_adapter = new DummyScreenAdapter(screen_options)
        }
        settings.screen = this.screen_adapter
        settings.screen_options = screen_options

        settings.serial_console = options.serial_console || { type: 'none' }

        // NOTE: serial_container_xtermjs and serial_container are deprecated
        if (options.serial_container_xtermjs) {
            settings.serial_console.type = 'xtermjs'
            settings.serial_console.container = options.serial_container_xtermjs
        } else if (options.serial_container) {
            settings.serial_console.type = 'textarea'
            settings.serial_console.container = options.serial_container
        }

        if (settings.serial_console?.type === 'xtermjs') {
            const xterm_lib =
                settings.serial_console.xterm_lib || (window as any)['Terminal']
            this.serial_adapter = new SerialAdapterXtermJS(
                settings.serial_console.container,
                this.bus,
                xterm_lib,
            )
        } else if (settings.serial_console?.type === 'textarea') {
            this.serial_adapter = new SerialAdapter(
                settings.serial_console.container,
                this.bus,
            )
            //this.recording_adapter = new SerialRecordingAdapter(this.bus);
        }

        const virtio_console_settings =
            options.virtio_console &&
            typeof options.virtio_console === 'boolean'
                ? { type: 'none' }
                : options.virtio_console

        if (virtio_console_settings?.type === 'xtermjs') {
            const xterm_lib =
                virtio_console_settings.xterm_lib || (window as any)['Terminal']
            this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(
                virtio_console_settings.container,
                this.bus,
                xterm_lib,
            )
        } else if (virtio_console_settings?.type === 'textarea') {
            this.virtio_console_adapter = new VirtioConsoleAdapter(
                virtio_console_settings.container,
                this.bus,
            )
        }

        if (!options.disable_speaker) {
            this.speaker_adapter = new SpeakerAdapter(this.bus)
        }

        // ugly, but required for closure compiler compilation

        function put_on_settings(name: string, buffer: any) {
            switch (name) {
                case 'hda':
                    settings.hda = buffer
                    break
                case 'hdb':
                    settings.hdb = buffer
                    break
                case 'cdrom':
                    settings.cdrom = buffer
                    break
                case 'fda':
                    settings.fda = buffer
                    break
                case 'fdb':
                    settings.fdb = buffer
                    break

                case 'multiboot':
                    settings.multiboot = buffer.buffer
                    break
                case 'bzimage':
                    settings.bzimage = buffer.buffer
                    break
                case 'initrd':
                    settings.initrd = buffer.buffer
                    break

                case 'bios':
                    settings.bios = buffer.buffer
                    break
                case 'vga_bios':
                    settings.vga_bios = buffer.buffer
                    break
                case 'initial_state':
                    settings.initial_state = buffer.buffer
                    break
                case 'fs9p_json':
                    settings.fs9p_json = buffer
                    break
                default:
                    dbg_assert(false, name)
            }
        }

        const files_to_load: any[] = []

        const add_file = (name: string, file: any) => {
            if (!file) {
                return
            }

            if (file.get && file.set && file.load) {
                files_to_load.push({
                    name: name,
                    loadable: file,
                })
                return
            }

            if (
                name === 'bios' ||
                name === 'vga_bios' ||
                name === 'initial_state' ||
                name === 'multiboot' ||
                name === 'bzimage' ||
                name === 'initrd'
            ) {
                // Ignore async for these because they must be available before boot.
                // This should make result.buffer available after the object is loaded
                file.async = false
            }

            if (name === 'fda' || name === 'fdb') {
                // small, doesn't make sense loading asynchronously
                file.async = false
            }

            if (file.url && !file.async) {
                files_to_load.push({
                    name: name,
                    url: file.url,
                    size: file.size,
                })
            } else {
                files_to_load.push({
                    name,
                    loadable: buffer_from_object(
                        file,
                        this.zstd_decompress_worker.bind(this),
                    ),
                })
            }
        }

        if (options.state) {
            console.warn(
                "Warning: Unknown option 'state'. Did you mean 'initial_state'?",
            )
        }

        add_file('bios', options.bios)
        add_file('vga_bios', options.vga_bios)
        add_file('cdrom', options.cdrom)
        add_file('hda', options.hda)
        add_file('hdb', options.hdb)
        add_file('fda', options.fda)
        add_file('fdb', options.fdb)
        add_file('initial_state', options.initial_state)
        add_file('multiboot', options.multiboot)
        add_file('bzimage', options.bzimage)
        add_file('initrd', options.initrd)

        if (options.filesystem && options.filesystem.handle9p) {
            settings.handle9p = options.filesystem.handle9p
        } else if (options.filesystem && options.filesystem.proxy_url) {
            settings.proxy9p = options.filesystem.proxy_url
        } else if (options.filesystem) {
            let fs_url = options.filesystem.basefs
            const base_url = options.filesystem.baseurl

            let file_storage: FileStorageInterface = new MemoryFileStorage()

            if (base_url) {
                file_storage = new ServerFileStorageWrapper(
                    file_storage,
                    base_url,
                    this.zstd_decompress.bind(this),
                )
            }
            settings.fs9p = this.fs9p = new FS(file_storage)

            if (fs_url) {
                dbg_assert(base_url, 'Filesystem: baseurl must be specified')

                let size: number | undefined

                if (typeof fs_url === 'object') {
                    size = fs_url.size
                    fs_url = fs_url.url
                }
                dbg_assert(typeof fs_url === 'string')

                files_to_load.push({
                    name: 'fs9p_json',
                    url: fs_url,
                    size: size,
                    as_json: true,
                })
            }
        }

        const total = files_to_load.length

        const cont = (index: number) => {
            if (index === total) {
                setTimeout(() => done.call(this), 0)
                return
            }

            const f = files_to_load[index]

            if (f.loadable) {
                f.loadable.onload = () => {
                    put_on_settings(f.name, f.loadable)
                    cont(index + 1)
                }
                f.loadable.load()
            } else {
                load_file(f.url, {
                    done: (result: any) => {
                        if (
                            f.url.endsWith('.zst') &&
                            f.name !== 'initial_state'
                        ) {
                            dbg_assert(
                                f.size,
                                'A size must be provided for compressed images',
                            )
                            result = this.zstd_decompress(
                                f.size,
                                new Uint8Array(result),
                            )
                        }

                        put_on_settings(
                            f.name,
                            f.as_json ? result : new SyncBuffer(result),
                        )
                        cont(index + 1)
                    },

                    progress: (e: any) => {
                        if (e.target.status === 200) {
                            this.emulator_bus.send('download-progress', {
                                file_index: index,
                                file_count: total,
                                file_name: f.url,

                                lengthComputable: e.lengthComputable,
                                total: e.total || f.size,
                                loaded: e.loaded,
                            })
                        } else {
                            this.emulator_bus.send('download-error', {
                                file_index: index,
                                file_count: total,
                                file_name: f.url,
                                request: e.target,
                            })
                        }
                    },
                    as_json: f.as_json,
                })
            }
        }
        cont(0)

        const done = async function (this: V86) {
            //if(settings.initial_state)
            //{
            //    // avoid large allocation now, memory will be restored later anyway
            //    settings.memory_size = 0;
            //}

            if (settings.fs9p && settings.fs9p_json) {
                if (!settings.initial_state) {
                    settings.fs9p.load_from_json(settings.fs9p_json)

                    if (options.bzimage_initrd_from_filesystem) {
                        const { bzimage_path, initrd_path } =
                            this.get_bzimage_initrd_from_filesystem(
                                settings.fs9p,
                            )

                        dbg_log(
                            'Found bzimage: ' +
                                bzimage_path +
                                ' and initrd: ' +
                                initrd_path,
                        )

                        const [initrd, bzimage] = await Promise.all([
                            settings.fs9p.read_file(initrd_path),
                            settings.fs9p.read_file(bzimage_path),
                        ])
                        put_on_settings('initrd', new SyncBuffer(initrd.buffer))
                        put_on_settings(
                            'bzimage',
                            new SyncBuffer(bzimage.buffer),
                        )
                    }
                } else {
                    dbg_log(
                        'Filesystem basefs ignored: Overridden by state image',
                    )
                }
            } else {
                dbg_assert(
                    !options.bzimage_initrd_from_filesystem ||
                        settings.initial_state,
                    'bzimage_initrd_from_filesystem: Requires a filesystem',
                )
            }

            if (this.serial_adapter && this.serial_adapter.show) {
                this.serial_adapter.show()
            }
            if (
                this.virtio_console_adapter &&
                this.virtio_console_adapter.show
            ) {
                this.virtio_console_adapter.show()
            }

            this.v86.init(settings)

            if (settings.initial_state) {
                emulator.restore_state(settings.initial_state)

                // The GC can't free settings, since it is referenced from
                // several closures. This isn't needed anymore, so we delete it
                // here
                settings.initial_state = undefined
            }

            if (options.autostart) {
                this.v86.run()
            }

            this.emulator_bus.send('emulator-loaded')
        }
    }

    /**
     * Decompress zstd data synchronously.
     */
    zstd_decompress(decompressed_size: number, src: Uint8Array): ArrayBuffer {
        const cpu = this.v86.cpu

        dbg_assert(!this.zstd_context)
        this.zstd_context = cpu.zstd_create_ctx(src.length)

        new Uint8Array(cpu.wasm_memory.buffer).set(
            src,
            cpu.zstd_get_src_ptr(this.zstd_context),
        )

        const ptr = cpu.zstd_read(this.zstd_context, decompressed_size)
        const result = cpu.wasm_memory.buffer.slice(
            ptr,
            ptr + decompressed_size,
        )
        cpu.zstd_read_free(ptr, decompressed_size)

        cpu.zstd_free_ctx(this.zstd_context)
        this.zstd_context = null

        return result
    }

    /**
     * Decompress zstd data asynchronously using a web worker.
     */
    async zstd_decompress_worker(
        decompressed_size: number,
        src: Uint8Array,
    ): Promise<ArrayBuffer> {
        if (!this.zstd_worker) {
            function the_worker() {
                let wasm: any

                globalThis.onmessage = function (e: any) {
                    if (!wasm) {
                        const env: Record<string, any> = Object.fromEntries(
                            [
                                'cpu_exception_hook',
                                'run_hardware_timers',
                                'cpu_event_halt',
                                'microtick',
                                'get_rand_int',
                                'stop_idling',
                                'io_port_read8',
                                'io_port_read16',
                                'io_port_read32',
                                'io_port_write8',
                                'io_port_write16',
                                'io_port_write32',
                                'mmap_read8',
                                'mmap_read32',
                                'mmap_write8',
                                'mmap_write16',
                                'mmap_write32',
                                'mmap_write64',
                                'mmap_write128',
                                'codegen_finalize',
                                'jit_clear_func',
                                'jit_clear_all_funcs',
                            ].map((f) => [
                                f,
                                () =>
                                    console.error(
                                        'zstd worker unexpectedly called ' + f,
                                    ),
                            ]),
                        )

                        env['__indirect_function_table'] =
                            new WebAssembly.Table({
                                element: 'anyfunc',
                                initial: 1024,
                            })
                        env['abort'] = () => {
                            throw new Error('zstd worker aborted')
                        }
                        env['log_from_wasm'] = env['console_log_from_wasm'] = (
                            off: number,
                            len: number,
                        ) => {
                            console.log(
                                read_sized_string_from_mem(
                                    wasm.exports.memory.buffer,
                                    off,
                                    len,
                                ),
                            )
                        }
                        env['dbg_trace_from_wasm'] = () => console.trace()

                        wasm = new WebAssembly.Instance(
                            new WebAssembly.Module(e.data),
                            { env: env },
                        )
                        return
                    }

                    const { src, decompressed_size, id } = e.data
                    const exports = wasm.exports

                    const zstd_context = exports['zstd_create_ctx'](src.length)
                    new Uint8Array(exports.memory.buffer).set(
                        src,
                        exports['zstd_get_src_ptr'](zstd_context),
                    )

                    const ptr = exports['zstd_read'](
                        zstd_context,
                        decompressed_size,
                    )
                    const result = exports.memory.buffer.slice(
                        ptr,
                        ptr + decompressed_size,
                    )
                    exports['zstd_read_free'](ptr, decompressed_size)

                    exports['zstd_free_ctx'](zstd_context)

                    postMessage({ result, id }, [result])
                }
            }

            const url = URL.createObjectURL(
                new Blob(['(' + the_worker.toString() + ')()'], {
                    type: 'text/javascript',
                }),
            )
            this.zstd_worker = new Worker(url)
            URL.revokeObjectURL(url)
            this.zstd_worker.postMessage(this.wasm_source, [this.wasm_source])
        }

        return new Promise((resolve) => {
            const id = this.zstd_worker_request_id++
            const done = async (e: MessageEvent) => {
                if (e.data.id === id) {
                    this.zstd_worker!.removeEventListener('message', done)
                    dbg_assert(decompressed_size === e.data.result.byteLength)
                    resolve(e.data.result)
                }
            }
            this.zstd_worker!.addEventListener('message', done)
            this.zstd_worker!.postMessage({ src, decompressed_size, id }, [
                src.buffer,
            ])
        })
    }

    get_bzimage_initrd_from_filesystem(filesystem: any): {
        initrd_path: string | undefined
        bzimage_path: string | undefined
    } {
        const root = (filesystem.read_dir('/') || []).map(
            (x: string) => '/' + x,
        )
        const boot = (filesystem.read_dir('/boot/') || []).map(
            (x: string) => '/boot/' + x,
        )

        let initrd_path: string | undefined
        let bzimage_path: string | undefined

        for (const f of ([] as string[]).concat(root, boot)) {
            const old = /old/i.test(f) || /fallback/i.test(f)
            const is_bzimage = /vmlinuz/i.test(f) || /bzimage/i.test(f)
            const is_initrd = /initrd/i.test(f) || /initramfs/i.test(f)

            if (is_bzimage && (!bzimage_path || !old)) {
                bzimage_path = f
            }

            if (is_initrd && (!initrd_path || !old)) {
                initrd_path = f
            }
        }

        if (!initrd_path || !bzimage_path) {
            console.log(
                'Failed to find bzimage or initrd in filesystem. Files:',
            )
            console.log(root.join(' '))
            console.log(boot.join(' '))
        }

        return { initrd_path, bzimage_path }
    }

    /**
     * Start emulation. Do nothing if emulator is running already. Can be asynchronous.
     */
    async run(): Promise<void> {
        this.v86.run()
    }

    /**
     * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
     */
    async stop(): Promise<void> {
        if (!this.cpu_is_running) {
            return
        }

        await new Promise<void>((resolve) => {
            const listener = () => {
                this.remove_listener('emulator-stopped', listener)
                resolve()
            }
            this.add_listener('emulator-stopped', listener)
            this.v86.stop()
        })
    }

    /**
     * Free resources associated with this instance.
     */
    async destroy(): Promise<void> {
        await this.stop()

        this.v86.destroy()
        if (this.keyboard_adapter) {
            this.keyboard_adapter.destroy()
        }
        if (this.network_adapter) {
            this.network_adapter.destroy()
        }
        if (this.mouse_adapter) {
            this.mouse_adapter.destroy()
        }
        if (this.screen_adapter) {
            this.screen_adapter.destroy()
        }
        if (this.serial_adapter) {
            this.serial_adapter.destroy()
        }
        if (this.speaker_adapter) {
            this.speaker_adapter.destroy()
        }
        if (this.virtio_console_adapter) {
            this.virtio_console_adapter.destroy()
        }
    }

    /**
     * Restart (force a reboot).
     */
    restart(): void {
        this.v86.restart()
    }

    /**
     * Add an event listener (the emulator is an event emitter).
     *
     * The callback function gets a single argument which depends on the event.
     */
    add_listener(event: string, listener: (...args: any[]) => any): void {
        this.bus.register(event, listener, this)
    }

    /**
     * Remove an event listener.
     */
    remove_listener(event: string, listener: (...args: any[]) => any): void {
        this.bus.unregister(event, listener)
    }

    /**
     * Restore the emulator state from the given state, which must be an
     * ArrayBuffer returned by save_state.
     *
     * Note that the state can only be restored correctly if this constructor has
     * been created with the same options as the original instance (e.g., same disk
     * images, memory size, etc.).
     *
     * Different versions of the emulator might use a different format for the
     * state buffer.
     */
    async restore_state(state: ArrayBuffer): Promise<void> {
        dbg_assert(arguments.length === 1)
        this.v86.restore_state(state)
    }

    /**
     * Asynchronously save the current state of the emulator.
     */
    async save_state(): Promise<ArrayBuffer> {
        dbg_assert(arguments.length === 0)
        return this.v86.save_state()
    }

    /**
     * Get the instruction counter value.
     */
    get_instruction_counter(): number {
        if (this.v86) {
            return this.v86.cpu.instruction_counter[0] >>> 0
        } else {
            // TODO: Should be handled using events
            return 0
        }
    }

    /**
     * Check if the emulator is running.
     */
    is_running(): boolean {
        return this.cpu_is_running
    }

    /**
     * Set the image inserted in the floppy drive. Can be changed at runtime, as
     * when physically changing the floppy disk.
     */
    async set_fda(file: FileDescriptor): Promise<void> {
        const fda = this.v86.cpu.devices.fdc.drives[0]
        if (file.url && !file.async) {
            await new Promise<void>((resolve) => {
                load_file(file.url, {
                    done: (result: any) => {
                        fda.insert_disk(new SyncBuffer(result))
                        resolve()
                    },
                })
            })
        } else {
            const image = buffer_from_object(
                file,
                this.zstd_decompress_worker.bind(this),
            )

            ;(image as any).onload = () => {
                fda.insert_disk(image)
            }

            await (image as any).load()
        }
    }

    /**
     * Set the image inserted in the second floppy drive, also at runtime.
     */
    async set_fdb(file: FileDescriptor): Promise<void> {
        const fdb = this.v86.cpu.devices.fdc.drives[1]
        if (file.url && !file.async) {
            await new Promise<void>((resolve) => {
                load_file(file.url, {
                    done: (result: any) => {
                        fdb.insert_disk(new SyncBuffer(result))
                        resolve()
                    },
                })
            })
        } else {
            const image = buffer_from_object(
                file,
                this.zstd_decompress_worker.bind(this),
            )

            ;(image as any).onload = () => {
                fdb.insert_disk(image)
            }

            await (image as any).load()
        }
    }

    /**
     * Eject floppy drive fda.
     */
    eject_fda(): void {
        this.v86.cpu.devices.fdc.drives[0].eject_disk()
    }

    /**
     * Eject second floppy drive fdb.
     */
    eject_fdb(): void {
        this.v86.cpu.devices.fdc.drives[1].eject_disk()
    }

    /**
     * Return buffer object of floppy disk of drive fda or null if the drive is empty.
     */
    get_disk_fda(): Uint8Array | null {
        return this.v86.cpu.devices.fdc.drives[0].get_buffer()
    }

    /**
     * Return buffer object of second floppy disk of drive fdb or null if the drive is empty.
     */
    get_disk_fdb(): Uint8Array | null {
        return this.v86.cpu.devices.fdc.drives[1].get_buffer()
    }

    /**
     * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
     * when physically changing the CD-ROM.
     */
    async set_cdrom(file: FileDescriptor): Promise<void> {
        if (file.url && !file.async) {
            load_file(file.url, {
                done: (result: any) => {
                    this.v86.cpu.devices.cdrom.set_cdrom(new SyncBuffer(result))
                },
            })
        } else {
            const image = buffer_from_object(
                file,
                this.zstd_decompress_worker.bind(this),
            )

            ;(image as any).onload = () => {
                this.v86.cpu.devices.cdrom.set_cdrom(image)
            }

            await (image as any).load()
        }
    }

    /**
     * Eject the CD-ROM.
     */
    eject_cdrom(): void {
        this.v86.cpu.devices.cdrom.eject()
    }

    /**
     * Send a sequence of scan codes to the emulated PS2 controller. A list of
     * codes can be found at http://stanislavs.org/helppc/make_codes.html.
     * Do nothing if there is no keyboard controller.
     */
    async keyboard_send_scancodes(
        codes: number[],
        delay?: number,
    ): Promise<void> {
        for (let i = 0; i < codes.length; i++) {
            this.bus.send('keyboard-code', codes[i])
            if (delay)
                await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }

    /**
     * Send translated keys.
     */
    async keyboard_send_keys(codes: number[], delay?: number): Promise<void> {
        for (let i = 0; i < codes.length; i++) {
            this.keyboard_adapter.simulate_press(codes[i])
            if (delay)
                await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }

    /**
     * Send text, assuming the guest OS uses a US keyboard layout.
     */
    async keyboard_send_text(string: string, delay?: number): Promise<void> {
        for (let i = 0; i < string.length; i++) {
            this.keyboard_adapter.simulate_char(string[i])
            if (delay)
                await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }

    /**
     * Download a screenshot (returns an img element, only works in browsers).
     */
    screen_make_screenshot(): HTMLImageElement | null {
        if (this.screen_adapter) {
            return this.screen_adapter.make_screenshot()
        }
        return null
    }

    /**
     * Set the scaling level of the emulated screen.
     */
    screen_set_scale(sx: number, sy: number): void {
        if (this.screen_adapter) {
            this.screen_adapter.set_scale(sx, sy)
        }
    }

    /**
     * Go fullscreen (only browsers).
     */
    screen_go_fullscreen(): void {
        if (!this.screen_adapter) {
            return
        }

        const elem = document.getElementById('screen_container')

        if (!elem) {
            return
        }

        // bracket notation because otherwise they get renamed by closure compiler

        const fn =
            (elem as any)['requestFullScreen'] ||
            (elem as any)['webkitRequestFullscreen'] ||
            (elem as any)['mozRequestFullScreen'] ||
            (elem as any)['msRequestFullScreen']

        if (fn) {
            fn.call(elem)

            // This is necessary, because otherwise chromium keyboard doesn't work anymore.
            // Might (but doesn't seem to) break something else
            const focus_element = document.getElementsByClassName(
                'phone_keyboard',
            )[0] as HTMLElement | undefined
            if (focus_element) {
                focus_element.focus()
            }
        }

        try {
            ;(navigator as any).keyboard.lock()
        } catch {
            // intentionally empty
        }

        this.lock_mouse()
    }

    /**
     * Lock the mouse cursor: It becomes invisible and is not moved out of the
     * browser window.
     */
    async lock_mouse(): Promise<void> {
        const elem = document.body

        try {
            await elem.requestPointerLock({
                unadjustedMovement: true,
            })
        } catch {
            // as per MDN, retry without unadjustedMovement option
            await elem.requestPointerLock()
        }
    }

    /**
     * Enable or disable sending mouse events to the emulated PS2 controller.
     */
    mouse_set_enabled(enabled: boolean): void {
        if (this.mouse_adapter) {
            this.mouse_adapter.emu_enabled = enabled
        }
    }

    /**
     * Alias for mouse_set_enabled.
     */
    mouse_set_status(enabled: boolean): void {
        this.mouse_set_enabled(enabled)
    }

    /**
     * Enable or disable sending keyboard events to the emulated PS2 controller.
     */
    keyboard_set_enabled(enabled: boolean): void {
        if (this.keyboard_adapter) {
            this.keyboard_adapter.emu_enabled = enabled
        }
    }

    /**
     * Alias for keyboard_set_enabled.
     */
    keyboard_set_status(enabled: boolean): void {
        this.keyboard_set_enabled(enabled)
    }

    /**
     * Send a string to the first emulated serial terminal.
     */
    serial0_send(data: string): void {
        for (let i = 0; i < data.length; i++) {
            this.bus.send('serial0-input', data.charCodeAt(i))
        }
    }

    /**
     * Send bytes to a serial port (to be received by the emulated PC).
     */
    serial_send_bytes(serial: number, data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) {
            this.bus.send('serial' + serial + '-input', data[i])
        }
    }

    /**
     * Set the modem status of a serial port.
     */
    serial_set_modem_status(serial: number, status: number): void {
        this.bus.send('serial' + serial + '-modem-status-input', status)
    }

    /**
     * Set the carrier detect status of a serial port.
     */
    serial_set_carrier_detect(serial: number, status: number): void {
        this.bus.send('serial' + serial + '-carrier-detect-input', status)
    }

    /**
     * Set the ring indicator status of a serial port.
     */
    serial_set_ring_indicator(serial: number, status: number): void {
        this.bus.send('serial' + serial + '-ring-indicator-input', status)
    }

    /**
     * Set the data set ready status of a serial port.
     */
    serial_set_data_set_ready(serial: number, status: number): void {
        this.bus.send('serial' + serial + '-data-set-ready-input', status)
    }

    /**
     * Set the clear to send status of a serial port.
     */
    serial_set_clear_to_send(serial: number, status: number): void {
        this.bus.send('serial' + serial + '-clear-to-send-input', status)
    }

    /**
     * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
     * been initialized.
     */
    async create_file(file: string, data: Uint8Array): Promise<void> {
        dbg_assert(arguments.length === 2)
        const fs = this.fs9p

        if (!fs) {
            return
        }

        const parts = file.split('/')
        const filename = parts[parts.length - 1]

        const path_infos = fs.SearchPath(file)
        const parent_id = path_infos.parentid
        const not_found = filename === '' || parent_id === -1

        if (!not_found) {
            await fs.CreateBinaryFile(filename, parent_id, data)
        } else {
            return Promise.reject(new FileNotFoundError())
        }
    }

    /**
     * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
     * initialized.
     */
    async read_file(file: string): Promise<Uint8Array | undefined> {
        dbg_assert(arguments.length === 1)
        const fs = this.fs9p

        if (!fs) {
            return
        }

        const result = await fs.read_file(file)

        if (result) {
            return result
        } else {
            return Promise.reject(new FileNotFoundError())
        }
    }

    /**
     * Run a sequence of automated steps.
     * @deprecated Use wait_until_vga_screen_contains etc.
     */
    automatically(steps: AutoStep[]): void {
        const run = (steps: AutoStep[]) => {
            const step = steps[0]

            if (!step) {
                return
            }

            const remaining_steps = steps.slice(1)

            if (step.sleep) {
                setTimeout(() => run(remaining_steps), step.sleep * 1000)
                return
            }

            if (step.vga_text) {
                this.wait_until_vga_screen_contains(step.vga_text).then(() =>
                    run(remaining_steps),
                )
                return
            }

            if (step.keyboard_send) {
                if (Array.isArray(step.keyboard_send)) {
                    this.keyboard_send_scancodes(step.keyboard_send)
                } else {
                    dbg_assert(typeof step.keyboard_send === 'string')
                    this.keyboard_send_text(step.keyboard_send)
                }

                run(remaining_steps)
                return
            }

            if (step.call) {
                step.call()
                run(remaining_steps)
                return
            }

            dbg_assert(false, step)
        }

        run(steps)
    }

    /**
     * Wait until expected text is present on the VGA text screen.
     *
     * Returns immediately if the expected text is already present on screen
     * at the time this function is called.
     *
     * An optional timeout may be specified in options.timeout_msec, returns
     * false if the timeout expires before the expected text could be detected.
     *
     * Expected text (or texts, see below) must be of type string or RegExp,
     * strings are tested against the beginning of a screen line, regular
     * expressions against the full line but may use wildcards for partial
     * matching.
     *
     * Two methods of text detection are supported depending on the type of the
     * argument expected:
     *
     * 1. If expected is a string or RegExp then the given text string or
     *    regular expression may match any line on screen for this function
     *    to succeed.
     *
     * 2. If expected is an array of strings and/or RegExp objects then the
     *    list of expected lines must match exactly at "the bottom" of the
     *    screen. The "bottom" line is the first non-empty line starting from
     *    the screen's end.
     *    Expected lines should not contain any trailing whitespace and/or
     *    newline characters. Expecting an empty line is valid.
     *
     * Returns true on success and false when the timeout has expired.
     */
    async wait_until_vga_screen_contains(
        expected: string | RegExp | Array<string | RegExp>,
        options?: { timeout_msec?: number },
    ): Promise<boolean> {
        const match_multi = Array.isArray(expected)
        const timeout_msec = options?.timeout_msec || 0
        const changed_rows = new Set<number>()

        const screen_put_char = (args: any) => changed_rows.add(args[0])
        const contains_expected = (
            screen_line: string,
            pattern: string | RegExp,
        ) =>
            (pattern as RegExp).test
                ? (pattern as RegExp).test(screen_line)
                : screen_line.startsWith(pattern as string)
        const screen_lines: string[] = []

        this.add_listener('screen-put-char', screen_put_char)

        for (const screen_line of this.screen_adapter.get_text_screen()) {
            if (match_multi) {
                screen_lines.push(screen_line.trimRight())
            } else if (
                contains_expected(screen_line, expected as string | RegExp)
            ) {
                this.remove_listener('screen-put-char', screen_put_char)
                return true
            }
        }

        let succeeded = false
        const end = timeout_msec ? performance.now() + timeout_msec : 0
        loop: while (!end || performance.now() < end) {
            if (match_multi) {
                let screen_height = screen_lines.length
                while (
                    screen_height > 0 &&
                    screen_lines[screen_height - 1] === ''
                ) {
                    screen_height--
                }
                const screen_offset =
                    screen_height - (expected as Array<string | RegExp>).length
                if (screen_offset >= 0) {
                    let matches = true
                    for (
                        let i = 0;
                        i < (expected as Array<string | RegExp>).length &&
                        matches;
                        i++
                    ) {
                        matches = contains_expected(
                            screen_lines[screen_offset + i],
                            (expected as Array<string | RegExp>)[i],
                        )
                    }
                    if (matches) {
                        succeeded = true
                        break
                    }
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 100))

            for (const row of changed_rows) {
                const screen_line = this.screen_adapter.get_text_row(row)
                if (match_multi) {
                    screen_lines[row] = screen_line.trimRight()
                } else if (
                    contains_expected(screen_line, expected as string | RegExp)
                ) {
                    succeeded = true
                    break loop
                }
            }
            changed_rows.clear()
        }

        this.remove_listener('screen-put-char', screen_put_char)
        return succeeded
    }

    /**
     * Reads data from memory at specified offset.
     */

    read_memory(offset: number, length: number): any {
        return this.v86.cpu.read_blob(offset, length)
    }

    /**
     * Writes data to memory at specified offset.
     */
    write_memory(blob: number[] | Uint8Array, offset: number): void {
        this.v86.cpu.write_blob(blob, offset)
    }

    /**
     * Set the serial container to an xterm.js terminal.
     */

    set_serial_container_xtermjs(
        element: HTMLElement,
        xterm_lib: any = (window as any)['Terminal'],
    ): void {
        if (this.serial_adapter && this.serial_adapter.destroy) {
            this.serial_adapter.destroy()
        }
        this.serial_adapter = new SerialAdapterXtermJS(
            element,
            this.bus,
            xterm_lib,
        )
        this.serial_adapter.show()
    }

    /**
     * Set the virtio console container to an xterm.js terminal.
     */

    set_virtio_console_container_xtermjs(
        element: HTMLElement,
        xterm_lib: any = (window as any)['Terminal'],
    ): void {
        if (
            this.virtio_console_adapter &&
            this.virtio_console_adapter.destroy
        ) {
            this.virtio_console_adapter.destroy()
        }
        this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(
            element,
            this.bus,
            xterm_lib,
        )
        this.virtio_console_adapter.show()
    }

    get_instruction_stats(): string {
        return print_stats.stats_to_string(this.v86.cpu)
    }
}

declare let module: any
declare let importScripts: any
declare let self: any

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports['V86'] = V86
} else if (typeof window !== 'undefined') {
    ;(window as any)['V86'] = V86
} else if (typeof importScripts === 'function') {
    // web worker

    ;(self as any)['V86'] = V86
}
