// decodePng against PNGs the fixture's encoder never writes (it writes RGB,
// every row Sub-filtered, in one IDAT): a Terrarium tile from another tiler may
// use any of the five row filters, RGBA, and several IDAT chunks. Built here by
// the PNG spec's filters (W3C PNG § 7.3, § 9), so the decoder is checked
// against the spec, not against its own encoder; and the refusals of what the
// DEM reader doesn't read (16-bit, palette, interlaced, a sixth filter, short
// image data).
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, PngError } from './png.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A chunk; decodePng doesn't check CRCs, so it is left 0. */
function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, 'latin1');
	return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function ihdr(width: number, height: number, depth = 8, colour = 2, interlace = 0): Buffer {
	const b = Buffer.alloc(13);
	b.writeUInt32BE(width, 0);
	b.writeUInt32BE(height, 4);
	b[8] = depth;
	b[9] = colour;
	b[12] = interlace;
	return chunk('IHDR', b);
}

/** The spec's Paeth predictor (PNG § 9.4). */
function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/** Filters rows of raw bytes (`bpp` bytes a pixel) with the given filter per row, as an encoder would. */
function filterRows(rows: Uint8Array[], bpp: number, filters: number[]): Buffer {
	const stride = rows[0]!.length;
	const out = Buffer.alloc(rows.length * (stride + 1));
	rows.forEach((row, y) => {
		const prev = y > 0 ? rows[y - 1]! : new Uint8Array(stride);
		const f = filters[y % filters.length]!;
		out[y * (stride + 1)] = f;
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? row[i - bpp]! : 0;
			const b = prev[i]!;
			const c = i >= bpp ? prev[i - bpp]! : 0;
			const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
			out[y * (stride + 1) + 1 + i] = (row[i]! - pred) & 255;
		}
	});
	return out;
}

/** Pixel bytes that exercise every predictor: wide swings, so a wrong one shows. */
function pixels(width: number, height: number, bpp: number): Uint8Array[] {
	const rows: Uint8Array[] = [];
	for (let y = 0; y < height; y++) {
		const row = new Uint8Array(width * bpp);
		for (let i = 0; i < row.length; i++) row[i] = (Math.imul(i + 1, 2654435761) ^ Math.imul(y + 7, 40503)) >>> 24;
		rows.push(row);
	}
	return rows;
}

/** A PNG of `rows`, its deflated data split into IDAT chunks of `split` bytes. */
function png(width: number, rows: Uint8Array[], colour: 2 | 6, filters: number[], split = Infinity): Uint8Array {
	const data = deflateSync(filterRows(rows, colour === 2 ? 3 : 4, filters));
	const idats: Buffer[] = [];
	for (let o = 0; o < data.length; o += Math.min(split, data.length)) idats.push(chunk('IDAT', data.subarray(o, o + Math.min(split, data.length))));
	return new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), ihdr(width, rows.length, 8, colour), ...idats, chunk('IEND', new Uint8Array(0))]));
}

const argbOf = (rows: Uint8Array[], bpp: number) =>
	rows.flatMap((row) => {
		const out: number[] = [];
		for (let p = 0; p < row.length; p += bpp) out.push((((bpp === 4 ? row[p + 3]! : 255) << 24) | (row[p]! << 16) | (row[p + 1]! << 8) | row[p + 2]!) >>> 0);
		return out;
	});

describe('decodePng: what other tilers write', () => {
	for (const [name, f] of [
		['None', 0],
		['Sub', 1],
		['Up', 2],
		['Average', 3],
		['Paeth', 4]
	] as const) {
		it(`undoes the ${name} filter on every row`, () => {
			const rows = pixels(19, 7, 3);
			const img = decodePng(png(19, rows, 2, [f]));
			expect([img.width, img.height]).toEqual([19, 7]);
			expect(Array.from(img.argb)).toEqual(argbOf(rows, 3));
		});
	}

	it('breaks a Paeth tie as the spec does: the left byte before the upper-left', () => {
		// The second pixel of the second row: a (left) 30, b (up) 60, c (upper-left) 50, so p = 40 and |p − a| = |p − c| = 10 < |p − b|.
		const rows = [new Uint8Array([50, 50, 50, 60, 60, 60]), new Uint8Array([30, 30, 30, 77, 77, 77])];
		expect(Array.from(decodePng(png(2, rows, 2, [4])).argb)).toEqual(argbOf(rows, 3));
	});

	it('undoes a different filter on each row, as an adaptive encoder writes', () => {
		const rows = pixels(23, 11, 3);
		expect(Array.from(decodePng(png(23, rows, 2, [4, 0, 3, 1, 2, 4, 3])).argb)).toEqual(argbOf(rows, 3));
	});

	it('reads RGBA, keeping the alpha, its predictors stepping four bytes', () => {
		const rows = pixels(13, 9, 4);
		expect(Array.from(decodePng(png(13, rows, 6, [1, 2, 3, 4, 0])).argb)).toEqual(argbOf(rows, 4));
	});

	it('joins image data split over many IDAT chunks', () => {
		const rows = pixels(17, 8, 3);
		expect(Array.from(decodePng(png(17, rows, 2, [4], 7)).argb)).toEqual(argbOf(rows, 3));
	});

	it('decodes a Terrarium elevation back to its metres whatever the filter (a 1 m step and a sub-metre slope)', async () => {
		const { terrarium } = await import('./dem.js');
		// Elevations 1200.5 m … across a row: R·256 + G + B/256 − 32768.
		const width = 8;
		const row = new Uint8Array(width * 3);
		const want: number[] = [];
		for (let x = 0; x < width; x++) {
			const v = 1200.5 + x * 1.25 + 32768;
			row[x * 3] = Math.floor(v / 256);
			row[x * 3 + 1] = Math.floor(v) % 256;
			row[x * 3 + 2] = Math.round((v % 1) * 256);
			want.push(1200.5 + x * 1.25);
		}
		for (const f of [0, 1, 2, 3, 4]) {
			const img = decodePng(png(width, [row, row], 2, [f]));
			expect(Array.from(img.argb, terrarium), `filter ${f}`).toEqual([...want, ...want]);
		}
	});
});

describe('decodePng: what the DEM reader refuses', () => {
	const body = (h: Buffer, raw: Buffer) => new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), h, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));

	it('refuses a 16-bit image, a palette image and an interlaced one, saying which', () => {
		expect(() => decodePng(body(ihdr(4, 4, 16, 2), Buffer.alloc(4 * 25)))).toThrow(/bit depth/);
		expect(() => decodePng(body(ihdr(4, 4, 8, 3), Buffer.alloc(4 * 5)))).toThrow(/colour type/);
		expect(() => decodePng(body(ihdr(4, 4, 8, 2, 1), Buffer.alloc(4 * 13)))).toThrow(/interlacing/);
	});

	it('refuses a row filter past Paeth', () => {
		const raw = filterRows(pixels(4, 2, 3), 3, [0]);
		raw[4 * 3 + 1] = 5; // the second row's filter byte
		expect(() => decodePng(body(ihdr(4, 2), raw))).toThrow(/unknown row filter/);
	});

	it('refuses image data short of its rows, and a chunk that runs past the file', () => {
		const raw = filterRows(pixels(4, 3, 3), 3, [0]);
		expect(() => decodePng(body(ihdr(4, 3), raw.subarray(0, raw.length - 1)))).toThrow(/too little image data/);
		const whole = body(ihdr(4, 3), raw);
		expect(() => decodePng(whole.subarray(0, 8 + 25 + 10))).toThrow(PngError);
	});

	it('refuses a file with no IHDR', () => {
		expect(() => decodePng(new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), chunk('IEND', new Uint8Array(0))])))).toThrow(/no IHDR/);
	});
});
