/**
 * The tools and the ops are ONE declaration. Pinned here because the drift this
 * guards against was silent the day it happened: `add-product` took `imageUrl`,
 * its tool did not, zod stripped the field, and the tool said "Added Earl Grey"
 * over a product with no picture (2026-09-12).
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginSchema } from "./app";
import { ops } from "./ops";
import { pluginServer } from "./server";

const IDENT = { workspaceId: "ws1", nodeId: "node1", applicationType: "plugin_shop_demo", instanceName: "Corner shop" };

describe("every tool that reaches an op is derived from it", () => {
  const tools = pluginSchema.toolkitCreator({ ...IDENT }, "chat", () => undefined, () => undefined) as Record<string, { op?: string; opInput?: unknown; parameters: { safeParse: (x: unknown) => { success: boolean } } }>;

  it("names an op the manifest declares, and shares its schema object with the handler", () => {
    const declared = Object.keys(manifest.ops);
    for (const [name, t] of Object.entries(tools)) {
      expect({ name, op: t.op }).toEqual({ name, op: expect.any(String) });
      expect(declared).toContain(t.op);
      expect((pluginServer.ops?.[t.op!] as { input?: unknown }).input).toBe(t.opInput);
    }
  });

  it("add_product takes a picture — the field the hand-written tool had dropped", () => {
    const add = tools[Object.keys(tools).find((n) => n.startsWith("add_product_"))!]!;
    expect(add.parameters.safeParse({ name: "Earl Grey", priceCents: 450, imageUrl: "https://x/y.webp" }).success).toBe(true);
    // ...and refuses one it does not take, aloud, before the op is ever called.
    expect(add.parameters.safeParse({ name: "Earl Grey", priceCents: 450, colour: "amber" }).success).toBe(false);
  });

  it("has a tool for every screen the desk has: notices included", () => {
    expect(Object.keys(tools).some((n) => n.startsWith("post_notice_"))).toBe(true);
  });
});

describe("an op refuses a field it does not take", () => {
  it("as `invalid`, naming the field and the ones it takes", async () => {
    const db = memoryDb(manifest as never);
    const owner = fakeViewer("owner", { userId: "u_owner", role: "owner" });
    const err = await runOp(pluginServer, "add-product", { viewer: owner, db: db.as(owner), args: { name: "Sencha", priceCents: 700, colour: "green" } }).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect(String(err.message)).toMatch(/add-product: does not take "colour" — it takes name, priceCents, sku, description, tagline, imageUrl, tags/);
  });

  it("and every declared op has a handler that carries its input", () => {
    for (const name of Object.keys(manifest.ops)) {
      const h = pluginServer.ops?.[name] as { input?: unknown } | undefined;
      expect({ name, input: h?.input }).toEqual({ name, input: (ops as Record<string, unknown>)[name] });
    }
  });
});
