import { dbg_assert } from '../log.js'
import { load_file } from '../lib.js'

export interface FileStorageInterface {
    read(
        sha256sum: string,
        offset: number,
        count: number,
        file_size: number,
    ): Promise<Uint8Array | null>
    cache(sha256sum: string, data: Uint8Array): Promise<void>
    uncache(sha256sum: string): void
}

export class MemoryFileStorage implements FileStorageInterface {
    filedata: Map<string, Uint8Array>

    constructor() {
        this.filedata = new Map()
    }

    async read(
        sha256sum: string,
        offset: number,
        count: number,
        _file_size: number,
    ): Promise<Uint8Array | null> {
        dbg_assert(
            !!sha256sum,
            'MemoryFileStorage read: sha256sum should be a non-empty string',
        )
        const data = this.filedata.get(sha256sum)

        if (!data) {
            return null
        }

        return data.subarray(offset, offset + count)
    }

    async cache(sha256sum: string, data: Uint8Array): Promise<void> {
        dbg_assert(
            !!sha256sum,
            'MemoryFileStorage cache: sha256sum should be a non-empty string',
        )
        this.filedata.set(sha256sum, data)
    }

    uncache(sha256sum: string): void {
        this.filedata.delete(sha256sum)
    }
}

export class ServerFileStorageWrapper implements FileStorageInterface {
    storage: FileStorageInterface
    baseurl: string
    zstd_decompress: (file_size: number, data: Uint8Array) => ArrayBuffer

    constructor(
        file_storage: FileStorageInterface,
        baseurl: string,
        zstd_decompress: (file_size: number, data: Uint8Array) => ArrayBuffer,
    ) {
        dbg_assert(
            !!baseurl,
            'ServerMemoryFileStorage: baseurl should not be empty',
        )

        if (!baseurl.endsWith('/')) {
            baseurl += '/'
        }

        this.storage = file_storage
        this.baseurl = baseurl
        this.zstd_decompress = zstd_decompress
    }

    load_from_server(
        sha256sum: string,
        file_size: number,
    ): Promise<Uint8Array> {
        return new Promise((resolve, _reject) => {
            load_file(this.baseurl + sha256sum, {
                done: async (buffer: ArrayBuffer) => {
                    let data = new Uint8Array(buffer)
                    if (sha256sum.endsWith('.zst')) {
                        data = new Uint8Array(
                            this.zstd_decompress(file_size, data),
                        )
                    }
                    await this.cache(sha256sum, data)
                    resolve(data)
                },
            })
        })
    }

    async read(
        sha256sum: string,
        offset: number,
        count: number,
        file_size: number,
    ): Promise<Uint8Array | null> {
        const data = await this.storage.read(
            sha256sum,
            offset,
            count,
            file_size,
        )
        if (!data) {
            const full_file = await this.load_from_server(sha256sum, file_size)
            return full_file.subarray(offset, offset + count)
        }
        return data
    }

    async cache(sha256sum: string, data: Uint8Array): Promise<void> {
        return await this.storage.cache(sha256sum, data)
    }

    uncache(sha256sum: string): void {
        this.storage.uncache(sha256sum)
    }
}
