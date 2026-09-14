/**
 * ROLES THE OWNER COMPOSES, at the shop: a packer who sees only what is being
 * prepared, never the note, may mark it shipped and nothing else — and the
 * op that composes it speaks the shop's words to the platform's envelope.
 */
import { compileCustomRole } from "esoul-sdk";
import { fakeViewer, memoryDb, runOp } from "esoul-sdk/testing";
import manifest from "./plugin.json";
import { ops } from "./ops";

const defined: unknown[] = [];
jest.mock("esoul-sdk/server", () => ({
  ...jest.requireActual("esoul-sdk/server"),
  defineAppRole: async (_ctx: unknown, def: unknown) => {
    defined.push(def);
    return { ok: true, name: (def as { name: string }).name };
  },
  removeAppRole: async (_ctx: unknown, name: string) => ({ ok: true, name }),
  viewerProfile: async () => null,
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pluginServer } = require("./server") as typeof import("./server");

// The envelope, compiled from the shop's own manifest — the same artefact the platform loads.
const rules = memoryDb(manifest as never).$rules;
const owner = fakeViewer("owner", { userId: "u_owner" });
const base = { viewer: owner, pluginId: "shop-demo", nodeId: "shop1" };

describe("composing a packer, in the shop's words", () => {
  it("define-role hands the platform the generic definition the envelope allows", async () => {
    const { result } = await runOp<{ name: string; moves: Record<string, string[]> }>(pluginServer, "define-role", { ...base, args: { name: "packer", statuses: ["preparing"], moves: { preparing: ["shipped"] }, hideNote: true, ops: ["set-order-status"] } });
    expect(result).toMatchObject({ name: "packer", moves: { preparing: ["shipped"] } });
    expect(defined[0]).toEqual({ name: "packer", base: "staff", describe: undefined, ops: ["set-order-status"], models: { Order: { where: { status: ["preparing"] }, hide: ["note"], update: { transitions: { preparing: ["shipped"] } } } } });
    // …and that definition compiles against the shop's own envelope.
    const compiled = compileCustomRole(defined[0] as never, rules.custom, manifest.roles.vocabulary);
    expect(compiled.models.Order.updateFields).toEqual(["status"]);
  });

  it("a definition outside the envelope is refused with the key and the allowed values", () => {
    expect(() => compileCustomRole({ name: "spy", base: "staff", ops: ["add-product"] }, rules.custom, manifest.roles.vocabulary)).toThrow(/not a surface the app lets a composed role call/);
    expect(() => compileCustomRole({ name: "pricer", base: "staff", models: { Product: { where: { active: true } } } }, rules.custom, manifest.roles.vocabulary)).toThrow(/lets no composed role touch Product/);
  });
});

describe("the packer at the desk", () => {
  const packerRole = compileCustomRole({ name: "packer", base: "staff", models: { Order: { where: { status: ["preparing"] }, hide: ["note"], update: { transitions: { preparing: ["shipped"] } } } }, ops: ["set-order-status"] }, rules.custom, manifest.roles.vocabulary);
  const packer = { ...fakeViewer("visitor", { userId: "u_pack", role: "staff" }), customRole: "packer", custom: { role: packerRole, attrs: {} } };
  const db = memoryDb(manifest as never);
  let preparing = "";
  let fresh = "";
  beforeAll(async () => {
    const alice = db.as(fakeViewer("visitor", { userId: "u_alice", role: "customer" }));
    preparing = (await alice.order.create({ data: { status: "preparing", totalCents: 500, lines: [], shipTo: { name: "Alice" }, note: "ring twice" } })).id;
    fresh = (await alice.order.create({ data: { status: "new", totalCents: 900, lines: [], shipTo: { name: "Alice" } } })).id;
  });

  it("sees only what is being prepared, without the note; staff see everything", async () => {
    const mine = await db.as(packer as never).order.findMany({});
    expect(mine.map((o: { id: string }) => o.id)).toEqual([preparing]);
    expect(mine[0].note).toBeNull();
    expect(await db.as("member").order.count({})).toBe(2);
  });

  it("me tells the desk what the packer may do, so the screen hides the rest", async () => {
    const { result } = await runOp<{ role: string; customRole: string; can: { moves: Record<string, string[]>; statuses: string[]; hidden: string[]; ops: string[] } }>(pluginServer, "me", { ...base, viewer: packer as never, args: {} });
    expect(result).toMatchObject({ role: "staff", customRole: "packer", can: { statuses: ["preparing"], moves: { preparing: ["shipped"] }, hidden: ["note"], ops: ["set-order-status"] } });
  });

  it("may mark a prepared order shipped through set-order-status, and nothing else", async () => {
    const p = db.as(packer as never);
    await expect(p.order.update({ where: { id: preparing }, data: { status: "fulfilled" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(p.order.update({ where: { id: fresh }, data: { status: "shipped" } })).rejects.toMatchObject({ code: "invalid" });
    const { result } = await runOp<{ status: string }>(pluginServer, "set-order-status", { ...base, viewer: packer as never, db: p, args: { orderId: preparing, status: "shipped" } });
    expect(result.status).toBe("shipped");
    expect(await p.order.count({})).toBe(0); // shipped: gone from the packer's list
  });
});
