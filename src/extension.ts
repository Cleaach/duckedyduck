import * as vscode from 'vscode';
import { injectBugs } from './injector';
import { getDuckRoast } from './roaster';

// --- STATE ---
let pendingRoast: string | null = null;
import * as vscode from "vscode";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

type BugKind =
  | "booleanNegation"
  | "offByOne"
  | "logicalAndOrSwap"
  | "comparisonDirectionFlip"
  | "equalityInequalityFlip"
  | "invertTernaryBranches"
  | "wrongArithmeticOperator"
  | "bitwiseLogicalSwap"
  | "indexOffByOne"
  | "generalBoundaryOffByOne";

type MutationResult =
  | { mutated: true; kind: BugKind }
  | { mutated: false; kind?: undefined };

// --- HELPERS ---
function getBugsPerRun(): number {
  const n = vscode.workspace.getConfiguration('duckedyduck').get<number>('bugsPerRun', 3);
  return Math.max(1, Math.min(10, n || 3));
}

function getActiveEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) void vscode.window.showInformationMessage('No active editor found.');
  return editor;
}

function normalizeAndPreserveFormatting(newCode: string, originalCode: string, eol: vscode.EndOfLine): string {
    const newline = eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const normalized = newCode.replace(/\r?\n/g, newline);
    const originalHasTrailing = /\r?\n$/.test(originalCode);
    const outputHasTrailing = /\r?\n$/.test(normalized);

    if (originalHasTrailing && !outputHasTrailing) return normalized + newline;
    if (!originalHasTrailing && outputHasTrailing) return normalized.replace(/\r?\n$/, '');
    return normalized;
}

async function replaceEditorContents(editor: vscode.TextEditor, output: string): Promise<boolean> {
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );
  return editor.edit(editBuilder => editBuilder.replace(fullRange, output));
}

// --- ACTIVATION ---
export function activate(context: vscode.ExtensionContext) {

  // 1. INJECT COMMAND
  const disposable = vscode.commands.registerCommand('duckedyduck.injectBug', async () => {
    const editor = getActiveEditor();
    if (!editor) return;

    const code = editor.document.getText();
    
    try {
      // Use the separate injector module
      const result = injectBugs(code, getBugsPerRun());

      if (result.applied.length === 0) {
        void vscode.window.showInformationMessage('Duck could not find anything to break.');
        return;
      }

      const finalCode = normalizeAndPreserveFormatting(result.code, code, editor.document.eol);
      await replaceEditorContents(editor, finalCode);

      // Trigger Roaster
      vscode.window.setStatusBarMessage(`$(bug) The Duck is watching...`, 5000);
      getDuckRoast(result.applied).then(roast => { pendingRoast = roast; });

    } catch (err) {
      void vscode.window.showErrorMessage(`Duck failed: ${err}`);
    }
  });

  // 2. DEBUG TRAP
  const debugListener = vscode.debug.onDidStartDebugSession(async () => {
      if (pendingRoast) {
          vscode.window.showWarningMessage(`🦆 QUACK: ${pendingRoast}`, "Fix it", "Ignore");
          pendingRoast = null; 
      }
  });

  // 3. SAVE TRAP
  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (pendingRoast && vscode.window.activeTextEditor?.document === doc) {
         vscode.window.showWarningMessage(`🦆 QUACK: ${pendingRoast}`);
         pendingRoast = null;
    }
  });

  context.subscriptions.push(disposable, debugListener, saveListener);
}

export function deactivate() {}