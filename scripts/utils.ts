import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const npm = ['node', resolve(root, 'node_modules/npm/bin/npm-cli.js')];

export function run(command: string[], options: { cwd?: string; capture?: boolean } = {}): string {
	const result = Bun.spawnSync(command, {
		cwd: options.cwd ?? root,
		stdin: 'ignore',
		stdout: options.capture ? 'pipe' : 'inherit',
		stderr: 'inherit'
	});

	if (result.exitCode !== 0) {
		throw new Error(`${command.join(' ')} failed with exit code ${result.exitCode}`);
	}
	return result.stdout?.toString().trim() ?? '';
}
