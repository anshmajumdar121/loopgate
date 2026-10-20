import type { Batch, CreateBatchBody } from "@/types/batch";

/** Thrown for non-2xx responses; `message` is safe to show inline. */
export class BatchApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BatchApiError";
  }
}

interface ZodIssueLike {
  message?: unknown;
  path?: unknown;
}

/**
 * Normalise the backend's error shapes into one readable line. Handlers
 * return `{ error: string }`; the zod validator returns
 * `{ success: false, error: { issues: [...] } }`.
 */
export function errorMessageFrom(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err === "object" && "issues" in err) {
      const issues = (err as { issues: unknown }).issues;
      if (Array.isArray(issues) && issues.length > 0) {
        return issues
          .map((i: ZodIssueLike) => {
            const path = Array.isArray(i.path) && i.path.length ? `${i.path.join(".")}: ` : "";
            return `${path}${typeof i.message === "string" ? i.message : "invalid"}`;
          })
          .join("; ");
      }
    }
  }
  return `Server returned ${status}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty / non-JSON body */
  }
  if (!res.ok) throw new BatchApiError(errorMessageFrom(body, res.status), res.status);
  return body as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function fetchBatches(): Promise<Batch[]> {
  const data = await request<{ batches: Batch[] }>("/api/batches");
  return data.batches ?? [];
}

export async function createBatch(body: CreateBatchBody): Promise<Batch> {
  const data = await request<{ batch: Batch }>("/api/batches", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return data.batch;
}

export async function cancelBatch(id: string): Promise<Batch> {
  const data = await request<{ batch: Batch }>(`/api/batches/${id}/cancel`, { method: "POST" });
  return data.batch;
}

export async function resumeBatch(id: string): Promise<Batch> {
  const data = await request<{ batch: Batch }>(`/api/batches/${id}/resume`, { method: "POST" });
  return data.batch;
}
