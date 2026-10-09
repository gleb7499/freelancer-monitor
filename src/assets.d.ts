// Промты живут в prompts/*.md и импортируются как текст (правило Text в
// wrangler.toml; в приёмке — --loader:.md=text у esbuild).
declare module "*.md" {
  const content: string;
  export default content;
}
