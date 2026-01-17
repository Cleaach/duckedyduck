import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

type BugKind = 'booleanNegation' | 'offByOne';

type MutationResult =
  | { mutated: true; kind: BugKind }
  | { mutated: false; kind?: undefined };

function getActiveEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('No active editor found.');
    return undefined;
  }
  return editor;
}

function parseToAst(code: string): t.File {
  return parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
    errorRecovery: false,
  });
}

function shouldParenthesizeForNegation(expr: t.Expression): boolean {
  return (
    t.isBinaryExpression(expr) ||
    t.isLogicalExpression(expr) ||
    t.isConditionalExpression(expr) ||
    t.isSequenceExpression(expr) ||
    t.isAssignmentExpression(expr)
  );
}

function negateExpression(expr: t.Expression): t.UnaryExpression {
  const argument = shouldParenthesizeForNegation(expr)
    ? t.parenthesizedExpression(expr)
    : expr;
  return t.unaryExpression('!', argument, true);
}

function applyBooleanNegationBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    enter(path: any) {
      if (didMutate) {
        return;
      }

      // Avoid turning !x into !!x (often not a "bug") and avoid stacking.
      if (
        path.parentPath?.isUnaryExpression() &&
        path.parentPath.node.operator === '!'
      ) {
        return;
      }

      // 1) Flip boolean literals by wrapping with !
      if (path.isBooleanLiteral()) {
        path.replaceWith(negateExpression(path.node));
        didMutate = true;
        path.stop();
        return;
      }

      // 2) Negate "obviously boolean" expressions.
      // Comparisons and equality operators always produce booleans.
      if (
        path.isBinaryExpression() &&
        ['==', '!=', '===', '!==', '<', '<=', '>', '>=', 'in', 'instanceof'].includes(
          path.node.operator
        )
      ) {
        path.replaceWith(negateExpression(path.node));
        didMutate = true;
        path.stop();
        return;
      }

      // Logical expressions produce booleans.
      if (path.isLogicalExpression()) {
        path.replaceWith(negateExpression(path.node));
        didMutate = true;
        path.stop();
        return;
      }
    },
  });

  return didMutate;
}

function flipBoundaryOperator(
  operator: t.BinaryExpression['operator']
): t.BinaryExpression['operator'] | undefined {
  switch (operator) {
    case '<':
      return '<=';
    case '<=':
      return '<';
    case '>':
      return '>=';
    case '>=':
      return '>';
    default:
      return undefined;
  }
}

function applyOffByOneBug(ast: t.File): boolean {
  let didMutate = false;

  function tryFlipTest(test: t.Expression | null | undefined): boolean {
    if (!test || !t.isBinaryExpression(test)) {
      return false;
    }
    const next = flipBoundaryOperator(test.operator);
    if (!next) {
      return false;
    }
    test.operator = next;
    return true;
  }

  traverse(ast, {
    ForStatement(path: any) {
      if (didMutate) {
        return;
      }
      if (tryFlipTest(path.node.test)) {
        didMutate = true;
        path.stop();
      }
    },
    WhileStatement(path: any) {
      if (didMutate) {
        return;
      }
      if (tryFlipTest(path.node.test)) {
        didMutate = true;
        path.stop();
      }
    },
    DoWhileStatement(path: any) {
      if (didMutate) {
        return;
      }
      if (tryFlipTest(path.node.test)) {
        didMutate = true;
        path.stop();
      }
    },
  });

  return didMutate;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function applyOneBug(ast: t.File): MutationResult {
  const mutators: Array<{ kind: BugKind; apply: (a: t.File) => boolean }> = [
    { kind: 'booleanNegation', apply: applyBooleanNegationBug },
    { kind: 'offByOne', apply: applyOffByOneBug },
  ];

  // Try in random order so repeated runs don't always do the same thing.
  shuffleInPlace(mutators);

  for (const m of mutators) {
    if (m.apply(ast)) {
      return { mutated: true, kind: m.kind };
    }
  }

  return { mutated: false };
}

async function replaceEditorContents(
  editor: vscode.TextEditor,
  originalCodeLength: number,
  output: string
): Promise<boolean> {
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(originalCodeLength)
  );
  return editor.edit(editBuilder => {
    editBuilder.replace(fullRange, output);
  });
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'bug-generator.injectBug',
    async () => {
      const editor = getActiveEditor();
      if (!editor) {
        return;
      }

      const code = editor.document.getText();

      try {
        const ast = parseToAst(code);
        const result = applyOneBug(ast);

        if (!result.mutated) {
          void vscode.window.showInformationMessage(
            'No suitable spot found to inject a bug (boolean negation / off-by-one).'
          );
          return;
        }

        const output = generate(ast).code;
        await replaceEditorContents(editor, code.length, output);

        void vscode.window.showInformationMessage(
          `Injected bug: ${result.kind}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Bug injection failed: ${msg}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
