/** Large backgrounds belong in IndexedDB, outside localStorage's small string quota. */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("taskradar-appearance", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function imageStorage(action: "get" | "put" | "delete", key: string, image?: string): Promise<string | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("images", action === "get" ? "readonly" : "readwrite");
      const store = transaction.objectStore("images");
      const request = action === "get" ? store.get(key) : action === "put" ? store.put(image, key) : store.delete(key);
      transaction.oncomplete = () => resolve(action === "get" && typeof request.result === "string" ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
