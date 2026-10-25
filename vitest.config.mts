/**
 * Vitest 配置。
 *
 * 【重要 1】这里刻意不从 'vitest/config' 或 'vite' 引入任何东西。
 * 原因：配置文件一旦 import vitest/vite 本身，加载器会走 rolldown 打包路径，
 * 在 Windows 上触发的 realpath 解析会 spawn `net use`，而本机沙箱禁止该 spawn（EPERM），
 * 导致配置加载直接失败。导出纯对象可以完全避开这条路径。
 *
 * 【重要 2】pool 固定为 'threads'。
 * vitest 默认的 'forks' 池会 fork 子进程，同样被沙箱的 spawn 限制拦下。
 * 线程池在进程内工作，不涉及 spawn。
 * 注意 Vitest 4 起 poolOptions 已废弃，相关开关直接写在顶层。
 *
 * 路径：tests/** 与 src/** 下的 *.test.ts 都会被收集。
 */
export default {
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'threads',
    isolate: true
  }
}
