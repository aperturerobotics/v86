import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CYAN_FMT = '\x1b[36m%s\x1b[0m'

export function hex(n: number, pad: number = 0): string {
    let s = n.toString(16).toUpperCase()
    while (s.length < pad) s = '0' + s
    return s
}

export function get_switch_value(arg_switch: string): string | null {
    const argv = process.argv
    const switch_i = argv.indexOf(arg_switch)
    const val_i = switch_i + 1
    if (switch_i > -1 && val_i < argv.length) {
        return argv[switch_i + 1]
    }
    return null
}

export function get_switch_exist(arg_switch: string): boolean {
    return process.argv.includes(arg_switch)
}

export function finalize_table_rust(
    out_dir: string,
    name: string,
    contents: string,
): void {
    const file_path = path.join(out_dir, name)
    fs.writeFileSync(file_path, contents)
    console.log(CYAN_FMT, `[+] Wrote table ${name}.`)
}
