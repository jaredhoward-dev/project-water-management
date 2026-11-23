// Every checkout and session on this machine shares the docker compose volumes
// (every checkout's dev, test and e2e databases, MinIO's data), so only the
// root script named for it may delete them: dev:db:reset once ran
// `docker compose down -v`, and a worktree resetting its own database wiped
// everyone's. scripts/check_root_scripts.mjs runs this over package.json.

/** The one root script allowed to delete the shared docker volumes. */
export const VOLUME_WIPE = 'dev:docker:wipe';

/** Matches a command that deletes docker volumes: `docker compose down -v`/`--volumes` (or docker-compose), `docker volume rm|prune`. */
export const DELETES_VOLUMES = /docker(?:-| )compose\b[^&|;]*\bdown\b[^&|;]*(?:\s-v\b|--volumes)|docker volume (?:rm|prune)/;

/**
 * One error per root script other than {@link VOLUME_WIPE} whose command deletes
 * the shared docker volumes.
 * @param {Record<string, string>} scripts package.json's scripts block
 * @returns {string[]}
 */
export function volumeWipeProblems(scripts) {
	return Object.entries(scripts)
		.filter(([name, cmd]) => !name.startsWith('//') && name !== VOLUME_WIPE && DELETES_VOLUMES.test(cmd))
		.map(([name]) => `${name}: deletes the shared docker volumes; only ${VOLUME_WIPE} may (dev:db:reset resets one checkout's database)`);
}
