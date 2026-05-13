export async function acquireLock(client, objectPath, accessMode = "MODIFY") {
  const res = await client.request({
    method: "POST",
    path: objectPath,
    query: { _action: "LOCK", accessMode },
    headers: { "X-sap-adt-sessiontype": "stateful" },
    accept: "application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result",
  });
  const body = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
    };
  }
  const handle = extractLockHandle(body);
  if (!handle) {
    return {
      ok: false,
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
      error: "no-lock-handle-in-response",
    };
  }
  return { ok: true, handle };
}

export async function releaseLock(client, objectPath, lockHandle) {
  return client.request({
    method: "POST",
    path: objectPath,
    query: { _action: "UNLOCK", lockHandle },
    headers: { "X-sap-adt-sessiontype": "stateful" },
  });
}

export function extractLockHandle(xml) {
  const m = xml.match(/<LOCK_HANDLE>([\s\S]*?)<\/LOCK_HANDLE>/i);
  return m ? m[1].trim() : null;
}
