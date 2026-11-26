// What the storage module sends to S3 (MinIO locally), with the client
// stubbed: an evidence pack's PDF goes to its own bucket under its derived
// key, carrying its SHA-256 (119_pack_render; the real round trip through
// MinIO is the pack e2e's). No network.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent, failHead, objects } = vi.hoisted(() => ({ sent: [] as { name: string; input: Record<string, unknown> }[], failHead: { on: false }, objects: new Map<string, string | undefined>() }));
vi.mock('@aws-sdk/client-s3', async (orig) => {
	const sdk = await orig<typeof import('@aws-sdk/client-s3')>();
	class S3Client {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			sent.push({ name: command.constructor.name, input: command.input });
			if (command.constructor.name === 'HeadBucketCommand' && failHead.on) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
			if (command.constructor.name === 'HeadObjectCommand') {
				if (!objects.has(command.input.Key as string)) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
				return { ChecksumSHA256: objects.get(command.input.Key as string) };
			}
			return {};
		}
	}
	return { ...sdk, S3Client };
});

const { headPackPdf, packPdfKey, putPackPdf, putPdf, resetStorageClient } = await import('./storage.js');

const P = '11111111-1111-4111-8111-111111111111';
const K = '33333333-3333-4333-8333-333333333333';
const pdf = Buffer.from('%PDF-1.7 an issued pack');
const sha = createHash('sha256').update(pdf).digest('hex');

beforeEach(() => {
	sent.length = 0;
	failHead.on = false;
	objects.clear();
	resetStorageClient();
});
afterEach(() => vi.unstubAllEnvs());

describe('putPackPdf', () => {
	it('puts the PDF into the packs bucket under its key, with its SHA-256 for S3 to check (production)', async () => {
		vi.stubEnv('STORAGE', 's3');
		vi.stubEnv('PACKS_BUCKET', 'water-management-packs-000000000000');
		vi.stubEnv('REPORTS_BUCKET', 'water-management-reports-000000000000');
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		expect(sent).toEqual([
			{
				name: 'PutObjectCommand',
				input: {
					Bucket: 'water-management-packs-000000000000',
					Key: `packs/${P}/${K}/${sha}.pdf`,
					Body: pdf,
					ContentType: 'application/pdf',
					// x-amz-checksum-sha256 is the base64 of the digest's bytes.
					ChecksumSHA256: createHash('sha256').update(pdf).digest('base64')
				}
			}
		]);
	});

	it('refuses a hash that is not a lowercase hex SHA-256 before any request', async () => {
		vi.stubEnv('STORAGE', 's3');
		await expect(putPackPdf(packPdfKey(P, K, sha), pdf, sha.toUpperCase())).rejects.toThrow('SHA-256');
		await expect(putPackPdf(packPdfKey(P, K, sha), pdf, 'x')).rejects.toThrow('SHA-256');
		expect(sent).toEqual([]);
	});

	it('locally, creates the packs bucket once in MinIO, apart from the reports bucket', async () => {
		vi.stubEnv('STORAGE', 'local');
		vi.stubEnv('PACKS_BUCKET', '');
		vi.stubEnv('REPORTS_BUCKET', '');
		failHead.on = true;
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		await putPdf(`reports/${P}/${K}.pdf`, pdf);
		expect(sent.map((c) => `${c.name} ${c.input.Bucket}`)).toEqual([
			'HeadBucketCommand water-packs',
			'CreateBucketCommand water-packs',
			'PutObjectCommand water-packs',
			'PutObjectCommand water-packs',
			'HeadBucketCommand water-reports',
			'CreateBucketCommand water-reports',
			'PutObjectCommand water-reports'
		]);
	});
});

describe('headPackPdf', () => {
	it('is ok only for an object under the key whose stored checksum is that hash; says missing or mismatch otherwise', async () => {
		vi.stubEnv('STORAGE', 's3');
		vi.stubEnv('PACKS_BUCKET', 'water-management-packs-000000000000');
		const key = packPdfKey(P, K, sha);
		expect(await headPackPdf(key, sha)).toEqual({ ok: false, reason: 'missing' });
		objects.set(key, createHash('sha256').update('other bytes').digest('base64'));
		expect(await headPackPdf(key, sha)).toMatchObject({ ok: false, reason: 'mismatch' });
		objects.set(key, undefined);
		expect(await headPackPdf(key, sha)).toEqual({ ok: false, reason: 'mismatch', stored: null });
		objects.set(key, createHash('sha256').update(pdf).digest('base64'));
		expect(await headPackPdf(key, sha)).toEqual({ ok: true });
		// Asked with checksum mode on, of the packs bucket.
		expect(sent.at(-1)).toEqual({ name: 'HeadObjectCommand', input: { Bucket: 'water-management-packs-000000000000', Key: key, ChecksumMode: 'ENABLED' } });
		await expect(headPackPdf(key, 'x')).rejects.toThrow('SHA-256');
	});
});

describe('applyLocalReportsLifecycle (pnpm dev:s3:up, issue #911)', () => {
	it("creates the local reports bucket if missing and puts production's 7-day expiry on reports/, the same on every run", async () => {
		failHead.on = true;
		const { applyLocalReportsLifecycle, REPORT_RETENTION_DAYS } = await import('./storage.js');
		expect(await applyLocalReportsLifecycle()).toEqual({ bucket: 'water-reports' });
		const rule = { ID: 'expire-reports', Status: 'Enabled', Filter: { Prefix: 'reports/' }, Expiration: { Days: 7 } };
		expect(REPORT_RETENTION_DAYS).toBe(7);
		expect(sent).toEqual([
			{ name: 'HeadBucketCommand', input: { Bucket: 'water-reports' } },
			{ name: 'CreateBucketCommand', input: { Bucket: 'water-reports' } },
			{ name: 'PutBucketLifecycleConfigurationCommand', input: { Bucket: 'water-reports', LifecycleConfiguration: { Rules: [rule] } } }
		]);
		// Again (a second dev:s3:up): the same whole configuration, nothing added.
		sent.length = 0;
		failHead.on = false;
		resetStorageClient();
		await applyLocalReportsLifecycle();
		expect(sent.map((c) => c.name)).toEqual(['HeadBucketCommand', 'PutBucketLifecycleConfigurationCommand']);
		expect(sent[1]!.input).toEqual({ Bucket: 'water-reports', LifecycleConfiguration: { Rules: [rule] } });
	});

	it("matches production's rule in infra/reports.tf (id, prefix, days)", async () => {
		const { readFileSync } = await import('node:fs');
		const tf = readFileSync(new URL('../../../infra/reports.tf', import.meta.url), 'utf8');
		const block = tf.slice(tf.indexOf('resource "aws_s3_bucket_lifecycle_configuration" "reports"'));
		expect(block).toMatch(/id\s*=\s*"expire-reports"/);
		expect(block).toMatch(/prefix\s*=\s*"reports\/"/);
		expect(block).toMatch(/days\s*=\s*local\.report_retention_days/);
		expect(tf).toMatch(/report_retention_days\s*=\s*7\b/);
	});

	it('refuses STORAGE=s3: production\'s bucket and rule are Terraform\'s', async () => {
		vi.stubEnv('STORAGE', 's3');
		const { applyLocalReportsLifecycle } = await import('./storage.js');
		await expect(applyLocalReportsLifecycle()).rejects.toThrow('Terraform');
		expect(sent).toEqual([]);
	});
});
