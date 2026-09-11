import { describe, expect, test } from 'bun:test';
import { releaseInfo } from '../../scripts/release-info';

describe('release validation', () => {
	test('publishes stable versions to latest', () => {
		expect(releaseInfo('v0.2.7', '0.2.7')).toEqual({
			tag: 'v0.2.7',
			version: '0.2.7',
			prerelease: false,
			distTag: 'latest'
		});
	});

	test('publishes prereleases to next', () => {
		expect(releaseInfo('v1.0.0-rc.1', '1.0.0-rc.1')).toEqual({
			tag: 'v1.0.0-rc.1',
			version: '1.0.0-rc.1',
			prerelease: true,
			distTag: 'next'
		});
	});

	test.each([
		'',
		'main',
		'1.0.0',
		'v1.0',
		'v01.0.0',
		'v1.0.0-01',
		'v1.0.0-',
		'v1.0.0+build',
		'v1.0.0\n',
		'v1.0.0\ninvalid'
	])('rejects invalid or unsupported tag %j', (tag) => {
		expect(() => releaseInfo(tag, '1.0.0')).toThrow('Expected vMAJOR.MINOR.PATCH');
	});

	test('rejects a tag/package version mismatch before publishing', () => {
		expect(() => releaseInfo('v0.2.7', '0.2.6')).toThrow('does not match');
	});
});
