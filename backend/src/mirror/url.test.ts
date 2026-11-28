// parseMirrorUrl on its own (store.test.ts covers it only through openStore's
// refusals): what each accepted MIRROR_URL resolves to, the bucket-name edges,
// and the prefix's slashes. No store is opened.
import { describe, expect, it } from 'vitest';
import { MirrorUrlError, parseMirrorUrl } from './url.js';

describe('parseMirrorUrl', () => {
	it('takes file:///abs/path as that directory, percent escapes decoded', () => {
		expect(parseMirrorUrl('file:///srv/mirror')).toEqual({ kind: 'file', dir: '/srv/mirror' });
		expect(parseMirrorUrl('file:///srv/rain%20copy/')).toEqual({ kind: 'file', dir: '/srv/rain copy/' });
	});

	it('refuses a file URL that names a host or no absolute path', () => {
		for (const url of ['file://relative/path', 'file://example.com/srv/mirror']) {
			expect(() => parseMirrorUrl(url), url).toThrow(MirrorUrlError);
			expect(() => parseMirrorUrl(url), url).toThrow(/absolute path/);
		}
	});

	it('takes s3://bucket with no prefix, and trims every leading and trailing slash off a prefix', () => {
		expect(parseMirrorUrl('s3://wm-mirror')).toEqual({ kind: 's3', bucket: 'wm-mirror', prefix: '' });
		expect(parseMirrorUrl('s3://wm-mirror/')).toEqual({ kind: 's3', bucket: 'wm-mirror', prefix: '' });
		expect(parseMirrorUrl('s3://wm-mirror/env/a')).toEqual({ kind: 's3', bucket: 'wm-mirror', prefix: 'env/a' });
		expect(parseMirrorUrl('s3://wm-mirror//env/a//')).toEqual({ kind: 's3', bucket: 'wm-mirror', prefix: 'env/a' });
	});

	it('takes a bucket name of 3 to 63 lowercase letters, digits, dots and dashes, starting and ending with a letter or digit', () => {
		expect(parseMirrorUrl('s3://abc')).toMatchObject({ bucket: 'abc' });
		expect(parseMirrorUrl('s3://my.mirror-1')).toMatchObject({ bucket: 'my.mirror-1' });
		expect(parseMirrorUrl(`s3://${'a'.repeat(63)}`)).toMatchObject({ bucket: 'a'.repeat(63) });
		for (const bucket of ['ab', 'a'.repeat(64), '-mirror', 'mirror-', '.mirror', 'Mirror', 'my_mirror']) {
			expect(() => parseMirrorUrl(`s3://${bucket}`), bucket).toThrow(MirrorUrlError);
		}
	});

	it('refuses every other scheme, case included, with the message naming both forms', () => {
		for (const url of ['', 'S3://wm-mirror', 'FILE:///srv/mirror', 'https://wm-mirror.s3.amazonaws.com/', 'gs://wm-mirror', '/srv/mirror']) {
			expect(() => parseMirrorUrl(url), url).toThrow('MIRROR_URL must be file:///abs/path or s3://bucket[/prefix]');
		}
	});
});
