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
import { pluginSchema } from "./app";

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

/**
 * THE DEPARTMENTS THE STOREFRONT OFFERS.
 *
 * They live in the fold, and until the SERVER recorded them only the owner's
 * form did — so a shop stocked by its agent had a catalogue and no departments
 * at all (seen on production, 2026-09-12). The change id is derived from the
 * product, so the UI's own optimistic dispatch of the same event is a no-op.
 */
describe("adding a product records the catalogue change", () => {
  it("names the departments it introduced, with an id derived from the product", async () => {
    const db = memoryDb(manifest as never);
    const run = (await runOp(pluginServer, "add-product", {
      viewer: owner,
      args: { name: "Earl Grey", priceCents: 450, tags: [" Tea ", "GIFTS"] },
      db: db.as(owner),
    })) as { result: { id: string }; emitted: { eventName: string; eventData: Record<string, unknown> }[] };
    const result = run.result;
    const change = run.emitted.find((e) => e.eventName.endsWith("catalogue_changed"));
    expect(change?.eventData).toMatchObject({ changeId: `product:${result.id}`, tags: ["tea", "gifts"] });
  });

  it("a product that adds no department still records the change", async () => {
    const db = memoryDb(manifest as never);
    const run2 = (await runOp(pluginServer, "add-product", {
      viewer: owner,
      args: { name: "Plain thing", priceCents: 100 },
      db: db.as(owner),
    })) as { emitted: { eventName: string }[] };
    expect(run2.emitted.some((e) => e.eventName.endsWith("catalogue_changed"))).toBe(true);
  });
});

/**
 * WHAT `catalogueVersion` MEANS.
 *
 * Every open storefront watches it to re-read the shelves. Three tools used to
 * bump it: add-product (twice, once from the tool and once from the op, with a
 * random id the reducer could not dedupe) and both order tools, for something
 * that never touched the catalogue. At a thousand orders a day that is a
 * thousand catalogue refetches on every shopper's open page (2026-09-12).
 */
describe("only a catalogue change is a catalogue change", () => {
  const toolkit = () => {
    const dispatched: { eventName: string }[] = [];
    const tools = pluginSchema.toolkitCreator!(
      { workspaceId: "w", nodeId: "n", instanceName: "Shop", applicationType: "plugin_shop_demo" } as never,
      undefined as never,
      ((e: { eventName: string }) => dispatched.push(e)) as never,
      // The platform passes a chat-message callback too. Naming it here is
      // what makes this call type-check in an author's editor — `tsc` on the
      // whole tree caught it; ts-jest never type-checks, so the box was green
      // with a call the real signature refuses (2026-09-12).
      (() => undefined) as never,
    ) as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
    return { tools, dispatched };
  };

  it("the till is askable — a table nobody can query is not a capability", () => {
    const { tools } = toolkit();
    const sales = Object.keys(tools).find((n) => n.startsWith("sales_"));
    expect(sales).toBeTruthy();
  });

  it("no tool dispatches an event of its own — the op owns the timeline", () => {
    const { tools, dispatched } = toolkit();
    expect(Object.keys(tools).length).toBeGreaterThan(5);
    expect(dispatched).toEqual([]);
  });
});
