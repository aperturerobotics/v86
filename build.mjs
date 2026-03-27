import { build } from 'esbuild'
import { rmSync, mkdirSync } from 'fs'

const isDebug = process.argv.includes('--debug')

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

const shared = {
    bundle: true,
    sourcemap: true,
    target: 'es2022',
    define: {
        DEBUG: isDebug ? 'true' : 'false',
    },
    external: [
        'perf_hooks',
        'crypto',
        'node:crypto',
        'node:fs/promises',
        './capstone-x86.min.js',
        './libwabt.cjs',
    ],
}

// ESM library output
await build({
    ...shared,
    entryPoints: ['src/main.js'],
    outfile: 'dist/v86.js',
    format: 'esm',
    platform: 'neutral',
})

// Browser bundle (single file, all-inclusive)
await build({
    ...shared,
    entryPoints: ['src/main.js'],
    outfile: 'dist/v86.browser.js',
    format: 'iife',
    globalName: 'V86Starter',
    platform: 'browser',
})

console.log('Build complete')
