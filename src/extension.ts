import * as vscode from "vscode";
import axios from "axios";
import ollama from "ollama";

// Workspace settings allow users to override settings manually
let VSConfig: vscode.WorkspaceConfiguration;
let apiEndpoint: string;
let apiModel: string;
let apiMessageHeader: string;
let apiTemperature: number;
let embedModel: string;
let numPredict: number;
let promptWindowSize: number;
let completionKeys: string;
let responsePreview: boolean | undefined;
let responsePreviewMaxTokens: number;
let responsePreviewDelay: number;
let continueInline: boolean | undefined;

// Function to update the configuration settings from the workspace
function updateVSConfig() {
  VSConfig = vscode.workspace.getConfiguration("squeel-autocoder");
  apiEndpoint = VSConfig.get("endpoint") || "";
  apiModel = VSConfig.get("model") || "";
  apiMessageHeader = VSConfig.get("message header") || "";
  embedModel = VSConfig.get("model") || "";
  numPredict = VSConfig.get("max tokens predicted") || 0;
  promptWindowSize = VSConfig.get("prompt window size") || 0;
  completionKeys = VSConfig.get("completion keys") || " ";
  responsePreview = VSConfig.get("response preview");
  responsePreviewMaxTokens = VSConfig.get("preview max tokens") || 0;
  responsePreviewDelay = VSConfig.get("preview delay") || 0; // Must be || 0 instead of || [default] because of truthy
  continueInline = VSConfig.get("continue inline");
  apiTemperature = VSConfig.get("temperature") || 0;
}

// Initial configuration update
updateVSConfig();

// Listen for configuration changes and update settings accordingly
vscode.workspace.onDidChangeConfiguration(updateVSConfig);

// Function to replace placeholders in the message header with actual values
function messageHeaderSub(document: vscode.TextDocument) {
  const sub = apiMessageHeader
    .replace("{LANG}", document.languageId)
    .replace("{FILE_NAME}", document.fileName)
    .replace("{PROJECT_NAME}", vscode.workspace.name || "Untitled");
  return sub;
}


// Error handler to show error messages in VSCode
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

// chunk codebase up for RAG
export async function createEmbeddings() {
  const files = await vscode.workspace.findFiles("**/*.ts", "**/node_modules/**");
  const fileContents = await Promise.all(files.map(async (file) => {
    const document = await vscode.workspace.openTextDocument(file);
    return document.getText();
  }));

  try {
    const response = await ollama.embed({
      model: embedModel,
      input: fileContents,
    });
    embeddings = response.embeddings;
    vscode.window.showInformationMessage("Embeddings created successfully.");
  } catch (err) {
    handleError(err);
  }
}

// Internal function for autocomplete, not directly exposed
async function autocompleteCommand(textEditor: vscode.TextEditor, cancellationToken?: vscode.CancellationToken) {
  const document = textEditor.document;
  const position = textEditor.selection.active;

  // Get the current prompt
  let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
  prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);

  // Add embeddings context to the prompt
  const context = embeddings.map(embedding => embedding.text).join("\n");
  const completeInput = messageHeaderSub(textEditor.document) + context + "\n" + prompt;

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

        // Make a request to the ollama.ai REST API
        const response = await axios.post(apiEndpoint, {
          model: apiModel,
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
        });

        // Tracker for the current position in the document
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

          if (completion === "") {
            return;
          }

          // Complete edit for token
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

          // Update progress bar
          progress.report({ message: "Generating...", increment: 1 / (numPredict / 100) });

          // Move cursor
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

  // Set the label & insert text to a shortened, non-stream response
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
  // Register a completion provider for all files
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

  // Register a command to create embeddings
  const createEmbeddingsCommand = vscode.commands.registerCommand("squeel-autocoder.createEmbeddings", createEmbeddings);

  // Add the commands & completion provider to the context
  try {
    context.subscriptions.push(completionProvider);
    context.subscriptions.push(externalAutocompleteCommand);
    context.subscriptions.push(createEmbeddingsCommand);
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
