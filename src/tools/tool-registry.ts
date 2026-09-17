import { ToolError } from './errors.js';
import type { Tool, ToolRiskLevel } from './tool-types.js';

function isRiskLevel(value: unknown): value is ToolRiskLevel {
  return value === 'safe' || value === 'low' || value === 'medium'
    || value === 'high' || value === 'critical';
}

function validateToolContract(tool: Tool): void {
  if (typeof tool !== 'object' || tool === null
    || typeof tool.id !== 'string' || typeof tool.name !== 'string'
    || typeof tool.description !== 'string'
    || !tool.id.trim() || !tool.name.trim() || !tool.description.trim()) {
    throw new ToolError('Tool metadata is incomplete.', 'TOOL_CONFIGURATION_ERROR');
  }
  if (!isRiskLevel(tool.risk) || !tool.argumentSchema
    || tool.argumentSchema.type !== 'object'
    || typeof tool.argumentSchema.properties !== 'object'
    || tool.argumentSchema.properties === null
    || Array.isArray(tool.argumentSchema.properties)) {
    throw new ToolError('Tool contract is invalid.', 'TOOL_CONFIGURATION_ERROR');
  }
  if (typeof tool.execute !== 'function') {
    throw new ToolError('Tool execution method is missing.', 'TOOL_CONFIGURATION_ERROR');
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    validateToolContract(tool);
    if (this.tools.has(tool.id)) {
      throw new ToolError('A tool with this ID is already registered.', 'TOOL_CONFIGURATION_ERROR');
    }
    this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }
}
