#!/usr/bin/env node

import url from "node:url";
import { V86 } from "../src/main.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Now booting, please stand by ...");

const emulator = new V86({
    bios: { url: __dirname + "/../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../images/linux4.iso" },
    autostart: true,
    net_device: {
        type: "virtio",
        relay_url: "fetch",
    },
});

emulator.add_listener("serial0-output-byte", function(byte: number)
{
    const chr = String.fromCharCode(byte);
    if(chr <= "~")
    {
        process.stdout.write(chr);
    }
});

process.stdin.on("data", function(c: string)
{
    if(c === "\u0003")
    {
        // ctrl c
        emulator.destroy();
        process.stdin.pause();
    }
    else
    {
        emulator.serial0_send(c);
    }
});
