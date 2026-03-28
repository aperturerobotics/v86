#!/usr/bin/env node

import url from "node:url";
import { V86 } from "../src/main.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

console.log("Use F2 to save the state and F3 to restore.");

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Now booting, please stand by ...");

const emulator = new V86({
    bios: { url: __dirname + "/../bios/seabios.bin" },
    cdrom: { url: __dirname + "/../images/linux4.iso" },
    autostart: true,
});

emulator.add_listener("serial0-output-byte", function(byte: number)
{
    const chr = String.fromCharCode(byte);
    if(chr <= "~")
    {
        process.stdout.write(chr);
    }
});

let state: ArrayBuffer | undefined;

process.stdin.on("data", async function(c: string)
{
    if(c === "\u0003")
    {
        // ctrl c
        emulator.destroy();
        process.stdin.pause();
    }
    else if(c === "\x1b\x4f\x51")
    {
        // f2
        state = await emulator.save_state();
        console.log("--- Saved ---");
    }
    else if(c === "\x1b\x4f\x52")
    {
        // f3
        if(state)
        {
            console.log("--- Restored ---");
            await emulator.restore_state(state);
        }
    }
    else
    {
        emulator.serial0_send(c);
    }
});
