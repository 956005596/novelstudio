import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

const processes = [];
const PID_FILES = {
  engine: 'novel-engine.pid',
  next: '.next-dev.pid',
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function stopProcessFromPidFile(name, path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    unlinkSync(path);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[${name}] stopped stale process from ${path} (${pid})`);
  } catch {
    // ignore
  }
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

function startProcess(name, command, args, logFile, pidFile) {
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  processes.push(child);
  if (pidFile) {
    writeFileSync(pidFile, String(child.pid));
  }

  const prefix = `[${name}] `;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(prefix + chunk.toString());
    log.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(prefix + chunk.toString());
    log.write(chunk);
  });
  child.on('exit', (code, signal) => {
    log.end();
    if (pidFile && existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
    if (signal) {
      console.log(`${prefix}stopped by ${signal}`);
      return;
    }
    console.log(`${prefix}exited with code ${code}`);
    if (code && name === 'next') shutdown(code);
  });

  return child;
}

function shutdown(code = 0) {
  for (const child of processes) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

stopProcessFromPidFile('engine', PID_FILES.engine);
stopProcessFromPidFile('next', PID_FILES.next);

if (await isPortOpen(3003)) {
  console.log('[engine] 3003 already running, reusing existing NovelEngine');
} else {
  startProcess('engine', 'bun', ['mini-services/novel-engine/index.ts'], 'novel-engine.log', PID_FILES.engine);
}

startProcess('next', 'next', ['dev', '-H', '0.0.0.0', '-p', '3000'], 'dev.log', PID_FILES.next);
