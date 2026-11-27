// `pnpm dev:s3:up` runs this once MinIO is healthy (issue #911): the local
// reports bucket gets production's 7-day expiry rule (infra/reports.tf;
// reports/storage.ts applyLocalReportsLifecycle), created first if MinIO
// lacks it. Safe to re-run: the rule replaces the bucket's lifecycle. Reads
// S3_ENDPOINT and REPORTS_BUCKET from backend/.env.development(.local), like
// the backend; refuses STORAGE=s3.
import { loadDevEnv } from '../src/config/devEnv.js';
import { applyLocalReportsLifecycle, REPORT_RETENTION_DAYS } from '../src/reports/storage.js';

loadDevEnv();
const { bucket } = await applyLocalReportsLifecycle();
console.log(`MinIO: ${bucket} expires reports/ after ${REPORT_RETENTION_DAYS} days`);
