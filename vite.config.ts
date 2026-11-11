import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 单 HTML 离线包：所有 JS/CSS/资源内联，产物可直接双击 file:// 打开。
// Tauri 桌面端复用同一份 dist：自定义协议加载 index.html，无外部资源依赖。
export default defineConfig({
  base: './',
  clearScreen: false,
  plugins: [vue(), viteSingleFile()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Rust 侧改动由 tauri dev 自己监听，避免 Vite 重复触发
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    target: 'es2019',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000
  }
})
