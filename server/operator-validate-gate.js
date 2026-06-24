/** Local validate gate before dev-done / opencode auto-complete. */
import { spawn } from 'child_process';
import { resolve } from 'path';

function runCmd(cwd, cmd, args, timeoutMs = 300_000) {
    return new Promise((resolveRun) => {
        const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            resolveRun({ ok: false, code: -1, stdout, stderr: stderr + '\n(timeout)' });
        }, timeoutMs);
        child.stdout?.on('data', (d) => { stdout += d; });
        child.stderr?.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolveRun({ ok: code === 0, code, stdout, stderr });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolveRun({ ok: false, code: -1, stdout, stderr: err.message });
        });
    });
}

export async function runValidateGate(workspace) {
    const root = resolve(workspace);
    const backend = resolve(root, 'relive-cure-backend');
    const dashboard = resolve(root, 'relive-cure-dashboard');

    const checks = [];

    const checkFiles = [
        'server/index.js',
        'server/operator-routes.js',
        'server/operator-agent.js',
        'server/operator-tools.js',
    ];
    for (const f of checkFiles) {
        const r = await runCmd(backend, 'node', ['--check', f], 60_000);
        checks.push({ step: `node --check ${f}`, ...r });
        if (!r.ok) {
            return { ok: false, checks, error: r.stderr || `check failed: ${f}` };
        }
    }

    const build = await runCmd(dashboard, 'npm', ['run', 'build'], 300_000);
    checks.push({ step: 'dashboard npm run build', ...build });
    if (!build.ok) {
        return { ok: false, checks, error: build.stderr?.slice(-2000) || 'dashboard build failed' };
    }

    return { ok: true, checks, error: null };
}
