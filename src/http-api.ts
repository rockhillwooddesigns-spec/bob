export async function api<T>(path: string, token: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The account service is unavailable. Please retry later.'); }
  if (!response.ok) throw new Error(data.error || 'Could not complete this account request.');
  return data as T;
}
