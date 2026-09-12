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

/**
 * A HOLD THAT NO ORDER USED MUST BE GIVEN BACK.
 *
 * This is the half a warehouse cannot do for us. `reserve_stock` is a real
 * write in another app's ledger, so it is outside the shop's transaction by
 * construction — the only honest arrangement is: hold, try to write the order,
 * and on any failure release what this attempt held. Before this, a basket
 * whose SECOND line was short left the first line's goods held for good: the
 * shelf read empty while the goods sat on it, and nothing in the ledger said
 * the reservation was stale.
 */
describe("stock held for an order that never happened", () => {
  const ledger = () => {
    const asked: { tool: string; args: Record<string, unknown> }[] = [];
    const free: Record<string, number> = { TEA: 10, COO: 1 };
    return {
      asked,
      apps: {
        stock: {
          nodeId: "warehouse-1",
          applicationType: "plugin_stock_min",
          via: "stock/v1",
          state: async () => ({}),
          call: async (tool: string, args?: Record<string, unknown>) => {
            const sku = String(args?.sku ?? "");
            const qty = Number(args?.qty ?? 0);
            asked.push({ tool, args: args ?? {} });
            if (tool === "reserve_stock") {
              if ((free[sku] ?? 0) < qty) return { ok: false, text: `cannot hold ${qty} × ${sku}: only ${free[sku] ?? 0} free` };
              free[sku] -= qty;
              return { ok: true, text: `Held ${qty} × ${sku}.` };
            }
            if (tool === "release_stock") {
              free[sku] = (free[sku] ?? 0) + qty;
              return { ok: true, text: `Released ${qty} × ${sku}.` };
            }
            return { ok: false, text: `no tool ${tool}` };
          },
        },
      },
      free,
    };
  };

  const stock = async (db: ReturnType<typeof memoryDb>, name: string, sku: string) =>
    (
      (await runOp(pluginServer, "add-product", { viewer: owner, args: { name, priceCents: 100, sku }, db: db.as(owner) })) as {
        result: { id: string };
      }
    ).result.id;

  it("a later line's refusal gives the earlier line's goods back", async () => {
    const db = memoryDb(manifest as never);
    const tea = await stock(db, "Tea", "TEA");
    const cookies = await stock(db, "Cookies", "COO");
    const w = ledger();
    await expect(
      runOp(pluginServer, "place-order", {
        viewer: alice,
        args: { lines: [{ productId: tea, qty: 2 }, { productId: cookies, qty: 5 }], shipTo: { name: "A", street: "1", city: "Ostrava" } },
        db: db.as(alice),
        ...w,
      }),
    ).rejects.toThrow(/only 1 free/);
    expect(w.asked.map((a) => `${a.tool} ${a.args.sku}×${a.args.qty}`)).toEqual([
      "reserve_stock TEA×2",
      "reserve_stock COO×5",
      "release_stock TEA×2",
    ]);
    // THE POINT: the warehouse is back where it started.
    expect(w.free.TEA).toBe(10);
    expect(await db.as(alice).order.count()).toBe(0);
  });

  it("a shop with no warehouse releases nothing — there is nothing to release", async () => {
    const db = memoryDb(manifest as never);
    const tea = await stock(db, "Tea", "TEA");
    const { result } = await runOp(pluginServer, "place-order", {
      viewer: alice,
      args: { lines: [{ productId: tea, qty: 2 }], shipTo: { name: "A", street: "1", city: "Ostrava" } },
      db: db.as(alice),
    });
    expect(result).toMatchObject({ totalCents: 200 });
  });

  it("an order that CANNOT be written releases the hold", async () => {
    const db = memoryDb(manifest as never);
    const tea = await stock(db, "Tea", "TEA");
    const w = ledger();
    // The table refusing the write is the failure this cannot be tested
    // without: it is the one that happens with the goods already held.
    const wedged = wedge(db.as(alice), "order", "create", "the order table is wedged");
    await expect(
      runOp(pluginServer, "place-order", {
        viewer: alice,
        args: { lines: [{ productId: tea, qty: 3 }], shipTo: { name: "A", street: "1", city: "Ostrava" } },
        db: wedged,
        ...w,
      }),
    ).rejects.toThrow(/wedged/);
    expect(w.asked.map((a) => a.tool)).toEqual(["reserve_stock", "release_stock"]);
    expect(w.free.TEA).toBe(10);
  });

  it("CHECKOUT is one breath: a basket that cannot be emptied leaves no order, and no hold", async () => {
    const db = memoryDb(manifest as never);
    const tea = await stock(db, "Tea", "TEA");
    await runOp(pluginServer, "add-to-cart", { viewer: alice, args: { productId: tea, qty: 2 }, db: db.as(alice) });
    const w = ledger();
    const wedged = wedge(db.as(alice), "cartLine", "deleteMany", "the basket is wedged");
    await expect(
      runOp(pluginServer, "checkout", { viewer: alice, args: { shipTo: { name: "A", street: "1", city: "Ostrava" } }, db: wedged, ...w }),
    ).rejects.toThrow(/wedged/);
    // Neither half happened: no order, the basket still holds the tea, and the
    // warehouse is whole. The alternative — an order written and a basket that
    // still holds it — is how somebody buys the same thing twice.
    expect(await db.as(alice).order.count()).toBe(0);
    expect(await db.as(alice).cartLine.count()).toBe(1);
    expect(w.free.TEA).toBe(10);
  });

  it("a checkout that works empties the basket and holds nothing back", async () => {
    const db = memoryDb(manifest as never);
    const tea = await stock(db, "Tea", "TEA");
    await runOp(pluginServer, "add-to-cart", { viewer: alice, args: { productId: tea, qty: 2 }, db: db.as(alice) });
    const w = ledger();
    const { result } = await runOp(pluginServer, "checkout", {
      viewer: alice,
      args: { shipTo: { name: "A", street: "1", city: "Ostrava" } },
      db: db.as(alice),
      ...w,
    });
    expect(result).toMatchObject({ totalCents: 200 });
    expect(w.asked.map((a) => a.tool)).toEqual(["reserve_stock"]);
    expect(w.free.TEA).toBe(8);
    expect(await db.as(alice).cartLine.count()).toBe(0);
    expect(await db.as(alice).order.count()).toBe(1);
  });
});

/**
 * One table's one method, made to fail — inside the transaction too, since
 * that is where the writes under test happen. Everything else is the real
 * client, rules and all.
 */
function wedge<T extends Record<string, unknown>>(db: T, model: string, method: string, message: string): T {
  const broken = (d: Record<string, unknown>): Record<string, unknown> => ({
    ...d,
    [model]: { ...(d[model] as Record<string, unknown>), [method]: async () => { throw new Error(message); } },
  });
  const out = broken(db as Record<string, unknown>);
  out.$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
    (db as unknown as { $transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).$transaction((tx) =>
      fn(broken(tx as Record<string, unknown>)),
    );
  return out as T;
}
