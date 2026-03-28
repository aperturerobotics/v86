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

const VIRTIO_V86FS_QUEUE_HIPRIQ = 0
const VIRTIO_V86FS_QUEUE_REQUESTQ = 1
const VIRTIO_V86FS_QUEUE_NOTIFYQ = 2

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
                    (_queue_id: number) => {
                        dbg_log('v86fs: hipriq notification', LOG_PCI)
                    },
                    // Queue 1: requestq
                    (_queue_id: number) => {
                        dbg_log('v86fs: requestq notification', LOG_PCI)
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

    get_state(): any[] {
        const state: any[] = []
        state[0] = this.virtio
        return state
    }

    set_state(state: any[]): void {
        this.virtio.set_state(state[0])
    }
}
