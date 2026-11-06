// Aggregate OS readings only: no process arguments, names, PIDs, hostname or account identifiers.
import os from 'node:os';
export function createMetricsReader({ cpus = os.cpus, totalmem = os.totalmem, freemem = os.freemem, now = Date.now } = {}) {
  let previous = null;
  return () => {
    const list = cpus(), sum = list.reduce((out, cpu) => ({ idle: out.idle + cpu.times.idle,
      total: out.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    let cpuPct = null;
    const at = now();
    if (previous && at - previous.at >= 500 && at - previous.at <= 15000 && previous.count === list.length && sum.total > previous.total && sum.idle >= previous.idle) {
      cpuPct = Math.round(Math.max(0, Math.min(100, 100 * (1 - (sum.idle - previous.idle) / (sum.total - previous.total)) )) * 10) / 10;
    }
    previous = { ...sum, count: list.length, at };
    const total = totalmem(), free = Math.max(0, Math.min(total, freemem()));
    return { sampledAt: at, cpuPct, memory: { total, free, used: total - free } };
  };
}
