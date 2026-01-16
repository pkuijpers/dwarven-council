#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    CallToolResult,
    TextContent
} from '@modelcontextprotocol/sdk/types.js';
import { DFHackClient } from './dfhack-client.js';

// Create a fresh connection for each request to avoid stale connection issues
async function getClient(): Promise<DFHackClient> {
    const client = new DFHackClient({
        host: process.env.DFHACK_HOST ?? 'localhost',
        port: parseInt(process.env.DFHACK_PORT ?? '5000'),
        timeout: parseInt(process.env.DFHACK_TIMEOUT ?? '30000')
    });
    await client.connect();
    return client;
}

function textResult(text: string): CallToolResult {
    return {
        content: [{ type: 'text', text } as TextContent]
    };
}

function errorResult(error: string): CallToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${error}` } as TextContent],
        isError: true
    };
}

// Tool definitions
const tools = [
    {
        name: 'dfhack_status',
        description: 'Check DFHack connection status and get basic game info',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'dfhack_command',
        description: 'Run any DFHack command and return its output',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The DFHack command to run (e.g., "ls", "help", "prospect")'
                },
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional arguments for the command'
                }
            },
            required: ['command']
        }
    },
    {
        name: 'coop_status',
        description: 'Get a quick one-line status of the cooperative fortress (runs dwarven-coop status)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'coop_members',
        description: 'Show voting members organized by faction with vote counts (runs dwarven-coop members)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'coop_briefing',
        description: 'Generate a full markdown briefing of the cooperative status including resources, military, events (runs dwarven-coop briefing)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'coop_assembly',
        description: 'Generate the full LLM prompt for the General Assembly OKR generation (runs dwarven-coop assembly)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'prospect',
        description: 'Run the prospect command to show available ores, gems, and mineral veins',
        inputSchema: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['all', 'hell', 'layers'],
                    description: 'Prospect mode: all (default), hell (show HFS), layers (show layers)'
                }
            },
            required: []
        }
    },
    {
        name: 'lua_eval',
        description: 'Evaluate a Lua expression in DFHack and return the result',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'Lua code to evaluate (e.g., "#df.global.world.units.active" to count units)'
                }
            },
            required: ['code']
        }
    },
    {
        name: 'dfhack_help',
        description: 'Get help for a DFHack command or list available commands',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'Command to get help for (omit to list all commands)'
                }
            },
            required: []
        }
    }
];

// Tool handlers
async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let client: DFHackClient | null = null;
    try {
        client = await getClient();

        switch (name) {
            case 'dfhack_status': {
                // Run a simple command to verify connection and get game status
                const result = await client.runCommand('lua', ['print(df.global.gamemode)']);
                if (result.success) {
                    return textResult(`DFHack connected successfully.\nGame mode: ${result.output.trim() || 'unknown'}`);
                }
                return textResult(`DFHack connected but command failed: ${result.error}`);
            }

            case 'dfhack_command': {
                const command = args.command as string;
                const cmdArgs = (args.args as string[]) ?? [];
                const result = await client.runCommand(command, cmdArgs);

                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'coop_status': {
                const result = await client.runCommand('dwarven-coop', ['status']);
                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'coop_members': {
                const result = await client.runCommand('dwarven-coop', ['members']);
                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'coop_briefing': {
                const result = await client.runCommand('dwarven-coop', ['briefing']);
                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'coop_assembly': {
                const result = await client.runCommand('dwarven-coop', ['assembly']);
                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'prospect': {
                const mode = (args.mode as string) ?? 'all';
                const result = await client.runCommand('prospect', [mode]);
                if (result.success) {
                    return textResult(result.output || '(no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'lua_eval': {
                const code = args.code as string;
                // Wrap in print() if not already printing
                const wrappedCode = code.includes('print') ? code : `print(${code})`;
                const result = await client.runCommand('lua', [wrappedCode]);

                if (result.success) {
                    return textResult(result.output || '(nil or no output)');
                }
                return errorResult(`${result.error}\nOutput: ${result.output}`);
            }

            case 'dfhack_help': {
                const command = args.command as string | undefined;
                if (command) {
                    const result = await client.runCommand('help', [command]);
                    if (result.success) {
                        return textResult(result.output || '(no help available)');
                    }
                    return errorResult(`${result.error}\nOutput: ${result.output}`);
                } else {
                    const result = await client.runCommand('ls');
                    if (result.success) {
                        return textResult(result.output || '(no commands found)');
                    }
                    return errorResult(`${result.error}\nOutput: ${result.output}`);
                }
            }

            default:
                return errorResult(`Unknown tool: ${name}`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to execute tool: ${message}`);
    } finally {
        // Always disconnect to avoid stale connections
        if (client) {
            await client.disconnect().catch(() => {});
        }
    }
}

// Main server setup
async function main() {
    const server = new Server(
        {
            name: 'dfhack-mcp',
            version: '1.0.0'
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return handleTool(name, args ?? {});
    });

    // Connect via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Handle cleanup on exit
    process.on('SIGINT', () => {
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
