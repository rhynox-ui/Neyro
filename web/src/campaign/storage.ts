import type { Campaign } from "./model";
import type { RegistrationSession } from "../execution/registration";

const DB_NAME = "neyro-web-terminal";
const DB_VERSION = 2;
const STORE_NAME = "campaigns";
const REGISTRATION_STORE_NAME = "registrations";

export interface RegistrationStore {
  getRegistration(id: string): Promise<RegistrationSession | null>;
  putRegistration(session: RegistrationSession): Promise<void>;
  deleteRegistration(id: string): Promise<void>;
  listRegistrations(): Promise<RegistrationSession[]>;
}

export interface CampaignStore {
  get(id: string): Promise<Campaign | null>;
  put(campaign: Campaign): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Campaign[]>;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error ?? new Error("Could not open campaign database"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(REGISTRATION_STORE_NAME)) {
        database.createObjectStore(REGISTRATION_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

export class IndexedDbCampaignStore implements CampaignStore, RegistrationStore {
  async get(id: string): Promise<Campaign | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const result = await requestResult<Campaign | undefined>(
        transaction.objectStore(STORE_NAME).get(id)
      );
      return result ?? null;
    } finally {
      database.close();
    }
  }

  async put(campaign: Campaign): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      await requestResult(transaction.objectStore(STORE_NAME).put(campaign));
    } finally {
      database.close();
    }
  }

  async getRegistration(id: string): Promise<RegistrationSession | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(REGISTRATION_STORE_NAME, "readonly");
      const result = await requestResult<RegistrationSession | undefined>(
        transaction.objectStore(REGISTRATION_STORE_NAME).get(id)
      );
      return result ?? null;
    } finally {
      database.close();
    }
  }

  async putRegistration(session: RegistrationSession): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(REGISTRATION_STORE_NAME, "readwrite");
      await requestResult(transaction.objectStore(REGISTRATION_STORE_NAME).put(session));
    } finally {
      database.close();
    }
  }

  async deleteRegistration(id: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(REGISTRATION_STORE_NAME, "readwrite");
      await requestResult(transaction.objectStore(REGISTRATION_STORE_NAME).delete(id));
    } finally {
      database.close();
    }
  }

  async listRegistrations(): Promise<RegistrationSession[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(REGISTRATION_STORE_NAME, "readonly");
      return await requestResult<RegistrationSession[]>(
        transaction.objectStore(REGISTRATION_STORE_NAME).getAll()
      );
    } finally {
      database.close();
    }
  }

  async delete(id: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      await requestResult(transaction.objectStore(STORE_NAME).delete(id));
    } finally {
      database.close();
    }
  }

  async list(): Promise<Campaign[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      return await requestResult<Campaign[]>(transaction.objectStore(STORE_NAME).getAll());
    } finally {
      database.close();
    }
  }
}

/**
 * Creates a deterministic campaign id from a stable source fingerprint.
 * The caller should include token, sender set and recipient data in the
 * fingerprint before calling this function.
 */
export async function campaignIdFromFingerprint(fingerprint: string): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprint);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
