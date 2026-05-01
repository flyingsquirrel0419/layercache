import process from "node:process";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(`${baseUrl}/playground`, { waitUntil: "networkidle" });

  const editor = page.locator("textarea");
  await editor.fill("while (true) {}");

  const runButton = page.getByRole("button", { name: "Run", exact: true });
  await runButton.click();

  await page.getByRole("button", { name: "Running...", exact: true }).waitFor({
    state: "visible",
    timeout: 5000,
  });

  await page.waitForFunction(
    () => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.some(
        (button) =>
          button.textContent?.trim() === "Run" &&
          !button.hasAttribute("disabled")
      );
    },
    { timeout: 35000 }
  );

  await page
    .locator("text=Execution timed out (30s limit) — worker terminated")
    .waitFor({ state: "visible", timeout: 5000 });

  console.log("E2E timeout recovery verified");
} finally {
  await browser.close();
}
