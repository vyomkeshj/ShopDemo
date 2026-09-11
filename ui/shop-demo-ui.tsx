"use client";

import React, { useCallback, useEffect, useState } from "react";
import { callPluginOp } from "esoul-sdk";
import { useAppCanEdit, usePluginEventDispatch, useSignInWall, useViewer } from "esoul-sdk/react";
import { catalogueChangedEvent, PLUGIN_ID, type ShopDemoData } from "../app";

/**
 * The shop, as three people see it.
 *
 * `useViewer()` says who is looking and the screen follows: a CUSTOMER gets the
 * catalogue and their own orders (and a sign-in wall the moment they try to
 * order signed out); STAFF get the desk — every order of this shop, with a
 * refund button; the OWNER gets the desk plus the price list. None of these
 * screens checks anything: each simply calls the ops it needs, and the rows
 * that come back are the rows the platform let this caller see.
 *
 * Nothing here talks to a database. Every read and write is an op (server.ts),
 * and every op is one `pluginDb(ctx)` call. That is the whole pattern a
 * business app on esoul follows — this file is the shape, not a special case.
 *
 * Styling follows app-style-guide.md: sepia in light, translucent in dark.
 */

interface Product {
  id: string;
  name: string;
  priceCents: number;
  sku: string | null;
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

const money = (cents: number) => (cents / 100).toFixed(2);

export function ShopDemoUi({ state }: { state: ShopDemoData }) {
  const viewer = useViewer();
  const wall = useSignInWall();
  const canEdit = useAppCanEdit();
  const dispatch = usePluginEventDispatch();
  const nodeId = state?.nodeId ?? "";

  const [products, setProducts] = useState<Product[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const op = useCallback(<T,>(name: string, args?: unknown) => callPluginOp<T>(PLUGIN_ID, name, nodeId, args), [nodeId]);

  // The catalogue is public; it refetches when the fold says it changed.
  useEffect(() => {
    if (!nodeId) return;
    op<Product[]>("browse").then(setProducts, (e) => setError(String(e?.message ?? e)));
  }, [nodeId, state?.catalogueVersion, op]);

  // Orders: a customer's own, or the desk — the server decides, not this file.
  const loadOrders = useCallback(() => {
    if (!nodeId || !viewer.signedIn) return;
    op<Order[]>("list-orders").then(setOrders, (e) => setError(String(e?.message ?? e)));
  }, [nodeId, viewer.signedIn, op]);
  useEffect(loadOrders, [loadOrders]);

  async function order(p: Product) {
    setBusy(p.id);
    setError(null);
    try {
      await op("place-order", {
        lines: [{ productId: p.id, qty: 1 }],
        shipTo: { name: viewer.userId ?? "Guest", street: "—", city: "—" },
      });
      loadOrders();
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
  }

  async function refund(o: Order) {
    setBusy(o.id);
    setError(null);
    try {
      await op("refund", { orderId: o.id });
      loadOrders();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function addProduct(form: FormData) {
    const name = String(form.get("name") ?? "").trim();
    const priceCents = Math.round(Number(form.get("price") ?? 0) * 100);
    if (!name || !Number.isFinite(priceCents)) return;
    setBusy("add");
    setError(null);
    try {
      await op("add-product", { name, priceCents });
      // The fold learns the catalogue changed; every open tab refetches.
      dispatch?.(
        catalogueChangedEvent.dataCreator({
          workspaceId: state.workspaceId,
          nodeId: state.nodeId,
          applicationId: state.nodeId,
          instanceName: state.instanceName,
          what: `added ${name}`,
        }),
      );
      const fresh = await op<Product[]>("browse");
      setProducts(fresh);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const isDesk = viewer.role === "staff" || viewer.role === "owner";

  return (
    <div className="shop-root flex h-full w-full flex-col gap-4 overflow-auto p-4 text-[13px] text-stone-800 dark:text-stone-100">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold tracking-tight">{state?.instanceName ?? "Shop"}</h1>
        <span className="rounded-full border border-stone-300/70 px-2 py-0.5 text-[11px] text-stone-500 dark:border-white/15 dark:text-stone-400">
          you are: {viewer.role}
          {!viewer.signedIn ? " · not signed in" : ""}
        </span>
      </header>

      {state?.announcements?.length ? (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
          {state.announcements[0].text}
        </div>
      ) : null}

      {error ? <div className="rounded-lg border border-rose-300/60 bg-rose-50/70 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100">{error}</div> : null}

      {wall.needed ? (
        <div className="rounded-xl border border-stone-300/70 bg-white/70 p-4 dark:border-white/15 dark:bg-white/5">
          <p className="mb-2">Sign in to order — your cart and your orders will be yours on every device.</p>
          <button type="button" onClick={wall.signIn} className="rounded-md bg-stone-900 px-3 py-1.5 text-white dark:bg-white dark:text-stone-900">
            Sign in
          </button>
        </div>
      ) : null}

      <section>
        <h2 className="mb-2 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">Catalogue</h2>
        {products === null ? (
          <p className="text-stone-500">Loading…</p>
        ) : products.length === 0 ? (
          <p className="text-stone-500">No products yet{viewer.role === "owner" ? " — add one below" : ""}.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {products.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-lg border border-stone-300/70 bg-white/70 px-3 py-2 dark:border-white/15 dark:bg-white/5">
                <span>
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-stone-500">{money(p.priceCents)}</span>
                </span>
                {!isDesk ? (
                  <button
                    type="button"
                    disabled={busy === p.id}
                    onClick={() => order(p)}
                    className="rounded-md border border-stone-400/60 px-2 py-1 text-[12px] hover:bg-stone-100 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
                  >
                    {busy === p.id ? "…" : "Order"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {viewer.role === "owner" && canEdit ? (
        <section>
          <h2 className="mb-2 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">Add a product</h2>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              e.currentTarget.reset();
              void addProduct(form);
            }}
          >
            <input name="name" placeholder="Name" required className="rounded-md border border-stone-300/70 bg-white/70 px-2 py-1 dark:border-white/15 dark:bg-white/5" />
            <input name="price" type="number" step="0.01" min="0" placeholder="Price" required className="w-28 rounded-md border border-stone-300/70 bg-white/70 px-2 py-1 dark:border-white/15 dark:bg-white/5" />
            <button type="submit" disabled={busy === "add"} className="rounded-md bg-stone-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-white dark:text-stone-900">
              Add
            </button>
          </form>
        </section>
      ) : null}

      {viewer.signedIn ? (
        <section>
          <h2 className="mb-2 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">{isDesk ? "Orders — the desk" : "Your orders"}</h2>
          {orders === null ? (
            <p className="text-stone-500">Loading…</p>
          ) : orders.length === 0 ? (
            <p className="text-stone-500">{isDesk ? "No orders yet." : "You have not ordered anything yet."}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between rounded-lg border border-stone-300/70 bg-white/70 px-3 py-2 dark:border-white/15 dark:bg-white/5">
                  <span>
                    <span className="font-mono text-[11px] text-stone-500">{o.id.slice(0, 8)}</span>
                    <span className="ml-2">{o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ")}</span>
                    <span className="ml-2 text-stone-500">{money(o.totalCents)}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${o.status === "refunded" ? "bg-stone-200 dark:bg-white/10" : "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100"}`}>{o.status}</span>
                  </span>
                  {isDesk && o.status !== "refunded" ? (
                    <button
                      type="button"
                      disabled={busy === o.id}
                      onClick={() => refund(o)}
                      className="rounded-md border border-stone-400/60 px-2 py-1 text-[12px] hover:bg-stone-100 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
                    >
                      Refund
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
