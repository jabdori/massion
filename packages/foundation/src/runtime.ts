const MINIMUM_NODE_MAJOR = 24;

export function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)\.\d+\.\d+$/.exec(version);
  if (!match?.[1]) {
    throw new Error(`잘못된 Node.js version: ${version}`);
  }
  return Number.parseInt(match[1], 10);
}

export function isSupportedNodeVersion(version: string): boolean {
  return parseNodeMajor(version) >= MINIMUM_NODE_MAJOR;
}

export function assertSupportedRuntime(version = process.version): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`Massion은 Node.js ${String(MINIMUM_NODE_MAJOR)} 이상이 필요합니다. 현재: ${version}`);
  }
}
