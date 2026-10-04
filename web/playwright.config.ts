import { defineConfig, devices } from "@playwright/test";

const port = process.env.MODDOTPLOT_E2E_PORT ?? "4174";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // GitHub's Linux runners do not expose a display-backed WebGL2 context to
        // headless Firefox. CI wraps Playwright in Xvfb so Firefox can exercise the
        // same renderer through Mesa's software backend.
        headless: process.env.CI ? false : true,
        launchOptions: {
          firefoxUserPrefs: {
            "webgl.disabled": false,
            "webgl.enable-webgl2": true,
            "webgl.forbid-software": false,
            "webgl.force-enabled": true,
            "webgl.ignore-blocklist": true,
          },
        },
      },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
