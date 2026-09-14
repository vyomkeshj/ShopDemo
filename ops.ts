/**
 * WHAT EACH OP TAKES, SAID ONCE.
 *
 * server.ts parses with these (`handleOp`), app.tsx derives every tool from
 * them (`opTool`), and the UI sends exactly these fields. Before this file the
 * same shapes were written twice — once in the op, once on the tool — and the
 * two drifted: `add-product` accepted `imageUrl`, its tool did not, zod
 * stripped the field on the way in, and the tool said "Added Earl Grey" over a
 * product with no picture (2026-09-12). A field can no longer go missing from
 * a tool, and a field an op does not take is refused by name.
 *
 * `.describe()` here is what the model reads as a tool's parameter help.
 */
import { z } from "zod";
import { defineOps } from "esoul-sdk";

/**
 * A PICTURE IS A URL WE WILL PUT IN AN `img src`, so it is checked rather than
 * trusted: https only, and short enough to be a link rather than an embedded
 * payload. A `data:` URL would work in a browser and would also let anyone with
 * the owner's tool put a megabyte in a row that every shopper downloads;
 * `javascript:` is inert in an `img` but belongs nowhere near one.
 */
export const ImageUrl = z
  .string()
  .max(500)
  .refine((u) => /^https:\/\/[^\s]+$/i.test(u), { message: "a picture must be an https:// link" })
  .describe("A photograph of it — an https link, from generateAppImage or your own");

const ShipTo = z.object({
  name: z.string().min(1).max(120),
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
});
const orderId = z.string().min(1).describe("The order id, as list_orders shows it");
const productId = z.string().min(1).describe("The product id, as browse_shop shows it");
const tags = z.array(z.string().min(1).max(24)).max(8).describe('How the storefront groups it: "tea", "gifts", "new"');

export const ORDER_STATUSES = ["new", "preparing", "shipped", "fulfilled", "refunded"] as const;
export const ACCENTS = ["stone", "amber", "rose", "emerald", "indigo"] as const;
/** The till pages a hundred rows at a time; `take + 1` must stay under the platform's 200. */
export const SALES_PAGE = 100;

export const ops = defineOps({
  /**
   * THE SHELVES, ONE PAGE AT A TIME. A department and a search term are a
   * WHERE, not a filter the browser applies to whatever arrived; the page walks
   * by cursor so the hundredth page costs what the first one did.
   */
  browse: z.object({
    tag: z.string().min(1).max(24).optional().describe('One department, e.g. "tea" — the shop lists them in its state'),
    q: z.string().min(1).max(60).optional().describe("Part of a product name"),
    cursor: z.string().min(1).optional().describe("The last product id of the previous page, to see the next"),
    limit: z.number().int().min(1).max(48).optional(),
  }),
  /** One product, with everything its page shows. */
  product: z.object({ productId }),
  "add-to-cart": z.object({ productId, qty: z.number().int().min(1).max(99).default(1).describe("Adds to what is already there") }),
  "set-cart-qty": z.object({ productId, qty: z.number().int().min(0).max(99).describe("Zero takes it out") }),
  "view-cart": z.object({}),
  /** Who the shop is talking to, for the checkout form. */
  me: z.object({}),
  // A blank name at checkout is filled from the buyer's own account (server.ts),
  // so this one address allows it where `place-order` does not.
  checkout: z.object({
    shipTo: ShipTo.extend({ name: z.string().max(120).describe("Blank = the buyer's own account name") }),
    note: z.string().max(280).optional(),
  }),
  /** The owner: a product. */
  "add-product": z.object({
    name: z.string().min(1).max(80),
    priceCents: z.number().int().min(0).max(100_000_000),
    sku: z.string().min(1).max(40).optional(),
    description: z.string().max(2000).optional().describe("What it is, in the shop's own words — the product page is mostly this"),
    tagline: z.string().max(140).optional().describe("One line the shelf shows under the name"),
    imageUrl: ImageUrl.optional(),
    tags: tags.optional(),
  }),
  /** Only the fields named are touched; `active: false` takes it off the shelves and keeps the row. */
  "update-product": z.object({
    productId,
    name: z.string().min(1).max(80).optional(),
    priceCents: z.number().int().min(0).max(100_000_000).optional(),
    description: z.string().max(2000).optional().describe("The product page is mostly this — write it like a shop would"),
    tagline: z.string().max(140).optional().describe("One line the shelf shows under the name"),
    tags: tags.optional(),
    imageUrl: ImageUrl.optional(),
    active: z.boolean().optional().describe("false takes it off the shelves; the row and its sales are kept"),
  }),
  /** The shop's own face. A field left out is left alone; null clears. */
  "set-look": z.object({
    heroUrl: ImageUrl.nullable().optional().describe("The picture across the top, or null for the shop's own pattern"),
    tagline: z.string().max(160).nullable().optional().describe("The line under the shop's name"),
    accent: z.enum(ACCENTS).optional().describe("One of the shop's own palettes, by name — never raw CSS"),
  }),
  /** The desk's board. An empty text clears it. */
  "post-notice": z.object({ text: z.string().max(200) }),
  "list-people": z.object({}),
  "set-person-role": z.object({
    email: z.string().min(3).max(200).describe("The esoul account's email — they must have signed in once"),
    role: z.string().max(40).describe('One of the shop\'s own words — "staff", "customer", "owner" — or a role the owner composed (list-people names them) — or "" to take it back'),
  }),
  /**
   * COMPOSE A ROLE on top of `staff`: which order statuses it sees, which moves it may
   * make, whether it sees the customer's note, which desk actions it may call. The
   * platform keeps it inside the manifest's `roles.custom` envelope and enforces it in
   * every read and write. Owner only.
   */
  "define-role": z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/).describe('A name of its own, e.g. "packer" — not one of the shop\'s words'),
    describe: z.string().max(200).optional().describe("What this role is for, for the People screen"),
    statuses: z.array(z.enum(ORDER_STATUSES)).min(1).max(5).describe("The order statuses this role SEES — a packer sees preparing"),
    moves: z.record(z.enum(ORDER_STATUSES), z.array(z.enum(ORDER_STATUSES)).max(4)).optional().describe('The moves it may make, from → to: { "preparing": ["shipped"] }'),
    hideNote: z.boolean().optional().describe("Hide the customer's note from this role (default false)"),
    ops: z.array(z.enum(["set-order-status", "fulfil-order", "order-notice", "refund"])).optional().describe("Desk actions this role may call (default: set-order-status)"),
  }),
  "remove-role": z.object({ name: z.string().min(1).max(31) }),
  "place-order": z.object({
    lines: z.array(z.object({ productId, qty: z.number().int().min(1).max(99) })).min(1).max(50),
    shipTo: ShipTo,
    note: z.string().max(280).optional(),
  }),
  "list-orders": z.object({}),
  /** THE TILL: money and units per product, paged. */
  sales: z.object({
    productId: z.string().min(1).optional().describe("One product's history"),
    since: z.string().min(4).optional().describe("A date; sales from this moment on"),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(SALES_PAGE).optional(),
  }),
  refund: z.object({ orderId }),
  "set-order-status": z.object({ orderId, status: z.enum(ORDER_STATUSES) }),
  /** What the telling task needs: whose order, where it stands. */
  "order-notice": z.object({ orderId }),
  /** The fulfil task's hands. */
  "fulfil-order": z.object({ orderId }),
});

export type OpIn<K extends keyof typeof ops> = z.infer<(typeof ops)[K]>;
