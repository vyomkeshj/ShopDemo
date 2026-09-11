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

export interface ShopDemoData extends ApplicationIdentifier {
  /** Bumped whenever the catalogue changes, so every open UI refetches it. */
  catalogueVersion: number;
  /** Staff notes to customers ("closed on Monday"). Small, shared, scrubbable. */
  announcements: ShopAnnouncement[];
}

const MAX_ANNOUNCEMENTS = 20;

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
      at: args.at ?? Date.now(),
    }),
  processor: (state, event) => {
    const d = event.eventData || {};
    if (typeof d.changeId !== "string" || !d.changeId) return state;
    // Idempotent: the version is a count of DISTINCT changes, kept as the last
    // applied id so a retried dispatch cannot bump twice.
    const seen = (state as ShopDemoData & { _lastChangeId?: string })._lastChangeId;
    if (seen === d.changeId) return state;
    return { ...state, catalogueVersion: (state.catalogueVersion ?? 0) + 1, _lastChangeId: d.changeId } as ShopDemoData;
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

export function describeShop(s: Pick<ShopDemoData, "instanceName" | "catalogueVersion" | "announcements">): string {
  const n = s.announcements?.length ?? 0;
  return (
    `Shop "${s.instanceName}": catalogue version ${s.catalogueVersion ?? 0}, ${n} announcement${n === 1 ? "" : "s"}. ` +
    `Products and orders live in the app's own tables — use browse_shop / list_orders; a customer's list is theirs alone.`
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
      taskName: "fulfil",
      description: "Mark an order of this shop fulfilled and notify the desk.",
      concurrency: { limit: 1, scope: "per-app" },
      handler: async (ctx) => {
        const orderId = String(ctx.eventData?.orderId ?? "");
        if (!orderId) throw new Error("fulfil: eventData.orderId is required");
        await ctx.step.run("fulfil-order", async () => {
          const { callPluginOp } = await import("esoul-sdk");
          await callPluginOp(PLUGIN_ID, "fulfil-order", ctx.identifier.nodeId, { orderId });
        });
        await ctx.step.run("tell-the-desk", async () => {
          await ctx.notify("order-status", { orderId, status: "fulfilled", by: ctx.kickedBy?.kind ?? "task" });
        });
      },
    },
  ],
  description:
    "The SDK's reference shop: a catalogue anyone may browse, orders a signed-in customer places and sees only their own, a staff desk, an owner who sets prices. Products, orders and addresses are the app's own tables, scoped by the platform.",
  reactNode: ShopDemoUi,
  reconstructStateFromEventLog: true,
  events: [catalogueChangedEvent, announcedEvent],
  getPorts: (): ApplicationPort[] => [],
  stateCreator: (identifier) => ({ ...identifier, catalogueVersion: 0, announcements: [] }),

  getStateDescription: (state: ShopDemoData) => {
    const notice = incompleteStateNotice({
      title: "Shop",
      instanceName: state?.instanceName,
      shape: { lists: { announcements: state?.announcements } },
    });
    if (notice) return notice;
    return describeShop(state);
  },

  toolkitCreator: (identifier, forChatId, eventCallback) => {
    const base = identifier.instanceName.replace(/[^a-zA-Z0-9]/g, "_");
    const idArgs = { ...identifier, applicationId: identifier.nodeId, chatIdSource: forChatId };
    const op = async <T,>(name: string, args?: unknown): Promise<T> => {
      const { callPluginOp } = await import("esoul-sdk");
      return callPluginOp<T>(PLUGIN_ID, name, identifier.nodeId, args);
    };
    const tools: Record<string, any> = {
      [`browse_shop_${base}`]: {
        description: `List the products of the shop "${identifier.instanceName}" (name, price in cents, id).`,
        parameters: z.object({}),
        readOnly: true,
        publicSafe: true,
        execute: async () => {
          const products = await op<{ id: string; name: string; priceCents: number }[]>("browse");
          if (!products.length) return `The shop "${identifier.instanceName}" has no products yet.`;
          return products.map((p) => `${p.name} — ${(p.priceCents / 100).toFixed(2)} (id ${p.id})`).join("\n");
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
      [`add_product_${base}`]: {
        description: `Add a product to "${identifier.instanceName}" (owner only).`,
        parameters: z.object({ name: z.string().min(1).max(80), priceCents: z.number().int().min(0), sku: z.string().max(40).optional() }),
        execute: async (args: { name: string }) => {
          await op("add-product", args);
          eventCallback(catalogueChangedEvent.dataCreator({ ...idArgs, what: `added ${args.name}` }));
          return `Added ${args.name}.`;
        },
      },
    };
    for (const t of Object.values(tools)) t.onClient = t.execute;
    return tools;
  },
};
