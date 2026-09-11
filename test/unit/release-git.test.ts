import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root } from '../../scripts/utils';

let directory: string;

function git(...args: string[]) {
	const result = Bun.spawnSync(
		[
			'git',
			'-c',
			'user.name=Release Fixture',
			'-c',
			'user.email=fixture@example.test',
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'commit.gpgsign=false',
			'-c',
			'tag.gpgsign=false',
			...args
		],
		{ cwd: directory, stdout: 'pipe', stderr: 'pipe' }
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'channel-rpc-release-'));
	mkdirSync(join(directory, 'scripts'));
	for (const file of ['utils.ts', 'release-info.ts', 'check-release.ts']) {
		copyFileSync(resolve(root, 'scripts', file), join(directory, 'scripts', file));
	}
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.2.7', type: 'module' }));
	git('init', '--initial-branch=main');
	git('add', '.');
	git('commit', '-m', 'Release fixture');
	git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function validate() {
	return Bun.spawnSync(['bun', 'run', 'scripts/check-release.ts'], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GITHUB_REF_NAME: 'v0.2.7', GITHUB_OUTPUT: join(directory, 'outputs') }
	});
}

test('accepts an annotated tag on main and emits the release outputs', () => {
	git('tag', '-a', 'v0.2.7', '-m', 'v0.2.7');
	expect(validate().exitCode).toBe(0);
	expect(readFileSync(join(directory, 'outputs'), 'utf8')).toBe('tag=v0.2.7\ndist-tag=latest\nprerelease=false\n');
});

test('rejects a tagged commit that has not been merged into main', () => {
	git('switch', '-c', 'unmerged');
	git('commit', '--allow-empty', '-m', 'Unmerged change');
	git('tag', '-a', 'v0.2.7', '-m', 'v0.2.7');
	expect(validate().exitCode).not.toBe(0);
	expect(existsSync(join(directory, 'outputs'))).toBe(false);
});

test('rejects a checkout that differs from the tagged commit', () => {
	git('tag', '-a', 'v0.2.7', '-m', 'v0.2.7');
	git('commit', '--allow-empty', '-m', 'Later main commit');
	git('update-ref', 'refs/remotes/origin/main', 'HEAD');
	const result = validate();
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain('checked-out commit must match');
	expect(existsSync(join(directory, 'outputs'))).toBe(false);
});
