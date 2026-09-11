import { appendFileSync } from 'node:fs';
import { version } from '../package.json';
import { releaseInfo } from './release-info';
import { run } from './utils';

const info = releaseInfo(process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '', version);
const taggedCommit = run(['git', 'rev-parse', `refs/tags/${info.tag}^{commit}`], { capture: true });
const head = run(['git', 'rev-parse', 'HEAD'], { capture: true });
if (head !== taggedCommit) throw new Error('The checked-out commit must match the release tag.');
run(['git', 'merge-base', '--is-ancestor', taggedCommit, 'refs/remotes/origin/main']);

if (process.env.GITHUB_OUTPUT) {
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`tag=${info.tag}\ndist-tag=${info.distTag}\nprerelease=${info.prerelease}\n`
	);
}
console.log(`Release ${info.tag} validated for npm dist-tag ${info.distTag}.`);
