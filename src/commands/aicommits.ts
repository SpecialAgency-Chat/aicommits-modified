import { execa } from 'execa';
import {
	black, dim, green, red, bgCyan,
} from 'kolorist';
import {
	intro, outro, spinner, select, isCancel, text,
} from '@clack/prompts';
import {
	assertGitRepo,
	getStagedDiff,
	getDetectedMessage,
} from '../utils/git.js';
import { getConfig } from '../utils/config.js';
import { generateCommitMessage } from '../utils/openai.js';
import { KnownError, handleCliError } from '../utils/error.js';

const commitPrefixes = {
	'': '',
	entrust: '',
	fix: '🐛 fix',
	chore: '🔨 chore',
	docs: '📝 docs',
	style: '🎨 style',
	feat: '🚀 feat',
	perf: '🔥 perf',
	test: '🚨 test',
	security: '🔒 security',
	refactor: '🔧 refactor',
} as const;

export default async (
	generate: number | undefined,
	excludeFiles: string[],
	stageAll: boolean,
	commitType: string | undefined,
	rawArgv: string[],
) => (async () => {
	intro(bgCyan(black(' aicommits ')));
	await assertGitRepo();

	const detectingFiles = spinner();

	if (stageAll) {
		// This should be equivalent behavior to `git commit --all`
		await execa('git', ['add', '--update']);
	}

	detectingFiles.start('Detecting staged files');
	const staged = await getStagedDiff(excludeFiles);

	if (!staged) {
		detectingFiles.stop('Detecting staged files');
		throw new KnownError('No staged changes found. Stage your changes manually, or automatically stage all changes with the `--all` flag.');
	}

	detectingFiles.stop(`${getDetectedMessage(staged.files)}:\n${staged.files.map(file => `     ${file}`).join('\n')
		}`);

	const { env } = process;
	const config = await getConfig({
		OPENAI_KEY: env.OPENAI_KEY || env.OPENAI_API_KEY,
		proxy: env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY,
		generate: generate?.toString(),
		type: commitType?.toString(),
	});

	const bgInfo = await text({
		message: 'Please enter any background information you would like to pass on to the AI.',
		placeholder: 'fixed typo',
	}) as string;
	if (isCancel(bgInfo)) {
		outro('Commit cancelled');
		return;
	}
	const prefix = await select({
		message: 'Please select a prefix for the commit message.',
		options: [
			{ label: 'None', value: '' },
			{ label: 'Entrust', value: 'entrust', hint: 'Entrust the AI to generate a commit message' },
			{ label: '🐛 fix', value: 'fix', hint: 'Fixes a bug' },
			{ label: '🔨 chore', value: 'chore', hint: 'Changes to the build process or auxiliary tools and libraries such as documentation generation' },
			{ label: '📝 docs', value: 'docs', hint: 'Documentation only changes' },
			{ label: '🎨 style', value: 'style', hint: 'Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)' },
			{ label: '🚀 feat', value: 'feat', hint: 'Adds a new feature' },
			{ label: '🔥 perf', value: 'perf', hint: 'Improves performance' },
			{ label: '🚨 test', value: 'test', hint: 'Adds or modifies tests' },
			{ label: '🔒 security', value: 'security', hint: 'Fixes a security issue' },
			{ label: '🔧 refactor', value: 'refactor', hint: 'A code change that neither fixes a bug nor adds a feature' },
		],
	}) as Exclude<keyof typeof commitPrefixes, symbol>;
	if (isCancel(prefix)) {
		outro('Commit cancelled');
		return;
	}
	const s = spinner();
	s.start('The AI is analyzing your changes');
	let messages: string[];
	try {
		const bgInfoText = bgInfo ? `Background information provided from user: ${bgInfo}` : '';
		messages = await generateCommitMessage(
			config.OPENAI_KEY,
			config.model,
			config.locale,
			staged.diff,
			prefix === 'entrust' ? `${bgInfoText}\nThe commit message must begin with an emoji and prefix that best describes the change. (e.g. 🐛 fix: bug in something.js file where processing does not stop)` : bgInfoText,
			config.generate,
			config['max-length'],
			config.type,
			config.timeout,
			config.proxy,
		);
	} finally {
		s.stop('Changes analyzed');
	}

	if (messages.length === 0) {
		throw new KnownError('No commit messages were generated. Try again.');
	}

	let message: string;
	if (messages.length === 1) {
		[message] = messages;
		// eslint-disable-next-line no-unused-expressions
		(prefix === 'entrust' || prefix === '') || (message = `${commitPrefixes[prefix]}: ${message}`);
		const confirmed = await select({
			message: `Use this commit message?\n\n   ${message}\n`,
			options: [
				{ label: 'Yes', value: 'yes' },
				{ label: 'No, regenerate', value: 'regenerate' },
				{ label: 'No, cancel commit', value: 'cancel' },
			],
			initialValue: 'yes',
		});

		if (confirmed === 'cancel' || isCancel(confirmed)) {
			outro('Commit cancelled');
			return;
		}
		if (confirmed === 'regenerate') {
			return execa('aim', rawArgv, { stdio: 'inherit' });
		}
	} else {
		const selected = await select({
			message: `Pick a commit message to use: ${dim('(Ctrl+c to exit)')}`,
			options: messages.map(value => ({ label: value, value })),
		});

		if (isCancel(selected)) {
			outro('Commit cancelled');
			return;
		}

		message = selected;
		// eslint-disable-next-line no-unused-expressions
		(prefix === 'entrust' || prefix === '') || (message = `${commitPrefixes[prefix]}: ${message}`);
	}

	await execa('git', ['commit', '-m', message, ...rawArgv]);

	outro(`${green('✔')} Successfully committed!`);
})().catch((error) => {
	outro(`${red('✖')} ${error.message}`);
	handleCliError(error);
	process.exit(1);
});
