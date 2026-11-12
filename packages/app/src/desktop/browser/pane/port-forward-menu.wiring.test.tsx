/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortForwardController } from "@/port-forward/types";

void testI18n;

const harness = vi.hoisted(() => ({
  controller: null as PortForwardController | null,
  opened: [] as string[],
}));

vi.mock("@/port-forward/controller", () => ({
  getPortForwardController: () => harness.controller,
}));
vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: async (url: string) => {
    harness.opened.push(url);
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/menu", () => ({ MenuTextField: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => {
  function DropdownMenu(props: { children: ReactNode; onOpenChange?: (open: boolean) => void }) {
    const { onOpenChange } = props;
    useEffect(() => onOpenChange?.(true), [onOpenChange]);
    return <div>{props.children}</div>;
  }
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu,
    DropdownMenuTrigger: () => null,
    DropdownMenuContent: Passthrough,
    DropdownMenuHint: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: (props: { children: ReactNode; onSelect?: () => void; testID?: string }) => (
      <button type="button" data-testid={props.testID} onClick={props.onSelect}>
        {props.children}
      </button>
    ),
  };
});

const { BrowserPortForwardMenu } = await import("./port-forward-menu");

function fakeController(result: Awaited<ReturnType<PortForwardController["start"]>>) {
  const starts: Parameters<PortForwardController["start"]>[0][] = [];
  const controller: PortForwardController = {
    device: "phone",
    start: async (input) => {
      starts.push(input);
      return result;
    },
    stop: async () => {},
    stopAll: async () => {},
    list: async () => ({ forwards: [], observedPorts: [] }),
  };
  return { controller, starts };
}

const triggerStyle = () => null;
const loadObservedPorts = async () => [8080, 24678];
const route = { serverId: "host-a", workspaceId: "ws-1" };

afterEach(() => {
  cleanup();
  harness.controller = null;
  harness.opened = [];
});

describe("BrowserPortForwardMenu wiring", () => {
  it("forwards the page port and the ports its traffic used to the tab's host, then opens it", async () => {
    const { controller, starts } = fakeController({
      kind: "started",
      forwards: [{ state: "forwarding", remotePort: 5173, localPort: 5173 }],
    });
    harness.controller = controller;
    const onForwardsStarted = vi.fn();
    render(
      <BrowserPortForwardMenu
        browserId="tab-1"
        url="http://localhost:5173/app"
        route={route}
        loadObservedPorts={loadObservedPorts}
        onForwardsStarted={onForwardsStarted}
        triggerStyle={triggerStyle}
      />,
    );
    await screen.findByText("localhost:8080");

    await act(async () => {
      fireEvent.click(screen.getByTestId("browser-port-forward-open"));
    });

    expect(starts).toEqual([
      { browserId: "tab-1", ports: [5173, 8080, 24678], fallbackToAnyPort: false, route },
    ]);
    expect(onForwardsStarted).toHaveBeenCalledTimes(1);
    expect(harness.opened).toEqual(["http://localhost:5173/app"]);
  });

  it("opens the URL itself when the host is this phone, with nothing to stop later", async () => {
    const { controller } = fakeController({ kind: "local-host" });
    harness.controller = controller;
    const onForwardsStarted = vi.fn();
    render(
      <BrowserPortForwardMenu
        browserId="tab-1"
        url="http://127.0.0.1:3000/"
        route={route}
        onForwardsStarted={onForwardsStarted}
        triggerStyle={triggerStyle}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("browser-port-forward-open"));
    });

    expect(harness.opened).toEqual(["http://127.0.0.1:3000/"]);
    expect(onForwardsStarted).not.toHaveBeenCalled();
  });

  it("is absent for a page off localhost", () => {
    harness.controller = fakeController({ kind: "local-host" }).controller;
    render(
      <BrowserPortForwardMenu
        browserId="tab-1"
        url="https://example.com/"
        route={route}
        triggerStyle={triggerStyle}
      />,
    );
    expect(screen.queryByTestId("browser-port-forward-open")).toBeNull();
  });
});
