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
import { handleOp } from "esoul-sdk";
import { pluginDb, sseStream } from "esoul-sdk/server";
import type { PluginOpContext, PluginRouteContext, PluginServerModule } from "esoul-sdk/server";
import type { ShopDemoDb } from "./.esoul/db";
// The shop's own ids and its catalogue event: the op records the change on the
// timeline, so an agent stocking the shop fills the departments too.
import { announcedEvent, catalogueChangedEvent, shopLookSetEvent } from "./app";
// What every op TAKES, declared once and shared with app.tsx: `handleOp` below
// parses with it and refuses a field it does not name; the tools are derived
// from the same object. There is no second schema here for a tool to drift from.
import { ImageUrl, ops, SALES_PAGE, type OpIn } from "./ops";

const db = (ctx: PluginOpContext) => pluginDb<ShopDemoDb>(ctx);

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
async function browse(ctx: PluginOpContext, { tag, q, cursor, limit }: OpIn<"browse">) {
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
    tagline: p.tagline,
    imageUrl: p.imageUrl,
  }));
  return { items, nextCursor: rows.length > take ? (items[items.length - 1]?.id ?? null) : null };
}

/** The owner: a product. The rule (`write: ["owner"]`) refuses everyone else. */
async function addProduct(ctx: PluginOpContext, input: OpIn<"add-product">) {
  const d = await db(ctx);
  const p = await d.product.create({
    data: {
      name: input.name,
      priceCents: input.priceCents,
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.tagline ? { tagline: input.tagline } : {}),
      ...(input.imageUrl ? { imageUrl: ImageUrl.parse(input.imageUrl) } : {}),
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
 * THE OWNER: a product's words and its picture.
 *
 * A shop is mostly writing. The first version of this app could only ADD a
 * product, so a description written badly was permanent and a photograph taken
 * later had nowhere to go — which is the same shape of hole as a catalogue you
 * cannot search: the data was fine and the shop could not be run.
 *
 * Only the fields named are touched, so setting a picture does not blank a
 * description somebody wrote. `active: false` takes a thing off the shelves and
 * keeps the row, which is what a shop actually wants for last winter's stock —
 * and for the rows a test left behind.
 */
async function updateProduct(ctx: PluginOpContext, parsed: OpIn<"update-product">) {
  const input = parsed as {
    productId: string;
    name?: string;
    priceCents?: number;
    description?: string;
    tagline?: string;
    tags?: string[];
    imageUrl?: string;
    active?: boolean;
  };
  const d = await db(ctx);
  const [before] = await d.product.findMany({ where: { id: input.productId }, take: 1, includeDeleted: false });
  if (!before) throw new Error(`no product ${input.productId} in this shop`);
  const tags = input.tags ? input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean) : undefined;
  const p = await d.product.update({
    where: { id: input.productId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(tags ? { tags } : {}),
    },
  });
  // The shelf changed if the DEPARTMENTS or the pictures did — every open
  // storefront re-reads on a catalogue change, so the id is derived from the
  // product and the reason, and a second identical edit is a no-op.
  await recordCatalogueChange(ctx, `changed ${p.name}`, `${p.id}:${changeKindOf(input)}`, p.tags ?? []);
  return { id: p.id, name: p.name, active: p.active, imageUrl: p.imageUrl ?? null, tagline: p.tagline ?? null };
}

/** What KIND of edit this was, so two different edits are two changes. */
function changeKindOf(input: Record<string, unknown>): string {
  return Object.keys(input)
    .filter((k) => k !== "productId")
    .sort()
    .join("+") || "nothing";
}

/**
 * THE OWNER: how the shop LOOKS — the picture across the top, the sentence
 * under its name, the accent.
 *
 * On the timeline rather than in a table, because it is one small fact about
 * the whole shop that every open page must re-read the moment it changes, and
 * because a look is the kind of thing somebody will want to undo. `null`
 * clears; a field left out is left alone.
 */
async function setLook(ctx: PluginOpContext, parsed: OpIn<"set-look">) {
  const input = parsed as { heroUrl?: string | null; tagline?: string | null; accent?: string };
  if (input.heroUrl === undefined && input.tagline === undefined && input.accent === undefined) {
    throw new Error("say what to change: heroUrl, tagline or accent");
  }
  await ctx.emit(shopLookSetEvent.eventName, {
    ...(input.heroUrl !== undefined ? { heroUrl: input.heroUrl } : {}),
    ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
    ...(input.accent !== undefined ? { accent: input.accent } : {}),
    at: Date.now(),
  });
  return { heroUrl: input.heroUrl ?? null, tagline: input.tagline ?? null, accent: input.accent ?? null };
}

/**
 * STAFF: a notice across the top of the shop ("closed Monday", "the bread is
 * out early today"). The op emits it, like every other fact — the storefront
 * reads the fold, so a notice appears on every open page without a refresh.
 * An empty text CLEARS the board rather than posting a blank.
 */
async function postNotice(ctx: PluginOpContext, { text }: OpIn<"post-notice">) {
  const trimmed = text.trim();
  await ctx.emit(announcedEvent.eventName, {
    id: `notice:${Date.now()}`,
    text: trimmed,
    at: Date.now(),
  });
  return { text: trimmed, cleared: !trimmed };
}

/**
 * WHO ELSE RUNS THIS SHOP.
 *
 * The owner types somebody's esoul email and picks one of the shop's own
 * words. Everything that decides whether that is allowed belongs to the
 * PLATFORM — the caller must own the app, the email must be a real account,
 * the word must be one `plugin.json` declares — so these two ops are
 * deliberately thin. An app that checked this itself would be an app that
 * could get it wrong.
 *
 * `role: ""` takes access back.
 */
async function listPeople(ctx: PluginOpContext) {
  const { listAppRoles } = await import("esoul-sdk/server");
  return listAppRoles(ctx);
}

/**
 * COMPOSE A ROLE on top of `staff`, in the shop's own terms — which statuses it
 * sees, which moves it may make, whether it sees the note, which desk actions
 * it may call — and hand the platform the generic definition. The platform
 * keeps it inside the manifest's `roles.custom` envelope and enforces it in
 * every read and write from then on; this op only translates words.
 */
async function defineRole(ctx: PluginOpContext, input: OpIn<"define-role">) {
  const { defineAppRole } = await import("esoul-sdk/server");
  const moves = Object.fromEntries(Object.entries(input.moves ?? {}).filter(([, to]) => to && to.length));
  const r = await defineAppRole(ctx, {
    name: input.name,
    base: "staff",
    describe: input.describe,
    ops: input.ops?.length ? input.ops : ["set-order-status"],
    models: {
      Order: {
        where: { status: [...input.statuses] },
        hide: input.hideNote ? ["note"] : [],
        ...(Object.keys(moves).length ? { update: { transitions: moves } } : {}),
      },
    },
  });
  if (!r.ok) throw new Error(r.error ?? "the role could not be composed");
  return { name: r.name ?? input.name, statuses: input.statuses, moves, hideNote: !!input.hideNote, ops: input.ops?.length ? input.ops : ["set-order-status"] };
}

async function removeRole(ctx: PluginOpContext, { name }: OpIn<"remove-role">) {
  const { removeAppRole } = await import("esoul-sdk/server");
  const r = await removeAppRole(ctx, name);
  if (!r.ok) throw new Error(r.error ?? "the role could not be removed");
  return { name, removed: true };
}

async function setPersonRole(ctx: PluginOpContext, { email, role }: OpIn<"set-person-role">) {
  const { setAppRole } = await import("esoul-sdk/server");
  const r = await setAppRole(ctx, { email, role });
  // The refusal is the platform's own words — "no esoul account has that
  // email", "this app has no role called manager" — and a person fixing a typo
  // needs to read exactly that, not "forbidden".
  if (!r.ok) throw new Error(r.error ?? "that did not work");
  return { email: r.email ?? email, role: r.role ?? "", removed: !r.role };
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
  /**
   * Anything else that must be true the moment the order exists, and false if
   * it does not — emptying the basket is the one caller. It runs inside the
   * SAME transaction as the order, so there is no instant where an order is
   * written and the basket that made it is still full.
   */
  alsoInTheSameBreath?: (tx: Awaited<ReturnType<typeof db>>) => Promise<void>,
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
  /** What this attempt is holding in the warehouse, so it can be given back. */
  const held: { sku: string; qty: number }[] = [];
  /**
   * GIVE THE GOODS BACK. A reservation the order never used is worse than a
   * refusal: nothing says it is stale, so the shelf reads empty while the
   * goods sit there. The release is best-effort per line and never throws —
   * the customer's error is the reason they came here, not the tidying-up.
   */
  const releaseWhatWeHeld = async () => {
    for (const h of held.reverse()) {
      try {
        const back = await stock!.call("release_stock", h);
        if (!back.ok) console.error(`[shop-demo] held stock not released: ${h.qty}x ${h.sku} — ${back.text}`);
      } catch (err) {
        console.error(`[shop-demo] held stock not released: ${h.qty}x ${h.sku} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  let order: { id: string };
  try {
    if (stock) {
      for (const l of lines) {
        const sku = byId.get(l.productId)?.sku;
        if (!sku) continue;
        const reserved = await stock.call("reserve_stock", { sku, qty: l.qty });
        if (!reserved.ok) throw new Error(`cannot take this order: ${reserved.text}`);
        held.push({ sku, qty: l.qty });
      }
    }
    // ONE BREATH: the order and whatever must stop being true when it exists.
    // A basket emptied after a committed order was two writes with a gap in
    // between, and every gap is a real state someone's session can end in —
    // an order paid for with a basket still holding it, which is how people
    // buy twice (2026-09-12).
    order = await d.$transaction(async (tx) => {
      const written = await tx.order.create({
        data: {
          totalCents,
          lines,
          shipTo,
          ...(note ? { note } : {}),
          // The first line's product, as the relation the rules check for scope.
          product: lines[0]!.productId,
        },
      });
      // ONE ROW PER THING SOLD, in the same breath as the order.
      //
      // `Order.lines` is the RECEIPT: what this person bought, at the prices
      // they paid, in one blob the order page renders. It answers a question
      // about ONE order and no question about the shop — "how much Earl Grey
      // did we sell in September" cannot be asked of a json column without
      // reading every order ever placed. These rows can be asked, by index.
      // They carry the price AT THE TIME, which is the other half: the
      // catalogue's price today is not what September's sales were worth.
      for (const l of lines) {
        await tx.orderLine.create({
          data: {
            order: written.id,
            product: l.productId,
            name: l.name,
            ...(byId.get(l.productId)?.sku ? { sku: byId.get(l.productId)!.sku } : {}),
            qty: l.qty,
            priceCents: l.priceCents,
          },
        });
      }
      if (alsoInTheSameBreath) await alsoInTheSameBreath(tx);
      return written;
    });
  } catch (err) {
    // Nothing was ordered, so nothing stays held. This is the whole reason the
    // reservation loop lives inside the try: a second line refusing used to
    // leave the first line's goods held for good (2026-09-12).
    await releaseWhatWeHeld();
    throw err;
  }

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

async function placeOrder(ctx: PluginOpContext, parsed: OpIn<"place-order">) {
  // The repo compiles with `strict: false`, where zod's inferred output makes
  // every field optional; the shapes the parser guarantees are named here.
  const input = parsed as { lines: Wanted[]; shipTo: ShipToAddress; note?: string };
  const d = await db(ctx);
  return priceAndPlace(ctx, d, input.lines, input.shipTo, input.note);
}

/* ─────────────────────────────── the basket ────────────────────────────── */

// The NAME may arrive empty, and only here: the shop fills it from the buyer's
// esoul account below. A `min(1)` made that fill unreachable — the parse
// refused the blank before the account could supply it, which is the shape a
// kind intention takes when the gate above it never let it run (2026-09-12).
// Street and city stay required: nobody else knows where the parcel goes.

/**
 * ONE product, with everything its page shows. `public`, because a detail page
 * is how a stranger decides to buy.
 */
async function product(ctx: PluginOpContext, { productId }: OpIn<"product">) {
  const d = await db(ctx);
  const [p] = await d.product.findMany({ where: { id: productId }, take: 1 });
  if (!p || !p.active) throw new Error(`no product ${productId} in this shop`);
  return {
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    sku: p.sku,
    description: p.description,
    tagline: p.tagline,
    imageUrl: p.imageUrl,
    tags: p.tags ?? [],
  };
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
async function addToCart(ctx: PluginOpContext, { productId, qty }: OpIn<"add-to-cart">) {
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
async function setCartQty(ctx: PluginOpContext, { productId, qty }: OpIn<"set-cart-qty">) {
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
  // The server says who you are: the base word the rules see, the composed
  // role's name when there is one, and what it may do — so the desk hides a
  // button the server would refuse, and never decides anything itself.
  const custom = ctx.viewer.custom?.role;
  const order = custom?.models.Order;
  return {
    name: who?.name ?? null,
    email: who?.email ?? null,
    role: ctx.viewer.role,
    customRole: ctx.viewer.customRole ?? null,
    can: custom ? { ops: custom.ops, statuses: (order?.where.status as string[] | undefined) ?? null, moves: order?.transitions?.moves ?? null, hidden: order?.hide ?? [] } : null,
  };
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
async function checkout(ctx: PluginOpContext, parsed: OpIn<"checkout">) {
  const { shipTo, note } = parsed as { shipTo: ShipToAddress; note?: string };
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
  // The basket is emptied INSIDE the order's transaction: either the order
  // exists and the basket is empty, or neither happened. `deleteMany` with no
  // `where` is every line the CALLER may delete — the manifest scopes
  // `CartLine` to the user, so it is their own basket and nobody else's.
  const placed = await priceAndPlace(
    ctx,
    d,
    cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
    { ...shipTo, name },
    note,
    async (tx) => {
      await tx.cartLine.deleteMany();
    },
  );
  await cartChanged(ctx, { lines: [], totalCents: 0 });
  // The receipt has somewhere to go. The shop does not STORE the address — it
  // belongs to the person's esoul account, and asking again next time costs
  // one read.
  return { ...placed, receiptTo: who?.email ?? null };
}

/**
 * WHAT SOLD — the question a shop actually asks its own till.
 *
 * Every line is a row, so this is index work rather than a walk over every
 * order: one product's history is `where: { product }`, a period is a cursor
 * page down `createdAt`. It answers in money and units, and it says the date
 * it can see back to — because `OrderLine` began with 0.6.0 and an order
 * placed before that has a receipt but no rows, and a total that quietly
 * omits last month is worse than one that names its horizon.
 *
 * Staff and the owner: the rules give them every row of this shop, and give a
 * customer only their own, so a customer calling this gets their own history
 * rather than a refusal.
 */
/**
 * A page of sales. `take + 1` is how "is there more" stops being a guess, and
 * the client refuses a `take` over 200 — so the page itself must leave room
 * for that extra row. Asking for 200 and being refused at 201 is the kind of
 * off-by-one that only ever appears once somebody runs it.
 */

async function sales(ctx: PluginOpContext, { productId, since, cursor, limit }: OpIn<"sales">) {
  const d = await db(ctx);
  const from = since ? new Date(since) : null;
  if (from && Number.isNaN(from.getTime())) throw new Error(`"${since}" is not a date I can read`);
  const take = limit ?? SALES_PAGE;
  const rows = await d.orderLine.findMany({
    where: {
      ...(productId ? { product: productId } : {}),
      ...(from ? { createdAt: { gte: from } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
  });
  const page = rows.slice(0, take);
  // Money and units per product, over the page. The caller walks the pages;
  // this never pretends to have summed rows it did not read.
  const byProduct = new Map<string, { productId: string | null; name: string; units: number; centsSold: number }>();
  for (const l of page) {
    const key = l.product ?? `name:${l.name}`;
    const seen = byProduct.get(key) ?? { productId: l.product ?? null, name: l.name, units: 0, centsSold: 0 };
    seen.units += l.qty;
    seen.centsSold += l.qty * l.priceCents;
    byProduct.set(key, seen);
  }
  const products = [...byProduct.values()].sort((a, b) => b.centsSold - a.centsSold);
  // HOW FAR BACK THIS CAN SEE. One indexed row, so it costs nothing to be
  // honest about.
  const [earliest] = await d.orderLine.findMany({ orderBy: { createdAt: "asc" }, take: 1 });
  return {
    lines: page.map((l) => ({
      orderId: l.order,
      productId: l.product,
      name: l.name,
      sku: l.sku,
      qty: l.qty,
      priceCents: l.priceCents,
      at: l.createdAt instanceof Date ? l.createdAt.toISOString() : String(l.createdAt),
    })),
    products,
    unitsSold: products.reduce((n, p) => n + p.units, 0),
    centsSold: products.reduce((n, p) => n + p.centsSold, 0),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    countsSalesFrom: earliest
      ? earliest.createdAt instanceof Date
        ? earliest.createdAt.toISOString()
        : String(earliest.createdAt)
      : null,
  };
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
async function refund(ctx: PluginOpContext, { orderId }: OpIn<"refund">) {
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
async function setOrderStatus(ctx: PluginOpContext, { orderId, status }: OpIn<"set-order-status">) {
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
async function orderNotice(ctx: PluginOpContext, { orderId }: OpIn<"order-notice">) {
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
async function fulfilOrder(ctx: PluginOpContext, { orderId }: OpIn<"fulfil-order">) {
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
  // Each handler receives PARSED input (./ops.ts) and refuses a field the op
  // does not take — `invalid`, naming the field. The tools are derived from
  // the same declarations, so nothing an agent passes is dropped on the way in.
  ops: {
    browse: handleOp(ops, "browse", browse),
    product: handleOp(ops, "product", product),
    "add-to-cart": handleOp(ops, "add-to-cart", addToCart),
    "set-cart-qty": handleOp(ops, "set-cart-qty", setCartQty),
    "view-cart": handleOp(ops, "view-cart", viewCart),
    me: handleOp(ops, "me", me),
    checkout: handleOp(ops, "checkout", checkout),
    "add-product": handleOp(ops, "add-product", addProduct),
    "update-product": handleOp(ops, "update-product", updateProduct),
    "set-look": handleOp(ops, "set-look", setLook),
    "post-notice": handleOp(ops, "post-notice", postNotice),
    "list-people": handleOp(ops, "list-people", listPeople),
    "set-person-role": handleOp(ops, "set-person-role", setPersonRole),
    "define-role": handleOp(ops, "define-role", defineRole),
    "remove-role": handleOp(ops, "remove-role", removeRole),
    "place-order": handleOp(ops, "place-order", placeOrder),
    "list-orders": handleOp(ops, "list-orders", listOrders),
    sales: handleOp(ops, "sales", sales),
    refund: handleOp(ops, "refund", refund),
    "set-order-status": handleOp(ops, "set-order-status", setOrderStatus),
    "order-notice": handleOp(ops, "order-notice", orderNotice),
    "fulfil-order": handleOp(ops, "fulfil-order", fulfilOrder),
  },
  routes: { "order-updates": orderUpdates },
};
