import { Injectable } from '@angular/core';
import { TelemetryResult } from '../models/telemetry.model';

// The Vault stores the heavy telemetry arrays (GPS, ACCL, GRAV) that are too
// large to send to PostgreSQL. Key: "<filename>__<fileSize>" — mirrors the
// composite identity rule used by the backend (filename + fileSize).

const DB_NAME    = 'telemetry-vault';
const STORE_NAME = 'clips';
const DB_VERSION = 1;

export type VaultEntry = Pick<TelemetryResult, 'gps' | 'accl' | 'grav'>;

@Injectable({ providedIn: 'root' })
export class TelemetryVaultService {
  private db: IDBDatabase | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = ({ target }) => {
        (target as IDBOpenDBRequest).result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = ({ target }) => {
        this.db = (target as IDBOpenDBRequest).result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Persists the three heavy arrays for a clip. Must complete before the
  // Library POST fires — see Write-Through Cache Flow in skill.md.
  async save(filename: string, fileSize: number, result: TelemetryResult): Promise<void> {
    const db  = await this.openDb();
    const key = vaultKey(filename, fileSize);
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(
        { gps: result.gps, accl: result.accl, grav: result.grav } satisfies VaultEntry,
        key,
      );
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  // Returns null when the Vault has no entry for this clip (cache miss — run WASM).
  // A 200 from GET /api/clips/lookup does NOT guarantee a Vault entry exists;
  // the user may have cleared IndexedDB since the last parse.
  async load(filename: string, fileSize: number): Promise<VaultEntry | null> {
    const db  = await this.openDb();
    const key = vaultKey(filename, fileSize);
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as VaultEntry | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  }
}

function vaultKey(filename: string, fileSize: number): string {
  return `${filename}__${fileSize}`;
}
