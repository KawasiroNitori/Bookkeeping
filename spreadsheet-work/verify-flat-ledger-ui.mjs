import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const mockLedger = JSON.parse(await fs.readFile(path.join(root, "outputs", "ledger-v2", "flat-ledger-response.json"), "utf8"));
const outDir = path.join(root, "outputs", "ledger-v2");
const indexHtml = await fs.readFile(path.join(root, "index.html"), "utf8");
const appJs = await fs.readFile(path.join(root, "app.js"), "utf8");
const stylesCss = await fs.readFile(path.join(root, "styles.css"), "utf8");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let savedPayload = null;
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/" || url.pathname.endsWith("/index.html")) {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: indexHtml });
    return;
  }
  if (url.pathname.endsWith("/app.js")) {
    await route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: appJs });
    return;
  }
  if (url.pathname.endsWith("/styles.css")) {
    await route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: stylesCss });
    return;
  }
  if (url.pathname === "/api/ledger") {
    await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(mockLedger) });
    return;
  }
  if (url.pathname === "/api/save") {
    savedPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ ok: true }) });
    return;
  }
  await route.fulfill({ status: 404, body: "not found" });
});

await page.goto("http://127.0.0.1:4188/");
await page.getByRole("button", { name: "거래내역" }).click();
await page.getByRole("button", { name: "최신순" }).click();
const newestFirst = await page.locator(".history-meta").first().innerText();
await page.getByRole("button", { name: "오래된순" }).click();
const oldestFirst = await page.locator(".history-meta").first().innerText();
if (newestFirst === oldestFirst) throw new Error("History sort did not change the first visible item.");
await page.getByRole("button", { name: "거래입력" }).click();
await page.getByRole("button", { name: "입금" }).click();
await page.locator("#entry-transaction-date").fill("2026-01-02");
await page.locator('[data-action="select-member"][data-group="deposit"]').first().click();
await page.locator("#deposit-amount").fill("1234");
await page.locator("#deposit-memo").fill("append-only verification");
await page.getByRole("button", { name: "저장" }).click();
await page.waitForFunction(() => document.body.innerText.includes("구글 시트에 저장됨"), null, { timeout: 5000 });
await page.screenshot({ path: path.join(outDir, "flat-ledger-ui-verification.png"), fullPage: true });

await browser.close();

if (!savedPayload) throw new Error("No save payload captured.");
if (savedPayload.action !== "appendTransaction") throw new Error(`Expected appendTransaction, got ${savedPayload.action}`);
if (savedPayload.transaction.transactionDate !== "2026-01-02") throw new Error(`Wrong transactionDate: ${savedPayload.transaction.transactionDate}`);
if (!savedPayload.memberDeltas || savedPayload.memberDeltas.length !== 1 || savedPayload.memberDeltas[0].delta !== 1234) {
  throw new Error(`Unexpected memberDeltas: ${JSON.stringify(savedPayload.memberDeltas)}`);
}
if (savedPayload.action === "saveAll") throw new Error("Unexpected saveAll payload.");

await fs.writeFile(path.join(outDir, "flat-ledger-ui-verification.json"), JSON.stringify({
  ok: true,
  capturedAction: savedPayload.action,
  transactionDate: savedPayload.transaction.transactionDate,
  memberDeltas: savedPayload.memberDeltas,
  newestFirst,
  oldestFirst,
  screenshot: "flat-ledger-ui-verification.png",
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  capturedAction: savedPayload.action,
  transactionDate: savedPayload.transaction.transactionDate,
  memberDeltas: savedPayload.memberDeltas,
  newestFirst,
  oldestFirst,
}, null, 2));
