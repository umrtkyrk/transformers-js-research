import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
const directory = new URL('../results/', import.meta.url);
await mkdir(directory, { recursive: true });
const cpus = os.cpus();
const environment = {
  capturedAt: new Date().toISOString(),
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  windowsRelease: os.release(),
  cpuModel: cpus[0]?.model,
  logicalCpuCount: cpus.length,
  totalMemoryBytes: os.totalmem(),
  availableMemoryBytesAtCapture: os.freemem(),
  nodeVersions: process.versions,
  hardwareDiscovery: 'Node os module; Windows CIM access unavailable in the sandbox',
};
await writeFile(new URL('environment.json', directory), JSON.stringify(environment, null, 2));
console.log(JSON.stringify(environment));
