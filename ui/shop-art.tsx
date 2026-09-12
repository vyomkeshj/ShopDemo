"use client";

import React from "react";

/**
 * THE SHOP'S DRAWN THINGS.
 *
 * Every one of these is an inline SVG, and that is a decision rather than a
 * convenience: a shop has to look like a shop on the day it is installed, when
 * nobody has photographed anything yet. A storefront whose good looks depend
 * on uploaded images has a first hour that looks broken, and "add a picture"
 * is the last thing a person does, not the first.
 *
 * So: photographs when the shop has them (`imageUrl`, `look.heroUrl`), and
 * these when it does not — the same layout either way, never a grey box with a
 * word in it. Lucide covers the FUNCTIONAL icons (basket, search, truck);
 * everything here is ornament, and ornament is where a shop's character is.
 *
 * They are all pure, take no state, and paint in `currentColor` or the accent
 * they are handed, so they invert with the theme without a second copy.
 */

/** The five palettes a shop may wear, as literal classes Tailwind can see. */
export const ACCENT_CLASS = {
  stone: { ink: "text-stone-900 dark:text-stone-100", soft: "text-stone-400/70", wash: "from-stone-200/80 via-stone-100 to-stone-50 dark:from-stone-800 dark:via-stone-900 dark:to-stone-950", pill: "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900", ring: "ring-stone-900/10 dark:ring-white/10", glow: "bg-stone-300/40 dark:bg-stone-500/20" },
  amber: { ink: "text-amber-900 dark:text-amber-100", soft: "text-amber-500/60", wash: "from-amber-200/80 via-orange-100 to-stone-50 dark:from-amber-950 dark:via-stone-900 dark:to-stone-950", pill: "bg-amber-900 text-amber-50 dark:bg-amber-200 dark:text-amber-950", ring: "ring-amber-900/10 dark:ring-amber-200/10", glow: "bg-amber-300/40 dark:bg-amber-500/20" },
  rose: { ink: "text-rose-900 dark:text-rose-100", soft: "text-rose-400/60", wash: "from-rose-200/80 via-rose-100 to-stone-50 dark:from-rose-950 dark:via-stone-900 dark:to-stone-950", pill: "bg-rose-900 text-rose-50 dark:bg-rose-200 dark:text-rose-950", ring: "ring-rose-900/10 dark:ring-rose-200/10", glow: "bg-rose-300/40 dark:bg-rose-500/20" },
  emerald: { ink: "text-emerald-900 dark:text-emerald-100", soft: "text-emerald-500/60", wash: "from-emerald-200/80 via-emerald-100 to-stone-50 dark:from-emerald-950 dark:via-stone-900 dark:to-stone-950", pill: "bg-emerald-900 text-emerald-50 dark:bg-emerald-200 dark:text-emerald-950", ring: "ring-emerald-900/10 dark:ring-emerald-200/10", glow: "bg-emerald-300/40 dark:bg-emerald-500/20" },
  indigo: { ink: "text-indigo-900 dark:text-indigo-100", soft: "text-indigo-400/60", wash: "from-indigo-200/80 via-indigo-100 to-stone-50 dark:from-indigo-950 dark:via-stone-900 dark:to-stone-950", pill: "bg-indigo-900 text-indigo-50 dark:bg-indigo-200 dark:text-indigo-950", ring: "ring-indigo-900/10 dark:ring-indigo-200/10", glow: "bg-indigo-300/40 dark:bg-indigo-500/20" },
} as const;

export type AccentName = keyof typeof ACCENT_CLASS;
export const accentOf = (name: string | undefined | null): (typeof ACCENT_CLASS)[AccentName] =>
  ACCENT_CLASS[(name as AccentName) in ACCENT_CLASS ? (name as AccentName) : "amber"];

/**
 * The shop's mark: a scalloped awning over a counter, drawn small enough to
 * read at 16 px and detailed enough to hold at 40. Three arcs, because two
 * looks like an accident and four looks like a spreadsheet.
 */
export function ShopMark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.2 9.4h17.6l-1.1 2.2H4.3z" fill="currentColor" stroke="none" opacity="0.9" />
      <path d="M3.2 9.4c0-2.2 1.4-3.6 3.1-3.6s2.9 1.4 2.9 3.6" />
      <path d="M9.2 9.4c0-2.2 1.3-3.6 2.9-3.6s2.9 1.4 2.9 3.6" />
      <path d="M15 9.4c0-2.2 1.3-3.6 2.9-3.6s3 1.4 3 3.6" />
      <path d="M5.1 11.6V19a1 1 0 0 0 1 1h11.8a1 1 0 0 0 1-1v-7.4" />
      <path d="M9.6 20v-4.3a2.4 2.4 0 0 1 4.8 0V20" />
      <path d="M12 5.8V3.4" />
    </svg>
  );
}

/**
 * PAPER GRAIN. A photograph on a screen looks like a screen; the same
 * photograph under a whisper of noise looks printed. feTurbulence costs one
 * filter and no bytes, and at 4% nobody can name what they are seeing.
 */
export function Grain({ opacity = 0.05 }: { opacity?: number }) {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden style={{ opacity }}>
      <filter id="shop-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#shop-grain)" />
    </svg>
  );
}

/**
 * The shop's own hero, for a shop with no photograph: morning light over a
 * counter, drawn. Concentric arcs for the light, a horizon, and the three
 * silhouettes every small grocer has — a loaf, a jar, a bottle.
 */
export function HeroPattern({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 270" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <defs>
        <linearGradient id="shop-sky" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
        <radialGradient id="shop-sun" cx="0.74" cy="0.3" r="0.5">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="480" height="270" fill="url(#shop-sky)" />
      <rect width="480" height="270" fill="url(#shop-sun)" />
      {[104, 82, 60, 38].map((r, i) => (
        <circle key={r} cx="355" cy="82" r={r} fill="none" stroke="currentColor" strokeOpacity={0.07 + i * 0.02} strokeWidth="1" />
      ))}
      {Array.from({ length: 42 }).map((_, i) => (
        <circle key={i} cx={(i * 73) % 470 + 6} cy={((i * 131) % 190) + 12} r={i % 5 === 0 ? 1.7 : 1} fill="currentColor" opacity={0.1 + ((i % 4) * 0.03)} />
      ))}
      {/* the counter */}
      <path d="M0 206h480v64H0z" fill="currentColor" opacity="0.1" />
      <path d="M0 206h480" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.4" />
      {/* a loaf */}
      <path d="M58 206c0-17 12-29 30-29s30 12 30 29z" fill="currentColor" opacity="0.3" />
      <path d="M70 182c4-5 8-7 12-7M84 180c4-4 8-6 12-6" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      {/* a jar */}
      <path d="M146 206v-32a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v32z" fill="currentColor" opacity="0.26" />
      <rect x="148" y="163" width="24" height="7" rx="2.5" fill="currentColor" opacity="0.42" />
      {/* a bottle */}
      <path d="M204 206v-38c0-4 3-6 3-11v-9h10v9c0 5 3 7 3 11v38z" fill="currentColor" opacity="0.28" />
      <rect x="206.5" y="141" width="11" height="6" rx="2" fill="currentColor" opacity="0.45" />
      {/* a sprig in a jug */}
      <path d="M262 206v-26h16v26z" fill="currentColor" opacity="0.24" />
      <path d="M270 180v-26M270 162c-6-2-9-7-9-12 6 1 9 6 9 12zM270 170c6-2 9-7 9-12-6 1-9 6-9 12z" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A TORN PAPER EDGE, laid over the bottom of the hero in the page's own
 * background colour. It is the cheapest thing in this file and the one that
 * does the most: a photograph that ends in a straight line reads as a banner,
 * and one that ends in a torn edge reads as something made.
 */
export function TornEdge({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 18" preserveAspectRatio="none" className={className} aria-hidden>
      <path
        d="M0 18V7.5c26-3.2 52 2.4 78-.4S156 .6 182 3.4s52 5.6 78 2.8 52-7.2 78-4.4 52 8 78 5.2c18-1.9 36-4.6 64-4.6V18z"
        fill="currentColor"
      />
    </svg>
  );
}

/** A shelf with nothing on it, for a search that found nothing. */
export function NoResultsArt({ className = "h-20 w-20" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M10 26h76M10 50h30M60 50h26M10 74h76" strokeOpacity="0.3" />
      <circle cx="52" cy="44" r="16" strokeOpacity="0.85" />
      <path d="M64 56l12 12" strokeOpacity="0.85" strokeWidth="2.2" />
      <path d="M44 44h16" strokeOpacity="0.5" />
    </svg>
  );
}

/** A basket with nothing in it. Two loose things beside it, for the shape of hope. */
export function EmptyBasketArt({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 96" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M26 44h68l-7 38a4 4 0 0 1-4 3H37a4 4 0 0 1-4-3z" strokeOpacity="0.8" />
      <path d="M40 44c0-13 9-22 20-22s20 9 20 22" strokeOpacity="0.45" strokeDasharray="3 4" />
      <path d="M34 56h52M36 68h48" strokeOpacity="0.3" />
      <path d="M45 44l4 41M60 44v41M75 44l-4 41" strokeOpacity="0.22" />
      <circle cx="100" cy="30" r="7" strokeOpacity="0.5" />
      <path d="M100 23v-4" strokeOpacity="0.5" />
      <path d="M14 34c5-6 11-6 15 0-4 6-10 6-15 0z" strokeOpacity="0.45" />
    </svg>
  );
}

/** A wax seal, for the moment an order exists. */
export function SealArt({ className = "h-12 w-12" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        d="M24 3.5l4.6 3.1 5.5-.6 2.2 5.1 4.8 2.8-1.2 5.4 2.6 4.9-3.9 3.9-.6 5.5-5.3 1.6-3.4 4.4-5.3-1.6-5.3 1.6-3.4-4.4-5.3-1.6-.6-5.5L1 27.2l2.6-4.9-1.2-5.4 4.8-2.8 2.2-5.1 5.5.6z"
        fill="currentColor"
        opacity="0.16"
      />
      <circle cx="24" cy="24" r="13" fill="currentColor" opacity="0.28" />
      <path d="M24 15.5l2.4 5.3 5.6.7-4.1 3.9 1.1 5.6-5-2.8-5 2.8 1.1-5.6-4.1-3.9 5.6-.7z" fill="currentColor" opacity="0.75" />
    </svg>
  );
}

/** A botanical sprig, for the space between one thing and the next. */
export function SprigArt({ className = "h-4 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
      <path d="M4 10h52" strokeOpacity="0.25" />
      <path d="M30 10c-4-1-6-4-6-7 4 .6 6 3.4 6 7zM30 10c4-1 6-4 6-7-4 .6-6 3.4-6 7z" strokeOpacity="0.6" />
      <circle cx="30" cy="13.5" r="1.6" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

/**
 * The picture of a thing when the shop has no photograph of it: the icon it
 * was already given, on a woven ground. Drawn rather than grey, because a
 * shelf of grey rectangles is how a shop looks closed.
 */
export function WovenGround({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <pattern id="shop-weave" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M0 5h10M5 0v10" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="80" height="80" fill="url(#shop-weave)" />
    </svg>
  );
}
