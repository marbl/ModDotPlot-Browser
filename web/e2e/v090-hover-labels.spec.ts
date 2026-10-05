import { expect, test, type Page } from "@playwright/test";

async function loadTwoSequences(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "hover-labels.fa",
    mimeType: "text/plain",
    buffer: Buffer.from([
      ">alpha first sequence",
      "ACGT".repeat(400),
      ">beta second sequence",
      "TGCA".repeat(400),
      "",
    ].join("\n")),
  });
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await page.locator("#explore-button").click();
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
}

async function hoverPlotCenter(page: Page): Promise<void> {
  const bounds = await page.locator("#plot-canvas").boundingBox();
  if (!bounds) throw new Error("plot canvas has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator("#hover-card")).toBeVisible();
}

test("hover coordinates identify both self and pairwise sequences", async ({ page }) => {
  await loadTwoSequences(page);

  await hoverPlotCenter(page);
  await expect(page.locator("#hover-card")).toContainText("x alpha ·");
  await expect(page.locator("#hover-card")).toContainText("y alpha ·");
  await expect(page.locator("#plot-summary")).toContainText("x alpha ·");
  await expect(page.locator("#plot-summary")).toContainText("y alpha ·");

  await page.locator("#plot-mode-pairwise").click();
  await expect(page.locator("#x-sequence")).toHaveValue("0");
  await expect(page.locator("#y-sequence")).toHaveValue("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });

  await hoverPlotCenter(page);
  await expect(page.locator("#hover-card")).toContainText("x alpha ·");
  await expect(page.locator("#hover-card")).toContainText("y beta ·");
});
