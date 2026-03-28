// VirtioV86FS: custom virtio device for v86fs guest filesystem
// PCI device ID 0x107F (virtio type 63, last slot in modern range)
// Three virtqueues: hipriq (metadata), requestq (data), notifyq (push invalidation)

import { LOG_PCI } from './const.js'
import { dbg_log } from './log.js'
import { VirtIO, VIRTIO_F_VERSION_1 } from './virtio.js'
import { BusConnector } from './bus.js'

interface VirtioV86FSCPU {
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
}

// Protocol message types
const V86FS_MSG_MOUNT = 0x00
const V86FS_MSG_LOOKUP = 0x01
const V86FS_MSG_GETATTR = 0x02

// Response types
const V86FS_MSG_MOUNT_R = 0x80
const _V86FS_MSG_LOOKUP_R = 0x81
const _V86FS_MSG_GETATTR_R = 0x82
const _V86FS_MSG_ERROR_R = 0xff

// Header size: 4B length + 1B type + 2B tag
const V86FS_HDR_SIZE = 7

const VIRTIO_V86FS_QUEUE_HIPRIQ = 0
const VIRTIO_V86FS_QUEUE_REQUESTQ = 1
const VIRTIO_V86FS_QUEUE_NOTIFYQ = 2

function packU32(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff
    buf[offset + 1] = (val >>> 8) & 0xff
    buf[offset + 2] = (val >>> 16) & 0xff
    buf[offset + 3] = (val >>> 24) & 0xff
}

function packU64(buf: Uint8Array, offset: number, val: number): void {
    packU32(buf, offset, val)
    packU32(buf, offset + 4, 0)
}

function readU16(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8)
}

export class VirtioV86FS {
    bus: BusConnector
    virtio: VirtIO

    constructor(cpu: VirtioV86FSCPU, bus: BusConnector) {
        this.bus = bus

        const queues = [
            // Queue 0: hipriq - high-priority metadata (LOOKUP, GETATTR)
            { size_supported: 128, notify_offset: 0 },
            // Queue 1: requestq - data requests (READ, WRITE, READDIR)
            { size_supported: 128, notify_offset: 1 },
            // Queue 2: notifyq - host-to-guest push invalidation
            { size_supported: 128, notify_offset: 2 },
        ]

        this.virtio = new VirtIO(cpu, {
            name: 'virtio-v86fs',
            pci_id: 0x0e << 3,
            device_id: 0x107f,
            subsystem_device_id: 63,
            common: {
                initial_port: 0xf800,
                queues: queues,
                features: [VIRTIO_F_VERSION_1],
                on_driver_ok: () => {
                    console.log('v86fs: driver ok')
                    this.bus.send('virtio-v86fs-driver-ok')
                },
            },
            notification: {
                initial_port: 0xf900,
                single_handler: false,
                handlers: [
                    // Queue 0: hipriq
                    (queue_id: number) => {
                        this.handle_queue(queue_id)
                    },
                    // Queue 1: requestq
                    (queue_id: number) => {
                        this.handle_queue(queue_id)
                    },
                    // Queue 2: notifyq
                    (_queue_id: number) => {
                        dbg_log('v86fs: notifyq notification', LOG_PCI)
                    },
                ],
            },
            isr_status: {
                initial_port: 0xf700,
            },
        })
    }

    handle_queue(queue_id: number): void {
        const queue = this.virtio.queues[queue_id]
        while (queue.has_request()) {
            const bufchain = queue.pop_request()
            const req = new Uint8Array(bufchain.length_readable)
            bufchain.get_next_blob(req)

            const resp = this.handle_message(req)
            if (resp && bufchain.length_writable > 0) {
                bufchain.set_next_blob(resp)
            }

            queue.push_reply(bufchain)
        }
        queue.flush_replies()
    }

    handle_message(req: Uint8Array): Uint8Array | null {
        if (req.length < V86FS_HDR_SIZE) {
            console.warn('v86fs: message too short:', req.length)
            return null
        }

        const type = req[4]
        const tag = readU16(req, 5)

        switch (type) {
            case V86FS_MSG_MOUNT:
                return this.handle_mount(req, tag)
            case V86FS_MSG_LOOKUP:
                dbg_log('v86fs: LOOKUP (not implemented)', LOG_PCI)
                return null
            case V86FS_MSG_GETATTR:
                dbg_log('v86fs: GETATTR (not implemented)', LOG_PCI)
                return null
            default:
                console.warn('v86fs: unknown message type:', type)
                return null
        }
    }

    handle_mount(req: Uint8Array, tag: number): Uint8Array {
        // Parse MOUNT: [7B hdr] [2B name_len] [name...]
        const name_len = readU16(req, 7)
        const name =
            name_len > 0
                ? new TextDecoder().decode(req.subarray(9, 9 + name_len))
                : ''

        console.log('v86fs: mount:', name || '(default)')

        // Emit bus event so host adapter can resolve the name
        this.bus.send('virtio-v86fs-mount', name)

        // Build MOUNT_R: [7B hdr] [4B status=0] [8B root_id=1] [4B mode=0x41ED]
        // 0x41ED = S_IFDIR | 0755
        const resp = new Uint8Array(23)
        packU32(resp, 0, 23) // length
        resp[4] = V86FS_MSG_MOUNT_R // type
        resp[5] = tag & 0xff // tag low
        resp[6] = (tag >> 8) & 0xff // tag high
        packU32(resp, 7, 0) // status = 0 (success)
        packU64(resp, 11, 1) // root_inode_id = 1
        packU32(resp, 19, 0x41ed) // mode = S_IFDIR | 0755

        return resp
    }

    get_state(): any[] {
        const state: any[] = []
        state[0] = this.virtio
        return state
    }

    set_state(state: any[]): void {
        this.virtio.set_state(state[0])
    }
}
