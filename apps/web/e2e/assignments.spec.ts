import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

type Created = { id: string; title: string };

test("two assignments on one employee open as their own conversations", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await signup(page, `assignments-${stamp}@rakazo.test`, "password12", "Assignments QA");
  await completeOnboarding(page);
  const botId = await createNamedBot(page, "Planner");

  const offsiteBrief = `offsite-brief-${stamp}`;
  const invoiceBrief = `invoice-brief-${stamp}`;
  const offsite = await rpc<Created>(page, "assignments/create", {
    botId,
    title: "Plan the offsite",
    brief: offsiteBrief,
    clientNonce: `offsite-${stamp}`,
  });
  const invoice = await rpc<Created>(page, "assignments/create", {
    botId,
    title: "Draft the invoice",
    brief: invoiceBrief,
    clientNonce: `invoice-${stamp}`,
  });

  await page.goto(`/app/a/${offsite.id}`);
  await expect(page.getByRole("heading", { name: "Plan the offsite" })).toBeVisible();
  await expect(page.getByText(offsiteBrief)).toBeVisible();
  await expect(page.getByText(invoiceBrief)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "assignment-plan-the-offsite");

  await page.goto(`/app/a/${invoice.id}`);
  await expect(page.getByRole("heading", { name: "Draft the invoice" })).toBeVisible();
  await expect(page.getByText(invoiceBrief)).toBeVisible();
  await expect(page.getByText(offsiteBrief)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "assignment-draft-the-invoice");

  // The employee's own chat carries neither job.
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
  await expect(page.getByText(offsiteBrief)).toHaveCount(0);
  await expect(page.getByText(invoiceBrief)).toHaveCount(0);
});
