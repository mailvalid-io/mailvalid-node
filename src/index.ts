export type VerificationStatus = "valid" | "invalid" | "catch_all" | "unknown" | "do_not_mail";

export interface MxRecord {
  priority: number;
  host: string;
}

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  is_valid: boolean;
  syntax_valid: boolean;
  domain: string;
  domain_valid: boolean;
  has_mx: boolean;
  mx_records: MxRecord[];
  smtp_checked: boolean;
  smtp_response_code: number | null;
  is_disposable: boolean;
  is_role_based: boolean;
  is_catch_all: boolean;
  is_free_provider: boolean;
  confidence_score: number;
  status_reason: string;
  provider: string | null;
  verification_time_ms: number;
  cached: boolean;
}

export interface VerifySingleResponse {
  success: boolean;
  credits_used: number;
  result: VerificationResult;
}

export interface BulkJobCreated {
  job_id: string;
  status: "pending";
  total_emails: number;
  credits_reserved: number;
  webhook_url: string | null;
}

export interface BulkJobStatus {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  total_emails: number;
  processed_emails: number;
  valid_count?: number;
  invalid_count?: number;
  credits_used?: number;
  results?: VerificationResult[];
}

export interface BulkJobListResponse {
  jobs: BulkJobStatus[];
  page: number;
  page_size: number;
}

export interface MailValidOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * The API returns `detail` as a plain string for most errors, but FastAPI's
 * request-validation errors (422) return an array of `{ loc, msg }` objects.
 * Flatten both into a readable string.
 */
function formatDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      if (typeof d === "string") return d;
      const loc = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== "body").join(".") : undefined;
      const msg = d?.msg ?? JSON.stringify(d);
      return loc ? `${loc}: ${msg}` : String(msg);
    });
    return parts.join("; ");
  }
  return JSON.stringify(detail);
}

export class MailValidError extends Error {
  constructor(message: string, public status?: number, public detail?: string) {
    super(message);
    this.name = "MailValidError";
  }
}

export class MailValid {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(options: MailValidOptions) {
    if (!options.apiKey) {
      throw new MailValidError("apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://mailvalid.io/api/v1";
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Verify a single email address. Costs 1 credit unless the result is cached or `unknown`. */
  async verify(email: string): Promise<VerifySingleResponse> {
    return this.request<VerifySingleResponse>("POST", "/verify/single", { email });
  }

  /** Submit up to 10,000 emails for bulk verification. Credits are reserved on submission. */
  async verifyBulk(emails: string[], webhookUrl?: string): Promise<BulkJobCreated> {
    return this.request<BulkJobCreated>("POST", "/verify/bulk", {
      emails,
      webhook_url: webhookUrl,
    });
  }

  /** Check the status of a bulk job. `results` is only populated once `status` is `completed`. */
  async getBulkJob(jobId: string): Promise<BulkJobStatus> {
    return this.request<BulkJobStatus>("GET", `/verify/bulk/${jobId}`);
  }

  /** Get a signed download URL / raw file for a completed bulk job's results. */
  async downloadBulkResults(jobId: string, format: "csv" | "json" = "csv"): Promise<string> {
    return this.request<string>("GET", `/verify/bulk/${jobId}/download?format=${format}`, undefined, true);
  }

  async cancelBulkJob(jobId: string): Promise<void> {
    await this.request<void>("DELETE", `/verify/bulk/${jobId}`);
  }

  async listBulkJobs(params?: { page?: number; pageSize?: number; status?: string }): Promise<BulkJobListResponse> {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", String(params.page));
    if (params?.pageSize) q.set("page_size", String(params.pageSize));
    if (params?.status) q.set("status", params.status);
    const qs = q.toString();
    return this.request<BulkJobListResponse>("GET", `/verify/bulk${qs ? `?${qs}` : ""}`);
  }

  /** Poll a bulk job until it reaches a terminal state (`completed`, `failed`, or `cancelled`). */
  async waitForBulkJob(jobId: string, opts?: { pollIntervalMs?: number; maxWaitMs?: number }): Promise<BulkJobStatus> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 2000;
    const maxWaitMs = opts?.maxWaitMs ?? 120_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const job = await this.getBulkJob(jobId);
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new MailValidError(`Bulk job ${jobId} did not reach a terminal state within ${maxWaitMs}ms`);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    raw = false
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const errBody = await res.json();
          detail = formatDetail(errBody?.detail) ?? detail;
        } catch {
          // response wasn't JSON, keep statusText
        }
        throw new MailValidError(`MailValid API error (${res.status}): ${detail}`, res.status, detail);
      }

      if (raw) {
        return (await res.text()) as unknown as T;
      }
      if (res.status === 204) {
        return undefined as unknown as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof MailValidError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new MailValidError(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw new MailValidError(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default MailValid;
