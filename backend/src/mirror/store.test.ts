import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import * as zarr from 'zarrita';
import { GZIP_MAX_DECODED_BYTES, gzipDecodedLimit, MirrorUrlError, NodeGzip, openStore, registerNodeGzip, S3Store } from './store.js';

/** An in-memory S3: GetObject answers NoSuchKey for a missing key, as S3 does. */
function fakeS3() {
	const objects = new Map<string, Uint8Array>();
	const sent: string[] = [];
	return {
		objects,
		sent,
		async send(cmd: unknown) {
			if (cmd instanceof PutObjectCommand) {
				sent.push(`put ${cmd.input.Bucket}/${cmd.input.Key}`);
				objects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, cmd.input.Body as Uint8Array);
				return {};
			}
			if (cmd instanceof DeleteObjectCommand) {
				sent.push(`delete ${cmd.input.Bucket}/${cmd.input.Key}`);
				objects.delete(`${cmd.input.Bucket}/${cmd.input.Key}`);
				return {};
			}
			if (cmd instanceof GetObjectCommand) {
				sent.push(`get ${cmd.input.Bucket}/${cmd.input.Key}`);
				const v = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
				if (!v) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
				return { Body: { transformToByteArray: async () => v } };
			}
			throw new Error('unexpected command');
		}
	};
}

describe('openStore (MIRROR_URL)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mirror-store-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('opens a local directory from file:///abs/path, missing keys as undefined', async () => {
		const store = openStore(pathToFileURL(dir).href);
		expect(await store.get('/rnl/zarr.json')).toBeUndefined();
		await store.set('/rnl/zarr.json', new Uint8Array([1, 2, 3]));
		expect(Array.from((await store.get('/rnl/zarr.json'))!)).toEqual([1, 2, 3]);
	});

	it('opens s3://bucket[/prefix] as an S3Store', () => {
		const s = openStore('s3://wm-prod-mirror/env/a', { s3: fakeS3() });
		expect(s).toBeInstanceOf(S3Store);
		expect((s as S3Store).bucket).toBe('wm-prod-mirror');
		expect((s as S3Store).key('/rnl/zarr.json')).toBe('env/a/rnl/zarr.json');
		expect((openStore('s3://wm-prod-mirror', { s3: fakeS3() }) as S3Store).key('/rnl/zarr.json')).toBe('rnl/zarr.json');
	});

	it('refuses any other URL', () => {
		for (const url of ['', 'http://example.com/m', 's3://', 's3://UPPER', 'file://relative/path', '/abs/path']) {
			expect(() => openStore(url), url).toThrow(MirrorUrlError);
		}
	});
});

describe('S3Store', () => {
	it('gets what it set, under its prefix, and a missing key as undefined', async () => {
		const s3 = fakeS3();
		const store = new S3Store('b-mirror', 'p', s3);
		expect(await store.get('/rnl/c/0/0/0/0')).toBeUndefined();
		await store.set('/rnl/c/0/0/0/0', new Uint8Array([9]));
		expect(await store.get('/rnl/c/0/0/0/0')).toEqual(new Uint8Array([9]));
		expect(s3.sent).toEqual(['get b-mirror/p/rnl/c/0/0/0/0', 'put b-mirror/p/rnl/c/0/0/0/0', 'get b-mirror/p/rnl/c/0/0/0/0']);
	});

	it('deletes under its prefix, after which the key reads as missing', async () => {
		const s3 = fakeS3();
		const store = new S3Store('b-mirror', 'p', s3);
		await store.set('/prelim/c/5/0/0', new Uint8Array([1]));
		await store.delete('/prelim/c/5/0/0');
		expect(await store.get('/prelim/c/5/0/0')).toBeUndefined();
		expect(s3.sent).toContain('delete b-mirror/p/prelim/c/5/0/0');
	});

	it('throws any failure other than a missing key (never reads it as all-NaN)', async () => {
		const store = new S3Store('b-mirror', '', {
			send: async () => {
				throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
			}
		});
		await expect(store.get('/rnl/zarr.json')).rejects.toThrow('denied');
	});
});

describe('NodeGzip', () => {
	it('round-trips bytes through node:zlib gzip', () => {
		const codec = NodeGzip.fromConfig({ level: 6 });
		const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
		const packed = codec.encode(bytes);
		expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
		expect(codec.decode(packed)).toEqual(bytes);
	});

	it('bounds a decode by the chunk zarrita describes: a gzip bomb fails the read (no unbounded inflate)', () => {
		// A day of the D1 grid's chunk: 1 × 55 × 62 float32.
		const codec = NodeGzip.fromConfig({ level: 6 }, { shape: [1, 55, 62], dataType: 'float32' });
		const chunk = new Uint8Array(55 * 62 * 4).fill(7);
		expect(codec.decode(codec.encode(chunk))).toEqual(chunk);
		// 4 MB of zeros packs to ~4 KB: far past what that chunk can hold.
		const bomb = new Uint8Array(gzipSync(new Uint8Array(4 * 1024 * 1024)));
		expect(bomb.length).toBeLessThan(10_000);
		expect(() => codec.decode(bomb)).toThrow(/inflates past the 14664 bytes/);
	});

	it('limits by shape and type, with a fixed ceiling for anything unknown or huge', () => {
		expect(gzipDecodedLimit({ shape: [1, 55, 62], dataType: 'float32' })).toBe(55 * 62 * 4 + 1024);
		expect(gzipDecodedLimit({ shape: [2, 3], dataType: 'float64' })).toBe(48 + 1024);
		expect(gzipDecodedLimit({ shape: [100_000, 100_000], dataType: 'float32' })).toBe(GZIP_MAX_DECODED_BYTES);
		expect(gzipDecodedLimit({ shape: [10], dataType: 'string' })).toBe(GZIP_MAX_DECODED_BYTES);
		expect(gzipDecodedLimit(undefined)).toBe(GZIP_MAX_DECODED_BYTES);
		expect(gzipDecodedLimit({ shape: [-1], dataType: 'float32' })).toBe(GZIP_MAX_DECODED_BYTES);
	});

	it('is the codec zarrita reads a mirror array through: a bomb chunk on disk fails getChunk', async () => {
		registerNodeGzip();
		const store = new Map<string, Uint8Array>();
		const s = { get: async (k: string) => store.get(k), set: async (k: string, v: Uint8Array) => void store.set(k, v) };
		const arr = await zarr.create(zarr.root(s as never).resolve('rain'), {
			shape: [2, 4],
			chunkShape: [1, 4],
			dtype: 'float32',
			codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'gzip', configuration: { level: 6 } }]
		});
		// A good chunk as the writers store it: little-endian float32, gzipped (positive control).
		store.set('/rain/c/0/0', new Uint8Array(gzipSync(new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer))));
		expect(Array.from((await arr.getChunk([0, 0])).data as Float32Array)).toEqual([1, 2, 3, 4]);
		store.set('/rain/c/1/0', new Uint8Array(gzipSync(new Uint8Array(1024 * 1024))));
		// zarrita wraps a codec's failure; ours is its cause.
		const err = await arr.getChunk([1, 0]).then(
			() => null,
			(e: unknown) => e as { cause?: unknown }
		);
		expect(err).not.toBeNull();
		expect(String((err!.cause as Error | undefined)?.message)).toMatch(/inflates past the 1040 bytes/);
	});
});

