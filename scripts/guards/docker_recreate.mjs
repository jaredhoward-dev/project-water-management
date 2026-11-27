// Every checkout and git worktree drives the same docker compose containers
// (docker-compose.yml pins the project name). The postgres service bind-mounts
// ./dev/postgres, which compose resolves to an absolute path per checkout, so a
// plain `docker compose up` from another worktree sees a "changed" service and
// recreates the shared container, dropping every other session's connections
// mid-run (issue #945). So a root script that starts a container passes
// --no-recreate, and only the scripts named for it force a recreate.
// scripts/check_root_scripts.mjs runs this over package.json.

/** The root scripts allowed to recreate a running container. */
export const RECREATE_SCRIPTS = new Set(['dev:db:recreate']);

/** A `docker compose up` (or docker-compose up), up to the next shell separator. */
const COMPOSE_UP = /docker(?:-| )compose\b[^&|;]*?\bup\b[^&|;]*/g;

/**
 * Problems in one command: each `docker compose up` in it must pass
 * --no-recreate, unless the script is allowed to recreate (then it must say
 * --force-recreate, so the intent is explicit).
 * @param {string} name the script's name, or a file path for a shell script
 * @param {string} cmd
 * @param {boolean} [mayRecreate]
 * @returns {string[]}
 */
export function composeUpProblems(name, cmd, mayRecreate = false) {
	const problems = [];
	for (const [up] of cmd.matchAll(COMPOSE_UP)) {
		if (mayRecreate) {
			if (!/--force-recreate\b/.test(up)) problems.push(`${name}: a recreate script should say --force-recreate (${up.trim()})`);
		} else if (!/--no-recreate\b/.test(up)) {
			problems.push(`${name}: \`${up.trim()}\` needs --no-recreate: from another checkout it recreates the shared container under every other session (issue #945)`);
		}
	}
	return problems;
}

/**
 * One error per root script whose `docker compose up` could recreate a running container.
 * @param {Record<string, string>} scripts package.json's scripts block
 * @returns {string[]}
 */
export function recreateProblems(scripts) {
	return Object.entries(scripts)
		.filter(([name]) => !name.startsWith('//'))
		.flatMap(([name, cmd]) => composeUpProblems(name, cmd, RECREATE_SCRIPTS.has(name)));
}
