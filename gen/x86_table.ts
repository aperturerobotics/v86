// http://ref.x86asm.net/coder32.html

export interface X86Encoding {
    opcode: number
    os?: number
    e?: number
    fixed_g?: number
    custom?: number
    custom_modrm_resolve?: number
    custom_sti?: number
    prefix?: number
    block_boundary?: number
    no_block_boundary_in_interpreted?: number
    no_next_instruction?: number
    absolute_jump?: number
    jump_offset_imm?: number
    conditional_jump?: number
    imm8?: number
    imm8s?: number
    imm16?: number
    imm1632?: number
    imm32?: number
    immaddr?: number
    extra_imm8?: number
    extra_imm16?: number
    mask_flags?: number
    skip?: number
    skip_mem?: number
    skip_reg?: number
    is_string?: number
    is_fpu?: number
    task_switch_test?: number
    sse?: number
    reg_ud?: number
    mem_ud?: number
    ignore_mod?: number
}

const zf = 1 << 6
const of = 1 << 11
const cf = 1 << 0
const af = 1 << 4
const pf = 1 << 2
const sf = 1 << 7

// Test intel-specific behaviour
// Setting this to true can make some tests fail
const TESTS_ASSUME_INTEL = false

// === Types of instructions
//
// create entry | check for compiled code | instruction
// -------------+-------------------------+-----------------------------------------------------------
//      1       |        optional         | pop ds (may change cpu state)
//              |                         | trigger_ud, div (exception that doesn't generate conditional return from BB)
//              |                         | port io, popf, sti (may call interrupt or continue at next instruction)
//              |                         | hlt
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call [eax], jmp [eax], int, iret, ret, jmpf, callf, sysenter, sysexit
//              |                         | Special case: normal instruction with fallthough to next page
//              |                         | Special case: after execution of compiled code
//              |                         | -> may create redundant entry points depending on last instruction?
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            0            | rep movs, rep lods, rep stos, rep cmps, rep scas
//              |                         | -> Executed as follows:
//              |                         |   - Upto including the first call in compiled mode
//              |                         |   - Back to main loop and repeated in interpreted mode (as entry point is after instruction, not on)
//              |                         |   - When finished entry pointer *after* instruction is hit and execution continues in compiled mode
// -------------+-------------------------+-----------------------------------------------------------
//      0       |        optional         | jmp foo, jnz foo
//              |                         | (foo is in the same page as the instruction)
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call foo
//              |                         | (foo is in the same page as the instruction)
//              |                         | -> The entry point is not created for jumps within
//              |                         |    this page, but speculatively for calls from
//              |                         |    other pages to the function in this page
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call foo, jmp foo, jnz foo
//              |                         | (foo is in a different page than the instruction)

// e: a modrm byte follows the operand
// os: the instruction behaves differently depending on the operand size
// fixed_g: the reg field of the modrm byte selects an instruction
// skip: skip automatically generated tests (nasmtests)
// mask_flags: flags bits to mask in generated tests
// prefix: is a prefix instruction
// imm8, imm8s, imm16, imm1632, immaddr, extra_imm8, extra_imm16: one or two immediate bytes follows the instruction
// custom: will callback jit to generate custom code
// block_boundary: may change eip in a way not handled by the jit
// no_next_instruction: jit will stop analysing after instruction (e.g., unconditional jump, ret)
const encodings: X86Encoding[] = [
    { opcode: 0x06, os: 1, custom: 1 },
    { opcode: 0x07, os: 1, skip: 1, block_boundary: 1 }, // pop es: block_boundary since it uses non-raising cpu exceptions
    { opcode: 0x0e, os: 1, custom: 1 },
    { opcode: 0x0f, os: 1, prefix: 1 },
    { opcode: 0x16, os: 1, custom: 1 },
    { opcode: 0x17, block_boundary: 1, os: 1, skip: 1 }, // pop ss
    { opcode: 0x1e, os: 1, custom: 1 },
    { opcode: 0x1f, block_boundary: 1, os: 1, skip: 1 }, // pop ds
    { opcode: 0x26, prefix: 1 },
    { opcode: 0x27, mask_flags: of },
    { opcode: 0x2e, prefix: 1 },
    { opcode: 0x2f, mask_flags: of },
    { opcode: 0x36, prefix: 1 },
    { opcode: 0x37, mask_flags: of | sf | pf | zf },
    { opcode: 0x3e, prefix: 1 },
    { opcode: 0x3f, mask_flags: of | sf | pf | zf },

    { opcode: 0x60, os: 1, block_boundary: 1 }, // pusha
    { opcode: 0x61, os: 1, block_boundary: 1 }, // popa
    { opcode: 0x62, e: 1, skip: 1 },
    { opcode: 0x63, e: 1, block_boundary: 1 }, // arpl
    { opcode: 0x64, prefix: 1 },
    { opcode: 0x65, prefix: 1 },
    { opcode: 0x66, prefix: 1 },
    { opcode: 0x67, prefix: 1 },

    { opcode: 0x68, custom: 1, os: 1, imm1632: 1 },
    {
        opcode: 0x69,
        os: 1,
        e: 1,
        custom: 1,
        imm1632: 1,
        mask_flags: TESTS_ASSUME_INTEL ? af : sf | zf | af | pf,
    },
    { opcode: 0x6a, custom: 1, os: 1, imm8s: 1 },
    {
        opcode: 0x6b,
        os: 1,
        e: 1,
        custom: 1,
        imm8s: 1,
        mask_flags: TESTS_ASSUME_INTEL ? af : sf | zf | af | pf,
    },

    { opcode: 0x6c, block_boundary: 1, custom: 1, is_string: 1, skip: 1 }, // ins
    { opcode: 0xf26c, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0xf36c, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    {
        opcode: 0x6d,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },
    {
        opcode: 0xf26d,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },
    {
        opcode: 0xf36d,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },

    { opcode: 0x6e, block_boundary: 1, custom: 1, is_string: 1, skip: 1 }, // outs
    { opcode: 0xf26e, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0xf36e, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    {
        opcode: 0x6f,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },
    {
        opcode: 0xf26f,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },
    {
        opcode: 0xf36f,
        block_boundary: 1,
        custom: 1,
        is_string: 1,
        os: 1,
        skip: 1,
    },

    { opcode: 0x84, custom: 1, e: 1 },
    { opcode: 0x85, custom: 1, e: 1, os: 1 },
    { opcode: 0x86, custom: 1, e: 1 },
    { opcode: 0x87, custom: 1, os: 1, e: 1 },
    { opcode: 0x88, custom: 1, e: 1 },
    { opcode: 0x89, custom: 1, os: 1, e: 1 },
    { opcode: 0x8a, custom: 1, e: 1 },
    { opcode: 0x8b, custom: 1, os: 1, e: 1 },

    { opcode: 0x8c, os: 1, e: 1, custom: 1, skip: 1 }, // mov reg, sreg
    {
        opcode: 0x8d,
        reg_ud: 1,
        os: 1,
        e: 1,
        custom_modrm_resolve: 1,
        custom: 1,
    }, // lea
    { opcode: 0x8e, block_boundary: 1, e: 1, skip: 1 }, // mov sreg
    {
        opcode: 0x8f,
        os: 1,
        e: 1,
        fixed_g: 0,
        custom_modrm_resolve: 1,
        custom: 1,
        block_boundary: 1,
    }, // pop r/m

    { opcode: 0x90, custom: 1 },
    { opcode: 0x91, custom: 1, os: 1 },
    { opcode: 0x92, custom: 1, os: 1 },
    { opcode: 0x93, custom: 1, os: 1 },
    { opcode: 0x94, custom: 1, os: 1 },
    { opcode: 0x95, custom: 1, os: 1 },
    { opcode: 0x96, custom: 1, os: 1 },
    { opcode: 0x97, custom: 1, os: 1 },

    { opcode: 0x98, os: 1, custom: 1 },
    { opcode: 0x99, os: 1, custom: 1 },
    {
        opcode: 0x9a,
        os: 1,
        imm1632: 1,
        extra_imm16: 1,
        skip: 1,
        block_boundary: 1,
    }, // callf
    { opcode: 0x9b, block_boundary: 1, skip: 1 }, // fwait: block_boundary since it uses non-raising cpu exceptions
    { opcode: 0x9c, os: 1, custom: 1, skip: 1 }, // pushf
    { opcode: 0x9d, os: 1, custom: 1, skip: 1 }, // popf
    { opcode: 0x9e, custom: 1 },
    { opcode: 0x9f, custom: 1 },

    { opcode: 0xa0, custom: 1, immaddr: 1 },
    { opcode: 0xa1, custom: 1, os: 1, immaddr: 1 },
    { opcode: 0xa2, custom: 1, immaddr: 1 },
    { opcode: 0xa3, custom: 1, os: 1, immaddr: 1 },

    // string instructions aren't jumps, but they modify eip due to how they're implemented
    { opcode: 0xa4, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xf2a4, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf3a4, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xa5, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf2a5, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf3a5, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xa6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf2a6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf3a6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xa7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf2a7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf3a7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xa8, custom: 1, imm8: 1 },
    { opcode: 0xa9, custom: 1, os: 1, imm1632: 1 },

    { opcode: 0xaa, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xf2aa, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf3aa, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xab, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf2ab, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf3ab, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xac, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xf2ac, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf3ac, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xad, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf2ad, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf3ad, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xae, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xf2ae, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xf3ae, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xaf, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf2af, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xf3af, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    {
        opcode: 0xc2,
        custom: 1,
        block_boundary: 1,
        no_next_instruction: 1,
        os: 1,
        absolute_jump: 1,
        imm16: 1,
        skip: 1,
    }, // ret
    {
        opcode: 0xc3,
        custom: 1,
        block_boundary: 1,
        no_next_instruction: 1,
        os: 1,
        absolute_jump: 1,
        skip: 1,
    },

    { opcode: 0xc4, block_boundary: 1, os: 1, e: 1, skip: 1 }, // les
    { opcode: 0xc5, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lds

    { opcode: 0xc6, custom: 1, e: 1, fixed_g: 0, imm8: 1 },
    { opcode: 0xc7, custom: 1, os: 1, e: 1, fixed_g: 0, imm1632: 1 },

    // XXX: Temporary block boundary
    { opcode: 0xc8, os: 1, imm16: 1, extra_imm8: 1, block_boundary: 1 }, // enter
    { opcode: 0xc9, custom: 1, os: 1, skip: 1 }, // leave

    {
        opcode: 0xca,
        block_boundary: 1,
        no_next_instruction: 1,
        os: 1,
        imm16: 1,
        skip: 1,
    }, // retf
    { opcode: 0xcb, block_boundary: 1, no_next_instruction: 1, os: 1, skip: 1 },
    { opcode: 0xcc, block_boundary: 1, skip: 1 }, // int
    { opcode: 0xcd, block_boundary: 1, skip: 1, imm8: 1 },
    { opcode: 0xce, block_boundary: 1, skip: 1 },
    { opcode: 0xcf, block_boundary: 1, no_next_instruction: 1, os: 1, skip: 1 }, // iret

    { opcode: 0xd4, imm8: 1, block_boundary: 1 }, // aam, may trigger #de
    { opcode: 0xd5, imm8: 1, mask_flags: of | cf | af },
    { opcode: 0xd6 },

    { opcode: 0xd7, skip: 1, custom: 1 },

    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xd8,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },

    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip_mem: 1,
    }, // fldenv (mem)
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip: 1,
    }, // fstenv (mem), fprem (reg)
    {
        opcode: 0xd9,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip_reg: 1,
    }, // fprem, fyl2xp1 (precision issues)

    {
        opcode: 0xda,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xda,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },

    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    }, // fisttp (sse3)
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 4,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdb,
        e: 1,
        fixed_g: 7,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
    },

    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdc,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },

    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    }, // fisttp (sse3)
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 4,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip_mem: 1,
    }, // frstor
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
    },
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 6,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip_mem: 1,
    }, // fsave
    {
        opcode: 0xdd,
        e: 1,
        fixed_g: 7,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
        os: 1,
        skip_mem: 1,
    }, // fstsw (denormal flag)

    {
        opcode: 0xde,
        e: 1,
        fixed_g: 0,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xde,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },

    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 0,
        custom: 0,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 1,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    }, // fisttp (sse3)
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 2,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 3,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 4,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
        skip: 1,
    }, // unimplemented: Binary Coded Decimals / fsts (denormal flag)
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 5,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 6,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },
    {
        opcode: 0xdf,
        e: 1,
        fixed_g: 7,
        custom: 1,
        is_fpu: 1,
        task_switch_test: 1,
    },

    // loop, jcxz, etc.
    {
        opcode: 0xe0,
        os: 1,
        imm8s: 1,
        no_block_boundary_in_interpreted: 1,
        skip: 1,
        block_boundary: 1,
        jump_offset_imm: 1,
        custom: 1,
        conditional_jump: 1,
    },
    {
        opcode: 0xe1,
        os: 1,
        imm8s: 1,
        no_block_boundary_in_interpreted: 1,
        skip: 1,
        block_boundary: 1,
        jump_offset_imm: 1,
        custom: 1,
        conditional_jump: 1,
    },
    {
        opcode: 0xe2,
        os: 1,
        imm8s: 1,
        no_block_boundary_in_interpreted: 1,
        skip: 1,
        block_boundary: 1,
        jump_offset_imm: 1,
        custom: 1,
        conditional_jump: 1,
    },
    {
        opcode: 0xe3,
        os: 1,
        imm8s: 1,
        no_block_boundary_in_interpreted: 1,
        skip: 1,
        block_boundary: 1,
        jump_offset_imm: 1,
        custom: 1,
        conditional_jump: 1,
    },

    // port functions aren't jumps, but they may modify eip due to how they are implemented
    { opcode: 0xe4, block_boundary: 1, imm8: 1, skip: 1 }, // in
    { opcode: 0xe5, block_boundary: 1, os: 1, imm8: 1, skip: 1 },
    { opcode: 0xe6, block_boundary: 1, imm8: 1, skip: 1 }, // out
    { opcode: 0xe7, block_boundary: 1, os: 1, imm8: 1, skip: 1 },

    {
        opcode: 0xe8,
        block_boundary: 1,
        jump_offset_imm: 1,
        os: 1,
        imm1632: 1,
        custom: 1,
        skip: 1,
    }, // call
    {
        opcode: 0xe9,
        block_boundary: 1,
        no_block_boundary_in_interpreted: 1,
        jump_offset_imm: 1,
        no_next_instruction: 1,
        os: 1,
        imm1632: 1,
        custom: 1,
        skip: 1,
    },
    {
        opcode: 0xea,
        block_boundary: 1,
        no_next_instruction: 1,
        os: 1,
        imm1632: 1,
        extra_imm16: 1,
        skip: 1,
    }, // jmpf
    {
        opcode: 0xeb,
        block_boundary: 1,
        no_block_boundary_in_interpreted: 1,
        jump_offset_imm: 1,
        no_next_instruction: 1,
        os: 1,
        imm8s: 1,
        custom: 1,
        skip: 1,
    },

    { opcode: 0xec, block_boundary: 1, skip: 1 }, // in
    { opcode: 0xed, block_boundary: 1, os: 1, skip: 1 },
    { opcode: 0xee, block_boundary: 1, skip: 1 }, // out
    { opcode: 0xef, block_boundary: 1, os: 1, skip: 1 },

    { opcode: 0xf0, prefix: 1 },
    { opcode: 0xf1, skip: 1 },
    { opcode: 0xf2, prefix: 1 },
    { opcode: 0xf3, prefix: 1 },
    { opcode: 0xf4, block_boundary: 1, no_next_instruction: 1, skip: 1 }, // hlt
    { opcode: 0xf5 },

    { opcode: 0xf6, e: 1, fixed_g: 0, imm8: 1, custom: 1 },
    { opcode: 0xf6, e: 1, fixed_g: 1, imm8: 1, custom: 1 },
    { opcode: 0xf6, e: 1, fixed_g: 2, custom: 1 },
    { opcode: 0xf6, e: 1, fixed_g: 3, custom: 1 },
    {
        opcode: 0xf6,
        e: 1,
        fixed_g: 4,
        mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf,
    },
    {
        opcode: 0xf6,
        e: 1,
        fixed_g: 5,
        mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf,
    },
    // div/idiv: Not a block boundary, but doesn't use control flow exceptions
    {
        opcode: 0xf6,
        e: 1,
        fixed_g: 6,
        mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf,
        block_boundary: 1,
    },
    {
        opcode: 0xf6,
        e: 1,
        fixed_g: 7,
        mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf,
        block_boundary: 1,
    },

    { opcode: 0xf7, os: 1, e: 1, fixed_g: 0, imm1632: 1, custom: 1 },
    { opcode: 0xf7, os: 1, e: 1, fixed_g: 1, imm1632: 1, custom: 1 },
    { opcode: 0xf7, os: 1, e: 1, fixed_g: 2, custom: 1 },
    { opcode: 0xf7, os: 1, e: 1, fixed_g: 3, custom: 1 },
    {
        opcode: 0xf7,
        os: 1,
        e: 1,
        fixed_g: 4,
        mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf,
        custom: 1,
    },
    {
        opcode: 0xf7,
        os: 1,
        e: 1,
        fixed_g: 5,
        mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf,
        custom: 1,
    },
    {
        opcode: 0xf7,
        os: 1,
        e: 1,
        fixed_g: 6,
        mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf,
        custom: 1,
    },
    {
        opcode: 0xf7,
        os: 1,
        e: 1,
        fixed_g: 7,
        mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf,
        custom: 1,
    },

    { opcode: 0xf8, custom: 1 },
    { opcode: 0xf9, custom: 1 },
    { opcode: 0xfa, custom: 1, skip: 1 },
    // STI: Note: Has special handling in jit in order to call handle_irqs safely
    { opcode: 0xfb, custom: 1, custom_sti: 1, skip: 1 },
    { opcode: 0xfc, custom: 1 },
    { opcode: 0xfd, custom: 1 },

    { opcode: 0xfe, e: 1, fixed_g: 0, custom: 1 },
    { opcode: 0xfe, e: 1, fixed_g: 1, custom: 1 },
    { opcode: 0xff, os: 1, e: 1, fixed_g: 0, custom: 1 },
    { opcode: 0xff, os: 1, e: 1, fixed_g: 1, custom: 1 },
    {
        opcode: 0xff,
        os: 1,
        e: 1,
        fixed_g: 2,
        custom: 1,
        block_boundary: 1,
        absolute_jump: 1,
        skip: 1,
    },
    { opcode: 0xff, os: 1, e: 1, fixed_g: 3, block_boundary: 1, skip: 1 },
    {
        opcode: 0xff,
        os: 1,
        e: 1,
        fixed_g: 4,
        custom: 1,
        block_boundary: 1,
        absolute_jump: 1,
        no_next_instruction: 1,
        skip: 1,
    },
    {
        opcode: 0xff,
        os: 1,
        e: 1,
        fixed_g: 5,
        block_boundary: 1,
        no_next_instruction: 1,
        skip: 1,
    },
    { opcode: 0xff, custom: 1, os: 1, e: 1, fixed_g: 6 },

    { opcode: 0x0f00, fixed_g: 0, e: 1, skip: 1, block_boundary: 1, os: 1 }, // sldt, ...
    { opcode: 0x0f00, fixed_g: 1, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f00, fixed_g: 2, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f00, fixed_g: 3, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f00, fixed_g: 4, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f00, fixed_g: 5, e: 1, skip: 1, block_boundary: 1, os: 1 },

    { opcode: 0x0f01, fixed_g: 0, e: 1, skip: 1, block_boundary: 1, os: 1 }, // sgdt, ...
    { opcode: 0x0f01, fixed_g: 1, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f01, fixed_g: 2, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f01, fixed_g: 3, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f01, fixed_g: 4, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f01, fixed_g: 6, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0f01, fixed_g: 7, e: 1, skip: 1, block_boundary: 1, os: 1 },

    { opcode: 0x0f02, os: 1, e: 1, skip: 1, block_boundary: 1 }, // lar
    { opcode: 0x0f03, os: 1, e: 1, skip: 1, block_boundary: 1 }, // lsl
    { opcode: 0x0f04, skip: 1, block_boundary: 1 },
    { opcode: 0x0f05, skip: 1, block_boundary: 1 },
    { opcode: 0x0f06, skip: 1, block_boundary: 1 }, // clts
    { opcode: 0x0f07, skip: 1, block_boundary: 1 },
    { opcode: 0x0f08, skip: 1, block_boundary: 1 },
    { opcode: 0x0f09, skip: 1, block_boundary: 1 }, // wbinvd
    { opcode: 0x0f0a, skip: 1, block_boundary: 1 },
    // ud2
    // Technically has a next instruction, but Linux uses this for assertions
    // and embeds the assertion message after this instruction, which is likely
    // the most common use case of ud2
    {
        opcode: 0x0f0b,
        skip: 1,
        block_boundary: 1,
        custom: 1,
        no_next_instruction: 1,
    },
    { opcode: 0x0f0c, skip: 1, block_boundary: 1 },
    { opcode: 0x0f0d, skip: 1, block_boundary: 1 },
    { opcode: 0x0f0e, skip: 1, block_boundary: 1 },
    { opcode: 0x0f0f, skip: 1, block_boundary: 1 },

    { opcode: 0x0f18, e: 1, custom: 1 },
    { opcode: 0x0f19, custom: 1, e: 1 },
    { opcode: 0x0f1a, skip: 1, block_boundary: 1 },
    { opcode: 0x0f1b, skip: 1, block_boundary: 1 },
    { opcode: 0x0f1c, custom: 1, e: 1 },
    { opcode: 0x0f1d, custom: 1, e: 1 },
    { opcode: 0x0f1e, custom: 1, e: 1 },
    { opcode: 0x0f1f, custom: 1, e: 1 },

    { opcode: 0x0f20, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov reg, creg
    { opcode: 0x0f21, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov reg, dreg
    { opcode: 0x0f22, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov creg, reg
    { opcode: 0x0f23, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov dreg, reg
    { opcode: 0x0f24, skip: 1, block_boundary: 1 },
    { opcode: 0x0f25, skip: 1, block_boundary: 1 },
    { opcode: 0x0f26, skip: 1, block_boundary: 1 },
    { opcode: 0x0f27, skip: 1, block_boundary: 1 },

    { opcode: 0x0f30, skip: 1, block_boundary: 1 }, // wrmsr
    { opcode: 0x0f31, skip: 1, custom: 1 }, // rdtsc
    { opcode: 0x0f32, skip: 1, block_boundary: 1 }, // rdmsr
    { opcode: 0x0f33, skip: 1, block_boundary: 1 }, // rdpmc
    { opcode: 0x0f34, skip: 1, block_boundary: 1, no_next_instruction: 1 }, // sysenter
    { opcode: 0x0f35, skip: 1, block_boundary: 1, no_next_instruction: 1 }, // sysexit

    { opcode: 0x0f36, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0f37, skip: 1, block_boundary: 1 }, // getsec

    // ssse3+
    { opcode: 0x0f38, skip: 1, block_boundary: 1 },
    { opcode: 0x0f39, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3a, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3b, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3c, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3d, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3e, skip: 1, block_boundary: 1 },
    { opcode: 0x0f3f, skip: 1, block_boundary: 1 },

    { opcode: 0x0fa0, os: 1, custom: 1 },
    { opcode: 0x0fa1, os: 1, block_boundary: 1, skip: 1 }, // pop fs: block_boundary since it uses non-raising cpu exceptions

    { opcode: 0x0fa2, skip: 1 },

    { opcode: 0x0fa8, os: 1, custom: 1 },
    { opcode: 0x0fa9, os: 1, block_boundary: 1, skip: 1 }, // pop gs

    { opcode: 0x0fa3, os: 1, e: 1, custom: 1, skip_mem: 1 }, // bt (can also index memory, but not supported by test right now)
    { opcode: 0x0fab, os: 1, e: 1, custom: 1, skip_mem: 1 },
    { opcode: 0x0fb3, os: 1, e: 1, custom: 1, skip_mem: 1 },
    { opcode: 0x0fbb, os: 1, e: 1, custom: 1, skip_mem: 1 },

    { opcode: 0x0fba, os: 1, e: 1, fixed_g: 4, imm8: 1, custom: 1 }, // bt
    { opcode: 0x0fba, os: 1, e: 1, fixed_g: 5, imm8: 1, custom: 1 },
    { opcode: 0x0fba, os: 1, e: 1, fixed_g: 6, imm8: 1, custom: 1 },
    { opcode: 0x0fba, os: 1, e: 1, fixed_g: 7, imm8: 1, custom: 1 },

    {
        opcode: 0x0fbc,
        os: 1,
        e: 1,
        mask_flags: of | sf | af | pf | cf,
        custom: 1,
    }, // bsf
    {
        opcode: 0x0fbd,
        os: 1,
        e: 1,
        mask_flags: of | sf | af | pf | cf,
        custom: 1,
    },

    // note: overflow flag only undefined if shift is > 1
    { opcode: 0x0fa4, os: 1, e: 1, custom: 1, imm8: 1, mask_flags: af | of }, // shld
    { opcode: 0x0fa5, os: 1, e: 1, custom: 1, mask_flags: af | of },
    { opcode: 0x0fac, os: 1, e: 1, custom: 1, imm8: 1, mask_flags: af | of },
    { opcode: 0x0fad, os: 1, e: 1, custom: 1, mask_flags: af | of },

    { opcode: 0x0fa6, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0fa7, skip: 1, block_boundary: 1 }, // ud

    { opcode: 0x0faa, skip: 1 },

    {
        opcode: 0x0fae,
        e: 1,
        fixed_g: 0,
        reg_ud: 1,
        task_switch_test: 1,
        skip: 1,
        block_boundary: 1,
    }, // fxsave
    {
        opcode: 0x0fae,
        e: 1,
        fixed_g: 1,
        reg_ud: 1,
        task_switch_test: 1,
        skip: 1,
        block_boundary: 1,
    }, // fxrstor
    {
        opcode: 0x0fae,
        e: 1,
        fixed_g: 2,
        reg_ud: 1,
        sse: 1,
        skip: 1,
        block_boundary: 1,
    }, // ldmxcsr
    {
        opcode: 0x0fae,
        e: 1,
        fixed_g: 3,
        reg_ud: 1,
        sse: 1,
        skip: 1,
        block_boundary: 1,
    }, // stmxcsr

    { opcode: 0x0fae, e: 1, fixed_g: 4, reg_ud: 1, skip: 1, block_boundary: 1 }, // xsave (mem, not implemented)
    { opcode: 0x0fae, e: 1, fixed_g: 5, skip: 1, custom: 1 }, // lfence (reg, only 0), xrstor (mem, not implemented)
    { opcode: 0x0fae, e: 1, fixed_g: 6, skip: 1, block_boundary: 1 }, // mfence (reg, only 0), xsaveopt (mem, not implemented)
    { opcode: 0x0fae, e: 1, fixed_g: 7, skip: 1, block_boundary: 1 }, // sfence (reg, only 0), clflush (mem)

    {
        opcode: 0x0faf,
        os: 1,
        e: 1,
        mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf,
        custom: 1,
    }, // imul

    { opcode: 0x0fb0, e: 1 }, // cmxchg
    { opcode: 0x0fb1, os: 1, e: 1, custom: 1 },
    { opcode: 0x0fc7, e: 1, fixed_g: 1, os: 1, reg_ud: 1, custom: 1 }, // cmpxchg8b (memory)
    { opcode: 0x0fc7, e: 1, fixed_g: 6, os: 1, mem_ud: 1, skip: 1 }, // rdrand

    { opcode: 0x0fb2, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lss
    { opcode: 0x0fb4, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lfs
    { opcode: 0x0fb5, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lgs

    { opcode: 0x0fb6, os: 1, e: 1, custom: 1 }, // movzx
    { opcode: 0x0fb7, os: 1, e: 1, custom: 1 },

    { opcode: 0xf30fb8, os: 1, e: 1, custom: 1 }, // popcnt
    { opcode: 0x0fb8, os: 1, e: 1, block_boundary: 1 }, // ud

    { opcode: 0x0fb9, block_boundary: 1 }, // ud2

    { opcode: 0x0fbe, os: 1, e: 1, custom: 1 }, // movsx
    { opcode: 0x0fbf, os: 1, e: 1, custom: 1 },

    { opcode: 0x0fc0, e: 1 }, // xadd
    { opcode: 0x0fc1, os: 1, e: 1, custom: 1 },

    { opcode: 0x0fc8, custom: 1 }, // bswap
    { opcode: 0x0fc9, custom: 1 },
    { opcode: 0x0fca, custom: 1 },
    { opcode: 0x0fcb, custom: 1 },
    { opcode: 0x0fcc, custom: 1 },
    { opcode: 0x0fcd, custom: 1 },
    { opcode: 0x0fce, custom: 1 },
    { opcode: 0x0fcf, custom: 1 },

    // mmx, sse

    { sse: 1, opcode: 0x0f10, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f10, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f10, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f10, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f11, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f11, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f11, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f11, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f12, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f12, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f12, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xf30f12, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x0f13, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f13, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f14, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f14, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f15, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f15, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f16, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f16, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f16, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x0f17, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f17, reg_ud: 1, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f28, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f28, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f29, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f29, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f2a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f2a, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f2a, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f2a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f2b, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f2b, reg_ud: 1, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f2c, e: 1 },
    { sse: 1, opcode: 0x660f2c, e: 1 },
    { sse: 1, opcode: 0xf20f2c, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f2c, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f2d, e: 1 },
    { sse: 1, opcode: 0x660f2d, e: 1 },
    { sse: 1, opcode: 0xf20f2d, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f2d, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f2e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f2e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f2f, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f2f, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f50, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x660f50, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x0f51, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f51, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f51, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f51, e: 1, custom: 1 },

    // approximation of 1/sqrt(x). Skipped because our approximation doesn't match intel's
    { sse: 1, opcode: 0x0f52, e: 1, skip: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f52, e: 1, skip: 1, custom: 1 },

    // reciprocal: approximation of 1/x. Skipped because our approximation doesn't match intel's
    { sse: 1, opcode: 0x0f53, e: 1, skip: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f53, e: 1, skip: 1, custom: 1 },

    { sse: 1, opcode: 0x0f54, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f54, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f55, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f55, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f56, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f56, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f57, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f57, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f58, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f58, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f58, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f58, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f59, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f59, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f59, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f59, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f5a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5a, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f5a, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f5a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f5b, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5b, e: 1, custom: 1 },
    // no F2 variant
    { sse: 1, opcode: 0xf30f5b, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f5c, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5c, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f5c, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f5c, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f5d, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5d, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f5d, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f5d, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f5e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5e, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f5e, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f5e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f5f, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f5f, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f5f, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f5f, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660f60, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f60, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f61, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f61, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f62, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f62, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f63, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f63, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f64, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f64, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f65, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f65, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f66, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f66, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f67, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f67, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660f68, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f68, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f69, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f69, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f6a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6a, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f6b, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6b, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f6c, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6c, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x660f6d, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6d, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x660f6e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6e, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f6f, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f6f, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f6f, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0f70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660f70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xf20f70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f70, e: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0f71, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f71,
        e: 1,
        fixed_g: 2,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    { sse: 1, opcode: 0x0f71, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f71,
        e: 1,
        fixed_g: 4,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    { sse: 1, opcode: 0x0f71, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f71,
        e: 1,
        fixed_g: 6,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },

    { sse: 1, opcode: 0x0f72, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f72,
        e: 1,
        fixed_g: 2,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    { sse: 1, opcode: 0x0f72, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f72,
        e: 1,
        fixed_g: 4,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    { sse: 1, opcode: 0x0f72, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f72,
        e: 1,
        fixed_g: 6,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },

    { sse: 1, opcode: 0x0f73, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f73,
        e: 1,
        fixed_g: 2,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    {
        sse: 1,
        opcode: 0x660f73,
        e: 1,
        fixed_g: 3,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    { sse: 1, opcode: 0x0f73, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    {
        sse: 1,
        opcode: 0x660f73,
        e: 1,
        fixed_g: 6,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },
    {
        sse: 1,
        opcode: 0x660f73,
        e: 1,
        fixed_g: 7,
        imm8: 1,
        mem_ud: 1,
        custom: 1,
    },

    { sse: 1, opcode: 0x0f74, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f74, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f75, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f75, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f76, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f76, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f77, skip: 1 }, // emms (skip as it breaks gdb printing of float registers)

    // vmx instructions
    { opcode: 0x0f78, skip: 1, block_boundary: 1 },
    { opcode: 0x0f79, skip: 1, block_boundary: 1 },

    { opcode: 0x0f7a, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0f7b, skip: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x660f7c, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xf20f7c, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x660f7d, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xf20f7d, e: 1, custom: 1 }, // sse3

    { opcode: 0x0f7c, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0f7d, skip: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x0f7e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f7e, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f7e, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0f7f, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660f7f, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30f7f, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0fc2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660fc2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xf20fc2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xf30fc2, e: 1, imm8: 1, custom: 1 },

    { opcode: 0x0fc3, e: 1, custom: 1, reg_ud: 1 }, // movnti: Uses normal registers, hence not marked as sse

    { sse: 1, opcode: 0x0fc4, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660fc4, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x0fc5, e: 1, mem_ud: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660fc5, e: 1, mem_ud: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0fc6, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660fc6, e: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0fd0, skip: 1, block_boundary: 1 }, // sse3

    { sse: 1, opcode: 0x0fd1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fd2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fd3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fd4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fd5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd5, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660fd6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20fd6, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0xf30fd6, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x0fd6, e: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x0fd7, e: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd7, e: 1, mem_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0fd8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fd9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fd9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fda, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fda, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fdb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fdb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fdc, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fdc, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fdd, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fdd, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fde, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fde, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fdf, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fdf, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0fe0, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe0, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe5, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660fe6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf20fe6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xf30fe6, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe6, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x0fe7, e: 1, reg_ud: 1 },
    { sse: 1, opcode: 0x660fe7, e: 1, reg_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0fe8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fe9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fe9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fea, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fea, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0feb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660feb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fec, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fec, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fed, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fed, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fee, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fee, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0fef, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660fef, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0ff0, skip: 1, block_boundary: 1 }, // sse3

    { sse: 1, opcode: 0x0ff1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff6, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff6, e: 1, custom: 1 },
    // maskmovq (0FF7), maskmovdqu (660FF7) tested manually
    // Generated tests don't setup EDI as required (yet)
    { sse: 1, opcode: 0x0ff7, mem_ud: 1, e: 1, custom: 1, skip: 1 },
    { sse: 1, opcode: 0x660ff7, mem_ud: 1, e: 1, custom: 1, skip: 1 },

    { sse: 1, opcode: 0x0ff8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ff9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ff9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ffa, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ffa, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ffb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ffb, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ffc, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ffc, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ffd, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ffd, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0ffe, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660ffe, e: 1, custom: 1 },

    { opcode: 0x0fff, block_boundary: 1 }, // ud
]

for (let i = 0; i < 8; i++) {
    encodings.push.apply(encodings, [
        { opcode: 0x00 | (i << 3), custom: 1, e: 1 },
        { opcode: 0x01 | (i << 3), custom: 1, os: 1, e: 1 },
        { opcode: 0x02 | (i << 3), custom: 1, e: 1 },
        { opcode: 0x03 | (i << 3), custom: 1, os: 1, e: 1 },
        { opcode: 0x04 | (i << 3), custom: 1, imm8: 1 },
        { opcode: 0x05 | (i << 3), custom: 1, os: 1, imm1632: 1 },

        { opcode: 0x40 | i, os: 1, custom: 1 },
        { opcode: 0x48 | i, os: 1, custom: 1 },

        { opcode: 0x50 | i, custom: 1, os: 1 },
        { opcode: 0x58 | i, custom: 1, os: 1 },

        {
            opcode: 0x70 | i,
            block_boundary: 1,
            no_block_boundary_in_interpreted: 1,
            jump_offset_imm: 1,
            conditional_jump: 1,
            os: 1,
            imm8s: 1,
            custom: 1,
            skip: 1,
        },
        {
            opcode: 0x78 | i,
            block_boundary: 1,
            no_block_boundary_in_interpreted: 1,
            jump_offset_imm: 1,
            conditional_jump: 1,
            os: 1,
            imm8s: 1,
            custom: 1,
            skip: 1,
        },

        { opcode: 0x80, e: 1, fixed_g: i, imm8: 1, custom: 1 },
        { opcode: 0x81, os: 1, e: 1, fixed_g: i, imm1632: 1, custom: 1 },
        { opcode: 0x82, e: 1, fixed_g: i, imm8: 1, custom: 1 },
        { opcode: 0x83, os: 1, e: 1, fixed_g: i, imm8s: 1, custom: 1 },

        { opcode: 0xb0 | i, custom: 1, imm8: 1 },
        { opcode: 0xb8 | i, custom: 1, os: 1, imm1632: 1 },

        // note: overflow flag only undefined if shift is > 1
        // note: the adjust flag is undefined for shifts > 0 and unaffected by rotates
        {
            opcode: 0xc0,
            e: 1,
            fixed_g: i,
            imm8: 1,
            mask_flags: of | af,
            custom: 1,
        },
        {
            opcode: 0xc1,
            os: 1,
            e: 1,
            fixed_g: i,
            imm8: 1,
            mask_flags: of | af,
            custom: 1,
        },
        { opcode: 0xd0, e: 1, fixed_g: i, mask_flags: af, custom: 1 },
        { opcode: 0xd1, os: 1, e: 1, fixed_g: i, mask_flags: af, custom: 1 },
        { opcode: 0xd2, e: 1, fixed_g: i, mask_flags: of | af, custom: 1 },
        {
            opcode: 0xd3,
            os: 1,
            e: 1,
            fixed_g: i,
            mask_flags: of | af,
            custom: 1,
        },

        { opcode: 0x0f40 | i, e: 1, os: 1, custom: 1 },
        { opcode: 0x0f48 | i, e: 1, os: 1, custom: 1 },

        {
            opcode: 0x0f80 | i,
            block_boundary: 1,
            no_block_boundary_in_interpreted: 1,
            jump_offset_imm: 1,
            conditional_jump: 1,
            imm1632: 1,
            os: 1,
            custom: 1,
            skip: 1,
        },
        {
            opcode: 0x0f88 | i,
            block_boundary: 1,
            no_block_boundary_in_interpreted: 1,
            jump_offset_imm: 1,
            conditional_jump: 1,
            imm1632: 1,
            os: 1,
            custom: 1,
            skip: 1,
        },

        { opcode: 0x0f90 | i, e: 1, custom: 1 },
        { opcode: 0x0f98 | i, e: 1, custom: 1 },
    ])
}

encodings.sort((e1: X86Encoding, e2: X86Encoding): number => {
    const o1 =
        (e1.opcode & 0xff00) === 0x0f00 ? e1.opcode & 0xffff : e1.opcode & 0xff
    const o2 =
        (e2.opcode & 0xff00) === 0x0f00 ? e2.opcode & 0xffff : e2.opcode & 0xff
    return o1 - o2 || (e1.fixed_g ?? 0) - (e2.fixed_g ?? 0)
})

const result: readonly Readonly<X86Encoding>[] = Object.freeze(
    encodings.map((entry) => Object.freeze(entry)),
)
export default result
