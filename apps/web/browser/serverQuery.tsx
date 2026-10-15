"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { serverUrl } from "./serverUrl";

const EndpointContext = createContext<string | null>(null);

export function ServerQueryProvider({
  endpoint,
  children,
}: {
  endpoint: string;
  children: ReactNode;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <EndpointContext value={endpoint}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </EndpointContext>
  );
}

function useServerEndpoint() {
  const endpoint = useContext(EndpointContext);
  if (!endpoint) throw new Error("Server query hooks must be used within ServerQueryProvider");
  return endpoint;
}

export type ServerRequestInit = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
};

export type ServerRequest = (path: string, init: ServerRequestInit) => Promise<unknown>;

async function writeServer(endpoint: string, path: string, init: ServerRequestInit) {
  const response = await fetch(serverUrl(endpoint, path), {
    method: init.method,
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

type Optimistic<TVariables, TOptimistic> = {
  queryKey: QueryKey;
  apply: (current: TOptimistic | undefined, variables: TVariables) => TOptimistic;
  rollback?: (current: TOptimistic | undefined, variables: TVariables) => TOptimistic | undefined;
};

type ServerMutationOptions<TVariables, TOptimistic> = {
  invalidate: QueryKey[];
  optimistic?: Optimistic<TVariables, TOptimistic>;
} & (
  | {
      mutationFn: (variables: TVariables, request: ServerRequest) => Promise<unknown>;
      path?: never;
      method?: never;
      body?: never;
    }
  | {
      mutationFn?: never;
      path: string | ((variables: TVariables) => string);
      method: ServerRequestInit["method"];
      body?: (variables: TVariables) => unknown;
    }
);

function restoreOptimistic<TVariables, TOptimistic>(
  client: QueryClient,
  optimistic: Optimistic<TVariables, TOptimistic>,
  variables: TVariables,
  snapshots: Array<[QueryKey, TOptimistic | undefined]>,
) {
  if (optimistic.rollback) {
    const rollback = optimistic.rollback;
    client.setQueriesData<TOptimistic>({ queryKey: optimistic.queryKey }, (current) =>
      rollback(current, variables),
    );
    return;
  }
  if (snapshots.every(([, data]) => data === undefined)) {
    // setQueryData ignores undefined and would keep the optimistic value.
    client.removeQueries({ queryKey: optimistic.queryKey });
    return;
  }
  for (const [key, data] of snapshots) {
    if (data === undefined) client.removeQueries({ queryKey: key, exact: true });
    else client.setQueryData(key, data);
  }
}

async function runServerMutation<TVariables, TOptimistic>(
  client: QueryClient,
  endpoint: string,
  options: ServerMutationOptions<TVariables, TOptimistic>,
  variables: TVariables,
) {
  const readKeys = options.optimistic
    ? [options.optimistic.queryKey, ...options.invalidate]
    : options.invalidate;
  await Promise.all(readKeys.map((queryKey) => client.cancelQueries({ queryKey })));

  const snapshots = options.optimistic
    ? client.getQueriesData<TOptimistic>({ queryKey: options.optimistic.queryKey })
    : [];
  if (options.optimistic) {
    const { queryKey, apply } = options.optimistic;
    client.setQueriesData<TOptimistic>({ queryKey }, (current) => apply(current, variables));
  }

  const request: ServerRequest = (path, init) => writeServer(endpoint, path, init);
  try {
    if (options.mutationFn) return await options.mutationFn(variables, request);
    const path = typeof options.path === "function" ? options.path(variables) : options.path;
    return await request(path, { method: options.method, body: options.body?.(variables) });
  } catch (error) {
    if (options.optimistic) restoreOptimistic(client, options.optimistic, variables, snapshots);
    throw error;
  } finally {
    void Promise.all(options.invalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
  }
}

export function useServerQuery<T>({
  queryKey,
  path,
  parse,
}: {
  queryKey: QueryKey;
  path: string;
  parse: (data: unknown) => T;
}) {
  const endpoint = useServerEndpoint();
  const query = useQuery({
    queryKey: [...queryKey, path],
    queryFn: async ({ signal }) => {
      const response = await fetch(serverUrl(endpoint, path), { cache: "no-store", signal });
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return parse(await response.json());
    },
  });
  return {
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export function useServerMutation<TVariables, TOptimistic = unknown>(
  options: ServerMutationOptions<TVariables, TOptimistic>,
) {
  const endpoint = useServerEndpoint();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (variables: TVariables) => runServerMutation(client, endpoint, options, variables),
  });
  return { isPending: mutation.isPending, mutateAsync: mutation.mutateAsync };
}
