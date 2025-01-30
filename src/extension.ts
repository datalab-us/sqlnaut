import * as vscode from "vscode";
import axios from "axios";

let VSConfig: vscode.WorkspaceConfiguration;
let apiEndpoint: string;
let apiModel: string;
let apiMessageHeader: string;
let apiTemperature: number;
let numPredict: number;
let promptWindowSize: number;
let completionKeys: string;
let responsePreview: boolean | undefined;
let responsePreviewMaxTokens: number;
let responsePreviewDelay: number;
let continueInline: boolean | undefined;

function updateVSConfig() {
	VSConfig = vscode.workspace.getConfiguration("squeel-autocoder");
	apiEndpoint = VSConfig.get("endpoint") || "";
	apiModel = VSConfig.get("model") || "";
	apiMessageHeader = VSConfig.get("message header") || "";
	numPredict = VSConfig.get("max tokens predicted") || 0;
	promptWindowSize = VSConfig.get("prompt window size") || 0;
	completionKeys = VSConfig.get("completion keys") || " ";
	responsePreview = VSConfig.get("response preview");
	responsePreviewMaxTokens = VSConfig.get("preview max tokens") || 0;
	responsePreviewDelay = VSConfig.get("preview delay") || 0; // Must be || 0 instead of || [default] because of truthy
	continueInline = VSConfig.get("continue inline");
	apiTemperature = VSConfig.get("temperature") || 0;
}

updateVSConfig();

// No need for restart for any of these settings
vscode.workspace.onDidChangeConfiguration(updateVSConfig);

// Give model additional information
function messageHeaderSub(document: vscode.TextDocument) {
	const sub = apiMessageHeader
		.replace("{LANG}", document.languageId)
		.replace("{FILE_NAME}", document.fileName)
		.replace("{PROJECT_NAME}", vscode.workspace.name || "Untitled");
	return sub;
}

async function handleError(err: any) {
	if (err.code === 'ERR_CANCELED') return;

	let error_reason = err.code ? err.code.toString() : "";
	if (err.code === 'ECONNREFUSED') error_reason = "ECONNREFUSED — Ollama is likely not running";
	if (err.code === 'ERR_BAD_REQUEST') error_reason = "ERR_BAD_REQUEST — Settings are likely misconfigured"

	let error_response = err.message;

	// Show an error message
	vscode.window.showErrorMessage(
		"Ollama Autocoder encountered an error: " + error_reason + (error_response != "" ? ": " : "") + 
		error_response);
	console.error(err);
}

// internal function for autocomplete, not directly exposed
async function autocompleteCommand(textEditor: vscode.TextEditor, cancellationToken?: vscode.CancellationToken) {
	const document = textEditor.document;
	const position = textEditor.selection.active;

	// Get the current prompt
	let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
	prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);

	// Show a progress message
	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Ollama Autocoder",
			cancellable: true,
		},
		async (progress, progressCancellationToken) => {
			try {
				progress.report({ message: "Starting model..." });

				let axiosCancelPost: () => void;
				const axiosCancelToken = new axios.CancelToken((c) => {
					const cancelPost = function () {
						c("Autocompletion request terminated by user cancel");
					};
					axiosCancelPost = cancelPost;
					if (cancellationToken) cancellationToken.onCancellationRequested(cancelPost);
					progressCancellationToken.onCancellationRequested(cancelPost);
					vscode.workspace.onDidCloseTextDocument(cancelPost);
				});

				const completeInput = messageHeaderSub(textEditor.document) + prompt;

				// Make a request to the ollama.ai REST API
				const response = await axios.post(apiEndpoint, {
					model: apiModel, // Change this to the model you want to use
					prompt: completeInput,
					stream: true,
					raw: true,
					options: {
						num_predict: numPredict,
						temperature: apiTemperature,
						stop: ["```"],
						num_ctx: Math.min(completeInput.length, promptWindowSize) // Assumes absolute worst case of 1 char = 1 token
					}
				}, {
					cancelToken: axiosCancelToken,
					responseType: 'stream'
				}
				);

				//tracker
				let currentPosition = position;

				response.data.on('data', async (d: Uint8Array) => {
					progress.report({ message: "Generating..." });

					// Check for user input (cancel)
					if (currentPosition.line != textEditor.selection.end.line || currentPosition.character != textEditor.selection.end.character) {
						axiosCancelPost(); // cancel axios => cancel finished promise => close notification
						return;
					}

					// Get a completion from the response
					const completion: string = JSON.parse(d.toString()).response;
					// lastToken = completion;

					if (completion === "") {
						return;
					}

					//complete edit for token
					const edit = new vscode.WorkspaceEdit();
					edit.insert(document.uri, currentPosition, completion);
					await vscode.workspace.applyEdit(edit);

					// Move the cursor to the end of the completion
					const completionLines = completion.split("\n");
					const newPosition = new vscode.Position(
						currentPosition.line + completionLines.length - 1,
						(completionLines.length > 1 ? 0 : currentPosition.character) + completionLines[completionLines.length - 1].length
					);
					const newSelection = new vscode.Selection(
						position,
						newPosition
					);
					currentPosition = newPosition;

					// completion bar
					progress.report({ message: "Generating...", increment: 1 / (numPredict / 100) });

					// move cursor
					textEditor.selection = newSelection;
				});

				// Keep cancel window available
				const finished = new Promise((resolve) => {
					response.data.on('end', () => {
						progress.report({ message: "Ollama completion finished." });
						resolve(true);
					});
					axiosCancelToken.promise.finally(() => { // prevent notification from freezing on user input cancel
						resolve(false);
					});
				});

				await finished;

			} catch (err: any) {
				if (err.response && err.response.data) err.response.data.on('data', async (d: Uint8Array) => {
					const completion: string = JSON.parse(d.toString()).error;
					err.message = completion;
					handleError(err);
				}).catch(handleError);
				else handleError(err);
			}
		}
	);
}

// Completion item provider callback for activate
async function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, cancellationToken: vscode.CancellationToken) {

	// Create a completion item
	const item = new vscode.CompletionItem("Autocomplete with Ollama");

	// Set the insert text to a placeholder
	item.insertText = new vscode.SnippetString('${1:}');

	// Wait before initializing Ollama to reduce compute usage
	if (responsePreview) await new Promise(resolve => setTimeout(resolve, responsePreviewDelay * 1000));
	if (cancellationToken.isCancellationRequested) {
		return [item];
	}

	// Set the label & inset text to a shortened, non-stream response
	if (responsePreview) {
		try {
			let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
			prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);
			const completeInput = messageHeaderSub(document) + prompt;

			const response_preview = await axios.post(apiEndpoint, {
				model: apiModel, // Change this to the model you want to use
				prompt: completeInput,
				stream: false,
				raw: true,
				options: {
					num_predict: responsePreviewMaxTokens, // reduced compute max
					temperature: apiTemperature,
					stop: ['\n', '```'],
					num_ctx: Math.min(completeInput.length, promptWindowSize) // Assumes absolute worst case of 1 char = 1 token
				}
			}, {
				cancelToken: new axios.CancelToken((c) => {
					const cancelPost = function () {
						c("Autocompletion request terminated by completion cancel");
					};
					cancellationToken.onCancellationRequested(cancelPost);
				})
			});

			if (response_preview.data.response.trim() != "") { // default if empty
				item.label = response_preview.data.response.trimStart(); // tended to add whitespace at the beginning
				item.insertText = response_preview.data.response.trimStart();
			}
		} catch (err: any) {
			if (err.response && err.response.data) err.message = err.response.data.error;
			handleError(err);
		}
	}

	// Set the documentation to a message
	item.documentation = new vscode.MarkdownString('Press `Enter` to get an autocompletion from Ollama');
	// Set the command to trigger the completion
	if (continueInline || !responsePreview) item.command = {
		command: 'squeel-autocoder.autocomplete',
		title: 'Autocomplete with Ollama',
		arguments: [cancellationToken]
	};
	// Return the completion item
	return [item];
}

// This method is called when extension is activated
function activate(context: vscode.ExtensionContext) {
	// Register a completion provider for JavaScript files
	const completionProvider = vscode.languages.registerCompletionItemProvider("*", {
		provideCompletionItems
	},
		...completionKeys.split("")
	);

	// Register a command for getting a completion from Ollama through command/keybind
	const externalAutocompleteCommand = vscode.commands.registerTextEditorCommand(
		"squeel-autocoder.autocomplete",
		(textEditor, _, cancellationToken?) => {
			// no cancellation token from here, but there is one from completionProvider
			autocompleteCommand(textEditor, cancellationToken);
		}
	);

	// Register a keybinding for cmd+u to trigger the autocomplete command
	const keybinding = vscode.commands.registerCommand("squeel-autocoder.triggerAutocomplete", () => {
		vscode.commands.executeCommand("squeel-autocoder.autocomplete");
	});

	// Add the keybinding to the package.json
	const packageJson = {
		"contributes": {
			"keybindings": [
				{
					"command": "squeel-autocoder.triggerAutocomplete",
					"key": "cmd+u",
					"when": "editorTextFocus"
				}
			]
		}
	};

	// Add the commands & completion provider to the context
	try {
		context.subscriptions.push(completionProvider);
		context.subscriptions.push(externalAutocompleteCommand);
		context.subscriptions.push(keybinding);
	} catch (err) {
		handleError(err);
	}

}

// This method is called when extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};