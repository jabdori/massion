import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MassionSessionStore } from './MassionSessionStore';

const executeFile = promisify(execFile);

interface MassionCliConfig {
    schemaVersion: 'massion.cli.config.v1';
    selectedProfile: string;
    profiles: Record<string, { endpoint: string; tokenReference: string }>;
}

function configPath(): string {
    const home = homedir();
    if (process.platform === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Massion', 'config.json');
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'massion', 'config.json');
}

async function resolveToken(reference: string): Promise<string> {
    if (reference.startsWith('env:')) {
        const val = process.env[reference.slice(4)];
        if (!val) throw new Error(`Massion token env var not set: ${reference}`);
        return val;
    }
    if (reference.startsWith('file:')) {
        return (await readFile(reference.slice(5), 'utf8')).trim();
    }
    if (reference.startsWith('keychain:') && process.platform === 'darwin') {
        const [service, account] = reference.slice(9).split('/', 2);
        const result = await executeFile('/usr/bin/security', [
            'find-generic-password', '-s', service, '-a', account, '-w',
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
        return result.stdout.trim();
    }
    throw new Error(`Unsupported Massion token reference: ${reference}`);
}

export async function initializeMassionBackend(): Promise<MassionSessionStore> {
    const raw = await readFile(configPath(), 'utf8').catch((e) => {
        throw new Error(`Massion CLI config not found (run "massion init" first): ${e}`);
    });
    const config = JSON.parse(raw) as MassionCliConfig;
    const profile = config.profiles[config.selectedProfile];
    if (!profile) throw new Error(`Massion CLI profile "${config.selectedProfile}" not found`);
    const token = await resolveToken(profile.tokenReference);
    const store = new MassionSessionStore(profile.endpoint, token);
    AISessionsRepository.registerStore(store);
    return store;
}
