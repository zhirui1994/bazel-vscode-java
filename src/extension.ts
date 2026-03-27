import { Span } from '@opentelemetry/api';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { format } from 'util';
import {
	ExtensionContext,
	ProgressLocation,
	TextDocument,
	Uri,
	commands,
	extensions,
	tasks,
	window,
	workspace,
} from 'vscode';
import {
	BazelLanguageServerTerminal,
	getBazelTerminal,
} from './bazelLangaugeServerTerminal';
import { getBazelProjectFile } from './bazelprojectparser';
import { BazelTaskManager } from './bazelTaskManager';
import { registerBuildifierFormatter } from './buildifier';
import { Commands, executeJavaLanguageServerCommand } from './commands';
import { BazelVscodeExtensionAPI } from './extension.api';
import { registerLSClient } from './loggingTCPServer';
import { ProjectViewManager } from './projectViewManager';
import { BazelRunTargetProvider } from './provider/bazelRunTargetProvider';
import { getModuleBuildFile } from './provider/bazelSyncStatusProvider';
import { BazelTaskProvider } from './provider/bazelTaskProvider';
import { ExtensionOtel, registerMetrics } from './tracing/otelUtils';
import {
	getWorkspaceRoot,
	initBazelProjectFile,
	isBazelWorkspaceRoot,
} from './util';

const workspaceRoot = getWorkspaceRoot();

export async function activate(
	context: ExtensionContext
): Promise<BazelVscodeExtensionAPI> {
	// activates
	// LS processes current .eclipse/.bazelproject file
	// if it DNE create one
	// register TCP port with LS
	// project view should reflect what's in the LS
	// show any directories listed in the .bazelproject file
	// fetch all projects loaded into LS and display those as well
	// show .eclipse folder
	//

	// Write java.bazel.enabled configuration to file for JDTLS layer
	writeBazelEnabledConfig();

	const enabled = workspace
		.getConfiguration('java.bazel-vscode')
		.get('enabled');
	if (!enabled) {
		BazelLanguageServerTerminal.info(
			'Bazel VSCode extension for Java is disabled. To enable it, set "java.bazel-vscode.enabled" to true in your settings.'
		);
		return Promise.resolve({
			parseProjectFile: await getBazelProjectFile(),
		});
	}

	registerMetrics(context);

	window.registerTreeDataProvider(
		'bazelTaskOutline',
		BazelRunTargetProvider.instance
	);
	tasks.registerTaskProvider('bazel', new BazelTaskProvider());

	BazelLanguageServerTerminal.trace('extension activated');

	workspace.onDidSaveTextDocument((doc) => {
		if (doc.fileName.includes('bazelproject')) {
			toggleBazelProjectSyncStatus(doc);
		}
	});

	context.subscriptions.push(
		commands.registerCommand(
			Commands.OPEN_BAZEL_BUILD_STATUS_CMD,
			getBazelTerminal().show
		)
	);

	commands.executeCommand(
		'setContext',
		'isBazelWorkspaceRoot',
		isBazelWorkspaceRoot()
	);
	commands.executeCommand(
		'setContext',
		'isMultiRoot',
		workspace.workspaceFile?.fsPath.includes('code-workspace')
	);
	// create .eclipse/.bazelproject file if DNE
	if (isBazelWorkspaceRoot()) {
		initBazelProjectFile();
		const showBazelprojectConfig =
			workspace.getConfiguration('bazel.projectview');
		if (showBazelprojectConfig.get('open')) {
			openBazelProjectFile();
			showBazelprojectConfig.update('open', false); // only open this file on the first activation of this extension
		}
		syncProjectViewDirectories();
		context.subscriptions.push(
			commands.registerCommand(Commands.OPEN_BAZEL_PROJECT_FILE, () =>
				openBazelProjectFile()
			)
		);
	}

	context.subscriptions.push(
		commands.registerCommand(Commands.SYNC_PROJECTS_CMD, syncProjectView)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.SYNC_DIRECTORIES_ONLY,
			syncProjectViewDirectories
		)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.UPDATE_CLASSPATHS_CMD, updateClasspaths)
	);
	context.subscriptions.push(
		commands.registerCommand(Commands.DEBUG_LS_CMD, runLSCmd)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_REFRESH,
			BazelTaskManager.refreshTasks
		)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_RUN,
			BazelTaskManager.runTask
		)
	);
	context.subscriptions.push(
		commands.registerCommand(
			Commands.BAZEL_TARGET_KILL,
			BazelTaskManager.killTask
		)
	);

	context.subscriptions.push(
		commands.registerCommand(
			Commands.CONVERT_PROJECT_WORKSPACE,
			ProjectViewManager.covertToMultiRoot
		)
	);

	registerBuildifierFormatter();

	// trigger a refresh of the tree view when any task get executed
	tasks.onDidStartTask((_) => BazelRunTargetProvider.instance.refresh());
	tasks.onDidEndTask((_) => BazelRunTargetProvider.instance.refresh());

	// always update the project view after the initial project load
	registerLSClient();

	ExtensionOtel.getInstance(context).tracer.startActiveSpan(
		'extension.activation',
		(span: Span) => {
			span.addEvent('activation success');
			span.end();
		}
	);

	return Promise.resolve({
		parseProjectFile: await getBazelProjectFile(),
	});
}

export function deactivate() {}

function syncProjectView(): void {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to sync project view. Java language server is not ready'
		);
		return;
	}

	const launchMode = workspace
		.getConfiguration('java.server')
		.get('launchMode');
	// if the launchMode is not Standard it should be changed and the window reloaded to apply that change
	if (!launchMode || launchMode !== 'Standard') {
		workspace
			.getConfiguration('java.server')
			.update('launchMode', 'Standard')
			.then(() => commands.executeCommand('workbench.action.reloadWindow'));
	}

	executeJavaLanguageServerCommand(Commands.SYNC_PROJECTS).then(
		syncProjectViewDirectories
	);
}

function updateClasspaths(moduleBuildFile?: Uri) {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to update classpath. Java language server is not ready'
		);
		return;
	}

	// Get BUILD file URI
	const buildFileUri = getBuildFileUri(moduleBuildFile);
	if (!buildFileUri) {
		return; // Error already shown in getBuildFileUri
	}

	// Show progress notification
	window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: 'Refreshing classpath',
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: 'Updating classpath from BUILD file...' });

			try {
				await executeJavaLanguageServerCommand(
					Commands.UPDATE_CLASSPATHS,
					buildFileUri.toString()
				);

				window.showInformationMessage(
					'Classpath refresh completed successfully.'
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				window.showErrorMessage(`Failed to refresh classpath: ${errorMessage}`);
			}
		}
	);
}

/**
 * Gets the BUILD file Uri from various sources.
 * Returns undefined if no valid BUILD file can be found (and shows error message).
 */
function getBuildFileUri(moduleBuildFile?: Uri): Uri | undefined {
	// If moduleBuildFile is provided, return it directly
	if (moduleBuildFile) {
		return moduleBuildFile;
	}

	// Otherwise, try to find BUILD file from active editor
	const activeEditor = window.activeTextEditor;
	if (!activeEditor) {
		window.showErrorMessage(
			'No BUILD file selected. Please open a BUILD file or select one in the explorer.'
		);
		return undefined;
	}

	const activeFileUri = activeEditor.document.uri;

	// If current file is a BUILD file, use it
	if (activeFileUri.fsPath.includes('BUILD')) {
		return activeFileUri;
	}

	// Otherwise, search for BUILD file in parent directories
	try {
		const buildFilePath = getModuleBuildFile(dirname(activeFileUri.fsPath));
		return Uri.file(buildFilePath);
	} catch (error) {
		window.showErrorMessage(
			'No BUILD file found in the current directory or parent directories.'
		);
		return undefined;
	}
}

function runLSCmd() {
	if (!isRedhatJavaReady()) {
		window.showErrorMessage(
			'Unable to execute LS cmd. Java language server is not ready'
		);
		return;
	}
	window
		.showInputBox({
			value: Commands.JAVA_LS_LIST_SOURCEPATHS,
		})
		.then((cmd) => {
			if (cmd) {
				const [lsCmd, args] = cmd.trim().split(/\s(.*)/s);
				executeJavaLanguageServerCommand<any>(lsCmd, args).then(
					(resp) => BazelLanguageServerTerminal.info(format(resp)),
					(err) => BazelLanguageServerTerminal.error(format(err))
				);
			}
		});
}

function isRedhatJavaReady(): boolean {
	const javaExtension = extensions.getExtension('redhat.java')?.exports;
	if (javaExtension) {
		return javaExtension.status === 'Started';
	}
	return false;
}

function toggleBazelProjectSyncStatus(doc: TextDocument) {
	if (workspace.getConfiguration('bazel.projectview').get('notification')) {
		window
			.showWarningMessage(
				`The Bazel Project View changed. Do you want to synchronize? [details](https://github.com/salesforce/bazel-eclipse/blob/main/docs/common/projectviews.md#project-views)`,
				...['Java Projects', 'Only Directories', 'Do Nothing']
			)
			.then((val) => {
				if (val === 'Java Projects') {
					syncProjectView();
				} else if (val === 'Only Directories') {
					syncProjectViewDirectories();
				} else if (val === 'Do Nothing') {
					workspace
						.getConfiguration('bazel.projectview')
						.update('notification', false);
				}
			});
	}
}

function syncProjectViewDirectories() {
	ProjectViewManager.updateProjectView();
}

function openBazelProjectFile() {
	try {
		const projectViewPath = join(workspaceRoot, '.eclipse', '.bazelproject');
		if (existsSync(projectViewPath)) {
			workspace
				.openTextDocument(projectViewPath)
				.then((f) => window.showTextDocument(f));
		} else {
			window.showErrorMessage(`${projectViewPath} does not exist`);
		}
	} catch (err) {
		window.showErrorMessage(
			'Unable to open the bazel project file; invalid workspace'
		);
	}
}

/**
 * Writes the java.bazel.enabled configuration to a file that JDTLS layer can read.
 * This allows conditional activation of Bazel Java support based on workspace type.
 */
function writeBazelEnabledConfig() {
	try {
		// Read the java.bazel.enabled configuration
		const config = workspace.getConfiguration('java.bazel');
		const enabled = config.get<boolean>('enabled', false);

		// Ensure we have a workspace root
		if (!workspaceRoot) {
			BazelLanguageServerTerminal.trace(
				'No workspace root found, skipping Bazel enabled config write'
			);
			return;
		}

		// Create .vscode directory if it doesn't exist
		const vscodeDir = join(workspaceRoot, '.vscode');
		if (!existsSync(vscodeDir)) {
			mkdirSync(vscodeDir, { recursive: true });
		}

		// Write the configuration file
		const configFile = join(vscodeDir, '.bazel-java-enabled');
		writeFileSync(configFile, enabled.toString(), 'utf8');

		BazelLanguageServerTerminal.trace(
			`Bazel Java support: ${enabled ? 'enabled' : 'disabled'}`
		);
	} catch (error) {
		// Log error but don't fail activation
		BazelLanguageServerTerminal.error(
			`Failed to write Bazel enabled state: ${error}`
		);
	}
}
