/**
 * THE OWNER CHANGES A STATUS; THE CUSTOMER'S OPEN PAGE MOVES.
 *
 * The whole path, asserted where each part actually decides something:
 *
 *   set-order-status  the record moves, and the telling is HANDED OFF
 *   tell-customer     a durable task: reads what was already told, reads the
 *                     order, tells ONE person, records that it did
 *   the screen        holds a token for its own channel and nothing else, and
 *                     re-READS on a nudge rather than trusting the payload
 *
 * The parts that matter are the ones a retry or a second customer would break.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";
import { pluginSchema, shopChannel, toldCustomerEvent, type ShopDemoData } from "./app";
import { subscriptionsFor } from "../../../packages/esoul-sdk/src/audience";

const staff = fakeViewer("member", { userId: "kp_s", role: "staff" });
const alice = fakeViewer("visitor", { userId: "kp_a", role: "customer" });
const bob = fakeViewer("visitor", { userId: "kp_b", role: "customer" });
const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });

const task = pluginSchema.tasks!.find((t) => t.taskName === "tell-customer")!;

/** A task context that records what the task did, and replays like the platform's. */
function taskCtx(over: {
  eventData: Record<string, unknown>;
  state?: Partial<ShopDemoData>;
  order?: { id: string; status: string; ownerId: string | null; name: string | null } | null;
}) {
  const notified: { topic: string; data: unknown; to?: unknown }[] = [];
  const dispatched: { eventName: string; eventData: Record<string, unknown> }[] = [];
  const steps: string[] = [];
  return {
    notified,
    dispatched,
    steps,
    ctx: {
      identifier: { workspaceId: "ws1", nodeId: "node1", instanceName: "Shop", applicationType: "plugin_shop_demo" },
      eventData: over.eventData,
      step: {
        run: async (id: string, fn: () => unknown) => {
          steps.push(id);
          return fn();
        },
      },
      logger: console,
      getState: async () => ({ deliveries: [], ...over.state }) as ShopDemoData,
      notify: async (topic: string, data: unknown, opts?: { to?: unknown }) => void notified.push({ topic, data, to: opts?.to }),
      dispatchEvent: async (eventName: string, eventData: Record<string, unknown>) => void dispatched.push({ eventName, eventData }),
      // The op the task reaches through; the platform's internal leg in production.
      __order: over.order === undefined ? { id: "o1", status: "preparing", ownerId: "kp_a", name: "Alice" } : over.order,
    },
  };
}

/** `callPluginOp` is what the task uses to read its own tables; answer it here. */
jest.mock("esoul-sdk", () => {
  const actual = jest.requireActual("esoul-sdk");
  return { ...actual, callPluginOp: async (_p: string, _op: string, _n: string, a: unknown) => (global as never as { __order: unknown }).__order ?? null };
});

async function runTask(over: Parameters<typeof taskCtx>[0]) {
  const t = taskCtx(over);
  (global as never as { __order: unknown }).__order = t.ctx.__order;
  await task.handler(t.ctx as never);
  return t;
}

describe("the owner moves an order", () => {
  it("the op moves the record and HANDS OFF the telling — it does not send anything itself", async () => {
    const db = memoryDb(manifest as never);
    const { result: p } = await runOp(pluginServer, "add-product", { viewer: owner, args: { name: "Tea", priceCents: 350, sku: "T1" }, db: db.as(owner) });
    const { result: o } = await runOp(pluginServer, "place-order", {
      viewer: alice,
      args: { lines: [{ productId: (p as { id: string }).id, qty: 1 }], shipTo: { name: "Alice", street: "1", city: "Ostrava" } },
      db: db.as(alice),
    });
    const { result, notified } = await runOp(pluginServer, "set-order-status", {
      viewer: staff,
      args: { orderId: (o as { orderId: string }).orderId, status: "preparing" },
      db: db.as(staff),
    });
    expect(result).toMatchObject({ status: "preparing" });
    // The telling is the task's job now; the op notifies nothing inline.
    expect(notified).toEqual([]);
  });
});

describe("the telling task", () => {
  it("tells ONE customer, on the topic their own channel carries", async () => {
    const t = await runTask({ eventData: { orderId: "o1", status: "preparing" } });
    expect(t.notified).toEqual([
      { topic: "order-status", data: { orderId: "o1", status: "preparing", to: "Alice", by: "the shop" }, to: { viewerIds: ["kp_a"] } },
    ]);
  });

  it("records that it told them, idempotently by order AND status", async () => {
    const t = await runTask({ eventData: { orderId: "o1", status: "preparing" } });
    expect(t.dispatched).toEqual([{ eventName: "plugin_shop_demo_told_customer", eventData: { orderId: "o1", status: "preparing" } }]);
    // The fold refuses the second one.
    const once = toldCustomerEvent.processor!({ deliveries: [] } as never, { eventData: { orderId: "o1", status: "preparing", at: 1 } } as never);
    const twice = toldCustomerEvent.processor!(once as never, { eventData: { orderId: "o1", status: "preparing", at: 2 } } as never);
    expect((twice as ShopDemoData).deliveries).toHaveLength(1);
    expect(twice).toBe(once); // and nothing churns
  });

  it("A RETRY TELLS NOBODY TWICE: it reads what was already told before doing anything", async () => {
    const t = await runTask({
      eventData: { orderId: "o1", status: "preparing" },
      state: { deliveries: [{ id: "o1:preparing", orderId: "o1", status: "preparing", at: 1 }] },
    });
    expect(t.notified).toEqual([]);
    expect(t.dispatched).toEqual([]);
    expect(t.steps).toEqual(["read-what-was-told"]); // it stopped at the first step
  });

  it("every side effect is inside a step — the replay rule, checked by name", async () => {
    const t = await runTask({ eventData: { orderId: "o1", status: "preparing" } });
    expect(t.steps).toEqual(["read-what-was-told", "read-the-order", "tell-them", "record-that-we-told-them"]);
  });

  it("the order moved on while the task was queued: what is true NOW wins, and the stale word is not sent", async () => {
    const t = await runTask({ eventData: { orderId: "o1", status: "preparing" }, order: { id: "o1", status: "shipped", ownerId: "kp_a", name: "Alice" } });
    expect(t.notified).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it("an order nobody owns is not announced into the void", async () => {
    const t = await runTask({ eventData: { orderId: "o1", status: "preparing" }, order: { id: "o1", status: "preparing", ownerId: null, name: null } });
    expect(t.notified).toEqual([]);
    expect(t.dispatched).toHaveLength(1); // still recorded: there is nothing left to try
  });

  it("refuses a kick that does not say what happened", async () => {
    await expect(runTask({ eventData: { orderId: "o1" } })).rejects.toThrow(/orderId, status/);
  });
});

describe("whose page moves", () => {
  const topics = (manifest as { channel: { topics: Record<string, { audience?: "all" | "viewer" | `role:${string}`; mayAddress?: string[] }> } }).channel.topics;

  it("the customer's screen is offered the shop's open channel and THEIR OWN — never the desk", () => {
    const subs = subscriptionsFor(topics, { kind: "visitor", userId: "kp_a", viewerIds: ["kp_a"], role: "customer" });
    expect(subs.map((s) => s.audience)).toEqual([{ kind: "all" }, { kind: "viewer", viewerId: "kp_a" }]);
    // Their own channel carries both the things that are theirs alone.
    expect(subs.flatMap((s) => s.topics).sort()).toEqual(["cart", "catalogue", "order-status"]);
  });

  it("and a second customer is offered a DIFFERENT channel, so Alice's news never reaches Bob", () => {
    const a = subscriptionsFor(topics, { kind: "visitor", userId: "kp_a", viewerIds: ["kp_a"], role: "customer" });
    const b = subscriptionsFor(topics, { kind: "visitor", userId: "kp_b", viewerIds: ["kp_b"], role: "customer" });
    const own = (s: typeof a) => s.find((x) => x.audience.kind === "viewer")!.audience;
    expect(own(a)).not.toEqual(own(b));
  });

  it("staff are offered the desk as well, because they run it", () => {
    const subs = subscriptionsFor(topics, { kind: "member", userId: "kp_s", viewerIds: ["kp_s"], role: "staff" });
    expect(subs.some((s) => s.audience.kind === "role" && s.topics.includes("new-order"))).toBe(true);
  });

  it("the channel the SCREEN subscribes to is the one the task publishes on — same names, one declaration", () => {
    expect(shopChannel.topicNames.sort()).toEqual(Object.keys(topics).sort());
  });
});
