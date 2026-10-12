// measure card heights in the wallet detail view (desktop viewport)
import puppeteer from "puppeteer";

const KEY = (await import("node:fs")).readFileSync("/root/.site-key", "utf8").trim().split("=")[1];
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`http://127.0.0.1:3000/?key=${KEY}`, { waitUntil: "domcontentloaded" }); await new Promise((r) => setTimeout(r, 2500));

// sign in anonymously and create a wallet if none
const me = await page.evaluate(async () => {
  const r = await fetch("/api/me", { credentials: "same-origin" });
  return r.status;
});
if (me === 401) {
  await page.evaluate(async () => {
    await fetch("/api/auth/anon", { method: "POST", credentials: "same-origin" });
  });
  await page.reload({ waitUntil: "domcontentloaded" }); await new Promise((r) => setTimeout(r, 2000));
}

// open the first wallet in the list
await page.evaluate(`(() => {
  const li = document.querySelector("#wallet-list li");
  if (li) li.click();
})()`);
await new Promise((r) => setTimeout(r, 2500));

const heights = await page.evaluate(`(() => {
  const wd = document.getElementById("wallet-detail");
  if (wd && wd.hidden) wd.hidden = false;
  const cards = document.querySelectorAll(".detail-grid > .card");
  const grid = document.querySelector(".detail-grid");
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
  };
  const b = cards[0], send = cards[1];
  return {
    grid: rect(grid),
    balance: rect(b),
    send: rect(send),
    balanceChildren: [...b.children].map((c) => c.tagName + ":" + Math.round(c.getBoundingClientRect().top)),
    sendChildren: [...send.children].map((c) => c.tagName + ":" + Math.round(c.getBoundingClientRect().top)),
  };
})()`);

// experiment: force align-self on the send card
const experiment = await page.evaluate(`(() => {
  const cards = document.querySelectorAll(".detail-grid > .card");
  const send = cards[1];
  const before = send.getBoundingClientRect().height;
  void 0;
  void 0;
  const after = send.getBoundingClientRect().height;
  const btn = document.querySelector('#form-send button[type="submit"]');
  const btnAfter = btn ? btn.getBoundingClientRect().bottom - send.getBoundingClientRect().bottom : null;
  return { before, after, btnGapToCardBottom: btnAfter };
})()`);
console.log("layout:", JSON.stringify(heights, null, 2));
console.log("experiment:", JSON.stringify(experiment, null, 2));
await page.setViewport({ width: 390, height: 844 });
await new Promise((r) => setTimeout(r, 1500));
const mobile = await page.evaluate(`(() => {
  const wide = [];
  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.left < -1) {
      wide.push(el.tagName + "." + (el.className || "").toString().slice(0, 40) + " right=" + Math.round(r.right));
    }
  });
  return {
    scrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow: document.scrollingElement.scrollWidth > window.innerWidth,
    wide: wide.slice(0, 8),
  };
})()`);
console.log("mobile:", JSON.stringify(mobile));
await browser.close();
process.exit(0);
