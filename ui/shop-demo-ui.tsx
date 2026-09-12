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
      await op("add-product", {
        name,
        priceCents,
        ...(sku ? { sku } : {}),
        ...(description ? { description } : {}),
        tags: String(form.get("tags") ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      });
      dispatch?.(
        catalogueChangedEvent.dataCreator({
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

  const ProductCard = ({ p }: { p: Product }) => {
    const Icon = iconFor(p.name, p.sku);
    const have = inCart(p.id);
    return (
      <li className={`${card} group flex flex-col overflow-hidden`}>
        <button type="button" onClick={() => setPage({ at: "product", id: p.id })} className="flex flex-col items-start gap-2 p-3 text-left">
          <span className="grid aspect-[4/3] w-full place-items-center rounded-lg bg-gradient-to-br from-stone-100 to-stone-200 text-stone-500 transition group-hover:from-stone-200 group-hover:to-stone-300 dark:from-white/10 dark:to-white/5 dark:text-stone-300">
            <Icon className="h-10 w-10" aria-hidden />
          </span>
          <span className="min-w-0 w-full">
            <span className="block truncate font-medium leading-tight">{p.name}</span>
            <span className="mt-0.5 block text-[15px] font-semibold tabular-nums">{money(p.priceCents)}</span>
            {p.description ? <span className="mt-1 block max-h-8 overflow-hidden text-[11px] leading-4 text-stone-500 dark:text-stone-400">{p.description}</span> : null}
          </span>
        </button>
        {shops ? (
          <div className="px-3 pb-3">
            <button type="button" disabled={busy === p.id} onClick={() => addToCart(p)} className={`${solid} inline-flex w-full items-center justify-center gap-1.5 text-[12px]`}>
              {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShoppingCart className="h-3.5 w-3.5" aria-hidden />}
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
    <div className="shop-root flex h-full w-full flex-col overflow-auto bg-stone-50/60 text-[13px] text-stone-800 dark:bg-transparent dark:text-stone-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-stone-300/60 bg-stone-50/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-stone-900/70 sm:px-6">
        <button type="button" onClick={() => setPage({ at: "home" })} className="flex items-center gap-2.5 text-left">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-stone-900 text-white dark:bg-white dark:text-stone-900">
            <Store className="h-4 w-4" aria-hidden />
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
            <section className={`${card} flex flex-wrap items-center justify-between gap-4 bg-gradient-to-br from-stone-100 to-stone-50 p-6 dark:from-white/10 dark:to-transparent`}>
              <div className="max-w-md">
                <h2 className="text-xl font-semibold tracking-tight">Everything on the shelves today</h2>
                <p className="mt-1 text-[12px] text-stone-500 dark:text-stone-400">
                  Open a thing to read about it, put it in the basket, change your mind, then order. You can ask the assistant to do any of it for you.
                </p>
              </div>
              <Store className="h-16 w-16 shrink-0 text-stone-300 dark:text-white/15" aria-hidden />
            </section>

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
              <div className={`${card} p-8 text-center text-stone-500`}>
                <Store className="mx-auto mb-2 h-6 w-6 opacity-40" aria-hidden />
                <p>The shelves are empty.</p>
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
              <div className="grid gap-5 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                <div className={`${card} grid aspect-square place-items-center bg-gradient-to-br from-stone-100 to-stone-200 text-stone-400 dark:from-white/10 dark:to-white/5 dark:text-stone-300`}>
                  {React.createElement(iconFor(detail.name, detail.sku), { className: "h-24 w-24", "aria-hidden": true })}
                </div>
                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">{detail.name}</h2>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{money(detail.priceCents)}</p>
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
                  <p className="max-w-prose whitespace-pre-wrap text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
                    {detail.description ?? "The shop has not written about this one yet."}
                  </p>
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
              <div className={`${card} p-8 text-center text-stone-500`}>
                <ShoppingCart className="mx-auto mb-2 h-6 w-6 opacity-40" aria-hidden />
                <p>Nothing in it yet.</p>
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
              <p className="rounded-xl border border-emerald-300/60 bg-emerald-50/70 px-3 py-2 text-[12px] text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100">
                Thank you — order <span className="font-mono">{placed.slice(0, 8)}</span> is with the shop. This page follows it.
              </p>
            ) : null}
            {orders === null ? (
              <p className="text-stone-500">Looking…</p>
            ) : orders.length === 0 ? (
              <div className={`${card} p-8 text-center text-stone-500`}>
                <CheckCircle2 className="mx-auto mb-2 h-6 w-6 opacity-40" aria-hidden />
                <p>Nothing ordered yet.</p>
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
        {isDesk ? (
          <>
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                <ShoppingBag className="h-3.5 w-3.5" aria-hidden /> What the shop sells
              </h2>
              {products === null ? <p className="text-stone-500">Reading the shelves…</p> : <Grid items={products} />}
            </section>

            {isOwner && canEdit ? (
              <section>
                <h2 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Add something to sell
                </h2>
                <form
                  className={`${card} grid gap-2 p-3 sm:grid-cols-2`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    e.currentTarget.reset();
                    void addProduct(form);
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">Name</span>
                    <input name="name" placeholder="Earl Grey" required className={field} />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-stone-500 dark:text-stone-400">Price</span>
                      <input name="price" type="number" step="0.01" min="0" placeholder="4.50" required className={`${field} tabular-nums`} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-stone-500 dark:text-stone-400">Stock code</span>
                      <input name="sku" placeholder="TEA-01" className={`${field} font-mono text-[12px]`} />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">What it is</span>
                    <textarea name="description" rows={2} placeholder="Bergamot, loose leaf, from a garden in Uva." className={field} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">Departments (comma separated)</span>
                    <input name="tags" placeholder="tea, gifts" className={field} />
                  </label>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy === "add"} className={`${solid} inline-flex items-center gap-1.5`}>
                      {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add
                    </button>
                  </div>
                </form>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <h2 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                <ClipboardList className="h-3.5 w-3.5" aria-hidden /> The desk
                {(orders ?? []).some((o) => o.status !== "fulfilled" && o.status !== "refunded")
                  ? ` — ${(orders ?? []).filter((o) => o.status !== "fulfilled" && o.status !== "refunded").length} to do`
                  : ""}
              </h2>
              {orders === null ? (
                <p className="text-stone-500">Looking…</p>
              ) : orders.length === 0 ? (
                <div className={`${card} p-6 text-center text-stone-500`}>
                  <CheckCircle2 className="mx-auto mb-2 h-6 w-6 opacity-40" aria-hidden />
                  <p>Nothing waiting. The desk is clear.</p>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {orders.map((o) => (
                    <li key={o.id} className={`${card} flex flex-wrap items-start justify-between gap-3 p-3`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill status={o.status} />
                          <span className="font-mono text-[10px] text-stone-400">{o.id.slice(0, 8)}</span>
                          {o.shipTo?.name ? <span className="text-[12px] text-stone-600 dark:text-stone-300">for {o.shipTo.name}</span> : null}
                          <span className="ml-auto text-[14px] font-semibold tabular-nums">{money(o.totalCents)}</span>
                        </div>
                        <p className="mt-1 truncate text-[12px] text-stone-600 dark:text-stone-300">{o.lines.map((l) => `${l.qty} × ${l.name}`).join(", ")}</p>
                        {o.shipTo?.street ? (
                          <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                            {o.shipTo.street}, {o.shipTo.city}
                          </p>
                        ) : null}
                        {o.note ? <p className="mt-0.5 text-[11px] italic text-stone-500 dark:text-stone-400">{o.note}</p> : null}
                      </div>
                      {o.status !== "refunded" && o.status !== "fulfilled" ? (
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {FLOW.slice(FLOW.indexOf(o.status as (typeof FLOW)[number]) + 1).map((next) => (
                            <button key={next} type="button" disabled={busy === o.id} onClick={() => move(o, next)} className={ghost}>
                              {busy === o.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : STATUS[next]!.label}
                            </button>
                          ))}
                          <button type="button" disabled={busy === o.id} onClick={() => move(o, "refunded")} className={`${ghost} text-rose-700 dark:text-rose-300`}>
                            Refund
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {state?.deliveries?.length ? (
                <p className="text-[11px] text-stone-400 dark:text-stone-500">
                  {state.deliveries.length} customer {state.deliveries.length === 1 ? "message" : "messages"} sent — each one told exactly once.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
