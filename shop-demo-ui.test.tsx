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
const render = () => renderToString(<ShopDemoUi state={state} />).replace(/<!-- -->/g, "");

describe("ShopDemoUi — the screen follows the viewer", () => {
  it("a customer sees the catalogue and 'Your orders', never the desk", () => {
    viewer = { kind: "visitor", role: "customer", userId: "u1", canEdit: false, signedIn: true };
    const html = render();
    expect(html).toContain("Corner shop");
    expect(html).toContain("you are: customer");
    expect(html).toContain("Your orders");
    expect(html).not.toContain("the desk");
    expect(html).not.toContain("Add a product");
  });

  it("staff see the desk and not the price form", () => {
    viewer = { kind: "member", role: "staff", userId: "u2", canEdit: true, signedIn: true };
    const html = render();
    expect(html).toContain("Orders — the desk");
    expect(html).not.toContain("Add a product");
  });

  it("the owner sees the desk AND the price form", () => {
    viewer = { kind: "owner", role: "owner", userId: "u0", canEdit: true, signedIn: true };
    const html = render();
    expect(html).toContain("Orders — the desk");
    expect(html).toContain("Add a product");
  });

  it("a signed-out visitor gets the catalogue and, once the wall is raised, a sign-in button — and no orders section", () => {
    viewer = { kind: "anonymous", role: "customer", userId: null as never, canEdit: false, signedIn: false };
    wallNeeded = true;
    const html = render();
    expect(html).toContain("not signed in");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Your orders");
    wallNeeded = false;
  });
});
