/**
 * The Pokémon Pets plugin's page (plugins/community/pokemon-pets/src/page.html) in a browser,
 * with a stand-in for the IDE's `openidea` bridge answering as the plugin does.
 * `OPENIDEA_LOOK_SHOTS=<dir>` also saves a screenshot there.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const PAGE = readFileSync(new URL("../plugins/community/pokemon-pets/src/page.html", import.meta.url), "utf8");

// A 24×24 sprite: what the plugin sends, as a data: URL.
const SPRITE =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="gold"/></svg>',
  ).toString("base64");

test("pets are added, walk, change size and scene, and are kept", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 260 });
  // Before the page's script, as the IDE's bridge is.
  const bridge = `<script>
    window.saved = [];
    let listener = () => {};
    const reply = (m) => setTimeout(() => listener(JSON.stringify(m)), 0);
    window.openidea = {
      onMessage: (fn) => (listener = fn),
      postMessage: (raw) => {
        const m = JSON.parse(raw);
        if (m.op === "ready")
          reply({ op: "state", state: { pets: [{ id: 25 }], size: 1, speed: 1, scene: "none" }, last: 1025 });
        if (m.op === "sprite") reply({ op: "sprite", id: m.id, url: ${JSON.stringify(SPRITE)} });
        if (m.op === "names") reply({ op: "names", names: ["bulbasaur", "ivysaur", "venusaur", "charmander"] });
        if (m.op === "save") window.saved.push(m.state);
      },
    };
  </script>`;
  await page.setContent(`<!doctype html><html><body>${bridge}${PAGE}</body></html>`);

  const pets = page.locator(".pet img");
  await expect(pets).toHaveCount(1);
  await expect(page.locator(".pet").first()).toHaveAttribute("title", /#25|pikachu/);
  // They walk.
  const x0 = await page
    .locator(".pet")
    .first()
    .evaluate((el) => parseFloat(el.style.left));
  await expect
    .poll(async () =>
      page
        .locator(".pet")
        .first()
        .evaluate((el) => parseFloat(el.style.left)),
    )
    .not.toBe(x0);

  // By name and by number.
  await page.getByLabel("Pokémon name or number").fill("charmander");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Pokémon name or number").fill("#1");
  await page.keyboard.press("Enter");
  await expect(pets).toHaveCount(3);
  await page.getByLabel("Pokémon name or number").fill("missingno");
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toContainText("missingno");

  // Size and scene.
  await page.locator("#size").fill("2");
  await expect(pets.first()).toHaveCSS("height", "48px");
  await page.getByLabel("Scene").selectOption("grass");
  await expect(page.locator("#field")).toHaveClass(/grass/);
  if (process.env.OPENIDEA_LOOK_SHOTS)
    await page.screenshot({ path: `${process.env.OPENIDEA_LOOK_SHOTS}/pets.png`, animations: "disabled" });

  // Double-click sends one home; the state is saved.
  await page.locator(".pet").first().dblclick();
  await expect(pets).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { saved: { pets: unknown[]; size: number }[] }).saved.at(-1)))
    .toMatchObject({ pets: [{ id: 4 }, { id: 1 }], size: 2, scene: "grass" });

  // The controls hide, and come back with a double-click on the field.
  await page.locator("#hide").click();
  await expect(page.locator("#bar")).toBeHidden();
  await page.locator("#field").dblclick({ position: { x: 5, y: 5 } });
  await expect(page.locator("#bar")).toBeVisible();
});
