// What the storage module sends to S3 (MinIO locally), with the client
// stubbed: an evidence pack's PDF goes to its own bucket under its derived
// key, carrying its SHA-256 (119_pack_render; the real round trip through
// MinIO is the pack e2e's). No network.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent, failHead, objects, respond } = vi.hoisted(() => ({
	sent: [] as { name: string; input: Record<string, unknown> }[],
	failHead: { on: false },
	objects: new Map<string, string | undefined>(),
	/** A test's own answer to a command, by its class name (else the defaults below). */
	respond: new Map<string, (input: Record<string, unknown>) => unknown>()
}));
vi.mock('@aws-sdk/client-s3', async (orig) => {
	const sdk = await orig<typeof import('@aws-sdk/client-s3')>();
	class S3Client {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			sent.push({ name: command.constructor.name, input: command.input });
			const own = respond.get(command.constructor.name);
			if (own) return own(command.input);
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

const { getPackBundle, headPackPdf, packBundleKey, packPdfKey, putPackBundle, putPackPdf, putPdf, resetStorageClient } = await import('./storage.js');

const P = '11111111-1111-4111-8111-111111111111';
const K = '33333333-3333-4333-8333-333333333333';
const pdf = Buffer.from('%PDF-1.7 an issued pack');
const sha = createHash('sha256').update(pdf).digest('hex');

beforeEach(() => {
	sent.length = 0;
	failHead.on = false;
	objects.clear();
	respond.clear();
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

describe('a local bucket that could not be made', () => {
	it('is asked for again on the next put, not remembered as ready', async () => {
		vi.stubEnv('STORAGE', 'local');
		vi.stubEnv('REPORTS_BUCKET', '');
		failHead.on = true;
		respond.set('CreateBucketCommand', () => {
			throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' });
		});
		await expect(putPdf(`reports/${P}/${K}.pdf`, pdf)).rejects.toThrow('ECONNREFUSED');
		// MinIO is up now: the next put makes the bucket, then puts.
		respond.delete('CreateBucketCommand');
		await putPdf(`reports/${P}/${K}.pdf`, pdf);
		expect(sent.map((c) => c.name)).toEqual(['HeadBucketCommand', 'CreateBucketCommand', 'HeadBucketCommand', 'CreateBucketCommand', 'PutObjectCommand']);
	});

	it('takes a bucket another process just made (BucketAlreadyOwnedByYou) as ready', async () => {
		vi.stubEnv('STORAGE', 'local');
		vi.stubEnv('REPORTS_BUCKET', '');
		failHead.on = true;
		respond.set('CreateBucketCommand', () => {
			throw Object.assign(new Error('owned'), { name: 'BucketAlreadyOwnedByYou' });
		});
		await putPdf(`reports/${P}/${K}.pdf`, pdf);
		expect(sent.map((c) => c.name)).toEqual(['HeadBucketCommand', 'CreateBucketCommand', 'PutObjectCommand']);
	});
});

describe('putPackBundle (122_pack_bundle)', () => {
	const zip = Buffer.from('PK a reproduction bundle');
	const zsha = createHash('sha256').update(zip).digest('hex');
	const z64 = createHash('sha256').update(zip).digest('base64');

	it('puts once, never over an existing key, with its SHA-256, and accepts the checksum the store answers', async () => {
		vi.stubEnv('STORAGE', 's3');
		vi.stubEnv('PACKS_BUCKET', 'water-management-packs-000000000000');
		respond.set('PutObjectCommand', () => ({ ChecksumSHA256: z64 }));
		await putPackBundle(packBundleKey(P, K, zsha), zip, zsha);
		expect(sent).toEqual([
			{
				name: 'PutObjectCommand',
				input: {
					Bucket: 'water-management-packs-000000000000',
					Key: `packs/${P}/${K}/${zsha}.zip`,
					Body: zip,
					ContentType: 'application/zip',
					ChecksumSHA256: z64,
					IfNoneMatch: '*'
				}
			}
		]);
	});

	it('takes a 412 (the key, named by these bytes’ hash, is taken already) as stored', async () => {
		vi.stubEnv('STORAGE', 's3');
		respond.set('PutObjectCommand', () => {
			throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
		});
		await expect(putPackBundle(packBundleKey(P, K, zsha), zip, zsha)).resolves.toBeUndefined();
	});

	it('refuses a store that answers another checksum or none, and passes any other failure on', async () => {
		vi.stubEnv('STORAGE', 's3');
		respond.set('PutObjectCommand', () => ({ ChecksumSHA256: createHash('sha256').update('other').digest('base64') }));
		await expect(putPackBundle(packBundleKey(P, K, zsha), zip, zsha)).rejects.toThrow('not recorded');
		respond.set('PutObjectCommand', () => ({}));
		await expect(putPackBundle(packBundleKey(P, K, zsha), zip, zsha)).rejects.toThrow('(none)');
		respond.set('PutObjectCommand', () => {
			throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
		});
		await expect(putPackBundle(packBundleKey(P, K, zsha), zip, zsha)).rejects.toThrow('Access Denied');
	});

	it('refuses a hash that is not a lowercase hex SHA-256 before any request', async () => {
		vi.stubEnv('STORAGE', 's3');
		await expect(putPackBundle(packBundleKey(P, K, zsha), zip, zsha.toUpperCase())).rejects.toThrow('SHA-256');
		expect(sent).toEqual([]);
	});
});

describe('getPackBundle (154_pack_reproduce)', () => {
	const key = packBundleKey(P, K, sha);
	/** A GetObject answer: the bytes, a declared length, and whether its stream was cancelled. */
	const body = (bytes: Uint8Array, contentLength?: number) => {
		const state = { read: false, cancelled: false };
		const res = {
			ContentLength: contentLength,
			Body: {
				transformToByteArray: async () => ((state.read = true), bytes),
				transformToWebStream: () => ({ cancel: async () => void (state.cancelled = true) })
			}
		};
		return { res, state };
	};

	it('reads the bundle with checksum mode on, from the packs bucket', async () => {
		vi.stubEnv('STORAGE', 's3');
		vi.stubEnv('PACKS_BUCKET', 'water-management-packs-000000000000');
		const b = body(new Uint8Array([1, 2, 3]), 3);
		respond.set('GetObjectCommand', () => b.res);
		expect(Array.from((await getPackBundle(key, 10))!)).toEqual([1, 2, 3]);
		expect(sent).toEqual([{ name: 'GetObjectCommand', input: { Bucket: 'water-management-packs-000000000000', Key: key, ChecksumMode: 'ENABLED' } }]);
	});

	it('is null for a missing object, and passes any other failure on', async () => {
		vi.stubEnv('STORAGE', 's3');
		respond.set('GetObjectCommand', () => {
			throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
		});
		expect(await getPackBundle(key, 10)).toBeNull();
		respond.set('GetObjectCommand', () => {
			throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
		});
		await expect(getPackBundle(key, 10)).rejects.toThrow('Access Denied');
	});

	it('refuses an object declared larger than maxBytes before reading its body, and cancels the stream', async () => {
		vi.stubEnv('STORAGE', 's3');
		const b = body(new Uint8Array(11), 11);
		respond.set('GetObjectCommand', () => b.res);
		await expect(getPackBundle(key, 10)).rejects.toThrow('is 11 bytes, more than a bundle holds (10)');
		expect(b.state).toEqual({ read: false, cancelled: true });
	});

	it('refuses a body longer than maxBytes when the length was not declared, and a missing body', async () => {
		vi.stubEnv('STORAGE', 's3');
		const b = body(new Uint8Array(11));
		respond.set('GetObjectCommand', () => b.res);
		await expect(getPackBundle(key, 10)).rejects.toThrow('more than a bundle holds (10 bytes)');
		respond.set('GetObjectCommand', () => ({ ContentLength: 0 }));
		await expect(getPackBundle(key, 10)).rejects.toThrow('has no body');
	});
});
