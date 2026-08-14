export async function fetchViaProxy(url) {
  const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return { text: data.text, finalUrl: data.finalUrl };
}
