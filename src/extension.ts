import * as vscode from "vscode";
import { injectBugs } from "./injector";
import { getDuckRoast } from "./roaster";

// --- STATE ---
let pendingRoast: string | null = null;
let autoInjectEnabled = false;
let duckEditing = false; // Flag to prevent infinite save loops

// --- TYPES ---
// Must match the types in injector.ts
type BugKind =
  | "homoglyphSabotage" // 🆕
  | "scopeGaslighting"  // 🆕
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

type DuckHistoryEntry = {
  id: string;
  time: string;
  filePath: string;
  fileUri: string;
  bugs: string[];
  startLine: number;
  endLine: number;
  beforeSnippet: string;
  afterSnippet: string;
};

const HISTORY_KEY = "duckedyduck.history";

// --- HISTORY HELPERS ---

function getChangedLineRange(before: string, after: string) {
  if (before === after) return null;

  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }

  let endBefore = before.length - 1;
  let endAfter = after.length - 1;

  while (
    endBefore >= start &&
    endAfter >= start &&
    before[endBefore] === after[endAfter]
  ) {
    endBefore--;
    endAfter--;
  }

  const startLine = before.slice(0, start).split("\n").length;
  const endLine = before.slice(0, endBefore + 1).split("\n").length;

  return { startLine, endLine };
}

function getLineSlice(text: string, startLine: number, endLine: number) {
  const lines = text.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine); // inclusive
  return lines.slice(start, end).join("\n");
}

async function appendHistoryToWorkspaceFile(block: string) {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  const dirUri = vscode.Uri.joinPath(ws.uri, ".duckedyduck");
  const fileUri = vscode.Uri.joinPath(dirUri, "history.md");

  await vscode.workspace.fs.createDirectory(dirUri);

  let existing = "";
  try {
    const buf = await vscode.workspace.fs.readFile(fileUri);
    existing = Buffer.from(buf).toString("utf8");
  } catch {
    // no file yet, that's fine
  }

  await vscode.workspace.fs.writeFile(
    fileUri,
    Buffer.from(existing + block, "utf8"),
  );
}

async function recordDuckHistory(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  before: string,
  after: string,
  bugs: string[],
) {
  const range = getChangedLineRange(before, after);
  if (!range) return;

  const beforeSnippet = getLineSlice(before, range.startLine, range.endLine);
  const afterSnippet = getLineSlice(after, range.startLine, range.endLine);

  const entry: DuckHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    filePath: editor.document.fileName,
    fileUri: editor.document.uri.toString(),
    bugs,
    startLine: range.startLine,
    endLine: range.endLine,
    beforeSnippet,
    afterSnippet,
  };

  // 1. Save in globalState (for internal tracking/popups)
  const history = context.globalState.get<DuckHistoryEntry[]>(HISTORY_KEY, []);
  history.unshift(entry);
  await context.globalState.update(HISTORY_KEY, history.slice(0, 50));

  // 2. Append to the visible .duckedyduck/history.md file
  const mdBlock = `

---

## 🦆 Duck Attack (${new Date(entry.time).toLocaleString()})
**File:** \`${entry.filePath.split(/[/\\]/).pop()}\`  
**Lines:** ${entry.startLine}–${entry.endLine}  
**Bugs:** ${entry.bugs.join(", ")}

### BEFORE
\`\`\`
${entry.beforeSnippet}
\`\`\`

### AFTER
\`\`\`
${entry.afterSnippet}
\`\`\`
`;

  await appendHistoryToWorkspaceFile(mdBlock);
}

// --- EDITOR HELPERS ---

function getBugsPerRun(): number {
  const n = vscode.workspace
    .getConfiguration("duckedyduck")
    .get<number>("bugsPerRun", 3);
  return Math.max(1, Math.min(10, n || 3));
}

function getActiveEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("No active editor found.");
    return undefined;
  }
  return editor;
}

function normalizeAndPreserveFormatting(
  newCode: string,
  originalCode: string,
  eol: vscode.EndOfLine,
): string {
  const newline = eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const normalized = newCode.replace(/\r?\n/g, newline);
  const originalHasTrailing = /\r?\n$/.test(originalCode);
  const outputHasTrailing = /\r?\n$/.test(normalized);

  if (originalHasTrailing && !outputHasTrailing) return normalized + newline;
  if (!originalHasTrailing && outputHasTrailing)
    return normalized.replace(/\r?\n$/, "");
  return normalized;
}

async function replaceEditorContents(
  editor: vscode.TextEditor,
  output: string,
): Promise<boolean> {
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length),
  );
  return editor.edit((editBuilder) => editBuilder.replace(fullRange, output));
}

// --- ACTIVATION ---

export function activate(context: vscode.ExtensionContext) {
  
  // COMMAND: Toggle Auto-Inject
  const toggleAutoInject = vscode.commands.registerCommand(
    "duckedyduck.toggleAutoInject",
    () => {
      autoInjectEnabled = !autoInjectEnabled;
      vscode.window.showInformationMessage(
        `🦆 Auto Sabotage on Save: ${autoInjectEnabled ? "ON" : "OFF"}`,
      );
    },
  );

  // COMMAND: Manual Inject
  const injectBugCommand = vscode.commands.registerCommand(
    "duckedyduck.injectBug",
    async () => {
      const editor = getActiveEditor();
      if (!editor) return;

      const code = editor.document.getText();

      try {
        const result = injectBugs(code, getBugsPerRun());

        if (result.applied.length === 0) {
          void vscode.window.showInformationMessage(
            "Duck could not find anything to break.",
          );
          return;
        }

        const finalCode = normalizeAndPreserveFormatting(
          result.code,
          code,
          editor.document.eol,
        );
        await replaceEditorContents(editor, finalCode);

        await recordDuckHistory(
          context,
          editor,
          code,
          finalCode,
          result.applied,
        );

        // Notify and Roast
        vscode.window.setStatusBarMessage(
          `$(bug) The Duck is watching...`,
          5000,
        );
        getDuckRoast(result.applied).then((roast) => {
          pendingRoast = roast;
        });
      } catch (err) {
        void vscode.window.showErrorMessage(`Duck failed: ${err}`);
      }
    },
  );

  // COMMAND: Clear History
  const clearHistory = vscode.commands.registerCommand(
    "duckedyduck.clearHistory",
    async () => {
      await context.globalState.update(HISTORY_KEY, []);
      vscode.window.showInformationMessage(
        "🦆 History erased. No evidence remains.",
      );
    },
  );

  // COMMAND: Show History
  const showHistory = vscode.commands.registerCommand(
    "duckedyduck.showHistory",
    async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showInformationMessage("🦆 Open a folder first!");
        return;
      }

      const dirUri = vscode.Uri.joinPath(ws.uri, ".duckedyduck");
      const fileUri = vscode.Uri.joinPath(dirUri, "history.md");

      await vscode.workspace.fs.createDirectory(dirUri);

      // Create file if missing
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        await vscode.workspace.fs.writeFile(
          fileUri,
          Buffer.from("# 🦆 Duck History\n\nNo attacks yet.\n", "utf8"),
        );
      }

      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    },
  );

  // EVENT: Debug Trap (F5)
  const debugListener = vscode.debug.onDidStartDebugSession(async () => {
    if (pendingRoast) {
      vscode.window.showWarningMessage(
        `🦆 QUACK: ${pendingRoast}`,
        "Fix it",
        "Ignore",
      );
      pendingRoast = null;
    }
  });

  // EVENT: Save Trap (Ctrl+S)
  // EVENT: Save Trap (Ctrl+S)
  const autoSaveListener = vscode.workspace.onDidSaveTextDocument(
    async (doc) => {
      // 1. Deliver pending roast if it exists
      if (pendingRoast && vscode.window.activeTextEditor?.document === doc) {
        vscode.window.showWarningMessage(`🦆 QUACK: ${pendingRoast}`);
        pendingRoast = null;
      }

      // 2. Auto-Sabotage Logic
      if (!autoInjectEnabled) return;
      if (duckEditing) return; // Don't react to our own edits

      if (
        doc.languageId !== "javascript" &&
        doc.languageId !== "typescript" &&
        doc.languageId !== "javascriptreact" &&
        doc.languageId !== "typescriptreact"
      ) {
        return;
      }

      if (doc.fileName.includes(".duckedyduck")) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.uri.toString() !== doc.uri.toString()) return;

      const before = doc.getText();

      try {
        // 🔥 UPDATE: Inject 1 to 3 bugs randomly, heavily weighted towards nasty ones
        const bugCount = Math.floor(Math.random() * 3) + 1;
        const result = injectBugs(before, bugCount); 
        
        if (result.applied.length === 0) return;

        const after = normalizeAndPreserveFormatting(
          result.code,
          before,
          doc.eol,
        );

        if (after === before) return;

        // Apply Edit
        duckEditing = true;
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(before.length),
        );
        await editor.edit((eb) => {
          eb.replace(fullRange, after);
        });
        duckEditing = false;

        // Record & Notify
        await recordDuckHistory(context, editor, before, after, result.applied);

        vscode.window.setStatusBarMessage(
          `🦆 Auto-sabotaged: ${result.applied.join(", ")}`,
          3000,
        );

        // Queue roast for next action
        getDuckRoast(result.applied).then((roast) => {
          pendingRoast = roast;
        });
      } catch (err) {
        duckEditing = false;
        console.error("Auto sabotage failed:", err);
      }
    },
  );

  context.subscriptions.push(
    toggleAutoInject,
    injectBugCommand,
    clearHistory,
    showHistory,
    debugListener,
    autoSaveListener,
  );
}

export function deactivate() {}