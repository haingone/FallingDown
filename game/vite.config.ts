import { defineConfig } from 'vite';

// base './' : 정적 호스팅 어느 경로에 올려도 동작 (앱인토스 WebView 배포 대비, SDK 연동은 M1 범위 외)
export default defineConfig({
  base: './',
  server: { host: true },
  build: { target: 'es2022', sourcemap: false },
});
