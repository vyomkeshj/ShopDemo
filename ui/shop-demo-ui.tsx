"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Apple,
  ArrowLeft,
  ArrowRight,
  Cake,
  Candy,
  CheckCircle2,
  ClipboardList,
  Coffee,
  Cookie,
  Flower2,
  Gift,
  Loader2,
  LogIn,
  Minus,
  Package,
  PackageCheck,
  Plus,
  RotateCcw,
  Search,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Store,
  Tag,
  Trash2,
  Truck,
  Wine,
} from "lucide-react";
import { callPluginOp } from "esoul-sdk";
import { useAppCanEdit, usePluginEventDispatch, usePluginRealtime, useSignInWall, useViewer } from "esoul-sdk/react";
import { catalogueChangedEvent, PLUGIN_ID, shopChannel, type Cart, type ShopDemoData } from "../app";
import { ShopDesk, type DeskOrder, type DeskProduct } from "./shop-desk";
import {
  accentOf,
  EmptyBasketArt,
  Grain,
  HeroPattern,
  NoResultsArt,
  SealArt,
  ShopMark,
  SprigArt,
  TornEdge,
  WovenGround,
} from "./shop-art";

/**
 * A SHOP WITH PAGES.
 *
 * A front with departments, a department, a product, the basket, your orders —
 * and, for the people who run it, the desk. Which page you are on is ordinary
 * component state: a navigation is one person's, on one device, in one moment,
 * and putting it on the timeline would move someone else's screen.
 *
 * What is worth reading here is that four different shops come out of one
 * file, and not one line of it checks anything:
 *
 *   a stranger   the shelves, a product page, and a reason to sign in
 *   a customer   those, plus a basket and their own orders
 *   staff        the desk — every order, moved along by hand
 *   the owner     the desk, and the price list
 *
 * Each screen calls the ops it needs and renders what came back. A customer's
 * `list-orders` returns theirs and staff's returns the shop's, because the
 * rules in the manifest decided — so the JSX cannot forget a check it never
 * had to make.
 *
 * The basket is SERVER-SIDE, which is what lets an agent work it: "add two of
 * the Earl Grey, make it three, now check out" are three tool calls against
 * the same rows this screen reads, and the screen moves as they land.
 *
 * Pictures are lucide icons chosen from each product's own name and stock
 * code, so a shop looks like a shop before anyone uploads anything.
 * Styling follows app-style-guide.md: sepia in light, translucent in dark.
 */

interface Product {
  id: string;
  name: string;
  priceCents: number;
  sku: string | null;
  tags: string[];
  description: string | null;
  /** One line for the shelf. Absent on a shop nobody has written yet. */
  tagline?: string | null;
  /** A photograph, if this shop has one of this thing. */
  imageUrl?: string | null;
}
interface Order {
  id: string;
  status: string;
  totalCents: number;
  lines: { productId: string; name: string; qty: number; priceCents: number }[];
  shipTo: { name: string; street: string; city: string };
  note: string | null;
  createdAt: string;
}

const money = (cents: number) => `${(cents / 100).toFixed(2)}`;

/* ── a picture for a thing, before anyone uploaded one ───────────────────── */

const SHELF = [
  { match: /\btea\b|coffee|espresso|latte|brew|earl.?grey|matcha|chai/i, Icon: Coffee },
  { match: /cake|tart|pastry|muffin|bun\b/i, Icon: Cake },
  { match: /cookie|biscuit|shortbread/i, Icon: Cookie },
  { match: /wine|beer|gin|whisk|rum\b|cider|vermouth/i, Icon: Wine },
  { match: /sweet|candy|choc|fudge|toffee/i, Icon: Candy },
  { match: /apple|fruit|veg|greens|salad/i, Icon: Apple },
  { match: /flower|plant|bouquet|rose|tulip|sunflower/i, Icon: Flower2 },
  { match: /shirt|tee\b|hoodie|sock|wear|apron|linen|scarf|hat\b|cloth/i, Icon: Shirt },
  { match: /gift|voucher|card\b/i, Icon: Gift },
];
const FALLBACK = [Package, ShoppingBag, Sparkles, Store];

/**
 * A picture for a thing. The NAME first, then the STOCK CODE — a shop that
 * calls something "Earl Grey" or "Linen apron" still files it under TEA-01 and
 * APR-01, and the code is often the plainer word. Deterministic either way:
 * the same product always has the same picture.
 */
export function iconFor(name: string, sku?: string | null) {
  const text = `${name ?? ""} ${sku ?? ""}`;
  const hit = SHELF.find((s) => s.match.test(text));
  if (hit) return hit.Icon;
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length]!;
}

/* ── where an order stands ───────────────────────────────────────────────── */

const FLOW = ["new", "preparing", "shipped", "fulfilled"] as const;
const STATUS: Record<string, { label: string; Icon: typeof Package; tone: string }> = {
  new: { label: "Placed", Icon: ClipboardList, tone: "bg-sky-100 text-sky-900 dark:bg-sky-400/15 dark:text-sky-100" },
  preparing: { label: "Preparing", Icon: Loader2, tone: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-100" },
  shipped: { label: "On its way", Icon: Truck, tone: "bg-indigo-100 text-indigo-900 dark:bg-indigo-400/15 dark:text-indigo-100" },
  fulfilled: { label: "Delivered", Icon: PackageCheck, tone: "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100" },
  refunded: { label: "Refunded", Icon: RotateCcw, tone: "bg-stone-200 text-stone-700 dark:bg-white/10 dark:text-stone-300" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, Icon: Package, tone: "bg-stone-200 text-stone-700 dark:bg-white/10" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.tone}`}>
      <s.Icon className="h-3 w-3" aria-hidden />
      {s.label}
    </span>
  );
}

/** The journey of one order, as a customer reads it. */
function Journey({ status }: { status: string }) {
  if (status === "refunded") return null;
  const at = FLOW.indexOf(status as (typeof FLOW)[number]);
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1" aria-label={`Order is ${status}`}>
      {FLOW.map((stage, i) => {
        const done = at >= 0 && i <= at;
        const s = STATUS[stage]!;
        return (
          <li key={stage} className="flex items-center gap-1">
            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${done ? s.tone : "bg-stone-100 text-stone-400 dark:bg-white/5 dark:text-stone-500"}`}>
              {done && i === at ? <s.Icon className="h-2.5 w-2.5" aria-hidden /> : null}
              {s.label}
            </span>
            {i < FLOW.length - 1 ? <ArrowRight className="h-2.5 w-2.5 text-stone-300 dark:text-stone-600" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

const card = "rounded-xl border border-stone-300/70 bg-white/70 dark:border-white/15 dark:bg-white/5";
const solid = "rounded-lg bg-stone-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-white dark:text-stone-900";
const ghost = "rounded-lg border border-stone-400/60 px-2.5 py-1 text-[12px] hover:bg-stone-100 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10";
const stepper = "grid h-7 w-7 place-items-center rounded-md border border-stone-400/60 hover:bg-stone-100 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10";
const field = "rounded-lg border border-stone-300/70 bg-white/70 px-2 py-1.5 dark:border-white/15 dark:bg-white/5";
/** A department, offered and chosen. The chosen one is a filled pill. */
const chip = "rounded-full border border-stone-300/70 px-2.5 py-1 text-[12px] capitalize hover:bg-stone-100 dark:border-white/15 dark:hover:bg-white/10";
const chipOn = "rounded-full border border-stone-900 bg-stone-900 px-2.5 py-1 text-[12px] capitalize text-white dark:border-white dark:bg-white dark:text-stone-900";

/** Where the shopper is. Per-person and per-moment: never an event. */
type Page = { at: "home" } | { at: "tag"; tag: string } | { at: "product"; id: string } | { at: "cart" } | { at: "orders" };

export function ShopDemoUi({ state }: { state: ShopDemoData }) {
  const viewer = useViewer();
  const wall = useSignInWall();
  const canEdit = useAppCanEdit();
  const dispatch = usePluginEventDispatch();
  const nodeId = state?.nodeId ?? "";

  const [page, setPage] = useState<Page>({ at: "home" });
  const [products, setProducts] = useState<Product[] | null>(null);
  // WHAT THE SHOPPER IS LOOKING AT: one department, one search term, and how
  // far down the shelf they have walked. All three are the SERVER's questions
  // now — with a big catalogue, a department the browser filters for is a
  // department that looks empty.
  const [dept, setDept] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [detail, setDetail] = useState<Product | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const op = useCallback(<T,>(name: string, args?: unknown) => callPluginOp<T>(PLUGIN_ID, name, nodeId, args), [nodeId]);
  const isDesk = viewer.role === "staff" || viewer.role === "owner";
  const isOwner = viewer.role === "owner";
  const shops = !isDesk;

  type Shelf = { items: Product[]; nextCursor: string | null };
  const loadProducts = useCallback(() => {
    if (!nodeId) return;
    setProducts(null);
    setNextCursor(null);
    op<Shelf>("browse", { ...(dept ? { tag: dept } : {}), ...(query ? { q: query } : {}) }).then(
      (r) => {
        setProducts(r.items);
        setNextCursor(r.nextCursor);
      },
      (e) => setError(String(e?.message ?? e)),
    );
  }, [nodeId, op, dept, query]);
  useEffect(loadProducts, [loadProducts, state?.catalogueVersion]);

  /** The next page, appended — the shelf continues rather than starting again. */
  const loadMore = useCallback(() => {
    if (!nodeId || !nextCursor) return;
    setMore(true);
    op<Shelf>("browse", { ...(dept ? { tag: dept } : {}), ...(query ? { q: query } : {}), cursor: nextCursor })
      .then(
        (r) => {
          setProducts((prev) => [...(prev ?? []), ...r.items]);
          setNextCursor(r.nextCursor);
        },
        (e) => setError(String(e?.message ?? e)),
      )
      .finally(() => setMore(false));
  }, [nodeId, op, dept, query, nextCursor]);

  const loadOrders = useCallback(() => {
    if (!nodeId || !viewer.signedIn) return;
    op<Order[]>("list-orders").then(setOrders, (e) => setError(String(e?.message ?? e)));
  }, [nodeId, viewer.signedIn, op]);
  useEffect(loadOrders, [loadOrders]);

  // Who the shop is talking to, for the checkout form. They signed into esoul
  // already; making them type their own name again is a small rudeness.
  const [me, setMe] = useState<{ name: string | null; email: string | null } | null>(null);
  useEffect(() => {
    if (!nodeId || !viewer.signedIn || isDesk) return;
    op<{ name: string | null; email: string | null }>("me").then(setMe, () => undefined);
  }, [nodeId, viewer.signedIn, isDesk, op]);

  const loadCart = useCallback(() => {
    if (!nodeId || !viewer.signedIn || isDesk) return;
    op<Cart>("view-cart").then(setCart, () => undefined);
  }, [nodeId, viewer.signedIn, isDesk, op]);
  useEffect(loadCart, [loadCart]);

  /**
   * The page moves by itself. The platform mints this viewer a token for the
   * shop's open channel and for THEIR OWN, and nothing else — so an agent
   * putting something in this person's basket, or the desk moving their order,
   * lands here, and another customer's news never does. A message is a NUDGE:
   * what is shown is still re-read through the op, so the rules decide.
   */
  const live = usePluginRealtime<{ orderId?: string; status?: string; count?: number }>({
    channel: shopChannel,
    workspaceId: state?.workspaceId ?? "",
    nodeId,
    topics: shopChannel.topicNames,
    enabled: !!nodeId && viewer.signedIn,
  });
  const lastLive = live.latestData;
  useEffect(() => {
    if (!lastLive) return;
    if (lastLive.topic === "cart") loadCart();
    if (lastLive.topic === "order-status" || lastLive.topic === "new-order") loadOrders();
    if (lastLive.topic === "catalogue") loadProducts();
  }, [lastLive, loadCart, loadOrders, loadProducts]);

  // A product page reads the ONE product, so a description too long for a card
  // is not carried around the whole catalogue.
  const pageKey = page.at === "product" ? page.id : "";
  useEffect(() => {
    if (!pageKey) return;
    setDetail(null);
    op<Product>("product", { productId: pageKey }).then(setDetail, (e) => setError(String(e?.message ?? e)));
  }, [pageKey, op]);

  // THE DEPARTMENTS COME FROM THE FOLD, not from whatever arrived on this
  // page. A storefront has to offer every department it has, and a page of 24
  // products out of 100 000 knows almost none of them.
  const departments = useMemo(() => [...(state?.departments ?? [])], [state?.departments]);
  // Sections only when nobody narrowed anything: a chosen department or a
  // search term is already one answer, and grouping it again would be noise.
  const sections = useMemo(() => {
    if (dept || query) return [];
    const byTag = new Map<string, Product[]>();
    for (const p of products ?? []) for (const t of p.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), p]);
    return [...byTag.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [products, dept, query]);
  const untagged = useMemo(() => (dept || query ? [] : (products ?? []).filter((p) => !p.tags?.length)), [products, dept, query]);
  const narrowed = useMemo(() => (dept || query ? (products ?? []) : []), [products, dept, query]);
  const cartCount = useMemo(() => (cart?.lines ?? []).reduce((n, l) => n + l.qty, 0), [cart]);
  const inCart = useCallback((id: string) => (cart?.lines ?? []).find((l) => l.productId === id)?.qty ?? 0, [cart]);
  /**
   * HOW THIS SHOP LOOKS, from its own fold. Both are optional and both have a
   * drawn answer, so a shop nobody has dressed is a different-looking shop
   * rather than a broken one.
   */
  const accent = useMemo(() => accentOf(state?.look?.accent), [state?.look?.accent]);
  const hero = state?.look?.heroUrl ?? null;

  /* ── the things a shopper does ─────────────────────────────────────────── */

  const guard = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // A `login-required` raises the wall; anything else is shown.
      try {
        wall.raise(e);
      } catch (other) {
        setError(String((other as Error)?.message ?? other));
      }
    } finally {
      setBusy(null);
    }
  };

  const addToCart = (p: Product, qty = 1) => guard(p.id, async () => setCart(await op<Cart>("add-to-cart", { productId: p.id, qty })));
  const setQty = (productId: string, qty: number) => guard(productId, async () => setCart(await op<Cart>("set-cart-qty", { productId, qty })));

  const checkout = (form: FormData) =>
    guard("checkout", async () => {
      const note = String(form.get("note") ?? "").trim();
      const r = await op<{ orderId: string }>("checkout", {
        shipTo: { name: String(form.get("name") ?? ""), street: String(form.get("street") ?? ""), city: String(form.get("city") ?? "") },
        ...(note ? { note } : {}),
      });
      setCart({ lines: [], totalCents: 0 });
      setPlaced(r.orderId);
      setPage({ at: "orders" });
      loadOrders();
    });

  const move = (o: Order, status: string) =>
    guard(o.id, async () => {
      await op(status === "refunded" ? "refund" : "set-order-status", status === "refunded" ? { orderId: o.id } : { orderId: o.id, status });
      loadOrders();
    });

  const addProduct = (form: FormData) =>
    guard("add", async () => {
      const name = String(form.get("name") ?? "").trim();
      const priceCents = Math.round(Number(form.get("price") ?? 0) * 100);
      if (!name || !Number.isFinite(priceCents)) return;
      const sku = String(form.get("sku") ?? "").trim();
      const description = String(form.get("description") ?? "").trim();
      const added = await op<{ id: string }>("add-product", {
        name,
        priceCents,
        ...(sku ? { sku } : {}),
        ...(description ? { description } : {}),
        tags: String(form.get("tags") ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      });
      // The SERVER records this too (`add-product` emits it), with the same
      // change id derived from the product — so whichever lands first wins and
      // the other is a no-op. This one is here for the person who pressed Add:
      // their own screen should not wait for a round trip.
      dispatch?.(
        catalogueChangedEvent.dataCreator({
          changeId: `product:${added.id}`,
          workspaceId: state.workspaceId,
          nodeId: state.nodeId,
          applicationId: state.nodeId,
          instanceName: state.instanceName,
          what: `added ${name}`,
          // The departments this product introduced, so the storefront can
          // offer them without asking the catalogue what its departments are.
          tags: String(form.get("tags") ?? "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        }),
      );
      loadProducts();
    });

  /* ── pieces ────────────────────────────────────────────────────────────── */

  /**
   * THE PICTURE OF A THING — a photograph if the shop has one, and the thing's
   * own drawn portrait if it does not.
   *
   * The two are the SAME SIZE and the same shape, so a shop that has
   * photographed half its shelves does not look half-broken; and the drawn one
   * is a woven ground with the product's icon on it rather than a grey box,
   * because a grey box is how a shop looks closed. The aspect ratio is fixed
   * either way, so nothing jumps when a photograph arrives late.
   */
  const Picture = ({ p, className = "", iconClass = "h-9 w-9", sizes }: { p: Product; className?: string; iconClass?: string; sizes?: string }) => {
    const Icon = iconFor(p.name, p.sku);
    const tone = accentOf(state?.look?.accent);
    if (p.imageUrl) {
      return (
        <span className={`relative block overflow-hidden bg-stone-100 dark:bg-white/5 ${className}`}>
          <img
            src={p.imageUrl}
            alt={p.name}
            loading="lazy"
            decoding="async"
            sizes={sizes}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
          />
          <Grain opacity={0.045} />
        </span>
      );
    }
    return (
      <span className={`relative grid place-items-center bg-gradient-to-br from-stone-100 via-stone-50 to-stone-200/70 dark:from-white/[0.07] dark:via-transparent dark:to-white/[0.04] ${className}`}>
        <WovenGround className="absolute inset-0 h-full w-full text-stone-400/60 dark:text-white/25" />
        <Icon className={`relative ${iconClass} ${tone.soft}`} aria-hidden />
      </span>
    );
  };

  const ProductCard = ({ p }: { p: Product }) => {
    const have = inCart(p.id);
    const tone = accentOf(state?.look?.accent);
    return (
      <li className={`group relative flex flex-col overflow-hidden rounded-2xl bg-white/80 ring-1 ${tone.ring} transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_12px_30px_-18px_rgba(28,25,23,0.5)] dark:bg-white/[0.04]`}>
        <button
          type="button"
          onClick={() => setPage({ at: "product", id: p.id })}
          className="flex flex-col items-stretch text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/40 dark:focus-visible:ring-white/40"
        >
          <Picture p={p} className="aspect-square w-full" iconClass="h-12 w-12" sizes="(max-width: 640px) 50vw, 25vw" />
          <span className="flex min-w-0 flex-col gap-0.5 px-3 pb-2 pt-2.5">
            <span className="truncate text-[13.5px] font-medium leading-tight">{p.name}</span>
            {p.tagline ? (
              <span className="line-clamp-2 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{p.tagline}</span>
            ) : p.description ? (
              <span className="line-clamp-2 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{p.description}</span>
            ) : null}
            <span className="mt-0.5 text-[15px] font-semibold tabular-nums">{money(p.priceCents)}</span>
          </span>
        </button>
        {shops ? (
          <div className="mt-auto px-3 pb-3">
            <button
              type="button"
              disabled={busy === p.id}
              onClick={() => addToCart(p)}
              className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50 ${
                have ? `border border-current ${tone.ink} bg-transparent` : tone.pill
              }`}
            >
              {busy === p.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : have ? (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ShoppingCart className="h-3.5 w-3.5" aria-hidden />
              )}
              {have ? `In basket · ${have}` : "Add to basket"}
            </button>
          </div>
        ) : null}
      </li>
    );
  };

  const Grid = ({ items }: { items: Product[] }) => (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </ul>
  );

  const Back = ({ to, children }: { to: Page; children: React.ReactNode }) => (
    <button type="button" onClick={() => setPage(to)} className="inline-flex w-fit items-center gap-1 text-[12px] text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {children}
    </button>
  );

  return (
    <div className="shop-root flex h-full w-full flex-col overflow-auto bg-stone-50 text-[13px] text-stone-800 dark:bg-stone-900 dark:text-stone-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-stone-300/60 bg-stone-50/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-stone-900/70 sm:px-6">
        <button type="button" onClick={() => setPage({ at: "home" })} className="flex items-center gap-2.5 text-left">
          <span className={`grid h-9 w-9 place-items-center rounded-xl ${accent.pill}`}>
            <ShopMark className="h-[18px] w-[18px]" />
          </span>
          <span>
            <span className="block text-[15px] font-semibold leading-tight tracking-tight">{state?.instanceName ?? "Shop"}</span>
            <span className="block text-[11px] text-stone-500 dark:text-stone-400">{isDesk ? "The desk — every order of this shop" : "Fresh things, ordered in one tap"}</span>
          </span>
        </button>

        <nav className="ml-auto flex flex-wrap items-center gap-1.5">
          {shops ? (
            <>
              <button type="button" onClick={() => setPage({ at: "cart" })} className={`${ghost} inline-flex items-center gap-1.5`}>
                <ShoppingCart className="h-3.5 w-3.5" aria-hidden /> Basket
                {cartCount ? <span className="rounded-full bg-stone-900 px-1.5 text-[10px] text-white dark:bg-white dark:text-stone-900">{cartCount}</span> : null}
              </button>
              {viewer.signedIn ? (
                <button type="button" onClick={() => setPage({ at: "orders" })} className={`${ghost} inline-flex items-center gap-1.5`}>
                  <ClipboardList className="h-3.5 w-3.5" aria-hidden /> Orders
                </button>
              ) : null}
            </>
          ) : null}
          <span className="rounded-full border border-stone-300/70 px-2.5 py-1 text-[11px] text-stone-500 dark:border-white/15 dark:text-stone-400">
            you are: <span className="font-medium text-stone-700 dark:text-stone-200">{viewer.role}</span>
            {!viewer.signedIn ? " · not signed in" : ""}
          </span>
        </nav>
      </header>

      <div className="flex flex-1 flex-col gap-5 p-4 sm:p-6">
        {state?.announcements?.length ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{state.announcements[0].text}</span>
          </div>
        ) : null}

        {error ? <div className="rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100">{error}</div> : null}

        {wall.needed ? (
          <div className={`${card} flex flex-wrap items-center justify-between gap-3 p-4`}>
            <p className="text-[13px]">
              <span className="font-medium">Sign in to order.</span> <span className="text-stone-500 dark:text-stone-400">Orders and addresses stay yours, on every device.</span>
            </p>
            <button type="button" onClick={wall.signIn} className={`${solid} inline-flex items-center gap-1.5`}>
              <LogIn className="h-4 w-4" aria-hidden /> Sign in
            </button>
          </div>
        ) : null}

        {/* the front */}
        {shops && page.at === "home" ? (
          <>
            {/* THE FRONT OF THE SHOP.
                A photograph when the owner has set one, the shop's own drawn
                morning when they have not — the same shape either way, with
                the words over a scrim so they are readable on any picture that
                arrives. The torn bottom edge is what stops it reading as a
                banner advert. */}
            <section className="relative -mx-4 overflow-hidden sm:-mx-6">
              <div className={`relative isolate flex min-h-[13.5rem] flex-col justify-end sm:min-h-[17rem] ${accent.ink}`}>
                {hero ? (
                  <>
                    <img src={hero} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
                    {/* TWO SCRIMS, ON TWO AXES. One up from the bottom for the
                        words, one in from the left for the column they sit in —
                        a photograph is bright wherever it likes, and on a phone
                        the crop puts its brightest part right under the
                        headline. One gradient was not enough; this was measured
                        on the phone screenshot, not guessed. */}
                    <div className="absolute inset-0 bg-gradient-to-t from-stone-950/88 via-stone-950/45 to-stone-950/10" />
                    <div className="absolute inset-0 bg-gradient-to-r from-stone-950/70 via-stone-950/20 to-transparent" />
                    <Grain opacity={0.06} />
                  </>
                ) : (
                  <>
                    <HeroPattern className={`absolute inset-0 h-full w-full ${accent.soft}`} />
                    <div className={`absolute inset-0 bg-gradient-to-br ${accent.wash} opacity-70`} />
                  </>
                )}
                <div className={`relative px-4 pb-7 pt-10 sm:px-6 ${hero ? "text-white" : ""}`}>
                  <p className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] ${hero ? "text-white/75" : "opacity-70"}`}>
                    <ShopMark className="h-3.5 w-3.5" /> open today
                  </p>
                  <h2 className="mt-2 max-w-xl text-[1.6rem] font-semibold leading-[1.12] tracking-tight sm:text-[2.1rem]">
                    {state?.look?.tagline || "Everything on the shelves today"}
                  </h2>
                  <p className={`mt-2 max-w-md text-[12.5px] leading-5 ${hero ? "text-white/80" : "opacity-75"}`}>
                    Open a thing to read about it, put it in the basket, change your mind, then order — or ask the assistant to do
                    any of it for you.
                  </p>
                  {departments.length ? (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {departments.slice(0, 6).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setDept(t);
                            setPage({ at: "home" });
                          }}
                          className={`rounded-full px-3 py-1 text-[11.5px] font-medium capitalize backdrop-blur transition ${
                            hero ? "bg-white/15 text-white ring-1 ring-white/25 hover:bg-white/25" : "bg-white/70 ring-1 ring-stone-900/10 hover:bg-white dark:bg-white/10 dark:ring-white/15"
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <TornEdge className="absolute -bottom-px left-0 h-[18px] w-full text-stone-50 dark:text-stone-900" />
              </div>
            </section>

            {/* What a shop says about itself in three short promises. */}
            <ul className="-mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                { Icon: PackageCheck, title: "Packed the morning it goes out", line: "Nothing sits in a warehouse waiting for you." },
                { Icon: Truck, title: "Ostrava and the villages round it", line: "Two days, usually one. We tell you when it moves." },
                { Icon: Sparkles, title: "Ask, and it is done", line: "The assistant can fill your basket and order it." },
              ].map(({ Icon, title, line }) => (
                <li key={title} className={`flex items-start gap-2.5 rounded-xl bg-white/60 px-3 py-2.5 ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${accent.soft}`} aria-hidden />
                  <span>
                    <span className="block text-[12px] font-medium leading-tight">{title}</span>
                    <span className="block text-[11px] leading-4 text-stone-500 dark:text-stone-400">{line}</span>
                  </span>
                </li>
              ))}
            </ul>

            {/* FINDING THINGS. Both of these are questions for the server: with
                a big catalogue, a department the browser filters for is a
                department that looks empty. */}
            <section className="flex flex-col gap-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setQuery(term.trim());
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden />
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="Search the shop"
                    aria-label="Search the shop"
                    className={`${field} pl-9`}
                  />
                </div>
                <button type="submit" className={solid}>
                  Search
                </button>
                {query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTerm("");
                      setQuery("");
                    }}
                    className={ghost}
                  >
                    Clear
                  </button>
                ) : null}
              </form>
              {departments.length ? (
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setDept(null)} className={dept === null ? chipOn : chip}>
                    Everything
                  </button>
                  {departments.map((t) => (
                    <button key={t} type="button" onClick={() => setDept(t === dept ? null : t)} className={t === dept ? chipOn : chip}>
                      {t}
                    </button>
                  ))}
                </div>
              ) : null}
              {dept || query ? (
                <p className="text-[12px] text-stone-500 dark:text-stone-400">
                  {dept ? `In ${dept}` : "Everything"}
                  {query ? ` matching “${query}”` : ""}
                  {products ? ` — ${products.length}${nextCursor ? "+" : ""} found` : ""}
                </p>
              ) : null}
            </section>

            {products === null ? (
              <p className="text-stone-500">Setting out the shelves…</p>
            ) : products.length === 0 ? (
              <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
                <NoResultsArt className={`h-20 w-20 ${accent.soft}`} />
                <p className="text-[13px] font-medium">{dept || query ? "Nothing here yet" : "The shelves are empty"}</p>
                <p className="max-w-xs text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">
                  {query ? `Nothing matching “${query}”.` : dept ? `Nothing in ${dept} today.` : "The owner has not put anything out."}
                  {dept || query ? " Try everything, or another department." : ""}
                </p>
                {dept || query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDept(null);
                      setTerm("");
                      setQuery("");
                    }}
                    className={`mt-1 rounded-xl px-3 py-1.5 text-[12px] font-medium ${accent.pill}`}
                  >
                    Show everything
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                {narrowed.length ? <Grid items={narrowed} /> : null}
                {sections.map(([tag, items]) => (
                  <section key={tag}>
                    <div className="mb-2 flex items-baseline justify-between">
                      <h2 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                        <Tag className="h-3.5 w-3.5" aria-hidden /> {tag}
                      </h2>
                      {items.length > 4 ? (
                        <button type="button" onClick={() => setPage({ at: "tag", tag })} className="text-[12px] text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100">
                          See all {items.length}
                        </button>
                      ) : null}
                    </div>
                    <Grid items={items.slice(0, 4)} />
                  </section>
                ))}
                {untagged.length ? (
                  <section>
                    <h2 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                      <ShoppingBag className="h-3.5 w-3.5" aria-hidden /> Everything else
                    </h2>
                    <Grid items={untagged} />
                  </section>
                ) : null}
                {/* The shelf continues. One more page, appended — never a
                    restart, and never a button that leads nowhere, because
                    `browse` asked for one more than it showed. */}
                {nextCursor ? (
                  <button type="button" onClick={loadMore} disabled={more} className={`${ghost} mx-auto`}>
                    {more ? "Fetching…" : "Show more"}
                  </button>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {/* a department */}
        {shops && page.at === "tag" ? (
          <section className="flex flex-col gap-3">
            <Back to={{ at: "home" }}>All departments</Back>
            <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
              <Tag className="h-4 w-4 text-stone-400" aria-hidden /> {page.tag}
            </h2>
            {/* The server already answered this question — see `dept` above. */}
            <Grid items={products ?? []} />
            {nextCursor ? (
              <button type="button" onClick={loadMore} disabled={more} className={`${ghost} mx-auto`}>
                {more ? "Fetching…" : "Show more"}
              </button>
            ) : null}
          </section>
        ) : null}

        {/* one product */}
        {page.at === "product" ? (
          <section className="flex flex-col gap-3">
            <Back to={{ at: "home" }}>Back to the shop</Back>
            {detail === null ? (
              <p className="text-stone-500">Fetching it…</p>
            ) : (
              <div className="grid gap-6 sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                <div className="group relative">
                  <Picture
                    p={detail}
                    className={`aspect-square w-full rounded-3xl ring-1 ${accent.ring} shadow-[0_24px_50px_-32px_rgba(28,25,23,0.6)]`}
                    iconClass="h-24 w-24"
                    sizes="(max-width: 640px) 92vw, 22rem"
                  />
                  {/* a corner flourish, so the picture is framed rather than pasted */}
                  <SprigArt className={`absolute -bottom-2 left-1/2 h-4 w-12 -translate-x-1/2 ${accent.soft}`} />
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-[1.45rem] font-semibold leading-tight tracking-tight">{detail.name}</h2>
                    {detail.tagline ? <p className="mt-1 max-w-prose text-[13px] italic leading-5 text-stone-500 dark:text-stone-400">{detail.tagline}</p> : null}
                    <p className="mt-2 text-2xl font-semibold tabular-nums">{money(detail.priceCents)}</p>
                    {detail.sku ? <p className="mt-0.5 font-mono text-[11px] text-stone-400">{detail.sku}</p> : null}
                  </div>
                  {detail.tags?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {detail.tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setPage({ at: "tag", tag: t })}
                          className="rounded-full border border-stone-300/70 px-2 py-0.5 text-[11px] text-stone-600 hover:bg-stone-100 dark:border-white/15 dark:text-stone-300 dark:hover:bg-white/10"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {detail.description ? (
                    <div className="max-w-prose space-y-2.5 text-[13.5px] leading-[1.65] text-stone-600 dark:text-stone-300">
                      {detail.description.split(/\n{2,}/).map((para, i) => (
                        <p key={i} className={i === 0 ? "first-letter:float-left first-letter:mr-1 first-letter:text-[2.1rem] first-letter:font-semibold first-letter:leading-[0.85] first-letter:text-stone-800 dark:first-letter:text-stone-100" : ""}>
                          {para}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="max-w-prose text-[13px] leading-relaxed text-stone-500 dark:text-stone-400">The shop has not written about this one yet.</p>
                  )}
                  {shops ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <button type="button" disabled={busy === detail.id} onClick={() => addToCart(detail)} className={`${solid} inline-flex items-center gap-1.5`}>
                        {busy === detail.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />} Add to basket
                      </button>
                      {inCart(detail.id) ? (
                        <span className="text-[12px] text-stone-500 dark:text-stone-400">
                          {inCart(detail.id)} in your basket —{" "}
                          <button type="button" onClick={() => setPage({ at: "cart" })} className="underline underline-offset-2">
                            go there
                          </button>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* the basket */}
        {shops && page.at === "cart" ? (
          <section className="flex flex-col gap-3">
            <Back to={{ at: "home" }}>Keep shopping</Back>
            <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
              <ShoppingCart className="h-4 w-4 text-stone-400" aria-hidden /> Your basket
            </h2>
            {!viewer.signedIn ? (
              <p className="text-stone-500">Sign in and your basket follows you.</p>
            ) : !cart || cart.lines.length === 0 ? (
              <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
                <EmptyBasketArt className={`h-24 w-24 ${accent.soft}`} />
                <p className="text-[13px] font-medium">Nothing in it yet</p>
                <p className="max-w-xs text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">
                  Put something in from the shelves — or ask the assistant to, and watch this page fill itself.
                </p>
                <button type="button" onClick={() => setPage({ at: "home" })} className={`mt-1 rounded-xl px-3 py-1.5 text-[12px] font-medium ${accent.pill}`}>
                  Back to the shelves
                </button>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
                <ul className="flex flex-col gap-2">
                  {cart.lines.map((l) => {
                    const Icon = iconFor(l.name, l.sku);
                    return (
                      <li key={l.lineId} className={`${card} flex flex-wrap items-center gap-3 p-3`}>
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500 dark:bg-white/10 dark:text-stone-300">
                          <Icon className="h-6 w-6" aria-hidden />
                        </span>
                        <button type="button" onClick={() => setPage({ at: "product", id: l.productId })} className="min-w-0 flex-1 text-left">
                          <span className="block truncate font-medium">{l.name}</span>
                          <span className="text-[11px] text-stone-500 dark:text-stone-400">{money(l.priceCents)} each</span>
                        </button>
                        <div className="flex items-center gap-1">
                          <button type="button" aria-label="One fewer" disabled={busy === l.productId} onClick={() => setQty(l.productId, l.qty - 1)} className={stepper}>
                            <Minus className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <span className="w-7 text-center tabular-nums">{l.qty}</span>
                          <button type="button" aria-label="One more" disabled={busy === l.productId} onClick={() => setQty(l.productId, l.qty + 1)} className={stepper}>
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </div>
                        <span className="w-16 text-right font-semibold tabular-nums">{money(l.priceCents * l.qty)}</span>
                        <button type="button" aria-label={`Take ${l.name} out`} disabled={busy === l.productId} onClick={() => setQty(l.productId, 0)} className={`${stepper} text-rose-600 dark:text-rose-300`}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>

                <form
                  className={`${card} flex h-fit flex-col gap-2 p-4`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void checkout(new FormData(e.currentTarget));
                  }}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">To pay</span>
                    <span className="text-xl font-semibold tabular-nums">{money(cart.totalCents)}</span>
                  </div>
                  <p className="text-[11px] text-stone-500 dark:text-stone-400">Priced by the shop when you order, not when you added it.</p>
                  <input name="name" required placeholder="Your name" defaultValue={me?.name ?? ""} className={field} />
                  {me?.email ? <p className="text-[11px] text-stone-500 dark:text-stone-400">The receipt goes to {me.email}.</p> : null}
                  <input name="street" required placeholder="Street" className={field} />
                  <input name="city" required placeholder="City" className={field} />
                  <input name="note" placeholder="Anything we should know (optional)" className={field} />
                  <button type="submit" disabled={busy === "checkout"} className={`${solid} mt-1 inline-flex items-center justify-center gap-1.5`}>
                    {busy === "checkout" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />} Place the order
                  </button>
                </form>
              </div>
            )}
          </section>
        ) : null}

        {/* your orders */}
        {shops && page.at === "orders" ? (
          <section className="flex flex-col gap-3">
            <Back to={{ at: "home" }}>Keep shopping</Back>
            <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
              <ClipboardList className="h-4 w-4 text-stone-400" aria-hidden /> Your orders
            </h2>
            {placed ? (
              <div className="flex items-center gap-3 rounded-2xl border border-emerald-300/60 bg-emerald-50/70 px-4 py-3 dark:border-emerald-400/30 dark:bg-emerald-400/10">
                <SealArt className="h-11 w-11 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <p className="text-[12.5px] leading-5 text-emerald-900 dark:text-emerald-100">
                  <span className="font-medium">Thank you.</span> Order <span className="font-mono">{placed.slice(0, 8)}</span> is with the shop —
                  this page follows it, and we write when it moves.
                </p>
              </div>
            ) : null}
            {orders === null ? (
              <p className="text-stone-500">Looking…</p>
            ) : orders.length === 0 ? (
              <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
                <SealArt className={`h-12 w-12 ${accent.soft}`} />
                <p className="text-[13px] font-medium">Nothing ordered yet</p>
                <p className="max-w-xs text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">When you order, it appears here and stays — on every device you sign in on.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {orders.map((o) => (
                  <li key={o.id} className={`${card} p-3`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={o.status} />
                      <span className="font-mono text-[10px] text-stone-400">{o.id.slice(0, 8)}</span>
                      <span className="ml-auto text-[14px] font-semibold tabular-nums">{money(o.totalCents)}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-stone-600 dark:text-stone-300">{o.lines.map((l) => `${l.qty} × ${l.name}`).join(", ")}</p>
                    <Journey status={o.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {/* the desk */}
        {/* ── THE DESK ──────────────────────────────────────────────────────
             A back office is not a storefront with the prices showing: it is
             a queue, a table, an editor, a till and a book of who may help.
             It lives in its own file because it is its own product. */}
        {isDesk ? (
          <ShopDesk
            instanceName={state?.instanceName ?? "Shop"}
            look={state?.look}
            announcements={state?.announcements ?? []}
            departments={departments}
            isOwner={isOwner}
            canEdit={canEdit}
            products={products as DeskProduct[] | null}
            nextCursor={nextCursor}
            onLoadMore={loadMore}
            loadingMore={more}
            orders={orders as DeskOrder[] | null}
            op={op}
            refreshProducts={loadProducts}
            refreshOrders={loadOrders}
            busy={busy}
            run={guard}
          />
        ) : null}
      </div>

      {/* The bottom of the shop. A sprig, a name, and who is actually serving
          you — the last one is not decoration: this storefront is the same app
          an agent drives, and a person should be told that plainly. */}
      <footer className="mt-auto flex flex-col items-center gap-1.5 px-4 pb-6 pt-8 text-center sm:px-6">
        <SprigArt className={`h-4 w-12 ${accent.soft}`} />
        <p className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-tight">
          <ShopMark className={`h-3.5 w-3.5 ${accent.soft}`} /> {state?.instanceName ?? "Shop"}
        </p>
        <p className="max-w-sm text-[10.5px] leading-4 text-stone-400 dark:text-stone-500">
          The shelves, your basket and your orders are this shop&rsquo;s own — you are seeing them as{" "}
          <span className="font-medium text-stone-500 dark:text-stone-400">{viewer.role}</span>. An assistant can do anything on this
          page that you can.
        </p>
      </footer>
    </div>
  );
}
