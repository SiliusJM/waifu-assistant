import type { Tool, ToolResult } from './tool-types.js';

export const LOCAL_CALCULATOR_TOOL_ID = 'local.calculate';
const MAX_EXPRESSION_LENGTH = 256;
const MAX_TOKENS = 128;
const MAX_DEPTH = 64;

export interface CalculatorValue {
  readonly expression: string;
  readonly result: number;
}

type Operator = '+' | '-' | '*' | '/' | '%';
type Token = { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'operator'; readonly value: Operator }
  | { readonly kind: 'parenthesis'; readonly value: '(' | ')' };

class ExpressionError extends Error {}

function tokenize(expression: string): Token[] {
  if (!expression || expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError('The expression is empty or too long.');
  }
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (character && /\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character && /[0-9.]/.test(character)) {
      const start = index;
      let dots = 0;
      while (index < expression.length && /[0-9.]/.test(expression[index] ?? '')) {
        if (expression[index] === '.') dots += 1;
        index += 1;
      }
      const literal = expression.slice(start, index);
      if (dots > 1 || literal === '.') throw new ExpressionError('Invalid number.');
      const value = Number(literal);
      if (!Number.isFinite(value)) throw new ExpressionError('Number is not finite.');
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (character && '+-*/%'.includes(character)) {
      tokens.push({ kind: 'operator', value: character as Operator });
      index += 1;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push({ kind: 'parenthesis', value: character });
      index += 1;
      continue;
    }
    throw new ExpressionError('Expression contains an unsupported character.');
  }
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) {
    throw new ExpressionError('Expression has an invalid size.');
  }
  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const result = this.parseExpression();
    if (this.position !== this.tokens.length) throw new ExpressionError('Unexpected token.');
    return result;
  }

  private parseExpression(): number {
    let result = this.parseTerm();
    while (this.isOperator('+') || this.isOperator('-')) {
      const operator = this.consume().value;
      const right = this.parseTerm();
      result = this.apply(operator as '+' | '-', result, right);
    }
    return result;
  }

  private parseTerm(): number {
    let result = this.parseUnary();
    while (this.isOperator('*') || this.isOperator('/') || this.isOperator('%')) {
      const operator = this.consume().value;
      const right = this.parseUnary();
      result = this.apply(operator as '*' | '/' | '%', result, right);
    }
    return result;
  }

  private parseUnary(): number {
    if (this.isOperator('+') || this.isOperator('-')) {
      const operator = this.consume().value;
      const value = this.parseUnary();
      return operator === '-' ? this.ensureFinite(-value) : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.position];
    if (!token) throw new ExpressionError('Expected a value.');
    if (token.kind === 'number') {
      this.position += 1;
      return token.value;
    }
    if (token.kind === 'parenthesis' && token.value === '(') {
      this.position += 1;
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new ExpressionError('Expression is too deeply nested.');
      const result = this.parseExpression();
      const closing = this.tokens[this.position];
      if (!closing || closing.kind !== 'parenthesis' || closing.value !== ')') {
        throw new ExpressionError('Parentheses are not balanced.');
      }
      this.position += 1;
      this.depth -= 1;
      return result;
    }
    throw new ExpressionError('Expected a number or parenthesized expression.');
  }

  private consume(): Token {
    const token = this.tokens[this.position];
    if (!token) throw new ExpressionError('Unexpected end of expression.');
    this.position += 1;
    return token;
  }

  private isOperator(operator: Operator): boolean {
    const token = this.tokens[this.position];
    return token?.kind === 'operator' && token.value === operator;
  }

  private apply(operator: '+' | '-' | '*' | '/' | '%', left: number, right: number): number {
    if ((operator === '/' || operator === '%') && right === 0) {
      throw new ExpressionError('Division by zero is not allowed.');
    }
    const result = operator === '+' ? left + right
      : operator === '-' ? left - right
        : operator === '*' ? left * right
          : operator === '/' ? left / right
            : left % right;
    return this.ensureFinite(result);
  }

  private ensureFinite(value: number): number {
    if (!Number.isFinite(value)) throw new ExpressionError('Result is not finite.');
    return Object.is(value, -0) ? 0 : value;
  }
}

export function evaluateExpression(expression: string): number {
  return new Parser(tokenize(expression)).parse();
}

export function createCalculatorTool(): Tool<{ expression: string }, CalculatorValue> {
  return {
    id: LOCAL_CALCULATOR_TOOL_ID,
    name: 'Calculator',
    description: 'Evaluates a bounded arithmetic expression.',
    risk: 'safe',
    argumentSchema: {
      type: 'object',
      properties: { expression: { type: 'string', required: true, minLength: 1, maxLength: MAX_EXPRESSION_LENGTH } },
      allowUnknown: false,
    },
    async execute(argumentsValue): Promise<ToolResult<CalculatorValue>> {
      try {
        return {
          status: 'success',
          value: { expression: argumentsValue.expression, result: evaluateExpression(argumentsValue.expression) },
        };
      } catch (error) {
        return {
          status: 'failure',
          error: {
            code: 'TOOL_ARGUMENTS_ERROR',
            message: error instanceof ExpressionError ? error.message : 'Expression could not be evaluated.',
            retryable: false,
          },
        };
      }
    },
  };
}
