// From http://baagoe.com/en/RandomMusings/javascript/
// Johannes Baagoe <baagoe@baagoe.com>, 2010

interface RandInstance {
    int32: () => number
    uint32: () => number
}

function Mash(): (data: number) => number {
    let n = 0xefc8249d

    const mash = function (data: number): number {
        const str = data.toString()
        for (let i = 0; i < str.length; i++) {
            n += str.charCodeAt(i)
            let h = 0.02519603282416938 * n
            n = h >>> 0
            h -= n
            h *= n
            n = h >>> 0
            h -= n
            n += h * 0x100000000 // 2^32
        }
        return (n >>> 0) * 2.3283064365386963e-10 // 2^-32
    }

    return mash
}

// From http://baagoe.com/en/RandomMusings/javascript/
export default function KISS07(...initArgs: number[]): RandInstance {
    return (function (args: number[]) {
        // George Marsaglia, 2007-06-23
        //http://groups.google.com/group/comp.lang.fortran/msg/6edb8ad6ec5421a5
        let x = 123456789
        let y = 362436069
        let z = 21288629
        let w = 14921776
        let c = 0

        if (args.length === 0) {
            args = [+new Date()]
        }
        const mash = Mash()
        for (let i = 0; i < args.length; i++) {
            x ^= mash(args[i]) * 0x100000000 // 2^32
            y ^= mash(args[i]) * 0x100000000
            z ^= mash(args[i]) * 0x100000000
            w ^= mash(args[i]) * 0x100000000
        }
        if (y === 0) {
            y = 1
        }
        c ^= z >>> 31
        z &= 0x7fffffff
        if (z % 7559 === 0) {
            z++
        }
        w &= 0x7fffffff
        if (w % 7559 === 0) {
            w++
        }

        const int32 = function (): number {
            x += 545925293
            x >>>= 0

            y ^= y << 13
            y ^= y >>> 17
            y ^= y << 5

            const t = z + w + c
            z = w
            c = t >>> 31
            w = t & 0x7fffffff

            return (x + y + w) | 0
        }
        const uint32 = function (): number {
            x += 545925293
            x >>>= 0

            y ^= y << 13
            y ^= y >>> 17
            y ^= y << 5

            const t = z + w + c
            z = w
            c = t >>> 31
            w = t & 0x7fffffff

            return (x + y + w) >>> 0
        }

        return {
            int32,
            uint32,
        }
    })(initArgs)
}
