/**
 * WHAT SOLD.
 *
 * `Order.lines` is a receipt: one order's worth, in a json column nothing can
 * ask a question of. "How much Earl Grey did we sell, and for how much" is a
 * question about the SHOP, and answering it from receipts means reading every
 * order ever placed. So each thing sold is a row, written in the same breath
 * as the order and carrying the price AT THE TIME — the catalogue's price
 * today is not what last month's sales were worth.
 *
 * These cases hold the two properties that make it trustworthy: the rows and
 * the order live or die together, and a total never counts rows it did not
 * read.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";

const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });
const alice = fakeViewer("visitor", { userId: "kp_a", role: "customer" });
const bob = fakeViewer("visitor", { userId: "kp_b", role: "customer" });
const staff = fakeViewer("member", { userId: "kp_s", role: "staff" });

const SHIP = { name: "A", street: "1", city: "Ostrava" };

async function shop() {
  const db = memoryDb(manifest as never);
  const add = async (name: string, priceCents: number, sku: string) =>
    (
      (await runOp(pluginServer, "add-product", { viewer: owner, args: { name, priceCents, sku }, db: db.as(owner) })) as {
        result: { id: string };
      }
    ).result.id;
  return { db, tea: await add("Earl Grey", 450, "TEA-01"), wine: await add("Red wine", 1150, "WIN-01") };
}

const order = (db: ReturnType<typeof memoryDb>, who: typeof alice, lines: { productId: string; qty: number }[]) =>
  runOp(pluginServer, "place-order", { viewer: who, args: { lines, shipTo: SHIP, note: undefined }, db: db.as(who) });

type Sales = {
  lines: { orderId: string; productId: string | null; name: string; qty: number; priceCents: number }[];
  products: { productId: string | null; name: string; units: number; centsSold: number }[];
  unitsSold: number;
  centsSold: number;
  nextCursor: string | null;
  countsSalesFrom: string | null;
};
const salesAs = async (db: ReturnType<typeof memoryDb>, who: typeof owner, args: Record<string, unknown> = {}) =>
  ((await runOp(pluginServer, "sales", { viewer: who, args, db: db.as(who) })) as { result: Sales }).result;

describe("a line per thing sold", () => {
  it("is written with the order, priced at the moment of sale", async () => {
    const { db, tea, wine } = await shop();
    await order(db, alice, [{ productId: tea, qty: 2 }, { productId: wine, qty: 1 }]);
    const s = await salesAs(db, owner);
    expect(s.unitsSold).toBe(3);
    expect(s.centsSold).toBe(2 * 450 + 1150);
    expect(s.products.map((p) => `${p.name} ${p.units}@${p.centsSold}`)).toEqual(["Red wine 1@1150", "Earl Grey 2@900"]);
    expect(s.lines.every((l) => !!l.orderId)).toBe(true);
  });

  it("survives a price change — September's sales are not repriced by October's catalogue", async () => {
    const { db, tea } = await shop();
    await order(db, alice, [{ productId: tea, qty: 2 }]);
    const rows = await db.as(owner).product.findMany({ where: { id: tea }, take: 1 });
    await db.as(owner).product.update({ where: { id: rows[0]!.id }, data: { priceCents: 900 } });
    expect((await salesAs(db, owner)).centsSold).toBe(900); // 2 × 450, as sold
  });

  it("ONE BREATH: an order that could not be written leaves no lines behind", async () => {
    const { db, tea } = await shop();
    const wedged = { ...(db.as(alice) as Record<string, unknown>) };
    wedged.$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
      (db.as(alice) as unknown as { $transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).$transaction(
        async (tx) => {
          await fn(tx);
          throw new Error("the till jammed");
        },
      );
    await expect(
      runOp(pluginServer, "place-order", { viewer: alice, args: { lines: [{ productId: tea, qty: 2 }], shipTo: SHIP }, db: wedged as never }),
    ).rejects.toThrow(/jammed/);
    expect(await db.as(owner).order.count()).toBe(0);
    expect(await db.as(owner).orderLine.count()).toBe(0);
  });
});

describe("who may ask the till", () => {
  it("staff and the owner see the whole shop's sales", async () => {
    const { db, tea } = await shop();
    await order(db, alice, [{ productId: tea, qty: 1 }]);
    await order(db, bob, [{ productId: tea, qty: 3 }]);
    expect((await salesAs(db, owner)).unitsSold).toBe(4);
    expect((await salesAs(db, staff)).unitsSold).toBe(4);
  });

  it("a customer asking gets their OWN history, not the shop's and not a refusal", async () => {
    const { db, tea } = await shop();
    await order(db, alice, [{ productId: tea, qty: 1 }]);
    await order(db, bob, [{ productId: tea, qty: 3 }]);
    expect((await salesAs(db, alice)).unitsSold).toBe(1);
    expect((await salesAs(db, bob)).unitsSold).toBe(3);
  });
});

describe("the questions a shop actually asks", () => {
  it("one product's history is a WHERE, not a filter over everything", async () => {
    const { db, tea, wine } = await shop();
    await order(db, alice, [{ productId: tea, qty: 2 }, { productId: wine, qty: 1 }]);
    const s = await salesAs(db, owner, { productId: wine });
    expect(s.products).toEqual([{ productId: wine, name: "Red wine", units: 1, centsSold: 1150 }]);
    expect(s.lines.every((l) => l.productId === wine)).toBe(true);
  });

  it("a period is a WHERE too, and a date it cannot read is said so", async () => {
    const { db, tea } = await shop();
    await order(db, alice, [{ productId: tea, qty: 1 }]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await salesAs(db, owner, { since: tomorrow })).unitsSold).toBe(0);
    expect((await salesAs(db, owner, { since: "1970-01-01" })).unitsSold).toBe(1);
    await expect(runOp(pluginServer, "sales", { viewer: owner, args: { since: "last tuesday" }, db: db.as(owner) })).rejects.toThrow(
      /not a date/,
    );
  });

  it("pages, and never totals rows it did not read", async () => {
    const { db, tea, wine } = await shop();
    for (let i = 0; i < 3; i++) await order(db, alice, [{ productId: tea, qty: 1 }, { productId: wine, qty: 1 }]);
    const first = await salesAs(db, owner, { limit: 2 });
    expect(first.lines).toHaveLength(2);
    expect(first.unitsSold).toBe(2); // the page's units, not the shop's
    expect(first.nextCursor).toBeTruthy();
    const second = await salesAs(db, owner, { limit: 2, cursor: first.nextCursor! });
    expect(second.lines.map((l) => l.orderId)).not.toEqual(first.lines.map((l) => l.orderId));
  });

  it("refuses a page too big to answer — the client caps a read at 200 and the page asks for one more", async () => {
    const { db } = await shop();
    await expect(runOp(pluginServer, "sales", { viewer: owner, args: { limit: 500 }, db: db.as(owner) })).rejects.toThrow();
  });

  it("names the date it can see back to — an order placed before this table has a receipt and no rows", async () => {
    const { db, tea } = await shop();
    expect((await salesAs(db, owner)).countsSalesFrom).toBeNull();
    await order(db, alice, [{ productId: tea, qty: 1 }]);
    expect((await salesAs(db, owner)).countsSalesFrom).toEqual(expect.stringContaining("T"));
  });
});
