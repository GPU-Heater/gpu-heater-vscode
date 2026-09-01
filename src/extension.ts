import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('gpu-heater');
    
    const provider = new HeaterChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('gpu-heater.chatView', provider)
    );

    const fimProvider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, {
        async provideInlineCompletionItems(document, position, context, token) {
            const isEnabled = vscode.workspace.getConfiguration('gpu-heater').get('autoCompleteEnabled');
            if (!isEnabled) return [];

            const apiBase = vscode.workspace.getConfiguration('gpu-heater').get('apiBaseUrl');
            const offset = document.offsetAt(position);
            const text = document.getText();
            const prefix = text.substring(Math.max(0, offset - 1000), offset);
            const suffix = text.substring(offset, Math.min(text.length, offset + 1000));

            try {
                const response = await fetch(`${apiBase}/api/coder/ide/fim-complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prefix, suffix })
                });
                const data: any = await response.json();
                
                if (data.success && data.completion) {
                    return [new vscode.InlineCompletionItem(data.completion)];
                }
            } catch (err) {}
            return [];
        }
    });
    context.subscriptions.push(fimProvider);

    const execInlineAction = async (actionType: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const selectedCode = editor.document.getText(selection);
        const language = editor.document.languageId;
        const apiBase = vscode.workspace.getConfiguration('gpu-heater').get('apiBaseUrl');
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';

        let payload: any = {
            use_knowledge_base: true,
            workspace_path: workspacePath
        };

        let endpoint = '/api/coder/ide/inline-action';

        if (actionType === 'fixError') {
            const errorText = await vscode.window.showInputBox({ prompt: 'Enter Error Log:', title: 'Debug' });
            if (errorText === undefined) return;
            
            payload.error = errorText;
            payload.file_content = editor.document.getText();
            payload.current_file = editor.document.uri.fsPath;
            endpoint = '/api/coder/ide/fix-error';
        } else {
            payload.selected_code = selectedCode;
            payload.action_type = actionType;
            payload.language = language;
        }

        try {
            const response = await fetch(`${apiBase}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data: any = await response.json();

            const result = data.fix || data.result || "";

            if (actionType === 'explain') {
                provider.sendMessageToWebview({ type: 'addBotResponse', title: 'Explanation for Selected Code', content: result });
            } else {
                vscode.window.showInformationMessage(result || "Success");
            }
        } catch (err: any) {
            vscode.window.showErrorMessage("API Error: " + err.message);
        }
    };

    const inspectFolder = async (uri: vscode.Uri) => {
        const folderPath = uri ? uri.fsPath : (vscode.workspace.workspaceFolders?.[0].uri.fsPath || "");

        if (!folderPath) {
            vscode.window.showWarningMessage("No folder found to inspect.");
            return;
        }

        const apiBase = vscode.workspace.getConfiguration('gpu-heater').get('apiBaseUrl');

        try {
            const response = await fetch(`${apiBase}/api/coder/inspect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: folderPath })
            });
            const data: any = await response.json();

            if (data.success) {
                const resultText = `# Folder Analysis (${folderPath})\n\n${data.data}`;
                const doc = await vscode.workspace.openTextDocument({ content: resultText, language: 'markdown' });
                vscode.window.showTextDocument(doc, { preview: false });
            } else {
                vscode.window.showErrorMessage(`Inspection Failed: ${data.error}`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage("API Error: " + err.message);
        }
    };

    const trainSnippet = async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        let content = editor.document.getText(editor.selection);
        if (!content || content.trim() === '') {
            content = editor.document.getText();
        }

        if (!content || content.trim() === '') {
            vscode.window.showWarningMessage("No code/text to train.");
            return;
        }

        const filename = path.basename(editor.document.uri.fsPath) || "Snippet";
        const apiBase = vscode.workspace.getConfiguration('gpu-heater').get('apiBaseUrl');

        try {
            const response = await fetch(`${apiBase}/api/coder/ide/train-snippet`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, filename })
            });
            const data: any = await response.json();

            if (data.success) {
                vscode.window.showInformationMessage(`✅ ${data.message}`);
            } else {
                vscode.window.showErrorMessage(`Training failed: ${data.error}`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage("API Error: " + err.message);
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.fixError', () => execInlineAction('fixError')));
    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.refactor', () => execInlineAction('refactor')));
    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.explain', () => execInlineAction('explain')));
    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.tests', () => execInlineAction('tests')));
    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.inspectFolder', inspectFolder));
    context.subscriptions.push(vscode.commands.registerCommand('gpu-heater.trainSnippet', trainSnippet));
}

class HeaterChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        const uiPath = vscode.Uri.joinPath(this._extensionUri, 'webview', 'ui.html');
        const langPath = vscode.Uri.joinPath(this._extensionUri, 'webview', 'lang.json');
        
        let html = fs.readFileSync(uiPath.fsPath, 'utf8');
        const langData = fs.existsSync(langPath.fsPath) ? fs.readFileSync(langPath.fsPath, 'utf8') : '{}';
        const apiBase = vscode.workspace.getConfiguration('gpu-heater').get('apiBaseUrl');

        html = html.replace('<head>', `<head>
            <script>
                const API_BASE = '${apiBase}';
                window.i18nData = ${langData};
                window.vscode = acquireVsCodeApi();
            </script>`);

        webviewView.webview.html = html;

        webviewView.webview.onDidReceiveMessage(async (data: any) => {
            if (data.type === 'getChatContext') {
                const editor = vscode.window.activeTextEditor;
                const content = editor?.document.getText() || '';
                const file = editor?.document.uri.fsPath || '';
                const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
                
                webviewView.webview.postMessage({
                    type: 'chatContextResponse',
                    workspacePath,
                    activeFile: file,
                    activeFileContent: content
                });
            } else if (data.type === 'toggleAutoComplete') {
                await vscode.workspace.getConfiguration('gpu-heater').update('autoCompleteEnabled', data.value, vscode.ConfigurationTarget.Global);
            } else if (data.type === 'changeExtLang') {
                await vscode.workspace.getConfiguration('gpu-heater').update('language', data.lang, vscode.ConfigurationTarget.Global);
            }
        });
    }

    public sendMessageToWebview(message: any) {
        this._view?.webview.postMessage(message);
    }
}