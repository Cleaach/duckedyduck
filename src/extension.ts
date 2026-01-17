import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'bug-generator.injectBug',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const code = editor.document.getText();

      // 1. Parse
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript'],
      });

      // 2. Mutate: i < n → i <= n
      traverse(ast, {
        ForStatement(path) {
          const test = path.node.test;
          if (
            t.isBinaryExpression(test) &&
            test.operator === '<'
          ) {
            test.operator = '<=';
            path.stop();
          }
        }
      });

      // 3. Generate code
      const output = generate(ast).code;

      // 4. Replace editor contents
      editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(code.length)
        );
        editBuilder.replace(fullRange, output);
      });
    }
  );

  context.subscriptions.push(disposable);
}
