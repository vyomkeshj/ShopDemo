/**
 * THE SHOP, WITH AND WITHOUT A WAREHOUSE.
 *
 * The slot is optional, so both halves must be true: a shop with nothing bound
 * sells exactly as it did before bindings existed, and a shop with a warehouse
 * behind it holds the goods first — and refuses the order in the ledger's own
 * words when it cannot.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";

const alice = fakeViewer("visitor", { userId: "kp_a", role: "customer" });
const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });

/** A warehouse in the slot, and a record of what the shop asked it. */
const warehouse = (answer: (tool: string, args: Record<string, unknown>) => { ok: boolean; text: string }) => {
  const asked: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    asked,
    apps: {
      stock: {
        nodeId: "warehouse-1",
        applicationType: "plugin_stock_min",
        via: "stock/v1",
        state: async () => ({}),
        call: async (tool: string, args?: Record<string, unknown>) => {
          asked.push({ tool, args: args ?? {} });
          return answer(tool, args ?? {});
        },
      },
    },
  };
};

async function shopWithProduct(db: ReturnType<typeof memoryDb>) {
  const { result } = await runOp(pluginServer, "add-product", { viewer: owner, args: { name: "Tea", priceCents: 350, sku: "TEA" }, db: db.as(owner) });
  return (result as { id: string }).id;
}
const ORDER = (productId: string, qty = 2) => ({ lines: [{ productId, qty }], shipTo: { name: "A", street: "1", city: "Ostrava" } });

describe("the shop's stock slot", () => {
  it("empty: the shop sells exactly as before — an optional slot is not a dependency", async () => {
    const db = memoryDb(manifest as never);
    const id = await shopWithProduct(db);
    const { result } = await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER(id), db: db.as(alice) });
    expect(result).toMatchObject({ totalCents: 700 });
    expect(await db.as(alice).order.count()).toBe(1);
  });

  it("filled: the goods are held BEFORE the order exists, by SKU and quantity", async () => {
    const db = memoryDb(manifest as never);
    const id = await shopWithProduct(db);
    const w = warehouse(() => ({ ok: true, text: "Held 2 × TEA. 8 free." }));
    const { result } = await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER(id), db: db.as(alice), ...w });
    expect(w.asked).toEqual([{ tool: "reserve_stock", args: { sku: "TEA", qty: 2 } }]);
    expect(result).toMatchObject({ totalCents: 700 });
  });

  it("refused: the ledger's own words reach the customer, and NO order is written", async () => {
    const db = memoryDb(manifest as never);
    const id = await shopWithProduct(db);
    const w = warehouse(() => ({ ok: false, text: "cannot hold 2 × TEA: only 1 free (1 on hand, 0 already held)" }));
    await expect(runOp(pluginServer, "place-order", { viewer: alice, args: ORDER(id), db: db.as(alice), ...w })).rejects.toThrow(/only 1 free/);
    expect(await db.as(alice).order.count()).toBe(0);
  });

  it("a product with no SKU is not held — the shop asks about what the warehouse can know", async () => {
    const db = memoryDb(manifest as never);
    const { result } = await runOp(pluginServer, "add-product", { viewer: owner, args: { name: "Gift card", priceCents: 1000 }, db: db.as(owner) });
    const w = warehouse(() => ({ ok: true, text: "" }));
    await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER((result as { id: string }).id), db: db.as(alice), ...w });
    expect(w.asked).toEqual([]);
    expect(await db.as(alice).order.count()).toBe(1);
  });
});

/**
 * A COURTESY MUST NOT UNDO A COMPLETED WRITE.
 *
 * The shop rings the staff desk when an order arrives. The order is already in
 * the table by then, so a refused or broken notification cannot be allowed to
 * throw out of the op — the first version did, and an order that existed came
 * back to the person as "forbidden". The owner hit it while ordering as staff,
 * because the manifest let only a customer ring the desk.
 */
describe("placing an order when the desk cannot be told", () => {
  const seller = fakeViewer("owner", { userId: "kp_o", role: "owner" });

  const failing = () => ({ notifyFails: () => Object.assign(new Error("forbidden"), { code: "forbidden" }) });

  it("the order STANDS, and says the desk was not told", async () => {
    const db = memoryDb(manifest as never);
    const { result: p } = await runOp(pluginServer, "add-product", { viewer: seller, args: { name: "Tea", priceCents: 350, sku: "T9" }, db: db.as(seller) });
    const { result } = await runOp(pluginServer, "place-order", {
      viewer: alice,
      args: { lines: [{ productId: (p as { id: string }).id, qty: 1 }], shipTo: { name: "A", street: "1", city: "Ostrava" } },
      db: db.as(alice),
      ...failing(),
    });
    expect(result).toMatchObject({ totalCents: 350, deskTold: false });
    expect(await db.as(alice).order.count()).toBe(1);
  });

  it("everyone the shop lets ORDER may also ring the desk — or their own order refuses", () => {
    const canOrder = (manifest as { db: { Order: { rules: { create: { roles: string[] } } } } }).db.Order.rules.create.roles;
    const mayRing = (manifest as { channel: { topics: { "new-order": { mayAddress: string[] } } } }).channel.topics["new-order"].mayAddress;
    for (const role of canOrder) expect(mayRing).toContain(role);
  });
});
