import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parse } from 'acorn';
import { name, version } from '../package.json';
import { npm, root, run } from './utils';

const artifacts = resolve(root, '.artifacts');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const consumer = mkdtempSync(join(tmpdir(), 'channel-rpc-consumer-'));
const isolatedNpm = [...npm, '--cache', join(consumer, '.npm-cache')];

try {
	const packs: Record<
		string,
		{ filename: string; name: string; version: string; integrity: string; files: { path: string }[] }
	> = JSON.parse(
		run([...isolatedNpm, 'pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { capture: true })
	);
	assert.deepEqual(Object.keys(packs), [name]);
	const pack = packs[name];
	assert.equal(pack.name, name);
	assert.equal(pack.version, version);
	const files = new Set(pack.files.map((file) => file.path));
	for (const required of [
		'dist/index.js',
		'dist/index.cjs',
		'dist/index.d.ts',
		'dist/index.d.cts',
		'src/index.ts',
		'package.json',
		'README.md',
		'LICENSE'
	]) {
		assert(files.has(required), `Missing published file: ${required}`);
	}
	for (const file of files) {
		assert(/^(?:dist\/|src\/|package\.json$|README\.md$|LICENSE$)/.test(file), `Unexpected published file: ${file}`);
	}

	const tarball = resolve(artifacts, pack.filename);
	writeFileSync(
		join(consumer, 'package.json'),
		JSON.stringify({ name: 'channel-rpc-consumer', private: true, type: 'module' })
	);
	run(
		[
			...isolatedNpm,
			'install',
			tarball,
			'--ignore-scripts',
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--offline'
		],
		{ cwd: consumer }
	);
	const installed = join(consumer, 'node_modules', name);
	run(['publint', tarball, '--strict']);
	run(['attw', tarball, '--profile', 'node16']);
	for (const [file, sourceType] of [
		['index.js', 'module'],
		['index.cjs', 'script']
	] as const) {
		parse(readFileSync(join(installed, 'dist', file), 'utf8'), { ecmaVersion: 2020, sourceType });
	}
	const assertions = `
		const assert = require('node:assert/strict');
		assert.deepEqual(Object.keys(rpc).sort(), ['ChannelClient', 'ChannelErrors', 'ChannelServer']);
		assert.equal(typeof rpc.ChannelClient, 'function');
		assert.equal(typeof rpc.ChannelServer, 'function');
		assert.equal(rpc.ChannelErrors.Timeout.code, -32000);
	`;
	run(['node', '--input-type=commonjs', '-e', `const rpc = require('channel-rpc'); ${assertions}`], { cwd: consumer });
	run(
		[
			'node',
			'--input-type=module',
			'-e',
			`import * as rpc from 'channel-rpc'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${assertions}`
		],
		{ cwd: consumer }
	);
	for (const file of ['consumer.mts', 'consumer.cts']) {
		copyFileSync(resolve(root, 'test/types', file), join(consumer, file));
	}
	for (const moduleResolution of ['NodeNext', 'Bundler'] as const) {
		const config = {
			compilerOptions: {
				target: 'ES2020',
				module: moduleResolution === 'NodeNext' ? 'NodeNext' : 'Preserve',
				moduleResolution,
				lib: ['ES2020', 'DOM'],
				types: [],
				strict: true,
				noEmit: true,
				skipLibCheck: false
			},
			include: ['consumer.mts', 'consumer.cts']
		};
		writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(config));
		run(['tsc', '-p', join(consumer, 'tsconfig.json')]);
	}
	writeFileSync(
		join(artifacts, 'package.json'),
		`${JSON.stringify({ filename: pack.filename, version, integrity: pack.integrity }, null, 2)}\n`
	);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${relative(root, tarball)}\n`);
	}
	console.log(`Verified ${pack.filename}: ESM, CJS, types, and ES2020 syntax.`);
} catch (error) {
	rmSync(artifacts, { recursive: true, force: true });
	throw error;
} finally {
	rmSync(consumer, { recursive: true, force: true });
}
