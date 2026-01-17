import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

export type BugKind =
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

// --- HELPERS ---

function addOneToIndexLiteral(n: number): number {
  return n <= 0 ? n + 1 : n + 1;
}

function shouldParenthesizeForNegation(expr: t.Expression): boolean {
  return (
    t.isBinaryExpression(expr) || t.isLogicalExpression(expr) ||
    t.isConditionalExpression(expr) || t.isSequenceExpression(expr) ||
    t.isAssignmentExpression(expr)
  );
}

function negateExpression(expr: t.Expression): t.UnaryExpression {
  const argument = shouldParenthesizeForNegation(expr) ? t.parenthesizedExpression(expr) : expr;
  return t.unaryExpression('!', argument, true);
}

// --- MUTATORS ---

function applyBooleanNegationBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    enter(path: any) {
      if (didMutate) return;
      if (path.parentPath?.isUnaryExpression() && path.parentPath.node.operator === '!') return;
      
      const isBool = path.isBooleanLiteral();
      const isComp = path.isBinaryExpression() && ['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(path.node.operator);
      
      if (isBool || isComp || path.isLogicalExpression()) {
        path.replaceWith(negateExpression(path.node));
        didMutate = true;
        path.stop();
      }
    },
  });
  return didMutate;
}

function applyOffByOneBug(ast: t.File): boolean {
  let didMutate = false;
  const flip = (op: string) => ({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }[op]);
  const visitor = (path: any) => {
    if (didMutate || !path.node.test || !t.isBinaryExpression(path.node.test)) return;
    const next = flip(path.node.test.operator);
    if (next) { path.node.test.operator = next; didMutate = true; path.stop(); }
  };
  traverse(ast, { ForStatement: visitor, WhileStatement: visitor, DoWhileStatement: visitor });
  return didMutate;
}

function applyLogicalAndOrSwapBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    LogicalExpression(path: any) {
      if (didMutate) return;
      if (path.node.operator === '&&') { path.node.operator = '||'; didMutate = true; path.stop(); }
      else if (path.node.operator === '||') { path.node.operator = '&&'; didMutate = true; path.stop(); }
    },
  });
  return didMutate;
}

function applyComparisonDirectionFlipBug(ast: t.File): boolean {
  let didMutate = false;
  const map: Record<string, any> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=' };
  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate || !map[path.node.operator]) return;
      path.node.operator = map[path.node.operator]; didMutate = true; path.stop();
    },
  });
  return didMutate;
}

function applyEqualityInequalityFlipBug(ast: t.File): boolean {
  let didMutate = false;
  const map: Record<string, any> = { '==': '!==', '!=': '===', '===': '!==', '!==': '===' };
  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate || !map[path.node.operator]) return;
      path.node.operator = map[path.node.operator]; didMutate = true; path.stop();
    },
  });
  return didMutate;
}

function applyInvertTernaryBranchesBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    ConditionalExpression(path: any) {
      if (didMutate) return;
      [path.node.consequent, path.node.alternate] = [path.node.alternate, path.node.consequent];
      didMutate = true; path.stop();
    }
  });
  return didMutate;
}

function applyWrongArithmeticOperatorBug(ast: t.File): boolean {
  let didMutate = false;
  const map: Record<string, any> = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '/' };
  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate || !map[path.node.operator]) return;
      path.node.operator = map[path.node.operator]; didMutate = true; path.stop();
    }
  });
  return didMutate;
}

function applyBitwiseLogicalSwapBug(ast: t.File): boolean {
  let didMutate = false;
  const logicToBit = { '&&': '&', '||': '|' };
  const bitToLogic = { '&': '&&', '|': '||' };
  traverse(ast, {
    LogicalExpression(path: any) {
      if (didMutate) return;
      if (logicToBit[path.node.operator as keyof typeof logicToBit]) {
        path.replaceWith(t.binaryExpression(logicToBit[path.node.operator as keyof typeof logicToBit] as any, path.node.left, path.node.right));
        didMutate = true; path.stop();
      }
    },
    BinaryExpression(path: any) {
      if (didMutate) return;
      if (bitToLogic[path.node.operator as keyof typeof bitToLogic]) {
        path.replaceWith(t.logicalExpression(bitToLogic[path.node.operator as keyof typeof bitToLogic] as any, path.node.left, path.node.right));
        didMutate = true; path.stop();
      }
    }
  });
  return didMutate;
}

function applyIndexOffByOneBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    MemberExpression(path: any) {
      if (didMutate || !path.node.computed || !t.isNumericLiteral(path.node.property)) return;
      path.node.property.value = addOneToIndexLiteral(path.node.property.value); didMutate = true; path.stop();
    }
  });
  return didMutate;
}

function applyGeneralBoundaryOffByOneBug(ast: t.File): boolean {
  let didMutate = false;
  const flip = (op: string) => ({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }[op]);
  traverse(ast, {
    BinaryExpression(path: any) {
      if (didMutate) return;
      const next = flip(path.node.operator);
      if (next) { path.node.operator = next; didMutate = true; path.stop(); }
    },
  });
  return didMutate;
}

// --- MAIN INJECTOR ---

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function injectBugs(code: string, maxBugs: number): { code: string; applied: BugKind[] } {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false });
  
  const mutators = [
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
  ] as const;

  const applied: BugKind[] = [];
  const used = new Set<string>();
  const available = [...mutators];

  while (applied.length < maxBugs) {
    shuffleInPlace(available);
    let didApply = false;
    for (const m of available) {
      if (used.has(m.kind)) continue;
      if (m.apply(ast)) {
        applied.push(m.kind);
        used.add(m.kind);
        didApply = true;
        break; 
      }
    }
    if (!didApply) break;
  }

  if (applied.length === 0) return { code, applied: [] };

  const generated = generate(ast, { retainLines: true, comments: true, compact: false }, code).code;
  return { code: generated, applied };
}