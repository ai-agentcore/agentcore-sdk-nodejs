export type ToolArguments = Record<string, unknown>;
export interface ToolOptions {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(arguments_: ToolArguments): unknown | Promise<unknown>;
}

export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  private readonly call: ToolOptions['invoke'];
  constructor(options: ToolOptions) {
    this.name = options.name; this.description = options.description;
    this.parameters = Object.freeze({ ...options.parameters }); this.call = options.invoke;
  }
  async invoke(arguments_: ToolArguments): Promise<unknown> { return this.call({ ...arguments_ }); }
  openAISchema() {
    return { type: 'function' as const, function: { name: this.name, description: this.description, parameters: this.parameters } };
  }
}
