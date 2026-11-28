// Where the mirror lives (MIRROR_URL): a local directory (`file:///abs/path`)
// in dev, CI and e2e, the private versioned bucket (`s3://bucket[/prefix]`) in
// production. Either way a zarrita store: get(key) → bytes or undefined, and
// set(key, bytes) for the writers.
//
// The S3 store goes through @aws-sdk/client-s3 (already a backend dependency,
// imported lazily so a bundle that never opens an s3:// mirror never loads
// it); no other S3 library.
import { gunzipSync, gzipSync } from 'node:zlib';
import FileSystemStore from '@zarrita/storage/fs';
import type { AbsolutePath, AsyncMutable } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { FeedFormatError } from '../feeds/errors.js';
import { parseMirrorUrl } from './url.js';

/** A mirror store: what zarrita reads and writes through. */
export type MirrorStore = AsyncMutable;

/** The subset of S3Client the store sends through (an injected client in tests). */
export interface S3Sender {
	send(command: unknown): Promise<unknown>;
}

/**
 * The bucket as a zarrita store. A missing key (NoSuchKey, 404) is undefined:
 * an unwritten chunk is all fill (NaN), and a missing manifest or zarr.json is
 * a product not in the copy yet. Every other failure throws.
 */
export class S3Store implements AsyncMutable {
	readonly bucket: string;
	readonly prefix: string;
	#client: Promise<{ s3: S3Sender; sdk: typeof import('@aws-sdk/client-s3') }>;

	constructor(bucket: string, prefix = '', client?: S3Sender) {
		this.bucket = bucket;
		this.prefix = prefix.replace(/^\/+|\/+$/g, '');
		this.#client = import('@aws-sdk/client-s3').then((sdk) => ({ s3: client ?? new sdk.S3Client({}), sdk }));
	}

	key(path: AbsolutePath): string {
		const rel = path.replace(/^\/+/, '');
		return this.prefix ? `${this.prefix}/${rel}` : rel;
	}

	async get(path: AbsolutePath): Promise<Uint8Array | undefined> {
		const { s3, sdk } = await this.#client;
		try {
			const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.key(path) }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
			return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
		} catch (err) {
			const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
			if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return undefined;
			throw err;
		}
	}

	async set(path: AbsolutePath, value: Uint8Array): Promise<void> {
		const { s3, sdk } = await this.#client;
		await s3.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.key(path), Body: value }));
	}

	/** Remove an object (the daily ingest drops a preliminary day's chunks once its finals land). S3 answers a missing key with success too. */
	async delete(path: AbsolutePath): Promise<void> {
		const { s3, sdk } = await this.#client;
		await s3.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(path) }));
	}
}

export { MirrorUrlError } from './url.js';

/** The store MIRROR_URL names. */
export function openStore(url: string, opts: { s3?: S3Sender } = {}): MirrorStore {
	registerNodeGzip();
	const at = parseMirrorUrl(url);
	return at.kind === 'file' ? new FileSystemStore(at.dir) : new S3Store(at.bucket, at.prefix, opts.s3);
}

/** Bytes per element of the zarr v3 fixed-size data types the mirror could hold. */
const DTYPE_BYTES: Readonly<Record<string, number>> = {
	bool: 1,
	int8: 1,
	uint8: 1,
	int16: 2,
	uint16: 2,
	float16: 2,
	int32: 4,
	uint32: 4,
	float32: 4,
	int64: 8,
	uint64: 8,
	float64: 8,
	complex64: 8,
	complex128: 16
};

/**
 * The most bytes a gzip chunk may inflate to, whatever its metadata says: far
 * past any chunk the ingest writes (a day of the D1 grid is ~0.3 MB, a whole
 * C3S array a few MB), and small enough that a worker Lambda survives it.
 */
export const GZIP_MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** Room past a chunk's elements for a checksum codec (crc32c's 4 bytes) between bytes and gzip. */
const GZIP_SLACK_BYTES = 1024;

/**
 * The most a chunk of `meta` may inflate to: its elements times their size
 * (plus GZIP_SLACK_BYTES), never more than GZIP_MAX_DECODED_BYTES. Unknown
 * shape or type: the ceiling alone.
 */
export function gzipDecodedLimit(meta?: { shape?: readonly number[]; dataType?: string }): number {
	const size = meta?.dataType !== undefined && Object.hasOwn(DTYPE_BYTES, meta.dataType) ? DTYPE_BYTES[meta.dataType]! : undefined;
	const shape = meta?.shape;
	if (size === undefined || !shape || !shape.every((n) => Number.isSafeInteger(n) && n >= 0)) return GZIP_MAX_DECODED_BYTES;
	const bytes = shape.reduce((a, n) => a * n, size) + GZIP_SLACK_BYTES;
	return Math.min(bytes, GZIP_MAX_DECODED_BYTES);
}

/**
 * gzip over node:zlib. zarrita 0.7.5's own gzip codec only decodes (encode
 * throws UnsupportedError), so the writers need this one (Round 0 check 5).
 * It decodes too, synchronously, which is the faster path in Node.
 *
 * A decode is bounded (gzipDecodedLimit, from the chunk's shape and type that
 * zarrita hands fromConfig): the mirror is written by Lambdas that read the
 * internet (the ingest job, the fetcher), and the worker and API read it, so a
 * small chunk that inflates to gigabytes (a gzip bomb, or a corrupt object)
 * fails that read instead of exhausting the reader's memory.
 */
export class NodeGzip {
	readonly kind = 'bytes_to_bytes';
	readonly level: number;
	readonly maxDecodedBytes: number;
	constructor(level = 6, maxDecodedBytes = GZIP_MAX_DECODED_BYTES) {
		this.level = level;
		this.maxDecodedBytes = maxDecodedBytes;
	}
	static fromConfig(c?: { level?: number }, meta?: { shape?: readonly number[]; dataType?: string }) {
		return new NodeGzip(c?.level ?? 6, gzipDecodedLimit(meta));
	}
	encode(bytes: Uint8Array): Uint8Array {
		return new Uint8Array(gzipSync(bytes, { level: this.level }));
	}
	decode(bytes: Uint8Array): Uint8Array {
		try {
			return new Uint8Array(gunzipSync(bytes, { maxOutputLength: this.maxDecodedBytes }));
		} catch (err) {
			if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
				throw new FeedFormatError(`a mirror chunk inflates past the ${this.maxDecodedBytes} bytes its shape allows`);
			}
			throw err;
		}
	}
}

let registered = false;
/** Register NodeGzip as zarrita's `gzip` codec, once, before any array is opened. */
export function registerNodeGzip(): void {
	if (registered) return;
	zarr.registry.set('gzip', async () => NodeGzip as never);
	registered = true;
}
