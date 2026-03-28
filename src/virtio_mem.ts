// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-4500006

import { LOG_PCI } from './const.js'
import { dbg_log } from './log.js'
import { VirtIO, VIRTIO_F_VERSION_1 } from './virtio.js'
import * as marshall from '../lib/marshall.js'
import { BusConnector } from './bus.js'

interface VirtioMemCPU {
    io: {
        register_read(
            port: number,
            device: object,
            r8?: ((port: number) => number) | undefined,
            r16?: ((port: number) => number) | undefined,
            r32?: ((port: number) => number) | undefined,
        ): void
        register_write(
            port: number,
            device: object,
            w8?: ((port: number) => void) | undefined,
            w16?: ((port: number) => void) | undefined,
            w32?: ((port: number) => void) | undefined,
        ): void
    }
    devices: {
        pci: {
            register_device(device: VirtIO): void
            raise_irq(pci_id: number): void
            lower_irq(pci_id: number): void
        }
    }
    read16(addr: number): number
    read32s(addr: number): number
    write16(addr: number, value: number): void
    write32(addr: number, value: number): void
    read_blob(addr: number, length: number): Uint8Array
    write_blob(blob: Uint8Array, addr: number): void
    zero_memory(addr: number, length: number): void
    memory_size: Int32Array
    resize_memory(new_size: number): void
    full_clear_tlb(): void
}

// Request types
const VIRTIO_MEM_REQ_PLUG = 0
const VIRTIO_MEM_REQ_UNPLUG = 1
const _VIRTIO_MEM_REQ_UNPLUG_ALL = 2
const VIRTIO_MEM_REQ_STATE = 3

// Response types
const VIRTIO_MEM_RESP_ACK = 0
const VIRTIO_MEM_RESP_NACK = 1
const _VIRTIO_MEM_RESP_BUSY = 2
const VIRTIO_MEM_RESP_ERROR = 3

// Default block size: 128MB
const DEFAULT_BLOCK_SIZE = 128 * 1024 * 1024

export class VirtioMem {
    bus: BusConnector
    cpu: VirtioMemCPU
    virtio: VirtIO

    block_size: number
    region_addr: number
    region_size: number
    usable_region_size: number
    plugged_size: number
    requested_size: number

    constructor(
        cpu: VirtioMemCPU,
        bus: BusConnector,
        region_addr: number,
        region_size: number,
        block_size?: number,
    ) {
        this.bus = bus
        this.cpu = cpu
        this.block_size = block_size || DEFAULT_BLOCK_SIZE
        this.region_addr = region_addr
        this.region_size = region_size
        this.usable_region_size = region_size
        this.plugged_size = 0
        this.requested_size = 0

        const queues = [{ size_supported: 32, notify_offset: 0 }]

        this.virtio = new VirtIO(cpu, {
            name: 'virtio-mem',
            pci_id: 0x0d << 3,
            device_id: 0x1058,
            subsystem_device_id: 24,
            common: {
                initial_port: 0xe800,
                queues,
                features: [VIRTIO_F_VERSION_1],
                on_driver_ok: () => {
                    dbg_log('virtio-mem setup', LOG_PCI)
                },
            },
            notification: {
                initial_port: 0xe900,
                single_handler: false,
                handlers: [
                    (queue_id: number) => {
                        this.handle_request(queue_id)
                    },
                ],
            },
            isr_status: {
                initial_port: 0xe700,
            },
            device_specific: {
                initial_port: 0xe600,
                struct: [
                    // block_size low
                    {
                        bytes: 4,
                        name: 'block_size_low',
                        read: () => this.block_size >>> 0,
                        write: () => {},
                    },
                    // block_size high
                    {
                        bytes: 4,
                        name: 'block_size_high',
                        read: () => 0,
                        write: () => {},
                    },
                    // node_id (u16 padded to u32)
                    {
                        bytes: 2,
                        name: 'node_id',
                        read: () => 0,
                        write: () => {},
                    },
                    // padding (6 bytes as 2+4)
                    {
                        bytes: 2,
                        name: 'padding0',
                        read: () => 0,
                        write: () => {},
                    },
                    {
                        bytes: 4,
                        name: 'padding1',
                        read: () => 0,
                        write: () => {},
                    },
                    // addr low
                    {
                        bytes: 4,
                        name: 'addr_low',
                        read: () => this.region_addr >>> 0,
                        write: () => {},
                    },
                    // addr high
                    {
                        bytes: 4,
                        name: 'addr_high',
                        read: () => 0,
                        write: () => {},
                    },
                    // region_size low
                    {
                        bytes: 4,
                        name: 'region_size_low',
                        read: () => this.region_size >>> 0,
                        write: () => {},
                    },
                    // region_size high
                    {
                        bytes: 4,
                        name: 'region_size_high',
                        read: () => 0,
                        write: () => {},
                    },
                    // usable_region_size low
                    {
                        bytes: 4,
                        name: 'usable_region_size_low',
                        read: () => this.usable_region_size >>> 0,
                        write: () => {},
                    },
                    // usable_region_size high
                    {
                        bytes: 4,
                        name: 'usable_region_size_high',
                        read: () => 0,
                        write: () => {},
                    },
                    // plugged_size low
                    {
                        bytes: 4,
                        name: 'plugged_size_low',
                        read: () => this.plugged_size >>> 0,
                        write: () => {},
                    },
                    // plugged_size high
                    {
                        bytes: 4,
                        name: 'plugged_size_high',
                        read: () => 0,
                        write: () => {},
                    },
                    // requested_size low
                    {
                        bytes: 4,
                        name: 'requested_size_low',
                        read: () => this.requested_size >>> 0,
                        write: () => {},
                    },
                    // requested_size high
                    {
                        bytes: 4,
                        name: 'requested_size_high',
                        read: () => 0,
                        write: () => {},
                    },
                ],
            },
        })
    }

    handle_request(queue_id: number): void {
        const queue = this.virtio.queues[queue_id]
        while (queue.has_request()) {
            const bufchain = queue.pop_request()
            const request = new Uint8Array(bufchain.length_readable)
            bufchain.get_next_blob(request)

            const type = request[0] | (request[1] << 8)
            const resp = new Uint8Array(8)

            let resp_type = VIRTIO_MEM_RESP_ERROR
            switch (type) {
                case VIRTIO_MEM_REQ_PLUG:
                    resp_type = this.handle_plug(request)
                    break
                case VIRTIO_MEM_REQ_UNPLUG:
                    resp_type = VIRTIO_MEM_RESP_NACK
                    break
                case VIRTIO_MEM_REQ_STATE:
                    resp_type = this.handle_state(request, resp)
                    break
                default:
                    dbg_log('virtio-mem: unknown request type ' + type, LOG_PCI)
            }

            resp[0] = resp_type & 0xff
            resp[1] = (resp_type >> 8) & 0xff

            bufchain.set_next_blob(resp)
            queue.push_reply(bufchain)
        }
        queue.flush_replies()
    }

    handle_plug(request: Uint8Array): number {
        // Request layout after type (8 bytes header):
        // addr: u64 at offset 8
        // nb_blocks: u16 at offset 16
        const addr =
            (request[8] |
                (request[9] << 8) |
                (request[10] << 16) |
                (request[11] << 24)) >>>
            0
        const nb_blocks = request[16] | (request[17] << 8)

        const size = nb_blocks * this.block_size
        const new_plugged = this.plugged_size + size

        if (new_plugged > this.usable_region_size) {
            return VIRTIO_MEM_RESP_NACK
        }

        // Grow guest memory to accommodate the plug
        const new_memory_size = this.cpu.memory_size[0] + size
        this.cpu.resize_memory(new_memory_size)
        this.cpu.full_clear_tlb()
        this.plugged_size = new_plugged

        dbg_log(
            'virtio-mem: plugged ' +
                nb_blocks +
                ' blocks at 0x' +
                addr.toString(16) +
                ' (' +
                (size >> 20) +
                'MB)',
            LOG_PCI,
        )

        return VIRTIO_MEM_RESP_ACK
    }

    handle_state(request: Uint8Array, resp: Uint8Array): number {
        const addr =
            (request[8] |
                (request[9] << 8) |
                (request[10] << 16) |
                (request[11] << 24)) >>>
            0
        const nb_blocks = request[16] | (request[17] << 8)

        // Report all requested blocks as plugged if within plugged_size
        const offset = addr - this.region_addr
        const end = offset + nb_blocks * this.block_size
        const all_plugged = end <= this.plugged_size ? 1 : 0

        // State response: count field at offset 8
        resp[8] = all_plugged & 0xff
        resp[9] = (all_plugged >> 8) & 0xff

        return VIRTIO_MEM_RESP_ACK
    }

    set_requested_size(size: number): void {
        this.requested_size = size
        if (this.virtio.device_status & 4) {
            this.virtio.notify_config_changes()
        }
    }

    get_state(): any[] {
        const state: any[] = []
        state[0] = this.virtio
        state[1] = this.block_size
        state[2] = this.region_addr
        state[3] = this.region_size
        state[4] = this.usable_region_size
        state[5] = this.plugged_size
        state[6] = this.requested_size
        return state
    }

    set_state(state: any[]): void {
        this.virtio.set_state(state[0])
        this.block_size = state[1]
        this.region_addr = state[2]
        this.region_size = state[3]
        this.usable_region_size = state[4]
        this.plugged_size = state[5]
        this.requested_size = state[6]
    }
}
