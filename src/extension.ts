import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

type BugKind =
  | 'booleanNegation'
  | 'offByOne'
  | 'logicalAndOrSwap'
  | 'comparisonDirectionFlip'
  | 'equalityInequalityFlip'
  | 'invertTernaryBranches'
  | 'wrongArithmeticOperator'
  | 'bitwiseLogicalSwap'
  | 'indexOffByOne'
  | 'generalBoundaryOffByOne';

type MutationResult =
  | { mutated: true; kind: BugKind }
  | { mutated: false; kind?: undefined };

function getBugsPerRun(): number {
  const configured = vscode.workspace
    .getConfiguration('bug-generator')
    .get<number>('bugsPerRun', 3);

  const n = Number.isFinite(configured) ? Math.floor(configured) : 3;
  return Math.max(1, Math.min(10, n));
}

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

function normalizeEol(text: string, eol: vscode.EndOfLine): string {
  const newline = eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return text.replace(/\r?\n/g, newline);
}

function preserveTrailingNewline(output: string, original: string): string {
  const originalHasTrailingNewline = /\r?\n$/.test(original);
  const outputHasTrailingNewline = /\r?\n$/.test(output);

  if (originalHasTrailingNewline && !outputHasTrailingNewline) {
    return output + '\n';
  }
  if (!originalHasTrailingNewline && outputHasTrailingNewline) {
    return output.replace(/\r?\n$/, '');
  }
  return output;
}

function getSimpleCalleeName(node: t.Expression | t.V8IntrinsicIdentifier): string | undefined {
  if (t.isIdentifier(node)) {
    return node.name;
  }
  return undefined;
}

function getMemberPropertyName(
  node: t.MemberExpression | t.OptionalMemberExpression
): string | undefined {
  const prop = node.property;
  if (node.computed) {
    return undefined;
  }
  if (t.isIdentifier(prop)) {
    return prop.name;
  }
  if (t.isStringLiteral(prop)) {
    return prop.value;
  }
  return undefined;
}

function addOneToIndexLiteral(n: number): number {
  // Prefer moving toward "wrong but plausible" indices; avoid negative literals.
  if (n <= 0) {
    return n + 1;
  }
  return n + 1;
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

function applyLogicalAndOrSwapBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    LogicalExpression(path: any) {
      if (didMutate) {
        return;
      }

      if (path.node.operator === '&&') {
        path.node.operator = '||';
        didMutate = true;
        path.stop();
        return;
      }

      if (path.node.operator === '||') {
        path.node.operator = '&&';
        didMutate = true;
        path.stop();
      }
    },
  });

  return didMutate;
}

function flipComparisonDirectionOperator(
  operator: t.BinaryExpression['operator']
): t.BinaryExpression['operator'] | undefined {
  switch (operator) {
    case '>':
      return '<';
    case '<':
      return '>';
    case '>=':
      return '<=';
    case '<=':
      return '>=';
    default:
      return undefined;
  }
}

function applyComparisonDirectionFlipBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate) {
        return;
      }

      const next = flipComparisonDirectionOperator(path.node.operator);
      if (!next) {
        return;
      }

      path.node.operator = next;
      didMutate = true;
      path.stop();
    },
  });

  return didMutate;
}

function flipEqualityInequalityOperator(
  operator: t.BinaryExpression['operator']
): t.BinaryExpression['operator'] | undefined {
  // Includes the user's requested transformation: == -> !==
  switch (operator) {
    case '==':
      return '!==';
    case '!=':
      return '===';
    case '===':
      return '!==';
    case '!==':
      return '===';
    default:
      return undefined;
  }
}

function applyEqualityInequalityFlipBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate) {
        return;
      }

      const next = flipEqualityInequalityOperator(path.node.operator);
      if (!next) {
        return;
      }

      path.node.operator = next;
      didMutate = true;
      path.stop();
    },
  });

  return didMutate;
}

function applyInvertTernaryBranchesBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    ConditionalExpression(path: any) {
      if (didMutate) {
        return;
      }

      const { consequent, alternate } = path.node;
      path.node.consequent = alternate;
      path.node.alternate = consequent;
      didMutate = true;
      path.stop();
    },
  });

  return didMutate;
}

function swapArithmeticOperator(
  operator: t.BinaryExpression['operator']
): t.BinaryExpression['operator'] | undefined {
  switch (operator) {
    case '+':
      return '-';
    case '-':
      return '+';
    case '*':
      return '/';
    case '/':
      return '*';
    case '%':
      return '/';
    default:
      return undefined;
  }
}

function applyWrongArithmeticOperatorBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate) {
        return;
      }
      const next = swapArithmeticOperator(path.node.operator);
      if (!next) {
        return;
      }

      path.node.operator = next;
      didMutate = true;
      path.stop();
    },
  });

  return didMutate;
}

function swapLogicalBitwiseOperator(
  operator: '&&' | '||' | '&' | '|'
): '&&' | '||' | '&' | '|' {
  // Keep "pair" semantics: AND stays AND-ish, OR stays OR-ish.
  switch (operator) {
    case '&&':
      return '&';
    case '&':
      return '&&';
    case '||':
      return '|';
    case '|':
      return '||';
  }
}

function applyBitwiseLogicalSwapBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    LogicalExpression(path: any) {
      if (didMutate) {
        return;
      }
      if (path.node.operator !== '&&' && path.node.operator !== '||') {
        return;
      }

      const op = path.node.operator as '&&' | '||';
      const replacement = t.binaryExpression(
        swapLogicalBitwiseOperator(op) as '&' | '|',
        path.node.left,
        path.node.right
      );
      path.replaceWith(replacement);
      didMutate = true;
      path.stop();
    },
    BinaryExpression(path: any) {
      if (didMutate) {
        return;
      }
      if (path.node.operator !== '&' && path.node.operator !== '|') {
        return;
      }

      const op = path.node.operator as '&' | '|';
      const replacement = t.logicalExpression(
        swapLogicalBitwiseOperator(op) as '&&' | '||',
        path.node.left,
        path.node.right
      );
      path.replaceWith(replacement);
      didMutate = true;
      path.stop();
    },
  });

  return didMutate;
}

function applyIndexOffByOneBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    // arr[3] -> arr[4]
    MemberExpression(path: any) {
      if (didMutate) {
        return;
      }
      if (!path.node.computed) {
        return;
      }
      if (!t.isNumericLiteral(path.node.property)) {
        return;
      }

      path.node.property = t.numericLiteral(addOneToIndexLiteral(path.node.property.value));
      didMutate = true;
      path.stop();
    },

    // arr.at(3), str.charAt(3), slice/substr/substring indices
    CallExpression(path: any) {
      if (didMutate) {
        return;
      }
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) {
        return;
      }

      const method = getMemberPropertyName(callee);
      if (!method) {
        return;
      }

      const indexy = new Set(['at', 'charAt', 'slice', 'substring', 'substr']);
      if (!indexy.has(method)) {
        return;
      }

      if (path.node.arguments.length === 0) {
        return;
      }

      // Mutate the first numeric literal argument we find (often start/end).
      for (let i = 0; i < path.node.arguments.length; i++) {
        const arg = path.node.arguments[i];
        if (t.isNumericLiteral(arg)) {
          path.node.arguments[i] = t.numericLiteral(addOneToIndexLiteral(arg.value));
          didMutate = true;
          path.stop();
          return;
        }
      }
    },
  });

  return didMutate;
}

function applyGeneralBoundaryOffByOneBug(ast: t.File): boolean {
  let didMutate = false;

  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate) {
        return;
      }

      const next = flipBoundaryOperator(path.node.operator);
      if (!next) {
        return;
      }

      path.node.operator = next;
      didMutate = true;
      path.stop();
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
    { kind: 'logicalAndOrSwap', apply: applyLogicalAndOrSwapBug },
    { kind: 'comparisonDirectionFlip', apply: applyComparisonDirectionFlipBug },
    { kind: 'equalityInequalityFlip', apply: applyEqualityInequalityFlipBug },
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

function applyManyBugs(ast: t.File, maxBugs: number): BugKind[] {
  const mutators: Array<{ kind: BugKind; apply: (a: t.File) => boolean }> = [
    { kind: 'booleanNegation', apply: applyBooleanNegationBug },
    { kind: 'offByOne', apply: applyOffByOneBug },
    { kind: 'logicalAndOrSwap', apply: applyLogicalAndOrSwapBug },
    { kind: 'comparisonDirectionFlip', apply: applyComparisonDirectionFlipBug },
    { kind: 'equalityInequalityFlip', apply: applyEqualityInequalityFlipBug },
    { kind: 'invertTernaryBranches', apply: applyInvertTernaryBranchesBug },
    { kind: 'wrongArithmeticOperator', apply: applyWrongArithmeticOperatorBug },
    { kind: 'bitwiseLogicalSwap', apply: applyBitwiseLogicalSwapBug },
    { kind: 'indexOffByOne', apply: applyIndexOffByOneBug },
    { kind: 'generalBoundaryOffByOne', apply: applyGeneralBoundaryOffByOneBug },
  ];

  const applied: BugKind[] = [];
  const used = new Set<BugKind>();

  // Keep applying different mutators until we hit the limit or can’t find any more targets.
  while (applied.length < maxBugs) {
    let didApplyThisRound = false;

    const remaining = mutators.filter(m => !used.has(m.kind));
    if (remaining.length === 0) {
      break;
    }

    shuffleInPlace(remaining);

    for (const m of remaining) {
      if (applied.length >= maxBugs) {
        break;
      }
      if (m.apply(ast)) {
        applied.push(m.kind);
        used.add(m.kind);
        didApplyThisRound = true;
        break; // reshuffle and search again after each successful mutation
      }
    }

    if (!didApplyThisRound) {
      break;
    }
  }

  return applied;
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
        const bugsPerRun = getBugsPerRun();
        const applied = applyManyBugs(ast, bugsPerRun);

        if (applied.length === 0) {
          void vscode.window.showInformationMessage(
            'No suitable spot found to inject a bug.'
          );
          return;
        }

        const generated = generate(
          ast,
          {
            retainLines: true,
            comments: true,
            compact: false,
            concise: false,
          },
          code
        ).code;

        const normalized = normalizeEol(generated, editor.document.eol);
        const output = preserveTrailingNewline(normalized, code);

        await replaceEditorContents(editor, code.length, output);

        void vscode.window.showInformationMessage(
          `Injected ${applied.length} bug(s): ${applied.join(', ')}`
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
