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
  | 'generalBoundaryOffByOne'
  | 'homoglyphSabotage'
  | 'scopeGaslighting';

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

const HOMOGLYPHS: Record<string, string> = {
  'a': 'а', // Cyrillic Small Letter A
  'c': 'с', // Cyrillic Small Letter Es
  'e': 'е', // Cyrillic Small Letter Ie
  'o': 'о', // Cyrillic Small Letter O
  'p': 'р', // Cyrillic Small Letter Er
  'x': 'х', // Cyrillic Small Letter Ha
  'y': 'у', // Cyrillic Small Letter U
};

// --- MUTATORS ---

// 1. Homoglyph Attack (Visual Impostor)
function applyHomoglyphSabotageBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    Identifier(path: any) {
      if (didMutate) return;
      
      // Target Declarations Only (Variables, Functions, Classes)
      if (
        path.key === 'id' && 
        (path.parentPath.isVariableDeclarator() || path.parentPath.isFunctionDeclaration())
      ) {
        const name = path.node.name;
        // Check if name contains any exploitable characters
        for (let i = 0; i < name.length; i++) {
          const char = name[i];
          if (HOMOGLYPHS[char]) {
            // Swap just ONE character to make it unsearchable but visually identical
            const newName = name.substring(0, i) + HOMOGLYPHS[char] + name.substring(i + 1);
            
            // CRITICAL FIX: Only change the node name. 
            // DO NOT use path.scope.rename(). We WANT the references to break.
            path.node.name = newName;
            
            didMutate = true;
            path.stop();
            return;
          }
        }
      }
    }
  });
  return didMutate;
}

// 2. Scope Gaslighting (Shadowing)
function applyScopeGaslightingBug(ast: t.File): boolean {
  let didMutate = false;
  traverse(ast, {
    "FunctionDeclaration|ArrowFunctionExpression|FunctionExpression"(path: any) {
      if (didMutate) return;
      if (!path.get("body").isBlockStatement()) return;

      // New Logic: Find what the function ACTUALLY uses from outside
      const usedGlobals = new Set<string>();
      
      path.traverse({
        Identifier(innerPath: any) {
           // If it's a reference (usage), not a declaration
           if (innerPath.isReferencedIdentifier()) {
               const name = innerPath.node.name;
               // Check if it's defined in the outer scope, but NOT in the function scope
               if (path.scope.hasBinding(name) && !path.scope.hasOwnBinding(name)) {
                   usedGlobals.add(name);
               }
           }
        }
      });

      if (usedGlobals.size > 0) {
        // Pick one victim to shadow
        const victim = Array.from(usedGlobals)[0];

        // Insert: let victim = null; (or undefined to be subtler)
        const shadow = t.variableDeclaration("let", [
            t.variableDeclarator(t.identifier(victim), t.nullLiteral())
        ]);
        
        // Inject at the very top of the function
        path.node.body.body.unshift(shadow);
        
        didMutate = true;
        path.stop();
      }
    }
  });
  return didMutate;
}

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
  
  // The Weighted MENU of Destruction
  // We add the nasty bugs 5x more often so they are prioritized by the shuffle
  const mutators = [
    // --- HIGH PRIORITY (5x Weight) ---
    { kind: 'homoglyphSabotage', apply: applyHomoglyphSabotageBug },
    { kind: 'homoglyphSabotage', apply: applyHomoglyphSabotageBug },
    { kind: 'homoglyphSabotage', apply: applyHomoglyphSabotageBug },
    { kind: 'homoglyphSabotage', apply: applyHomoglyphSabotageBug },
    { kind: 'homoglyphSabotage', apply: applyHomoglyphSabotageBug },

    { kind: 'scopeGaslighting', apply: applyScopeGaslightingBug },
    { kind: 'scopeGaslighting', apply: applyScopeGaslightingBug },
    { kind: 'scopeGaslighting', apply: applyScopeGaslightingBug },
    { kind: 'scopeGaslighting', apply: applyScopeGaslightingBug },
    { kind: 'scopeGaslighting', apply: applyScopeGaslightingBug },

    // --- STANDARD PRIORITY (1x Weight) ---
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