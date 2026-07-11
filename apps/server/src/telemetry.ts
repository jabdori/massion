import { createServer, type Server } from "node:http";

const METRIC_NAME = /^[a-z][a-z0-9_]{2,127}$/u;
const LABEL_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/u;

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class MetricRegistry {
  private readonly values = new Map<string, number>();

  public constructor(private readonly descriptors: Readonly<Record<string, readonly string[]>>) {
    for (const [name, labels] of Object.entries(descriptors)) {
      if (!METRIC_NAME.test(name) || labels.length > 8 || labels.some((label) => !LABEL_NAME.test(label)))
        throw new Error("metric descriptor가 유효하지 않습니다");
    }
  }

  public increment(name: string, labels: Readonly<Record<string, string>>, value = 1): void {
    const allowed = this.descriptors[name];
    if (!allowed) throw new Error("등록되지 않은 metric입니다");
    const names = Object.keys(labels).sort();
    if (names.some((label) => !allowed.includes(label)) || allowed.some((label) => !(label in labels)))
      throw new Error("metric label 구성이 유효하지 않습니다");
    if (Object.values(labels).some((label) => !LABEL_VALUE.test(label)))
      throw new Error("metric label 값이 유효하지 않습니다");
    if (!Number.isFinite(value) || value <= 0) throw new Error("metric 증가 값이 유효하지 않습니다");
    const key = JSON.stringify([name, names.map((label) => [label, labels[label]])]);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  public render(): string {
    const entries = [...this.values.entries()]
      .map(([key, value]) => {
        const [name, labels] = JSON.parse(key) as [string, [string, string][]];
        return { name, labels, value };
      })
      .sort((left, right) =>
        `${left.name}:${JSON.stringify(left.labels)}`.localeCompare(`${right.name}:${JSON.stringify(right.labels)}`),
      );
    const lines: string[] = [];
    let previous = "";
    for (const entry of entries) {
      if (entry.name !== previous) {
        lines.push(`# TYPE ${entry.name} counter`);
        previous = entry.name;
      }
      const labels = entry.labels.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",");
      lines.push(`${entry.name}${labels ? `{${labels}}` : ""} ${String(entry.value)}`);
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }
}

export class MetricsHttpServer {
  private readonly server: Server;

  public constructor(
    private readonly metrics: MetricRegistry,
    private readonly options: { readonly host: string; readonly port: number },
  ) {
    this.server = createServer({ maxHeaderSize: 4 * 1024, requestTimeout: 5_000 }, (request, response) => {
      if (request.url !== "/metrics") {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        response.writeHead(405).end();
        return;
      }
      const body = this.metrics.render();
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
    });
    this.server.maxHeadersCount = 16;
    this.server.headersTimeout = 3_000;
    this.server.keepAliveTimeout = 2_000;
  }

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("metric listener address를 확인할 수 없습니다");
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return { host: address.address, port: address.port, url: `http://${host}:${String(address.port)}` };
  }

  public async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|token|key)/iu;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/giu, "Bearer [REDACTED]")
      .replace(/\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s]+/giu, "[REDACTED_URL]")
      .slice(0, 1024);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(child, depth + 1)]),
    );
  }
  return value;
}

export class JsonOperationalLogger {
  public constructor(
    private readonly sink: (line: string) => void,
    private readonly options: { readonly maximumBytes?: number } = {},
  ) {}

  public write(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (!/^[a-z][a-z0-9.-]{2,127}$/u.test(event)) throw new Error("운영 log event가 유효하지 않습니다");
    const encoded = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...(redact(fields) as Readonly<Record<string, unknown>>),
    });
    const maximum = this.options.maximumBytes ?? 16 * 1024;
    if (Buffer.byteLength(encoded) <= maximum) {
      this.sink(encoded);
      return;
    }
    this.sink(JSON.stringify({ timestamp: new Date().toISOString(), event, category: "event-too-large" }));
  }
}
