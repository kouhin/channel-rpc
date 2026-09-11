import { defineConfig } from '@playwright/test';

const port = Number(process.env.RPC_TEST_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './test/browser',
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: true,
	retries: 0,
	reporter: 'list',
	use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure' },
	webServer: {
		command: 'bun run test/browser/server.ts',
		url: `${baseURL}/health`,
		reuseExistingServer: false,
		timeout: 10000
	}
});
