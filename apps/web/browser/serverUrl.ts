/** Join the configured browser-server endpoint with a path such as `/sessions`. */
export function serverUrl(endpoint: string, path: string) {
  const base = endpoint.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
