// Заглушка модуля "cloudflare:workers" для оффлайн-приёмки (esbuild alias в
// scripts/acceptance). В воркере wrangler резолвит настоящий модуль; тестам
// нужен только базовый класс DurableObject, от которого наследуют DO-классы.
export class DurableObject {
  protected ctx: any;
  protected env: any;
  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }
}
