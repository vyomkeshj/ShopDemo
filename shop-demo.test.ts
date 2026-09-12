/**
 * The fold half of the reference shop: small, shared, scrubbable.
 *
 * Orders never come through here — they are rows in the app's own tables
 * (`rules.test.ts` beside this file proves who sees which). What the timeline
 * holds is the catalogue's VERSION and staff announcements, and both must
 * survive a retried dispatch unchanged.
 */
import { announcedEvent, catalogueChangedEvent, describeShop, pluginSchema, type ShopDemoData } from "./app";

const IDENT = { workspaceId: "ws1", nodeId: "node1", applicationType: "plugin_shop_demo", instanceName: "Corner shop" };
const fresh = (): ShopDemoData => pluginSchema.stateCreator(IDENT, {}) as ShopDemoData;

describe("the catalogue version", () => {
  it("bumps once per distinct change and not again for the same change replayed", () => {
    const e = catalogueChangedEvent.dataCreator({ ...IDENT, applicationId: IDENT.nodeId, what: "added Tea" });
    let s = fresh();
    s = catalogueChangedEvent.processor(s, e);
    expect(s.catalogueVersion).toBe(1);
    s = catalogueChangedEvent.processor(s, e); // the retry
    expect(s.catalogueVersion).toBe(1);
    const e2 = catalogueChangedEvent.dataCreator({ ...IDENT, applicationId: IDENT.nodeId, what: "price" });
    expect(catalogueChangedEvent.processor(s, e2).catalogueVersion).toBe(2);
  });

  it("leaves the state alone for a malformed event", () => {
    const s = fresh();
    expect(catalogueChangedEvent.processor(s, { eventData: {} } as never)).toBe(s);
  });
});

describe("announcements", () => {
  it("are idempotent by id and newest-first", () => {
    let s = fresh();
    const a = announcedEvent.dataCreator({ ...IDENT, applicationId: IDENT.nodeId, text: "Closed Monday" });
    s = announcedEvent.processor(s, a);
    s = announcedEvent.processor(s, a);
    expect(s.announcements).toHaveLength(1);
    const b = announcedEvent.dataCreator({ ...IDENT, applicationId: IDENT.nodeId, text: "Open Tuesday" });
    s = announcedEvent.processor(s, b);
    expect(s.announcements.map((x) => x.text)).toEqual(["Open Tuesday", "Closed Monday"]);
  });
});

describe("what an agent is told", () => {
  it("describes the fold and points at the tables for the rest", () => {
    const text = describeShop({ instanceName: "Corner shop", catalogueVersion: 3, announcements: [], departments: ["tea"] });
    expect(text).toContain("Corner shop");
    expect(text).toContain("version 3");
    expect(text).toMatch(/list_orders/);
    expect(text).toContain("tea");
  });

  it("says the state did not load rather than inventing an empty shop", () => {
    const notice = pluginSchema.getStateDescription({ ...IDENT } as never);
    expect(notice).toMatch(/incomplete|missing|did not load|not loaded/i);
  });

  it("mints one tool per op the manifest declares, and marks the catalogue read public-safe", () => {
    const tools = pluginSchema.toolkitCreator({ ...IDENT }, "chat", () => undefined, () => undefined);
    const names = Object.keys(tools);
    expect(names.some((n) => n.startsWith("browse_shop_"))).toBe(true);
    expect(names.some((n) => n.startsWith("place_order_"))).toBe(true);
    expect(names.some((n) => n.startsWith("list_orders_"))).toBe(true);
    expect(names.some((n) => n.startsWith("add_product_"))).toBe(true);
    const browse = tools[names.find((n) => n.startsWith("browse_shop_"))!] as { publicSafe?: boolean; readOnly?: boolean; onClient?: unknown };
    expect(browse.publicSafe).toBe(true);
    expect(browse.readOnly).toBe(true);
    for (const t of Object.values(tools)) expect(typeof (t as { onClient?: unknown }).onClient).toBe("function");
  });
});
