/**
 * ShopDemoUi — first render through react-dom/server, as three people.
 *
 * The SDK hooks read context a bare render has none of, so they are mocked
 * (the tally/flappy pattern). What is asserted is the one thing this UI is
 * for: the same state renders a DIFFERENT screen for a customer, for staff
 * and for the owner, and a signed-out visitor is offered the wall.
 */
let viewer = { kind: "visitor", role: "customer", userId: "u1", canEdit: false, signedIn: true };
let wallNeeded = false;

jest.mock("esoul-sdk/react", () => ({
  usePluginEventDispatch: () => () => null,
  usePluginCurrentChatId: () => "",
  useAppCanEdit: () => viewer.canEdit,
  useViewer: () => viewer,
  useSignInWall: () => ({ needed: wallNeeded, reason: wallNeeded ? "sign in" : null, signIn: () => undefined, raise: () => undefined }),
  // The screen subscribes to its own channel so a customer's page moves when
  // their order does. Quiet here; `shop-demo.test.ts` proves the wiring.
  usePluginRealtime: () => ({ data: [], latestData: null, error: null, state: "idle" }),
}));
jest.mock("esoul-sdk", () => ({
  ...jest.requireActual("esoul-sdk"),
  callPluginOp: async () => [],
}));

import React from "react";
import { renderToString } from "react-dom/server";
import { ShopDemoUi } from "./ui/shop-demo-ui";

const IDENT = { workspaceId: "ws1", nodeId: "node1", applicationType: "plugin_shop_demo", instanceName: "Corner shop" };
const state = { ...IDENT, catalogueVersion: 0, announcements: [] } as never;
/** The words a person would actually read, with the markup taken out. */
const render = () =>
  renderToString(<ShopDemoUi state={state} />)
    .replace(/<!-- -->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("ShopDemoUi — four people, four shops", () => {
  it("a CUSTOMER gets the storefront, a basket and a way to their own orders — never the desk", () => {
    viewer = { kind: "visitor", role: "customer", userId: "u1", canEdit: false, signedIn: true };
    const text = render();
    expect(text).toContain("Corner shop");
    expect(text).toContain("Fresh things, ordered in one tap");
    expect(text).toContain("you are: customer");
    expect(text).toContain("Everything on the shelves today");
    expect(text).toContain("Basket");
    expect(text).toContain("Orders");
    // The desk's words are the ones a customer must never see.
    expect(text).not.toContain("The desk");
    expect(text).not.toContain("every order of this shop");
    expect(text).not.toContain("Taken today");
  });

  it("STAFF get the desk — the queue, the shelves and the till — and no basket", () => {
    viewer = { kind: "member", role: "staff", userId: "u2", canEdit: true, signedIn: true };
    const text = render();
    expect(text).toContain("The desk");
    expect(text).toContain("every order of this shop");
    // What the desk opens on: the four numbers, then the work.
    expect(text).toContain("Waiting");
    expect(text).toContain("Queue");
    expect(text).toContain("Shelves");
    expect(text).toContain("Till");
    expect(text).not.toContain("Basket"); // the people who run a shop do not shop in it here
  });

  it("the OWNER also gets the book of who may help, and the shop's look", () => {
    viewer = { kind: "owner", role: "owner", userId: "u0", canEdit: true, signedIn: true };
    const text = render();
    expect(text).toContain("The desk");
    expect(text).toContain("People");
    expect(text).toContain("Look");
    // The notice board is the owner's, and it says what is currently showing.
    expect(text).toContain("Post");
  });

  it("a SIGNED-OUT visitor gets the shelves and a reason to sign in — and no orders of anyone's", () => {
    viewer = { kind: "anonymous", role: "customer", userId: null as never, canEdit: false, signedIn: false };
    wallNeeded = true;
    const text = render();
    expect(text).toContain("not signed in");
    expect(text).toContain("Sign in to order");
    expect(text).toContain("Everything on the shelves today"); // the shelves are open to anyone
    expect(text).toContain("Basket"); // they may fill one; ordering is what needs an account
    expect(text).not.toContain("The desk");
    // No orders page and no link to one.
    expect(text).not.toMatch(/Your orders|Nothing ordered yet/);
    wallNeeded = false;
  });

  it("a read-only owner may LOOK at the desk and change nothing — a word is not a permission", () => {
    viewer = { kind: "owner", role: "owner", userId: "u0", canEdit: false, signedIn: true };
    const text = render();
    expect(text).toContain("The desk");
    // The notice composer is a write, so it is not offered at all.
    expect(text).not.toContain("Post");
  });
});

/**
 * A shop should look like a shop before anyone has uploaded a photograph, so
 * a product's picture is chosen from what it is called — and from its stock
 * code, because "Earl Grey" and "Linen apron" do not say what they are while
 * TEA-01 and APR-01 do.
 */
describe("the picture a product gets", () => {
  const { iconFor } = require("./ui/shop-demo-ui") as { iconFor: (n: string, s?: string | null) => { displayName?: string; name?: string } };
  const name = (n: string, s?: string | null) => {
    const I = iconFor(n, s) as unknown as { displayName?: string; name?: string; render?: { displayName?: string } };
    return I.displayName ?? I.render?.displayName ?? I.name ?? "";
  };

  it("reads the NAME when the name says what it is", () => {
    expect(name("Butter cookies")).toBe("Cookie");
    expect(name("Red wine")).toBe("Wine");
    expect(name("Sunflowers")).toBe("Flower2");
    expect(name("Gift card")).toBe("Gift");
  });

  it("reads the STOCK CODE when the name does not — Earl Grey is tea, a Linen apron is worn", () => {
    expect(name("Earl Grey", "TEA-01")).toBe("Coffee");
    expect(name("Linen apron", "APR-01")).toBe("Shirt"); // "linen" and "apron" both land it
  });

  it("is stable: the same product always gets the same picture, matched or not", () => {
    expect(name("Zarf", "ZZZ-9")).toBe(name("Zarf", "ZZZ-9"));
    expect(name("Zarf", "ZZZ-9")).not.toBe("");
  });
});
