const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const tagPattern = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?)$`);

export function releaseInfo(tag: string, packageVersion: string) {
	const match = tagPattern.exec(tag);
	if (!match || match[0] !== tag)
		throw new Error('Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease; build metadata is not supported.');
	const version = match[1];
	if (version !== packageVersion) {
		throw new Error(`Tag version ${version} does not match package.json version ${packageVersion}`);
	}
	const prerelease = version.includes('-');
	return { tag, version, prerelease, distTag: prerelease ? 'next' : 'latest' };
}
