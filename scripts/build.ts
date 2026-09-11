import { copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, run } from './utils';

const temporary = resolve(root, '.build');
const bundled = resolve(temporary, 'bundled');
const output = resolve(root, 'dist');
rmSync(temporary, { recursive: true, force: true });
rmSync(output, { recursive: true, force: true });

try {
	run(['tsc', '-p', 'tsconfig.build.json']);
	for (const format of ['esm', 'cjs'] as const) {
		const result = await Bun.build({
			entrypoints: [resolve(temporary, 'index.js')],
			outdir: bundled,
			target: 'browser',
			format,
			minify: false,
			naming: format === 'esm' ? 'index.js' : 'index.cjs'
		});
		if (!result.success) throw new AggregateError(result.logs, `${format} build failed`);
	}
	// Bun's generated CJS helpers may use syntax newer than the input's target.
	run(['tsc', '-p', 'tsconfig.bundle.json']);
	for (const name of ['index.d.ts', 'index.d.cts']) {
		copyFileSync(resolve(temporary, 'index.d.ts'), resolve(output, name));
	}
} catch (error) {
	rmSync(output, { recursive: true, force: true });
	throw error;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
