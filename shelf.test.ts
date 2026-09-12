/**
 * THE SHELF AT THE SIZE OF A REAL SHOP.
 *
 * A shop with 100 000 products is answerable only if a department and a search
 * term are questions for the SERVER. Filtering a page of results in the
 * browser makes a department with nothing on the first page look empty, and it
 * makes a search box impossible. `plugin.json` declares the two index kinds
 * that answer them (`tags` → `contains`, `name` → `text`); these are the cases
 * that say the ops use them.
 *
 * Written against the app's own manifest, so what passes here is what the real
 * database will do.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";

const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });
const shopper = fakeViewer("anonymous", { role: "customer" });

type Shelf = { items: { id: string; name: string; tags: string[] }[]; nextCursor: string | null };

/** A shop with more on the shelves than one page can hold. */
async function stocked(n = 30) {
  const db = memoryDb(manifest as never);
  const departments = ["tea", "baked", "drinks"];
  for (let i = 0; i < n; i++) {
    await runOp(pluginServer, "add-product", {
      viewer: owner,
      args: {
        name: i === 7 ? "Earl Grey, loose leaf" : `Product ${i}`,
        priceCents: 100 + i,
        sku: `SKU-${i}`,
        tags: [departments[i % 3]!, ...(i % 10 === 0 ? ["gifts"] : [])],
      },
      db: db.as(owner),
    });
  }
  return db;
}

const shelf = async (db: ReturnType<typeof memoryDb>, args: Record<string, unknown> = {}) =>
  ((await runOp(pluginServer, "browse", { viewer: shopper, args, db: db.as(shopper) })) as { result: Shelf }).result;

describe("the shelf a stranger walks", () => {
  it("comes a page at a time, and says whether there is another", async () => {
    const db = await stocked();
    const first = await shelf(db);
    expect(first.items).toHaveLength(24);
    expect(first.nextCursor).toBe(first.items[23]!.id);
  });

  it("THE ONE THAT MATTERS: the next page continues the shelf, and the last one ends it", async () => {
    const db = await stocked();
    const first = await shelf(db);
    const second = await shelf(db, { cursor: first.nextCursor });
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    // Every product exactly once, which is what a shopper walking a shelf means.
    const ids = [...first.items, ...second.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(30);
  });

  it("a DEPARTMENT is answered by the shop, not by the page — so it is never empty by accident", async () => {
    const db = await stocked();
    const gifts = await shelf(db, { tag: "gifts" });
    // The gifts are every tenth product: 0, 10, 20. Two of the three are past
    // the first page of an unfiltered shelf, which is the whole point.
    expect(gifts.items).toHaveLength(3);
    expect(gifts.items.every((p) => p.tags.includes("gifts"))).toBe(true);
    expect(gifts.nextCursor).toBeNull();
  });

  it("a department is matched however the shopper capitalised it", async () => {
    const db = await stocked();
    expect((await shelf(db, { tag: "GIFTS" })).items).toHaveLength(3);
  });

  it("a SEARCH TERM finds a product the first page never showed", async () => {
    const db = await stocked();
    const found = await shelf(db, { q: "Earl Grey" });
    expect(found.items.map((p) => p.name)).toEqual(["Earl Grey, loose leaf"]);
  });

  it("a department and a term together", async () => {
    const db = await stocked();
    const both = await shelf(db, { tag: "baked", q: "Product 1" });
    expect(both.items.length).toBeGreaterThan(0);
    expect(both.items.every((p) => p.tags.includes("baked") && p.name.includes("Product 1"))).toBe(true);
  });

  it("nothing matching is an empty shelf, not an error", async () => {
    const db = await stocked();
    expect(await shelf(db, { q: "unobtainium" })).toEqual({ items: [], nextCursor: null });
    expect(await shelf(db, { tag: "hardware" })).toEqual({ items: [], nextCursor: null });
  });

  it("refuses a page bigger than the shop is willing to serve", async () => {
    const db = await stocked();
    await expect(runOp(pluginServer, "browse", { viewer: shopper, args: { limit: 500 }, db: db.as(shopper) })).rejects.toThrow();
  });

  it("an empty shop is an empty shelf", async () => {
    const db = memoryDb(manifest as never);
    expect(await shelf(db)).toEqual({ items: [], nextCursor: null });
  });
});
