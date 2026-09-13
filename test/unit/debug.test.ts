import { expect, test } from 'bun:test';

test.each([
	'off',
	'on',
	'empty',
	'false-string',
	'storage-denied',
	'get-item-denied',
	'storage-missing',
	'console-throws',
	'late-enable',
	'late-disable'
])('diagnostics in an isolated module: %s', async (mode) => {
	const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/debug.ts`, mode], {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	]);
	expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
});
