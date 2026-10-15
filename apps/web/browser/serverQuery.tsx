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

/**
 * One query cache for browser-server JSON, scoped to `endpoint`.
 * Mount this above the per-session stores so the cache survives session switches.
 */
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
            // Panels recover on focus, reopen, or invalidation. A hidden retry would
            // race those refreshes and delay the error the panel shows.
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

/** A write against the configured endpoint. It has no abort signal. */
export type ServerRequest = (path: string, init: ServerRequestInit) => Promise<unknown>;

async function writeServer(endpoint: string, path: string, init: ServerRequestInit) {
  // Mutations outlive the page. Callers cannot attach the query signal or persistence stop().
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
};

type ServerMutationOptions<TVariables, TOptimistic> = {
  /** Query keys to refresh after the mutation succeeds or fails. Prefixes match. */
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

/**
 * Run a mutation, then refresh its queries.
 * An in-flight read of those queries is cancelled first so its response cannot overwrite the outcome.
 * The request itself is not cancelled when the caller unmounts.
 */
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

  const previous = options.optimistic
    ? client.getQueryData<TOptimistic>(options.optimistic.queryKey)
    : undefined;
  if (options.optimistic) {
    const { queryKey, apply } = options.optimistic;
    client.setQueryData<TOptimistic>(queryKey, (current) => apply(current, variables));
  }

  const request: ServerRequest = (path, init) => writeServer(endpoint, path, init);
  try {
    if (options.mutationFn) return await options.mutationFn(variables, request);
    const path = typeof options.path === "function" ? options.path(variables) : options.path;
    return await request(path, { method: options.method, body: options.body?.(variables) });
  } catch (error) {
    if (options.optimistic) {
      // setQueryData ignores undefined and would keep the optimistic value.
      if (previous === undefined) client.removeQueries({ queryKey: options.optimistic.queryKey });
      else client.setQueryData(options.optimistic.queryKey, previous);
    }
    throw error;
  } finally {
    // Start the refresh, but do not wait for it. The mutation has already settled.
    void Promise.all(options.invalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
  }
}

/** Read JSON from the configured endpoint. The query signal cancels the fetch when the read is dropped. */
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
    queryKey,
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

/** Change server data. Reads refresh after it settles. The write is not tied to navigation or `stop()`. */
export function useServerMutation<TVariables, TOptimistic = unknown>(
  options: ServerMutationOptions<TVariables, TOptimistic>,
) {
  const endpoint = useServerEndpoint();
  const client = useQueryClient();
  const mutation = useMutation({
    // TanStack passes an AbortSignal that can follow the observer. This layer does not.
    mutationFn: (variables: TVariables) => runServerMutation(client, endpoint, options, variables),
  });
  return { isPending: mutation.isPending, mutateAsync: mutation.mutateAsync };
}
