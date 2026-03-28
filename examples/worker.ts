// Web Worker script for running V86 emulator in a worker context.
// Uses importScripts (classic worker) and communicates via postMessage.

declare function importScripts(...urls: string[]): void;
declare const self: DedicatedWorkerGlobalScope;

importScripts("../dist/v86.browser.js");

// V86 is loaded globally by importScripts above
 
const V86 = (globalThis as any).V86;

const emulator = new V86({
    wasm_path: "../build/v86.wasm",
    memory_size: 32 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: {
        url: "../bios/seabios.bin",
    },
    vga_bios: {
        url: "../bios/vgabios.bin",
    },
    cdrom: {
        url: "../images/linux4.iso",
    },
    autostart: true,
});


emulator.add_listener("serial0-output-byte", function(byte: number)
{
    const chr = String.fromCharCode(byte);
    self.postMessage(chr);
});

self.onmessage = function(e: MessageEvent)
{
    emulator.serial0_send(e.data);
};
