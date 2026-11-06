import { defineConfig } from '@playwright/test';

// Local runner for the chat-pane viewport regression on this host.
// Ports 3000/3100 are already occupied here (3200 is production), so the dev
// server runs on a dedicated port and the spec reads it through TEST_URL.
const PORT = Number(process.env.E2E_PORT || 3199);
const URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: './test-results-e2e',
  reporter: [['line']],
  use: { baseURL: URL, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `COMMHUB_URL=http://localhost:9999 ANET_DASHBOARD_PASSWORD=admin123 npm run dev -- -p ${PORT}`,
    url: `${URL}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
