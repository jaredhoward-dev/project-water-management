// A root script or bin/ shell script that starts a compose container passes
// --no-recreate (docker_recreate.mjs, run by scripts/check_root_scripts.mjs; issue #945).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { composeUpProblems, recreateProblems } from './docker_recreate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('recreateProblems', () => {
	for (const cmd of [
		'docker compose up -d --wait postgres',
		'docker-compose up -d postgres',
		'docker compose -f docker-compose.yml up -d minio',
		'pnpm install && docker compose up -d --wait mailpit',
	]) {
		it(`fails a start script that runs \`${cmd}\``, () => {
			const problems = recreateProblems({ 'dev:db:up': cmd });
			assert.equal(problems.length, 1);
			assert.match(problems[0], /^dev:db:up: .* needs --no-recreate/);
		});
	}

	it('passes --no-recreate, and commands that are not an up', () => {
		assert.deepEqual(
			recreateProblems({
				'dev:db:up': 'docker compose up -d --no-recreate --wait postgres',
				'dev:db:down': 'docker compose down',
				'dev:db:status': 'docker compose ps postgres',
				'dev:db:logs': 'docker compose logs -f postgres',
				// `up` after a separator belongs to another command.
				'dev:other': 'docker compose ps && echo up',
			}),
			[]
		);
	});

	it('checks each up in a chain on its own', () => {
		const problems = recreateProblems({
			'dev:both': 'docker compose up -d --no-recreate postgres && docker compose up -d minio',
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /docker compose up -d minio/);
	});

	it('lets dev:db:recreate recreate, but only by saying so', () => {
		assert.deepEqual(recreateProblems({ 'dev:db:recreate': 'docker compose up -d --force-recreate --wait postgres' }), []);
		assert.equal(recreateProblems({ 'dev:db:recreate': 'docker compose up -d --wait postgres' }).length, 1);
	});

	it('ignores //-- group dividers', () => {
		assert.deepEqual(recreateProblems({ '//-- db --': 'dev:db:up runs docker compose up -d postgres' }), []);
	});

	it("passes this repo's own package.json", () => {
		const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		assert.match(scripts['dev:db:up'], /docker compose up/, 'positive control: dev:db:up starts the container');
		assert.deepEqual(recreateProblems(scripts), []);
	});

	it("passes this repo's bin/ shell scripts", () => {
		const problems = readdirSync(join(root, 'bin'))
			.filter((f) => f.endsWith('.sh'))
			.flatMap((f) => composeUpProblems(`bin/${f}`, readFileSync(join(root, 'bin', f), 'utf8')));
		assert.deepEqual(problems, []);
		assert.match(readFileSync(join(root, 'bin', 'tiles-dev.sh'), 'utf8'), /docker compose up -d --no-recreate --wait minio/, 'positive control');
	});
});
