/* Laido Downloader bridge — every download the browser starts gets
 * handed to the Laido segmented engine (parallel range streams, stall
 * tunneling, pause/resume, the bottom-right toast) instead of the
 * browser's built-in shelf.
 *
 * Flow: onCreated fires → ping the localhost bridge → cancel + erase
 * the native download → POST the url. If Laido isn't running, the ping
 * fails fast and the browser's own download proceeds untouched.
 * Laido's own bv-* engine downloads also land here and get deduped
 * against the webview's on_download intercept on the Rust side. */
const HUB = "http://127.0.0.1:47472";

chrome.downloads.onCreated.addListener((item) => {
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url)) return;
  (async () => {
    try {
      const ping = await fetch(`${HUB}/ping`, { signal: AbortSignal.timeout(900) });
      if (!ping.ok) return; // laido not running — leave it native
      await chrome.downloads.cancel(item.id);
      await chrome.downloads.erase(item.id).catch(() => {});
      await fetch(`${HUB}/dl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          name: item.filename || undefined,
          mime: item.mime || "",
          referrer: item.referrer === "about:blank" ? "" : item.referrer || "",
        }),
      });
    } catch (e) {
      /* bridge unreachable mid-flight — can't un-cancel, nothing else to do */
    }
  })();
});
