declare var DEBUG: boolean

// AudioWorkletProcessor is available in AudioWorklet scope but not in main thread scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var AudioWorkletProcessor: any

import {
    MIXER_CHANNEL_BOTH,
    MIXER_CHANNEL_LEFT,
    MIXER_CHANNEL_RIGHT,
    MIXER_SRC_PCSPEAKER,
    MIXER_SRC_DAC,
    MIXER_SRC_MASTER,
} from '../const.js'
import { dbg_assert, dbg_log } from '../log.js'
import { OSCILLATOR_FREQ } from '../pit.js'
import { dump_file } from '../lib.js'
import { BusConnector } from '../bus.js'

/* global registerProcessor, sampleRate */

const DAC_QUEUE_RESERVE = 0.2

const AUDIOBUFFER_MINIMUM_SAMPLING_RATE = 8000

interface SpeakerDACInterface {
    node_processor: AudioWorkletNode | null
    pump(): void
}

export class SpeakerAdapter {
    bus: BusConnector
    audio_context: AudioContext | null
    mixer: SpeakerMixer
    pcspeaker: PCSpeaker
    dac: SpeakerWorkletDAC | SpeakerBufferSourceDAC

    constructor(bus: BusConnector) {
        if (typeof window === 'undefined') {
            this.bus = bus
            this.audio_context = null
            this.mixer = undefined!
            this.pcspeaker = undefined!
            this.dac = undefined!
            return
        }
        if (!window.AudioContext) {
            console.warn("Web browser doesn't support Web Audio API")
            this.bus = bus
            this.audio_context = null
            this.mixer = undefined!
            this.pcspeaker = undefined!
            this.dac = undefined!
            return
        }

        var SpeakerDAC = window.AudioWorklet
            ? SpeakerWorkletDAC
            : SpeakerBufferSourceDAC

        this.bus = bus

        this.audio_context = new AudioContext()

        this.mixer = new SpeakerMixer(bus, this.audio_context)

        this.pcspeaker = new PCSpeaker(bus, this.audio_context, this.mixer)

        this.dac = new SpeakerDAC(bus, this.audio_context, this.mixer)

        this.pcspeaker.start()

        bus.register(
            'emulator-stopped',
            function (this: SpeakerAdapter) {
                this.audio_context?.suspend()
            },
            this,
        )

        bus.register(
            'emulator-started',
            function (this: SpeakerAdapter) {
                this.audio_context?.resume()
            },
            this,
        )

        bus.register(
            'speaker-confirm-initialized',
            function () {
                bus.send('speaker-has-initialized')
            },
            this,
        )
        bus.send('speaker-has-initialized')
    }

    destroy(): void {
        this.audio_context && this.audio_context.close()
        this.audio_context = null
        this.dac &&
            this.dac.node_processor &&
            this.dac.node_processor.port.close()
        this.dac = undefined!
    }
}

class SpeakerMixer {
    audio_context: AudioContext
    sources: Map<number, SpeakerMixerSource> = new Map()

    volume_both = 1
    volume_left = 1
    volume_right = 1
    gain_left = 1
    gain_right = 1

    node_treble_left: BiquadFilterNode
    node_treble_right: BiquadFilterNode
    node_bass_left: BiquadFilterNode
    node_bass_right: BiquadFilterNode
    node_gain_left: GainNode
    node_gain_right: GainNode
    node_merger: ChannelMergerNode

    input_left: BiquadFilterNode
    input_right: BiquadFilterNode

    constructor(bus: BusConnector, audio_context: AudioContext) {
        this.audio_context = audio_context

        this.node_treble_left = this.audio_context.createBiquadFilter()
        this.node_treble_right = this.audio_context.createBiquadFilter()
        this.node_treble_left.type = 'highshelf'
        this.node_treble_right.type = 'highshelf'
        this.node_treble_left.frequency.setValueAtTime(
            2000,
            this.audio_context.currentTime,
        )
        this.node_treble_right.frequency.setValueAtTime(
            2000,
            this.audio_context.currentTime,
        )

        this.node_bass_left = this.audio_context.createBiquadFilter()
        this.node_bass_right = this.audio_context.createBiquadFilter()
        this.node_bass_left.type = 'lowshelf'
        this.node_bass_right.type = 'lowshelf'
        this.node_bass_left.frequency.setValueAtTime(
            200,
            this.audio_context.currentTime,
        )
        this.node_bass_right.frequency.setValueAtTime(
            200,
            this.audio_context.currentTime,
        )

        this.node_gain_left = this.audio_context.createGain()
        this.node_gain_right = this.audio_context.createGain()

        this.node_merger = this.audio_context.createChannelMerger(2)

        this.input_left = this.node_treble_left
        this.input_right = this.node_treble_right

        this.node_treble_left.connect(this.node_bass_left)
        this.node_bass_left.connect(this.node_gain_left)
        this.node_gain_left.connect(this.node_merger, 0, 0)

        this.node_treble_right.connect(this.node_bass_right)
        this.node_bass_right.connect(this.node_gain_right)
        this.node_gain_right.connect(this.node_merger, 0, 1)

        this.node_merger.connect(this.audio_context.destination)

        bus.register(
            'mixer-connect',
            function (this: SpeakerMixer, data: [number, number]) {
                var source_id = data[0]
                var channel = data[1]
                this.connect_source(source_id, channel)
            },
            this,
        )

        bus.register(
            'mixer-disconnect',
            function (this: SpeakerMixer, data: [number, number]) {
                var source_id = data[0]
                var channel = data[1]
                this.disconnect_source(source_id, channel)
            },
            this,
        )

        bus.register(
            'mixer-volume',
            function (this: SpeakerMixer, data: [number, number, number]) {
                var source_id = data[0]
                var channel = data[1]
                var decibels = data[2]

                var gain = Math.pow(10, decibels / 20)

                var source: SpeakerMixer | SpeakerMixerSource | undefined =
                    source_id === MIXER_SRC_MASTER
                        ? this
                        : this.sources.get(source_id)

                if (source === undefined) {
                    dbg_assert(
                        false,
                        'Mixer set volume - cannot set volume for undefined source: ' +
                            source_id,
                    )
                    return
                }

                source.set_volume(gain, channel)
            },
            this,
        )

        bus.register(
            'mixer-gain-left',
            function (this: SpeakerMixer, decibels: number) {
                this.gain_left = Math.pow(10, decibels / 20)
                this.update()
            },
            this,
        )

        bus.register(
            'mixer-gain-right',
            function (this: SpeakerMixer, decibels: number) {
                this.gain_right = Math.pow(10, decibels / 20)
                this.update()
            },
            this,
        )

        const create_gain_handler = (audio_node: BiquadFilterNode) => {
            return function (this: SpeakerMixer, decibels: number) {
                audio_node.gain.setValueAtTime(
                    decibels,
                    this.audio_context.currentTime,
                )
            }
        }
        bus.register(
            'mixer-treble-left',
            create_gain_handler(this.node_treble_left),
            this,
        )
        bus.register(
            'mixer-treble-right',
            create_gain_handler(this.node_treble_right),
            this,
        )
        bus.register(
            'mixer-bass-left',
            create_gain_handler(this.node_bass_left),
            this,
        )
        bus.register(
            'mixer-bass-right',
            create_gain_handler(this.node_bass_right),
            this,
        )
    }

    add_source(source_node: AudioNode, source_id: number): SpeakerMixerSource {
        var source = new SpeakerMixerSource(
            this.audio_context,
            source_node,
            this.input_left,
            this.input_right,
        )

        dbg_assert(
            !this.sources.has(source_id),
            'Mixer add source - overwritting source: ' + source_id,
        )

        this.sources.set(source_id, source)
        return source
    }

    connect_source(source_id: number, channel?: number): void {
        var source = this.sources.get(source_id)

        if (source === undefined) {
            dbg_assert(
                false,
                'Mixer connect - cannot connect undefined source: ' + source_id,
            )
            return
        }

        source.connect(channel)
    }

    disconnect_source(source_id: number, channel?: number): void {
        var source = this.sources.get(source_id)

        if (source === undefined) {
            dbg_assert(
                false,
                'Mixer disconnect - cannot disconnect undefined source: ' +
                    source_id,
            )
            return
        }

        source.disconnect(channel)
    }

    set_volume(value: number, channel?: number): void {
        if (channel === undefined) {
            channel = MIXER_CHANNEL_BOTH
        }

        switch (channel) {
            case MIXER_CHANNEL_LEFT:
                this.volume_left = value
                break
            case MIXER_CHANNEL_RIGHT:
                this.volume_right = value
                break
            case MIXER_CHANNEL_BOTH:
                this.volume_both = value
                break
            default:
                dbg_assert(
                    false,
                    'Mixer set master volume - unknown channel: ' + channel,
                )
                return
        }

        this.update()
    }

    update(): void {
        var net_gain_left = this.volume_both * this.volume_left * this.gain_left
        var net_gain_right =
            this.volume_both * this.volume_right * this.gain_right

        this.node_gain_left.gain.setValueAtTime(
            net_gain_left,
            this.audio_context.currentTime,
        )
        this.node_gain_right.gain.setValueAtTime(
            net_gain_right,
            this.audio_context.currentTime,
        )
    }
}

class SpeakerMixerSource {
    audio_context: AudioContext

    connected_left = true
    connected_right = true
    gain_hidden = 1
    volume_both = 1
    volume_left = 1
    volume_right = 1

    node_splitter: ChannelSplitterNode
    node_gain_left: GainNode
    node_gain_right: GainNode

    constructor(
        audio_context: AudioContext,
        source_node: AudioNode,
        destination_left: AudioNode,
        destination_right: AudioNode,
    ) {
        this.audio_context = audio_context

        this.node_splitter = audio_context.createChannelSplitter(2)
        this.node_gain_left = audio_context.createGain()
        this.node_gain_right = audio_context.createGain()

        source_node.connect(this.node_splitter)

        this.node_splitter.connect(this.node_gain_left, 0)
        this.node_gain_left.connect(destination_left)

        this.node_splitter.connect(this.node_gain_right, 1)
        this.node_gain_right.connect(destination_right)
    }

    update(): void {
        var net_gain_left =
            +this.connected_left *
            this.gain_hidden *
            this.volume_both *
            this.volume_left
        var net_gain_right =
            +this.connected_right *
            this.gain_hidden *
            this.volume_both *
            this.volume_right

        this.node_gain_left.gain.setValueAtTime(
            net_gain_left,
            this.audio_context.currentTime,
        )
        this.node_gain_right.gain.setValueAtTime(
            net_gain_right,
            this.audio_context.currentTime,
        )
    }

    connect(channel?: number): void {
        var both = !channel || channel === MIXER_CHANNEL_BOTH
        if (both || channel === MIXER_CHANNEL_LEFT) {
            this.connected_left = true
        }
        if (both || channel === MIXER_CHANNEL_RIGHT) {
            this.connected_right = true
        }
        this.update()
    }

    disconnect(channel?: number): void {
        var both = !channel || channel === MIXER_CHANNEL_BOTH
        if (both || channel === MIXER_CHANNEL_LEFT) {
            this.connected_left = false
        }
        if (both || channel === MIXER_CHANNEL_RIGHT) {
            this.connected_right = false
        }
        this.update()
    }

    set_volume(value: number, channel?: number): void {
        if (channel === undefined) {
            channel = MIXER_CHANNEL_BOTH
        }

        switch (channel) {
            case MIXER_CHANNEL_LEFT:
                this.volume_left = value
                break
            case MIXER_CHANNEL_RIGHT:
                this.volume_right = value
                break
            case MIXER_CHANNEL_BOTH:
                this.volume_both = value
                break
            default:
                dbg_assert(
                    false,
                    'Mixer set volume - unknown channel: ' + channel,
                )
                return
        }

        this.update()
    }

    set_gain_hidden(value: number): void {
        this.gain_hidden = value
    }
}

class PCSpeaker {
    node_oscillator: OscillatorNode
    mixer_connection: SpeakerMixerSource

    constructor(
        bus: BusConnector,
        audio_context: AudioContext,
        mixer: SpeakerMixer,
    ) {
        this.node_oscillator = audio_context.createOscillator()
        this.node_oscillator.type = 'square'
        this.node_oscillator.frequency.setValueAtTime(
            440,
            audio_context.currentTime,
        )

        this.mixer_connection = mixer.add_source(
            this.node_oscillator,
            MIXER_SRC_PCSPEAKER,
        )
        this.mixer_connection.disconnect()

        bus.register(
            'pcspeaker-enable',
            function () {
                mixer.connect_source(MIXER_SRC_PCSPEAKER)
            },
            this,
        )

        bus.register(
            'pcspeaker-disable',
            function () {
                mixer.disconnect_source(MIXER_SRC_PCSPEAKER)
            },
            this,
        )

        bus.register(
            'pcspeaker-update',
            function (this: PCSpeaker, data: [number, number]) {
                var counter_mode = data[0]
                var counter_reload = data[1]

                var frequency = 0
                var beep_enabled = counter_mode === 3

                if (beep_enabled) {
                    frequency = (OSCILLATOR_FREQ * 1000) / counter_reload
                    frequency = Math.min(
                        frequency,
                        this.node_oscillator.frequency.maxValue,
                    )
                    frequency = Math.max(frequency, 0)
                }

                this.node_oscillator.frequency.setValueAtTime(
                    frequency,
                    audio_context.currentTime,
                )
            },
            this,
        )
    }

    start(): void {
        this.node_oscillator.start()
    }
}

class SpeakerWorkletDAC {
    bus: BusConnector
    audio_context: AudioContext
    enabled = false
    sampling_rate = 48000
    node_processor: AudioWorkletNode | null = null
    node_output: GainNode
    mixer_connection: SpeakerMixerSource
    debugger: SpeakerDACDebugger | undefined

    constructor(
        bus: BusConnector,
        audio_context: AudioContext,
        mixer: SpeakerMixer,
    ) {
        this.bus = bus
        this.audio_context = audio_context

        // The worklet function body is extracted as a string and loaded as a Blob URL.
        // It runs in a separate AudioWorklet scope, not in the main thread.
        function worklet() {
            const RENDER_QUANTUM = 128
            const MINIMUM_BUFFER_SIZE = 2 * RENDER_QUANTUM
            const QUEUE_RESERVE = 1024

            function sinc(x: number): number {
                if (x === 0) return 1
                x *= Math.PI
                return Math.sin(x) / x
            }

            var EMPTY_BUFFER: [Float32Array, Float32Array] = [
                new Float32Array(MINIMUM_BUFFER_SIZE),
                new Float32Array(MINIMUM_BUFFER_SIZE),
            ]

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            function DACProcessor(this: any) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                var self = Reflect.construct(
                    AudioWorkletProcessor,
                    [],
                    DACProcessor,
                )

                self.kernel_size = 3

                self.queue_data = new Array(1024)
                self.queue_start = 0
                self.queue_end = 0
                self.queue_length = 0
                self.queue_size = self.queue_data.length
                self.queued_samples = 0

                self.source_buffer_previous = EMPTY_BUFFER
                self.source_buffer_current = EMPTY_BUFFER

                self.source_samples_per_destination = 1.0

                self.source_block_start = 0

                self.source_time = 0.0

                self.source_offset = 0

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                self.port.onmessage = (event: any) => {
                    switch (event.data.type) {
                        case 'queue':
                            self.queue_push(event.data.value)
                            break
                        case 'sampling-rate':
                            self.source_samples_per_destination =
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                event.data.value /
                                (globalThis as any).sampleRate
                            break
                    }
                }

                return self
            }

            Reflect.setPrototypeOf(
                DACProcessor.prototype,
                AudioWorkletProcessor.prototype,
            )
            Reflect.setPrototypeOf(DACProcessor, AudioWorkletProcessor)

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype['process'] = DACProcessor.prototype.process =
                function (
                    this: any,
                    _inputs: any,
                    outputs: any,
                    _parameters: any,
                ) {
                    for (var i = 0; i < outputs[0][0].length; i++) {
                        var sum0 = 0
                        var sum1 = 0

                        var start = this.source_offset - this.kernel_size + 1
                        var end = this.source_offset + this.kernel_size

                        for (var j = start; j <= end; j++) {
                            var convolute_index = this.source_block_start + j
                            sum0 +=
                                this.get_sample(convolute_index, 0) *
                                this.kernel(this.source_time - j)
                            sum1 +=
                                this.get_sample(convolute_index, 1) *
                                this.kernel(this.source_time - j)
                        }

                        if (isNaN(sum0) || isNaN(sum1)) {
                            sum0 = sum1 = 0
                            this.dbg_log('ERROR: NaN values! Ignoring for now.')
                        }

                        outputs[0][0][i] = sum0
                        outputs[0][1][i] = sum1

                        this.source_time += this.source_samples_per_destination
                        this.source_offset = Math.floor(this.source_time)
                    }

                    var samples_needed_per_block = this.source_offset
                    samples_needed_per_block += this.kernel_size + 2

                    this.source_time -= this.source_offset
                    this.source_block_start += this.source_offset
                    this.source_offset = 0

                    this.ensure_enough_data(samples_needed_per_block)

                    return true
                }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.kernel = function (this: any, x: number) {
                return sinc(x) * sinc(x / this.kernel_size)
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.get_sample = function (
                this: any,
                index: number,
                channel: number,
            ) {
                if (index < 0) {
                    index += this.source_buffer_previous[0].length
                    return this.source_buffer_previous[channel][index]
                }
                return this.source_buffer_current[channel][index]
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.ensure_enough_data = function (
                this: any,
                needed: number,
            ) {
                var current_length = this.source_buffer_current[0].length
                var remaining = current_length - this.source_block_start

                if (remaining < needed) {
                    this.prepare_next_buffer()
                    this.source_block_start -= current_length
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.prepare_next_buffer = function (this: any) {
                if (
                    this.queued_samples < MINIMUM_BUFFER_SIZE &&
                    this.queue_length
                ) {
                    this.dbg_log(
                        'Not enough samples - should not happen during midway of playback',
                    )
                }

                this.source_buffer_previous = this.source_buffer_current
                this.source_buffer_current = this.queue_shift()

                var sample_count = this.source_buffer_current[0].length

                if (sample_count < MINIMUM_BUFFER_SIZE) {
                    var queue_pos = this.queue_start
                    var buffer_count = 0

                    while (
                        sample_count < MINIMUM_BUFFER_SIZE &&
                        buffer_count < this.queue_length
                    ) {
                        sample_count += this.queue_data[queue_pos][0].length

                        queue_pos = (queue_pos + 1) & (this.queue_size - 1)
                        buffer_count++
                    }

                    var new_big_buffer_size = Math.max(
                        sample_count,
                        MINIMUM_BUFFER_SIZE,
                    )
                    var new_big_buffer = [
                        new Float32Array(new_big_buffer_size),
                        new Float32Array(new_big_buffer_size),
                    ]

                    new_big_buffer[0].set(this.source_buffer_current[0])
                    new_big_buffer[1].set(this.source_buffer_current[1])
                    var new_big_buffer_pos =
                        this.source_buffer_current[0].length

                    for (var i = 0; i < buffer_count; i++) {
                        var small_buffer = this.queue_shift()
                        new_big_buffer[0].set(
                            small_buffer[0],
                            new_big_buffer_pos,
                        )
                        new_big_buffer[1].set(
                            small_buffer[1],
                            new_big_buffer_pos,
                        )
                        new_big_buffer_pos += small_buffer[0].length
                    }

                    this.source_buffer_current = new_big_buffer
                }

                this.pump()
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.pump = function (this: any) {
                if (
                    this.queued_samples / this.source_samples_per_destination <
                    QUEUE_RESERVE
                ) {
                    this.port.postMessage({
                        type: 'pump',
                    })
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.queue_push = function (
                this: any,
                item: [Float32Array, Float32Array],
            ) {
                if (this.queue_length < this.queue_size) {
                    this.queue_data[this.queue_end] = item
                    this.queue_end =
                        (this.queue_end + 1) & (this.queue_size - 1)
                    this.queue_length++

                    this.queued_samples += item[0].length

                    this.pump()
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.queue_shift = function (this: any) {
                if (!this.queue_length) {
                    return EMPTY_BUFFER
                }

                var item = this.queue_data[this.queue_start]

                this.queue_data[this.queue_start] = null
                this.queue_start =
                    (this.queue_start + 1) & (this.queue_size - 1)
                this.queue_length--

                this.queued_samples -= item[0].length

                return item
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            DACProcessor.prototype.dbg_log = function (
                this: any,
                message: string,
            ) {
                if (DEBUG) {
                    this.port.postMessage({
                        type: 'debug-log',
                        value: message,
                    })
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(globalThis as any).registerProcessor(
                'dac-processor',
                DACProcessor,
            )
        }

        var worklet_string = worklet.toString()

        var worklet_code_start = worklet_string.indexOf('{') + 1
        var worklet_code_end = worklet_string.lastIndexOf('}')
        var worklet_code = worklet_string.substring(
            worklet_code_start,
            worklet_code_end,
        )

        if (DEBUG) {
            worklet_code = 'var DEBUG = true;\n' + worklet_code
        }

        var worklet_blob = new Blob([worklet_code], {
            type: 'application/javascript',
        })
        var worklet_url = URL.createObjectURL(worklet_blob)

        this.node_output = this.audio_context.createGain()

        this.audio_context.audioWorklet.addModule(worklet_url).then(() => {
            URL.revokeObjectURL(worklet_url)

            this.node_processor = new AudioWorkletNode(
                this.audio_context,
                'dac-processor',
                {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                    parameterData: {},
                    processorOptions: {},
                },
            )

            this.node_processor.port.postMessage({
                type: 'sampling-rate',
                value: this.sampling_rate,
            })

            this.node_processor.port.onmessage = (event) => {
                switch (event.data.type) {
                    case 'pump':
                        this.pump()
                        break
                    case 'debug-log':
                        dbg_log(
                            'SpeakerWorkletDAC - Worklet: ' + event.data.value,
                        )
                        break
                }
            }

            this.node_processor.connect(this.node_output)
        })

        this.mixer_connection = mixer.add_source(
            this.node_output,
            MIXER_SRC_DAC,
        )
        this.mixer_connection.set_gain_hidden(3)

        bus.register(
            'dac-send-data',
            function (
                this: SpeakerWorkletDAC,
                data: [Float32Array, Float32Array],
            ) {
                this.queue(data)
            },
            this,
        )

        bus.register(
            'dac-enable',
            function (this: SpeakerWorkletDAC) {
                this.enabled = true
            },
            this,
        )

        bus.register(
            'dac-disable',
            function (this: SpeakerWorkletDAC) {
                this.enabled = false
            },
            this,
        )

        bus.register(
            'dac-tell-sampling-rate',
            function (this: SpeakerWorkletDAC, rate: number) {
                dbg_assert(rate > 0, 'Sampling rate should be nonzero')
                this.sampling_rate = rate

                if (!this.node_processor) {
                    return
                }

                this.node_processor.port.postMessage({
                    type: 'sampling-rate',
                    value: rate,
                })
            },
            this,
        )

        if (DEBUG) {
            this.debugger = new SpeakerDACDebugger(
                this.audio_context,
                this.node_output,
            )
        }
    }

    queue(data: [Float32Array, Float32Array]): void {
        if (!this.node_processor) {
            return
        }

        if (DEBUG) {
            this.debugger!.push_queued_data(data)
        }

        this.node_processor.port.postMessage(
            {
                type: 'queue',
                value: data,
            },
            [data[0].buffer, data[1].buffer],
        )
    }

    pump(): void {
        if (!this.enabled) {
            return
        }
        this.bus.send('dac-request-data')
    }
}

class SpeakerBufferSourceDAC {
    bus: BusConnector
    audio_context: AudioContext
    enabled = false
    sampling_rate = 22050
    buffered_time = 0
    rate_ratio = 1
    node_lowpass: BiquadFilterNode
    node_output: BiquadFilterNode
    node_processor: AudioWorkletNode | null = null
    mixer_connection: SpeakerMixerSource
    debugger: SpeakerDACDebugger | undefined

    constructor(
        bus: BusConnector,
        audio_context: AudioContext,
        mixer: SpeakerMixer,
    ) {
        this.bus = bus
        this.audio_context = audio_context

        this.node_lowpass = this.audio_context.createBiquadFilter()
        this.node_lowpass.type = 'lowpass'

        this.node_output = this.node_lowpass

        this.mixer_connection = mixer.add_source(
            this.node_output,
            MIXER_SRC_DAC,
        )
        this.mixer_connection.set_gain_hidden(3)

        bus.register(
            'dac-send-data',
            function (
                this: SpeakerBufferSourceDAC,
                data: [Float32Array, Float32Array],
            ) {
                this.queue(data)
            },
            this,
        )

        bus.register(
            'dac-enable',
            function (this: SpeakerBufferSourceDAC) {
                this.enabled = true
                this.pump()
            },
            this,
        )

        bus.register(
            'dac-disable',
            function (this: SpeakerBufferSourceDAC) {
                this.enabled = false
            },
            this,
        )

        bus.register(
            'dac-tell-sampling-rate',
            function (this: SpeakerBufferSourceDAC, rate: number) {
                dbg_assert(rate > 0, 'Sampling rate should be nonzero')
                this.sampling_rate = rate
                this.rate_ratio = Math.ceil(
                    AUDIOBUFFER_MINIMUM_SAMPLING_RATE / rate,
                )
                this.node_lowpass.frequency.setValueAtTime(
                    rate / 2,
                    this.audio_context.currentTime,
                )
            },
            this,
        )

        if (DEBUG) {
            this.debugger = new SpeakerDACDebugger(
                this.audio_context,
                this.node_output,
            )
        }
    }

    queue(data: [Float32Array, Float32Array]): void {
        if (DEBUG) {
            this.debugger!.push_queued_data(data)
        }

        var sample_count = data[0].length
        var block_duration = sample_count / this.sampling_rate

        var buffer: AudioBuffer
        if (this.rate_ratio > 1) {
            var new_sample_count = sample_count * this.rate_ratio
            var new_sampling_rate = this.sampling_rate * this.rate_ratio
            buffer = this.audio_context.createBuffer(
                2,
                new_sample_count,
                new_sampling_rate,
            )
            var buffer_data0 = buffer.getChannelData(0)
            var buffer_data1 = buffer.getChannelData(1)

            var buffer_index = 0
            for (var i = 0; i < sample_count; i++) {
                for (var j = 0; j < this.rate_ratio; j++, buffer_index++) {
                    buffer_data0[buffer_index] = data[0][i]
                    buffer_data1[buffer_index] = data[1][i]
                }
            }
        } else {
            buffer = this.audio_context.createBuffer(
                2,
                sample_count,
                this.sampling_rate,
            )
            if (buffer.copyToChannel) {
                buffer.copyToChannel(new Float32Array(data[0]), 0)
                buffer.copyToChannel(new Float32Array(data[1]), 1)
            } else {
                buffer.getChannelData(0).set(data[0])
                buffer.getChannelData(1).set(data[1])
            }
        }

        var source = this.audio_context.createBufferSource()
        source.buffer = buffer
        source.connect(this.node_lowpass)
        source.addEventListener('ended', this.pump.bind(this))

        var current_time = this.audio_context.currentTime

        if (this.buffered_time < current_time) {
            dbg_log(
                "Speaker DAC - Creating/Recreating reserve - shouldn't occur frequently during playback",
            )

            this.buffered_time = current_time
            var target_silence_duration = DAC_QUEUE_RESERVE - block_duration
            var current_silence_duration = 0
            while (current_silence_duration <= target_silence_duration) {
                current_silence_duration += block_duration
                this.buffered_time += block_duration
                setTimeout(() => this.pump(), current_silence_duration * 1000)
            }
        }

        source.start(this.buffered_time)
        this.buffered_time += block_duration

        setTimeout(() => this.pump(), 0)
    }

    pump(): void {
        if (!this.enabled) {
            return
        }
        if (
            this.buffered_time - this.audio_context.currentTime >
            DAC_QUEUE_RESERVE
        ) {
            return
        }
        this.bus.send('dac-request-data')
    }
}

class SpeakerDACDebugger {
    audio_context: AudioContext
    node_source: AudioNode
    node_processor: ScriptProcessorNode | null = null
    node_gain: GainNode
    is_active = false
    queued_history: [Float32Array[], Float32Array[]][] = []
    output_history: [Float32Array[], Float32Array[]][] = []
    queued: [Float32Array[], Float32Array[]] = [[], []]
    output: [Float32Array[], Float32Array[]] = [[], []]

    constructor(audio_context: AudioContext, source_node: AudioNode) {
        this.audio_context = audio_context
        this.node_source = source_node

        this.node_gain = this.audio_context.createGain()
        this.node_gain.gain.setValueAtTime(0, this.audio_context.currentTime)

        this.node_gain.connect(this.audio_context.destination)
    }

    start(duration_ms: number): void {
        this.is_active = true
        this.queued = [[], []]
        this.output = [[], []]
        this.queued_history.push(this.queued)
        this.output_history.push(this.output)

        this.node_processor = this.audio_context.createScriptProcessor(
            1024,
            2,
            2,
        )
        this.node_processor.onaudioprocess = (event) => {
            this.output[0].push(event.inputBuffer.getChannelData(0).slice())
            this.output[1].push(event.inputBuffer.getChannelData(1).slice())
        }

        this.node_source.connect(this.node_processor)
        this.node_processor.connect(this.node_gain)

        setTimeout(() => {
            this.stop()
        }, duration_ms)
    }

    stop(): void {
        this.is_active = false
        if (this.node_processor) {
            this.node_source.disconnect(this.node_processor)
            this.node_processor.disconnect()
            this.node_processor = null
        }
    }

    push_queued_data(data: [Float32Array, Float32Array]): void {
        if (this.is_active) {
            this.queued[0].push(data[0].slice())
            this.queued[1].push(data[1].slice())
        }
    }

    download_txt(history_id: number, channel: number): void {
        var txt = this.output_history[history_id][channel]
            .map((v) => v.join(' '))
            .join(' ')

        dump_file(txt, 'dacdata.txt')
    }

    download_csv(history_id: number): void {
        var buffers = this.output_history[history_id]
        var csv_rows: string[] = []
        for (var buffer_id = 0; buffer_id < buffers[0].length; buffer_id++) {
            for (var i = 0; i < buffers[0][buffer_id].length; i++) {
                csv_rows.push(
                    `${buffers[0][buffer_id][i]},${buffers[1][buffer_id][i]}`,
                )
            }
        }
        dump_file(csv_rows.join('\n'), 'dacdata.csv')
    }
}
