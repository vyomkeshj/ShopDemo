// The shop's server half — every op is one call into the app's own tables.
//
// Read this file for what is NOT in it: there is no access check anywhere.
// `pluginDb(ctx)` already knows who is calling (`ctx.viewer`) and which
// instance this is, and the manifest's `db` rules already say what each role
// may read and write. A customer's `order.findMany` returns their rows; a staff
// member's returns every row of THIS shop; a customer calling `refund` is
// refused by the rules, not by a line here. The one thing the server must do
// itself is what only a server can: PRICE the order from the catalogue, never
// from the client.
import "server-only";
import { z } from "zod";
import { pluginDb, sseStream } from "esoul-sdk/server";
import type { PluginOpContext, PluginRouteContext, PluginServerModule } from "esoul-sdk/server";
import type { ShopDemoDb } from "./.esoul/db";

const db = (ctx: PluginOpContext) => pluginDb<ShopDemoDb>(ctx);

const OrderInput = z.object({
  lines: z.array(z.object({ productId: z.string().min(1), qty: z.number().int().min(1).max(99) })).min(1).max(50),
  shipTo: z.object({ name: z.string().min(1).max(120), street: z.string().min(1).max(200), city: z.string().min(1).max(120) }),
  note: z.string().max(280).optional(),
});

const ProductInput = z.object({
  name: z.string().min(1).max(80),
  priceCents: z.number().int().min(0).max(100_000_000),
  sku: z.string().min(1).max(40).optional(),
});

/** Anyone on the link: the live catalogue. `read: anyone` in the manifest. */
async function browse(ctx: PluginOpContext) {
  const d = await db(ctx);
  const rows = await d.product.findMany({ where: { active: true }, orderBy: { createdAt: "asc" }, take: 100 });
  return rows.map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents, sku: p.sku }));
}

/** The owner: a product. The rule (`write: ["owner"]`) refuses everyone else. */
async function addProduct(ctx: PluginOpContext) {
  const input = ProductInput.parse(ctx.args);
  const d = await db(ctx);
  const p = await d.product.create({ data: { name: input.name, priceCents: input.priceCents, ...(input.sku ? { sku: input.sku } : {}) } });
  return { id: p.id };
}

/**
 * A signed-in caller: an order, priced HERE. The manifest says `create`
 * requires an account, so an anonymous caller gets `login-required` before
 * this runs; the client's UI turns that into a sign-in wall.
 */
async function placeOrder(ctx: PluginOpContext) {
  const input = OrderInput.parse(ctx.args);
  const d = await db(ctx);
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const products = await d.product.findMany({ where: { id: { in: ids }, active: true }, take: 200 });
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new Error(`no product ${l.productId} in this shop`);
    return { productId: p.id, name: p.name, qty: l.qty, priceCents: p.priceCents };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const order = await d.order.create({
    data: {
      totalCents,
      lines,
      shipTo: input.shipTo,
      ...(input.note ? { note: input.note } : {}),
      // The first line's product, as the relation the rules check for scope.
      product: lines[0]!.productId,
    },
  });
  return { orderId: order.id, totalCents };
}

/** Whatever this caller may see: their own orders, or the whole desk. */
async function listOrders(ctx: PluginOpContext) {
  const d = await db(ctx);
  const rows = await d.order.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((o) => ({
    id: o.id,
    status: o.status,
    totalCents: o.totalCents,
    lines: o.lines,
    shipTo: o.shipTo,
    note: o.note,
    createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
  }));
}

/** Staff or the owner. A customer is refused by `update: { roles: [staff, owner] }`. */
async function refund(ctx: PluginOpContext) {
  const { orderId } = z.object({ orderId: z.string().min(1) }).parse(ctx.args);
  const d = await db(ctx);
  const o = await d.order.update({ where: { id: orderId }, data: { status: "refunded" } });
  return { id: o.id, status: o.status };
}

/**
 * The `fulfil` TASK's hands. A task runs as the app's own code and calls this
 * op with the platform's internal leg, so `pluginDb(ctx)` here runs as
 * `internal`: rules bypassed, scope kept — it may mark any order of THIS shop
 * fulfilled and none of another's. (A task never imports server code itself;
 * it reaches its tables through an op, the way every platform app does.)
 */
async function fulfilOrder(ctx: PluginOpContext) {
  const { orderId } = z.object({ orderId: z.string().min(1) }).parse(ctx.args);
  const d = await db(ctx);
  const o = await d.order.update({ where: { id: orderId }, data: { status: "fulfilled" } });
  return { id: o.id, status: o.status };
}

/**
 * The desk, live: a Server-Sent Events route that re-reads THIS caller's
 * orders every two seconds and sends the list when it changes. Declared
 * `read`, so a read-only staff member may watch; a customer on the link may
 * not (their door is the ops declared `public`). The same `pluginDb(ctx)` —
 * a customer connecting through a share would see only their own rows, if the
 * app ever opened this route to them.
 */
async function orderUpdates(ctx: PluginRouteContext): Promise<Response> {
  const d = await pluginDb<ShopDemoDb>(ctx);
  return sseStream(
    async (send, signal) => {
      let last = "";
      const openedAt = Date.now();
      while (!signal.aborted && Date.now() - openedAt < 280_000) {
        const rows = await d.order.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
        const snapshot = JSON.stringify(rows.map((o) => [o.id, o.status, o.totalCents]));
        if (snapshot !== last) {
          last = snapshot;
          send("orders", rows.map((o) => ({ id: o.id, status: o.status, totalCents: o.totalCents })));
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
    { signal: ctx.request.signal },
  );
}

export const pluginServer: PluginServerModule = {
  ops: {
    browse,
    "add-product": addProduct,
    "place-order": placeOrder,
    "list-orders": listOrders,
    refund,
    "fulfil-order": fulfilOrder,
  },
  routes: { "order-updates": orderUpdates },
};
