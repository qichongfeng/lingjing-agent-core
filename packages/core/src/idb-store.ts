// IndexedDB-backed MemoryStore for browser hosts (conversation persistence
// across tabs/reloads). Zero dependencies — raw IndexedDB, the same
// runtime-conditional pattern as fetchTransport: importing this module is safe
// everywhere; CONSTRUCTING it requires a global `indexedDB` (browsers,
// Electron/Tauri webviews). Mini-programs have no IndexedDB — hosts there
// bridge their own storage behind the MemoryStore interface instead.

import type { MemoryStore } from "./memory.js";
import type { Message } from "./types.js";

export interface IDBStoreOptions {
  /** Database name. Default "lingjing-agent". Share it to share storage. */
  dbName?: string;
  /** Object store name. Default "conversations". */
  storeName?: string;
}

/**
 * Persistent MemoryStore over IndexedDB: one record per conversation, value is
 * the Message[] (structured-clone of plain JSON shapes — no serialization
 * step needed). Wire into `createAgent({ memory: new IDBStore() })` and
 * conversations survive reloads and are shared across tabs.
 *
 * Concurrency: `append` is read-modify-write. The agent loop runs one run per
 * conversation at a time, so this is safe for normal use; do not append to the
 * SAME conversation from two agents concurrently.
 */
export class IDBStore implements MemoryStore {
  private readonly storeName: string;
  private readonly db: Promise<IDBDatabase>;

  constructor(opts: IDBStoreOptions = {}) {
    if (typeof indexedDB === "undefined") {
      throw new Error(
        "IDBStore requires a global indexedDB (browser/Electron/Tauri webview). " +
          "In Node use InMemoryStore; in mini-programs bridge wx storage behind MemoryStore.",
      );
    }
    this.storeName = opts.storeName ?? "conversations";
    this.db = openDB(opts.dbName ?? "lingjing-agent", this.storeName);
  }

  async load(conversationId: string): Promise<Message[]> {
    const db = await this.db;
    const value = await request<Message[] | undefined>(db, this.storeName, "readonly", (s) => s.get(conversationId));
    return value ?? [];
  }

  async append(conversationId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const db = await this.db;
    const existing = await request<Message[] | undefined>(db, this.storeName, "readonly", (s) => s.get(conversationId));
    await request<IDBValidKey>(db, this.storeName, "readwrite", (s) =>
      s.put([...(existing ?? []), ...messages], conversationId),
    );
  }

  /** Drop a conversation's history (not part of MemoryStore — UI convenience). */
  async delete(conversationId: string): Promise<void> {
    const db = await this.db;
    await request<undefined>(db, this.storeName, "readwrite", (s) => s.delete(conversationId));
  }

  /** All stored conversation ids — satisfies `MemoryStore.list`, so a recall
   *  backend (createRecallStore) can discover its corpus; also a UI convenience. */
  async list(): Promise<string[]> {
    const db = await this.db;
    const keys = await request<IDBValidKey[]>(db, this.storeName, "readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }

  /** Close the underlying connection (deliberate, e.g. on page unload). */
  async close(): Promise<void> {
    (await this.db).close();
  }
}

/** Open (or create at version 1) the database and its single object store. */
function openDB(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(storeName)) {
        req.result.createObjectStore(storeName);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`indexedDB.open(${dbName}) failed`));
    req.onblocked = () => reject(new Error(`indexedDB.open(${dbName}) blocked — close other tabs holding an older version`));
  });
}

/** Run one request in its own transaction and settle on the request result. */
function request<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = run(tx.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`IDB ${mode} request failed`));
  });
}
