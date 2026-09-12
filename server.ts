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
// The shop's own ids and its catalogue event: the op records the change on the
// timeline, so an agent stocking the shop fills the departments too.
import { catalogueChangedEvent } from "./app";

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
  /** What it IS, in the shop's own words. The detail page is mostly this. */
  description: z.string().max(2000).optional(),
  /** How the storefront groups things: "tea", "gifts", "new". Lower-case, few. */
  tags: z.array(z.string().min(1).max(24)).max(8).optional(),
});

const BrowseInput = z.object({
  /** One department, as the storefront's chips offer it. */
  tag: z.string().min(1).max(24).optional(),
  /** What the shopper typed. */
  q: z.string().min(1).max(60).optional(),
  /** The id of the last product on the previous page. */
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(48).optional(),
});

const PAGE = 24;

/**
 * THE SHELVES, ONE PAGE AT A TIME.
 *
 * A department and a search term are a WHERE, not a filter the browser applies
 * to whatever arrived. That is the whole difference between a catalogue and a
 * list: with 100 000 products, "gifts" has to find the gifts, not look for
 * them among the first page. Both questions are index lookups because
 * `plugin.json` declares the kinds for them (`tags` → `contains`, `name` →
 * `text`), and the page walks by CURSOR so the hundredth page costs what the
 * first one did.
 *
 * `read: anyone` in the manifest, so a stranger on the link reaches it.
 */
async function browse(ctx: PluginOpContext) {
  const { tag, q, cursor, limit } = BrowseInput.parse(ctx.args ?? {});
  const d = await db(ctx);
  const take = limit ?? PAGE;
  const rows = await d.product.findMany({
    where: {
      active: true,
      ...(tag ? { tags: { has: tag.trim().toLowerCase() } } : {}),
      ...(q ? { name: { contains: q.trim() } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
  });
  // One more than asked for, so "is there another page" is an answer rather
  // than a guess the shopper discovers by pressing More and getting nothing.
  const items = rows.slice(0, take).map((p) => ({
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    sku: p.sku,
    tags: p.tags ?? [],
    description: p.description,
  }));
  return { items, nextCursor: rows.length > take ? (items[items.length - 1]?.id ?? null) : null };
}

/** The owner: a product. The rule (`write: ["owner"]`) refuses everyone else. */
async function addProduct(ctx: PluginOpContext) {
  const input = ProductInput.parse(ctx.args);
  const d = await db(ctx);
  const p = await d.product.create({
    data: {
      name: input.name,
      priceCents: input.priceCents,
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.description ? { description: input.description } : {}),
      tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    },
  });
  // THE SHOP RECORDS ITS OWN CHANGE, whoever asked for it. The storefront
  // offers departments from the fold, and until this was here only the owner's
  // FORM recorded them — so a shop stocked by its agent had a catalogue and no
  // departments at all (seen on production, 2026-09-12). The change id is
  // derived from the product, so the UI's own optimistic dispatch of the same
  // event is a no-op rather than a second bump.
  await recordCatalogueChange(ctx, `added ${p.name}`, p.id, p.tags ?? []);
  return { id: p.id, name: p.name, tags: p.tags ?? [] };
}

/**
 * Put the catalogue's change on the shop's own timeline. A courtesy, like
 * telling the desk: a failure must not undo a product that exists.
 */
async function recordCatalogueChange(ctx: PluginOpContext, what: string, productId: string, tags: string[]): Promise<void> {
  try {
    // `ctx.emit` is the seam: the platform provides it in production and in a
    // workbench, and `runOp` captures it, so this line is testable rather than
    // host-only.
    await ctx.emit(catalogueChangedEvent.eventName, { changeId: `product:${productId}`, what, tags, at: Date.now() });
  } catch (err) {
    console.warn(`[shop-demo] product ${productId} added, catalogue change not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A signed-in caller: an order, priced HERE. The manifest says `create`
 * requires an account, so an anonymous caller gets `login-required` before
 * this runs; the client's UI turns that into a sign-in wall.
 */
interface Wanted { productId: string; qty: number }
interface ShipToAddress { name: string; street: string; city: string }

/**
 * Price a basket HERE, from the catalogue, never from the client. Everything
 * that turns a list of wishes into an order goes through this: the direct
 * "order one" button and the cart's checkout both land here, so there is one
 * place that decides what a thing costs and whether the goods can be held.
 */
async function priceAndPlace(
  ctx: PluginOpContext,
  d: Awaited<ReturnType<typeof db>>,
  wanted: Wanted[],
  shipTo: ShipToAddress,
  note?: string,
) {
  const ids = [...new Set(wanted.map((l) => l.productId))];
  const products = await d.product.findMany({ where: { id: { in: ids }, active: true }, take: 200 });
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = wanted.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new Error(`no product ${l.productId} in this shop`);
    return { productId: p.id, name: p.name, qty: l.qty, priceCents: p.priceCents };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);

  // If a warehouse stands in the `stock` slot, hold the goods before taking
  // the order. The shop does not know WHICH warehouse — the owner bound it —
  // and it cannot do anything to it beyond what `stock/v1` names. A refusal
  // here ("only 2 free") is the ledger's own words, and the customer sees it
  // instead of an order the shop cannot fill.
  const stock = ctx.apps?.stock;
  if (stock) {
    for (const l of lines) {
      const sku = byId.get(l.productId)?.sku;
      if (!sku) continue;
      const held = await stock.call("reserve_stock", { sku, qty: l.qty });
      if (!held.ok) throw new Error(`cannot take this order: ${held.text}`);
    }
  }

  const order = await d.order.create({
    data: {
      totalCents,
      lines,
      shipTo,
      ...(note ? { note } : {}),
      // The first line's product, as the relation the rules check for scope.
      product: lines[0]!.productId,
    },
  });

  // Ring the desk. Anyone who may PLACE an order may ring it — the manifest's
  // `channel.topics["new-order"].mayAddress` names them — and none of them can
  // address another CUSTOMER.
  //
  // THE ORDER IS ALREADY WRITTEN. Telling the desk is a courtesy, and a
  // courtesy must never undo a completed write: the first version let a
  // refused notify throw out of here, so an order that existed came back to
  // the customer as "forbidden" and they tried again (2026-09-11).
  let deskTold = true;
  try {
    await ctx.notify("new-order", { orderId: order.id, totalCents }, { to: { role: "staff" } });
  } catch (err) {
    deskTold = false;
    console.warn(`[shop-demo] order ${order.id} placed, desk not told: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { orderId: order.id, totalCents, deskTold };
}

async function placeOrder(ctx: PluginOpContext) {
  // The repo compiles with `strict: false`, where zod's inferred output makes
  // every field optional; the shapes the parser guarantees are named here.
  const input = OrderInput.parse(ctx.args) as { lines: Wanted[]; shipTo: ShipToAddress; note?: string };
  const d = await db(ctx);
  return priceAndPlace(ctx, d, input.lines, input.shipTo, input.note);
}

/* ─────────────────────────────── the basket ────────────────────────────── */

// The NAME may arrive empty, and only here: the shop fills it from the buyer's
// esoul account below. A `min(1)` made that fill unreachable — the parse
// refused the blank before the account could supply it, which is the shape a
// kind intention takes when the gate above it never let it run (2026-09-12).
// Street and city stay required: nobody else knows where the parcel goes.
const ShipTo = z.object({ name: z.string().max(120), street: z.string().min(1).max(200), city: z.string().min(1).max(120) });

/**
 * ONE product, with everything its page shows. `public`, because a detail page
 * is how a stranger decides to buy.
 */
async function product(ctx: PluginOpContext) {
  const { productId } = z.object({ productId: z.string().min(1) }).parse(ctx.args);
  const d = await db(ctx);
  const [p] = await d.product.findMany({ where: { id: productId }, take: 1 });
  if (!p || !p.active) throw new Error(`no product ${productId} in this shop`);
  return { id: p.id, name: p.name, priceCents: p.priceCents, sku: p.sku, description: p.description, tags: p.tags ?? [] };
}

/**
 * The basket, as the person sees it: their own lines, priced from the
 * catalogue now rather than from whatever the price was when they added it.
 *
 * There is no access check here either. `CartLine` is `owner: "creator"` with
 * `read: ["creator"]`, so `findMany` returns THIS person's basket and there is
 * no argument that would return anyone else's.
 */
async function viewCart(ctx: PluginOpContext) {
  const d = await db(ctx);
  const lines = await d.cartLine.findMany({ orderBy: { createdAt: "asc" }, take: 100 });
  if (!lines.length) return { lines: [], totalCents: 0 };
  const products = await d.product.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.product).filter((x): x is string => !!x))] } }, take: 200 });
  const byId = new Map(products.map((p) => [p.id, p]));
  const out = lines
    .map((l) => {
      const p = l.product ? byId.get(l.product) : undefined;
      if (!p) return null; // the shop stopped selling it; the line is simply not shown
      return { lineId: l.id, productId: p.id, name: p.name, qty: l.qty, priceCents: p.priceCents, sku: p.sku, tags: p.tags ?? [] };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return { lines: out, totalCents: out.reduce((sum, l) => sum + l.priceCents * l.qty, 0) };
}

/** Tell this person their own basket moved, so a screen they left open agrees with the agent that changed it. */
async function cartChanged(ctx: PluginOpContext, cart: { lines: unknown[]; totalCents: number }) {
  const ids = ctx.viewer.viewerIds ?? [];
  if (!ids.length) return;
  try {
    await ctx.notify("cart", { count: cart.lines.length, totalCents: cart.totalCents }, { to: { viewerIds: ids } });
  } catch (err) {
    // A basket that changed is still changed. Saying so is a courtesy.
    console.warn(`[shop-demo] cart changed, nobody told: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Put something in the basket, or add to what is already there. */
async function addToCart(ctx: PluginOpContext) {
  const { productId, qty } = z.object({ productId: z.string().min(1), qty: z.number().int().min(1).max(99).default(1) }).parse(ctx.args);
  const d = await db(ctx);
  const [p] = await d.product.findMany({ where: { id: productId, active: true }, take: 1 });
  if (!p) throw new Error(`no product ${productId} in this shop`);
  const [existing] = await d.cartLine.findMany({ where: { product: productId }, take: 1 });
  if (existing) await d.cartLine.update({ where: { id: existing.id }, data: { qty: Math.min(99, existing.qty + qty) } });
  else await d.cartLine.create({ data: { product: productId, qty } });
  const cart = await viewCart(ctx);
  await cartChanged(ctx, cart);
  return cart;
}

/** Change how many — or zero, which takes it out. */
async function setCartQty(ctx: PluginOpContext) {
  const { productId, qty } = z.object({ productId: z.string().min(1), qty: z.number().int().min(0).max(99) }).parse(ctx.args);
  const d = await db(ctx);
  const [existing] = await d.cartLine.findMany({ where: { product: productId }, take: 1 });
  if (!existing) throw new Error("that is not in your basket");
  if (qty === 0) await d.cartLine.delete({ where: { id: existing.id } });
  else await d.cartLine.update({ where: { id: existing.id }, data: { qty } });
  const cart = await viewCart(ctx);
  await cartChanged(ctx, cart);
  return cart;
}

/**
 * WHO THE SHOP IS TALKING TO, for the checkout form. The person signed into
 * esoul already; asking them to type their own name again is a small
 * rudeness. `public` + `requires: account`, because it only ever answers about
 * the CALLER — there is no argument for whose profile to read.
 */
async function me(ctx: PluginOpContext) {
  const who = await whoIsThis(ctx);
  return { name: who?.name ?? null, email: who?.email ?? null };
}

/**
 * The caller's account, or null — never a throw. A profile read that fails
 * (the platform's database blinking, a test with no database at all) must
 * not stop a person from buying: the name is a courtesy, the order is the
 * point.
 */
async function whoIsThis(ctx: PluginOpContext): Promise<{ name: string | null; email: string | null } | null> {
  try {
    const { viewerProfile } = await import("esoul-sdk/server");
    return await viewerProfile(ctx.viewer);
  } catch {
    return null;
  }
}

/**
 * Buy what is in the basket. Priced HERE, from the catalogue — a basket is a
 * list of wishes, not a quote — then the basket is emptied, because an order
 * that exists and a basket that still holds it is how people buy twice.
 */
async function checkout(ctx: PluginOpContext) {
  const { shipTo, note } = z.object({ shipTo: ShipTo, note: z.string().max(280).optional() }).parse(ctx.args) as { shipTo: ShipToAddress; note?: string };
  // WHO IS BUYING, in words. The shop asks the platform rather than the
  // customer: they signed into esoul already, so making them type their name
  // again is a small rudeness, and a receipt needs somewhere to go. One read,
  // here, at the one moment it matters — not on every page.
  const who = await whoIsThis(ctx);
  const d = await db(ctx);
  const cart = await viewCart(ctx);
  if (!cart.lines.length) throw new Error("your basket is empty");
  // Their esoul name when the form left it blank; never overriding what they
  // typed. Still nothing means nobody knows who the parcel is for — say that,
  // rather than posting it to an empty label.
  const name = shipTo.name?.trim() || who?.name?.trim() || "";
  if (!name) throw new Error("we need a name for the parcel — type one, or sign in so we can use your account's");
  const placed = await priceAndPlace(ctx, d, cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })), { ...shipTo, name }, note);
  const mine = await d.cartLine.findMany({ take: 100 });
  for (const l of mine) await d.cartLine.delete({ where: { id: l.id } });
  await cartChanged(ctx, { lines: [], totalCents: 0 });
  // The receipt has somewhere to go. The shop does not STORE the address — it
  // belongs to the person's esoul account, and asking again next time costs
  // one read.
  return { ...placed, receiptTo: who?.email ?? null };
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
  // The customer hears about their own refund — and only they do. Two
  // declarations make that true: `order-status` is `audience: viewer`, so it
  // goes to that person's channel and nobody else holds a token for it; and
  // `mayAddress: [staff, owner]` is what lets the desk aim it at them at all.
  // Without that second line the platform refuses this call — which is how
  // the box drive caught the shop promising something its manifest did not.
  if (o.ownerId) await ctx.notify("order-status", { orderId: o.id, status: o.status }, { to: { viewerIds: [o.ownerId] } });
  return { id: o.id, status: o.status };
}

/**
 * THE DESK, in words: move one order along. This is the op behind
 * `set_order_status_<base>`, which is how an owner runs the shop by talking —
 * "mark order 91 preparing" — and how their agent does it for them.
 *
 * There is still no access check here. `update: { roles: [staff, owner] }`
 * refuses a customer at the rules, and the op is declared `write`, so a
 * customer never reaches it at all. What this function owns is the part only
 * a server can: that the status is one the shop recognises, in an order that
 * makes sense, and that the person whose order it is hears about it.
 */
const STATUSES = ["new", "preparing", "shipped", "fulfilled", "refunded"] as const;

async function setOrderStatus(ctx: PluginOpContext) {
  const { orderId, status } = z
    .object({ orderId: z.string().min(1), status: z.enum(STATUSES) })
    .parse(ctx.args);
  const d = await db(ctx);
  const o = await d.order.update({ where: { id: orderId }, data: { status } });
  // TELLING THE CUSTOMER IS A SEPARATE, DURABLE JOB.
  //
  // A real shop sends an email here, and an email is the thing most likely to
  // be slow, to fail, and to need retrying — none of which belongs in the
  // request that moved the order. So the op does the one thing only it can
  // (change the record) and hands the telling to a TASK: it survives this
  // request, retries on its own, and its steps are on the timeline.
  //
  // `kickPluginTask` is fire-and-forget by design. The status has already
  // moved; a kick that fails must not un-move it, so the failure is reported
  // and the record stands.
  const { kickPluginTask } = await import("esoul-sdk");
  const kicked = await kickPluginTask({
    applicationType: "plugin_shop_demo",
    taskName: "tell-customer",
    identifier: { workspaceId: ctx.workspaceId, nodeId: ctx.nodeId, instanceName: ctx.instanceName },
    data: { orderId: o.id, status: o.status },
  }).catch(() => ({ ok: false, status: 0 }));
  return { id: o.id, status: o.status, shipTo: o.shipTo, telling: kicked.ok };
}

/**
 * What the telling job needs to know, and nothing more: whose order it is and
 * where it stands. Declared `write`, so only the app's own internal leg (and
 * the desk) reaches it — a customer has no reason to ask this question and no
 * way to ask it about someone else.
 */
async function orderNotice(ctx: PluginOpContext) {
  const { orderId } = z.object({ orderId: z.string().min(1) }).parse(ctx.args);
  const d = await db(ctx);
  const [o] = await d.order.findMany({ where: { id: orderId }, take: 1 });
  if (!o) throw new Error(`no order ${orderId} in this shop`);
  const shipTo = (o.shipTo ?? {}) as { name?: string };
  return { id: o.id, status: o.status, ownerId: o.ownerId, name: typeof shipTo.name === "string" ? shipTo.name : null };
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
  // `ownerId` so the task can tell THIS customer and nobody else. It is the
  // platform's column, stamped when the row was created, and it leaves the
  // server only into the app's own task.
  return { id: o.id, status: o.status, ownerId: o.ownerId };
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
    product,
    "add-to-cart": addToCart,
    "set-cart-qty": setCartQty,
    "view-cart": viewCart,
    me,
    checkout,
    "add-product": addProduct,
    "place-order": placeOrder,
    "list-orders": listOrders,
    refund,
    "set-order-status": setOrderStatus,
    "order-notice": orderNotice,
    "fulfil-order": fulfilOrder,
  },
  routes: { "order-updates": orderUpdates },
};
