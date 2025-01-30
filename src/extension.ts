import * as vscode from "vscode";
import ollama from "ollama";

export function activate(context: vscode.ExtensionContext) {
  const chatCommand = vscode.commands.registerCommand(
    "sqlnaut.openChat",
    () => {
      const panel = vscode.window.createWebviewPanel(
        "sqlnautChat",
        "sqlnaut Chat",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      panel.webview.html = getWebviewContent();
      panel.webview.onDidReceiveMessage(async (message: any) => {
        if (message.command === "ask") {
          const userPrompt = message.text;
          let responseText = "";

          try {
            const streamResponse = await ollama.chat({
              model: "deepseek-r1:8b",
              messages: [{ role: "user", content: userPrompt }],
              stream: true,
            });

            for await (const part of streamResponse) {
              responseText += part.message.content;
              panel.webview.postMessage({
                command: "chatResponse",
                text: responseText,
              });
            }
          } catch (err) {
            panel.webview.postMessage({
              command: "chatResponse",
              text: `Error: ${String(err)}`,
            });
          }
        }
      });
    }
  );

  context.subscriptions.push(chatCommand);
}

export function deactivate() {}

function getWebviewContent(): string {
  return /*html*/ `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body { font-family: sans-serif; margin: 1rem; }
      #prompt { width: 100%; box-sizing: border-box; }
      #response { border: 1px solid #ccc; margin-top: 1rem; padding: 0.5rem; }
    </style>
    <body>
      <h2>sqlnaut Chat</h2>
      <textarea id="prompt" rows=3 placeholder="Got SQL?"></textarea><br />
      <button id="askBtn">Ask</button>
      <div id="response"></div>

      <script>
        const vscode = acquireVsCodeApi();

        document.getElementById("askBtn").addEventListener("click", () => {
          const text = document.getElementById("prompt").value;
          vscode.postMessage({ command: "ask", text });
        });

        document.getElementById("prompt").addEventListener("keydown", (event) => {
          if (event.metaKey && event.key === "Enter") {
            const text = document.getElementById("prompt").value;
            vscode.postMessage({ command: "ask", text });
            event.preventDefault();
          }
        });

        window.addEventListener("message", (event) => {
          const { command, text } = event.data;
          if (command === "chatResponse") {
            document.getElementById("response").innerText = text;
          }
        });
      </script>
    </body>
    </html>
  `;
}
