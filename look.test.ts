/**
 * THE SHOP'S FACE: a picture on a thing, and a look on the shop.
 *
 * Both are new and both are optional, which is the whole risk: an optional
 * field that silently never arrives looks exactly like a shop nobody has
 * photographed. So these cases follow a picture all the way from the tool that
 * sets it to the shelf that shows it.
 */
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { pluginServer } from "./server";
import { pluginSchema, shopLookSetEvent, type ShopDemoData } from "./app";

const owner = fakeViewer("owner", { userId: "kp_o", role: "owner" });
const shopper = fakeViewer("anonymous", { role: "customer" });
const PIC = "https://pictures.example.com/tea.webp";

type Shelf = { items: { id: string; name: string; imageUrl?: string | null; tagline?: string | null }[] };

const stocked = async () => {
  const db = memoryDb(manifest as never);
  const { result } = await runOp(pluginServer, "add-product", {
    viewer: owner,
    args: { name: "Earl Grey", priceCents: 450, sku: "TEA-01", tags: ["tea"], tagline: "Bergamot over Assam.", imageUrl: PIC },
    db: db.as(owner),
  });
  return { db, id: (result as { id: string }).id };
};

describe("a picture on a thing", () => {
  it("is set when the product is added, and REACHES THE SHELF", async () => {
    const { db } = await stocked();
    const { result } = await runOp<Shelf>(pluginServer, "browse", { viewer: shopper, args: {}, db: db.as(shopper) });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.imageUrl).toBe(PIC);
    expect(result.items[0]!.tagline).toBe("Bergamot over Assam.");
  });

  it("reaches the product page too", async () => {
    const { db, id } = await stocked();
    const { result } = await runOp<{ imageUrl?: string | null }>(pluginServer, "product", { viewer: shopper, args: { productId: id }, db: db.as(shopper) });
    expect(result.imageUrl).toBe(PIC);
  });

  it("can be added later — the thing already on the shelf gets its photograph", async () => {
    const db = memoryDb(manifest as never);
    const { result: p } = await runOp<{ id: string }>(pluginServer, "add-product", { viewer: owner, args: { name: "Sencha", priceCents: 690 }, db: db.as(owner) });
    await runOp(pluginServer, "update-product", { viewer: owner, args: { productId: p.id, imageUrl: PIC, tagline: "A green cup." }, db: db.as(owner) });
    const { result } = await runOp<Shelf>(pluginServer, "browse", { viewer: shopper, args: {}, db: db.as(shopper) });
    expect(result.items[0]!.imageUrl).toBe(PIC);
  });

  it("must be an https link — a data: payload or a javascript: url is refused", async () => {
    const { db, id } = await stocked();
    for (const bad of ["data:image/png;base64,AAAA", "javascript:alert(1)", "http://plain.example.com/x.png"]) {
      await expect(
        runOp(pluginServer, "update-product", { viewer: owner, args: { productId: id, imageUrl: bad }, db: db.as(owner) }),
      ).rejects.toThrow();
    }
  });

  it("only what is named is changed — setting a picture does not blank the words", async () => {
    const { db, id } = await stocked();
    await runOp(pluginServer, "update-product", { viewer: owner, args: { productId: id, imageUrl: "https://pictures.example.com/other.webp" }, db: db.as(owner) });
    const { result } = await runOp<{ tagline?: string | null }>(pluginServer, "product", { viewer: shopper, args: { productId: id }, db: db.as(shopper) });
    expect(result.tagline).toBe("Bergamot over Assam.");
  });

  it("taken off the shelves, it keeps its row and leaves the shelf", async () => {
    const { db, id } = await stocked();
    await runOp(pluginServer, "update-product", { viewer: owner, args: { productId: id, active: false }, db: db.as(owner) });
    const { result } = await runOp<Shelf>(pluginServer, "browse", { viewer: shopper, args: {}, db: db.as(shopper) });
    expect(result.items).toEqual([]);
    expect(await db.as(owner).product.count()).toBe(1);
  });
});

describe("the shop's look", () => {
  const fold = (events: { eventData: Record<string, unknown> }[]): ShopDemoData => {
    let s = { instanceName: "Shop" } as ShopDemoData;
    for (const e of events) s = shopLookSetEvent.processor!(s, e as never) as ShopDemoData;
    return s;
  };

  it("is recorded by the OP, on the shop's own timeline", async () => {
    const db = memoryDb(manifest as never);
    const { emitted } = await runOp(pluginServer, "set-look", {
      viewer: owner,
      args: { heroUrl: "https://pictures.example.com/hero.webp", tagline: "Bread before six", accent: "amber" },
      db: db.as(owner),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.eventName).toBe("plugin_shop_demo_look_set");
    expect(fold([{ eventData: emitted[0]!.eventData }]).look).toEqual({
      heroUrl: "https://pictures.example.com/hero.webp",
      tagline: "Bread before six",
      accent: "amber",
    });
  });

  it("a field left out is LEFT ALONE; null clears it", async () => {
    const dressed = fold([{ eventData: { heroUrl: "https://pictures.example.com/hero.webp", tagline: "One", accent: "rose" } }]);
    expect(shopLookSetEvent.processor!(dressed, { eventData: { tagline: "Two" } } as never).look).toEqual({
      heroUrl: "https://pictures.example.com/hero.webp",
      tagline: "Two",
      accent: "rose",
    });
    expect(shopLookSetEvent.processor!(dressed, { eventData: { heroUrl: null } } as never).look!.heroUrl).toBeNull();
  });

  it("refuses a hero that is not an https link, and an accent it does not own", () => {
    const s = fold([{ eventData: { heroUrl: "javascript:alert(1)", accent: "neon-pink" } }]);
    expect(s.look!.heroUrl).toBeNull();
    expect(s.look!.accent).toBeUndefined();
  });

  it("says nothing changed rather than emitting an empty event", async () => {
    const db = memoryDb(manifest as never);
    await expect(runOp(pluginServer, "set-look", { viewer: owner, args: {}, db: db.as(owner) })).rejects.toThrow(/say what to change/);
  });
});

/**
 * THE TOOL IS A SURFACE OF ITS OWN.
 *
 * `add_product`'s op took a picture and its TOOL did not declare one, so zod
 * stripped the argument and the tool cheerfully answered "Added Earl Grey"
 * with nothing on the shelf. Every case above passed throughout, because they
 * called the op. A test that only exercises the op cannot see the hole an
 * agent falls into — so this one goes through the toolkit, and it is the
 * shape to copy for any field a tool is supposed to carry.
 */
describe("what the TOOLS carry, not just the ops", () => {
  const toolsOf = () => {
    const seen: { name: string; args: Record<string, unknown> }[] = [];
    const tools = pluginSchema.toolkitCreator!(
      { workspaceId: "w", nodeId: "n", instanceName: "Shop", applicationType: "plugin_shop_demo" } as never,
      undefined as never,
      (() => undefined) as never,
      (() => undefined) as never,
    ) as Record<string, { parameters: { safeParse: (a: unknown) => { success: boolean; data?: Record<string, unknown> } } }>;
    return { tools, seen };
  };

  it("add_product accepts a picture and a tagline — zod keeps only what it names", () => {
    const { tools } = toolsOf();
    const add = Object.entries(tools).find(([n]) => n.startsWith("add_product_"))![1];
    const parsed = add.parameters.safeParse({ name: "Earl Grey", priceCents: 450, tagline: "Bergamot.", imageUrl: PIC });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.imageUrl).toBe(PIC);
    expect(parsed.data!.tagline).toBe("Bergamot.");
  });

  it("every field the update op accepts, the update tool declares", () => {
    const { tools } = toolsOf();
    const upd = Object.entries(tools).find(([n]) => n.startsWith("update_product_"))![1];
    const parsed = upd.parameters.safeParse({
      productId: "p1",
      name: "n",
      priceCents: 1,
      description: "d",
      tagline: "t",
      tags: ["x"],
      imageUrl: PIC,
      active: false,
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data!).sort()).toEqual(["active", "description", "imageUrl", "name", "priceCents", "productId", "tagline", "tags"]);
  });

  it("set_shop_look carries all three, and null clears the picture", () => {
    const { tools } = toolsOf();
    const look = Object.entries(tools).find(([n]) => n.startsWith("set_shop_look_"))![1];
    const parsed = look.parameters.safeParse({ heroUrl: null, tagline: "Bread before six", accent: "amber" });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.heroUrl).toBeNull();
    expect(parsed.data!.accent).toBe("amber");
  });
});

/**
 * EVERY SCREEN IS A TOOL. The desk has a page for handing out access, and the
 * footer tells the visitor "an assistant can do anything on this page that you
 * can" — so the toolkit either keeps that promise or the sentence is a lie.
 * This is the shape to copy for any new desk screen.
 */
describe("the desk's screens all exist as tools", () => {
  const names = () =>
    Object.keys(
      pluginSchema.toolkitCreator!(
        { workspaceId: "w", nodeId: "n", instanceName: "Shop", applicationType: "plugin_shop_demo" } as never,
        undefined as never,
        (() => undefined) as never,
        (() => undefined) as never,
      ) as Record<string, unknown>,
    );

  it.each([
    ["the queue", "set_order_status_"],
    ["the shelves", "update_product_"],
    ["adding something", "add_product_"],
    ["the till", "sales_"],
    ["the look", "set_shop_look_"],
    ["who may help", "give_access_"],
    ["who has access", "list_access_"],
  ])("%s", (_screen, prefix) => {
    expect(names().some((n) => n.startsWith(prefix))).toBe(true);
  });
});
