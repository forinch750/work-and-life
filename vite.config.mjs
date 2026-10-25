/**
 * 渲染进程构建配置。
 *
 * 【重要】这里刻意不 import 任何东西（包括 @vitejs/plugin-react 与 defineConfig）。
 *
 * 原因：`vite` 本体的配置加载对该文件走原生 ESM 导入，不 spawn 子进程，可以正常工作；
 * 而任何"打包配置文件"的路径都会拉起 esbuild 的服务模式，其 stdio 固定使用管道，
 * 在本机沙箱下被拒绝（EPERM）。Vite 8 内置的转换器已能处理 TS/TSX，
 * 因此这里只需要一个纯对象把入口与输出指好。
 *
 * 主进程与预加载不经过 vite，由 tsc 编译（见 scripts/build.mjs）。
 */
export default {
  root: 'src/renderer',
  base: './',
  logLevel: 'info',
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome120',
    rollupOptions: {
      input: { index: 'src/renderer/index.html' }
    }
  }
}
