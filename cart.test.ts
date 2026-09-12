/**
 * THE WHOLE JOURNEY, THE WAY AN AGENT DRIVES IT.
 *
 * "Add two of the Earl Grey. Actually make it three. Take the cookies out.
 * Now check out." Those are four tool calls landing on four ops, against the
 * same rows the screen reads — which is the only reason an agent and an open
 * page can agree about a basket.
 *
 * The cases that matter are the ones a second customer or a retry would break:
 * whose basket it is, what a basket is worth (nothing — the shop prices at
 * checkout), and what is left behind afterwards.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";
import type { Cart } from "./app";

const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });
const alice = fakeViewer("visitor", { userId: "kp_a", role: "customer" });
const bob = fakeViewer("visitor", { userId: "kp_b", role: "customer" });
const stranger = fakeViewer("anonymous", { role: "customer" });

const SHIP = { name: "Alice Nowak", street: "Hlavní 12", city: "Ostrava" };

/** A shop with three things on the shelves, as the owner would stock it. */
async function stocked() {
  const db = memoryDb(manifest as never);
  const add = async (name: string, priceCents: number, sku: string, tags: string[], description?: string) =>
    (
      (await runOp(pluginServer, "add-product", {
        viewer: owner,
        args: { name, priceCents, sku, tags, ...(description ? { description } : {}) },
        db: db.as(owner),
      })) as { result: { id: string } }
    ).result.id;
  const tea = await add("Earl Grey", 450, "TEA-01", ["tea", "gifts"], "Bergamot, loose leaf.");
  const cookies = await add("Butter cookies", 320, "COO-01", ["baked"]);
  const wine = await add("Red wine", 1150, "WIN-01", ["drinks", "gifts"]);
  return { db, tea, cookies, wine };
}

const as = (db: ReturnType<typeof memoryDb>, viewer: typeof alice) => ({ viewer, db: db.as(viewer) });
const cartOf = async (db: ReturnType<typeof memoryDb>, viewer: typeof alice) =>
  ((await runOp(pluginServer, "view-cart", { ...as(db, viewer), args: {} })) as { result: Cart }).result;

describe("the basket, as an agent works it", () => {
  it("add, change the mind, take one out — and the WHOLE basket comes back each time", async () => {
    const { db, tea, cookies } = await stocked();

    let { result } = (await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 2 } })) as { result: Cart };
    expect(result.lines).toEqual([expect.objectContaining({ productId: tea, name: "Earl Grey", qty: 2, priceCents: 450 })]);
    expect(result.totalCents).toBe(900);

    // "add two more" — adding the same thing again adds up, it does not replace.
    ({ result } = (await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 1 } })) as { result: Cart });
    expect(result.lines[0]!.qty).toBe(3);

    ({ result } = (await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: cookies } })) as { result: Cart });
    expect(result.lines).toHaveLength(2);
    expect(result.totalCents).toBe(450 * 3 + 320);

    // "actually, make it one" — and then "take the cookies out".
    ({ result } = (await runOp(pluginServer, "set-cart-qty", { ...as(db, alice), args: { productId: tea, qty: 1 } })) as { result: Cart });
    expect(result.lines.find((l) => l.productId === tea)!.qty).toBe(1);
    ({ result } = (await runOp(pluginServer, "set-cart-qty", { ...as(db, alice), args: { productId: cookies, qty: 0 } })) as { result: Cart });
    expect(result.lines.map((l) => l.productId)).toEqual([tea]);
    expect(result.totalCents).toBe(450);
  });

  it("THE ONE THAT MATTERS: a basket is one person's — Bob's is empty while Alice's is full", async () => {
    const { db, tea } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 2 } });
    expect((await cartOf(db, alice)).lines).toHaveLength(1);
    expect((await cartOf(db, bob)).lines).toEqual([]);
    // And Bob cannot reach into hers by naming the line: he has no line to name.
    await expect(runOp(pluginServer, "set-cart-qty", { ...as(db, bob), args: { productId: tea, qty: 9 } })).rejects.toThrow(/not in your basket/);
    expect((await cartOf(db, alice)).lines[0]!.qty).toBe(2);
  });

  it("a signed-out visitor is asked to sign in, not refused", async () => {
    const { db, tea } = await stocked();
    await expect(runOp(pluginServer, "add-to-cart", { ...as(db, stranger), args: { productId: tea } })).rejects.toMatchObject({ code: "login-required" });
  });

  it("refuses what the shop does not sell, and says so plainly", async () => {
    const { db } = await stocked();
    await expect(runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: "nope" } })).rejects.toThrow(/no product nope/);
  });
});

describe("checkout", () => {
  it("prices the basket AT CHECKOUT from the catalogue, not from what it cost when it went in", async () => {
    const { db, tea } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 2 } });

    // The owner puts the price up while it sits in the basket.
    const [row] = await db.as(owner).product.findMany({ where: { id: tea }, take: 1 });
    await db.as(owner).product.update({ where: { id: row!.id }, data: { priceCents: 500 } });

    const { result } = (await runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP } })) as { result: { orderId: string; totalCents: number } };
    expect(result.totalCents).toBe(1000); // 2 × 5.00, the price now
  });

  it("leaves an order and an EMPTY basket — an order that exists beside a basket that still holds it is how people buy twice", async () => {
    const { db, tea, wine } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 2 } });
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: wine } });

    const { result, notified } = (await runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP, note: "leave with the neighbour" } })) as {
      result: { orderId: string; totalCents: number };
      notified: { topic: string; to?: unknown }[];
    };
    expect(result.totalCents).toBe(450 * 2 + 1150);
    expect((await cartOf(db, alice)).lines).toEqual([]);

    const orders = (await runOp(pluginServer, "list-orders", { ...as(db, alice), args: {} })) as { result: { id: string; lines: unknown[]; note: string | null }[] };
    expect(orders.result).toHaveLength(1);
    expect(orders.result[0]!.lines).toHaveLength(2);
    expect(orders.result[0]!.note).toBe("leave with the neighbour");

    // The desk was rung, and this person was told their own basket emptied.
    expect(notified.map((n) => n.topic)).toEqual(expect.arrayContaining(["new-order", "cart"]));
    expect(notified.find((n) => n.topic === "new-order")!.to).toEqual({ role: "staff" });
  });

  it("a blank name is not a refusal in itself — the shop asks the platform, and only then says it does not know", async () => {
    const { db, tea } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea } });
    // Nobody is signed into an account here, so there is no name to borrow and
    // the shop says what is missing. The point of the case is WHERE it refuses:
    // after asking, not in the schema. A `min(1)` on the field would make the
    // whole borrowing unreachable, which is how it shipped once.
    await expect(runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: { ...SHIP, name: "  " } } })).rejects.toThrow(/we need a name for the parcel/);
    // And what they DID type is never overridden.
    const { result } = (await runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP } })) as { result: { orderId: string } };
    const orders = (await runOp(pluginServer, "list-orders", { ...as(db, alice), args: {} })) as { result: { id: string; shipTo: { name: string } }[] };
    expect(orders.result.find((o) => o.id === result.orderId)!.shipTo.name).toBe("Alice Nowak");
  });

  it("an empty basket is not an order", async () => {
    const { db } = await stocked();
    await expect(runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP } })).rejects.toThrow(/basket is empty/);
  });

  it("checking out empties only the CHECKER-OUT's basket", async () => {
    const { db, tea, wine } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea } });
    await runOp(pluginServer, "add-to-cart", { ...as(db, bob), args: { productId: wine } });
    await runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP } });
    expect((await cartOf(db, alice)).lines).toEqual([]);
    expect((await cartOf(db, bob)).lines).toHaveLength(1);
  });

  it("a warehouse behind the shop holds the goods BEFORE the order, and refuses in its own words", async () => {
    const { db, tea } = await stocked();
    await runOp(pluginServer, "add-to-cart", { ...as(db, alice), args: { productId: tea, qty: 4 } });
    const asked: { tool: string; args: Record<string, unknown> }[] = [];
    const apps = {
      stock: {
        nodeId: "w1",
        applicationType: "plugin_stock_min",
        via: "stock/v1",
        state: async () => ({}),
        call: async (tool: string, args?: Record<string, unknown>) => {
          asked.push({ tool, args: args ?? {} });
          return { ok: false, text: "cannot hold 4 × TEA-01: only 2 free" };
        },
      },
    };
    await expect(runOp(pluginServer, "checkout", { ...as(db, alice), args: { shipTo: SHIP }, apps })).rejects.toThrow(/only 2 free/);
    expect(asked).toEqual([{ tool: "reserve_stock", args: { sku: "TEA-01", qty: 4 } }]);
    // Nothing was written, and the basket is untouched so they can try again.
    expect((await runOp(pluginServer, "list-orders", { ...as(db, alice), args: {} })).result).toEqual([]);
    expect((await cartOf(db, alice)).lines).toHaveLength(1);
  });
});

describe("the shelves", () => {
  it("a product page carries what a card cannot: the description and the departments", async () => {
    const { db, tea } = await stocked();
    const { result } = (await runOp(pluginServer, "product", { ...as(db, alice), args: { productId: tea } })) as {
      result: { name: string; description: string | null; tags: string[] };
    };
    expect(result).toMatchObject({ name: "Earl Grey", description: "Bergamot, loose leaf.", tags: ["tea", "gifts"] });
  });

  it("tags come back lower-cased and trimmed, so departments do not split in two", async () => {
    const db = memoryDb(manifest as never);
    const { result } = (await runOp(pluginServer, "add-product", { viewer: owner, args: { name: "Tulips", priceCents: 700, tags: [" Flowers ", "GIFTS"] }, db: db.as(owner) })) as {
      result: { tags: string[] };
    };
    expect(result.tags).toEqual(["flowers", "gifts"]);
  });

  it("a stranger may read a product page — that is how they decide to buy", async () => {
    const { db, tea } = await stocked();
    const { result } = (await runOp(pluginServer, "product", { ...as(db, stranger), args: { productId: tea } })) as { result: { name: string } };
    expect(result.name).toBe("Earl Grey");
  });
});
