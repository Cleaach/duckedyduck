declare module '@babel/traverse' {
  const traverse: (ast: unknown, visitors: unknown) => void;
  export default traverse;
}

declare module '@babel/generator' {
  const generate: (ast: unknown, options?: unknown, code?: string) => { code: string };
  export default generate;
}


