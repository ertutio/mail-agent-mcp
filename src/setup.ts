import { WebUIServer } from './web/server.js';
import chalk from 'chalk';
import ora from 'ora';
import { program } from 'commander';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { resolveBundledServerPath } from './utils/install-paths.js';

program
  .name('mail-agent-setup')
  .description('Mail Agent MCP Setup Wizard')
  .option('-p, --port <port>', 'Port for web UI (0 chooses an available local port)', '0')
  .option('--no-open', 'Do not open browser automatically')
  .option('--claude-setup', 'Setup Claude Desktop integration')
  .option('--skip-claude', 'Skip Claude Desktop integration')
  .parse();

const options = program.opts();

async function getClaudeConfigPath(): Promise<string> {
  const platform = os.platform();
  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

async function setupClaudeIntegration(): Promise<void> {
  const spinner = ora('Setting up Claude Desktop integration...').start();
  
  try {
    const configPath = await getClaudeConfigPath();
    const configDir = path.dirname(configPath);

    // Create config directory if it doesn't exist
    await fs.mkdir(configDir, { recursive: true });

    // T32 / ENG-03: locate the bundled server next to THIS module — never via
    // process.cwd(), or an installer started from another directory registers
    // a command pointing at the wrong installation.
    const serverPath = resolveBundledServerPath(import.meta.url);
    
    let config: any = {};
    
    // Read existing config if it exists
    try {
      const existingConfig = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(existingConfig);
    } catch (error) {
      // File doesn't exist, start with empty config
      config = {};
    }
    
    // Ensure mcpServers object exists
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    
    // Add or update the Mail Agent MCP server
    config.mcpServers.imap = {
      command: 'node',
      args: [serverPath]
    };
    
    // Write updated config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    
    spinner.succeed('Claude Desktop integration configured!');
    
    console.log('\n' + chalk.green('✓') + ' Claude Desktop configuration updated');
    console.log('  Config file: ' + chalk.cyan(configPath));
    console.log('  Server path: ' + chalk.cyan(serverPath));
    console.log('\n' + chalk.yellow('⚠') + '  ' + chalk.bold('Important:') + ' Restart Claude Desktop to apply changes');
    
  } catch (error) {
    spinner.fail('Failed to setup Claude Desktop integration');
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    console.log('\n' + chalk.yellow('💡') + ' You can manually add this configuration to your Claude Desktop config:');
    console.log(chalk.gray('  {'));
    console.log(chalk.gray('    "mcpServers": {'));
    console.log(chalk.gray('      "imap": {'));
    console.log(chalk.gray('        "command": "node",'));
    console.log(chalk.gray(`        "args": ["${resolveBundledServerPath(import.meta.url)}"]`));
    console.log(chalk.gray('      }'));
    console.log(chalk.gray('    }'));
    console.log(chalk.gray('  }'));
  }
}

async function askForClaudeSetup(): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(chalk.cyan('? ') + 'Do you want to setup Claude Desktop integration? (y/N): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

async function main() {
  console.log(chalk.blue.bold('\n🚀 Mail Agent MCP Setup Wizard\n'));
  
  // First, check if we should setup Claude Desktop integration
  if (options.claudeSetup || (!options.skipClaude && await askForClaudeSetup())) {
    await setupClaudeIntegration();
    console.log('');
  }
  
  const spinner = ora('Starting web interface...').start();
  
  try {
    const server = new WebUIServer(parseInt(options.port));
    await server.start(options.open);
    
    spinner.succeed('Web interface is running!');
    
    console.log('\n' + chalk.green('✓') + ' Private setup session: ' + chalk.cyan(server.getSetupUrl()));
    console.log('\n' + chalk.yellow('ℹ') + ' Press Ctrl+C to stop the server\n');
    
    if (!options.open) {
      console.log(chalk.gray('  Open your browser and navigate to the URL above'));
    }
    
    console.log('\n' + chalk.blue('📧') + ' After configuring your email accounts:');
    console.log('  Complete enrollment in your default browser and wait for verified success.');
    console.log('  Restart or reconnect your MCP client to load the newly saved accounts.');
    console.log('  Try: "Search all my mailboxes" or "List all my email accounts".');
    
  } catch (error) {
    spinner.fail('Failed to start web interface');
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}

main().catch(console.error);
