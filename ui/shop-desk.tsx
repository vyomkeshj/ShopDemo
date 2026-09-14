"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  Check,
  ChevronDown,
  ClipboardList,
  Copy,
  ImageIcon,
  Loader2,
  Megaphone,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShoppingBag,
  Tag,
  Trash2,
  Truck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { ACCENTS, type ShopLook } from "../app";
import { accentOf, EmptyBasketArt, NoResultsArt, SealArt, SprigArt, WovenGround } from "./shop-art";

/**
 * THE DESK — the shop as the person who RUNS it sees it.
 *
 * A storefront and a back office are two different products that happen to
 * share a database, and the mistake is to build the second one out of the
 * first: a grid of pretty cards is how you SELL a thing and a terrible way to
 * price forty of them. So this is a list, a queue, an editor and a till —
 * dense on purpose, because the owner is here to work.
 *
 * What an owner actually needs, in the order they need it:
 *
 *   · what is waiting     — orders, oldest first, with the next action on them
 *   · what to write       — the shelves, flagged where a thing has no words
 *                           or no picture, and a roomy editor for both
 *   · who may help        — staff, by their esoul email, with a role
 *   · what it took        — money and units, from the order lines
 *   · how it looks        — the hero, the line, the accent
 *
 * Everything here goes through the app's own OPS, so the same work is
 * available to an agent; nothing on this screen is a capability the tools do
 * not have.
 */

export interface DeskProduct {
  id: string;
  name: string;
  priceCents: number;
  sku: string | null;
  tags: string[];
  description: string | null;
  tagline?: string | null;
  imageUrl?: string | null;
}

export interface DeskOrder {
  id: string;
  status: string;
  totalCents: number;
  lines: { productId: string; name: string; qty: number; priceCents: number }[];
  shipTo?: { name?: string; street?: string; city?: string } | null;
  note?: string | null;
  createdAt?: string;
}

type Tab = "queue" | "shelves" | "people" | "till" | "look";

const money = (cents: number) => `${(cents / 100).toFixed(2)}`;
const FLOW = ["new", "preparing", "shipped", "fulfilled"] as const;
const NEXT: Record<string, { to: string; label: string; Icon: typeof Package } | undefined> = {
  new: { to: "preparing", label: "Start preparing", Icon: Package },
  preparing: { to: "shipped", label: "Mark on its way", Icon: Truck },
  shipped: { to: "fulfilled", label: "Mark delivered", Icon: PackageCheck },
};

/** How long something has been waiting, in the words a person would use. */
function since(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function ShopDesk(props: {
  instanceName: string;
  look: ShopLook | undefined;
  announcements: { id: string; text: string; at?: number }[];
  departments: string[];
  isOwner: boolean;
  canEdit: boolean;
  products: DeskProduct[] | null;
  nextCursor: string | null;
  onLoadMore: () => void;
  loadingMore: boolean;
  orders: DeskOrder[] | null;
  op: <T>(name: string, args?: unknown) => Promise<T>;
  refreshProducts: () => void;
  refreshOrders: () => void;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const { instanceName, isOwner, canEdit, products, orders, op, refreshProducts, refreshOrders, busy, run } = props;
  // WHAT THIS PERSON MAY DO, from the server — a composed role (a packer) sees
  // only its statuses and may make only its moves; the desk hides the rest so
  // nobody presses a button the server would refuse. The server decides anyway.
  const [can, setCan] = useState<RoleCan | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    op<{ customRole: string | null; can: RoleCan | null }>("me")
      .then((r) => alive && setCan(r.can ?? null))
      .catch(() => alive && setCan(null));
    return () => {
      alive = false;
    };
  }, [op]);
  const accent = accentOf(props.look?.accent);
  const [tab, setTab] = useState<Tab>("queue");
  const [editing, setEditing] = useState<DeskProduct | "new" | null>(null);
  const [note, setNote] = useState("");

  /* ── what is waiting, and what it took ─────────────────────────────────── */

  const waiting = useMemo(() => (orders ?? []).filter((o) => o.status !== "fulfilled" && o.status !== "refunded"), [orders]);
  const takenToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (orders ?? [])
      .filter((o) => o.status !== "refunded" && o.createdAt && new Date(o.createdAt).getTime() >= start.getTime())
      .reduce((sum, o) => sum + o.totalCents, 0);
  }, [orders]);
  const unwritten = useMemo(() => (products ?? []).filter((p) => !p.description || !p.imageUrl).length, [products]);

  // A COMPOSED ROLE works the queue it was handed and nothing else: shelves,
  // people, till and look are the staff's and the owner's desks, backed by ops
  // the owner did not give it (the server refuses them either way).
  const composed = !!can;
  const TABS: { id: Tab; label: string; Icon: typeof Package; badge?: number }[] = [
    { id: "queue" as Tab, label: "Queue", Icon: ClipboardList, badge: waiting.length },
    { id: "shelves" as Tab, label: "Shelves", Icon: ShoppingBag, badge: unwritten || undefined },
    { id: "people" as Tab, label: "People", Icon: Users },
    { id: "till" as Tab, label: "Till", Icon: Banknote },
    { id: "look" as Tab, label: "Look", Icon: ImageIcon },
  ].filter((t) => !composed || t.id === "queue");
  const shown: Tab = composed ? "queue" : tab;

  return (
    <div className="flex flex-col gap-4">
      {/* ── TODAY, in four numbers. The first thing a person wants on opening
             a back office is whether anything needs them. ───────────────── */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Waiting" value={String(waiting.length)} tone={waiting.length ? "warn" : "calm"} Icon={ClipboardList} />
        {composed ? null : (
          <>
            <Stat label="Taken today" value={money(takenToday)} Icon={Banknote} />
            <Stat label="On the shelves" value={products ? `${products.length}${props.nextCursor ? "+" : ""}` : "…"} Icon={ShoppingBag} />
            <Stat label="Need work" value={String(unwritten)} tone={unwritten ? "warn" : "calm"} Icon={Pencil} />
          </>
        )}
      </section>

      {/* ── the notice board ─────────────────────────────────────────────── */}
      {canEdit ? (
        <form
          className={`flex flex-wrap items-center gap-2 rounded-xl bg-white/70 px-3 py-2 ring-1 ${accent.ring} dark:bg-white/[0.04]`}
          onSubmit={(e) => {
            e.preventDefault();
            const text = note;
            setNote("");
            void run("notice", async () => {
              await op("post-notice", { text });
            });
          }}
        >
          <Megaphone className={`h-4 w-4 shrink-0 ${accent.soft}`} aria-hidden />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={props.announcements[0]?.text ? `Now showing: “${props.announcements[0].text}”` : "Put a notice across the shop — “closed Monday”"}
            aria-label="A notice across the shop"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-stone-400"
          />
          <button type="submit" disabled={!note.trim() || busy === "notice"} className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40 ${accent.pill}`}>
            {busy === "notice" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Post"}
          </button>
        </form>
      ) : null}

      {/* ── the tabs ─────────────────────────────────────────────────────── */}
      <nav className="flex flex-wrap gap-1.5 border-b border-stone-300/60 pb-2 dark:border-white/10" aria-label="The desk">
        {TABS.map(({ id, label, Icon, badge }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition ${
              tab === id ? accent.pill : "text-stone-500 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-white/10"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
            {badge ? (
              <span className={`rounded-full px-1.5 text-[10px] ${tab === id ? "bg-black/20 dark:bg-white/25" : "bg-stone-300/70 dark:bg-white/15"}`}>{badge}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {shown === "queue" ? <Queue orders={orders} accent={accent} busy={busy} run={run} op={op} refreshOrders={refreshOrders} can={can ?? null} /> : null}
      {shown === "shelves" ? (
        <Shelves
          products={products}
          accent={accent}
          canEdit={canEdit}
          onEdit={setEditing}
          nextCursor={props.nextCursor}
          onLoadMore={props.onLoadMore}
          loadingMore={props.loadingMore}
        />
      ) : null}
      {shown === "people" ? <People accent={accent} isOwner={isOwner} op={op} busy={busy} run={run} /> : null}
      {shown === "till" ? <Till accent={accent} op={op} /> : null}
      {shown === "look" ? <Look accent={accent} look={props.look} instanceName={instanceName} canEdit={canEdit} op={op} busy={busy} run={run} /> : null}

      {editing ? (
        <Editor
          product={editing === "new" ? null : editing}
          departments={props.departments}
          accent={accent}
          nodeKey={instanceName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refreshProducts();
          }}
          op={op}
        />
      ) : null}
    </div>
  );
}

/* ── one number ──────────────────────────────────────────────────────────── */

function Stat({ label, value, Icon, tone = "calm" }: { label: string; value: string; Icon: typeof Package; tone?: "calm" | "warn" }) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 ring-1 ${
        tone === "warn"
          ? "bg-amber-50/80 ring-amber-300/50 dark:bg-amber-400/10 dark:ring-amber-400/20"
          : "bg-white/70 ring-stone-900/10 dark:bg-white/[0.04] dark:ring-white/10"
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-stone-400"}`} aria-hidden />
      <span className="min-w-0">
        <span className="block text-[17px] font-semibold leading-none tabular-nums">{value}</span>
        {/* WRAPS, never truncates: a number without its label is a mystery,
            and the box's own geometry check is what noticed this clipping. */}
        <span className="mt-1 block text-[10.5px] uppercase leading-tight tracking-wide text-stone-500 dark:text-stone-400">{label}</span>
      </span>
    </div>
  );
}

/* ── the queue ───────────────────────────────────────────────────────────── */

/** What a composed role may do, as `me` reports it. Null = the base word's full reach. */
interface RoleCan {
  ops: string[];
  statuses: string[] | null;
  moves: Record<string, string[]> | null;
  hidden: string[];
}

function Queue({
  orders,
  accent,
  busy,
  run,
  op,
  refreshOrders,
  can,
}: {
  orders: DeskOrder[] | null;
  accent: ReturnType<typeof accentOf>;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  can: RoleCan | null;
  op: <T>(name: string, args?: unknown) => Promise<T>;
  refreshOrders: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const groups = useMemo(() => {
    const open = (orders ?? []).filter((o) => o.status !== "fulfilled" && o.status !== "refunded");
    const done = (orders ?? []).filter((o) => o.status === "fulfilled" || o.status === "refunded");
    return { open, done };
  }, [orders]);

  const move = (o: DeskOrder, status: string) =>
    run(o.id, async () => {
      await op(status === "refunded" ? "refund" : "set-order-status", status === "refunded" ? { orderId: o.id } : { orderId: o.id, status });
      refreshOrders();
    });

  const label = (o: DeskOrder) => {
    const to = o.shipTo ?? {};
    return [to.name, to.street, to.city].filter(Boolean).join("\n");
  };

  if (orders === null) return <p className="text-[12.5px] text-stone-500">Reading the book…</p>;
  if (!groups.open.length && !groups.done.length)
    return (
      <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-12 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
        <EmptyBasketArt className={`h-24 w-24 ${accent.soft}`} />
        <p className="text-[13px] font-medium">The desk is clear</p>
        <p className="max-w-xs text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">
          Every order that arrives lands here, oldest first, with the next thing to do on it.
        </p>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {groups.open.length ? (
        <ul className="flex flex-col gap-2.5">
          {groups.open.map((o) => {
            // A composed role sees the next step only when it holds that move.
            const step = NEXT[o.status];
            const next = step && (!can || (can.moves?.[o.status] ?? []).includes(step.to)) ? step : undefined;
            const mayRefund = !can || can.ops.includes("refund");
            const at = FLOW.indexOf(o.status as (typeof FLOW)[number]);
            return (
              <li key={o.id} className={`overflow-hidden rounded-2xl bg-white/80 ring-1 ${accent.ring} dark:bg-white/[0.04]`}>
                <div className="flex flex-wrap items-start gap-3 p-3">
                  {/* who and where */}
                  <div className="min-w-[11rem] flex-1">
                    <p className="flex items-center gap-1.5 text-[13px] font-medium leading-tight">
                      {o.shipTo?.name || "No name given"}
                      <span className="font-mono text-[10.5px] font-normal text-stone-400">{o.id.slice(0, 8)}</span>
                    </p>
                    <p className="mt-0.5 whitespace-pre-line text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">
                      {o.shipTo?.street ? `${o.shipTo.street}\n${o.shipTo.city ?? ""}` : "No address"}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(label(o));
                        setCopied(o.id);
                        setTimeout(() => setCopied((c) => (c === o.id ? null : c)), 1600);
                      }}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
                    >
                      {copied === o.id ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                      {copied === o.id ? "Copied" : "Copy the label"}
                    </button>
                  </div>

                  {/* what they bought */}
                  <ul className="min-w-[10rem] flex-1 text-[11.5px] leading-5 text-stone-600 dark:text-stone-300">
                    {o.lines?.map((l, i) => (
                      <li key={`${l.productId}-${i}`} className="flex justify-between gap-2">
                        <span className="truncate">
                          {l.qty} × {l.name}
                        </span>
                        <span className="tabular-nums text-stone-400">{money(l.priceCents * l.qty)}</span>
                      </li>
                    ))}
                    {o.note ? <li className="mt-1 italic text-stone-500 dark:text-stone-400">“{o.note}”</li> : null}
                  </ul>

                  {/* where it stands, and the one thing to do next */}
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="text-[15px] font-semibold tabular-nums">{money(o.totalCents)}</span>
                    <span className="text-[10.5px] text-stone-400">{since(o.createdAt)}</span>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {next ? (
                        <button
                          type="button"
                          disabled={busy === o.id}
                          onClick={() => move(o, next.to)}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium disabled:opacity-50 ${accent.pill}`}
                        >
                          {busy === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <next.Icon className="h-3.5 w-3.5" aria-hidden />}
                          {next.label}
                        </button>
                      ) : null}
                      {mayRefund ? (
                        <button
                          type="button"
                          disabled={busy === o.id}
                          onClick={() => move(o, "refunded")}
                          className="rounded-lg border border-rose-300/70 px-2 py-1.5 text-[11.5px] text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-400/30 dark:text-rose-300 dark:hover:bg-rose-400/10"
                        >
                          Refund
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                {/* the journey, as a rail the width of the card */}
                <div className="flex h-1 w-full">
                  {FLOW.map((stage, i) => (
                    <span
                      key={stage}
                      className={`h-full flex-1 ${i <= at ? (accent.pill.includes("bg-stone-900") ? "bg-stone-900 dark:bg-stone-100" : accent.glow) : "bg-stone-200 dark:bg-white/10"} ${
                        i <= at ? "" : ""
                      }`}
                      title={stage}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-stone-500 dark:text-stone-400">Nothing waiting — every order is delivered or refunded.</p>
      )}

      {groups.done.length ? (
        <details className="group">
          <summary className="cursor-pointer text-[11.5px] text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100">
            {groups.done.length} finished {groups.done.length === 1 ? "order" : "orders"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {groups.done.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/50 px-3 py-2 text-[11.5px] dark:bg-white/[0.02]">
                <span className="truncate">
                  <span className="font-mono text-[10.5px] text-stone-400">{o.id.slice(0, 8)}</span> {o.shipTo?.name || "—"}
                </span>
                <span className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
                  {o.status === "refunded" ? <RotateCcw className="h-3 w-3" aria-hidden /> : <BadgeCheck className="h-3 w-3" aria-hidden />}
                  {o.status}
                  <span className="tabular-nums">{money(o.totalCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/* ── the shelves, as a TABLE ─────────────────────────────────────────────── */

/**
 * A CATALOGUE IS NOT A SHOP WINDOW.
 *
 * The storefront's grid of photographs is the right way to SELL forty things
 * and the wrong way to price them: an owner with a few hundred products is
 * scanning and comparing — which of these has no words, which is priced wrong,
 * which left the shelves — and that is a table. Columns you can sort, rows
 * dense enough to see twenty at once, and the detail behind a click rather
 * than crammed into the row.
 *
 * Under 640 px a table becomes a horizontal scroll nobody wants, so the same
 * rows render as a list there. Same data, same click, one less dimension.
 */
type SortKey = "name" | "price" | "state";

function Shelves({
  products,
  accent,
  canEdit,
  onEdit,
  nextCursor,
  onLoadMore,
  loadingMore,
}: {
  products: DeskProduct[] | null;
  accent: ReturnType<typeof accentOf>;
  canEdit: boolean;
  onEdit: (p: DeskProduct | "new") => void;
  nextCursor: string | null;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [onlyUnfinished, setOnlyUnfinished] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");
  const [desc, setDesc] = useState(false);

  const missing = (p: DeskProduct) => (p.imageUrl ? 0 : 1) + (p.description ? 0 : 1);
  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const rows = (products ?? []).filter(
      (p) =>
        (!term || p.name.toLowerCase().includes(term) || (p.sku ?? "").toLowerCase().includes(term) || p.tags?.some((t) => t.includes(term))) &&
        (!onlyUnfinished || missing(p) > 0),
    );
    const dir = desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (sort === "price") return (a.priceCents - b.priceCents) * dir;
      if (sort === "state") return (missing(b) - missing(a)) * dir || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name) * dir;
    });
  }, [products, filter, onlyUnfinished, sort, desc]);

  /** One style for every header cell, so a sortable column looks like a column. */
  const HEAD = "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400";
  const head = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={`${HEAD} ${className}`} aria-sort={sort === key ? (desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={() => {
          if (sort === key) setDesc((d) => !d);
          else {
            setSort(key);
            setDesc(false);
          }
        }}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-stone-900 dark:hover:text-stone-100"
      >
        {label}
        <span aria-hidden className={`text-[9px] ${sort === key ? "opacity-100" : "opacity-25"}`}>{sort === key && desc ? "\u25be" : "\u25b4"}</span>
      </button>
    </th>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, stock code or department"
            aria-label="Filter the catalogue"
            className="w-full rounded-lg border border-stone-300/70 bg-white/70 py-1.5 pl-8 pr-2 text-[12.5px] dark:border-white/15 dark:bg-white/5"
          />
        </div>
        <button
          type="button"
          onClick={() => setOnlyUnfinished((v) => !v)}
          className={`rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium ${
            onlyUnfinished ? accent.pill : "border border-stone-300/70 text-stone-600 dark:border-white/15 dark:text-stone-300"
          }`}
        >
          Needs work
        </button>
        {canEdit ? (
          <button type="button" onClick={() => onEdit("new")} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${accent.pill}`}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add something
          </button>
        ) : null}
      </div>

      {products === null ? (
        <p className="text-[12.5px] text-stone-500">Reading the shelves…</p>
      ) : !shown.length ? (
        <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
          <NoResultsArt className={`h-16 w-16 ${accent.soft}`} />
          <p className="text-[12.5px] text-stone-500 dark:text-stone-400">{filter || onlyUnfinished ? "Nothing matches that." : "Nothing on the shelves yet."}</p>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-stone-500 dark:text-stone-400">
            {shown.length} of {products.length}
            {nextCursor ? "+" : ""} shown
            {onlyUnfinished ? " · only the ones needing work" : ""}
          </p>

          {/* the table, from 640 px up */}
          <div className="hidden overflow-x-auto rounded-2xl bg-white/70 ring-1 ring-stone-900/10 dark:bg-white/[0.04] dark:ring-white/10 sm:block">
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-stone-100/95 backdrop-blur dark:bg-white/[0.06]">
                <tr>
                  {head("name", "Thing")}
                  <th scope="col" className={`${HEAD} w-24 whitespace-nowrap`}>
                    Code
                  </th>
                  {head("price", "Price", "w-20 text-right")}
                  <th scope="col" className={HEAD}>
                    Departments
                  </th>
                  {head("state", "State", "w-40")}
                  <th scope="col" className={`${HEAD} w-20 text-right`}>
                    <span className="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200/70 dark:divide-white/5">
                {shown.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => canEdit && onEdit(p)}
                    className={`${canEdit ? "cursor-pointer" : ""} transition hover:bg-stone-100/70 dark:hover:bg-white/[0.05]`}
                  >
                    <td className="max-w-[20rem] px-3 py-2">
                      <span className="flex items-center gap-2.5">
                        <Thumb p={p} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium leading-tight">{p.name}</span>
                          {p.tagline ? <span className="block truncate text-[11px] leading-4 text-stone-500 dark:text-stone-400">{p.tagline}</span> : null}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">{p.sku ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(p.priceCents)}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {p.tags?.length ? (
                          p.tags.map((t) => (
                            <span key={t} className="rounded bg-stone-200/70 px-1 text-[10.5px] capitalize dark:bg-white/10">
                              {t}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-stone-400">none</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {!p.imageUrl ? <Flag>no photo</Flag> : null}
                        {!p.description ? <Flag>no words</Flag> : null}
                        {p.imageUrl && p.description ? (
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-700 dark:text-emerald-300">
                            <BadgeCheck className="h-3 w-3" aria-hidden /> written up
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit ? (
                        <span className="inline-flex items-center gap-1 text-[11.5px] text-stone-500 dark:text-stone-400">
                          <Pencil className="h-3.5 w-3.5" aria-hidden /> Write
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* the same rows, as a list, on a phone */}
          <ul className="flex flex-col divide-y divide-stone-200/70 overflow-hidden rounded-2xl bg-white/70 ring-1 ring-stone-900/10 dark:divide-white/5 dark:bg-white/[0.04] dark:ring-white/10 sm:hidden">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => canEdit && onEdit(p)} className="flex w-full items-center gap-3 p-2.5 text-left">
                  <Thumb p={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-tight">{p.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                      <span className="tabular-nums">{money(p.priceCents)}</span>
                      {p.sku ? <span className="font-mono text-[10px]">{p.sku}</span> : null}
                      {!p.imageUrl ? <Flag>no photo</Flag> : null}
                      {!p.description ? <Flag>no words</Flag> : null}
                    </span>
                  </span>
                  {canEdit ? <Pencil className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden /> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {nextCursor ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="self-center rounded-lg border border-stone-300/70 px-3 py-1.5 text-[12px] disabled:opacity-50 dark:border-white/15"
        >
          {loadingMore ? "Reading…" : "Read more of the shelf"}
        </button>
      ) : null}
    </div>
  );
}

/** The picture of a thing at 40 px, photograph or drawn. */
function Thumb({ p }: { p: DeskProduct }) {
  return (
    <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-stone-100 dark:bg-white/5">
      {p.imageUrl ? (
        <img src={p.imageUrl} alt="" aria-hidden className="h-full w-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <>
          <WovenGround className="absolute inset-0 h-full w-full text-stone-400/50 dark:text-white/20" />
          <Package className="relative h-3.5 w-3.5 text-stone-400" aria-hidden />
        </>
      )}
    </span>
  );
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900 dark:bg-amber-400/15 dark:text-amber-100">
      <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
      {children}
    </span>
  );
}

/* ── writing a thing up ──────────────────────────────────────────────────── */

/**
 * THE EDITOR — where the words are written, and the only screen in this app
 * designed around one long text field.
 *
 * Three decisions, all of them about not losing work:
 *
 *   · The draft lives in `localStorage` under the product's id, written as you
 *     type. A description is the longest thing anyone types into this app, and
 *     a reload that eats four paragraphs is the kind of thing people do not
 *     forgive. It is cleared on a successful save (and only then).
 *   · Closing with unsaved changes ASKS. A sheet that swallows an edit on a
 *     stray click is worse than one that nags.
 *   · The preview shows the page as the shopper will read it, from the same
 *     paragraph-splitting the product page uses — so "does this read well" is
 *     answered here rather than by leaving and looking.
 */
function Editor({
  product,
  departments,
  accent,
  nodeKey,
  onClose,
  onSaved,
  op,
}: {
  product: DeskProduct | null;
  departments: string[];
  accent: ReturnType<typeof accentOf>;
  nodeKey: string;
  onClose: () => void;
  onSaved: () => void;
  op: <T>(name: string, args?: unknown) => Promise<T>;
}) {
  const draftKey = `shop-demo:draft:${nodeKey}:${product?.id ?? "new"}`;
  const initial = useMemo(
    () => ({
      name: product?.name ?? "",
      price: product ? (product.priceCents / 100).toFixed(2) : "",
      sku: product?.sku ?? "",
      tagline: product?.tagline ?? "",
      description: product?.description ?? "",
      imageUrl: product?.imageUrl ?? "",
      tags: product?.tags ?? [],
      active: true,
    }),
    [product],
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const firstField = useRef<HTMLInputElement | null>(null);

  // A DRAFT SURVIVES A RELOAD. Per viewer, per product, and nowhere near the
  // timeline: it is unfinished typing, not a fact about the shop.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw) as typeof initial;
        setForm({ ...initial, ...saved });
        setRestored(true);
      }
    } catch {
      /* a blocked localStorage is not a reason to refuse to edit */
    }
    firstField.current?.focus();
  }, [draftKey, initial]);

  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(form));
    } catch {
      /* ignore */
    }
  }, [draftKey, form]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const close = () => {
    if (dirty && !window.confirm("Close without saving? Your words are kept as a draft.")) return;
    onClose();
  };

  const save = async () => {
    setProblem(null);
    const priceCents = Math.round(Number(form.price) * 100);
    if (!form.name.trim()) return setProblem("It needs a name.");
    if (!Number.isFinite(priceCents) || priceCents < 0) return setProblem("That price is not a number.");
    setSaving(true);
    try {
      const common = {
        name: form.name.trim(),
        priceCents,
        description: form.description.trim(),
        tagline: form.tagline.trim(),
        tags: form.tags,
        ...(form.imageUrl.trim() ? { imageUrl: form.imageUrl.trim() } : {}),
      };
      if (product) await op("update-product", { productId: product.id, ...common, active: form.active });
      else await op("add-product", { ...common, ...(form.sku.trim() ? { sku: form.sku.trim() } : {}) });
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      onSaved();
    } catch (e) {
      setProblem(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const paragraphs = form.description.split(/\n{2,}/).filter((p) => p.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-stone-950/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={product ? `Write up ${product.name}` : "Add something to sell"}>
      <button type="button" aria-label="Close" onClick={close} className="flex-1 cursor-default" />
      <div className="flex h-full w-full max-w-xl flex-col overflow-auto bg-stone-50 shadow-2xl dark:bg-stone-900 sm:max-w-2xl">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-stone-300/60 bg-stone-50/95 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-stone-900/95">
          <span className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-stone-100 dark:bg-white/5">
            {form.imageUrl ? (
              <img src={form.imageUrl} alt="" aria-hidden className="h-full w-full object-cover" />
            ) : (
              <>
                <WovenGround className="absolute inset-0 h-full w-full text-stone-400/50 dark:text-white/20" />
                <ImageIcon className="relative h-4 w-4 text-stone-400" aria-hidden />
              </>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold leading-tight">{form.name || (product ? product.name : "Something new")}</span>
            <span className="block text-[11px] text-stone-500 dark:text-stone-400">
              {product ? "Only what you change is changed" : "A new thing for the shelves"}
              {restored ? " · draft restored" : ""}
            </span>
          </span>
          <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-200/70 dark:hover:bg-white/10">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field label="Name">
              <input ref={firstField} value={form.name} onChange={(e) => set("name", e.target.value)} className={input} placeholder="Earl Grey" />
            </Field>
            <Field label="Price">
              <input value={form.price} onChange={(e) => set("price", e.target.value)} inputMode="decimal" className={`${input} tabular-nums`} placeholder="4.50" />
            </Field>
          </div>

          {!product ? (
            <Field label="Stock code" hint="Optional. A warehouse holds stock against this.">
              <input value={form.sku} onChange={(e) => set("sku", e.target.value)} className={`${input} font-mono text-[12px]`} placeholder="TEA-01" />
            </Field>
          ) : null}

          <Field label="One line for the shelf" hint={`${form.tagline.length}/140 — what the card says under the name`}>
            <input value={form.tagline} onChange={(e) => set("tagline", e.target.value.slice(0, 140))} className={input} placeholder="Bergamot over a brisk Assam base." />
          </Field>

          {/* THE LONG FIELD. Roomy, monospaced-comfortable line height, and a
              live preview beside it — the product page is mostly this. */}
          <Field
            label="What it is"
            hint={`${form.description.length}/2000 · a blank line starts a new paragraph`}
          >
            <textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value.slice(0, 2000))}
              rows={10}
              className={`${input} min-h-[12rem] resize-y leading-[1.6]`}
              placeholder={"Where it comes from, what it tastes like, what to do with it.\n\nA blank line makes a new paragraph — two or three is plenty."}
            />
          </Field>

          {paragraphs.length ? (
            <section className={`rounded-xl bg-white/70 p-3 ring-1 ${accent.ring} dark:bg-white/[0.04]`}>
              <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                <SprigArt className={`h-3 w-8 ${accent.soft}`} /> how the page will read
              </p>
              <div className="space-y-2 text-[13px] leading-[1.65] text-stone-600 dark:text-stone-300">
                {paragraphs.map((para, i) => (
                  <p
                    key={i}
                    className={
                      i === 0
                        ? "first-letter:float-left first-letter:mr-1 first-letter:text-[2rem] first-letter:font-semibold first-letter:leading-[0.85] first-letter:text-stone-800 dark:first-letter:text-stone-100"
                        : ""
                    }
                  >
                    {para}
                  </p>
                ))}
              </div>
            </section>
          ) : null}

          <Field label="Departments" hint="How the storefront groups it. Lower case, a few.">
            <TagEditor tags={form.tags} known={departments} accent={accent} onChange={(tags) => set("tags", tags)} />
          </Field>

          <Field label="Photograph" hint="An https link. A thing with no photograph gets the shop's drawn one.">
            <input value={form.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} className={`${input} font-mono text-[11.5px]`} placeholder="https://…" />
          </Field>

          {product ? (
            <label className="flex items-center gap-2.5 rounded-xl bg-white/70 px-3 py-2.5 ring-1 ring-stone-900/10 dark:bg-white/[0.04] dark:ring-white/10">
              <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} className="h-4 w-4" />
              <span>
                <span className="block text-[12.5px] font-medium">On the shelves</span>
                <span className="block text-[11px] text-stone-500 dark:text-stone-400">
                  Turn it off and it leaves the storefront. The row and everything it ever sold are kept.
                </span>
              </span>
            </label>
          ) : null}

          {problem ? (
            <p className="rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100">{problem}</p>
          ) : null}
        </div>

        <footer className="sticky bottom-0 mt-auto flex items-center gap-2 border-t border-stone-300/60 bg-stone-50/95 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-stone-900/95">
          <button type="button" onClick={() => void save()} disabled={saving || !dirty} className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium disabled:opacity-40 ${accent.pill}`}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            {product ? "Save it" : "Put it on the shelves"}
          </button>
          {dirty ? (
            <button type="button" onClick={() => setForm(initial)} className="rounded-xl border border-stone-300/70 px-3 py-2 text-[12.5px] dark:border-white/15">
              Put it back
            </button>
          ) : null}
          <span className="ml-auto text-[11px] text-stone-400">{dirty ? "unsaved" : "saved"}</span>
        </footer>
      </div>
    </div>
  );
}

const select =
  "w-full appearance-none rounded-lg border border-stone-300/70 bg-white/80 py-2 pl-2.5 pr-8 text-[13px] outline-none focus:border-stone-500 dark:border-white/15 dark:bg-white/5 dark:focus:border-white/40";

/** A select with room for its own chevron, because the native one collides with our padding. */
function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <span className="relative inline-block">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={select}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" aria-hidden />
    </span>
  );
}

const input = "w-full rounded-lg border border-stone-300/70 bg-white/80 px-2.5 py-2 text-[13px] outline-none focus:border-stone-500 dark:border-white/15 dark:bg-white/5 dark:focus:border-white/40";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">{label}</span>
      {children}
      {hint ? <span className="text-[10.5px] text-stone-400">{hint}</span> : null}
    </label>
  );
}

/** Departments as chips: the shop's own first, then anything new you type. */
function TagEditor({ tags, known, accent, onChange }: { tags: string[]; known: string[]; accent: ReturnType<typeof accentOf>; onChange: (t: string[]) => void }) {
  const [typed, setTyped] = useState("");
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t || tags.includes(t) || tags.length >= 8) return;
    onChange([...tags, t]);
    setTyped("");
  };
  const offer = known.filter((k) => !tags.includes(k)).slice(0, 8);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-300/70 bg-white/80 px-2 py-1.5 dark:border-white/15 dark:bg-white/5">
        {tags.map((t) => (
          <span key={t} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] capitalize ${accent.pill}`}>
            {t}
            <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`} className="opacity-70 hover:opacity-100">
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(typed);
            }
            if (e.key === "Backspace" && !typed && tags.length) onChange(tags.slice(0, -1));
          }}
          placeholder={tags.length ? "" : "tea, gifts"}
          aria-label="Add a department"
          className="min-w-[6rem] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-stone-400"
        />
      </div>
      {offer.length ? (
        <div className="flex flex-wrap gap-1">
          {offer.map((k) => (
            <button key={k} type="button" onClick={() => add(k)} className="rounded-full border border-stone-300/70 px-2 py-0.5 text-[11px] capitalize text-stone-500 hover:bg-stone-100 dark:border-white/15 dark:text-stone-400 dark:hover:bg-white/10">
              + {k}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── who may help ────────────────────────────────────────────────────────── */

interface Helper {
  userId: string;
  email: string | null;
  role: string;
  grantedAt?: number;
}

/** A role the owner composed, as list-people returns it (the platform's generic shape). */
interface ComposedRole {
  name: string;
  base: string;
  describe?: string;
  ops?: string[];
  models?: { Order?: { where?: { status?: string[] }; hide?: string[]; update?: { transitions?: Record<string, string[]> } } };
}

const STATUS_FLOW = ["new", "preparing", "shipped", "fulfilled", "refunded"] as const;
const DESK_OPS = ["set-order-status", "fulfil-order", "order-notice", "refund"] as const;

/**
 * COMPOSE A ROLE — the owner says, in the shop's words, what a packer or a
 * courier is: which statuses they see, where they may move an order, whether
 * they see the note, which desk actions they may call. The platform keeps the
 * result inside the manifest's envelope and enforces it everywhere.
 */
function RoleComposer({ accent, op, busy, run, onDone }: { accent: ReturnType<typeof accentOf>; op: <T>(name: string, args?: unknown) => Promise<T>; busy: string | null; run: (key: string, fn: () => Promise<void>) => Promise<void>; onDone: () => void }) {
  const [name, setName] = useState("");
  const [describe, setDescribe] = useState("");
  const [statuses, setStatuses] = useState<string[]>(["preparing"]);
  const [moves, setMoves] = useState<Record<string, string[]>>({ preparing: ["shipped"] });
  const [hideNote, setHideNote] = useState(true);
  const [opsAllowed, setOpsAllowed] = useState<string[]>(["set-order-status"]);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = () =>
    run("compose-role", async () => {
      setProblem(null);
      try {
        await op("define-role", { name: name.trim(), describe: describe.trim() || undefined, statuses, moves: Object.fromEntries(statuses.map((s) => [s, moves[s] ?? []])), hideNote, ops: opsAllowed });
        setName("");
        setDescribe("");
        onDone();
      } catch (e) {
        setProblem(String((e as Error)?.message ?? e));
      }
    });
  const tick = "h-3.5 w-3.5 accent-stone-700";
  return (
    <form
      className={`flex flex-col gap-3 rounded-2xl bg-white/70 p-3 ring-1 ${accent.ring} dark:bg-white/[0.04]`}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && statuses.length) void submit();
      }}
    >
      <p className="text-[12px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">Compose a role on top of staff</p>
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <span className="text-[11px] text-stone-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder="packer" className={input} />
        </label>
        <label className="flex min-w-[14rem] flex-[2] flex-col gap-1">
          <span className="text-[11px] text-stone-500">What it is for</span>
          <input value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="packs what is being prepared" className={input} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] text-stone-500">Sees orders that are…</legend>
          {STATUS_FLOW.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" className={tick} checked={statuses.includes(s)} onChange={() => setStatuses(toggle(statuses, s))} /> {s}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] text-stone-500">…and may move them to</legend>
          {statuses.map((from) => (
            <div key={from} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="w-20 text-stone-500">{from} →</span>
              {STATUS_FLOW.filter((t) => t !== from).map((to) => (
                <label key={to} className="flex items-center gap-1">
                  <input type="checkbox" className={tick} checked={(moves[from] ?? []).includes(to)} onChange={() => setMoves({ ...moves, [from]: toggle(moves[from] ?? [], to) })} /> {to}
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" className={tick} checked={hideNote} onChange={() => setHideNote(!hideNote)} /> never sees the customer&rsquo;s note
        </label>
        <span className="text-[11px] text-stone-500">may call:</span>
        {DESK_OPS.map((o) => (
          <label key={o} className="flex items-center gap-1">
            <input type="checkbox" className={tick} checked={opsAllowed.includes(o)} onChange={() => setOpsAllowed(toggle(opsAllowed, o))} /> {o}
          </label>
        ))}
      </div>
      {problem ? <p className="rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100">{problem}</p> : null}
      <div>
        <button type="submit" disabled={!name.trim() || !statuses.length || busy === "compose-role"} className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] font-medium disabled:opacity-40 ${accent.pill}`}>
          {busy === "compose-role" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
          Compose the role
        </button>
      </div>
    </form>
  );
}

/**
 * PEOPLE — the owner hands someone an access level by their esoul email.
 *
 * The email is how a person is NAMED and never how they are checked: the
 * platform resolves it once against a real account and the grant is stored
 * against that account's id, so changing an inbox does not change who may see
 * the orders, and a typo is refused here rather than becoming a grant nobody
 * holds.
 *
 * What a role means is the app's own business — `plugin.json` says a `staff`
 * may read every order and move it along, and may not touch the price list.
 * The platform only decides WHICH word this caller arrives with.
 */
function People({
  accent,
  isOwner,
  op,
  busy,
  run,
}: {
  accent: ReturnType<typeof accentOf>;
  isOwner: boolean;
  op: <T>(name: string, args?: unknown) => Promise<T>;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [people, setPeople] = useState<Helper[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [problem, setProblem] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>(["staff"]);
  const [composed, setComposed] = useState<ComposedRole[]>([]);

  const load = useCallback(() => {
    op<{ people: Helper[]; roles: string[]; custom?: ComposedRole[] }>("list-people")
      .then((r) => {
        setPeople(r.people);
        if (r.roles?.length) setRoles(r.roles);
        setComposed(r.custom ?? []);
      })
      .catch((e) => setProblem(String((e as Error)?.message ?? e)));
  }, [op]);
  const removeRole = (name: string) =>
    run(`remove-role:${name}`, async () => {
      setProblem(null);
      try {
        await op("remove-role", { name });
        load();
      } catch (e) {
        setProblem(String((e as Error)?.message ?? e));
      }
    });
  // The words the app declared, then the roles the owner composed — one list to give.
  const giveable = [...roles, ...composed.map((c) => c.name)];
  useEffect(load, [load]);

  const grant = (to: string, asRole: string) =>
    run(`grant:${to}`, async () => {
      setProblem(null);
      try {
        await op("set-person-role", { email: to, role: asRole });
        setEmail("");
        load();
      } catch (e) {
        setProblem(String((e as Error)?.message ?? e));
      }
    });

  if (!isOwner)
    return (
      <p className={`rounded-xl bg-white/60 px-3 py-2.5 text-[12.5px] text-stone-500 ring-1 ${accent.ring} dark:bg-white/[0.03] dark:text-stone-400`}>
        Only the shop&rsquo;s owner hands out access.
      </p>
    );

  return (
    <div className="flex flex-col gap-3">
      <form
        className={`flex flex-wrap items-end gap-2 rounded-2xl bg-white/70 p-3 ring-1 ${accent.ring} dark:bg-white/[0.04]`}
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) void grant(email.trim(), role);
        }}
      >
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">Their esoul email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="someone@example.com"
            className={input}
          />
        </label>
        <span className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">As</span>
          <Select value={role} onChange={setRole} label="The role to give">
            {giveable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </span>
        <button type="submit" disabled={!email.trim() || busy === `grant:${email.trim()}`} className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] font-medium disabled:opacity-40 ${accent.pill}`}>
          {busy === `grant:${email.trim()}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
          Give access
        </button>
      </form>

      {problem ? (
        <p className="rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100">{problem}</p>
      ) : null}

      {people === null ? (
        <p className="text-[12.5px] text-stone-500">Reading the book…</p>
      ) : !people.length ? (
        <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
          <Users className={`h-10 w-10 ${accent.soft}`} aria-hidden />
          <p className="text-[13px] font-medium">Nobody else has access</p>
          <p className="max-w-sm text-[11.5px] leading-4 text-stone-500 dark:text-stone-400">
            Give someone&rsquo;s esoul email a role and they see this shop as that role the next time they open it — a{" "}
            <span className="font-medium">staff</span> member sees the desk and every order, and never the price list.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-200/70 overflow-hidden rounded-2xl bg-white/70 ring-1 ring-stone-900/10 dark:divide-white/5 dark:bg-white/[0.04] dark:ring-white/10">
          {people.map((h) => (
            <li key={h.userId} className="flex flex-wrap items-center gap-3 p-2.5">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${accent.pill}`}>
                {(h.email ?? "?").slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{h.email ?? h.userId}</span>
                <span className="block text-[10.5px] text-stone-400">{h.grantedAt ? `since ${new Date(h.grantedAt).toLocaleDateString()}` : "granted"}</span>
              </span>
              <Select value={h.role} onChange={(v) => void grant(h.email ?? h.userId, v)} label={`Access for ${h.email ?? h.userId}`}>
                {giveable.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                onClick={() => void grant(h.email ?? h.userId, "")}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-300/70 px-2 py-1 text-[11.5px] text-stone-600 hover:bg-stone-100 dark:border-white/15 dark:text-stone-300 dark:hover:bg-white/10"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Take it back
              </button>
            </li>
          ))}
        </ul>
      )}

      {composed.length ? (
        <ul className="flex flex-col divide-y divide-stone-200/70 overflow-hidden rounded-2xl bg-white/70 ring-1 ring-stone-900/10 dark:divide-white/5 dark:bg-white/[0.04] dark:ring-white/10">
          {composed.map((c) => {
            const o = c.models?.Order;
            const moves = Object.entries(o?.update?.transitions ?? {}).filter(([, to]) => to?.length);
            return (
              <li key={c.name} className="flex flex-wrap items-center gap-3 p-2.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.pill}`}>{c.name}</span>
                <span className="min-w-0 flex-1 text-[12px] text-stone-600 dark:text-stone-300">
                  on <span className="font-medium">{c.base}</span> · sees {(o?.where?.status ?? []).join(", ") || "every status"}
                  {moves.length ? ` · may move ${moves.map(([f, t]) => `${f} → ${t.join("/")}`).join(", ")}` : " · may not move orders"}
                  {(o?.hide ?? []).includes("note") ? " · never sees the note" : ""}
                  {c.ops?.length ? ` · may call ${c.ops.join(", ")}` : ""}
                  {c.describe ? <span className="block text-[11px] text-stone-400">{c.describe}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => void removeRole(c.name)}
                  disabled={busy === `remove-role:${c.name}`}
                  className="inline-flex items-center gap-1 rounded-lg border border-stone-300/70 px-2 py-1 text-[11.5px] text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:border-white/15 dark:text-stone-300 dark:hover:bg-white/10"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <RoleComposer accent={accent} op={op} busy={busy} run={run} onDone={load} />
    </div>
  );
}

/* ── the till ────────────────────────────────────────────────────────────── */

/**
 * WHAT IT TOOK. One indexed read per window, summed per product, and it says
 * the date it can see back to — an order placed before this version has a
 * receipt and no lines, and a total that quietly omits last month is worse
 * than one that names its horizon.
 */
function Till({ accent, op }: { accent: ReturnType<typeof accentOf>; op: <T>(name: string, args?: unknown) => Promise<T> }) {
  type Sales = {
    products: { productId: string | null; name: string; units: number; centsSold: number }[];
    unitsSold: number;
    centsSold: number;
    nextCursor: string | null;
    countsSalesFrom: string | null;
  };
  const WINDOWS = [
    { id: "7", label: "7 days", days: 7 },
    { id: "30", label: "30 days", days: 30 },
    { id: "all", label: "Everything", days: 0 },
  ];
  const [win, setWin] = useState("30");
  const [sales, setSales] = useState<Sales | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const w = WINDOWS.find((x) => x.id === win)!;
    setSales(null);
    setProblem(null);
    op<Sales>("sales", w.days ? { since: new Date(Date.now() - w.days * 86_400_000).toISOString() } : {})
      .then(setSales)
      .catch((e) => setProblem(String((e as Error)?.message ?? e)));
  }, [win, op]);

  const top = sales?.products ?? [];
  const most = Math.max(1, ...top.map((p) => p.centsSold));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setWin(w.id)}
            className={`rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium ${win === w.id ? accent.pill : "border border-stone-300/70 text-stone-600 dark:border-white/15 dark:text-stone-300"}`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {problem ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{problem}</p> : null}

      {sales === null ? (
        <p className="text-[12.5px] text-stone-500">Adding it up…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Taken" value={money(sales.centsSold)} Icon={Banknote} />
            <Stat label="Things sold" value={String(sales.unitsSold)} Icon={ShoppingBag} />
            <Stat label="Different things" value={String(top.length)} Icon={Tag} />
          </div>

          {top.length ? (
            <ul className={`flex flex-col gap-1.5 rounded-2xl bg-white/70 p-3 ring-1 ${accent.ring} dark:bg-white/[0.04]`}>
              {top.map((p) => (
                <li key={p.productId ?? p.name} className="flex items-center gap-2.5">
                  <span className="w-32 shrink-0 truncate text-[12px]">{p.name}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-stone-200/70 dark:bg-white/10">
                    <span className={`block h-full rounded-full ${accent.glow}`} style={{ width: `${Math.max(3, (p.centsSold / most) * 100)}%` }} />
                  </span>
                  <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-stone-500 dark:text-stone-400">{p.units}×</span>
                  <span className="w-16 shrink-0 text-right text-[12px] font-medium tabular-nums">{money(p.centsSold)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className={`flex flex-col items-center gap-2 rounded-2xl bg-white/60 px-6 py-10 text-center ring-1 ${accent.ring} dark:bg-white/[0.03]`}>
              <SealArt className={`h-12 w-12 ${accent.soft}`} />
              <p className="text-[12.5px] text-stone-500 dark:text-stone-400">Nothing sold in that window.</p>
            </div>
          )}

          <p className="text-[10.5px] text-stone-400">
            {sales.countsSalesFrom
              ? `Counted from ${new Date(sales.countsSalesFrom).toLocaleString()} — the line-by-line record starts there. Orders placed before it have a receipt and are not in these totals.`
              : "Nothing has been sold yet."}
            {sales.nextCursor ? " More pages exist; this is the newest page." : ""}
          </p>
        </>
      )}
    </div>
  );
}

/* ── how it looks ────────────────────────────────────────────────────────── */

/** The shop's own face: one picture, one line, five palettes. */
function Look({
  accent,
  look,
  instanceName,
  canEdit,
  op,
  busy,
  run,
}: {
  accent: ReturnType<typeof accentOf>;
  look: ShopLook | undefined;
  instanceName: string;
  canEdit: boolean;
  op: <T>(name: string, args?: unknown) => Promise<T>;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [hero, setHero] = useState(look?.heroUrl ?? "");
  const [tagline, setTagline] = useState(look?.tagline ?? "");
  useEffect(() => {
    setHero(look?.heroUrl ?? "");
    setTagline(look?.tagline ?? "");
  }, [look?.heroUrl, look?.tagline]);

  const save = (args: Record<string, unknown>, key: string) => run(key, async () => void (await op("set-look", args)));

  return (
    <div className="flex flex-col gap-3">
      {/* what it looks like now, at a glance */}
      <div className={`relative isolate flex min-h-[9rem] items-end overflow-hidden rounded-2xl ring-1 ${accent.ring}`}>
        {hero ? (
          <>
            <img src={hero} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-stone-950/85 via-stone-950/40 to-transparent" />
          </>
        ) : (
          <div className={`absolute inset-0 bg-gradient-to-br ${accent.wash}`} />
        )}
        <div className={`relative p-4 ${hero ? "text-white" : ""}`}>
          <p className="text-[10px] uppercase tracking-[0.18em] opacity-70">open today</p>
          <p className="mt-1 max-w-md text-[17px] font-semibold leading-tight">{tagline || "Everything on the shelves today"}</p>
          <p className="mt-1 text-[11px] opacity-70">{instanceName}</p>
        </div>
      </div>

      <Field label="The line under the shop's name" hint={`${tagline.length}/160 — leave it empty for the shop's own words`}>
        <input value={tagline} onChange={(e) => setTagline(e.target.value.slice(0, 160))} className={input} placeholder="Bread before six, tea by the ounce, jam from October" />
      </Field>

      <Field label="The picture across the top" hint="An https link. Empty for the shop's own drawn morning.">
        <input value={hero} onChange={(e) => setHero(e.target.value)} className={`${input} font-mono text-[11.5px]`} placeholder="https://…" />
      </Field>

      <Field label="Accent">
        <div className="flex flex-wrap gap-1.5">
          {ACCENTS.map((a) => {
            const tone = accentOf(a);
            const on = (look?.accent ?? "amber") === a;
            return (
              <button
                key={a}
                type="button"
                disabled={!canEdit}
                onClick={() => void save({ accent: a }, `accent:${a}`)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] capitalize ring-1 ${on ? tone.pill : "bg-white/70 ring-stone-900/10 dark:bg-white/5 dark:ring-white/10"} ${tone.ring}`}
              >
                <span className={`h-3 w-3 rounded-full ${tone.glow} ring-1 ${tone.ring}`} aria-hidden />
                {a}
                {on ? <Check className="h-3 w-3" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      </Field>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy === "look"}
            onClick={() => void save({ heroUrl: hero.trim() || null, tagline: tagline.trim() || null }, "look")}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium disabled:opacity-40 ${accent.pill}`}
          >
            {busy === "look" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            Save the look
          </button>
          {look?.heroUrl ? (
            <button type="button" onClick={() => void save({ heroUrl: null }, "look")} className="rounded-xl border border-stone-300/70 px-3 py-2 text-[12.5px] dark:border-white/15">
              Take the picture down
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
