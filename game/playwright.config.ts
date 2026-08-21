import { defineConfig } from '@playwright/test';

// 사전 설치된 Chromium 사용 (환경 규칙: playwright install 금지, /opt/pw-browsers/chromium 직접 지정)
const executablePath = process.env.FD_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 }, // 모바일 세로 (iPhone급)
    hasTouch: true,
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'npx vite --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
