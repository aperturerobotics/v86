// -------------------------------------------------
// ------------------ Marshall ---------------------
// -------------------------------------------------
// helper functions for virtio and 9p.

import { dbg_log } from './../src/log.js'

const textde = new TextDecoder()
const texten = new TextEncoder()

// QID structure used in the 9P protocol.
export interface QID {
    type: number
    version: number
    path: number
}

// Tracks the current read offset during unmarshalling.
export interface MarshallState {
    offset: number
}

// Type codes used by Marshall/Unmarshall:
// 'w' = word (4 bytes), 'd' = double word (8 bytes, only low 32 bits written),
// 'h' = half word (2 bytes), 'b' = byte, 's' = length-prefixed string, 'Q' = QID (13 bytes).
export type MarshallTypeCode = 'w' | 'd' | 'h' | 'b' | 's' | 'Q'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MarshallInput = any

// Inserts data from an array to a byte aligned struct in memory
export function Marshall(
    typelist: MarshallTypeCode[],
    input: MarshallInput[],
    struct: Uint8Array,
    offset: number,
): number {
    var item: MarshallInput
    var size = 0
    for (var i = 0; i < typelist.length; i++) {
        item = input[i]
        switch (typelist[i]) {
            case 'w':
                struct[offset++] = item & 0xff
                struct[offset++] = (item >> 8) & 0xff
                struct[offset++] = (item >> 16) & 0xff
                struct[offset++] = (item >> 24) & 0xff
                size += 4
                break
            case 'd': // double word
                struct[offset++] = item & 0xff
                struct[offset++] = (item >> 8) & 0xff
                struct[offset++] = (item >> 16) & 0xff
                struct[offset++] = (item >> 24) & 0xff
                struct[offset++] = 0x0
                struct[offset++] = 0x0
                struct[offset++] = 0x0
                struct[offset++] = 0x0
                size += 8
                break
            case 'h':
                struct[offset++] = item & 0xff
                struct[offset++] = item >> 8
                size += 2
                break
            case 'b':
                struct[offset++] = item
                size += 1
                break
            case 's': {
                var lengthoffset = offset
                var length = 0
                struct[offset++] = 0 // set the length later
                struct[offset++] = 0
                size += 2

                var stringBytes = texten.encode(item)
                size += stringBytes.byteLength
                length += stringBytes.byteLength
                struct.set(stringBytes, offset)
                offset += stringBytes.byteLength

                struct[lengthoffset + 0] = length & 0xff
                struct[lengthoffset + 1] = (length >> 8) & 0xff
                break
            }
            case 'Q':
                Marshall(
                    ['b', 'w', 'd'],
                    [item.type, item.version, item.path],
                    struct,
                    offset,
                )
                offset += 13
                size += 13
                break
            default:
                dbg_log('Marshall: Unknown type=' + typelist[i])
                break
        }
    }
    return size
}

// Extracts data from a byte aligned struct in memory to an array
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Unmarshall(
    typelist: MarshallTypeCode[],
    struct: Uint8Array,
    state: MarshallState,
): any[] {
    let offset = state.offset
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    var output: any[] = []
    for (var i = 0; i < typelist.length; i++) {
        switch (typelist[i]) {
            case 'w': {
                var val = struct[offset++]
                val += struct[offset++] << 8
                val += struct[offset++] << 16
                val += (struct[offset++] << 24) >>> 0
                output.push(val)
                break
            }
            case 'd': {
                var val = struct[offset++]
                val += struct[offset++] << 8
                val += struct[offset++] << 16
                val += (struct[offset++] << 24) >>> 0
                offset += 4
                output.push(val)
                break
            }
            case 'h': {
                var val = struct[offset++]
                output.push(val + (struct[offset++] << 8))
                break
            }
            case 'b':
                output.push(struct[offset++])
                break
            case 's': {
                var len = struct[offset++]
                len += struct[offset++] << 8

                var stringBytes = struct.slice(offset, offset + len)
                offset += len
                output.push(textde.decode(stringBytes))
                break
            }
            case 'Q': {
                state.offset = offset
                const qid = Unmarshall(['b', 'w', 'd'], struct, state)
                offset = state.offset
                output.push({
                    type: qid[0],
                    version: qid[1],
                    path: qid[2],
                })
                break
            }
            default:
                dbg_log('Error in Unmarshall: Unknown type=' + typelist[i])
                break
        }
    }
    state.offset = offset
    return output
}
