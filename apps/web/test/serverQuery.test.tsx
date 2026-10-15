// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithProbe, type Probe } from "@weng-lab/render-probe";
import { ServerQueryProvider, useServerMutation, useServerQuery } from "../browser/serverQuery";

let probe: Probe | undefined;
let outcome: Promise<unknown> | undefined;

function SessionList() {
  const sessions = useServerQuery({
    queryKey: ["sessions"],
    path: "/sessions",
    parse: (data) => data as string[],
  });
  const deletion = useServerMutation<string, string[]>({
    invalidate: [["sessions"]],
    optimistic: {
      queryKey: ["sessions"],
      apply: (ids, id) => (ids ?? []).filter((savedId) => savedId !== id),
    },
    mutationFn: (id, request) => request(`/sessions/${id}`, { method: "DELETE" }),
  });
  const names = sessions.data ?? [];
  return (
    <>
      <output>{sessions.isLoading ? "loading" : names.join(",")}</output>
      <button
        type="button"
        onClick={() => {
          outcome = deletion.mutateAsync("niship").then(
            () => "deleted",
            () => "failed",
          );
        }}
      >
        Delete niship
      </button>
    </>
  );
}

function Host({ show = true }: { show?: boolean }) {
  return (
    <ServerQueryProvider endpoint="/gateway">{show ? <SessionList /> : null}</ServerQueryProvider>
  );
}

afterEach(() => {
  probe?.unmount();
  probe = undefined;
  outcome = undefined;
  vi.unstubAllGlobals();
});

it("cancels a read from the configured endpoint when the query unmounts", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  function Toggle() {
    const [show, setShow] = useState(true);
    return (
      <>
        <Host show={show} />
        <button type="button" onClick={() => setShow(false)}>
          Hide
        </button>
      </>
    );
  }
  probe = await renderWithProbe(<Toggle />);
  expect(document.querySelector("output")?.textContent).toBe("loading");
  expect(signal?.aborted).toBe(false);
  await probe.measure(() => document.querySelectorAll("button")[1]!.click());
  expect(document.querySelector("output")).toBeNull();
  expect(signal?.aborted).toBe(true);
});

it("drops an in-flight list read when a delete settles and applies the later refresh", async () => {
  const requests: Array<{
    url: string;
    signal?: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  const deletes: Array<{ url: string; signal?: AbortSignal }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push({ url, signal: init.signal ?? undefined });
      return Promise.resolve(Response.json({ ok: true }));
    }
    return new Promise<Response>((resolve) => {
      requests.push({ url, signal: init?.signal ?? undefined, resolve });
    });
  });
  probe = await renderWithProbe(<Host />);
  expect(requests.map((request) => request.url)).toEqual(["/gateway/sessions"]);
  await probe.measure(() => document.querySelector("button")!.click());
  expect(deletes).toEqual([{ url: "/gateway/sessions/niship", signal: undefined }]);
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests[0].signal?.aborted).toBe(true);
  expect(requests[1].signal?.aborted).toBe(false);
  await probe.measure(() => requests[0].resolve(Response.json(["local", "niship"])));
  await vi.waitFor(() => {
    expect(document.querySelector("output")?.textContent).toBe("");
  });
  await probe.measure(() => requests[1].resolve(Response.json(["local"])));
  await vi.waitFor(() => {
    expect(document.querySelector("output")?.textContent).toBe("local");
  });
  expect(await outcome).toBe("deleted");
});

it("finishes a delete after the panel unmounts", async () => {
  let resolveDelete!: (response: Response) => void;
  const deletes: RequestInit[] = [];
  const deleteUrls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleteUrls.push(url);
      deletes.push(init);
      return new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    }
    return Promise.resolve(Response.json(["local", "niship"]));
  });
  function Toggle() {
    const [show, setShow] = useState(true);
    return (
      <>
        <Host show={show} />
        <button type="button" onClick={() => setShow(false)}>
          Hide
        </button>
      </>
    );
  }
  probe = await renderWithProbe(<Toggle />);
  await vi.waitFor(() => {
    expect(document.querySelector("output")?.textContent).toBe("local,niship");
  });
  await probe.measure(() => document.querySelectorAll("button")[0]!.click());
  expect(deleteUrls).toEqual(["/gateway/sessions/niship"]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].signal).toBeUndefined();
  await probe.measure(() => document.querySelectorAll("button")[1]!.click());
  expect(deletes[0].signal).toBeUndefined();
  let settled = false;
  void outcome!.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  resolveDelete(Response.json({ ok: true }));
  expect(await outcome).toBe("deleted");
});

it("restores the previous list when a delete fails", async () => {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
    init?.method === "DELETE"
      ? Promise.resolve(new Response(null, { status: 503 }))
      : Promise.resolve(Response.json(["local", "niship"])),
  );
  probe = await renderWithProbe(<Host />);
  await vi.waitFor(() => {
    expect(document.querySelector("output")?.textContent).toBe("local,niship");
  });
  await probe.measure(() => document.querySelector("button")!.click());
  expect(await outcome).toBe("failed");
  await vi.waitFor(() => {
    expect(document.querySelector("output")?.textContent).toBe("local,niship");
  });
});
