/**
 * THE AUTHOR'S LOOP — this file is written the way the friend writes it.
 *
 * Nothing here imports from the platform. It imports `esoul-sdk/testing`, the
 * app's own `plugin.json`, and the app's own server code, exactly as it would
 * in a folder that has never seen this repository. If this file is pleasant to
 * write and honest about what it proves, the SDK works; if it is awkward, the
 * SDK is wrong and no amount of platform code fixes that.
 *
 * What it proves is the thing a shop owner actually worries about: that one
 * customer cannot see another's orders, that a stranger is told to sign in
 * rather than refused outright, and that staff can do their job without
 * reading anybody's address book.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";

/**
 * The server half a shop would ship. Inline here because the fixture is a
 * manifest, but this is verbatim what `server.ts` looks like — note that it
 * contains NO access checks: `pluginDb(ctx)` carries the viewer, and the rules
 * in plugin.json are enforced before any row is touched.
 */
const pluginServer = {
  ops: {
    "place-order": async (ctx: any) => {
      const { lines, totalCents } = ctx.args as { lines: unknown[]; totalCents: number };
      const order = await ctx.db.order.create({ data: { lines, totalCents, shipTo: {} } });
      await ctx.notify("new-order", { orderId: order.id }, { to: { role: "staff" } });
      return { orderId: order.id };
    },
    "list-orders": async (ctx: any) =>
      ctx.db.order.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  },
};

const ORDER = { lines: [{ sku: "TEA", qty: 2 }], totalCents: 700 };

describe("my shop's rules", () => {
  const alice = fakeViewer("visitor", { userId: "u_alice", role: "customer" });
  const bob = fakeViewer("visitor", { userId: "u_bob", role: "customer" });
  const stranger = fakeViewer("anonymous", { role: "customer" });

  it("lets a customer order and see it", async () => {
    const db = memoryDb(manifest as never);
    const { result } = await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER, db: db.as(alice) });
    expect(result).toMatchObject({ orderId: expect.any(String) });
    expect(await db.as(alice).order.count()).toBe(1);
  });

  it("does not let another customer see it", async () => {
    const db = memoryDb(manifest as never);
    await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER, db: db.as(alice) });
    const { result } = await runOp(pluginServer, "list-orders", { viewer: bob, args: {}, db: db.as(bob) });
    expect(result).toEqual([]);
  });

  it("tells a signed-out visitor to sign in, rather than refusing them", async () => {
    const db = memoryDb(manifest as never);
    await expect(
      runOp(pluginServer, "place-order", { viewer: stranger, args: ORDER, db: db.as(stranger) }),
    ).rejects.toMatchObject({ code: "login-required" });
  });

  it("shows staff every order", async () => {
    const db = memoryDb(manifest as never);
    await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER, db: db.as(alice) });
    await runOp(pluginServer, "place-order", { viewer: bob, args: ORDER, db: db.as(bob) });
    const { result } = await runOp(pluginServer, "list-orders", { viewer: fakeViewer("member", { role: "staff" }), args: {}, db: db.as("member") });
    expect(result).toHaveLength(2);
  });

  it("tells the staff desk about a new order, and nobody else", async () => {
    const db = memoryDb(manifest as never);
    const { notified } = await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER, db: db.as(alice) });
    expect(notified).toEqual([{ topic: "new-order", data: { orderId: expect.any(String) }, to: { role: "staff" } }]);
  });

  it("keeps the address book out of staff's hands", async () => {
    const db = memoryDb(manifest as never);
    await db.as(alice).address.create({ data: { label: "Home", lines: { street: "Hlavní 1" } } });
    expect(await db.as(alice).address.count()).toBe(1);
    expect(await db.as("member").address.count()).toBe(0);
    expect(await db.as("owner").address.count()).toBe(0);
  });

  it("lets a customer add a note to their order but not change its status", async () => {
    const db = memoryDb(manifest as never);
    const { result } = await runOp(pluginServer, "place-order", { viewer: alice, args: ORDER, db: db.as(alice) });
    const id = (result as { orderId: string }).orderId;
    await db.as(alice).order.update({ where: { id }, data: { note: "leave at the door" } });
    await expect(db.as(alice).order.update({ where: { id }, data: { status: "paid" } })).rejects.toMatchObject({
      code: "forbidden",
    });
    await db.as("member").order.update({ where: { id }, data: { status: "paid" } });
    expect((await db.as(alice).order.findUnique({ where: { id } })).status).toBe("paid");
  });
});
