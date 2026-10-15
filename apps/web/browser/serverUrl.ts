export function serverUrl(endpoint: string, path: string) {
  const base = endpoint.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
