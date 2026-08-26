# mailvalid

Official Node.js / TypeScript client for the [MailValid](https://mailvalid.io) email verification API.

Matches the spec at [mailvalid.io/docs](https://mailvalid.io/docs).

```bash
npm install mailvalid
```

## Usage

```ts
import { MailValid } from "mailvalid";

const client = new MailValid({ apiKey: process.env.MAILVALID_API_KEY! }); // mv_live_...

const { result } = await client.verify("someone@example.com");
if (!result.is_valid || result.is_disposable) {
  throw new Error("Please use a valid work email address.");
}
```

### Bulk verification

```ts
const job = await client.verifyBulk(["a@example.com", "b@example.com"]);
const finished = await client.waitForBulkJob(job.job_id);

console.log(finished.valid_count, finished.invalid_count);
console.log(finished.results);
```

Bulk jobs accept up to 10,000 emails per submission (fewer on lower-tier plans — see rate limits in the docs) and reserve credits on submission; unused credits are released once processing completes.

### Webhooks instead of polling

Pass `webhookUrl` to `verifyBulk` and MailValid will POST a `job.completed` / `job.failed` / `job.cancelled` event to that URL instead of you polling. Verify the `X-Mailvalid-Signature` header (HMAC-SHA256 of the raw body) before trusting the payload — signature verification isn't included in this client, since it depends on your server framework.

## API

### `new MailValid({ apiKey, baseUrl?, timeoutMs? })`

- `apiKey` — required, format `mv_live_...`, from your [MailValid dashboard](https://mailvalid.io/signup)
- `baseUrl` — defaults to `https://mailvalid.io/api/v1`
- `timeoutMs` — defaults to `5000`. Always wrap calls in a try/catch and fail open in a signup/checkout flow — never let a verification timeout block your own users.

### `client.verify(email): Promise<VerifySingleResponse>`
`POST /verify/single`

### `client.verifyBulk(emails, webhookUrl?): Promise<BulkJobCreated>`
`POST /verify/bulk`

### `client.getBulkJob(jobId): Promise<BulkJobStatus>`
`GET /verify/bulk/{job_id}`

### `client.waitForBulkJob(jobId, opts?): Promise<BulkJobStatus>`
Polls `getBulkJob` until the job reaches `completed`, `failed`, or `cancelled`.

### `client.downloadBulkResults(jobId, format?): Promise<string>`
`GET /verify/bulk/{job_id}/download?format=csv|json`

### `client.cancelBulkJob(jobId): Promise<void>`
`DELETE /verify/bulk/{job_id}`

### `client.listBulkJobs(params?): Promise<BulkJobListResponse>`
`GET /verify/bulk`

## Errors

All non-2xx responses throw `MailValidError` with `.status` (HTTP code) and `.detail` (the API's `detail` message). Notable codes: `401` bad/missing API key, `402` insufficient credits, `429` rate limited (check `Retry-After`).

## License

MIT
