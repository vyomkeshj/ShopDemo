// Shop (reference) — the SDK's smallest complete business app.
//
// NOT "use client": this is the SCHEMA module, evaluated in the server bundle.
// The UI lives in ./ui/shop-demo-ui.tsx; the server half in ./server.ts.
//
// WHERE THE DATA LIVES — the split every business app makes:
//   · the FOLD (events on the timeline): what is shared, small and worth
//     scrubbing — here, the catalogue's version and staff announcements.
//   · the app's own TABLES (plugin.json `db`, reached through `pluginDb(ctx)`
//     in server.ts): what is per-person and large and must never revert —
//     products, orders, addresses. A customer's read of `order` is scoped to
//     their own rows by the platform; staff read them all; nobody writes the
//     catalogue but the owner. The app holds NO access checks.
//
// The three roles are the manifest's (`roles`): customer, staff, owner. The
// UI reads `useViewer()` to decide which screen; the server never has to,
// because the rules already decided what each caller's client can see.
import { z } from "zod";
import {
  defineBindingEvent,
  definePluginChannel,
  type BindingHolder,
  EventTypes,
  incompleteStateNotice,
  nanoid,
  type ApplicationIdentifier,
  type ApplicationPort,
  type ApplicationSchema,
  type EventData,
  type EventDefinition,
} from "esoul-sdk";
import { ShopDemoUi } from "./ui/shop-demo-ui";

export const PLUGIN_ID = "shop-demo";
export const APP_TYPE = "plugin_shop_demo";

export interface ShopAnnouncement {
  id: string;
  text: string;
  at: number;
}

/**
 * The shop's slots, from its manifest. A `stock` slot is OPTIONAL: a shop with
 * no warehouse behind it still sells — it simply cannot hold anything back.
 */
export const SHOP_SLOTS = ["stock"] as const;

/** The owner's consent, on the timeline: which app fills which slot. */
export const bindingSetEvent = defineBindingEvent<ShopDemoData>({ applicationType: APP_TYPE, slots: SHOP_SLOTS });

export interface ShopDelivery {
  /** `<orderId>:<status>` — one delivery per status per order, so a retry is not a second email. */
  id: string;
  orderId: string;
  status: string;
  at: number;
}

export interface ShopDemoData extends ApplicationIdentifier, BindingHolder {
  /** Bumped whenever the catalogue changes, so every open UI refetches it. */
  catalogueVersion: number;
  /**
   * THE DEPARTMENTS, in the fold on purpose. A storefront has to offer every
   * department, and with 100 000 products it cannot learn them from a page of
   * results — `SELECT DISTINCT` over a catalogue is the scan the tables exist
   * to avoid. A shop's department list is small, shared, and worth scrubbing,
   * which is exactly what the fold is for; the products themselves stay in the
   * table where they belong.
   */
  departments: string[];
  /** Staff notes to customers ("closed on Monday"). Small, shared, scrubbable. */
  announcements: ShopAnnouncement[];
  /**
   * What the shop has told which customer. The point is IDEMPOTENCE: a task
   * that retries — and a durable task will — must not tell the same person the
   * same thing twice, and the only honest record of "already told" is one the
   * retry can read. It is on the timeline, so it can also be looked at.
   */
  deliveries: ShopDelivery[];
  /**
   * HOW IT LOOKS. Absent on a shop nobody has dressed yet — and the storefront
   * has to be good-looking then too, which is why every field here is
   * optional and the UI draws its own picture when there is none.
   */
  look?: ShopLook;
}

/** The shop's own five palettes, by name. Never raw CSS from an event. */
export const ACCENTS = ["stone", "amber", "rose", "emerald", "indigo"] as const;

export interface ShopLook {
  /** A photograph across the top, as an https link, or null for the shop's own pattern. */
  heroUrl?: string | null;
  /** The line under the shop's name. */
  tagline?: string | null;
  accent?: (typeof ACCENTS)[number];
}

const MAX_ANNOUNCEMENTS = 20;
const MAX_DEPARTMENTS = 60;

const envelope = (eventName: string, args: Record<string, any>, eventData: unknown): EventData<any> => ({
  eventName,
  eventData,
  timestamp: Date.now(),
  workspaceId: args.workspaceId,
  applicationId: args.applicationId || args.nodeId,
  instanceName: args.instanceName,
  chatIdSource: args.chatIdSource,
});

/** The catalogue changed (a product added, a price set). Idempotent by changeId. */
export const catalogueChangedEvent: EventDefinition<ShopDemoData> = {
  eventName: "plugin_shop_demo_catalogue_changed",
  type: EventTypes.Client,
  triggerMeta: {
    displayName: "Shop catalogue changed",
    description: "Fires when the owner adds a product or changes a price. eventData: {changeId, what}.",
    sampleVariables: ["event.what"],
  },
  dataCreator: (args) =>
    envelope("plugin_shop_demo_catalogue_changed", args, {
      changeId: args.changeId ?? nanoid(),
      what: typeof args.what === "string" ? args.what : "catalogue",
      // The departments this change introduced, so the storefront can offer
      // them without asking the catalogue what its departments are.
      tags: Array.isArray(args.tags) ? args.tags.filter((t: unknown) => typeof t === "string") : [],
      at: args.at ?? Date.now(),
    }),
  processor: (state, event) => {
    const d = event.eventData || {};
    if (typeof d.changeId !== "string" || !d.changeId) return state;
    // Idempotent: the version is a count of DISTINCT changes, kept as the last
    // applied id so a retried dispatch cannot bump twice.
    const seen = (state as ShopDemoData & { _lastChangeId?: string })._lastChangeId;
    if (seen === d.changeId) return state;
    // Departments accumulate, sorted, never duplicated — a set kept in the
    // order a person reads. Capped, because a fold is not a place for
    // unbounded growth and a shop with 200 departments has a different problem.
    const incoming = Array.isArray(d.tags) ? (d.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const departments = [...new Set([...(state.departments ?? []), ...incoming])].sort().slice(0, MAX_DEPARTMENTS);
    return {
      ...state,
      catalogueVersion: (state.catalogueVersion ?? 0) + 1,
      departments,
      _lastChangeId: d.changeId,
    } as ShopDemoData;
  },
};

/**
 * HOW THE SHOP LOOKS: the picture across the top, the line under its name, the
 * accent. One small fact about the WHOLE shop, so it lives on the timeline
 * rather than in a table — every open storefront hears it the moment it
 * changes, and a look somebody regrets can be scrubbed like anything else.
 *
 * A field that is absent is LEFT ALONE; `null` clears it. Those are different
 * on purpose: "I am only changing the tagline" must not blank the photograph.
 */
export const shopLookSetEvent: EventDefinition<ShopDemoData> = {
  eventName: "plugin_shop_demo_look_set",
  type: EventTypes.Client,
  triggerMeta: {
    displayName: "Shop look changed",
    description: "Fires when the owner sets the shop's hero picture, tagline or accent. eventData: {heroUrl, tagline, accent}.",
    sampleVariables: ["event.tagline", "event.accent"],
  },
  dataCreator: (args) =>
    envelope("plugin_shop_demo_look_set", args, {
      ...(args.heroUrl !== undefined ? { heroUrl: args.heroUrl } : {}),
      ...(args.tagline !== undefined ? { tagline: args.tagline } : {}),
      ...(args.accent !== undefined ? { accent: args.accent } : {}),
      at: args.at ?? Date.now(),
    }),
  processor: (state, event) => {
    const d = event.eventData || {};
    const look = { ...(state.look ?? {}) };
    // An https link or nothing. A fold is read by every visitor's browser, so
    // what a processor keeps is what a page will render: the check belongs
    // here as well as in the op, because an event can arrive from anywhere.
    if (d.heroUrl !== undefined) look.heroUrl = typeof d.heroUrl === "string" && /^https:\/\/[^\s]+$/i.test(d.heroUrl) ? d.heroUrl : null;
    if (d.tagline !== undefined) look.tagline = typeof d.tagline === "string" ? d.tagline.slice(0, 160) : null;
    if (d.accent !== undefined && (ACCENTS as readonly string[]).includes(String(d.accent))) look.accent = String(d.accent) as ShopLook["accent"];
    return { ...state, look } as ShopDemoData;
  },
};

/** A staff announcement. Idempotent by id. */
export const announcedEvent: EventDefinition<ShopDemoData> = {
  eventName: "plugin_shop_demo_announced",
  type: EventTypes.Client,
  dataCreator: (args) =>
    envelope("plugin_shop_demo_announced", args, {
      id: args.id ?? nanoid(),
      text: String(args.text ?? "").slice(0, 280),
      at: args.at ?? Date.now(),
    }),
  processor: (state, event) => {
    const d = event.eventData || {};
    if (typeof d.id !== "string" || !d.id || typeof d.text !== "string" || !d.text) return state;
    const list = state.announcements ?? [];
    if (list.some((a) => a.id === d.id)) return state;
    const a: ShopAnnouncement = { id: d.id, text: d.text, at: typeof d.at === "number" ? d.at : 0 };
    return { ...state, announcements: [a, ...list].slice(0, MAX_ANNOUNCEMENTS) };
  },
};

/**
 * The shop's realtime channel, in code. The manifest says WHO hears each topic
 * (`channel.topics[*].audience`); this says what the topics ARE and what rides
 * on them. Both halves are needed: without the manifest the platform mints one
 * channel for everyone, and without this the mint has no topics to issue.
 */
export const shopChannel = definePluginChannel({
  applicationType: APP_TYPE,
  topics: {
    /** The catalogue moved. Anyone watching the shop may hear it. */
    catalogue: { schema: z.object({ what: z.string() }) },
    /** ONE customer's order moved. Only they hear it (`audience: viewer`). */
    "order-status": { schema: z.object({ orderId: z.string(), status: z.string(), to: z.string().optional(), by: z.string().optional() }) },
    /** A new order reached the desk. Only staff hear it (`audience: role:staff`). */
    "new-order": { schema: z.object({ orderId: z.string(), totalCents: z.number() }) },
    /** This person's own basket moved — so an open screen and the agent agree. */
    cart: { schema: z.object({ count: z.number(), totalCents: z.number() }) },
  },
});

const MAX_DELIVERIES = 50;

/** One telling, recorded. Idempotent by `<orderId>:<status>`. */
export const toldCustomerEvent: EventDefinition<ShopDemoData> = {
  eventName: "plugin_shop_demo_told_customer",
  // Dispatched by the app's own TASK, never by a screen — but the platform's
  // vocabulary for "an event" is Client/Workflow/Workspace, and a task's
  // dispatch rides the same path a client one does.
  type: EventTypes.Client,
  triggerMeta: {
    displayName: "Shop told a customer",
    description: "Fires when the shop has told a customer their order moved. eventData: {orderId, status}.",
    sampleVariables: ["event.orderId", "event.status"],
  },
  dataCreator: (args) =>
    envelope("plugin_shop_demo_told_customer", args, {
      orderId: String(args.orderId ?? ""),
      status: String(args.status ?? ""),
      at: args.at ?? Date.now(),
    }),
  processor: (state, event) => {
    const d = event.eventData || {};
    if (!d.orderId || !d.status) return state;
    const id = `${d.orderId}:${d.status}`;
    const list = state.deliveries ?? [];
    if (list.some((x) => x.id === id)) return state; // a retry is not a second email
    const row: ShopDelivery = { id, orderId: String(d.orderId), status: String(d.status), at: typeof d.at === "number" ? d.at : 0 };
    return { ...state, deliveries: [row, ...list].slice(0, MAX_DELIVERIES) };
  },
};

export interface Cart {
  lines: { lineId: string; productId: string; name: string; qty: number; priceCents: number; sku: string | null; tags: string[] }[];
  totalCents: number;
}

/** A basket in words — what a tool hands back, and what an agent reads aloud. */
export function describeCart(cart: Cart, shopName: string): string {
  if (!cart?.lines?.length) return `The basket at "${shopName}" is empty.`;
  const lines = cart.lines.map((l) => `${l.qty} × ${l.name} — ${((l.priceCents * l.qty) / 100).toFixed(2)} (id ${l.productId})`);
  return `${lines.join("\n")}\nTotal ${(cart.totalCents / 100).toFixed(2)}.`;
}

export function describeShop(s: Pick<ShopDemoData, "instanceName" | "catalogueVersion" | "announcements" | "departments" | "look">): string {
  const n = s.announcements?.length ?? 0;
  const depts = s.departments ?? [];
  const look = s.look ?? {};
  const dressed = [look.heroUrl ? "a hero picture" : null, look.tagline ? `the line "${look.tagline}"` : null, look.accent ? `${look.accent} accent` : null]
    .filter(Boolean)
    .join(", ");
  return (
    `Shop "${s.instanceName}": catalogue version ${s.catalogueVersion ?? 0}, ${n} announcement${n === 1 ? "" : "s"}. ` +
    (dressed ? `Its look: ${dressed}. ` : "Not dressed yet — set_shop_look takes a hero picture, a tagline and an accent. ") +
    (depts.length ? `Departments: ${depts.join(", ")}. ` : "No departments yet. ") +
    `Products and orders live in the app's own tables — use browse_shop (narrow it by department or search term; it pages) ` +
    `and list_orders; a customer's list is theirs alone.`
  );
}

export const pluginSchema: ApplicationSchema<ShopDemoData> = {
  applicationType: APP_TYPE,
  /**
   * `fulfil` — the durable half of the desk: a staff member kicks it for an
   * order, it marks the order fulfilled through the app's own op and tells the
   * desk. A task runs as the app's own code; it reaches the tables through an
   * op (the internal leg), never by importing server code into this module.
   * `ctx.kickedBy` is who asked — attribution, so the answer can be addressed
   * back to them; never authority.
   */
  tasks: [
    {
      /**
       * TELLING THE CUSTOMER — the durable half of a status change.
       *
       * A real shop sends an email here, and an email is slow, fails, and
       * needs retrying: exactly the work that must not sit inside the request
       * that moved the order. So `set-order-status` moves the record and kicks
       * this, which survives the request and retries on its own.
       *
       * Three things make a retry safe, and a durable task WILL retry:
       *   · every side effect is inside a `step.run`, so a replay does not
       *     repeat one that already happened (the platform's oldest rule);
       *   · the shop reads its own fold first and stops if this order already
       *     went out at this status — "already told" has to be readable, or
       *     idempotence is a hope;
       *   · the record of telling is itself idempotent (`<orderId>:<status>`).
       */
      taskName: "tell-customer",
      description: "Tell one customer their order moved — the durable half of a status change.",
      concurrency: { limit: 5, scope: "per-app" },
      handler: async (ctx) => {
        const orderId = String(ctx.eventData?.orderId ?? "");
        const status = String(ctx.eventData?.status ?? "");
        if (!orderId || !status) throw new Error("tell-customer: eventData needs {orderId, status}");

        // Already told? The fold is the record, and reading it costs nothing
        // next to sending the same person the same email twice.
        const already = await ctx.step.run("read-what-was-told", async () => {
          const state = await ctx.getState();
          return (state?.deliveries ?? []).some((d) => d.id === `${orderId}:${status}`);
        });
        if (already) return;

        const order = await ctx.step.run("read-the-order", async () => {
          const { callPluginOp } = await import("esoul-sdk");
          return callPluginOp<{ id: string; status: string; ownerId: string | null; name: string | null }>(
            PLUGIN_ID,
            "order-notice",
            ctx.identifier.nodeId,
            { orderId },
          );
        });
        // The order moved again while this was queued: what is true now wins,
        // and the message for the older status is simply not sent.
        if (!order || order.status !== status) return;

        await ctx.step.run("tell-them", async () => {
          // Where the email would go. It reaches ONE person: `order-status` is
          // declared `audience: viewer`, so the platform hands no other
          // customer a token for this channel.
          if (!order.ownerId) return;
          await ctx.notify(
            "order-status",
            { orderId, status, to: order.name ?? undefined, by: "the shop" },
            { to: { viewerIds: [order.ownerId] } },
          );
        });

        await ctx.step.run("record-that-we-told-them", async () => {
          await ctx.dispatchEvent("plugin_shop_demo_told_customer", { orderId, status });
        });
      },
    },
    {
      taskName: "fulfil",
      description: "Mark an order of this shop fulfilled and notify the desk.",
      concurrency: { limit: 1, scope: "per-app" },
      handler: async (ctx) => {
        const orderId = String(ctx.eventData?.orderId ?? "");
        if (!orderId) throw new Error("fulfil: eventData.orderId is required");
        const order = await ctx.step.run("fulfil-order", async () => {
          const { callPluginOp } = await import("esoul-sdk");
          return callPluginOp<{ id: string; status: string; ownerId: string | null }>(PLUGIN_ID, "fulfil-order", ctx.identifier.nodeId, { orderId });
        });
        await ctx.step.run("tell-the-customer", async () => {
          // ONE customer hears this. `order-status` is declared
          // `audience: viewer`, so the message goes to the order owner's own
          // channel and no other customer is handed a token for it. A task is
          // the app's own code, which is why it may address someone at all.
          if (!order?.ownerId) return;
          await ctx.notify(
            "order-status",
            { orderId, status: "fulfilled", by: ctx.kickedBy?.kind ?? "task" },
            { to: { viewerIds: [order.ownerId] } },
          );
        });
      },
    },
  ],
  description:
    "The SDK's reference shop: a catalogue anyone may browse, orders a signed-in customer places and sees only their own, a staff desk, an owner who sets prices. Products, orders and addresses are the app's own tables, scoped by the platform.",
  channel: shopChannel,
  reactNode: ShopDemoUi,
  reconstructStateFromEventLog: true,
  events: [catalogueChangedEvent, shopLookSetEvent, announcedEvent, toldCustomerEvent, bindingSetEvent as never],
  getPorts: (): ApplicationPort[] => [],
  stateCreator: (identifier) => ({ ...identifier, catalogueVersion: 0, departments: [], announcements: [], deliveries: [] }),

  getStateDescription: (state: ShopDemoData) => {
    const notice = incompleteStateNotice({
      title: "Shop",
      instanceName: state?.instanceName,
      shape: { lists: { announcements: state?.announcements, deliveries: state?.deliveries } },
    });
    if (notice) return notice;
    return describeShop(state);
  },

  // `eventCallback` is unused on purpose: every tool here goes through an OP,
  // and the op records anything that belongs on the timeline (`ctx.emit`). A
  // tool that also dispatched its own event double-recorded it, with a random
  // id the reducer could not dedupe (2026-09-12).
  toolkitCreator: (identifier, forChatId, _eventCallback) => {
    const base = identifier.instanceName.replace(/[^a-zA-Z0-9]/g, "_");
    const idArgs = { ...identifier, applicationId: identifier.nodeId, chatIdSource: forChatId };
    const op = async <T,>(name: string, args?: unknown): Promise<T> => {
      const { callPluginOp } = await import("esoul-sdk");
      return callPluginOp<T>(PLUGIN_ID, name, identifier.nodeId, args);
    };
    const tools: Record<string, any> = {
      [`browse_shop_${base}`]: {
        // An agent shopping a large catalogue needs the same two questions the
        // storefront asks, and the same paging: "the tea ones", "anything with
        // grey in the name", "the next twenty-four".
        description:
          `List the products of the shop "${identifier.instanceName}" (name, price in cents, id). ` +
          `Narrow it with a department and/or a search term rather than asking for everything; ` +
          `pass \`after\` with the last id to see the next page.`,
        parameters: z.object({
          tag: z.string().optional().describe('One department, e.g. "tea" — the shop lists them in its state'),
          q: z.string().optional().describe("Part of a product name"),
          after: z.string().optional().describe("The last product id of the previous page"),
        }),
        readOnly: true,
        publicSafe: true,
        execute: async (a: { tag?: string; q?: string; after?: string }) => {
          const page = await op<{ items: { id: string; name: string; priceCents: number }[]; nextCursor: string | null }>("browse", {
            ...(a?.tag ? { tag: a.tag } : {}),
            ...(a?.q ? { q: a.q } : {}),
            ...(a?.after ? { cursor: a.after } : {}),
          });
          const asked = [a?.tag && `in ${a.tag}`, a?.q && `matching "${a.q}"`].filter(Boolean).join(" ");
          if (!page.items.length) return `Nothing ${asked || "on the shelves"} at "${identifier.instanceName}".`;
          const lines = page.items.map((p) => `${p.name} — ${(p.priceCents / 100).toFixed(2)} (id ${p.id})`);
          if (page.nextCursor) lines.push(`… more: browse again with after: "${page.nextCursor}"`);
          return lines.join("\n");
        },
      },
      [`product_detail_${base}`]: {
        description: `Everything "${identifier.instanceName}" says about one product: what it is, what it costs, and how it is filed.`,
        parameters: z.object({ productId: z.string().describe("The product id, as browse_shop shows it") }),
        readOnly: true,
        publicSafe: true,
        execute: async (args: { productId: string }) => {
          const p = await op<{ name: string; priceCents: number; sku: string | null; description: string | null; tags: string[] }>("product", args);
          return [
            `${p.name} — ${(p.priceCents / 100).toFixed(2)}`,
            p.sku ? `stock code ${p.sku}` : null,
            p.tags?.length ? `filed under ${p.tags.join(", ")}` : null,
            p.description ?? "No description yet.",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
      // THE BASKET, as an agent works it. A person says "add two of the Earl
      // Grey, actually make it three, now check out" and these are the three
      // calls — each returning the WHOLE basket, so the answer the agent reads
      // back is the state the screen shows.
      [`add_to_cart_${base}`]: {
        description: `Put a product in the caller's own basket at "${identifier.instanceName}" (adds to what is already there). Returns the whole basket.`,
        parameters: z.object({ productId: z.string(), qty: z.number().int().min(1).max(99).optional() }),
        execute: async (args: { productId: string; qty?: number }) => {
          const cart = await op<Cart>("add-to-cart", args);
          return describeCart(cart, identifier.instanceName);
        },
      },
      [`view_cart_${base}`]: {
        description: `What is in the caller's own basket at "${identifier.instanceName}", and what it comes to.`,
        parameters: z.object({}),
        readOnly: true,
        execute: async () => describeCart(await op<Cart>("view-cart"), identifier.instanceName),
      },
      [`set_cart_quantity_${base}`]: {
        description: `Change how many of one product are in the caller's basket at "${identifier.instanceName}". Zero takes it out.`,
        parameters: z.object({ productId: z.string(), qty: z.number().int().min(0).max(99) }),
        execute: async (args: { productId: string; qty: number }) => {
          const cart = await op<Cart>("set-cart-qty", args);
          return describeCart(cart, identifier.instanceName);
        },
      },
      [`checkout_${base}`]: {
        description: `Buy what is in the caller's basket at "${identifier.instanceName}". Needs a name and an address; the shop prices it from the catalogue, not from the basket.`,
        parameters: z.object({
          shipTo: z.object({ name: z.string(), street: z.string(), city: z.string() }),
          note: z.string().max(280).optional(),
        }),
        execute: async (args: unknown) => {
          const r = await op<{ orderId: string; totalCents: number }>("checkout", args);
          // NOT a catalogue change. This used to bump `catalogueVersion`, which
          // is what every open storefront watches to re-read the shelves — so
          // at a thousand orders a day every shopper's page would refetch the
          // catalogue a thousand times for something that did not touch it.
          // The desk and the customer learn through the channel's own topics
          // (`new-order`, `order-status`), which is what those are for.
          return `Order ${r.orderId} placed — ${(r.totalCents / 100).toFixed(2)}. The basket is empty again.`;
        },
      },
      [`place_order_${base}`]: {
        description: `Place an order in "${identifier.instanceName}" for the CALLER (they must be signed in). Lines are product ids and quantities; the server prices them.`,
        parameters: z.object({
          lines: z.array(z.object({ productId: z.string(), qty: z.number().int().min(1).max(99) })).min(1),
          shipTo: z.object({ name: z.string(), street: z.string(), city: z.string() }),
          note: z.string().max(280).optional(),
        }),
        execute: async (args: unknown) => {
          const r = await op<{ orderId: string; totalCents: number }>("place-order", args);
          return `Order ${r.orderId} placed — total ${(r.totalCents / 100).toFixed(2)}.`;
        },
      },
      [`list_orders_${base}`]: {
        description: `The orders of "${identifier.instanceName}" this caller may see: a customer's own; every order for staff and the owner.`,
        parameters: z.object({}),
        readOnly: true,
        execute: async () => {
          const orders = await op<{ id: string; status: string; totalCents: number; createdAt: string }[]>("list-orders");
          if (!orders.length) return "No orders.";
          return orders.map((o) => `${o.id} · ${o.status} · ${(o.totalCents / 100).toFixed(2)} · ${o.createdAt}`).join("\n");
        },
      },
      /**
       * THE TILL. Every thing sold is a row carrying the price at the time, so
       * this is index work rather than a walk over every order — and it says
       * the date it can see back to, because an order placed before 0.6.0 has
       * a receipt and no rows. Staff and the owner get the shop's; a customer
       * gets their own, which is a perfectly good answer to "what did I buy".
       */
      [`sales_${base}`]: {
        description:
          `What "${identifier.instanceName}" sold: money and units per product. ` +
          `Narrow it with productId or since (a date); it pages with cursor, and totals only the page it read.`,
        parameters: z.object({
          productId: z.string().optional(),
          since: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        readOnly: true,
        execute: async (args: unknown) => {
          const r = await op<{
            products: { name: string; units: number; centsSold: number }[];
            unitsSold: number;
            centsSold: number;
            nextCursor: string | null;
            countsSalesFrom: string | null;
          }>("sales", args);
          if (!r.products.length) {
            return r.countsSalesFrom
              ? `Nothing sold in that window. Sales are counted from ${r.countsSalesFrom}.`
              : "Nothing sold yet.";
          }
          const lines = r.products.map((p) => `${p.name} · ${p.units} sold · ${(p.centsSold / 100).toFixed(2)}`);
          return (
            `${r.unitsSold} item${r.unitsSold === 1 ? "" : "s"}, ${(r.centsSold / 100).toFixed(2)} total\n` +
            lines.join("\n") +
            (r.nextCursor ? `\nMore: cursor ${r.nextCursor}` : "") +
            (r.countsSalesFrom ? `\nCounted from ${r.countsSalesFrom}.` : "")
          );
        },
      },
      [`set_order_status_${base}`]: {
        description: `Move an order of "${identifier.instanceName}" along: new → preparing → shipped → fulfilled, or refunded. Staff and the owner only. Returns the address to ship to, so the next thing said can be the label.`,
        parameters: z.object({
          orderId: z.string().describe("The order id, as list_orders shows it"),
          status: z.enum(["new", "preparing", "shipped", "fulfilled", "refunded"]),
        }),
        execute: async (args: { orderId: string; status: string }) => {
          const r = await op<{ id: string; status: string; shipTo: { name?: string; street?: string; city?: string } | null }>("set-order-status", args);
          // Not a catalogue change either — see the note in `checkout` above.
          const to = r.shipTo && typeof r.shipTo === "object" ? [r.shipTo.name, r.shipTo.street, r.shipTo.city].filter(Boolean).join(", ") : "";
          return `Order ${r.id} is now ${r.status}.${to ? ` Ship to: ${to}.` : ""} The customer has been told; nobody else was.`;
        },
      },
      [`add_product_${base}`]: {
        description: `Add a product to "${identifier.instanceName}" (owner only).`,
        // EVERY FIELD THE OP ACCEPTS IS DECLARED HERE, and that is not
        // tidiness: zod STRIPS what a schema does not name, so a tool whose
        // parameters lag its op drops arguments silently and answers "Added
        // Earl Grey" while the picture you passed went nowhere. Found by
        // photographing the shelf and seeing the drawn fallback (2026-09-12).
        parameters: z.object({
          name: z.string().min(1).max(80),
          priceCents: z.number().int().min(0),
          sku: z.string().max(40).optional(),
          description: z.string().max(2000).optional().describe("What it is, in the shop's own words — the product page is mostly this"),
          tagline: z.string().max(140).optional().describe("One line the shelf shows under the name"),
          imageUrl: z.string().max(500).optional().describe("A photograph of it — an https link"),
          tags: z.array(z.string().min(1).max(24)).max(8).optional().describe('How the storefront groups it: "tea", "gifts", "new"'),
        }),
        execute: async (args: { name: string }) => {
          // The OP records the catalogue change now, with a change id derived
          // from the product and the departments it introduced. This tool used
          // to dispatch its own with a random id, so every product bumped the
          // version twice and none of them recorded a department — the reason
          // a shop stocked by its agent had no departments at all while its
          // catalogue version climbed past thirty (2026-09-12).
          const p = await op<{ tags: string[] }>("add-product", args);
          return `Added ${args.name}${p.tags?.length ? ` under ${p.tags.join(", ")}` : ""}.`;
        },
      },
      /**
       * WRITING THE SHOP, which is most of running one. A description written
       * badly used to be permanent and a photograph taken later had nowhere to
       * go: the app could only ADD. Only the fields named are touched.
       */
      [`update_product_${base}`]: {
        description:
          `Change a product of "${identifier.instanceName}" (owner only): its words, its price, its picture, its departments, ` +
          `or take it off the shelves with active:false (the row and its sales are kept). Only what you name is changed.`,
        parameters: z.object({
          productId: z.string().min(1),
          name: z.string().min(1).max(80).optional(),
          priceCents: z.number().int().min(0).optional(),
          description: z.string().max(2000).optional().describe("The product page is mostly this — write it like a shop would"),
          tagline: z.string().max(140).optional().describe("One line the shelf shows under the name"),
          tags: z.array(z.string().min(1).max(24)).max(8).optional(),
          imageUrl: z.string().max(500).optional().describe("A photograph of it — an https link"),
          active: z.boolean().optional(),
        }),
        execute: async (args: { productId: string }) => {
          const p = await op<{ name: string; active: boolean; imageUrl: string | null }>("update-product", args);
          return `${p.name}: updated${p.active ? "" : " and taken off the shelves"}${p.imageUrl ? ", picture set" : ""}.`;
        },
      },
      /**
       * WHO ELSE RUNS THE SHOP. The desk has a screen for this, so the tools
       * must have it too — "an assistant can do anything on this page that you
       * can" is a claim the toolkit either keeps or breaks.
       */
      [`give_access_${base}`]: {
        description:
          `Give an esoul account a role in "${identifier.instanceName}" by their email (owner only): ` +
          `customer, staff or owner. An empty role takes the access back. They must have signed into esoul at least once.`,
        parameters: z.object({
          email: z.string().min(3).max(200),
          role: z.string().max(40).describe('One of the shop\'s own words — "staff", "customer", "owner" — or "" to take it back'),
        }),
        execute: async (args: { email: string; role: string }) => {
          const r = await op<{ email: string; role: string; removed: boolean }>("set-person-role", args);
          return r.removed ? `${r.email} no longer has access.` : `${r.email} is now ${r.role} of "${identifier.instanceName}".`;
        },
      },
      [`list_access_${base}`]: {
        description: `Who has been given a role in "${identifier.instanceName}", and which roles it has to give (owner only).`,
        parameters: z.object({}),
        readOnly: true,
        execute: async () => {
          const r = await op<{ people: { email: string | null; role: string }[]; roles: string[] }>("list-people", {});
          if (!r.people.length) return `Nobody else has access. The roles this shop can give: ${r.roles.join(", ") || "none"}.`;
          return r.people.map((p) => `${p.email ?? "an account"} — ${p.role}`).join("\n");
        },
      },
      /** The shop's own face: a picture across the top, a line, an accent. */
      [`set_shop_look_${base}`]: {
        description:
          `Set how "${identifier.instanceName}" LOOKS (owner only): heroUrl (an https picture across the top, or null for the ` +
          `shop's own pattern), tagline (the line under its name), accent (stone, amber, rose, emerald, indigo).`,
        parameters: z.object({
          heroUrl: z.string().max(500).nullable().optional(),
          tagline: z.string().max(160).nullable().optional(),
          accent: z.enum(["stone", "amber", "rose", "emerald", "indigo"]).optional(),
        }),
        execute: async (args: unknown) => {
          const r = await op<{ heroUrl: string | null; tagline: string | null; accent: string | null }>("set-look", args);
          const said = [r.heroUrl ? "picture" : null, r.tagline ? "tagline" : null, r.accent ? `accent ${r.accent}` : null].filter(Boolean);
          return `The shop's look: ${said.length ? said.join(", ") : "cleared"}.`;
        },
      },
    };
    for (const t of Object.values(tools)) t.onClient = t.execute;
    return tools;
  },
};
