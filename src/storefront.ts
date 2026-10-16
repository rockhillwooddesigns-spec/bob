/** Embedded stores keep their own navigation; billing must open outside the frame. */
export const embedded = window.self !== window.top;

export async function openBilling(request: () => Promise<{ url: string }>) {
  // Reserve the tab during the click, before awaiting the API (popup blockers).
  const tab = embedded ? window.open('about:blank', '_blank') : null;
  if (embedded && !tab) throw new Error('Allow pop-ups to open secure billing, or use Open full workspace.');
  if (tab) tab.opener = null;
  try {
    const { url } = await request();
    const destination = new URL(url);
    if (destination.protocol !== 'https:' && destination.origin !== location.origin) throw new Error('Invalid billing destination.');
    if (tab) tab.location.replace(destination.href);
    else location.assign(destination.href);
  } catch (error) { tab?.close(); throw error; }
}
