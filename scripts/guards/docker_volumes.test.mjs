// Only dev:docker:wipe may delete the shared docker volumes
// (docker_volumes.mjs, run by scripts/check_root_scripts.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VOLUME_WIPE, volumeWipeProblems } from './docker_volumes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('volumeWipeProblems', () => {
	for (const cmd of [
		'docker compose down -v',
		'docker compose down --volumes',
		'docker compose -f docker-compose.yml down -v --remove-orphans',
		'docker-compose down -v',
		'pnpm dev:db:up && docker compose down -v postgres',
		'docker volume rm project_pgdata',
		'docker volume prune -f',
	]) {
		it(`fails another script that runs \`${cmd}\``, () => {
			const problems = volumeWipeProblems({ 'dev:db:reset': cmd });
			assert.equal(problems.length, 1);
			assert.match(problems[0], /^dev:db:reset: deletes the shared docker volumes; only dev:docker:wipe may/);
		});
	}

	it(`passes ${VOLUME_WIPE} alone`, () => {
		assert.deepEqual(volumeWipeProblems({ [VOLUME_WIPE]: 'docker compose down -v' }), []);
		assert.deepEqual(volumeWipeProblems({ [VOLUME_WIPE]: 'docker compose down -v', 'dev:other': 'docker volume rm x' }), [
			"dev:other: deletes the shared docker volumes; only dev:docker:wipe may (dev:db:reset resets one checkout's database)",
		]);
	});

	it('passes a plain docker compose down and commands that only mention volumes', () => {
		assert.deepEqual(
			volumeWipeProblems({
				'dev:db:down': 'docker compose down',
				'dev:down': 'docker compose down --remove-orphans',
				'dev:db:status': 'docker compose ps && docker volume ls',
				'dev:db:logs': 'docker compose logs -f postgres',
				// -v after a separator is another command's flag, not down's.
				'dev:both': 'docker compose down && node -v',
			}),
			[]
		);
	});

	it('ignores //-- group dividers', () => {
		assert.deepEqual(volumeWipeProblems({ '//-- db --': 'dev:docker:wipe runs docker compose down -v' }), []);
	});

	it("passes this repo's own package.json", () => {
		const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		assert.equal(scripts[VOLUME_WIPE], 'docker compose down -v', 'positive control: the wipe script exists and deletes the volumes');
		assert.deepEqual(volumeWipeProblems(scripts), []);
	});
});
